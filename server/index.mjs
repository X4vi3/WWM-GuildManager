// Крошечный бэкенд для WWM Guild Manager (без зависимостей, Node >= 18).
// Хранит состояние гильдии в data/state.json.
//  - GET  /api/state  — отдаёт состояние (публично, для просмотра)
//  - POST /api/auth   — проверка пароля редактора { password } -> 200 / 401
//  - POST /api/auth/change — сменить пароль { newPassword }, нужен Bearer <текущий>; рассылает 'authrevoked'
//  - PUT  /api/state  — сохранить состояние, нужен заголовок Authorization: Bearer <пароль>
//  - GET  /api/events — живой поток (SSE): рассылка нового состояния + списка "кто на сайте"
//  - POST /api/presence/claim   — закрепить ник за собой { clientId, playerId }
//  - POST /api/presence/unclaim — снять закрепление { clientId }
//  - всё остальное GET — раздаёт статику из ../dist (SPA), если она есть
//
// Запуск:  EDIT_PASSWORD='ваш-пароль' node server/index.js
// Переменные: PORT (3001), HOST, EDIT_PASSWORD (обязательно), DATA_DIR, STATIC_DIR

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTelegram } from './telegram.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { createDiscord } from './discord.mjs';
import { archiveSessions } from './autofill.mjs';
import { applyAway } from './away.mjs';
import { createYouTube, FULL_SCOPE, BROWSER_SCOPE } from './youtube.mjs';
import {
  SESSION_COOKIE, STATE_COOKIE, SESSION_MAX_AGE_MS, STATE_MAX_AGE_MS,
  sign as signSession, verify as verifySession,
  parseCookies, serializeCookie, clearCookie, callbackUrl, isSecureRequest
} from './session.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3001;
const ENV_PASSWORD = process.env.EDIT_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
// Архив расстановок. Отдельным файлом, а не полем в state.json, по двум причинам:
// его нельзя затереть клиентским сохранением, и он не едет в каждую рассылку
// состояния по SSE — а рассылка уходит на каждую заявку всем открытым вкладкам.
const LINEUPS_FILE = path.join(DATA_DIR, 'lineups.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Пароль редактора. Приоритет: файл auth.json (если меняли из админки) → переменная окружения.
// Так смена пароля из UI переживает перезапуск, а EDIT_PASSWORD остаётся первоначальным значением.
let PASSWORD = ENV_PASSWORD;
try {
  const saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (saved && typeof saved.password === 'string' && saved.password) PASSWORD = saved.password;
} catch { /* файла нет — берём env */ }

if (!PASSWORD) {
  console.error('Ошибка: задайте пароль редактора через переменную EDIT_PASSWORD (или data/auth.json).');
  process.exit(1);
}

const savePassword = (pw) => {
  const tmp = AUTH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ password: pw }));
  fs.renameSync(tmp, AUTH_FILE); // атомарно
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

const send = (res, code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' });

// Тело как СЫРЫЕ байты (Buffer). Нужно и для подписи Discord (подписаны именно
// байты), и для честного разбора текста — см. readBody ниже.
const readRawBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 8_000_000) req.destroy(); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// Тело как строка. ВАЖНО: сначала склеиваем байты, и только потом декодируем один
// раз целиком. Раньше здесь было `data += chunk`, то есть КАЖДЫЙ чанк декодировался
// отдельно — и если многобайтовый символ (эмодзи, кириллица) попадал на границу
// чанков, его половинки превращались в U+FFFD безвозвратно. На проде это уже
// испортило заметку к событию. Тело состояния гильдии — десятки килобайт, чанков
// много, так что попадание было делом времени.
const readBody = async (req) => (await readRawBody(req)).toString('utf8');

const bearer = (req) => {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

// В значение HTTP-заголовка можно положить только байты 0..255, а пароль офицера
// вполне может быть с кириллицей — тогда fetch в браузере падает с TypeError ещё
// до отправки, и офицер выглядит вошедшим, но ничего не сохраняется. Поэтому
// клиент присылает ключ в base64 (так же поступает Basic-аутентификация).
// Старую форму (пароль как есть) принимаем тоже — чтобы деплой никого не выкинул.
const decodeKey = (given) => {
  if (!given) return null;
  try {
    const raw = Buffer.from(given, 'base64').toString('utf8');
    if (!raw) return null;
    const back = Buffer.from(raw, 'utf8').toString('base64').replace(/=+$/, '');
    return back === given.replace(/=+$/, '') ? raw : null;
  } catch {
    return null;
  }
};

// ---- Защита пароля офицера от перебора ----
// Пароль — единственное, что защищает запись: состояние гильдии, токены ботов и
// смену самого пароля. Без ограничения попыток его перебирают на скорости сети,
// и в журнале это выглядит просто как поток запросов. Счётчик держим в памяти:
// перезапуск службы редок, а лишней зависимости и файла на диске не хочется.
const AUTH_WINDOW_MS = 15 * 60_000;   // за это окно помним неудачи
const AUTH_MAX_FAILS = 8;             // столько неудач — и блок
const AUTH_BLOCK_MS = 10 * 60_000;    // на столько блокируем
const AUTH_MAP_CAP = 5000;
const authFails = new Map();          // ip -> { count, first, until }

// За Caddy реальный адрес — ПОСЛЕДНИЙ в X-Forwarded-For: прокси дописывает его
// сам, а всё, что левее, прислал клиент и подделать может. Брать первый нельзя —
// тогда ограничение обходится одним заголовком.
const clientIp = (req) => {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
};

const authBlockedMs = (ip) => {
  const rec = authFails.get(ip);
  if (!rec) return 0;
  const left = rec.until - Date.now();
  return left > 0 ? left : 0;
};

const noteAuthFail = (ip) => {
  const now = Date.now();
  let rec = authFails.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) rec = { count: 0, first: now, until: 0 };
  rec.count++;
  if (rec.count >= AUTH_MAX_FAILS) {
    rec.until = now + AUTH_BLOCK_MS;
    rec.count = 0;
    rec.first = now;
    console.error(`[auth] перебор с ${ip} — блок на ${AUTH_BLOCK_MS / 60000} мин`);
  }
  authFails.set(ip, rec);
  if (authFails.size > AUTH_MAP_CAP) {
    for (const [k, v] of authFails) {
      if (v.until < now && now - v.first > AUTH_WINDOW_MS) authFails.delete(k);
    }
  }
};

// Сравнение постоянного времени: посимвольное выдаёт длину и позицию расхождения.
const samePassword = (given) => {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(PASSWORD, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // холостое сравнение, чтобы время не выдавало длину
    return false;
  }
  return crypto.timingSafeEqual(a, b);
};

// Верный ли ключ офицера. Отсутствие ключа попыткой перебора НЕ считаем — это
// обычный зритель; считаем только непустой неверный.
const officerOk = (req) => {
  const given = bearer(req);
  if (!given) return false;
  const ip = clientIp(req);
  if (authBlockedMs(ip) > 0) return false;
  // Сначала как есть (старые клиенты), потом из base64 (новые)
  const decoded = decodeKey(given);
  if (samePassword(given) || (decoded && samePassword(decoded))) {
    authFails.delete(ip);
    return true;
  }
  noteAuthFail(ip);
  return false;
};

