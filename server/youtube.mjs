// Заливка записей ГВГ на канал гильдии. Сервер здесь делает РОВНО ДВЕ вещи:
// выдаёт браузеру короткоживущий токен и ведёт плейлисты. Само видео идёт
// напрямую из браузера в Google и сервера не касается вовсе — на VPS десять
// гигабайт диска, а клип весит два-четыре, и «сначала к нам, потом туда»
// съедало бы сотню гигабайт трафика за вечер.
//
// Зависимостей нет: fetch и crypto в Node есть свои.

import fs from 'node:fs';
import path from 'node:path';
import { classifyError, ERR, worthRetry, retryDelay, videoFacts, ID_BATCH } from './ytmeta.mjs';

const OAUTH = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';

// Браузеру отдаём УЗКОЕ право: залить видео и поставить обложку. Плейлисты им не
// управляются (playlistItems.insert требует полного youtube), и это как раз то,
// чего мы хотим: утёкший из вкладки токен не сможет ни удалить чужую запись, ни
// переписать чужой плейлист.
export const BROWSER_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

// Сколько записей за раз соглашаемся перевести в другую видимость. Каждая правка
// стоит 50 единиц суточной квоты, так что тысяча видео молча съела бы её целиком.
const PRIVACY_BATCH_CAP = 60;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Полный доступ нужен серверу: плейлисты, их видимость и счётчик загрузок.
export const FULL_SCOPE = 'https://www.googleapis.com/auth/youtube';

