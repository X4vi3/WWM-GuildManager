// Заливка видео из браузера прямо в YouTube. Сервер в этой цепочке не участвует:
// он выдал токен и ведёт плейлисты, а байты идут по каналу самого человека.
//
// Почему XHR, а не fetch: у fetch НЕТ прогресса отправки. Клип весит 2–4 ГБ, и
// полоска, которая не двигается двадцать минут, читается как «зависло».

import { CHUNK_SIZE, classifyError, ERR, worthRetry, retryDelay } from '../server/ytmeta.mjs';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMB_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';

export type Privacy = 'unlisted' | 'public';

export interface TokenSource {
  /** Свежий токен. Обязан сам продлевать: токен живёт час, а 4 ГБ льются дольше. */
  get(): Promise<string>;
}

export interface UploadHooks {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Ошибка с уже разобранной категорией — интерфейсу остаётся показать текст. */
export class YtError extends Error {
  kind: string;
  status: number;
  constructor(kind: string, status = 0, message = '') {
    super(message || kind);
    this.kind = kind;
    this.status = status;
  }
}

const parseBody = (text: string) => { try { return JSON.parse(text); } catch { return null; } };

/**
 * Один запрос через XHR. Возвращает статус, тело и заголовки; сетевую неудачу
 * отдаёт статусом 0, чтобы разбор ошибок был общим с сервером.
 */
const xhr = (
  method: string,
  url: string,
  { headers = {}, body, onProgress, signal }:
    { headers?: Record<string, string>; body?: XMLHttpRequestBodyInit | null;
      onProgress?: (loaded: number) => void; signal?: AbortSignal } = {}
): Promise<{ status: number; text: string; header: (n: string) => string | null }> =>
  new Promise((resolve, reject) => {
    const r = new XMLHttpRequest();
    r.open(method, url, true);
    for (const [k, v] of Object.entries(headers)) r.setRequestHeader(k, v);
    if (onProgress) r.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    r.onload = () => resolve({ status: r.status, text: r.responseText || '', header: (n) => r.getResponseHeader(n) });
    r.onerror = () => resolve({ status: 0, text: '', header: () => null });
    r.ontimeout = () => resolve({ status: 0, text: '', header: () => null });
    r.onabort = () => reject(new YtError('aborted'));
    if (signal) {
      if (signal.aborted) { r.abort(); return; }
      signal.addEventListener('abort', () => r.abort(), { once: true });
    }
    r.send(body ?? null);
  });

/** Открыть сессию заливки. Возвращает адрес, по которому дальше идут куски. */
const startSession = async (token: TokenSource, meta: unknown, size: number, type: string) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = await token.get();
    const r = await xhr('POST', `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': type || 'video/*'
      },
      body: JSON.stringify(meta)
    });
    if (r.status >= 200 && r.status < 300) {
      const loc = r.header('location');
      if (loc) return loc;
    }
    const kind = classifyError(r.status, parseBody(r.text));
    if (!worthRetry(kind) || attempt === 3) throw new YtError(kind, r.status, r.text.slice(0, 300));
    await sleep(retryDelay(attempt));
  }
  throw new YtError(ERR.NETWORK);
};

/** Сколько байт сервер уже принял. Нужно, чтобы после обрыва не лить заново. */
const askOffset = async (token: TokenSource, session: string, size: number) => {
  const t = await token.get();
  const r = await xhr('PUT', session, {
    headers: { authorization: `Bearer ${t}`, 'content-range': `bytes */${size}` }
  });
  if (r.status === 308) {
    const range = r.header('range');            // вида "bytes=0-16777215"
    const end = range ? Number(range.split('-')[1]) : NaN;
    return Number.isFinite(end) ? end + 1 : 0;
  }
  if (r.status >= 200 && r.status < 300) return size;   // всё уже принято
  return 0;
};

/**
 * Залить файл. Куски по 16 МиБ: файл в память целиком не читается, а после
 * обрыва продолжаем с последнего принятого байта, а не с нуля.
 */
export const uploadVideo = async (
  file: File,
  meta: unknown,
  token: TokenSource,
  { onProgress, signal }: UploadHooks = {}
): Promise<string> => {
  const size = file.size;
  const session = await startSession(token, meta, size, file.type);
  let offset = 0;
  let fails = 0;

  while (offset < size) {
    if (signal?.aborted) throw new YtError('aborted');
    const end = Math.min(offset + CHUNK_SIZE, size);
    const chunk = file.slice(offset, end);
    const base = offset;

    const t = await token.get();   // продлевается сам — час на 4 ГБ может не хватить
    const r = await xhr('PUT', session, {
      headers: {
        authorization: `Bearer ${t}`,
        'content-range': `bytes ${offset}-${end - 1}/${size}`
      },
      body: chunk,
      onProgress: (loaded) => onProgress?.(base + loaded, size),
      signal
    });

    if (r.status === 308) {                       // кусок принят, продолжаем
      offset = end;
      fails = 0;
      onProgress?.(offset, size);
      continue;
    }
    if (r.status >= 200 && r.status < 300) {      // последний кусок — готово
      onProgress?.(size, size);
      const id = parseBody(r.text)?.id;
      if (!id) throw new YtError(ERR.API, r.status, 'YouTube не вернул id видео');
      return id as string;
    }

    const kind = classifyError(r.status, parseBody(r.text));
    if (!worthRetry(kind)) throw new YtError(kind, r.status, r.text.slice(0, 300));
    if (++fails > 6) throw new YtError(ERR.NETWORK, r.status);
    await sleep(retryDelay(Math.min(fails - 1, 3)));
    offset = await askOffset(token, session, size);   // спрашиваем, где остановились
  }
  throw new YtError(ERR.API, 0, 'Заливка завершилась без ответа');
};

/**
 * Поставить обложку. Требует канала, подтверждённого по телефону; если Google
 * откажет — это НЕ провал заливки, видео уже на месте. Поэтому наружу отдаём
 * признак, а не исключение.
 */
export const setThumbnail = async (videoId: string, blob: Blob, token: TokenSource): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await token.get();
    const r = await xhr('POST', `${THUMB_URL}?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      headers: { authorization: `Bearer ${t}`, 'content-type': blob.type || 'image/png' },
      body: blob
    });
    if (r.status >= 200 && r.status < 300) return true;
    const kind = classifyError(r.status, parseBody(r.text));
    if (!worthRetry(kind) || attempt === 2) return false;
    await sleep(retryDelay(attempt));
  }
  return false;
};