// ---- Присутствие (кто сейчас смотрит / редактирует) + живая рассылка через SSE ----
const connections = new Map(); // connId -> { res, clientId, isEditor, ping }
const identities = new Map();  // clientId -> { guestName, playerId }
let guestCounter = 1;

// identities раньше росла без предела: запись создавалась на каждый новый clientId
// и не удалялась никогда, а завести её мог любой POST /api/presence/claim без
// авторизации. На сервере с 1 ГБ это заметно. Теперь помним, когда клиента видели
// последний раз, и подчищаем тех, кто не онлайн и давно не появлялся.
const IDENTITY_CAP = 5000;
const IDENTITY_TTL_MS = 24 * 3600_000;

const pruneIdentities = () => {
  if (identities.size <= IDENTITY_CAP) return;
  const live = new Set([...connections.values()].map(c => c.clientId));
  const now = Date.now();
  for (const [id, v] of identities) {
    if (live.has(id)) continue;                          // онлайн — не трогаем
    if (now - (v.lastSeen || 0) > IDENTITY_TTL_MS) identities.delete(id);
  }
  // Если и после этого тесно — выкидываем самых давних из тех, кто не онлайн
  if (identities.size > IDENTITY_CAP) {
    const stale = [...identities.entries()]
      .filter(([id]) => !live.has(id))
      .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    for (const [id] of stale.slice(0, identities.size - IDENTITY_CAP)) identities.delete(id);
  }
};

const getIdentity = (clientId) => {
  let id = identities.get(clientId);
  if (!id) {
    id = { guestName: `Гусь${guestCounter++}`, playerId: null, lastSeen: Date.now() };
    identities.set(clientId, id);
    pruneIdentities();
  } else {
    id.lastSeen = Date.now();
  }
  return id;
};

// Один человек = один clientId, даже если у него открыто несколько вкладок
const presenceList = () => {
  const byClient = new Map();
  for (const c of connections.values()) byClient.set(c.clientId, byClient.get(c.clientId) || c.isEditor);
  return [...byClient.entries()].map(([clientId, isEditor]) => {
    const id = getIdentity(clientId);
    return { clientId, guestName: id.guestName, playerId: id.playerId, isEditor };
  });
};

const sseWrite = (res, event, data) => {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
};

const broadcast = (event, data) => { for (const c of connections.values()) sseWrite(c.res, event, data); };
const broadcastPresence = () => broadcast('presence', presenceList());

// ---- Жизненный цикл событий (сроки закрытия регистрации; общий для сайта/ТГ/Дискорда) ----
const lifecycle = createLifecycle(DATA_DIR);

// Кто-то изменил состояние из бота: рассылаем сайту и — главное — просим ОБА бота
// перерисовать анонс. Без этого заявка, поданная в Дискорде, не появлялась бы в
// телеграмном анонсе (и наоборот) до следующего нажатия уже там.
// Повторный вызов у бота-инициатора безвреден: склейка правок сольёт их в одну.
const onBotStateChange = (state, sessionId) => {
  broadcast('state', state);
  if (!sessionId) return;
  telegram.refreshEvent(sessionId).catch(() => {});
  discord.refreshEvent(sessionId).catch(() => {});
};

// ---- Телеграм-бот (настраивается из UI; env-токен — лишь засев при первом запуске).
// Никаких id бесед/тем в env: цель анонсов бот запоминает по /sithere и хранит в файле.
const telegram = createTelegram({
  envToken: process.env.TELEGRAM_BOT_TOKEN || '',
  envSiteUrl: process.env.TELEGRAM_SITE_URL || '',
  dataDir: DATA_DIR,
  lifecycle,
  broadcastState: onBotStateChange
});
telegram.start();

// ---- Discord-бот (настраивается целиком из UI; в env вообще ничего нет) ----
const discord = createDiscord({
  dataDir: DATA_DIR,
  lifecycle,
  broadcastState: onBotStateChange
});
discord.start();

// ---- Вход на сайт через Discord ----
// Ведущее требование: НА ПУТИ ЗАПРОСА DISCORD НЕ УЧАСТВУЕТ НИКОГДА. Сервер дешёвый,
// и ставить чужую сеть между офицером и кнопкой «сохранить» нельзя. Поэтому всё,
// что нужно для проверки прав, лежит либо в подписи печеньки, либо в памяти процесса.

const SESSION_KEY_FILE = path.join(DATA_DIR, 'session.key');
let SESSION_KEY = null;
try {
  const buf = fs.readFileSync(SESSION_KEY_FILE);
  if (buf.length >= 32) SESSION_KEY = buf;
} catch { /* первого запуска ещё не было */ }
if (!SESSION_KEY) {
  SESSION_KEY = crypto.randomBytes(32);
  // Ключ на диске нужен, чтобы перезапуск не выкидывал всю гильдию. Если записать
  // не удалось — работаем на временном: вход останется рабочим, просто переживёт
  // не больше одного перезапуска. Молчать тут нельзя, иначе причина «меня опять
  // разлогинило» так и не всплывёт.
  try { fs.writeFileSync(SESSION_KEY_FILE, SESSION_KEY, { mode: 0o600 }); }
  catch (e) { console.error('[auth] ключ подписи не сохранён, вход переживёт только этот запуск:', e?.message || e); }
}

// Как часто переспрашиваем Discord про роль активного офицера и кого считаем активным.
// Офицеров единицы, значит это единицы запросов в минуту — при пределе Discord
// в 50 запросов в СЕКУНДУ. Обычный игрок не стоит ни одного запроса вовсе.
// OFFICER_TTL_MS переопределяется переменной окружения ТОЛЬКО ради тестов: иначе
// проверка «сняли роль — права отпали сами» шла бы минуту реального времени.
// В проде переменная не задаётся, как и TG_API_BASE.
const OFFICER_TTL_MS = Number(process.env.OFFICER_TTL_MS) || 60_000;
const OFFICER_ACTIVE_MS = 60 * 60_000;
const officerRoles = new Map(); // discordId -> { officer, checkedAt, seenAt }

const noteSeen = (discordId) => {
  const rec = officerRoles.get(discordId) || { officer: false, checkedAt: 0, seenAt: 0 };
  rec.seenAt = Date.now();
  officerRoles.set(discordId, rec);
  return rec;
};

const officerRefresh = async (discordId) => {
  const roleId = discord.officerRoleId();
  const rec = noteSeen(discordId);
  if (!roleId) {           // роль офицера не настроена — через Discord редактором не стать
    rec.officer = false;
    rec.checkedAt = Date.now();
    return rec;
  }
  const roles = await discord.memberRoles(discordId);
  // null — Discord не ответил. Прежний ответ НЕ трогаем: чужой сбой не должен
  // ни отбирать права у работающего офицера, ни выдавать их тому, у кого их нет.
  if (roles) {
    rec.officer = roles.includes(roleId);
    rec.checkedAt = Date.now();
  }
  return rec;
};