export function createYouTube(env = process.env, dataDir = '') {
  // Ключи живут в ДАННЫХ, а переменные окружения — только засев при первом
  // запуске. Ровно так же сделан Телеграм: иначе подключить свой канал мог бы
  // только тот, у кого есть доступ к серверу, и офицеру чужой гильдии пришлось
  // бы присылать свои секреты в личку.
  const FILE = dataDir ? path.join(dataDir, 'ytconfig.json') : '';

  const cfg = {
    clientId: env.YT_CLIENT_ID || '',
    clientSecret: env.YT_CLIENT_SECRET || '',
    refreshToken: env.YT_REFRESH_TOKEN || '',
    // Второй ключ, выданный СРАЗУ только на загрузку. Он нужен потому, что
    // сузить права у существующего нельзя: Google отвечает invalid_scope и
    // выдаёт ровно тот набор, на который согласились при первой авторизации.
    // Если он задан — именно его получает браузер, и утёкшим из вкладки токеном
    // нельзя ни удалить чужое видео, ни тронуть плейлисты.
    uploadRefreshToken: env.YT_REFRESH_TOKEN_UPLOAD || ''
  };

  if (FILE) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* ещё не настраивали */ }
  }

  const save = () => {
    if (!FILE) return;
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
      fs.renameSync(tmp, FILE);   // атомарно
    } catch (e) { console.error('[yt] не удалось сохранить настройки:', e?.message || e); }
  };

  const configured = () => !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);

  // Кэш токенов: свой на каждый набор прав. Токен живёт час, но мы считаем его
  // протухшим за минуту до конца — иначе он умрёт посреди уже начатого запроса.
  const cache = new Map(); // scope -> { token, until, scope }

  /**
   * Обменять refresh-токен на access-токен. `scope` просим явно, но Google
   * может вернуть и более широкий набор — что он реально выдал, лежит в ответе
   * и показывается офицеру в панели, чтобы это не было догадкой.
   */
  const mint = async (scope, refreshToken = cfg.refreshToken) => {
    if (!configured()) return { ok: false, kind: ERR.ACCESS, error: 'Заливка не настроена' };
    const key = `${scope || '*'}|${refreshToken.slice(-8)}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return { ok: true, ...hit };

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken
    });
    if (scope) body.set('scope', scope);

    // Повторы нужны и здесь. Инцидент на десктопе: заливки не начинались двое
    // суток, а обрыв случался в TLS-рукопожатии ДО первого байта видео —
    // подготовительные запросы шли голыми, и одна сетевая икота роняла сессию.
    for (let attempt = 0; attempt < 4; attempt++) {
      let status = 0, data = null;
      try {
        const r = await fetch(OAUTH, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        status = r.status;
        data = await r.json().catch(() => null);
        if (r.ok && data?.access_token) {
          const rec = {
            token: data.access_token,
            scope: data.scope || '',
            until: Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000
          };
          cache.set(key, rec);
          return { ok: true, ...rec };
        }
      } catch { /* сеть — попробуем ещё */ }
      const kind = classifyError(status, data);
      if (!worthRetry(kind) || attempt === 3) return { ok: false, kind, status };
      await sleep(retryDelay(attempt));
    }
    return { ok: false, kind: ERR.NETWORK };
  };

  /** Полный доступ — только для серверных действий (плейлисты, видимость, счётчик). */
  const serverToken = () => mint(null);

  /** Один вызов YouTube API нашим токеном, с повторами. Наружу не бросает. */
  const api = async (method, path, { query, body, retries = 4 } = {}) => {
    const t = await serverToken();
    if (!t.ok) return { ok: false, kind: t.kind, status: t.status || 0 };
    const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      let status = 0, data = null;
      try {
        const r = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${t.token}`,
            ...(body ? { 'content-type': 'application/json' } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        status = r.status;
        data = r.status === 204 ? {} : await r.json().catch(() => null);
        if (r.ok) return { ok: true, data };
      } catch { /* сеть */ }
      const kind = classifyError(status, data);
      if (!worthRetry(kind) || attempt === retries - 1) return { ok: false, kind, status, data };
      await sleep(retryDelay(attempt));
    }
    return { ok: false, kind: ERR.NETWORK, status: 0 };
  };

  // ---- Плейлисты ----
  // Ищем по названию среди своих. Название плейлиста — игровой ник, и берётся он
  // на сервере из печеньки: подставить чужой неоткуда, поэтому «строго за себя»
  // держится не интерфейсом, а тем, что другого ника в запросе просто нет.
  const findPlaylist = async (title) => {
    let page;
    for (let i = 0; i < 10; i++) {   // до 500 плейлистов, дальше искать нечего
      const r = await api('GET', '/playlists', {
        query: { part: 'snippet,status', mine: 'true', maxResults: '50', ...(page ? { pageToken: page } : {}) }
      });
      if (!r.ok) return r;
      const found = (r.data?.items || []).find(p => (p.snippet?.title || '') === title);
      if (found) return { ok: true, data: found };
      page = r.data?.nextPageToken;
      if (!page) break;
    }
    return { ok: true, data: null };
  };

  const createPlaylist = (title, privacy) => api('POST', '/playlists', {
    query: { part: 'snippet,status' },
    body: {
      snippet: { title, description: 'Записи ГВГ' },
      status: { privacyStatus: privacy }
    }
  });

  /** Плейлист участника: найти или завести. privacy применяется только при создании. */
  const ensurePlaylist = async (title, privacy = 'unlisted') => {
    const found = await findPlaylist(title);
    if (!found.ok) return found;
    if (found.data) return { ok: true, data: found.data, created: false };
    const made = await createPlaylist(title, privacy);
    return made.ok ? { ok: true, data: made.data, created: true } : made;
  };

  const addToPlaylist = (playlistId, videoId) => api('POST', '/playlistItems', {
    query: { part: 'snippet' },
    body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }
  });

  const playlistVideoIds = async (playlistId) => {
    const ids = [];
    let page;
    for (let i = 0; i < 10; i++) {
      const r = await api('GET', '/playlistItems', {
        query: { part: 'contentDetails', playlistId, maxResults: '50', ...(page ? { pageToken: page } : {}) }
      });
      if (!r.ok) return r;
      for (const it of (r.data?.items || [])) {
        const id = it?.contentDetails?.videoId;
        if (id) ids.push(id);
      }
      page = r.data?.nextPageToken;
      if (!page) break;
    }
    return { ok: true, data: ids };
  };

  /**
   * Сменить видимость плейлиста ВМЕСТЕ со всеми записями внутри.
   *
   * Порознь их менять нельзя: у YouTube есть ловушка — видео «по ссылке»,
   * лежащее в ОТКРЫТОМ плейлисте, начинает находиться поиском. Человек считает
   * запись спрятанной, а она доступна всем. Поэтому состояние всегда цельное.
   */
  const setPrivacy = async (title, privacy) => {
    const pl = await findPlaylist(title);
    if (!pl.ok) return pl;
    if (!pl.data) return { ok: false, kind: ERR.API, error: 'Плейлиста ещё нет' };
    const playlistId = pl.data.id;

    const upd = await api('PUT', '/playlists', {
      query: { part: 'snippet,status' },
      body: {
        id: playlistId,
        snippet: { title: pl.data.snippet?.title || title, description: pl.data.snippet?.description || '' },
        status: { privacyStatus: privacy }
      }
    });
    if (!upd.ok) return upd;

    const ids = await playlistVideoIds(playlistId);
    if (!ids.ok) return ids;

    let changed = 0, failed = 0;
    for (const videoId of ids.data.slice(0, PRIVACY_BATCH_CAP)) {
      const r = await api('PUT', '/videos', {
        query: { part: 'status' },
        body: { id: videoId, status: { privacyStatus: privacy } },
        retries: 2
      });
      if (r.ok) changed++; else failed++;
    }
    return { ok: true, data: { playlistId, privacy, total: ids.data.length, changed, failed } };
  };

  // ---- Галерея записей ----
  //
  // Смотрим не по плейлистам игроков, а по общему списку загрузок канала: с
  // ростом гильдии плейлистов станут десятки, и обход каждого стоил бы по
  // запросу на человека при каждом обновлении. Список загрузок один, а кто чей
  // ролик — видно из заголовка, мы его сами и собирали.
  //
  // Важно: скрытые записи в этом списке ЕСТЬ, потому что мы спрашиваем как
  // владелец канала. Любой сторонний виджет показал бы пустоту — у гильдии
  // всё «по ссылке».
  const GALLERY_TTL_MS = 10 * 60_000;
  const GALLERY_MAX_PAGES = 10;      // до 500 записей; дальше не тянем
  let galleryCache = null;           // { at, data }

  const gallery = async ({ force = false } = {}) => {
    if (!force && galleryCache && Date.now() - galleryCache.at < GALLERY_TTL_MS) {
      return { ok: true, data: galleryCache.data, cached: true };
    }

    const ch = await api('GET', '/channels', { query: { part: 'snippet,contentDetails', mine: 'true' }, retries: 2 });
    if (!ch.ok) return ch;
    const item = (ch.data?.items || [])[0];
    const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return { ok: false, kind: ERR.API, error: 'Список загрузок не найден' };

    // Сначала только идентификаторы: заголовки из этого списка брать нельзя —
    // он какое-то время держит и УДАЛЁННЫЕ записи, и они приезжали в галерею.
    const ids = [];
    let page;
    for (let i = 0; i < GALLERY_MAX_PAGES; i++) {
      const r = await api('GET', '/playlistItems', {
        query: {
          part: 'contentDetails', playlistId: uploads,
          maxResults: '50', ...(page ? { pageToken: page } : {})
        }
      });
      if (!r.ok) return r;
      for (const it of (r.data?.items || [])) {
        const id = it?.contentDetails?.videoId;
        if (id && !ids.includes(id)) ids.push(id);
      }
      page = r.data?.nextPageToken;
      if (!page) break;
    }

    // Сверка пачками по 50: живое видео `videos.list` вернёт, удалённое молча
    // пропустит. Одна единица квоты на полсотни записей — дешевле, чем показывать
    // людям битые плитки. Оттуда же берётся возрастное ограничение и запрет
    // встраивания: без них плеер на странице просто оставался бы чёрным.
    const videos = [];
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const chunk = ids.slice(i, i + ID_BATCH);
      const r = await api('GET', '/videos', {
        query: { part: 'snippet,status,contentDetails', id: chunk.join(','), maxResults: String(ID_BATCH) }
      });
      if (!r.ok) return r;
      const byId = new Map((r.data?.items || []).map(v => [v.id, v]));
      for (const id of chunk) {
        const v = byId.get(id);
        if (v) videos.push(videoFacts(v));   // нет в ответе — удалено, и хорошо
      }
    }

    // Плейлисты игроков — отдельным запросом, одна единица квоты. Нужны, чтобы
    // показать «чьи вообще есть записи» до того, как человек начал фильтровать.
    const pls = [];
    let plPage;
    for (let i = 0; i < 5; i++) {
      const r = await api('GET', '/playlists', {
        query: { part: 'snippet,contentDetails,status', mine: 'true', maxResults: '50', ...(plPage ? { pageToken: plPage } : {}) },
        retries: 2
      });
      if (!r.ok) break;   // без плейлистов галерея всё равно работает
      for (const p of (r.data?.items || [])) {
        pls.push({
          id: p.id,
          title: p.snippet?.title || '',
          count: p.contentDetails?.itemCount ?? 0,
          privacy: p.status?.privacyStatus || ''
        });
      }
      plPage = r.data?.nextPageToken;
      if (!plPage) break;
    }

    const data = { channel: item?.snippet?.title || '', videos, playlists: pls, at: Date.now() };
    galleryCache = { at: Date.now(), data };
    return { ok: true, data, cached: false };
  };

  /** Сбросить кэш — после заливки, чтобы свежая запись появилась сразу. */
  const galleryStale = () => { galleryCache = null; };

  // ---- Диагностика ----

  /** Дешёвая проверка связи при открытии страницы: 1 единица квоты. */
  const channel = async () => {
    const r = await api('GET', '/channels', { query: { part: 'snippet,contentDetails', mine: 'true' }, retries: 2 });
    if (!r.ok) return r;
    const item = (r.data?.items || [])[0];
    if (!item) return { ok: false, kind: ERR.ACCESS, error: 'Канал не найден' };
    return {
      ok: true,
      data: {
        title: item.snippet?.title || '',
        uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads || ''
      }
    };
  };

  // Квота сбрасывается в полночь по тихоокеанскому времени. API остаток не
  // отдаёт вовсе, поэтому считаем сами: сколько видео на канале опубликовано
  // сегодняшним тихоокеанским днём.
  const ptDate = (iso) => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(iso));
    } catch { return ''; }
  };

  const uploadsToday = async (uploadsPlaylist) => {
    if (!uploadsPlaylist) return { ok: true, data: 0 };
    const today = ptDate(new Date().toISOString());
    let count = 0, page;
    for (let i = 0; i < 4; i++) {   // до 200 штук; если больше — ты и так за пределом
      const r = await api('GET', '/playlistItems', {
        query: { part: 'contentDetails', playlistId: uploadsPlaylist, maxResults: '50', ...(page ? { pageToken: page } : {}) },
        retries: 2
      });
      if (!r.ok) return r;
      let older = false;
      for (const it of (r.data?.items || [])) {
        const at = it?.contentDetails?.videoPublishedAt;
        if (!at) continue;
        if (ptDate(at) === today) count++;
        else { older = true; break; }   // список идёт от свежих — дальше только старее
      }
      page = r.data?.nextPageToken;
      if (older || !page) break;
    }
    return { ok: true, data: count };
  };

  // Умеет ли этот refresh-токен сужаться. Проверено на живых ключах: Google
  // отвечает `invalid_scope` (400) — при обмене refresh-токена права сузить
  // НЕЛЬЗЯ, выдаётся ровно тот набор, на который человек когда-то согласился.
  // Просить всё равно продолжаем: если однажды заведут отдельный токен только
  // на загрузку, он подхватится сам, без правок кода.
  let narrowingWorks = true;

  /**
   * Токен для браузера. Пытаемся получить узкий; если приложение так не умеет —
   * отдаём тот, что есть. Что именно выдано, уходит наружу в поле scope и видно
   * на странице: это должно быть заметно, а не подразумеваться.
   */
  const browserToken = async () => {
    // Есть отдельный ключ на загрузку — берём его и ничего не сужаем: он и так
    // выдан ровно на то, что нужно.
    if (cfg.uploadRefreshToken) {
      const own = await mint(null, cfg.uploadRefreshToken);
      if (own.ok) return own;
      // Ключ отозвали или он протух — не роняем заливку, откатываемся на общий
    }
    if (narrowingWorks) {
      const narrow = await mint(BROWSER_SCOPE);
      if (narrow.ok) return narrow;
      narrowingWorks = false;   // второй раз не пробуем — ответ не изменится
    }
    return mint(null);
  };

  // ---- Подключение канала из панели ----
  // Тот же путь, что у входа через Discord: человек уходит к Google, разрешает,
  // возвращается — ключ оседает на сервере. Библиотека для этого не нужна: весь
  // обмен умещается в один fetch, а зависимостей у бэкенда нет по правилу проекта.

  /** Что видно офицеру. Секреты наружу не отдаём, только признаки. */
  const setup = () => ({
    hasKeys: !!(cfg.clientId && cfg.clientSecret),
    clientIdHint: cfg.clientId ? cfg.clientId.slice(0, 12) + '…' : '',
    hasToken: !!cfg.refreshToken,
    hasUploadToken: !!cfg.uploadRefreshToken
  });

  const setKeys = (clientId, clientSecret) => {
    const id = String(clientId ?? '').trim();
    const secret = String(clientSecret ?? '').trim();
    // Сменили приложение — прежние ключи выданы ЕМУ и работать не будут.
    // Оставить их значило бы получить канал, который молча перестал отвечать.
    if (id !== cfg.clientId || secret !== cfg.clientSecret) {
      cfg.refreshToken = '';
      cfg.uploadRefreshToken = '';
      cache.clear();
    }
    cfg.clientId = id;
    cfg.clientSecret = secret;
    save();
    return setup();
  };

  const disconnect = () => {
    cfg.refreshToken = '';
    cfg.uploadRefreshToken = '';
    cache.clear();
    save();
    return setup();
  };

  /** Куда отправить офицера за согласием. Пустая строка — приложение не задано. */
  const authUrl = (redirectUri, scope, state) => {
    if (!cfg.clientId || !redirectUri) return '';
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      // offline+consent — иначе постоянный ключ приходит только при самой первой
      // авторизации; select_account — иначе Google молча берёт тот аккаунт, под
      // которым человек сидит сейчас, и отказ выглядит необъяснимым.
      access_type: 'offline',
      prompt: 'consent select_account'
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  };

  /**
   * Обменять код возврата на постоянный ключ и запомнить его.
   * which: 'full' — которым сервер ведёт плейлисты; 'upload' — который получает
   * браузер. Это ДВА разных согласия, потому что сузить права у готового ключа
   * Google не даёт.
   */
  const saveCode = async (code, redirectUri, which) => {
    if (!cfg.clientId || !cfg.clientSecret || !code) return { ok: false, error: 'not_configured' };
    try {
      const r = await fetch(OAUTH, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        }).toString()
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.refresh_token) return { ok: false, error: data?.error || 'no_refresh_token' };
      if (which === 'upload') cfg.uploadRefreshToken = data.refresh_token;
      else cfg.refreshToken = data.refresh_token;
      cache.clear();
      save();
      return { ok: true, scope: data.scope || '' };
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  };

  return {
    configured,
    setup,
    setKeys,
    disconnect,
    authUrl,
    saveCode,
    browserToken,
    ensurePlaylist,
    addToPlaylist,
    findPlaylist,
    setPrivacy,
    channel,
    gallery,
    galleryStale,
    uploadsToday
  };
}
