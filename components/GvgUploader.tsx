import '@fontsource/anton/400.css';   // только на этой странице: в общий бандл шрифт не тащим
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, YtStatus } from '../services/api';
import { uploadVideo, setThumbnail, YtError, TokenSource } from '../services/ytupload';
import { thumbBlob, renderThumb } from '../services/ytthumb';
import { grabFrame } from '../services/videoframe';
import { battleDate, buildTitle, MAX_PARALLEL, DAILY_LIMIT, ERR } from '../server/ytmeta.mjs';
import { useT } from '../services/i18n';
import { toast, confirm } from './Notifications';

// Заливка записей ГВГ. Видео идёт из браузера прямо в YouTube: сервер только
// выдаёт токен и кладёт готовое видео в плейлист владельца.

type ClipState = 'ready' | 'uploading' | 'done' | 'error';

interface Clip {
  id: string;
  file: File;
  // Соперник ЭТОЙ записи. Пусто — берётся общий для пачки.
  //
  // Раньше здесь был «свой хвост названия», и это оказалось ловушкой: за вечер
  // бьются с разными гильдиями, человек вписывал в строки соперников — и получал
  // заголовки без «vs» (значит галерея не могла отфильтровать их по сопернику),
  // а обложка у всех пяти оставалась одна, с пустым местом вместо врага.
  enemy: string;
  prefix: boolean;     // подставлять «<ник> [дата]»
  state: ClipState;
  sent: number;
  videoId?: string;
  noThumb?: boolean;   // видео залито, но обложку канал не принял
  error?: string;
}

const mb = (n: number) => (n / 1048576).toFixed(0);
// Размер подписываем той единицей, в которой число читается: «0.00 ГБ» у
// стомегабайтного клипа выглядит как ошибка, хотя всё правильно.
const size = (n: number) => (n >= 1073741824
  ? `${(n / 1073741824).toFixed(2)} ГБ`
  : `${Math.max(1, Math.round(n / 1048576))} МБ`);

// Русскому нужны три формы: 1 запись, 2–4 записи, 5+ записей. Одна строка
// с «%n записей» давала «Залить 3 записей».
const plural = (n: number, one: string, few: string, many: string) => {
  const t10 = n % 10, t100 = n % 100;
  if (t10 === 1 && t100 !== 11) return one;
  if (t10 >= 2 && t10 <= 4 && (t100 < 12 || t100 > 14)) return few;
  return many;
};

// Токен продлевается сам: он живёт час, а четыре гигабайта на небыстром канале
// льются дольше. Без этого заливка падала бы ровно на середине.
const makeTokenSource = (): TokenSource => {
  let token = '';
  let until = 0;
  let inflight: Promise<string> | null = null;
  return {
    async get() {
      if (token && until > Date.now() + 60_000) return token;
      if (inflight) return inflight;
      inflight = (async () => {
        const t = await api.getYtToken();
        if (!t?.accessToken) throw new YtError(ERR.ACCESS, 0, 'Токен не выдан');
        token = t.accessToken;
        until = t.expiresAt || Date.now() + 3300_000;
        return token;
      })().finally(() => { inflight = null; });
      return inflight;
    }
  };
};

const errText = (t: (s: string) => string, e: unknown): string => {
  const kind = e instanceof YtError ? e.kind : '';
  if (kind === ERR.NETWORK) return t('Связь оборвалась — до YouTube не дошло. Попробуйте ещё раз.');
  if (kind === ERR.ACCESS) return t('Доступ к каналу недействителен. Это чинится на сервере, не у вас.');
  if (kind === ERR.QUOTA) return t('Дневной лимит загрузок исчерпан. Сбросится в полночь по тихоокеанскому времени.');
  if (kind === 'aborted') return t('Отменено.');
  return e instanceof Error && e.message ? e.message : t('YouTube отказал.');
};