// Фоновое обновление. Именно оно и есть ответ на «снял роль — через минуту пропала»:
// переспрашиваем только про тех, кто заходил за последний час, и только между их
// действиями. Само действие офицера никогда ничего не ждёт.
const officerTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of officerRoles) {
    if (now - rec.seenAt > OFFICER_ACTIVE_MS) { officerRoles.delete(id); continue; }
    // ТОЛЬКО про тех, кто СЕЙЧАС считается офицером. Запись здесь заводится на
    // каждого вошедшего (её создаёт проверка прав), и обновляй мы всех подряд —
    // полсотни игроков онлайн дали бы полсотни запросов в минуту, то есть ровно
    // ту нагрузку, ради отсутствия которой всё и построено.
    // Отобрать права надо быстро, а выдать — не срочно: новую роль подхватит
    // ближайшая загрузка страницы (GET /api/session).
    if (!rec.officer) continue;
    if (now - rec.checkedAt >= OFFICER_TTL_MS) officerRefresh(id).catch(() => {});
  }
}, OFFICER_TTL_MS);
officerTimer.unref?.();

const readStateSafe = () => {
  try {
    return JSON.parse(fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '{"players":[],"sessions":[]}');
  } catch { return { players: [], sessions: [] }; }
};

/** Кто прислал запрос. null — вход выключен или печеньки нет. Без сети и без диска. */
const sessionOf = (req) => {
  if (!discord.authConfig().loginEnabled) return null;
  const data = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], SESSION_KEY);
  if (!data?.did) return null;
  return { discordId: String(data.did), name: String(data.name || ''), playerId: discord.playerIdFor(data.did) };
};

/**
 * Привязка действительна, только пока карточка игрока на месте. Удалили игрока из
 * состава — доступ пропадает в ту же секунду, хотя сама запись цела и оживёт при
 * откате. Это и есть мгновенный рычаг: отвязать или удалить, и человек — никто.
 */
const livePlayerId = (session, state) => {
  if (!session?.playerId) return '';
  return (state.players || []).some(p => p.id === session.playerId) ? session.playerId : '';
};

/** Офицер ли по Discord. Чтение из памяти: ни сети, ни файла, ни ожидания. */
const sessionOfficer = (req) => {
  const s = sessionOf(req);
  if (!s) return false;
  noteSeen(s.discordId);
  return !!officerRoles.get(s.discordId)?.officer;
};

/** Две двери офицера: пароль (работает всегда) и роль в Discord. */
const canEdit = (req) => officerOk(req) || sessionOfficer(req);

/** Пускать ли смотреть. В Закрытом режиме — только привязанных к живой карточке. */
const canView = (req) => {
  const auth = discord.authConfig();
  if (!auth.loginEnabled || auth.accessMode !== 'closed') return true;
  if (officerOk(req)) return true;   // пароль — запасная дверь и здесь
  const s = sessionOf(req);
  return !!s && !!livePlayerId(s, readStateSafe());
};

const cookieOpts = (req) => ({ secure: isSecureRequest(req) });

/** Куда Google вернёт офицера после согласия. Собираем из запроса, как у Discord. */
const ytCallbackUrl = (req) => {
  const back = callbackUrl(req);   // …/api/auth/discord/callback
  return back ? back.replace(/\/api\/auth\/discord\/callback$/, '/api/yt/callback') : '';
};

// ---- Заливка записей ГВГ на YouTube ----
// Ключи только в переменных окружения службы, рядом с EDIT_PASSWORD: в код и в
// отдаваемую браузеру сборку они не попадают ни при каких условиях.
const youtube = createYouTube(process.env, DATA_DIR);

// ---- Оформление обложки ----
// Название гильдии, цвета и фон живут в ДАННЫХ, а не в сборке. Раньше название
// гильдии стояло прямо в коде, а фон вшивался из assets/ — то есть на обложках
// другой гильдии оказалось бы чужое имя, и подставить свою картинку она могла
// бы только пересобрав сайт.
const THUMB_FILE = path.join(DATA_DIR, 'ytthumb.json');
const THUMB_BG_FILE = path.join(DATA_DIR, 'ytthumb_bg');
const THUMB_DEFAULTS = {
  guildName: '',
  goldTop: '#FFEFB0',
  goldBottom: '#E0A028',
  vsColor: '#F07178'
};

const readThumb = () => {
  try {
    return { ...THUMB_DEFAULTS, ...JSON.parse(fs.readFileSync(THUMB_FILE, 'utf8')) };
  } catch { return { ...THUMB_DEFAULTS }; }
};

const writeThumb = (cfg) => {
  const tmp = THUMB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  fs.renameSync(tmp, THUMB_FILE);   // атомарно
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const thumbPatch = (body) => {
  const cur = readThumb();
  const next = { ...cur };
  if (typeof body?.guildName === 'string') next.guildName = body.guildName.trim().slice(0, 40);
  for (const key of ['goldTop', 'goldBottom', 'vsColor']) {
    if (typeof body?.[key] === 'string' && HEX.test(body[key])) next[key] = body[key];
  }
  writeThumb(next);
  return next;
};

/**
 * Игровой ник того, кто прислал запрос, — из печеньки, через привязку.
 * Именно ЗДЕСЬ держится правило «заливаешь только за себя»: чужой ник в запрос
 * положить некуда, потому что сервер его оттуда и не читает.
 * '' — человек не вошёл или не привязан, заливать ему нечего.
 */
const uploaderNick = (req) => {
  const s = sessionOf(req);
  if (!s) return '';
  const state = readStateSafe();
  const p = (state.players || []).find(x => x.id === s.playerId);
  return p ? String(p.name || '').trim() : '';
};

// Страховка на весь сервер: любая необработанная ошибка в маршруте превращается
// в 500, а не роняет процесс. Без неё одного недоступного Discord/Телеграма хватало,
// чтобы вместе с ботом лёг и сайт.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('[http] необработанная ошибка:', req.method, req.url, e?.message || e);
    try { if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.end(); } catch {}
  });
});

