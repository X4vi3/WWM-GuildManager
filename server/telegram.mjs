// Телеграм-бот для WWM Guild Manager (без зависимостей, Node >= 18).
//   1) Анонсирует события (праки/ранкед/лига) в выбранную беседу/тему.
//   2) Привязывает аккаунт Телеграма к нику из состава (1:1, поиск по подстроке).
//   3) Принимает регистрацию тапом по кнопкам под анонсом.
//
// Конфиг бота (токен + цель) хранится в data/tgconfig.json и настраивается ИЗ UI:
//   - токен вводит офицер в админке (/api/tgconfig);
//   - темы бот запоминает командами прямо в них: /setprac, /setranked, /setleague
//     (Bot API не умеет перечислять темы форума, узнать их иначе невозможно);
//   - /sithere задаёт тему по умолчанию, /where показывает раскладку;
//   - если беседа без тем — бот берёт её целью сам, как только его добавят.
// Для совместимости со старым сервером: если файла нет, конфиг засевается из
// переменных окружения (TELEGRAM_BOT_TOKEN / _CHAT_ID / _THREAD_ID / _SITE_URL).
//
// Взаимодействие — long-polling (getUpdates): HTTPS/домен на нашем сайте не нужен.
// На один токен «слушает» только один процесс.

import fs from 'node:fs';
import path from 'node:path';
import { createCoalescer } from './coalesce.mjs';
import { fingerprint, worthResync, RESYNC_GAP_MS, RESYNC_DELAY_MS } from './msgsync.mjs';

const RU_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const TYPE_LABELS = { prak: 'Прак', ranked: 'Ранкед', league: 'Лига' };
const TYPE_EMOJI = { prak: '⚔️', ranked: '🏅', league: '🏆' };
const STATUS_LABELS = { in: 'Иду', maybe: 'Под вопросом', sub: 'Замена', out: 'Не идут' };
const STATUSES = ['in', 'maybe', 'out', 'sub'];
const PAGE_SIZE = 8;

// Адрес Bot API. Подменяется только в тестах (TG_API_BASE), чтобы можно было
// прогонять бота против поддельного сервера и видеть, что он реально отправляет.
const API_BASE = process.env.TG_API_BASE || 'https://api.telegram.org';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// День недели события в ЕГО поясе (в нём офицер вводил время). Тот же расчёт,
// что и в Дискорде: поздний прак по МСК должен попасть в субботнюю клетку,
// а не в пятничную по UTC.
const weekdayOf = (startsAt, tz) => {
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Europe/Moscow', weekday: 'short'
    }).format(new Date(startsAt));
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? null;
  } catch { return null; }
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripSlash = (u) => (u || '').replace(/\/+$/, '');