const GvgUploader: React.FC<{ isOfficer?: boolean; onSettings?: () => void; onGallery?: () => void }> =
  ({ isOfficer = false, onSettings, onGallery }) => {
  const t = useT();
  const [status, setStatus] = useState<YtStatus | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [enemy, setEnemy] = useState('');
  const [date, setDate] = useState('');
  const [privacy, setPrivacy] = useState<'unlisted' | 'public'>('unlisted');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string>('');
  const [dragging, setDragging] = useState(false);   // подсветка зоны броска
  const abort = useRef<AbortController | null>(null);
  const tokens = useRef<TokenSource>(makeTokenSource());
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => { api.getYtStatus().then(setStatus); }, []);
  useEffect(load, [load]);

  // Приватность пачки по умолчанию повторяет плейлист: «по ссылке» в открытом
  // плейлисте — ловушка, такое видео начинает находиться поиском.
  useEffect(() => {
    if (status?.playlist) setPrivacy(status.playlist.privacy);
  }, [status?.playlist?.privacy]);

  const addFiles = (list: FileList | File[]) => {
    const picked = Array.from(list).filter(f => f.size > 0);
    if (!picked.length) return;
    setClips(prev => {
      const known = new Set(prev.map(c => c.file.name + c.file.size));
      const fresh = picked
        .filter(f => !known.has(f.name + f.size))
        .map(f => ({
          id: `${f.name}-${f.size}-${f.lastModified}`,
          file: f, enemy: '', prefix: true, state: 'ready' as ClipState, sent: 0
        }));
      const all = [...prev, ...fresh];
      // Дата боя — по самому раннему файлу пачки: бой идёт за полночь, и запись,
      // начатая в 00:20, относится ко вчерашнему бою, а не к сегодняшнему дню.
      setDate(battleDate(all.map(c => c.file)));
      return all;
    });
  };

  /** Соперник записи: свой, а если не вписан — общий для пачки. */
  const foeOf = (c: Clip) => (c.enemy.trim() || enemy.trim());

  const titleOf = (c: Clip) =>
    buildTitle({ nick: status?.nick || '', date, enemy: foeOf(c), prefix: c.prefix });

  // Крупный предпросмотр показывает обложку ПЕРВОЙ записи, а не общее поле:
  // когда соперники вписаны по строкам, общее поле пустое, и картинка «ГИЛЬДИЯ vs»
  // без врага читалась как поломка, хотя у всех строк обложки уже правильные.
  const headFoe = clips.length ? (clips[0].enemy.trim() || enemy.trim()) : enemy.trim();
  useEffect(() => {
    let alive = true;
    renderThumb({ enemy: headFoe, nick: status?.nick || '', date, style: status?.thumb })
      .then(cv => { if (alive) setPreview(cv.toDataURL('image/jpeg', 0.8)); })
      .catch(() => { if (alive) setPreview(''); });
    return () => { alive = false; };
  }, [headFoe, date, status?.nick, status?.thumb]);

  // Кадр из самого файла. Обложку мы нарисовали сами и она предсказуема, а вот
  // «тот ли это клип и записалось ли вообще» видно только по кадру.
  //
  // Достаём по одному: пять декодеров разом на слабой машине — это заметная
  // просадка ради картинок, которые всё равно появятся через секунду.
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [showFrames, setShowFrames] = useState(true);
  const clipIds = clips.map(c => c.id).join('\n');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const c of clips) {
        if (!alive) return;
        if (frames[c.id] !== undefined) continue;   // уже брали, второй раз незачем
        const data = await grabFrame(c.file);
        if (!alive) return;
        // Пишем и пустую строку: это «пробовали, кодек не по зубам»
        setFrames(prev => ({ ...prev, [c.id]: data }));
      }
    })();
    return () => { alive = false; };
  }, [clipIds]);

  // Просмотр записи — оверлеем по центру экрана.
  //
  // Сначала плеер открывался прямо в карточке, растянутой на всю строку сетки.
  // Так делать нельзя: элемент во всю ширину не встаёт посреди ряда, и карточка
  // уезжала вниз — нажал на третью, а открылось где-то под первой строкой.
  // Оверлей открывается всегда в одном месте, занимает весь экран (название
  // гильдии в игре мелкое) и закрывается щелчком мимо или Esc.
  //
  // Один плеер за раз: пять открытых декодеров четырёхгигабайтных файлов кладут
  // вкладку. Blob-адрес заводим только на время просмотра и сразу отзываем —
  // пока он жив, браузер держит файл.
  const [watching, setWatching] = useState('');
  const [watchUrl, setWatchUrl] = useState('');
  // Адрес держим ещё и в ref: отзывать его внутри апдейтера состояния нельзя,
  // React вправе вызвать апдейтер дважды и отозвал бы живой адрес.
  const watchRef = useRef('');

  const dropUrl = useCallback(() => {
    if (watchRef.current) URL.revokeObjectURL(watchRef.current);
    watchRef.current = '';
  }, []);

  const closeWatch = useCallback(() => {
    dropUrl();
    setWatchUrl('');
    setWatching('');
  }, [dropUrl]);

  const watch = (c: Clip) => {
    dropUrl();
    const url = URL.createObjectURL(c.file);
    watchRef.current = url;
    setWatchUrl(url);
    setWatching(c.id);
  };

  // Уходим со страницы — адрес отзываем, иначе браузер держит файл до перезагрузки
  useEffect(() => dropUrl, [dropUrl]);

  // Запись убрали из списка или она поехала — плеер закрываем сами: файл под ним
  // уже читает заливка, и держать второй читатель незачем.
  useEffect(() => {
    if (watching && !clips.some(c => c.id === watching && c.state === 'ready')) closeWatch();
  }, [clips, watching, closeWatch]);

  // Esc закрывает — как у всех модалок в проекте
  useEffect(() => {
    if (!watching) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeWatch(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [watching, closeWatch]);

  const watched = clips.find(c => c.id === watching) || null;

  // Обложка каждой строки — рядом со строкой. Пять записей за вечер бывают с
  // пятью разными гильдиями, и увидеть это надо ДО заливки: переснять обложку
  // потом можно только руками в Studio, по одной.
  //
  // Рисуем с задержкой: печатают посимвольно, а каждый кадр — это canvas 1280×720.
  const [shots, setShots] = useState<Record<string, string>>({});
  const shotKey = clips.map(c => `${c.id}|${foeOf(c)}`).join('\n');
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const next: Record<string, string> = {};
      for (const c of clips) {
        if (!alive) return;
        try {
          const cv = await renderThumb({ enemy: foeOf(c), nick: status?.nick || '', date, style: status?.thumb });
          next[c.id] = cv.toDataURL('image/jpeg', 0.6);
        } catch { /* обложка не критична, видео зальётся и без неё */ }
      }
      if (alive) setShots(next);
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [shotKey, date, status?.nick, status?.thumb]);

  const patch = (id: string, p: Partial<Clip>) =>
    setClips(prev => prev.map(c => (c.id === id ? { ...c, ...p } : c)));

  const uploadOne = async (clip: Clip, signal: AbortSignal) => {
    patch(clip.id, { state: 'uploading', sent: 0, error: undefined });
    try {
      // Пустой заголовок YouTube не примет. Такое возможно, только если сняли
      // «ник и дата» и не вписали соперника — тогда пусть будет имя файла.
      const title = titleOf(clip) || clip.file.name.replace(/\.[^.]+$/, '');
      const meta = {
        snippet: { title, description: '', categoryId: '20' },
        // embeddable ставим явно: записи смотрят в галерее на сайте, и запрет
        // встраивания сделал бы плеер там пустым. Возрастное ограничение сюда
        // не относится — его YouTube ставит сам и через API оно не пишется.
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, embeddable: true }
      };
      const videoId = await uploadVideo(clip.file, meta, tokens.current, {
        onProgress: (sent) => patch(clip.id, { sent }),
        signal
      });

      // Ссылка валидна сразу после последнего байта — обработку YouTube не ждём,
      // это минуты, которые человеку не нужны.
      // Обложка своя у каждой записи — с её соперником, а не с общим
      let noThumb = false;
      const blob = await thumbBlob({ enemy: foeOf(clip), nick: status?.nick || '', date, style: status?.thumb });
      if (blob) noThumb = !(await setThumbnail(videoId, blob, tokens.current));
      else noThumb = true;

      const attached = await api.ytAttach(videoId, privacy);
      patch(clip.id, { state: 'done', videoId, noThumb, sent: clip.file.size,
        error: attached ? undefined : t('залито, но в плейлист не попало') });
    } catch (e) {
      patch(clip.id, { state: 'error', error: errText(t, e) });
    }
  };

  /** Льём пачкой, но не больше пяти разом: браузер держит шесть соединений к хосту. */
  const run = async (targets: Clip[]) => {
    if (!targets.length) return;
    setBusy(true);
    abort.current = new AbortController();
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || abort.current?.signal.aborted) return;
        await uploadOne(next, abort.current!.signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));
    setBusy(false);
    load();   // счётчик «залито / 100» обновляем после пачки
  };

  // Соперники по строкам разошлись — значит и обложки разные, и крупная картинка
  // показывает лишь первую из них. Об этом надо сказать, а не делать вид.
  const mixedFoes = new Set(clips.map(foeOf)).size > 1;

  const failed = clips.filter(c => c.state === 'error');
  const pending = clips.filter(c => c.state === 'ready');
  const totalBytes = clips.reduce((s, c) => s + c.file.size, 0);
  const sentBytes = clips.reduce((s, c) => s + (c.state === 'done' ? c.file.size : c.sent), 0);

  const left = useMemo(() => {
    if (typeof status?.uploadsToday !== 'number') return null;
    return Math.max(0, (status.dailyLimit || DAILY_LIMIT) - status.uploadsToday);
  }, [status?.uploadsToday, status?.dailyLimit]);

  const changePlaylistPrivacy = async (next: 'unlisted' | 'public') => {
    const word = next === 'public' ? t('открытым') : t('скрытым («по ссылке»)');
    const ok = await confirm(
      t('Сменить видимость плейлиста на %s? Все записи внутри тоже сменят её — иначе скрытые ролики в открытом плейлисте начинают находиться поиском.').replace('%s', word),
      { confirmLabel: t('Сменить') }
    );
    if (!ok) return;
    setBusy(true);
    const r = await api.ytPrivacy(next);
    setBusy(false);
    if (!r) return toast(t('Не удалось сменить видимость.'), 'error');
    toast(t('Готово: записей затронуто %n').replace('%n', String(r.changed)), 'success');
    load();
  };

  // ---------------------------------------------------------------- экраны

  if (!status) {
    return <p className="text-slate-500 text-sm py-10 text-center">
      <i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}
    </p>;
  }

  if (!status.configured) {
    return (
      <div className="max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
        <i className="fa-brands fa-youtube text-3xl text-slate-600 mb-3"></i>
        <h2 className="cinzel text-lg font-semibold mb-1">{t('Заливка не настроена')}</h2>
        <p className="text-sm text-slate-400">
          {t('Офицер подключает канал в разделе «Интеграции» — там же, где Discord.')}
        </p>
      </div>
    );
  }

  if (!status.nick) {
    return (
      <div className="max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
        <i className="fa-solid fa-link-slash text-3xl text-amber-500/70 mb-3"></i>
        <h2 className="cinzel text-lg font-semibold mb-1">{t('Нужен привязанный ник')}</h2>
        <p className="text-sm text-slate-400">
          {t('Плейлист называется вашим игровым ником, поэтому заливать можно только за себя.')}
        </p>
      </div>
    );
  }

  const hasClips = clips.length > 0;
  const allDone = hasClips && clips.every(c => c.state === 'done');

  // Ширина должна быть ЗАРАБОТАНА. Строке файла она нужна: там имя, готовое
  // название, полоска и размер в один ряд. Полю «с кем бились» не нужна вовсе —
  // метровое поле ввода не удобнее трёхсотпиксельного. Поэтому слева рабочая
  // поверхность, которая тянется, а справа панель публикации фиксированной
  // ширины: обложка 16:9 и три коротких поля.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }
  };

  return (
    <>
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <h1 className="cinzel text-2xl font-semibold text-slate-100">{t('Залить записи')}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {t('Файлы уходят на канал гильдии прямо с вашего компьютера — сайт их не хранит и не пересылает.')}
          </p>
        </div>
        {onGallery && (
          <button
            onClick={onGallery}
            className="ml-auto px-3 py-2 rounded-lg border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 text-sm font-semibold transition-colors"
          ><i className="fa-solid fa-photo-film mr-2"></i>{t('Все записи')}</button>
        )}
      </div>

      {/* Связь проверена ЗАРАНЕЕ: узнать о поломке на последнем шаге, выбрав
          три файла по четыре гигабайта, — главная претензия к десктопу. */}
      {!status.ready && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg px-4 py-3 text-sm text-red-300">
          <i className="fa-solid fa-triangle-exclamation mr-2"></i>
          {status.problem === ERR.ACCESS
            ? t('Доступ к каналу недействителен. Это чинится на сервере, не у вас.')
            : status.problem === ERR.QUOTA
              ? t('Дневной лимит загрузок исчерпан. Сбросится в полночь по тихоокеанскому времени.')
              : t('YouTube сейчас не отвечает. Заливать нельзя.')}
          <button onClick={load} className="ml-2 underline hover:text-red-200">{t('Проверить снова')}</button>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_25rem] items-start">

        {/* ---------------- рабочая поверхность: файлы ---------------- */}
        <div className="min-w-0" {...dropProps}>
          {!hasClips ? (
            // Пусто — зона броска и есть работа, поэтому она большая по праву
            <div className={`rounded-2xl border border-dashed flex flex-col items-center justify-center gap-3 min-h-[24rem] transition-colors
              ${dragging ? 'border-amber-600 bg-amber-950/10' : 'border-slate-700'}`}>
              <i className="fa-solid fa-film text-3xl text-slate-700"></i>
              <button
                onClick={() => fileInput.current?.click()}
                className="px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-slate-950 text-sm font-semibold transition-colors"
              >
                <i className="fa-solid fa-folder-open mr-2"></i>{t('Выбрать записи')}
              </button>
              <p className="text-xs text-slate-500">{t('или перетащите их сюда')}</p>
            </div>
          ) : (
            <div className={`rounded-2xl transition-colors ${dragging ? 'ring-1 ring-amber-600/60' : ''}`}>
              {/* Кнопка добавления — маленькая, в шапке списка. Полоса во всю
                  ширину ради одной кнопки ширину ничем не оправдывала. */}
              <div className="flex items-center gap-3 pb-3">
                <span className="text-[11px] uppercase tracking-widest text-slate-500">
                  {t('Файлы')} · {clips.length}
                </span>
                <span className="text-xs text-slate-600">{size(totalBytes)}</span>

                {/* Что показывать на плитках. Кадр отвечает на «тот ли это файл»,
                    обложка — на «что уедет на YouTube». Нужны оба, но не разом:
                    вторая картинка в углу первой была бы нечитаемой. */}
                <div className="ml-auto flex items-center rounded-lg border border-slate-800 p-0.5">
                  {([['кадр', true], ['обложка', false]] as const).map(([label, v]) => (
                    <button
                      key={label}
                      onClick={() => setShowFrames(v)}
                      title={v
                        ? t('Кадр из вашего файла. На YouTube он не уходит.')
                        : t('Обложка, которая уедет на YouTube.')}
                      className={`px-2 py-1 rounded text-xs transition-colors
                        ${showFrames === v ? 'bg-slate-800 text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}
                    >{t(label)}</button>
                  ))}
                </div>

                <button
                  onClick={() => fileInput.current?.click()}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 text-xs font-semibold transition-colors"
                >
                  <i className="fa-solid fa-plus mr-1.5"></i>{t('Добавить')}
                </button>
              </div>

              {/* Карточками, а не строками. Строка на широком мониторе давала
                  дыру в пол-экрана между именем файла и полем, а обложку
                  прижимала до марки — при том, что проверяют глазами именно её.
                  Сетка та же, что в галерее: две страницы одного семейства. */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {clips.map(c => {
                  const pct = c.file.size ? Math.round((c.state === 'done' ? c.file.size : c.sent) / c.file.size * 100) : 0;
                  return (
                    <article key={c.id} className="min-w-0 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                      {/* Обложка ИМЕННО этой записи. С пятью разными соперниками
                          одна картинка на всех — это ровно то, что ломалось. */}
                      <div className="relative aspect-video bg-slate-950 border-b border-slate-800">
                        {(() => {
                          // Кадр, если он есть и переключатель на кадрах; иначе обложка.
                          // Кодек не по зубам браузеру — молча показываем обложку.
                          const pic = (showFrames && frames[c.id]) || shots[c.id];
                          return pic ? <img src={pic} alt="" className="absolute inset-0 w-full h-full object-cover" /> : null;
                        })()}
                        {showFrames && frames[c.id] === undefined && (
                          <span className="absolute inset-0 flex items-center justify-center text-slate-700">
                            <i className="fa-solid fa-spinner fa-spin text-sm"></i>
                          </span>
                        )}

                        {/* Открыть плеер. Только у неотправленных: у остальных
                            смотреть уже поздно, а место под состояние нужнее. */}
                        {c.state === 'ready' && (
                          <button
                            onClick={() => watch(c)}
                            title={t('Посмотреть запись — например, чтобы узнать соперника')}
                            className="group absolute inset-0 w-full h-full"
                          >
                            <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-slate-950/40 transition-opacity">
                              <span className="w-12 h-12 rounded-full bg-slate-950/80 flex items-center justify-center">
                                <i className="fa-solid fa-play text-slate-100 text-sm ml-0.5"></i>
                              </span>
                            </span>
                          </button>
                        )}

                        {c.state !== 'ready' && (
                          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/70">
                            <i className={`fa-solid text-xl ${
                              c.state === 'done' ? 'fa-circle-check text-emerald-400'
                                : c.state === 'error' ? 'fa-circle-exclamation text-red-400'
                                  : 'fa-spinner fa-spin text-amber-400'}`}></i>
                            {c.state === 'uploading' && (
                              <span className="text-xs text-slate-300 tabular-nums">
                                {mb(c.sent)} / {mb(c.file.size)} {t('МБ')} · {pct}%
                              </span>
                            )}
                          </span>
                        )}

                        {c.state === 'ready' && (
                          <button
                            onClick={() => setClips(prev => prev.filter(x => x.id !== c.id))}
                            title={t('Убрать из списка')}
                            className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-slate-950/70 text-slate-400 hover:text-red-400 transition-colors"
                          ><i className="fa-solid fa-xmark text-xs"></i></button>
                        )}

                        {(c.state === 'uploading' || c.state === 'done') && (
                          <div className="absolute bottom-0 inset-x-0 h-1 bg-slate-950">
                            <div
                              className={`h-full ${c.state === 'done' ? 'bg-emerald-500' : 'bg-amber-500'}`}
                              style={{ width: `${pct}%` }}
                            ></div>
                          </div>
                        )}
                      </div>

                      <div className="p-3 space-y-2 min-w-0">
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="text-sm text-slate-200 truncate">{c.file.name}</span>
                          <span className="text-xs text-slate-600 whitespace-nowrap tabular-nums ml-auto">{size(c.file.size)}</span>
                        </div>
                        <p className="text-xs text-slate-500 truncate">
                          {titleOf(c) || t('название появится, когда впишете соперника')}
                        </p>

                        {c.state === 'ready' ? (
                          <div className="flex items-center gap-2 pt-1">
                            <input
                              value={c.enemy}
                              onChange={e => patch(c.id, { enemy: e.target.value })}
                              placeholder={enemy.trim() || t('соперник')}
                              title={t('Соперник этой записи. Пусто — возьмётся общий.')}
                              className="min-w-0 flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-600 transition-colors"
                            />
                            <label
                              title={t('Подставлять «ник [дата]» в начало названия')}
                              className="flex items-center gap-1.5 text-xs text-slate-500 whitespace-nowrap cursor-pointer"
                            >
                              <input
                                type="checkbox" checked={c.prefix}
                                onChange={e => patch(c.id, { prefix: e.target.checked })}
                                className="w-3.5 h-3.5 accent-amber-600"
                              />
                              {t('ник и дата')}
                            </label>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-xs pt-1">
                            {c.state === 'done' && c.videoId && (
                              <a href={`https://youtu.be/${c.videoId}`} target="_blank" rel="noreferrer"
                                className="text-emerald-400 underline">{t('Открыть видео')}</a>
                            )}
                            {c.state === 'error' && <span className="text-red-400 truncate">{c.error}</span>}
                            {c.state === 'done' && (c.noThumb || c.error) && (
                              <span className="text-slate-500 truncate ml-auto">
                                {c.noThumb && t('без превью')}{c.noThumb && c.error ? ' · ' : ''}
                                {c.error && <span className="text-amber-400">{c.error}</span>}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
          <input
            ref={fileInput} type="file" accept="video/*" multiple hidden
            onChange={e => { addFiles(e.target.files || []); e.target.value = ''; }}
          />
        </div>

        {/* ---------------- панель публикации ----------------
            Узкая нарочно: тут только короткие поля и картинка 16:9. Липкая на
            широком экране, чтобы кнопка не уезжала под длинный список. */}
        <aside className="min-w-0 xl:sticky xl:top-20 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
          {/* Пока файлов нет — здесь единственное место, где видно, как обложка
              вообще выглядит. Как только файлы выбраны, её показывает каждая
              карточка своей, и вторая такая же картинка тут только дублирует. */}
          <div>
            <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">{t('Обложка')}</p>
            {!hasClips && (
              preview
                ? <img src={preview} alt={t('Обложка')} className="w-full rounded-lg border border-slate-800" />
                : <div className="w-full aspect-video rounded-lg border border-dashed border-slate-800"></div>
            )}
            {hasClips && (
              <p className="text-xs text-slate-500">
                {mixedFoes ? t('У каждой записи своя — видно в карточках.') : t('Одна на все записи — видно в карточках.')}
              </p>
            )}
            {isOfficer && (
              <button onClick={onSettings}
                className="text-[11px] text-slate-500 hover:text-amber-400 underline mt-1.5 transition-colors">
                {t('Изменить название и фон')}
              </button>
            )}
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">{t('С кем бились')}</label>
            <input
              value={enemy} onChange={e => setEnemy(e.target.value)}
              placeholder={t('название вражеской гильдии')}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <p className="text-[11px] text-slate-600 mt-1">
              {t('Идёт на все записи. Если за вечер бились с разными — впишите своего в строке.')}
            </p>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">{t('Дата боя')}</label>
            <input
              type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600"
            />
            <p className="text-[11px] text-slate-600 mt-1">{t('Взята из файлов, можно поправить.')}</p>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5">{t('Кто сможет посмотреть')}</label>
            <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
              {(['unlisted', 'public'] as const).map(v => {
                // В открытый плейлист «по ссылке» не предлагаем: такое видео
                // всё равно находится поиском, то есть прячется только на вид.
                const locked = status.playlist?.privacy === 'public' && v === 'unlisted';
                return (
                  <button
                    key={v} disabled={locked} onClick={() => setPrivacy(v)}
                    title={locked ? t('В открытом плейлисте скрытая запись всё равно находится поиском') : ''}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-30
                      ${privacy === v ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
                  >{v === 'unlisted' ? t('только по ссылке') : t('все на YouTube')}</button>
                );
              })}
            </div>
          </div>

          <div className="pt-1 space-y-2">
            {busy ? (
              <button
                onClick={() => abort.current?.abort()}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:border-red-800 hover:text-red-300 text-sm font-semibold transition-colors"
              >{t('Остановить')}</button>
            ) : allDone ? (
              <p className="text-sm text-emerald-400 text-center py-2">
                <i className="fa-solid fa-circle-check mr-2"></i>{t('Всё залито')}
              </p>
            ) : (
              <button
                onClick={() => run(pending)}
                disabled={!status.ready || !pending.length}
                className="w-full px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-sm font-semibold transition-colors"
              >
                <i className="fa-solid fa-cloud-arrow-up mr-2"></i>
                {/* «Залить 0 записей» — бессмыслица; пока файлов нет, кнопка
                    просто называет действие и остаётся недоступной. */}
                {!pending.length
                  ? t('Залить записи')
                  : pending.length === 1
                    ? t('Залить запись')
                    : plural(pending.length,
                        t('Залить %n запись'), t('Залить %n записи'), t('Залить %n записей')
                      ).replace('%n', String(pending.length))}
              </button>
            )}

            {/* Повторяем только упавшие: успешные перезаливать нельзя, будут дубли */}
            {!busy && failed.length > 0 && (
              <button
                onClick={() => run(failed)}
                className="w-full px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 text-xs font-semibold transition-colors"
              >{t('Повторить упавшие')} · {failed.length}</button>
            )}
            {busy && (
              <p className="text-[11px] text-slate-500 text-center tabular-nums">
                {size(sentBytes)} / {size(totalBytes)} · {t('не закрывайте вкладку')}
              </p>
            )}
          </div>

          <div className="pt-3 border-t border-slate-800 space-y-1 text-[11px] text-slate-500">
            <p className="truncate"><i className="fa-brands fa-youtube mr-1.5"></i>{status.channel || t('канал гильдии')}</p>
            {typeof status.uploadsToday === 'number' && (
              <p className={left !== null && left <= 10 ? 'text-amber-400' : ''}>
                {t('сегодня залито %a из %b')
                  .replace('%a', String(status.uploadsToday))
                  .replace('%b', String(status.dailyLimit))}
              </p>
            )}
            <p className="flex flex-wrap items-center gap-x-1.5">
              {t('плейлист')} «{status.nick}»
              {status.playlist ? (
                <>
                  · {status.playlist.privacy === 'public' ? t('видят все') : t('только по ссылке')}
                  <button
                    disabled={busy}
                    onClick={() => changePlaylistPrivacy(status.playlist!.privacy === 'public' ? 'unlisted' : 'public')}
                    className="underline hover:text-slate-300 disabled:opacity-40"
                  >{t('изменить')}</button>
                </>
              ) : <>· {t('появится после первой заливки')}</>}
            </p>
            {status.tokenScope && !status.tokenScope.includes('.upload') && (
              <p className="text-amber-500/70" title={t('Пока вы на этой странице, браузер держит полный доступ к каналу — Google не умеет выдавать урезанный. Отдельный токен только на загрузку это чинит.')}>
                <i className="fa-solid fa-triangle-exclamation mr-1"></i>{t('доступ шире, чем нужно')}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>

      {/* ---------------- просмотр записи ----------------
          Щелчок мимо плеера закрывает: это привычка, а не украшение — ровно так
          ведут себя все оверлеи, и искать крестик глазами не приходится. */}
      {watched && (
        <div
          onClick={closeWatch}
          /* Фон НЕПРОЗРАЧНЫЙ, в отличие от обычных модалок. Полупрозрачный
             оставлял сверху светлую полосу: шапка со своим фоном slate-900/80
             просвечивала и читалась как «блюр не достаёт до края». Здесь это и
             не нужно — смотрят видео, и подложка под ним только мешает. */
          className="fixed inset-0 z-[300] flex flex-col p-4 gap-3 bg-slate-950 animate-in fade-in duration-200"
        >
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-sm text-slate-300 truncate">{watched.file.name}</span>
            <span className="text-xs text-slate-500 whitespace-nowrap tabular-nums">{size(watched.file.size)}</span>
            <button
              onClick={closeWatch}
              className="ml-auto flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-100 text-sm font-semibold transition-colors"
            >
              <i className="fa-solid fa-xmark"></i>{t('Закрыть')}
            </button>
          </div>

          {/* Плеер по размеру кадра, а не во всю ширину. Иначе чёрные поля по
              бокам принадлежали бы самому элементу <video>, и щелчок по ним —
              визуально по пустому месту — ничего бы не закрыл. */}
          <div className="min-h-0 flex-1 flex items-center justify-center">
            <video
              // Клик по самому плееру не закрывает: по нему ставят паузу
              onClick={e => e.stopPropagation()}
              src={watchUrl} controls autoPlay muted playsInline
              className="max-w-full max-h-full bg-black rounded-lg"
            />
          </div>

          {/* Соперник вписывается не отходя: за этим сюда и заходили */}
          <div
            onClick={e => e.stopPropagation()}
            className="shrink-0 flex flex-wrap items-center gap-3 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2"
          >
            <label className="text-xs text-slate-400 whitespace-nowrap">{t('С кем бились')}</label>
            <input
              autoFocus
              value={watched.enemy}
              onChange={e => patch(watched.id, { enemy: e.target.value })}
              placeholder={enemy.trim() || t('соперник')}
              className="min-w-0 flex-1 max-w-md bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-amber-600 transition-colors"
            />
            <span className="text-xs text-slate-500 truncate">{titleOf(watched)}</span>
          </div>
        </div>
      )}
    </>
  );
};

export default GvgUploader;