const handleRequest = async (req, res) => {
  let pathname, query;
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    query = u.searchParams;
  }
  catch { return send(res, 400, 'bad request'); }

  // ---- API ----
  if (pathname === '/api/state' && req.method === 'GET') {
    if (!canView(req)) return json(res, 403, { error: 'closed' });
    try {
      const data = fs.existsSync(STATE_FILE)
        ? fs.readFileSync(STATE_FILE, 'utf8')
        : '{"players":[],"sessions":[]}';
      return send(res, 200, data, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    } catch { return json(res, 500, { error: 'read' }); }
  }

  // Архив расстановок для автозаполнения. Отдельно от состояния: нужен только в
  // момент нажатия кнопки, а весит заметно — в рассылку по SSE его тащить незачем.
  if (pathname === '/api/lineups' && req.method === 'GET') {
    if (!canView(req)) return json(res, 403, { error: 'closed' });
    try {
      const data = fs.existsSync(LINEUPS_FILE) ? fs.readFileSync(LINEUPS_FILE, 'utf8') : '[]';
      return send(res, 200, data, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    } catch { return json(res, 500, { error: 'read' }); }
  }

  if (pathname === '/api/auth' && req.method === 'POST') {
    const ip = clientIp(req);
    const blocked = authBlockedMs(ip);
    if (blocked > 0) {
      // 429 с Retry-After: клиент видит, сколько ждать, и не гадает
      return send(res, 429, JSON.stringify({ error: 'too_many', retryAfterSec: Math.ceil(blocked / 1000) }), {
        'content-type': 'application/json',
        'retry-after': String(Math.ceil(blocked / 1000))
      });
    }
    let pw = '';
    try { pw = JSON.parse((await readBody(req)) || '{}').password || ''; } catch {}
    if (pw && samePassword(pw)) { authFails.delete(ip); return json(res, 200, { ok: true }); }
    if (pw) noteAuthFail(ip);  // пустой пароль попыткой перебора не считаем
    return json(res, 401, { ok: false });
  }

  // Сменить пароль редактора. Нужен текущий пароль (Bearer). После смены рассылаем
  // 'authrevoked' — все клиенты перепроверяют свой пароль, у кого старый — выбьет.
  if (pathname === '/api/auth/change' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const next = typeof body?.newPassword === 'string' ? body.newPassword.trim() : '';
    if (next.length < 4) return json(res, 422, { error: 'weak' }); // слишком короткий
    try {
      PASSWORD = next;
      savePassword(next);
      broadcast('authrevoked', {}); // всем: перепроверьте доступ
      return json(res, 200, { ok: true });
    } catch { return json(res, 500, { error: 'write' }); }
  }

  // ---- Вход через Discord ----

  // Кто я и что мне можно. Единственное место, где сайт вообще ходит в Discord ради
  // прав, — и происходит это, пока грузится страница. Ни одно действие этого не ждёт.
  if (pathname === '/api/session' && req.method === 'GET') {
    const auth = discord.authConfig();
    const base = {
      loginEnabled: auth.loginEnabled,
      accessMode: auth.accessMode,
      // Ссылка прямо в канал регистрации: человеку, вошедшему ЧЕРЕЗ Discord, он
      // уже открыт, так что это один клик, а не «сходи куда-нибудь поищи».
      registerUrl: auth.guildId && auth.registerChannelId
        ? `https://discord.com/channels/${auth.guildId}/${auth.registerChannelId}` : ''
    };
    if (!auth.loginEnabled) return json(res, 200, { ...base, user: null });
    const s = sessionOf(req);
    if (!s) return json(res, 200, { ...base, user: null });
    noteSeen(s.discordId);
    const rec = officerRoles.get(s.discordId);
    if (!rec || Date.now() - rec.checkedAt >= OFFICER_TTL_MS) await officerRefresh(s.discordId);
    const state = readStateSafe();
    const playerId = livePlayerId(s, state);
    const player = (state.players || []).find(p => p.id === playerId);
    return json(res, 200, {
      ...base,
      user: {
        discordId: s.discordId,
        name: s.name,
        playerId,
        playerName: player ? player.name : '',
        linked: !!player,
        officer: !!officerRoles.get(s.discordId)?.officer
      }
    });
  }

  if (pathname === '/api/auth/discord/login' && req.method === 'GET') {
    const auth = discord.authConfig();
    if (!auth.loginEnabled) return send(res, 503, 'Вход через Discord не настроен');
    const back = callbackUrl(req);
    if (!back) return send(res, 400, 'Не удалось определить адрес сайта');
    // consent=1 — второй заход, с обычным экраном согласия (см. callback ниже)
    const consent = query.get('consent') === '1';
    // Защита от подделки возврата: одноразовое значение уходит и в адрес, и в
    // печеньку. Не совпало на возврате — значит код принесли не оттуда, куда мы
    // отправляли, и менять его на личность нельзя.
    const nonce = signSession(
      { n: crypto.randomBytes(9).toString('base64url'), c: consent },
      SESSION_KEY, { maxAgeMs: STATE_MAX_AGE_MS }
    );
    const url = discord.loginUrl(back, nonce, { consent });
    if (!url) return send(res, 503, 'Вход через Discord не настроен');
    res.setHeader('set-cookie', serializeCookie(STATE_COOKIE, nonce, {
      maxAgeMs: STATE_MAX_AGE_MS, ...cookieOpts(req)
    }));
    return send(res, 302, '', { location: url });
  }

  if (pathname === '/api/auth/discord/callback' && req.method === 'GET') {
    const opts = cookieOpts(req);
    const drop = clearCookie(STATE_COOKIE, opts);
    const home = (suffix = '') => send(res, 302, '', { location: '/' + suffix, 'set-cookie': drop });

    const cookieNonce = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
    const given = query.get('state') || '';
    const nonceData = verifySession(cookieNonce, SESSION_KEY);
    if (!nonceData || given !== cookieNonce) return home('?login=state');

    if (query.get('error')) {
      // Первый заход шёл с prompt=none — Discord мог отказать просто потому, что
      // человек ещё не разрешал приложение. Документация про этот случай молчит,
      // поэтому не гадаем: повторяем один раз с обычным экраном согласия.
      if (!nonceData.c) return send(res, 302, '', { location: '/api/auth/discord/login?consent=1', 'set-cookie': drop });
      return home('?login=denied');
    }

    const code = query.get('code') || '';
    const who = code ? await discord.exchangeCode(code, callbackUrl(req)) : null;
    if (!who) return home('?login=error');

    const token = signSession({ did: who.id, name: who.name }, SESSION_KEY, { maxAgeMs: SESSION_MAX_AGE_MS });
    // Роль спросим сразу: человек мог войти именно чтобы что-то поправить, и первое
    // же его действие не должно упереться в «ещё не знаем, офицер ли ты».
    await officerRefresh(who.id).catch(() => {});
    return send(res, 302, '', {
      location: '/',
      'set-cookie': [drop, serializeCookie(SESSION_COOKIE, token, { maxAgeMs: SESSION_MAX_AGE_MS, ...opts })]
    });
  }

  // ---- Заливка записей ГВГ ----
  // Видео сюда НЕ приходит: сервер выдаёт браузеру узкий токен и ведёт плейлисты.

  if (pathname === '/api/yt/status' && req.method === 'GET') {
    const nick = uploaderNick(req);
    const base = {
      configured: youtube.configured(), nick, dailyLimit: 100,
      thumb: { ...readThumb(), hasBg: fs.existsSync(THUMB_BG_FILE) }
    };
    if (!base.configured || !nick) return json(res, 200, { ...base, ready: false });

    // Дешёвая проверка связи при открытии страницы. Смысл её в том, чтобы
    // человек узнал о поломке ДО того, как выбрал три файла по четыре гигабайта,
    // а не на последнем шаге — это была главная претензия к десктопу.
    const ch = await youtube.channel();
    if (!ch.ok) return json(res, 200, { ...base, ready: false, problem: ch.kind });
    const used = await youtube.uploadsToday(ch.data.uploadsPlaylist);
    const pl = await youtube.findPlaylist(nick);
    // Какие права реально получит браузер. Показываем, потому что сузить их у
    // Google не вышло (он отвечает invalid_scope), и это стоит видеть, а не
    // предполагать: полный набор даёт вкладке час власти над каналом.
    const tok = await youtube.browserToken();
    return json(res, 200, {
      ...base,
      ready: true,
      channel: ch.data.title,
      tokenScope: tok.ok ? (tok.scope || '') : '',
      uploadsToday: used.ok ? used.data : null,
      playlist: pl.ok && pl.data
        ? { id: pl.data.id, privacy: pl.data.status?.privacyStatus || 'unlisted' }
        : null
    });
  }

  if (pathname === '/api/yt/token' && req.method === 'POST') {
    if (!uploaderNick(req)) return json(res, 403, { error: 'forbidden' });
    const t = await youtube.browserToken();
    if (!t.ok) return json(res, 502, { error: t.kind });
    // scope отдаём наружу нарочно: панель показывает, какие права Google выдал
    // на самом деле, чтобы это было видно, а не предполагалось.
    return json(res, 200, { accessToken: t.token, scope: t.scope, expiresAt: t.until });
  }

  // Видео залито браузером — сервер кладёт его в плейлист владельца.
  if (pathname === '/api/yt/attach' && req.method === 'POST') {
    const nick = uploaderNick(req);
    if (!nick) return json(res, 403, { error: 'forbidden' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const videoId = String(body?.videoId || '').trim();
    const privacy = body?.privacy === 'public' ? 'public' : 'unlisted';
    if (!videoId) return json(res, 400, { error: 'fields' });
    const pl = await youtube.ensurePlaylist(nick, privacy);
    if (!pl.ok) return json(res, 502, { error: pl.kind });
    const add = await youtube.addToPlaylist(pl.data.id, videoId);
    if (!add.ok) return json(res, 502, { error: add.kind });
    youtube.galleryStale();   // свежая запись должна появиться в галерее сразу
    return json(res, 200, { ok: true, playlistId: pl.data.id, created: !!pl.created });
  }

  // Видимость плейлиста ВМЕСТЕ с записями внутри: раздельно нельзя, иначе
  // «по ссылке» в открытом плейлисте начинает находиться поиском.
  if (pathname === '/api/yt/privacy' && req.method === 'POST') {
    const nick = uploaderNick(req);
    if (!nick) return json(res, 403, { error: 'forbidden' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const privacy = body?.privacy === 'public' ? 'public' : 'unlisted';
    const r = await youtube.setPrivacy(nick, privacy);
    if (!r.ok) return json(res, 502, { error: r.kind || 'api' });
    youtube.galleryStale();
    return json(res, 200, r.data);
  }

  // Галерея записей канала. Отдаём только своим (тем же правилом, что и заливку):
  // «по ссылке» на YouTube значит «кто знает адрес», а список всех адресов сразу —
  // это уже не «по ссылке».
  //
  // Ответ общий для всех, поэтому кэш в модуле один на гильдию: восемьдесят
  // человек, открывших вкладку, стоят одного обращения к Google, а не восьмидесяти.
  if (pathname === '/api/yt/gallery' && req.method === 'GET') {
    const nick = uploaderNick(req);
    if (!nick) return json(res, 403, { error: 'forbidden' });
    if (!youtube.configured()) return json(res, 200, { configured: false, videos: [], playlists: [] });
    const force = query.get('force') === '1' && canEdit(req);
    const r = await youtube.gallery({ force });
    if (!r.ok) return json(res, 502, { error: r.kind || 'api' });
    return json(res, 200, { configured: true, me: nick, ...r.data, cached: r.cached });
  }

  // Оформление обложки. Читать может любой (картинка всё равно уезжает в
  // публичную обложку на YouTube), менять — только офицер.
  // ---- Подключение канала YouTube из панели ----
  // Чтобы офицер чужой гильдии настраивал свой канал сам: без терминала, без
  // доступа к серверу и без пересылки секретов кому-то ещё.

  if (pathname === '/api/yt/setup' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { ...youtube.setup(), redirectUri: ytCallbackUrl(req) });
  }

  if (pathname === '/api/yt/keys' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    return json(res, 200, youtube.setKeys(body?.clientId, body?.clientSecret));
  }

  if (pathname === '/api/yt/disconnect' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, youtube.disconnect());
  }

  // Шаг согласия. Их ДВА подряд: полный доступ для сервера (плейлисты) и узкий
  // для браузера. Одним не обойтись — сузить права у готового ключа Google не
  // даёт, отвечает invalid_scope. Кнопка при этом одна: второй шаг запускается
  // из возврата сам, человеку остаётся дважды нажать «Разрешить».
  if (pathname === '/api/yt/connect' && req.method === 'GET') {
    if (!canEdit(req)) return send(res, 401, 'Нужны права офицера');
    const step = query.get('step') === 'upload' ? 'upload' : 'full';
    const back = ytCallbackUrl(req);
    if (!back) return send(res, 400, 'Не удалось определить адрес сайта');
    const nonce = signSession({ n: crypto.randomBytes(9).toString('base64url'), step },
      SESSION_KEY, { maxAgeMs: STATE_MAX_AGE_MS });
    const url = youtube.authUrl(back, step === 'upload' ? BROWSER_SCOPE : FULL_SCOPE, nonce);
    if (!url) return send(res, 503, 'Сначала впишите client_id и client_secret приложения');
    res.setHeader('set-cookie', serializeCookie(STATE_COOKIE, nonce, {
      maxAgeMs: STATE_MAX_AGE_MS, ...cookieOpts(req)
    }));
    return send(res, 302, '', { location: `${url}&state=${encodeURIComponent(nonce)}` });
  }

  if (pathname === '/api/yt/callback' && req.method === 'GET') {
    const opts = cookieOpts(req);
    const drop = clearCookie(STATE_COOKIE, opts);
    const back = (suffix) => send(res, 302, '', { location: '/#integrations' + suffix, 'set-cookie': drop });

    const cookieNonce = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
    const given = query.get('state') || '';
    const nonceData = verifySession(cookieNonce, SESSION_KEY);
    if (!nonceData || given !== cookieNonce) return back('?yt=state');
    if (query.get('error')) return back('?yt=denied');

    const r = await youtube.saveCode(query.get('code') || '', ytCallbackUrl(req), nonceData.step);
    if (!r.ok) return back('?yt=error');
    // Первый шаг прошёл — сразу отправляем на второй, чтобы кнопка была одна.
    if (nonceData.step !== 'upload') {
      return send(res, 302, '', { location: '/api/yt/connect?step=upload', 'set-cookie': drop });
    }
    return back('?yt=ok');
  }

  if (pathname === '/api/yt/thumb' && req.method === 'PUT') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    return json(res, 200, thumbPatch(body));
  }

  if (pathname === '/api/yt/thumb/bg' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(THUMB_BG_FILE);
      return send(res, 200, data, { 'content-type': 'image/webp', 'cache-control': 'no-cache' });
    } catch { return json(res, 404, { error: 'none' }); }
  }

  // Картинка приходит из браузера офицера как data:image/…;base64 — тем же путём,
  // что иконки школ для Discord: на сервере папки assets/ нет вовсе.
  if (pathname === '/api/yt/thumb/bg' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const m = String(body?.image || '').match(/^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return json(res, 400, { error: 'image' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 4_000_000) return json(res, 413, { error: 'too_big' });
    try {
      const tmp = THUMB_BG_FILE + '.tmp';
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, THUMB_BG_FILE);
      return json(res, 200, { ok: true, bytes: bytes.length });
    } catch { return json(res, 500, { error: 'write' }); }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    return send(res, 200, JSON.stringify({ ok: true }), {
      'content-type': 'application/json',
      'set-cookie': clearCookie(SESSION_COOKIE, cookieOpts(req))
    });
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'json' }); }
    if (!parsed || !Array.isArray(parsed.players) || !Array.isArray(parsed.sessions)) {
      return json(res, 400, { error: 'shape' });
    }
    try {
      // старое состояние — чтобы бот понял, какие события новые/удалённые
      let oldState = null;
      try { oldState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
      const tmp = STATE_FILE + '.tmp';
      const toSave = {
        players: parsed.players,
        sessions: parsed.sessions,
        activeSessionId: parsed.activeSessionId ?? null,
        mapTemplates: Array.isArray(parsed.mapTemplates) ? parsed.mapTemplates : []
      };
      fs.writeFileSync(tmp, JSON.stringify(toSave));
      fs.renameSync(tmp, STATE_FILE); // атомарная замена
      broadcast('state', toSave); // мгновенно разослать всем живым клиентам

      // Запомнить расстановки, чтобы они пережили удаление событий. Делается и при
      // тихом сохранении: операция только добавляет, терять тут нечего, а импорт
      // старого бэкапа наоборот вернёт историю, которой не было.
      // Клиент прислать архив не может — он собирается здесь из sessions.
      try {
        let prev = [];
        try { prev = JSON.parse(fs.readFileSync(LINEUPS_FILE, 'utf8')); } catch {}
        const next = archiveSessions(parsed.sessions, Array.isArray(prev) ? prev : []);
        const ltmp = LINEUPS_FILE + '.tmp';
        fs.writeFileSync(ltmp, JSON.stringify(next));
        fs.renameSync(ltmp, LINEUPS_FILE);
      } catch (e) { console.error('[archive] не записался:', e?.message); }

      // Тихое сохранение (импорт/откат из бэкапа): Телеграм не трогаем вовсе. Иначе бот
      // принял бы вернувшиеся из файла события за новые и заспамил топик анонсами
      // прошедших матчей, а при откате — удалил бы сообщения живых событий.
      if (parsed.silent !== true) {
        telegram.syncEvents(oldState, toSave).catch(() => {}); // анонсы/счётчики в Телеге (не блокируем ответ)
        discord.syncEvents(oldState, toSave).catch(() => {});  // то же самое в Дискорде
      }
      return json(res, 200, { ok: true });
    } catch { return json(res, 500, { error: 'write' }); }
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const clientId = query.get('clientId') || '';
    if (!clientId) return json(res, 400, { error: 'clientId' });
    if (!canView(req)) return json(res, 403, { error: 'closed' });
    const isEditor = canEdit(req);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(':ok\n\n');

    // Кто это — знает печенька, спрашивать «это я» не нужно и незачем.
    //
    // Без этого вошедший через Discord показывался остальным «Гусём»: имя в
    // присутствии ставил только ручной claim, а в режиме входа его никто не
    // нажимает — кнопки «это я» там просто нет. Себя человек при этом видел
    // правильно (фронт знает свой ник из сессии), и со стороны это выглядело
    // как «у меня всё хорошо, а у него гусь».
    const who = sessionOf(req);
    if (who) getIdentity(clientId).playerId = livePlayerId(who, readStateSafe()) || null;

    const connId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Уборка одна на все причины и выполняется РОВНО ОДИН РАЗ: закрытие, ошибка сокета
    // и мёртвый пинг приходят вперемешку, а `broadcastPresence` на каждую рассылала бы
    // одно и то же всем подключённым.
    let closed = false;
    // `ping` объявлен ДО `drop`, хотя присваивается после: без этого `drop`, вызванный
    // из обработчика ошибки раньше установки таймера, упал бы на временной мёртвой зоне.
    let ping;
    const drop = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      connections.delete(connId);
      broadcastPresence();
    };

    // Пинг не только держит соединение живым, но и СЛУЖИТ ПРОВЕРКОЙ. Раньше он писал
    // внутрь `try { } catch {}`, и это была дыра: у оборванного клиента (закрыли крышку,
    // пропала сеть, убили браузер) сокет остаётся полуоткрытым, `close` не приходит
    // никогда, ошибка глоталась — и человек висел в списке «кто на сайте» до перезапуска
    // процесса. Гуси накапливались десятками.
    ping = setInterval(() => {
      if (res.destroyed || res.socket?.destroyed || !res.writable) { drop(); return; }
      try { res.write(': ping\n\n'); } catch { drop(); }
    }, 25000);

    // Ошибку сокета Node сообщает событием, а не исключением из write, — без этой
    // подписки обрыв так и остался бы незамеченным.
    res.on('error', drop);
    req.on('error', drop);
    req.on('close', drop);

    // Живой TCP keep-alive: просим ОС саму проверять, жив ли тот конец. Без него
    // полуоткрытый сокет держится до системного таймаута, а это десятки минут.
    try { req.socket.setKeepAlive(true, 30000); } catch {}

    connections.set(connId, { res, clientId, isEditor, ping });
    broadcastPresence();
    return;
  }

  // «Это я» живёт только в режиме без входа. Когда вход включён, личность берётся
  // из печеньки при подключении, и второй способ её задать означал бы, что любой
  // может назваться кем угодно в списке «на сайте».
  if (pathname === '/api/presence/claim' && req.method === 'POST') {
    if (discord.authConfig().loginEnabled) return json(res, 403, { error: 'login-required' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const { clientId, playerId } = body || {};
    if (!clientId || !playerId) return json(res, 400, { error: 'fields' });

    for (const [otherId, identity] of identities) {
      if (otherId !== clientId && identity.playerId === playerId) {
        const onlineElsewhere = [...connections.values()].some(c => c.clientId === otherId);
        if (onlineElsewhere) return json(res, 409, { error: 'taken' });
      }
    }
    getIdentity(clientId).playerId = playerId;
    broadcastPresence();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/presence/unclaim' && req.method === 'POST') {
    if (discord.authConfig().loginEnabled) return json(res, 403, { error: 'login-required' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const { clientId } = body || {};
    if (!clientId) return json(res, 400, { error: 'fields' });
    if (identities.has(clientId)) identities.get(clientId).playerId = null;
    broadcastPresence();
    return json(res, 200, { ok: true });
  }

  // Заявка игрока на событие. Писать можно только СВОЮ заявку (clientId закреплён за playerId
  // через «это я»), либо офицер с верным паролем (Bearer) — он может ставить любому.
  if (pathname === '/api/signup' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const { clientId, sessionId, playerId, status } = body || {};
    if (!sessionId || !playerId) return json(res, 400, { error: 'fields' });
    const okStatus = status === null || status === undefined || ['in', 'maybe', 'out', 'sub'].includes(status);
    if (!okStatus) return json(res, 400, { error: 'status' });
    const isOfficer = canEdit(req);
    const auth = discord.authConfig();
    let state;
    try {
      state = JSON.parse(fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '{"players":[],"sessions":[]}');
    } catch { return json(res, 500, { error: 'read' }); }
    // Право писать заявку. При включённом входе его даёт ТОЛЬКО подписанная печенька:
    // «это я» (claim) больше не годится — она не требует ничего, и именно поэтому
    // человека мог отписать с прака кто угодно, безымянно. При выключенном флаге
    // всё как было, иначе выкат остановил бы гильдию посреди недели.
    const session = auth.loginEnabled ? sessionOf(req) : null;
    const ownsSession = !!session && livePlayerId(session, state) === playerId;
    const ownsClaim = !auth.loginEnabled && !!clientId && identities.get(clientId)?.playerId === playerId;
    if (!isOfficer && !ownsSession && !ownsClaim) return json(res, 403, { error: 'forbidden' });
    const sess = (state.sessions || []).find(s => s.id === sessionId);
    if (!sess) return json(res, 404, { error: 'session' });
    // регистрация закрывается спустя настроенный срок после старта (см. /api/lifecycle);
    // офицер может править и после — через штаб войны
    const startsAt = sess.event?.startsAt;
    if (!isOfficer && startsAt && Date.now() > new Date(startsAt).getTime() + lifecycle.closeMsFor(sess.event?.type)) {
      return json(res, 409, { error: 'closed' });
    }
    sess.signups = sess.signups || {};
    if (status === null || status === undefined) {
      delete sess.signups[playerId];
      if (sess.signupMeta) delete sess.signupMeta[playerId];
    } else {
      const prevStatus = sess.signups[playerId];
      sess.signups[playerId] = status;
      // Источник и время заявки (порядковые номера, значок «откуда записался»).
      // Время обновляем только при смене статуса — повторный клик той же кнопки
      // не должен двигать человека в конец очереди его группы.
      sess.signupMeta = sess.signupMeta || {};
      if (!sess.signupMeta[playerId] || prevStatus !== status) {
        sess.signupMeta[playerId] = { from: 'site', at: new Date().toISOString() };
      }
    }
    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
      broadcast('state', state); // мгновенно всем
      telegram.refreshEvent(sessionId).catch(() => {}); // обновить счётчики в Телеге
      discord.refreshEvent(sessionId).catch(() => {});  // и в Дискорде
      return json(res, 200, { ok: true });
    } catch { return json(res, 500, { error: 'write' }); }
  }

  // Пометка «недоступен» (отпуск, болезнь, жизненные обстоятельства). Права те же,
  // что у заявки: себе — сам, любому — офицер. Отдельная точка нужна потому, что
  // PUT /api/state требует офицерских прав, а помечать себя должен уметь и игрок.
  //
  // Пересчёт заявок и составов делает та же чистая функция, что и на фронте
  // (away.mjs), иначе офицер и игрок получали бы разный результат.
  if (pathname === '/api/unavailable' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const { clientId, playerId, unavailable } = body || {};
    if (!playerId) return json(res, 400, { error: 'fields' });
    // Дата возвращения — только стенной день. Время сюда не пускаем: оно тут же
    // потребовало бы пояса, а «вернётся 24-го» пояса не требует.
    if (unavailable && unavailable.until && !/^\d{4}-\d{2}-\d{2}$/.test(String(unavailable.until))) {
      return json(res, 400, { error: 'until' });
    }
    const isOfficer = canEdit(req);
    const auth = discord.authConfig();
    let state;
    try {
      state = JSON.parse(fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '{"players":[],"sessions":[]}');
    } catch { return json(res, 500, { error: 'read' }); }
    const session = auth.loginEnabled ? sessionOf(req) : null;
    const ownsSession = !!session && livePlayerId(session, state) === playerId;
    const ownsClaim = !auth.loginEnabled && !!clientId && identities.get(clientId)?.playerId === playerId;
    if (!isOfficer && !ownsSession && !ownsClaim) return json(res, 403, { error: 'forbidden' });
    if (!(state.players || []).some(p => p.id === playerId)) return json(res, 404, { error: 'player' });

    const mark = unavailable
      ? { note: String(unavailable.note || '').slice(0, 200), until: unavailable.until || '' }
      : null;
    const next = applyAway(state, playerId, mark);
    state.players = next.players;
    state.sessions = next.sessions;

    try {
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_FILE);
      broadcast('state', state);
      // Анонсы затронутых событий пересобрать: заявка изменилась, а значит и счётчики
      // в них. Правки склеиваются коалесцером, поэтому отпуск на десять событий
      // не превращается в десять всплесков запросов подряд.
      for (const id of next.changed) {
        telegram.refreshEvent(id).catch(() => {});
        discord.refreshEvent(id).catch(() => {});
      }
      return json(res, 200, { ok: true, changed: next.changed.length });
    } catch { return json(res, 500, { error: 'write' }); }
  }

  // ---- Жизненный цикл событий: сроки закрытия регистрации по типу ----
  // GET публичный: зрителям тоже нужно знать, когда событие считается закрытым.
  if (pathname === '/api/lifecycle' && req.method === 'GET') {
    return json(res, 200, lifecycle.get());
  }
  if (pathname === '/api/lifecycle' && req.method === 'PUT') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    if (!lifecycle.set(body)) return json(res, 400, { error: 'shape' });
    telegram.rescheduleAll();                    // таймеры авто-закрытия пересчитать под новые сроки
    discord.rescheduleAll();
    broadcast('lifecycle', lifecycle.get());     // клиентам — чтобы «Завершено» на карточках совпадало
    return json(res, 200, lifecycle.get());
  }

  // ---- Офицерская админка привязок Телеграма (нужен Bearer) ----
  if (pathname === '/api/tglinks' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { links: telegram.listLinks() });
  }
  if (pathname === '/api/tglinks/unbind' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const telegramId = body?.telegramId;
    if (!telegramId) return json(res, 400, { error: 'fields' });
    telegram.unbind(String(telegramId));
    return json(res, 200, { ok: true });
  }

  // ---- Настройка бота из UI (токен + статус беседы/темы). Нужен Bearer ----
  if (pathname === '/api/tgconfig' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, telegram.getStatus());
  }
  if (pathname === '/api/tgconfig' && req.method === 'PUT') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    // Адрес сайта для кнопки «Открыть на сайте»: явный из тела либо из заголовка Host
    if (typeof body.siteUrl === 'string') {
      telegram.setSiteUrl(body.siteUrl);
    } else if (body.token && req.headers.host) {
      telegram.setSiteUrl(`http://${req.headers.host}`);
    }
    if (typeof body.token === 'string') {
      const r = await telegram.setToken(body.token);
      if (!r.ok) return json(res, 422, { error: r.error || 'token' });
    }
    telegram.setDmSettings(body);                       // напоминания в личку
    if (body.routes) telegram.setRoutes(body.routes);   // таблица тем
    return json(res, 200, telegram.getStatus());
  }

  // ---- Discord: приём интеракций (сюда стучится сам Discord) ----
  // Подпись проверяем на сырых байтах ДО разбора JSON; ответ должен уйти быстро
  // (лимит Discord — 3 секунды, при серии провалов эндпоинт отключают).
  if (pathname === '/api/discord/interactions' && req.method === 'POST') {
    let raw;
    try { raw = await readRawBody(req); } catch { return json(res, 400, { error: 'body' }); }
    const sig = req.headers['x-signature-ed25519'];
    const ts = req.headers['x-signature-timestamp'];
    if (!discord.verifySignature(sig, ts, raw)) {
      return json(res, 401, { error: 'invalid request signature' });
    }
    let interaction;
    try { interaction = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'json' }); }
    return json(res, 200, discord.handleInteraction(interaction));
  }

  // ---- Discord: настройка из UI (нужен Bearer) ----
  if (pathname === '/api/discord/config' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, discord.getStatus());
  }
  if (pathname === '/api/discord/config' && req.method === 'PUT') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    if (typeof body.token === 'string') {
      const r = await discord.setToken(body.token);
      if (!r.ok) return json(res, 422, { error: r.error || 'token' });
    }
    // Адрес сайта для кнопки «Открыть на сайте» — явный либо из заголовка Host
    if (typeof body.siteUrl === 'string') discord.setSiteUrl(body.siteUrl);
    else if (req.headers.host) discord.setSiteUrl(`https://${req.headers.host}`);
    discord.updateSettings(body);
    // Сменили офицерскую роль — прежние ответы про неё больше ничего не значат.
    // Перепроверяем сразу, чтобы новый офицер не ждал минуту, а прежний её не имел.
    for (const id of officerRoles.keys()) officerRefresh(id).catch(() => {});
    return json(res, 200, discord.getStatus());
  }
  // Загрузка иконок школ как эмодзи приложения. Картинки шлёт фронт: на сервере
  // папки assets/ нет (она нужна только сборке), а в браузере они уже в сборке.
  if (pathname === '/api/discord/emojis' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const r = await discord.syncEmojis(body?.images);
    if (r.ok) return json(res, 200, r);
    // Отказ Discord — это 502 (сломался вышестоящий сервис), а не 422: 422 значит
    // «данные плохие» и уводит офицера чинить свои картинки вместо ожидания.
    return json(res, r.upstream ? 502 : 422, { error: r.error || 'emoji' });
  }
  // Опубликовать в канале регистрации сообщение с кнопкой (офицер жмёт один раз)
  if (pathname === '/api/discord/register-message' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    const r = await discord.postRegisterMessage();
    if (r.ok) return json(res, 200, r);
    return json(res, r.upstream ? 502 : 422, { error: r.error || 'discord' });
  }
  // Привязки ников к аккаунтам Discord (офицерская админка)
  if (pathname === '/api/discord/links' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { links: discord.listLinks() });
  }
  if (pathname === '/api/discord/links/unbind' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    if (!body?.discordId) return json(res, 400, { error: 'fields' });
    discord.unbind(String(body.discordId));
    return json(res, 200, { ok: true });
  }
  // Перенацелить привязку на другую карточку — случай «удалил игрока и завёл заново».
  if (pathname === '/api/discord/links/rebind' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    const r = discord.rebind(String(body?.discordId || ''), String(body?.playerId || ''));
    return json(res, r.ok ? 200 : 400, r);
  }

  // Client secret приложения. Наружу не отдаётся никогда — только признак «задан».
  if (pathname === '/api/discord/secret' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'json' }); }
    return json(res, 200, discord.setClientSecret(body?.clientSecret));
  }

  // Кнопка «Обновить данные Discord». Делает две вещи разом: панель следом заново
  // тянет списки каналов и ролей (они нигде не кэшируются, просто читались лишь при
  // открытии панели), а здесь немедленно перепроверяются права всех, кто на сайте.
  // Это и есть «прямо сейчас» вместо ожидания фоновой минуты.
  if (pathname === '/api/discord/refresh' && req.method === 'POST') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    // Берём тех, кто заходил недавно: и чтобы отобрать права у снятого, и чтобы
    // выдать их только что назначенному, пока он сидит на открытой странице.
    const now = Date.now();
    const ids = [...officerRoles.entries()]
      .filter(([, rec]) => now - rec.seenAt < 10 * 60_000)
      .map(([id]) => id);
    // Пачками по пять: у Discord общий предел 50 запросов в секунду, и залпом
    // упереться в него на людной гильдии было бы обидно из-за одной кнопки.
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(id => officerRefresh(id).catch(() => {})));
    }
    return json(res, 200, { ok: true, checked: ids.length });
  }
  // Живые списки для страницы настроек (сервер/каналы/роли бота)
  if (pathname === '/api/discord/guilds' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    const list = await discord.listGuilds();
    return list === null ? json(res, 502, { error: 'discord' }) : json(res, 200, { guilds: list });
  }
  if (pathname === '/api/discord/channels' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    const list = await discord.listChannels();
    return list === null ? json(res, 502, { error: 'discord' }) : json(res, 200, { channels: list });
  }
  if (pathname === '/api/discord/roles' && req.method === 'GET') {
    if (!canEdit(req)) return json(res, 401, { error: 'unauthorized' });
    const list = await discord.listRoles();
    return list === null ? json(res, 502, { error: 'discord' }) : json(res, 200, { roles: list });
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  // ---- Статика (прод). В dev фронт раздаёт Vite, сюда идут только /api ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rel = pathname === '/' ? '/index.html' : pathname;
    let filePath = path.normalize(path.join(STATIC_DIR, rel));
    if (!filePath.startsWith(STATIC_DIR)) return send(res, 403, 'forbidden');
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(STATIC_DIR, 'index.html'); // SPA-фолбэк
    }
    if (!fs.existsSync(filePath)) return send(res, 404, 'Not found (нет собранной статики в ' + STATIC_DIR + ')');
    const ext = path.extname(filePath).toLowerCase();
    // Кэширование: файлы в /assets/ захешированы Vite (имя меняется при изменении
    // содержимого), поэтому их можно кэшировать «навсегда». index.html и прочее —
    // только с ревалидацией, чтобы новый деплой подхватывался сразу.
    const served = path.relative(STATIC_DIR, filePath).replace(/\\/g, '/');
    const cacheControl = served.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    return send(res, 200, fs.readFileSync(filePath), {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cacheControl
    });
  }

  send(res, 405, 'method not allowed');
};

// HOST=127.0.0.1 прячет бэкенд за Caddy: снаружи порт 3001 не виден, и всё ходит
// только через HTTPS. Без HOST слушаем все адреса, как раньше.
const HOST = process.env.HOST || undefined;
server.listen(PORT, HOST, () => console.log(`WWM backend на порту ${PORT}`));