const fmtDate = (d) => {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${RU_WEEKDAYS[dt.getDay()]}, ${m[3]}.${m[2]}`;
};

// Момент → строка по Москве: «пт, 30.06, 21:30 МСК»
const fmtMsk = (startsAt) => {
  try {
    const s = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(startsAt));
    return s.replace(',', '') + ' МСК';
  } catch { return ''; }
};

export function createTelegram(opts) {
  const dataDir = opts.dataDir;
  const broadcastState = opts.broadcastState || (() => {});
  // Сроки закрытия регистрации — из общего конфига (server/lifecycle.mjs), не константой
  const lifecycle = opts.lifecycle;

  const isClosed = (sess, entry) =>
    !!(entry && entry.closed) ||
    (!!sess.event?.startsAt &&
      Date.now() >= new Date(sess.event.startsAt).getTime() + lifecycle.closeMsFor(sess.event?.type));

  const STATE_FILE = path.join(dataDir, 'state.json');
  const LINKS_FILE = path.join(dataDir, 'links.json');       // { [telegramId]: playerId }
  const MSGS_FILE = path.join(dataDir, 'tg_messages.json');   // { [sessionId]: { chatId, messageId, closed? } }
  const CONFIG_FILE = path.join(dataDir, 'tgconfig.json');    // { token, chatId, threadId, threadName, chatTitle, siteUrl }

  // ---- Хранилища (атомарная запись) ----
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (file, obj) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  };
  const readState = () => readJson(STATE_FILE, { players: [], sessions: [] });
  const writeState = (state) => writeJson(STATE_FILE, state);
  let links = readJson(LINKS_FILE, {});
  // Раньше на событие приходилось ОДНО сообщение: { chatId, messageId, closed? }.
  // С темами их может быть несколько, поэтому храним массив. Старую форму
  // заворачиваем при чтении — иначе потеряли бы связь с уже опубликованными анонсами.
  let msgs = (() => {
    const raw = readJson(MSGS_FILE, {});
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      out[id] = Array.isArray(v) ? v : [v];
    }
    return out;
  })();
  const saveLinks = () => writeJson(LINKS_FILE, links);
  const saveMsgs = () => writeJson(MSGS_FILE, msgs);
  const closeTimers = new Map();
  const deleteTimers = new Map();
  const remindTimers = new Map();

  const SUBS_FILE = path.join(dataDir, 'tg_subs.json');  // { [telegramId]: true }
  const DMS_FILE = path.join(dataDir, 'tg_dms.json');    // { [sessionId]: { sent: [], reminded } }
  let subs = readJson(SUBS_FILE, {});
  let dms = readJson(DMS_FILE, {});
  const saveSubs = () => writeJson(SUBS_FILE, subs);
  const saveDms = () => writeJson(DMS_FILE, dms);

  // ---- Конфиг (файл → иначе засев токена из env при самом первом запуске).
  // id беседы/темы из env больше не читаем: цель анонсов задаётся только через
  // /sithere и живёт в файле — при переезде беседы ничего перенастраивать в env не надо.
  let cfg = readJson(CONFIG_FILE, null);
  if (!cfg) {
    cfg = {
      token: opts.envToken || '',
      chatId: '',
      threadId: '',
      threadName: '',
      chatTitle: '',
      siteUrl: opts.envSiteUrl || ''
    };
    if (cfg.token) writeJson(CONFIG_FILE, cfg); // сохраняем засев из env
  }
  // Личка: у старых конфигов этих полей нет — доставляем умолчания
  if (cfg.dmEnabled === undefined) cfg.dmEnabled = true;
  if (cfg.remindBeforeMin === undefined) cfg.remindBeforeMin = 180;
  // Известные темы (куда бота звали через /sithere) и таблица маршрутов
  // «день недели × тип события» → темы. Пустой маршрут = публиковать в цель
  // по умолчанию (cfg.chatId/threadId), чтобы старая настройка продолжала работать.
  if (!Array.isArray(cfg.targets)) cfg.targets = [];
  if (!cfg.routes || typeof cfg.routes !== 'object') cfg.routes = {};
  // Старый конфиг знал одну цель — заносим её в список известных тем
  // Старый конфиг знал одну цель — заносим её в список известных тем. Названия у
  // неё может не быть (беседа задавалась через env, а не командой), и выдумывать
  // его нельзя: «беседа» читается как несуществующая тема. Пишем честно «тема #id»,
  // настоящее имя бот узнает, когда в этой теме напишут команду.
  if (cfg.chatId && !cfg.targets.some(x => String(x.threadId || '') === String(cfg.threadId || ''))) {
    const tid = cfg.threadId ? String(cfg.threadId) : '';
    cfg.targets.push({
      chatId: String(cfg.chatId),
      threadId: tid,
      name: cfg.threadName || (tid ? `тема #${tid}` : (cfg.chatTitle || 'беседа'))
    });
  }
  const saveConfig = () => writeJson(CONFIG_FILE, cfg);

  let botUsername = '';
  let running = false;  // активен ли цикл поллинга
  let pollGen = 0;      // поколение — чтобы старый цикл вышел при смене токена
  let offset = 0;

  // ---- Вызовы Telegram Bot API (текущий токен) ----
  // При 429 (слишком много запросов) Телеграм присылает retry_after — ждём и повторяем,
  // максимум 3 попытки, чтобы не зависнуть навсегда.
  const tg = async (method, params = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${API_BASE}/bot${cfg.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params)
      });
      const data = await r.json();
      if (data?.error_code === 429 && attempt < 3) {
        const waitSec = Math.min(Number(data.parameters?.retry_after) || 1, 60);
        await sleep(waitSec * 1000);
        continue;
      }
      return data;
    }
  };

  // ---- Текст и кнопки анонса ----
  const countStatuses = (sess, players) => {
    const byId = new Set((players || []).map(p => p.id));
    const c = { in: 0, maybe: 0, out: 0, sub: 0 };
    for (const [pid, v] of Object.entries(sess.signups || {})) {
      if (c[v] !== undefined && byId.has(pid)) c[v]++;
    }
    return c;
  };

  const STATUS_META = [
    ['in', '✅', 'Иду'],
    ['maybe', '❓', 'Под вопросом'],
    ['sub', '🔄', 'Замена'],
    ['out', '❌', 'Не идут']
  ];
  const DIVIDER = '➖➖➖➖➖➖➖➖➖➖';

  const tgIdByPlayer = () => {
    const m = {};
    for (const [tid, pid] of Object.entries(links)) m[pid] = tid;
    return m;
  };

  const votersByStatus = (sess, players) => {
    const rev = tgIdByPlayer();
    const byId = {};
    for (const p of (players || [])) byId[p.id] = p;
    const groups = { in: [], maybe: [], sub: [], out: [] };
    for (const [pid, status] of Object.entries(sess.signups || {})) {
      if (!groups[status] || !byId[pid]) continue;
      const name = byId[pid].name;
      const tid = rev[pid];
      groups[status].push(tid ? `<a href="tg://user?id=${tid}">${esc(name)}</a>` : esc(name));
    }
    return groups;
  };

  const announceText = (sess, players, closed = false) => {
    const ev = sess.event || {};
    const title = ev.type === 'prak' && ev.opponent
      ? `vs ${esc(ev.opponent)}`
      : esc(sess.name || TYPE_LABELS[ev.type] || 'Событие');
    const c = countStatuses(sess, players);
    const v = votersByStatus(sess, players);
    const when = ev.startsAt ? fmtMsk(ev.startsAt) : [fmtDate(ev.date), ev.time].filter(Boolean).join(' ');

    const header = `${TYPE_EMOJI[ev.type] || '📣'} <b>${esc(TYPE_LABELS[ev.type] || '')} — ${title}</b>`;
    const meta = [when ? `🗓 ${esc(when)}` : '', ev.note ? `📝 ${esc(ev.note)}` : ''].filter(Boolean).join('\n');
    const statuses = STATUS_META.map(([key, emoji, label]) => {
      let s = `${emoji} <b>${label}</b> — ${c[key]}`;
      if (v[key].length) s += `\n${v[key].join(', ')}`;
      return s;
    }).join('\n\n');

    const sections = [header, meta, DIVIDER, statuses];
    if (closed) sections.push(DIVIDER, '🔒 Регистрация закрыта.');
    return sections.filter(Boolean).join('\n\n');
  };

  const announceKeyboard = (sess, closed = false) => {
    const rows = [];
    if (!closed) {
      rows.push([
        { text: '✅ Иду', callback_data: `sg:${sess.id}:in` },
        { text: '❓ Вопрос', callback_data: `sg:${sess.id}:maybe` }
      ]);
      rows.push([
        { text: '🔄 Замена', callback_data: `sg:${sess.id}:sub` },
        { text: '❌ Нет', callback_data: `sg:${sess.id}:out` }
      ]);
    }
    const site = stripSlash(cfg.siteUrl);
    if (site) rows.push([{ text: '🌐 Открыть на сайте', url: site }]);
    return { inline_keyboard: rows };
  };

  // Куда публиковать событие: клетка таблицы «день недели × тип». Если маршрут
  // не задан — цель по умолчанию, как было до появления таблицы.
  const targetsFor = (sess) => {
    const ev = sess.event;
    if (!ev) return [];
    const day = ev.startsAt ? weekdayOf(ev.startsAt, ev.tz) : null;
    const ids = (day === null) ? [] : (cfg.routes[`${day}:${ev.type}`]?.threadIds || []);
    if (ids.length) {
      const out = [];
      for (const tid of ids) {
        const target = cfg.targets.find(x => String(x.threadId || '') === String(tid));
        if (target) out.push(target);
      }
      if (out.length) return out;
    }
    // Маршрут не настроен или темы уже нет — публикуем как раньше
    return cfg.chatId
      ? [{ chatId: String(cfg.chatId), threadId: cfg.threadId ? String(cfg.threadId) : '', name: cfg.threadName || '' }]
      : [];
  };

  const announce = async (sess, players) => {
    const targets = targetsFor(sess);
    if (!targets.length) return;
    const posted = [];
    for (const target of targets) {
      const params = {
        chat_id: target.chatId,
        text: announceText(sess, players),
        parse_mode: 'HTML',
        reply_markup: announceKeyboard(sess)
      };
      if (target.threadId) params.message_thread_id = Number(target.threadId);
      const res = await tg('sendMessage', params);
      if (res.ok) {
        posted.push({
          chatId: target.chatId,
          messageId: res.result.message_id,
          fp: fingerprint([params.text, params.reply_markup])
        });
      } else console.error('[tg] anons fail:', res.description);
    }
    if (posted.length) {
      msgs[sess.id] = posted;
      saveMsgs();
      scheduleClose(sess.id);
      scheduleDelete(sess.id);
      scheduleReminder(sess.id);
      dmAnnounce(sess).catch(() => {}); // личка подписавшимся — не блокирует анонс
    }
  };

  // Перерисовать анонс. Состояние читаем СВЕЖЕЕ в момент запуска (не принимаем аргументом):
  // вызовы идут через склейку правок, и к моменту фактической правки данные могли уйти вперёд.
  const renderEvent = async (sessionId) => {
    const entries = msgs[sessionId];
    if (!entries || !entries.length) return;
    const st = readState();
    const sess = st.sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const closed = isClosed(sess, entries[0]);
    const text = announceText(sess, st.players, closed);
    const markup = announceKeyboard(sess, closed);
    // Отпечаток отправленного: если в теме уже висит ровно это, в сеть не идём вовсе.
    // Заодно исчезает частая ошибка «message is not modified» — мы её больше не вызываем.
    const fp = fingerprint([text, markup]);
    let changed = false;
    for (const entry of entries) {
      if (closed && !entry.closed) { entry.closed = true; changed = true; }
      if (entry.fp === fp) continue;
      const res = await tg('editMessageText', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: markup
      });
      if (res.ok) { entry.fp = fp; changed = true; continue; }
      if (!/not modified/i.test(res.description || '')) {
        console.error('[tg] render fail:', res.description);
      }
    }
    if (changed) saveMsgs();
  };

  // Подтянуть вид уже висящих анонсов под текущий код. Запускается при старте
  // (деплой мог принести новую вёрстку) и при смене адреса сайта — от него зависит
  // кнопка «Открыть на сайте». Прошедшее давно не трогаем.
  const resyncPass = async () => {
    const st = readState();
    const byId = new Map((st.sessions || []).map(s => [s.id, s]));
    const now = Date.now();
    for (const id of Object.keys(msgs)) {
      const sess = byId.get(id);
      if (!sess || !worthResync(sess.event?.startsAt, now)) continue;
      await renderEvent(id);
      await sleep(RESYNC_GAP_MS);
    }
  };
  // Второй вызов не отбрасываем, а присоединяем к идущему проходу (см. discord.mjs)
  let resyncing = null;
  let resyncAgain = false;
  const resyncAll = () => {
    if (!cfg.token) return Promise.resolve();
    if (resyncing) { resyncAgain = true; return resyncing; }
    resyncing = (async () => {
      do {
        resyncAgain = false;
        await resyncPass();
      } while (resyncAgain);
    })().finally(() => { resyncing = null; });
    return resyncing;
  };
  const scheduleResync = () => {
    setTimeout(() => { resyncAll().catch(() => {}); }, RESYNC_DELAY_MS).unref?.();
  };

  // Склейка правок: сколько бы кликов подряд ни пришло по событию, сообщение
  // редактируется не чаще раза в ~1.2 с. Кнопки отвечают мгновенно (answerCallbackQuery),
  // а перерисовка анонса догоняет следом.
  const renderQueue = createCoalescer((sessionId) => renderEvent(sessionId), 1200);

  // ---- Точный таймер авто-закрытия ----
  const clearCloseTimer = (sessionId) => {
    const tmr = closeTimers.get(sessionId);
    if (tmr) { clearTimeout(tmr); closeTimers.delete(sessionId); }
  };
  const scheduleClose = (sessionId) => {
    clearCloseTimer(sessionId);
    const entries = msgs[sessionId];
    if (!entries || !entries.length || entries[0].closed) return;
    const sess = readState().sessions.find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const delay = new Date(startsAt).getTime() + lifecycle.closeMsFor(sess?.event?.type) - Date.now();
    if (delay <= 0) { renderQueue.schedule(sessionId); return; }
    if (delay > 2147483647) return;
    closeTimers.set(sessionId, setTimeout(() => {
      closeTimers.delete(sessionId);
      renderQueue.schedule(sessionId);
    }, delay));
  };
  // ---- Таймер удаления анонса ----
  // Тот же общий конфиг сроков, что и у Дискорда: закрытие оставляет карточку
  // в беседе, удаление убирает её совсем. По умолчанию не удаляем.
  const clearDeleteTimer = (sessionId) => {
    const tmr = deleteTimers.get(sessionId);
    if (tmr) { clearTimeout(tmr); deleteTimers.delete(sessionId); }
  };
  const deleteAnnounce = async (sessionId) => {
    const entries = msgs[sessionId];
    if (!entries) return;
    for (const e of entries) {
      await tg('deleteMessage', { chat_id: e.chatId, message_id: e.messageId }).catch(() => {});
    }
    clearCloseTimer(sessionId);
    clearDeleteTimer(sessionId);
    renderQueue.cancel(sessionId);
    delete msgs[sessionId];
    saveMsgs();
  };
  const scheduleDelete = (sessionId) => {
    clearDeleteTimer(sessionId);
    const entries = msgs[sessionId];
    if (!entries || !entries.length) return;
    const sess = readState().sessions.find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const after = lifecycle.deleteMsFor(sess?.event?.type);
    if (after === null) return; // «не удалять»
    const delay = new Date(startsAt).getTime() + after - Date.now();
    if (delay > 2147483647) return;
    if (delay <= 0) { deleteAnnounce(sessionId).catch(() => {}); return; }
    deleteTimers.set(sessionId, setTimeout(() => {
      deleteTimers.delete(sessionId);
      deleteAnnounce(sessionId).catch(() => {});
    }, delay));
  };

  const rescheduleAll = () => {
    for (const id of Object.keys(msgs)) { scheduleClose(id); scheduleDelete(id); scheduleReminder(id); }
  };

  // ---- Привязка ника ----
  const boundPlayerIds = () => new Set(Object.values(links));
  const playerById = (state, id) => state.players.find(p => p.id === id);

  const searchPlayers = (state, q) => {
    const ql = q.trim().toLowerCase();
    const taken = boundPlayerIds();
    return state.players.filter(p => !taken.has(p.id) && p.name.toLowerCase().includes(ql));
  };

  const pickKeyboard = (players, page = null) => {
    const rows = players.map(p => [{ text: p.name.slice(0, 60), callback_data: `bind:${p.id}` }]);
    if (page !== null) {
      const nav = [];
      if (page > 0) nav.push({ text: '◀', callback_data: `all:${page - 1}` });
      nav.push({ text: '✖', callback_data: 'cancel' });
      nav.push({ text: '▶', callback_data: `all:${page + 1}` });
      rows.push(nav);
    }
    return { inline_keyboard: rows };
  };

  const sendBindHelp = async (toChatId) => {
    await tg('sendMessage', {
      chat_id: toChatId,
      parse_mode: 'HTML',
      text: 'Напиши пару букв своего ника из состава (можно латиницей) — я покажу кнопки на выбор.\n\nИли нажми, чтобы листать весь список:',
      reply_markup: { inline_keyboard: [[{ text: '📜 Показать всех', callback_data: 'all:0' }]] }
    });
  };

  // ---- Личка: подписка на события ----
  // Как и в Дискорде — только по своей воле. Карточка со СВОИМ статусом, без
  // общих счётчиков: копия с живыми счётчиками означала бы правку личного
  // сообщения каждому на каждый чужой клик, и мы упёрлись бы в лимиты.
  // Отличие от Дискорда: в Телеграме писать в личку можно всем, кто хоть раз
  // открыл бота, — а привязка как раз через личку и происходит.
  const subMenu = (subscribed) => ({
    inline_keyboard: [[subscribed
      ? { text: '🔕 Выключить напоминания', callback_data: 'sub:off' }
      : { text: '🔔 Включить напоминания', callback_data: 'sub:on' }]]
  });

  const dmText = (sess, myStatus) => {
    const ev = sess.event || {};
    const title = ev.type === 'prak' && ev.opponent
      ? `vs ${esc(ev.opponent)}`
      : esc(sess.name || TYPE_LABELS[ev.type] || 'Событие');
    const when = ev.startsAt ? fmtMsk(ev.startsAt) : [fmtDate(ev.date), ev.time].filter(Boolean).join(' ');
    const mine = myStatus ? STATUS_LABELS[myStatus] : '— не ответил —';
    return [
      `${TYPE_EMOJI[ev.type] || '📣'} <b>${esc(TYPE_LABELS[ev.type] || '')} — ${title}</b>`,
      when ? `🗓 ${esc(when)}` : '',
      DIVIDER,
      `Твой ответ: <b>${esc(mine)}</b>`
    ].filter(Boolean).join('\n');
  };

  const dmKeyboard = (sess) => ({
    inline_keyboard: [
      [
        { text: '✅ Иду', callback_data: `sg:${sess.id}:in` },
        { text: '❓ Вопрос', callback_data: `sg:${sess.id}:maybe` }
      ],
      [
        { text: '🔄 Замена', callback_data: `sg:${sess.id}:sub` },
        { text: '❌ Нет', callback_data: `sg:${sess.id}:out` }
      ]
    ]
  });

  // Кому слать: подписавшиеся и привязанные. onlySilent — только не ответившим.
  const dmTargets = (sess, onlySilent) => {
    const out = [];
    for (const [tgId, playerId] of Object.entries(links)) {
      if (!subs[tgId]) continue;
      if (onlySilent && (sess.signups || {})[playerId]) continue;
      out.push({ tgId, playerId });
    }
    return out;
  };

  const dmAnnounce = async (sess) => {
    if (!cfg.dmEnabled) return;
    const record = dms[sess.id] || { sent: [], reminded: false };
    for (const { tgId, playerId } of dmTargets(sess, false)) {
      if (record.sent.includes(tgId)) continue;
      const r = await tg('sendMessage', {
        chat_id: tgId,
        text: dmText(sess, (sess.signups || {})[playerId]),
        parse_mode: 'HTML',
        reply_markup: dmKeyboard(sess)
      }).catch(() => ({ ok: false }));
      if (r.ok) record.sent.push(tgId);
      await sleep(120); // у лички лимиты жёстче, чем у беседы
    }
    dms[sess.id] = record;
    saveDms();
  };

  const dmRemind = async (sessionId) => {
    if (!cfg.dmEnabled || !cfg.remindBeforeMin) return;
    const sess = readState().sessions.find(s => s.id === sessionId);
    if (!sess) return;
    const record = dms[sessionId] || { sent: [], reminded: false };
    if (record.reminded) return;
    for (const { tgId, playerId } of dmTargets(sess, true)) {
      await tg('sendMessage', {
        chat_id: tgId,
        text: dmText(sess, (sess.signups || {})[playerId]),
        parse_mode: 'HTML',
        reply_markup: dmKeyboard(sess)
      }).catch(() => {});
      await sleep(120);
    }
    record.reminded = true;
    dms[sessionId] = record;
    saveDms();
  };

  const clearRemindTimer = (sessionId) => {
    const tmr = remindTimers.get(sessionId);
    if (tmr) { clearTimeout(tmr); remindTimers.delete(sessionId); }
  };
  const scheduleReminder = (sessionId) => {
    clearRemindTimer(sessionId);
    if (!cfg.dmEnabled || !cfg.remindBeforeMin) return;
    if (dms[sessionId]?.reminded) return;
    const sess = readState().sessions.find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const delay = new Date(startsAt).getTime() - cfg.remindBeforeMin * 60_000 - Date.now();
    if (delay <= 0) return;          // момент напоминания уже прошёл — задним числом не спамим
    if (delay > 2147483647) return;
    remindTimers.set(sessionId, setTimeout(() => {
      remindTimers.delete(sessionId);
      dmRemind(sessionId).catch(() => {});
    }, delay));
  };

  // Bot API НЕ умеет перечислять темы форума — ни одного метода. Поэтому тему
  // бот может узнать только из сообщения, написанного в ней. Отсюда и команды:
  // их пишут прямо в нужной теме, а бот запоминает и id, и название.
  //
  // Название берём в таком порядке: явный аргумент команды → служебное поле
  // Телеграма (есть не всегда) → честное «тема #id». Заглушку «беседа» для темы
  // не подставляем: выглядит как несуществующая тема, которой в форуме нет.
  const topicName = (msg, chat, explicit) => {
    const tid = msg.message_thread_id;
    if (explicit) return explicit.slice(0, 60);
    const fromService = msg.reply_to_message?.forum_topic_created?.name;
    if (fromService) return fromService;
    return tid ? `тема #${tid}` : (chat.title || 'беседа');
  };

  // Добавить/обновить тему в списке известных. Первая становится целью по
  // умолчанию — туда уходит всё, для чего маршрут не задан.
  const upsertTarget = (chat, threadId, name) => {
    const tid = threadId ? String(threadId) : '';
    const existing = cfg.targets.find(x => String(x.threadId || '') === tid);
    if (existing) { existing.chatId = String(chat.id); existing.name = name; }
    else cfg.targets.push({ chatId: String(chat.id), threadId: tid, name });
    if (!cfg.chatId) {
      cfg.chatId = String(chat.id);
      cfg.chatTitle = chat.title || '';
      cfg.threadId = tid;
      cfg.threadName = tid ? name : '';
    }
    return tid;
  };

  // Команды на тип события: /setprac, /setranked, /setleague (+ /unset…)
  const SET_CMDS = { '/setprac': 'prak', '/setranked': 'ranked', '/setleague': 'league' };
  const UNSET_CMDS = { '/unsetprac': 'prak', '/unsetranked': 'ranked', '/unsetleague': 'league' };

  // Куда сейчас уходит тип: собираем по дням. Если во все дни одно и то же —
  // говорим «все дни», иначе перечисляем по дням.
  const whereType = (type) => {
    const per = [];
    for (let d = 0; d < 7; d++) {
      const ids = cfg.routes[`${d}:${type}`]?.threadIds || [];
      per.push(ids.map(String).sort().join(','));
    }
    const uniq = [...new Set(per)];
    const nameOf = (key) => key
      ? key.split(',').map(id => cfg.targets.find(x => String(x.threadId || '') === id)?.name || `тема #${id}`).join(', ')
      : null;
    if (uniq.length === 1) {
      const n = nameOf(uniq[0]);
      return n ? `все дни → ${n}` : 'маршрут не задан (в тему по умолчанию)';
    }
    const RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    return per.map((key, d) => `${RU[d]} → ${nameOf(key) || 'по умолчанию'}`).join('; ');
  };

  // ---- Обработка апдейтов ----
  const handleMessage = async (msg) => {
    if (!msg) return;
    const chat = msg.chat || {};
    const text = (msg.text || '').trim();
    const cmd = text.split(/[\s@]/)[0].toLowerCase();

    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    // Ответ всегда в ту же тему, откуда пришла команда
    const replyHere = (t) => {
      const params = { chat_id: chat.id, text: t, parse_mode: 'HTML' };
      if (msg.message_thread_id) params.message_thread_id = msg.message_thread_id;
      return tg('sendMessage', params).catch(() => {});
    };
    const arg = text.slice(cmd.length).trim();

    // /setprac | /setranked | /setleague — публиковать этот тип в ЭТУ тему (все дни).
    // Пишем в те же routes["день:тип"], что и таблица на сайте, поэтому команда и
    // таблица не расходятся: заполнил командой — видно в таблице, и наоборот.
    if (isGroup && SET_CMDS[cmd]) {
      const type = SET_CMDS[cmd];
      const name = topicName(msg, chat, arg);
      const tid = upsertTarget(chat, msg.message_thread_id, name);
      for (let d = 0; d < 7; d++) cfg.routes[`${d}:${type}`] = { threadIds: [tid] };
      saveConfig();
      rescheduleAll();
      await replyHere(
        `✅ <b>${TYPE_LABELS[type]}</b> теперь публикуются здесь — «${esc(name)}».\n` +
        'Если нужна разбивка по дням недели — она на сайте, вкладка «Интеграции».'
      );
      return;
    }

    if (isGroup && UNSET_CMDS[cmd]) {
      const type = UNSET_CMDS[cmd];
      let had = false;
      for (let d = 0; d < 7; d++) {
        if (cfg.routes[`${d}:${type}`]) { delete cfg.routes[`${d}:${type}`]; had = true; }
      }
      if (had) saveConfig();
      await replyHere(had
        ? `🗑 <b>${TYPE_LABELS[type]}</b> больше не привязаны к теме — уйдут в тему по умолчанию.`
        : `Для <b>${TYPE_LABELS[type]}</b> маршрут и не был задан.`);
      return;
    }

    // /where — показать текущую раскладку
    if (isGroup && (cmd === '/where' || cmd === '/routes')) {
      const lines = ['prak', 'ranked', 'league'].map(t => `${TYPE_EMOJI[t]} <b>${TYPE_LABELS[t]}</b>: ${esc(whereType(t))}`);
      const def = cfg.threadName || cfg.chatTitle || (cfg.threadId ? `тема #${cfg.threadId}` : 'беседа');
      await replyHere(
        lines.join('\n') + `\n\n📌 Тема по умолчанию: <b>${esc(def)}</b>\n\n` +
        'Команды: /setprac, /setranked, /setleague — привязать тип к этой теме ' +
        '(можно с названием: <code>/setprac Праки</code>). /unsetprac и т.п. — снять. ' +
        '/sithere — сделать эту тему темой по умолчанию.'
      );
      return;
    }

    // /sithere — только тема по умолчанию (куда уходит всё без маршрута)
    if (isGroup && cmd === '/sithere') {
      const name = topicName(msg, chat, arg);
      const tid = upsertTarget(chat, msg.message_thread_id, name);
      cfg.chatId = String(chat.id);
      cfg.chatTitle = chat.title || '';
      cfg.threadId = tid;
      cfg.threadName = tid ? name : '';
      saveConfig();
      await replyHere(
        `📌 Тема по умолчанию: <b>${esc(name)}</b>. Сюда пойдёт всё, для чего не задан маршрут.\n` +
        'Чтобы развести по типам: /setprac, /setranked, /setleague в нужных темах.'
      );
      return;
    }
    // Забыть тему целиком: убрать из списка и из всех маршрутов
    if (isGroup && cmd === '/forgethere') {
      const tid = msg.message_thread_id ? String(msg.message_thread_id) : '';
      const before = cfg.targets.length;
      cfg.targets = cfg.targets.filter(x => String(x.threadId || '') !== tid);
      // Подчищаем маршруты, чтобы не ссылались на исчезнувшую тему
      for (const [key, cell] of Object.entries(cfg.routes)) {
        const left = (cell.threadIds || []).filter(x => String(x) !== tid);
        if (left.length) cfg.routes[key] = { threadIds: left };
        else delete cfg.routes[key];
      }
      if (String(cfg.threadId || '') === tid) {
        const next = cfg.targets[0];
        cfg.chatId = next ? next.chatId : '';
        cfg.threadId = next ? next.threadId : '';
        cfg.threadName = next ? next.name : '';
      }
      saveConfig();
      const params = {
        chat_id: chat.id,
        text: before === cfg.targets.length ? 'Эта тема и не была в списке.' : '🗑 Забыл эту тему.'
      };
      if (msg.message_thread_id) params.message_thread_id = msg.message_thread_id;
      await tg('sendMessage', params).catch(() => {});
      return;
    }

    // Остальное (привязка ника) — только в личке
    if (chat.type !== 'private') return;
    const fromChat = chat.id;

    if (cmd === '/start' || cmd === '/help') {
      const myId = String(msg.from.id);
      const boundTo = links[myId];
      if (boundTo) {
        const p = playerById(readState(), boundTo);
        const on = !!subs[myId];
        await tg('sendMessage', {
          chat_id: fromChat,
          parse_mode: 'HTML',
          text: `Ты привязан как <b>${esc(p ? p.name : '???')}</b>.\n` +
                'Жми кнопки под анонсами, чтобы записываться. /unlink — отвязаться.\n\n' +
                (on
                  ? '🔔 Напоминания о событиях в личку <b>включены</b>.'
                  : '🔕 Напоминания в личку выключены. Включи — и я буду присылать карточку события сюда, отвечать можно прямо из неё.'),
          reply_markup: subMenu(on)
        });
      } else {
        await sendBindHelp(fromChat);
      }
      return;
    }
    // Подписка отдельной командой — чтобы её можно было найти, не листая /start
    if (cmd === '/notify' || cmd === '/subscribe') {
      const myId = String(msg.from.id);
      if (!links[myId]) { await sendBindHelp(fromChat); return; }
      const on = !!subs[myId];
      await tg('sendMessage', {
        chat_id: fromChat,
        parse_mode: 'HTML',
        text: on ? '🔔 Напоминания <b>включены</b>.' : '🔕 Напоминания выключены.',
        reply_markup: subMenu(on)
      });
      return;
    }
    if (cmd === '/unlink') {
      const myId = String(msg.from.id);
      if (links[myId]) { delete links[myId]; saveLinks(); }
      if (subs[myId]) { delete subs[myId]; saveSubs(); } // отписываем заодно
      await tg('sendMessage', { chat_id: fromChat, text: 'Отвязал. Теперь ник свободен. /start — привязаться заново.' });
      return;
    }
    if (text.startsWith('/')) { await sendBindHelp(fromChat); return; }

    const state = readState();
    const found = searchPlayers(state, text);
    if (found.length === 0) {
      await tg('sendMessage', { chat_id: fromChat, text: 'Никого не нашёл по такому запросу (или ник уже привязан). Попробуй иначе или открой полный список:', reply_markup: { inline_keyboard: [[{ text: '📜 Показать всех', callback_data: 'all:0' }]] } });
      return;
    }
    if (found.length > PAGE_SIZE) {
      await tg('sendMessage', { chat_id: fromChat, text: `Нашёл много (${found.length}). Уточни запрос или листай полный список:`, reply_markup: { inline_keyboard: [[{ text: '📜 Показать всех', callback_data: 'all:0' }]] } });
      return;
    }
    await tg('sendMessage', { chat_id: fromChat, text: 'Выбери свой ник:', reply_markup: pickKeyboard(found) });
  };

  // Бота добавили в группу: беседу без тем берём целью сразу; форум — просим /sithere
  const handleMyChatMember = async (upd) => {
    const chat = upd.chat || {};
    const status = upd.new_chat_member?.status;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    if (status !== 'member' && status !== 'administrator') return;
    if (cfg.chatId) return; // цель уже задана
    if (chat.is_forum) {
      await tg('sendMessage', {
        chat_id: chat.id,
        text: 'Привет! Напишите в нужной теме одну из команд:\n' +
              '/setprac — праки сюда\n/setranked — ранкед сюда\n/setleague — лигу сюда\n\n' +
              '/where — показать текущую раскладку.'
      }).catch(() => {});
    } else {
      upsertTarget(chat, null, chat.title || 'беседа');
      saveConfig();
      await tg('sendMessage', { chat_id: chat.id, text: 'Привет! Буду публиковать сюда анонсы событий.' }).catch(() => {});
    }
  };

  const handleCallback = async (cq) => {
    const data = cq.data || '';
    const fromId = String(cq.from.id);
    const ack = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert });

    if (data === 'cancel') {
      await ack('Отменено');
      if (cq.message) await tg('deleteMessage', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
      return;
    }
    // Подписка на напоминания в личку
    if (data === 'sub:on' || data === 'sub:off') {
      if (!links[fromId]) { await ack('Сначала привяжи ник: /start', true); return; }
      const on = data === 'sub:on';
      if (on) subs[fromId] = true; else delete subs[fromId];
      saveSubs();
      await ack(on ? 'Буду напоминать в личку' : 'Больше не напоминаю');
      if (cq.message) {
        await tg('editMessageText', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          parse_mode: 'HTML',
          text: on
            ? '🔔 Напоминания о событиях в личку <b>включены</b>.\nБуду присылать карточку события сюда — отвечать можно прямо из неё.'
            : '🔕 Напоминания в личку выключены.',
          reply_markup: subMenu(on)
        }).catch(() => {});
      }
      return;
    }
    if (data.startsWith('all:')) {
      const page = Math.max(0, Number(data.slice(4)) || 0);
      const state = readState();
      const taken = boundPlayerIds();
      const free = state.players.filter(p => !taken.has(p.id));
      const slice = free.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      await ack();
      if (slice.length === 0) { await ack('Дальше пусто'); return; }
      const kb = pickKeyboard(slice, page);
      if (cq.message) {
        await tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `Выбери свой ник (стр. ${page + 1}):`, reply_markup: kb }).catch(() => {});
      }
      return;
    }
    if (data.startsWith('bind:')) {
      const pid = data.slice(5);
      const state = readState();
      const p = playerById(state, pid);
      if (!p) { await ack('Этого ника уже нет в составе', true); return; }
      const taken = boundPlayerIds();
      if (taken.has(pid) && links[fromId] !== pid) { await ack('Этот ник уже привязан к другому Телеграму. Обратись к офицеру.', true); return; }
      links[fromId] = pid;
      saveLinks();
      await ack(`Готово! Ты привязан как ${p.name}`);
      if (cq.message) {
        await tg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `✅ Привязан как «${p.name}».\nТеперь жми кнопки под анонсами, чтобы записываться. /unlink — отвязаться.` }).catch(() => {});
      }
      return;
    }
    if (data.startsWith('sg:')) {
      const parts = data.split(':');
      const sessionId = parts[1];
      const status = parts[2];
      if (!STATUSES.includes(status)) { await ack('Неизвестный статус'); return; }
      const pid = links[fromId];
      if (!pid) {
        await ack(`Ты ещё не привязал ник. Открой @${botUsername || 'бота'} → Старт → выбери себя, потом сможешь записываться.`, true);
        return;
      }
      const state = readState();
      const sess = state.sessions.find(s => s.id === sessionId);
      if (!sess) { await ack('Событие не найдено'); return; }
      if (isClosed(sess, msgs[sessionId]?.[0])) { await ack('Регистрация на это событие уже закрыта', true); return; }
      const p = playerById(state, pid);
      if (!p) { await ack('Твой ник пропал из состава', true); return; }
      sess.signups = sess.signups || {};
      const prevStatus = sess.signups[pid];
      sess.signups[pid] = status;
      // Источник и время заявки (для порядковых номеров и значка «откуда записался»).
      // Время обновляем только при СМЕНЕ статуса: повторный тап той же кнопки не должен
      // отправлять человека в конец очереди своей группы.
      sess.signupMeta = sess.signupMeta || {};
      if (!sess.signupMeta[pid] || prevStatus !== status) {
        sess.signupMeta[pid] = { from: 'tg', at: new Date().toISOString() };
      }
      writeState(state);
      // Вторым аргументом — какое событие изменилось: index.mjs по нему обновит
      // анонс и в Дискорде (иначе заявка из Телеграма там не отобразится).
      broadcastState(state, sessionId);
      await ack(`Записал: ${STATUS_LABELS[status]}`);
      renderQueue.schedule(sessionId);

      // Нажали в личке — обновляем свою карточку, чтобы в ней сразу был новый
      // ответ. Правится одно сообщение (своё), на лимиты это не влияет.
      if (cq.message?.chat?.type === 'private') {
        await tg('editMessageText', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: dmText(sess, status),
          parse_mode: 'HTML',
          reply_markup: dmKeyboard(sess)
        }).catch(() => {});
      }
      return;
    }
    await ack();
  };

  const handleUpdate = async (u) => {
    try {
      if (u.message) await handleMessage(u.message);
      else if (u.callback_query) await handleCallback(u.callback_query);
      else if (u.my_chat_member) await handleMyChatMember(u.my_chat_member);
    } catch (e) {
      console.error('[tg] update error:', e?.message || e);
    }
  };

  // ---- Long-polling (перезапускаемый при смене токена) ----
  const startPolling = () => {
    running = true;
    const gen = ++pollGen;
    (async () => {
      while (running && gen === pollGen) {
        try {
          const res = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
          if (res.ok) {
            for (const u of res.result) { offset = u.update_id + 1; await handleUpdate(u); }
          } else {
            await sleep(3000);
          }
        } catch { await sleep(3000); }
      }
    })();
  };
  const stopPolling = () => { running = false; pollGen++; };

  // Подключиться текущим токеном: проверить getMe, запустить поллинг
  const connect = async () => {
    if (!cfg.token) return false;
    try {
      const me = await tg('getMe');
      if (!me.ok) { console.error('[tg] токен не принят Телеграмом'); return false; }
      botUsername = me.result.username || '';
      await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
      startPolling();
      rescheduleAll();
      console.log(`[tg] бот @${botUsername} запущен (long-polling)`);
      return true;
    } catch (e) {
      console.error('[tg] не удалось запустить бота:', e?.message || e);
      return false;
    }
  };

  // ---- Публичный интерфейс ----
  return {
    // Старт при запуске процесса (если токен уже задан в файле/env)
    async start() { await connect(); scheduleResync(); },

    // Сменить токен из UI. Пустой токен — отключить бота.
    async setToken(token) {
      token = (token || '').trim();
      stopPolling();
      botUsername = '';
      if (!token) { cfg.token = ''; saveConfig(); return { ok: true, connected: false }; }
      cfg.token = token;
      const me = await tg('getMe').catch(() => ({ ok: false }));
      if (!me.ok) { cfg.token = ''; saveConfig(); return { ok: false, error: me.description || 'Токен не принят' }; }
      botUsername = me.result.username || '';
      saveConfig();
      await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
      startPolling();
      rescheduleAll();
      return { ok: true, connected: true, botUsername };
    },

    setSiteUrl(url) {
      const next = stripSlash((url || '').trim());
      if (next === cfg.siteUrl) return;
      cfg.siteUrl = next;
      saveConfig();
      resyncAll().catch(() => {}); // от адреса зависит кнопка «Открыть на сайте» в висящих анонсах
    },

    // Статус для UI (токен не отдаём целиком)
    getStatus() {
      return {
        hasToken: !!cfg.token,
        connected: !!cfg.token && running,
        botUsername,
        tokenHint: cfg.token ? '…' + cfg.token.slice(-6) : '',
        chatId: cfg.chatId || '',
        chatTitle: cfg.chatTitle || '',
        threadId: cfg.threadId || '',
        threadName: cfg.threadName || '',
        siteUrl: stripSlash(cfg.siteUrl),
        dmEnabled: cfg.dmEnabled !== false,
        remindBeforeMin: cfg.remindBeforeMin ?? 180,
        subscriberCount: Object.keys(subs).length,
        targets: cfg.targets.map(x => ({ threadId: x.threadId || '', name: x.name })),
        routes: cfg.routes
      };
    },

    // Таблица маршрутов «день недели × тип события» → темы
    setRoutes(routes) {
      if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return false;
      const known = new Set(cfg.targets.map(x => String(x.threadId || '')));
      const next = {};
      for (const [key, cell] of Object.entries(routes)) {
        if (!/^[0-6]:(prak|ranked|league)$/.test(key)) continue;
        const ids = Array.isArray(cell?.threadIds)
          ? cell.threadIds.map(String).filter(x => known.has(x)).slice(0, 5)
          : [];
        if (ids.length) next[key] = { threadIds: ids };
      }
      cfg.routes = next;
      saveConfig();
      return true;
    },

    // Настройки лички со страницы интеграций
    setDmSettings(body) {
      if (!body || typeof body !== 'object') return;
      let changed = false;
      if (typeof body.dmEnabled === 'boolean') { cfg.dmEnabled = body.dmEnabled; changed = true; }
      if (body.remindBeforeMin !== undefined) {
        const n = Number(body.remindBeforeMin);
        if (Number.isFinite(n)) { cfg.remindBeforeMin = Math.min(1440, Math.max(0, Math.round(n))); changed = true; }
      }
      if (changed) { saveConfig(); rescheduleAll(); }
    },

    async syncEvents(oldState, newState) {
      if (!cfg.token || !cfg.chatId) return;
      const oldSessions = (oldState?.sessions || []);
      const newSessions = (newState?.sessions || []);
      const oldIds = new Set(oldSessions.map(s => s.id));
      const newIds = new Set(newSessions.map(s => s.id));

      for (const s of newSessions) {
        if (!s.event) continue;
        if (oldIds.has(s.id)) continue;
        if (msgs[s.id]) continue;
        await announce(s, newState.players);
      }
      for (const s of oldSessions) {
        if (!msgs[s.id]) continue;
        if (newIds.has(s.id)) continue;
        for (const entry of msgs[s.id]) {
          await tg('deleteMessage', { chat_id: entry.chatId, message_id: entry.messageId }).catch(() => {});
        }
        clearCloseTimer(s.id);
        clearDeleteTimer(s.id);
        clearRemindTimer(s.id);
        renderQueue.cancel(s.id); // ожидающая правка удалённого сообщения больше не нужна
        delete msgs[s.id];
        saveMsgs();
        if (dms[s.id]) { delete dms[s.id]; saveDms(); }
      }
      const oldById = new Map(oldSessions.map(s => [s.id, s]));
      const digest = (s) => JSON.stringify({ n: s.name, e: s.event, g: s.signups || {} });
      const namesDigest = (st) => JSON.stringify((st?.players || []).map(p => [p.id, p.name]));
      const rosterChanged = namesDigest(oldState) !== namesDigest(newState);
      for (const s of newSessions) {
        if (!msgs[s.id]) continue;
        const prev = oldById.get(s.id);
        if (!rosterChanged && prev && digest(prev) === digest(s)) continue;
        renderQueue.schedule(s.id);
        scheduleClose(s.id);
        scheduleDelete(s.id); // офицер мог сдвинуть время события
      }
    },

    async refreshEvent(sessionId) {
      if (!cfg.token || !cfg.chatId) return;
      renderQueue.schedule(sessionId);
    },

    // Пересчитать таймеры авто-закрытия (после смены сроков в /api/lifecycle)
    rescheduleAll() { rescheduleAll(); },

    listLinks() {
      const state = readState();
      return Object.entries(links).map(([telegramId, playerId]) => {
        const p = playerById(state, playerId);
        return { telegramId, playerId, playerName: p ? p.name : '(нет в составе)' };
      });
    },

    unbind(telegramId) {
      if (links[telegramId]) { delete links[telegramId]; saveLinks(); return true; }
      return false;
    }
  };
}
