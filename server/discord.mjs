// Discord-интеграция для WWM Guild Manager (без зависимостей, Node >= 18).
// Транспорт — Interactions over HTTP: Discord сам стучится к нам на
// POST /api/discord/interactions (маршрут живёт в index.mjs), никакого
// постоянного соединения не держим. Каждый запрос подписан Ed25519 —
// подпись проверяется на СЫРЫХ байтах тела до разбора JSON.
//
// Конфиг хранится в data/discordconfig.json и настраивается целиком из UI.
// Никаких id серверов/каналов в коде или env: офицер вводит ТОЛЬКО токен бота,
// applicationId и публичный ключ мы забираем у Discord сами (/applications/@me),
// сервер и каналы выбираются на странице настроек из живых списков.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCoalescer } from './coalesce.mjs';
import { fingerprint, worthResync, RESYNC_GAP_MS, RESYNC_DELAY_MS } from './msgsync.mjs';
import { buildAnnounce } from './discord_embed.mjs';
import { rankRoster, alphaGroups } from './nickmatch.mjs';
import { langPack, LANGS } from './botlang.mjs';

const API = 'https://discord.com/api/v10';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// День недели события в его собственном поясе. Важно: у события есть tz (в нём
// офицер вводил время), и «пятничный прак» должен попасть в пятничную клетку
// таблицы по времени гильдии, а не по UTC на сервере.
const weekdayOf = (startsAt, tz) => {
  try {
    const name = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Europe/Moscow', weekday: 'short'
    }).format(new Date(startsAt));
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? null;
  } catch { return null; }
};

// Сырой 32-байтовый ключ Ed25519 → объект ключа Node (обёртка DER/SPKI).
// Работает на любом Node 18 без WebCrypto-экспериментов.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const publicKeyFromHex = (hex) => crypto.createPublicKey({
  key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
  format: 'der',
  type: 'spki'
});

// Типы каналов, куда имеет смысл публиковать анонсы: текстовый и новостной
const TEXT_CHANNEL_TYPES = new Set([0, 5]);

// Насколько старую подпись ещё принимаем (защита от повтора перехваченного запроса)
const SIG_MAX_SKEW_SEC = 300;

// Сколько каналов можно назначить одной клетке таблицы «день × тип события».
// Продублировано в components/DiscordSettings.tsx — менять только в паре.
const MAX_CHANNELS_PER_CELL = 5;

// Боевые роли и школы оружия — зеркало types.ts (сервер на .mjs, импортировать
// оттуда нельзя). Данные игры, меняются только вместе с самой игрой.
// emojiName — имя эмодзи приложения с той же иконкой роли, что и на сайте (заливается
// кнопкой «Загрузить иконки» на странице интеграций). Имена обязаны совпадать с
// ROLE_EMOJI_NAMES в components/DiscordSettings.tsx и с ROLE_COLUMNS в discord_embed.mjs.
const ROLES = [
  { value: 'Tank', key: 'roleTank', emoji: '🛡️', emojiName: 'role_tank' },
  { value: 'DPS', key: 'roleDps', emoji: '⚔️', emojiName: 'role_dps' },
  { value: 'Healer', key: 'roleHeal', emoji: '💚', emojiName: 'role_heal' }
];

// Значок роли для выпадающего списка анкеты. У своего эмодзи указывается id (name —
// только подпись), у стандартного — наоборот, сам символ в name и никакого id. Пока
// иконки не залиты, подставляется стандартное: анкета обязана работать и без них.
const roleEmoji = (r, emojis) =>
  emojis?.[r.emojiName] ? { id: emojis[r.emojiName], name: r.emojiName } : { name: r.emoji };

const WEAPON_SCHOOLS = [
  { value: 'bamboocut', label: 'Bamboocut - Wind' },
  { value: 'hengblade', label: 'Stonesplit - Strength' },
  { value: 'splendor', label: 'Bellstrike - Splendor' },
  { value: 'umbra', label: 'Bellstrike - Umbra' },
  { value: 'dmg_umbrella', label: 'Silkbind - Jade' },
  { value: 'new_umbrella', label: 'Bamboocut - Dust' },
  { value: 'hea', label: 'Silkbind - Deluge' },
  { value: 'might', label: 'Stonesplit - Might' }
];

export const __test = { weekdayOf };

export function createDiscord(opts) {
  const dataDir = opts.dataDir;
  const lifecycle = opts.lifecycle;
  const broadcastState = opts.broadcastState || (() => {});

  const CONFIG_FILE = path.join(dataDir, 'discordconfig.json');
  const STATE_FILE = path.join(dataDir, 'state.json');
  const LINKS_FILE = path.join(dataDir, 'discordlinks.json');   // { [discordUserId]: playerId }
  const MSGS_FILE = path.join(dataDir, 'discord_messages.json'); // { [sessionId]: [{channelId, messageId, closed?, fp?}] }

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const writeJson = (file, obj) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file); // атомарно
  };

  // ---- Конфиг ----
  // routes: таблица маршрутизации 7×3 — ключ `${деньНедели}:${типСобытия}` (день 0=вс…6=сб),
  // значение { discordChannelIds: string[] }. Пустая клетка = в Discord не публиковать.
  // Телеграм-половина клетки живёт в своём конфиге; общая логика придёт с фазой анонсов.
  const cfg = Object.assign({
    botToken: '',
    applicationId: '',   // заполняется автоматически из /applications/@me
    publicKey: '',       // тоже автоматически (verify_key приложения)
    appName: '',
    botUsername: '',
    guildId: '',         // какой сервер обслуживаем (бот может состоять в нескольких)
    pingRoleId: '',      // одна роль, которую пингуем над анонсами ('' = не пинговать)
    registerChannelId: '', // канал, где живёт кнопка регистрации
    // Где стоит опубликованное сообщение с кнопкой: { channelId, messageId, fp }.
    // Раньше id не сохранялся вовсе — поэтому сообщение нельзя было ни обновить,
    // ни найти, а повторное нажатие в панели вешало в канал второе такое же.
    registerMessage: null,
    registerRoleId: '',    // роль-гейт: без неё регистрация недоступна
    // ---- Вход на сайт через Discord ----
    clientSecret: '',      // нужен, чтобы обменять код возврата на личность
    officerRoleId: '',     // роль, дающая права редактора на сайте
    // Флаг. Выключен — сайт работает ровно как сегодня, весь код входа спит.
    // Включить нельзя без clientSecret: иначе получился бы сайт, на который никто
    // не может войти и где никто не может отметиться.
    loginEnabled: false,
    accessMode: 'open',    // open — смотрят все; closed — только привязанные
    siteUrl: '',           // адрес сайта для кнопки «Открыть на сайте»
    emojis: {},            // школа оружия -> id эмодзи приложения
    lang: 'ru',            // язык сообщений бота (ru/en) — отдельно от Телеграма
    dmEnabled: true,       // слать ли личку подписавшимся
    remindBeforeMin: 180,  // за сколько минут напоминать молчунам (0 — не напоминать)
    routes: {}
  }, readJson(CONFIG_FILE, {}));
  const saveConfig = () => writeJson(CONFIG_FILE, cfg);

  // ---- Состояние гильдии, привязки и опубликованные сообщения ----
  const readState = () => readJson(STATE_FILE, { players: [], sessions: [] });
  const writeState = (state) => writeJson(STATE_FILE, state);
  const SUBS_FILE = path.join(dataDir, 'discord_subs.json'); // { [discordUserId]: true }
  const DMS_FILE = path.join(dataDir, 'discord_dms.json');    // { [sessionId]: { sent: [userId], reminded: bool } }

  let links = readJson(LINKS_FILE, {});
  let msgs = readJson(MSGS_FILE, {});
  let subs = readJson(SUBS_FILE, {});
  let dms = readJson(DMS_FILE, {});
  const saveLinks = () => writeJson(LINKS_FILE, links);

  // Значение привязки исторически было просто id игрока строкой. Теперь рядом лежат
  // подписи — имя в Discord и последний известный ник, — чтобы офицер видел, ЧЬЯ это
  // привязка, когда карточка игрока исчезла. Старая форма читается как раньше: иначе
  // деплой оборвал бы связь со всеми, кто уже привязался.
  const pidOf = (v) => (
    typeof v === 'string' ? v
      : (v && typeof v === 'object' ? String(v.playerId || '') : '')
  );
  const linkedPid = (discordId) => pidOf(links[discordId]);
  const saveMsgs = () => writeJson(MSGS_FILE, msgs);
  const saveSubs = () => writeJson(SUBS_FILE, subs);
  const saveDms = () => writeJson(DMS_FILE, dms);
  const closeTimers = new Map();
  const remindTimers = new Map();
  const deleteTimers = new Map();

  // playerId -> discordUserId (в анонсе ники показываем через <@id>)
  const discordIdByPlayer = () => {
    const m = {};
    for (const [did, v] of Object.entries(links)) { const pid = pidOf(v); if (pid) m[pid] = did; }
    return m;
  };

  // ---- Вызовы Discord REST API (токен бота) ----
  // При 429 Discord присылает retry_after в секундах — ждём и повторяем, максимум 3 раза.
  // ВАЖНО: наружу никогда не бросаем. Discord может быть недоступен (провайдер,
  // блокировка, обрыв), и если дать исключению всплыть из обработчика запроса,
  // Node уронит весь процесс — вместе с сайтом. Сетевую ошибку возвращаем как
  // обычный неуспешный ответ со status 0.
  const dapi = async (method, apiPath, body) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(`${API}${apiPath}`, {
          method,
          headers: {
            'authorization': `Bot ${cfg.botToken}`,
            'content-type': 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000)
        });
      } catch (e) {
        console.error('[dc] сеть недоступна:', method, apiPath, e?.message || e);
        return { ok: false, status: 0, data: null, networkError: true };
      }
      if (r.status === 429 && attempt < 3) {
        let waitSec = 1;
        try { waitSec = Number((await r.json())?.retry_after) || 1; } catch {}
        await sleep(Math.min(waitSec, 60) * 1000);
        continue;
      }
      let data = null;
      try { data = await r.json(); } catch { /* 204 No Content и подобное */ }
      return { ok: r.ok, status: r.status, data };
    }
  };

  // Обращения Discord к нашему эндпоинту. Нужны панели: понять, дошёл ли вообще
  // Interactions Endpoint URL до Discord, иначе никак — сам Discord статус проверки
  // наружу не отдаёт, а при серии отказов молча перестаёт слать запросы.
  const endpoint = { lastOkAt: 0, lastFailAt: 0, okCount: 0, failCount: 0 };

  // ---- Проверка подписи интеракции ----
  // Discord подписывает СЫРЫЕ байты: timestamp + тело как пришло по сети.
  // Поэтому rawBody обязан быть Buffer'ом, а не строкой после склейки чанков.
  const verifySignature = (signatureHex, timestamp, rawBody) => {
    if (!cfg.publicKey || !signatureHex || !timestamp || !Buffer.isBuffer(rawBody)) return false;
    // Свежесть: подпись верна вечно, поэтому перехваченный запрос можно было
    // повторить хоть через месяц. Окно в 5 минут — стандартная мера, её же
    // советует Discord. Полную защиту дал бы учёт nonce, но для нашего эффекта
    // (повторная установка того же статуса) окна достаточно.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_MAX_SKEW_SEC) return false;
    try {
      const ok = crypto.verify(
        null,
        Buffer.concat([Buffer.from(timestamp), rawBody]),
        publicKeyFromHex(cfg.publicKey),
        Buffer.from(signatureHex, 'hex')
      );
      if (ok) { endpoint.lastOkAt = Date.now(); endpoint.okCount++; }
      else { endpoint.lastFailAt = Date.now(); endpoint.failCount++; }
      return ok;
    } catch {
      endpoint.lastFailAt = Date.now();
      endpoint.failCount++;
      return false;
    }
  };

  // ---- Публикация и обновление анонсов ----
  const isClosed = (sess, entry) =>
    !!(entry && entry.closed) ||
    (!!sess.event?.startsAt &&
      Date.now() >= new Date(sess.event.startsAt).getTime() + lifecycle.closeMsFor(sess.event?.type));

  // В какие каналы публиковать событие: клетка таблицы по дню недели и типу.
  // Пустая клетка = не публиковать вовсе.
  const channelsFor = (sess) => {
    const ev = sess.event;
    if (!ev || !ev.startsAt) return [];
    const day = weekdayOf(ev.startsAt, ev.tz);
    if (day === null) return [];
    return cfg.routes[`${day}:${ev.type}`]?.discordChannelIds || [];
  };

  // Отпечаток берём БЕЗ метки времени в подвале карточки: её ставит отрисовка в
  // момент запуска (discord_embed.mjs), поэтому она отличается всегда. Считай мы её —
  // каждый перезапуск правил бы все анонсы подряд, то есть ровно то, что отпечаток
  // и должен был прекратить. Содержимым карточки эта метка не является.
  const bodyFingerprint = (body) => fingerprint({
    ...body,
    embeds: (body.embeds || []).map(({ timestamp, ...rest }) => rest)
  });

  const payloadFor = (sess, players, closed) => buildAnnounce(sess, players, {
    closed,
    links: discordIdByPlayer(),
    emojis: cfg.emojis,
    pingRoleId: cfg.pingRoleId,
    siteUrl: cfg.siteUrl,
    lang: cfg.lang
  });

  const announce = async (sess, players) => {
    const channels = channelsFor(sess);
    if (!channels.length) {
      // Молчать здесь нельзя. «Анонс не пришёл» — самая частая жалоба, и раньше
      // при пустой клетке (или событии без времени) в логах не оставалось ровно
      // ничего, поэтому причину искали часами. Строка в журнале стоит копейки.
      const ev = sess.event || {};
      console.warn('[dc] анонс пропущен: нет каналов. событие=%s тип=%s время=%s пояс=%s день=%s',
        sess.id, ev.type, ev.startsAt || '(не задано)', ev.tz || '(не задан)',
        ev.startsAt ? weekdayOf(ev.startsAt, ev.tz) : '—');
      return;
    }
    const body = payloadFor(sess, players, false);
    const fp = bodyFingerprint(body);
    const posted = [];
    for (const channelId of channels) {
      const r = await dapi('POST', `/channels/${channelId}/messages`, body);
      if (r.ok && r.data?.id) posted.push({ channelId, messageId: r.data.id, fp });
      else console.error('[dc] анонс не отправлен:', r.status, r.data?.message);
    }
    if (posted.length) {
      msgs[sess.id] = posted;
      saveMsgs();
      scheduleClose(sess.id);
      scheduleReminder(sess.id);
      scheduleDelete(sess.id);
      dmAnnounce(sess).catch(() => {}); // личка подписавшимся — не блокирует анонс
    }
  };

  // Перерисовать все сообщения события. Состояние читаем свежее — вызовы идут
  // через склейку правок, и к моменту правки данные могли уйти вперёд.
  //
  // Здесь же единственная реальная опасность правки: не Discord теряет наши данные
  // (он их не хранит — заявки лежат в state.json, анонс лишь рисуется из них), а мы
  // сами можем затереть хорошее сообщение картинкой, собранной из непрочитавшегося
  // состояния. Поэтому оба выхода ниже — молчаливые: не смогли прочитать состояние
  // или не нашли событие — не трогаем сообщение вовсе, оно останется прежним.
  const renderEvent = async (sessionId) => {
    const entries = msgs[sessionId];
    if (!entries || !entries.length) return;
    const st = readState();
    const sess = (st.sessions || []).find(s => s.id === sessionId);
    if (!sess) return;
    const closed = isClosed(sess, entries[0]);
    const body = payloadFor(sess, st.players, closed);
    const fp = bodyFingerprint(body);
    let changed = false;
    const alive = [];
    for (const entry of entries) {
      if (closed && !entry.closed) { entry.closed = true; changed = true; }
      if (entry.fp === fp) { alive.push(entry); continue; } // в канале уже ровно это
      const r = await dapi('PATCH', `/channels/${entry.channelId}/messages/${entry.messageId}`, body);
      if (r.ok) { entry.fp = fp; changed = true; alive.push(entry); continue; }
      // 10008 — сообщения больше нет (удалили руками в канале). Запись мёртвая:
      // держать её незачем, иначе она будет впустую опрашиваться при каждом проходе.
      if (r.data?.code === 10008) { changed = true; continue; }
      console.error('[dc] правка не прошла:', r.status, r.data?.message);
      alive.push(entry);
    }
    if (alive.length) msgs[sessionId] = alive;
    else delete msgs[sessionId];
    if (changed) saveMsgs();
  };

  // Склейка правок: 30 кликов подряд → одна правка. Без неё упрёмся в лимиты.
  const renderQueue = createCoalescer((sessionId) => renderEvent(sessionId), 1200);

  const deleteMessages = async (sessionId) => {
    const entries = msgs[sessionId];
    if (!entries) return;
    for (const e of entries) {
      await dapi('DELETE', `/channels/${e.channelId}/messages/${e.messageId}`).catch(() => {});
    }
    clearCloseTimer(sessionId);
    clearRemindTimer(sessionId);
    clearDeleteTimer(sessionId);
    renderQueue.cancel(sessionId);
    delete msgs[sessionId];
    saveMsgs();
    if (dms[sessionId]) { delete dms[sessionId]; saveDms(); }
  };

  // ---- Таймер авто-закрытия ----
  const clearCloseTimer = (sessionId) => {
    const tmr = closeTimers.get(sessionId);
    if (tmr) { clearTimeout(tmr); closeTimers.delete(sessionId); }
  };
  const scheduleClose = (sessionId) => {
    clearCloseTimer(sessionId);
    const entries = msgs[sessionId];
    if (!entries || !entries.length || entries[0].closed) return;
    const sess = (readState().sessions || []).find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const delay = new Date(startsAt).getTime() + lifecycle.closeMsFor(sess?.event?.type) - Date.now();
    if (delay <= 0) { renderQueue.schedule(sessionId); return; }
    if (delay > 2147483647) return; // дальше горизонта setTimeout — переставим при следующем старте
    closeTimers.set(sessionId, setTimeout(() => {
      closeTimers.delete(sessionId);
      renderQueue.schedule(sessionId);
    }, delay));
  };
  // ---- Таймер удаления анонса ----
  // Отдельно от закрытия: закрытая регистрация оставляет карточку с составом в
  // канале, а удаление убирает её совсем. По умолчанию не удаляем — историю
  // потерять хуже, чем оставить лишнее сообщение.
  const clearDeleteTimer = (sessionId) => {
    const tmr = deleteTimers.get(sessionId);
    if (tmr) { clearTimeout(tmr); deleteTimers.delete(sessionId); }
  };
  const scheduleDelete = (sessionId) => {
    clearDeleteTimer(sessionId);
    const entries = msgs[sessionId];
    if (!entries || !entries.length) return;
    const sess = (readState().sessions || []).find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const after = lifecycle.deleteMsFor(sess?.event?.type);
    if (after === null) return; // «не удалять»
    const delay = new Date(startsAt).getTime() + after - Date.now();
    if (delay > 2147483647) return;
    if (delay <= 0) { deleteMessages(sessionId).catch(() => {}); return; }
    deleteTimers.set(sessionId, setTimeout(() => {
      deleteTimers.delete(sessionId);
      deleteMessages(sessionId).catch(() => {});
    }, delay));
  };

  const rescheduleAll = () => {
    for (const id of Object.keys(msgs)) { scheduleClose(id); scheduleReminder(id); scheduleDelete(id); }
  };

  // ---- Подтягивание вида уже отправленных сообщений ----
  // Обновить сообщение с кнопкой регистрации, если текущий код рисует его иначе.
  // В отличие от публикации, здесь ничего не создаём: нет сохранённого id — значит
  // офицер его ещё не публиковал, и вешать сообщение в канал самим нельзя.
  const syncRegisterMessage = async () => {
    const prev = cfg.registerMessage;
    if (!prev?.messageId) return;
    const body = registerBody();
    const fp = bodyFingerprint(body);
    if (prev.fp === fp) return;
    const r = await dapi('PATCH', `/channels/${prev.channelId}/messages/${prev.messageId}`, body);
    if (r.ok) { cfg.registerMessage = { ...prev, fp }; saveConfig(); return; }
    if (r.data?.code === 10008) { cfg.registerMessage = null; saveConfig(); } // удалили из канала
  };

  // Пройти живые сообщения и привести их к тому, что рисует текущий код.
  // Отпечаток делает проход почти бесплатным: сравнение локальное, в Discord уходят
  // только реально отличающиеся правки. Прошедшее давно не трогаем вовсе.
  // Настройки, от которых зависит ВИД уже висящих сообщений. Без этой связки смена
  // языка бота коснулась бы только будущих анонсов, а старые остались бы русскими.
  const viewKey = () =>
    JSON.stringify([cfg.lang, cfg.siteUrl, cfg.pingRoleId, cfg.registerRoleId, cfg.emojis]);
  const afterViewChange = (before) => {
    if (viewKey() !== before) resyncAll().catch(() => {});
  };

  const resyncPass = async () => {
    const st = readState();
    const byId = new Map((st.sessions || []).map(s => [s.id, s]));
    const now = Date.now();
    for (const id of Object.keys(msgs)) {
      const sess = byId.get(id);
      if (!sess || !worthResync(sess.event?.startsAt, now)) continue;
      await renderEvent(id);
      await sleep(RESYNC_GAP_MS); // растягиваем правки, чтобы не влететь в 429
    }
    await syncRegisterMessage();
  };

  // Два прохода разом не запускаем, но и не отбрасываем второй вызов молча:
  // он присоединяется к идущему и дожидается его. Если настройки поменялись,
  // пока проход шёл, делаем ещё круг — иначе сообщения, пройденные до правки,
  // остались бы в старом виде до следующего перезапуска.
  let resyncing = null;
  let resyncAgain = false;
  const resyncAll = () => {
    if (!cfg.botToken) return Promise.resolve();
    if (resyncing) { resyncAgain = true; return resyncing; }
    resyncing = (async () => {
      do {
        resyncAgain = false;
        await resyncPass();
      } while (resyncAgain);
    })().finally(() => { resyncing = null; });
    return resyncing;
  };

  // ---- Личка подписавшимся ----
  // Важно: в личку шлём карточку БЕЗ общих счётчиков, только со своим статусом.
  // Копия с живыми счётчиками означала бы правку 47 личных сообщений на каждый
  // клик — мгновенно упрёмся в лимиты. Здесь правится только своё, по своему клику.
  const dmBody = (sess, myStatus) => {
    const ev = sess.event || {};
    const L = langPack(cfg.lang);
    const TYPE = { prak: L.typePrak, ranked: L.typeRanked, league: L.typeLeague }[ev.type] || L.event;
    const title = ev.type === 'prak' && ev.opponent ? `${TYPE} — vs ${ev.opponent}` : (sess.name || TYPE);
    const when = ev.startsAt
      ? `<t:${Math.floor(new Date(ev.startsAt).getTime() / 1000)}:F> · <t:${Math.floor(new Date(ev.startsAt).getTime() / 1000)}:R>`
      : '';
    const LABEL = { in: `✅ ${L.stIn}`, maybe: `❓ ${L.stMaybe}`, sub: `🔄 ${L.stSub}`, out: `❌ ${L.stOut}` };
    return {
      embeds: [{
        title: `📣 ${title}`,
        description: [when && `🗓 ${when}`, L.dmYourAnswer(myStatus ? LABEL[myStatus] : L.dmNoAnswer)]
          .filter(Boolean).join('\n'),
        color: 0x5865f2,
        footer: { text: L.dmFooter }
      }],
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: L.btnIn, emoji: { name: '✅' }, custom_id: `sg:${sess.id}:in` },
          { type: 2, style: 2, label: L.btnMaybe, emoji: { name: '❓' }, custom_id: `sg:${sess.id}:maybe` },
          { type: 2, style: 2, label: L.btnSub, emoji: { name: '🔄' }, custom_id: `sg:${sess.id}:sub` },
          { type: 2, style: 4, label: L.btnOut, emoji: { name: '❌' }, custom_id: `sg:${sess.id}:out` }
        ]
      }]
    };
  };

  // Личный канал с пользователем (Discord его переиспользует, создавать каждый раз безопасно)
  const dmChannel = async (userId) => {
    const r = await dapi('POST', '/users/@me/channels', { recipient_id: userId });
    return r.ok ? r.data?.id : null;
  };

  const sendDm = async (userId, body) => {
    const channelId = await dmChannel(userId);
    if (!channelId) return false;
    const r = await dapi('POST', `/channels/${channelId}/messages`, body);
    // 50007 — «нельзя писать этому пользователю»: закрыта личка. Это нормально,
    // не ошибка нашей стороны; просто больше не пытаемся в этот заход.
    if (!r.ok && r.data?.code !== 50007) console.error('[dc] личка не ушла:', r.status, r.data?.message);
    return r.ok;
  };

  // Кому слать: подписавшиеся, привязанные и (для напоминаний) ещё не ответившие
  const dmTargets = (sess, onlySilent) => {
    const out = [];
    for (const [userId, v] of Object.entries(links)) {
      const playerId = pidOf(v);
      if (!playerId || !subs[userId]) continue;
      if (onlySilent && (sess.signups || {})[playerId]) continue;
      out.push({ userId, playerId });
    }
    return out;
  };

  const dmAnnounce = async (sess) => {
    if (!cfg.dmEnabled) return;
    const targets = dmTargets(sess, false);
    if (!targets.length) return;
    const record = dms[sess.id] || { sent: [], reminded: false };
    for (const { userId, playerId } of targets) {
      if (record.sent.includes(userId)) continue;
      const okSent = await sendDm(userId, dmBody(sess, (sess.signups || {})[playerId]));
      if (okSent) record.sent.push(userId);
      await sleep(150); // не частим: у лички лимиты жёстче, чем у канала
    }
    dms[sess.id] = record;
    saveDms();
  };

  const dmRemind = async (sessionId) => {
    if (!cfg.dmEnabled || !cfg.remindBeforeMin) return;
    const sess = (readState().sessions || []).find(s => s.id === sessionId);
    if (!sess) return;
    const record = dms[sessionId] || { sent: [], reminded: false };
    if (record.reminded) return;
    for (const { userId, playerId } of dmTargets(sess, true)) {
      await sendDm(userId, dmBody(sess, (sess.signups || {})[playerId]));
      await sleep(150);
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
    const sess = (readState().sessions || []).find(s => s.id === sessionId);
    const startsAt = sess?.event?.startsAt;
    if (!startsAt) return;
    const delay = new Date(startsAt).getTime() - cfg.remindBeforeMin * 60_000 - Date.now();
    if (delay <= 0) return;              // момент напоминания уже прошёл — не спамим задним числом
    if (delay > 2147483647) return;
    remindTimers.set(sessionId, setTimeout(() => {
      remindTimers.delete(sessionId);
      dmRemind(sessionId).catch(() => {});
    }, delay));
  };

  // ---- Регистрация и привязка ника ----
  // Всё общение — эфемерное (флаг 64): видит только нажавший, канал не засоряется.
  // Незавершённые анкеты держим в памяти: диалог занимает секунды, переживать
  // перезапуск ему не нужно, а на диске это лишний мусор.
  const pending = new Map(); // discordUserId -> { nick, role, weapons }

  const boundPlayerIds = () => new Set(Object.values(links).map(pidOf).filter(Boolean));

  // Ники, которые ещё можно занять: чужие привязки не показываем вовсе, иначе
  // человек выберет занятого и упрётся в отказ, не понимая почему.
  const freePlayers = (state, selfId) => {
    const taken = boundPlayerIds();
    return (state.players || []).filter(p => !taken.has(p.id) || linkedPid(selfId) === p.id);
  };

  // Сколько похожих ников показываем кнопками на первом шаге. Пять — это одна строка
  // кнопок в Discord; шестая уехала бы на вторую строку и спорила бы с «Меня здесь нет».
  const SIMILAR_LIMIT = 5;
  // Выпадающих списков со всем составом — не больше четырёх (по 25 ников в каждом):
  // в сообщении всего пять рядов, и один обязан остаться под кнопку «Я новенький».
  const ALL_GROUPS_LIMIT = 4;

  // Экран «весь состав»: выбрать себя из списка, ничего не печатая. Именно здесь
  // ловятся те, кто записан в составе иначе, чем помнит сам, — а раньше они молча
  // уходили заводить дубль. Возвращает пару [текст, ряды компонентов].
  const allRosterScreen = (L, state, selfId, intro) => {
    const groups = alphaGroups(freePlayers(state, selfId)).slice(0, ALL_GROUPS_LIMIT);
    const say = (s) => (intro ? `${intro}\n\n${s}` : s);
    const newbieRow = (style) => ({
      type: 1, components: [{ type: 2, style, label: L.regNewbie, custom_id: 'reg:new' }]
    });
    if (!groups.length) return [say(L.regAllEmpty), [newbieRow(1)]];
    // custom_id обязан быть свой у каждого списка: Discord не принимает сообщение,
    // где два компонента названы одинаково.
    const rows = groups.map((g, i) => ({
      type: 1,
      components: [{
        type: 3, custom_id: `reg:pick:${i}`, placeholder: L.regGroup(g.from, g.to),
        options: g.players.map(p => ({ label: String(p.name).slice(0, 100), value: p.id }))
      }]
    }));
    rows.push(newbieRow(2));
    return [say(L.regAllList), rows];
  };

  // Есть ли у нажавшего роль-гейт. Роли приходят прямо в интеракции — отдельный
  // запрос к Discord не нужен, а значит успеваем в 3-секундный лимит.
  const passesGate = (interaction) => {
    if (!cfg.registerRoleId) return true; // гейт не настроен — открыто всем
    const roles = interaction.member?.roles || [];
    return roles.includes(cfg.registerRoleId);
  };

  // Как человек подписан в Discord. Нужно панели «Привязки»: по одному числовому id
  // офицер не поймёт, чья это привязка, когда карточка игрока исчезла из состава, —
  // а значит не сможет ни перепривязать её, ни осознанно снять.
  const discordNameOf = (interaction) => String(
    interaction?.member?.user?.global_name || interaction?.member?.user?.username ||
    interaction?.user?.global_name || interaction?.user?.username || ''
  );

  const linkPlayer = (userId, playerId, playerName = '', discordName = '') => {
    links[userId] = { playerId, discordName, playerName };
    saveLinks();
  };

  // Сразу после привязки предлагаем включить напоминания в личку. Раньше эту
  // кнопку можно было найти только повторным нажатием «Зарегистрироваться» —
  // то есть практически никак.
  const subPrompt = (L, userId) => (subs[userId] ? [] : [{
    type: 1,
    components: [{ type: 2, style: 1, label: L.subEnable, emoji: { name: '🔔' }, custom_id: 'reg:sub' }]
  }]);

  // ---- Обработка интеракции ----
  // Ответ обязан уйти в течение 3 секунд, иначе Discord считает эндпоинт мёртвым
  // (а при серии провалов отключает его в панели разработчика). Поэтому здесь
  // только быстрые ответы; перерисовка анонса уходит в склейку и догоняет следом.
  const ephemeral = (content, components) => ({
    type: 4,
    data: components ? { content, components, flags: 64 } : { content, flags: 64 }
  });

  // Эфемерное ли сообщение, на котором нажали кнопку (флаг 64).
  const fromEphemeral = (interaction) => !!((interaction?.message?.flags || 0) & 64);
  // Личка: у интеракций в ЛС нет guild_id.
  const fromDm = (interaction) => !interaction?.guild_id;

  // Продолжение диалога. ВАЖНО: type 7 заменяет то сообщение, на котором была
  // кнопка. Для эфемерных шагов анкеты это правильно (диалог идёт в одном окне),
  // но на ПУБЛИЧНОМ сообщении он затёр бы его вместе с кнопками — именно так
  // пропадала кнопка регистрации после нажатия «Напоминания». Поэтому на
  // публичном сообщении отвечаем новым эфемерным (type 4), не трогая исходное.
  const reply = (interaction, content, components = []) =>
    fromEphemeral(interaction)
      ? { type: 7, data: { content, components, flags: 64 } }
      : { type: 4, data: { content, components, flags: 64 } };

  // Сообщение с кнопкой регистрации — заодно вторая кнопка на подписку,
  // чтобы её было видно всем и сразу, а не только уже привязанным.
  const registerComponents = (L) => [{
    type: 1,
    components: [
      { type: 2, style: 1, label: L.regButton, emoji: { name: '📝' }, custom_id: 'reg:start' },
      { type: 2, style: 2, label: L.subButton, emoji: { name: '🔔' }, custom_id: 'reg:sub' }
    ]
  }];

  // Тело сообщения с кнопкой регистрации. Вынесено, чтобы публикация и обновление
  // собирали ровно одно и то же — иначе отпечатки не сойдутся и правка будет
  // уходить каждый проход.
  const registerBody = () => {
    const L = langPack(cfg.lang);
    const gate = cfg.registerRoleId ? L.regGate(cfg.registerRoleId) : '';
    return {
      content: '',
      embeds: [{ title: L.regTitle, description: L.regDesc + gate, color: 0x5865f2 }],
      components: registerComponents(L),
      allowed_mentions: { parse: [] } // роль в тексте упомянута, но пинговать её не надо
    };
  };

  const handleInteraction = (interaction) => {
    if (interaction?.type === 1) return { type: 1 }; // PING → PONG (проверка эндпоинта)
    const L = langPack(cfg.lang);

    // Нажатие кнопки под анонсом: sg:<sessionId>:<status>
    if (interaction?.type === 3 && String(interaction.data?.custom_id || '').startsWith('sg:')) {
      const [, sessionId, status] = String(interaction.data.custom_id).split(':');
      if (!['in', 'maybe', 'out', 'sub'].includes(status)) return ephemeral(L.unknownStatus);

      const userId = String(interaction.member?.user?.id || interaction.user?.id || '');
      const playerId = linkedPid(userId);
      if (!playerId) {
        return ephemeral(L.notLinked);
      }

      const state = readState();
      const sess = (state.sessions || []).find(s => s.id === sessionId);
      if (!sess) return ephemeral(L.eventGone);
      if (isClosed(sess, msgs[sessionId]?.[0])) return ephemeral(L.regClosed);
      const player = (state.players || []).find(p => p.id === playerId);
      if (!player) return ephemeral(L.playerGone);

      sess.signups = sess.signups || {};
      const prev = sess.signups[playerId];
      sess.signups[playerId] = status;
      // Время двигаем только при смене статуса: повторный тап той же кнопки
      // не должен отправлять человека в конец очереди.
      sess.signupMeta = sess.signupMeta || {};
      if (!sess.signupMeta[playerId] || prev !== status) {
        sess.signupMeta[playerId] = { from: 'discord', at: new Date().toISOString() };
      }
      writeState(state);
      // Вторым аргументом — какое событие изменилось: index.mjs по нему обновит
      // анонс и в Телеграме, иначе там заявка не появится, пока кто-то не нажмёт
      // кнопку уже в Телеграме.
      broadcastState(state, sessionId);
      renderQueue.schedule(sessionId); // свой анонс догонит через ~1.2 с

      // Нажали в личке — обновляем саму карточку (type 7), чтобы в ней сразу
      // был виден новый ответ. Правится ровно одно сообщение — своё, — поэтому
      // на лимиты это не влияет, в отличие от общих счётчиков.
      if (fromDm(interaction)) {
        return { type: 7, data: dmBody(sess, status) };
      }

      // В канале карточку трогать нельзя: анонс общий, его перерисует склейка.
      // Отвечаем эфемерным подтверждением.
      const LABEL = { in: L.stIn, maybe: L.stMaybe, sub: L.stSub, out: L.stOut };
      return ephemeral(L.saved(LABEL[status]));
    }

    // ---- Регистрация ----
    const customId = String(interaction?.data?.custom_id || '');
    const userId = String(interaction?.member?.user?.id || interaction?.user?.id || '');

    // Кнопка «Зарегистрироваться» → окно ввода ника
    if (interaction?.type === 3 && customId === 'reg:start') {
      if (!passesGate(interaction)) {
        return ephemeral(L.regNoAccess);
      }
      const already = links[userId];
      if (already) {
        const p = (readState().players || []).find(x => x.id === already);
        const subbed = !!subs[userId];
        return ephemeral(
          `${L.regAlready(p ? p.name : '???')}\n\n${subbed ? L.subOn : L.subOff}`,
          [{
            type: 1,
            components: [
              subbed
                ? { type: 2, style: 2, label: L.subDisable, emoji: { name: '🔕' }, custom_id: 'reg:unsub' }
                : { type: 2, style: 1, label: L.subEnable, emoji: { name: '🔔' }, custom_id: 'reg:sub' },
              { type: 2, style: 4, label: L.unlink, custom_id: 'reg:unlink' }
            ]
          }]
        );
      }
      return {
        type: 9, // модальное окно
        data: {
          custom_id: 'reg:nick',
          title: L.regModalTitle,
          components: [{
            type: 1,
            components: [{
              type: 4, custom_id: 'nick', style: 1, label: L.regNickLabel,
              placeholder: L.regNickPlaceholder, required: true, min_length: 1, max_length: 40
            }]
          }]
        }
      };
    }

    if (interaction?.type === 3 && customId === 'reg:unlink') {
      if (links[userId]) { delete links[userId]; saveLinks(); }
      if (subs[userId]) { delete subs[userId]; saveSubs(); } // отписываем заодно
      return reply(interaction, L.unlinked);
    }

    // Подписка на личку — только по своей воле (иначе рассылка упрётся в закрытые
    // настройки приватности, а людей это раздражает)
    if (interaction?.type === 3 && customId === 'reg:sub') {
      if (!links[userId]) return reply(interaction, L.subNeedLink);
      // Уже подписан — не молчим и не подписываем повторно, а сразу даём выключить.
      // Иначе кнопка «Напоминания» в канале становится дорогой в один конец.
      if (subs[userId]) {
        return reply(interaction, L.subOn, [{
          type: 1,
          components: [{ type: 2, style: 2, label: L.subDisable, emoji: { name: '🔕' }, custom_id: 'reg:unsub' }]
        }]);
      }
      subs[userId] = true; saveSubs();
      return reply(interaction, L.subDone, [{
        type: 1,
        components: [{ type: 2, style: 2, label: L.subDisable, emoji: { name: '🔕' }, custom_id: 'reg:unsub' }]
      }]);
    }
    if (interaction?.type === 3 && customId === 'reg:unsub') {
      if (subs[userId]) { delete subs[userId]; saveSubs(); }
      return reply(interaction, L.subGone);
    }

    // Ввели ник → ищем в составе
    if (interaction?.type === 5 && customId === 'reg:nick') {
      const nick = String(
        interaction.data?.components?.[0]?.components?.[0]?.value || ''
      ).trim();
      if (!nick) return ephemeral(L.regEmptyNick);

      const state = readState();
      // Ник запоминаем СРАЗУ. Раньше при одном совпадении его не сохраняли, и тот, кто
      // отвечал «нет, я новый», заводился в составе с ПУСТЫМ именем.
      pending.set(userId, { nick, role: null, weapons: [] });

      // Лесенка: сначала похожие, потом весь состав, и только в конце «я новенький».
      const similar = rankRoster(freePlayers(state, userId), nick, SIMILAR_LIMIT);
      if (!similar.length) {
        const [text, rows] = allRosterScreen(L, state, userId, L.regNoneSimilar(nick));
        return ephemeral(text, rows);
      }
      return ephemeral(L.regSimilar(nick), [
        {
          // Первый кандидат — зелёной кнопкой: он самый вероятный, и по нему сразу видно,
          // куда жать. Остальные серые, чтобы не создавать пять равнозначных вариантов.
          type: 1,
          components: similar.map((p, i) => ({
            type: 2, style: i === 0 ? 3 : 2,
            label: String(p.name).slice(0, 80), custom_id: `reg:bind:${p.id}`
          }))
        },
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: L.regNotMe, custom_id: 'reg:all' },
            { type: 2, style: 2, label: L.regNewbie, custom_id: 'reg:new' }
          ]
        }
      ]);
    }

    // «Меня здесь нет» → весь состав списками
    if (interaction?.type === 3 && customId === 'reg:all') {
      const [text, rows] = allRosterScreen(L, readState(), userId);
      return reply(interaction, text, rows);
    }

    // Выбрал себя из списка (похожие или алфавитная группа — обработка одна)
    if (interaction?.type === 3 && customId.startsWith('reg:pick')) {
      const playerId = interaction.data?.values?.[0];
      const p = (readState().players || []).find(x => x.id === playerId);
      if (!p) return reply(interaction, L.regNickGone);
      if (boundPlayerIds().has(p.id) && linkedPid(userId) !== p.id) {
        return reply(interaction, L.regTaken);
      }
      linkPlayer(userId, p.id, p.name, discordNameOf(interaction));
      pending.delete(userId);
      return reply(interaction, L.regDone(p.name), subPrompt(L, userId));
    }

    // Подтвердил единственное совпадение
    if (interaction?.type === 3 && customId.startsWith('reg:bind:')) {
      const playerId = customId.slice('reg:bind:'.length);
      const p = (readState().players || []).find(x => x.id === playerId);
      if (!p) return reply(interaction, L.regNickGone);
      if (boundPlayerIds().has(p.id) && linkedPid(userId) !== p.id) {
        return reply(interaction, L.regTaken);
      }
      linkPlayer(userId, p.id, p.name, discordNameOf(interaction));
      pending.delete(userId);
      return reply(interaction, L.regDone(p.name), subPrompt(L, userId));
    }

    // «Нет, я новый» — спрашиваем роль
    if (interaction?.type === 3 && customId === 'reg:new') {
      const prev = pending.get(userId);
      const nick = String(prev?.nick || '').trim();
      // Без ника нового игрока не заводим: в составе появилась бы безымянная строка,
      // и офицер потом гадал бы, чья она.
      if (!nick) return reply(interaction, L.regNickLost);
      pending.set(userId, { nick, role: null, weapons: [] });
      return reply(interaction, L.regAskRoleAgain, [{
        type: 1,
        components: [{
          type: 3, custom_id: 'reg:role', placeholder: L.regRolePlaceholder,
          options: ROLES.map(r => ({ label: L[r.key], value: r.value, emoji: roleEmoji(r, cfg.emojis) }))
        }]
      }]);
    }

    // Выбрал роль → спрашиваем две школы
    if (interaction?.type === 3 && customId === 'reg:role') {
      const draft = pending.get(userId);
      if (!draft) return reply(interaction, L.regLost);
      draft.role = interaction.data?.values?.[0] || 'DPS';
      pending.set(userId, draft);
      return reply(interaction, L.regAskWeapons, [{
        type: 1,
        components: [{
          type: 3, custom_id: 'reg:weapons', placeholder: L.regWeaponsPlaceholder,
          min_values: 2, max_values: 2,
          options: WEAPON_SCHOOLS.map(w => ({ label: w.label, value: w.value }))
        }]
      }]);
    }

    // Выбрал школы → заводим карточку и привязываем
    if (interaction?.type === 3 && customId === 'reg:weapons') {
      const draft = pending.get(userId);
      if (!draft || !draft.role) return reply(interaction, L.regLost);
      if (!String(draft.nick || '').trim()) return reply(interaction, L.regNickLost);
      const weapons = (interaction.data?.values || []).slice(0, 2);
      if (weapons.length !== 2) return reply(interaction, L.regNeedTwo);

      const state = readState();
      // Пока человек заполнял анкету, офицер мог завести его руками — проверяем ещё раз
      const dup = (state.players || []).find(p => p.name.trim().toLowerCase() === draft.nick.trim().toLowerCase());
      if (dup && !boundPlayerIds().has(dup.id)) {
        linkPlayer(userId, dup.id, dup.name, discordNameOf(interaction));
        pending.delete(userId);
        return reply(interaction, L.regWasThere(dup.name), subPrompt(L, userId));
      }

      const player = {
        id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: draft.nick,
        role: draft.role,
        weapons
      };
      state.players = [...(state.players || []), player];
      writeState(state);
      broadcastState(state);
      linkPlayer(userId, player.id, player.name, discordNameOf(interaction));
      pending.delete(userId);
      return reply(interaction, 
        L.regCreated(player.name, L[ROLES.find(r => r.value === player.role)?.key] || player.role),
        subPrompt(L, userId)
      );
    }

    return ephemeral(L.notReady);
  };

  // ---- Публичный интерфейс ----
  return {
    verifySignature,
    handleInteraction,
    dapi, // фазам анонсов/регистрации; наружу в index.mjs не торчит

    // Задать/сменить токен бота из UI. Пустой токен — отключить интеграцию.
    // applicationId и публичный ключ забираем у Discord сами — офицеру их искать не нужно.
    async setToken(token) {
      token = (token || '').trim();
      if (!token) {
        // Эмодзи чистим вместе с токеном: их id принадлежат конкретному приложению.
        // Без этого панель после переподключения рапортует «8 / 8 загружено», а в
        // анонсах на месте значков школ появляется сломанный текст.
        // Секрет и флаг входа уезжают вместе с приложением: секрет принадлежит ему
        // же, а оставленный включённым флаг запер бы снаружи всю гильдию — войти
        // нечем, а отмечаться без входа при включённом флаге уже нельзя.
        Object.assign(cfg, {
          botToken: '', applicationId: '', publicKey: '', appName: '', botUsername: '',
          emojis: {}, clientSecret: '', loginEnabled: false
        });
        saveConfig();
        return { ok: true, connected: false };
      }
      const prevToken = cfg.botToken;
      const prevAppId = cfg.applicationId;
      cfg.botToken = token;
      const me = await dapi('GET', '/users/@me');
      const app = me.ok ? await dapi('GET', '/applications/@me') : { ok: false };
      if (!me.ok || !app.ok) {
        cfg.botToken = prevToken; // не затираем рабочий токен нерабочим
        return { ok: false, error: me.status === 401 ? 'Токен не принят Discord' : 'Discord не ответил' };
      }
      cfg.botUsername = me.data?.username || '';
      cfg.applicationId = String(app.data?.id || '');
      cfg.publicKey = String(app.data?.verify_key || '');
      cfg.appName = app.data?.name || '';
      // Подключили другое приложение — старые id эмодзи к нему не относятся.
      // Client secret тем более: он выдан прежнему приложению и обменять код им
      // уже нельзя. Оставить его — значит получить вход, который молча не работает.
      if (prevAppId && prevAppId !== cfg.applicationId) {
        cfg.emojis = {};
        cfg.clientSecret = '';
        cfg.loginEnabled = false;
      }
      saveConfig();
      return { ok: true, connected: true, botUsername: cfg.botUsername };
    },

    // Статус для UI (токен целиком не отдаём)
    getStatus() {
      return {
        hasToken: !!cfg.botToken,
        tokenHint: cfg.botToken ? '…' + cfg.botToken.slice(-6) : '',
        appName: cfg.appName,
        botUsername: cfg.botUsername,
        applicationId: cfg.applicationId,
        hasPublicKey: !!cfg.publicKey,
        guildId: cfg.guildId,
        pingRoleId: cfg.pingRoleId,
        registerChannelId: cfg.registerChannelId,
        registerRoleId: cfg.registerRoleId,
        registerPosted: !!cfg.registerMessage?.messageId,
        officerRoleId: cfg.officerRoleId,
        accessMode: cfg.accessMode === 'closed' ? 'closed' : 'open',
        loginEnabled: !!cfg.loginEnabled,
        hasClientSecret: !!cfg.clientSecret,
        secretHint: cfg.clientSecret ? '…' + cfg.clientSecret.slice(-4) : '',
        routes: cfg.routes,
        emojiCount: Object.keys(cfg.emojis || {}).length,
        // Диагностика эндпоинта: было ли хоть одно проверенное обращение от Discord
        // и когда. Сбрасывается при перезапуске процесса — это нормально.
        endpointOkAt: endpoint.lastOkAt,
        endpointFailAt: endpoint.lastFailAt,
        endpointFailCount: endpoint.failCount,
        siteUrl: cfg.siteUrl,
        lang: cfg.lang,
        dmEnabled: cfg.dmEnabled,
        remindBeforeMin: cfg.remindBeforeMin,
        subscriberCount: Object.keys(subs).length
      };
    },

    // ---- Вход на сайт через Discord (OAuth2) ----

    /** Настройки входа для сервера и панели. Секрет наружу не отдаём никогда. */
    authConfig() {
      return {
        loginEnabled: !!cfg.loginEnabled && !!cfg.clientSecret && !!cfg.applicationId,
        accessMode: cfg.accessMode === 'closed' ? 'closed' : 'open',
        officerRoleId: cfg.officerRoleId,
        guildId: cfg.guildId,
        registerChannelId: cfg.registerChannelId,
        hasClientSecret: !!cfg.clientSecret,
        canEnable: !!cfg.clientSecret && !!cfg.applicationId && !!cfg.botToken
      };
    },

    setClientSecret(secret) {
      const next = String(secret ?? '').trim();
      cfg.clientSecret = next;
      // Секрет убрали — входить больше нечем. Оставить флаг включённым значило бы
      // запереть снаружи всех разом: войти нельзя, а отмечаться без входа уже нельзя.
      if (!next) cfg.loginEnabled = false;
      saveConfig();
      return { ok: true, hasClientSecret: !!cfg.clientSecret };
    },

    /**
     * Адрес, куда отправляем человека на Discord.
     * Просим ТОЛЬКО identify — «узнать, кто вы». Состоит ли он в гильдии и есть ли у
     * него роль, спрашиваем сами, токеном бота: так экран согласия самый безобидный,
     * а guilds.members.read просить не приходится вовсе.
     */
    loginUrl(redirectUri, state, { consent = false } = {}) {
      if (!cfg.applicationId || !cfg.clientSecret || !redirectUri) return '';
      const q = new URLSearchParams({
        client_id: cfg.applicationId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state
      });
      // prompt=none пропускает экран согласия тому, кто уже разрешал. Что Discord
      // делает с ним у новичка — в документации не написано, поэтому на удачу не
      // полагаемся: при отказе index.mjs повторит заход с обычным экраном.
      if (!consent) q.set('prompt', 'none');
      return `https://discord.com/oauth2/authorize?${q}`;
    },

    /**
     * Обменять одноразовый код на личность. Возвращает { id, name } либо null.
     * Наружу не бросает: Discord может не ответить, и это не повод ронять запрос.
     */
    async exchangeCode(code, redirectUri) {
      if (!cfg.applicationId || !cfg.clientSecret || !code || !redirectUri) return null;
      try {
        const basic = Buffer.from(`${cfg.applicationId}:${cfg.clientSecret}`).toString('base64');
        // Обмен идёт form-urlencoded: JSON здесь Discord не принимает.
        const tok = await fetch(`${API}/oauth2/token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${basic}`
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri
          }).toString()
        });
        if (!tok.ok) return null;
        const access = (await tok.json())?.access_token;
        if (!access) return null;
        // Токен человека живёт только эту секунду: узнали, кто он, и забыли.
        // Хранить его негде и незачем — всё остальное мы спрашиваем токеном бота.
        const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${access}` } });
        if (!me.ok) return null;
        const u = await me.json();
        if (!u?.id) return null;
        return { id: String(u.id), name: String(u.global_name || u.username || '') };
      } catch {
        return null;   // сеть отвалилась — вход просто не состоялся
      }
    },

    setSiteUrl(url) {
      const next = (url || '').trim().replace(/\/+$/, '');
      if (next && next !== cfg.siteUrl) {
        const before = viewKey();
        cfg.siteUrl = next;
        saveConfig();
        afterViewChange(before);
      }
    },

    // Пересчитать таймеры авто-закрытия (после смены сроков в /api/lifecycle)
    rescheduleAll() { rescheduleAll(); },

    // Привести висящие сообщения к текущему виду прямо сейчас. Обычно вызывается
    // сама при старте и смене настроек; наружу вынесена, чтобы её можно было
    // проверить тестами, не дожидаясь отложенного запуска.
    resyncMessages() { return resyncAll(); },

    // Загрузить иконки школ оружия как эмодзи приложения. Картинки приходят с
    // фронта (на сервер папка assets/ не заливается — она нужна только сборке), каждая как
    // data:image/png;base64,… Слоты сервера при этом не занимаются.
    async syncEmojis(images) {
      if (!cfg.botToken || !cfg.applicationId) return { ok: false, error: 'Бот не подключён' };
      if (!images || typeof images !== 'object') return { ok: false, error: 'Нет картинок' };

      // Что уже загружено — чтобы не плодить дубликаты при повторном запуске.
      //
      // Проверять ответ ОБЯЗАТЕЛЬНО до перебора: при ошибке Discord присылает не
      // массив, а объект вида {message, code}, и `for...of` по нему бросал
      // TypeError: not iterable. Исключение ловила общая страховка сервера, поэтому
      // сайт выживал, но офицер вместо «Discord недоступен» получал 500 и совет
      // «проверьте, что бот подключён» — то есть его отправляли чинить не то.
      // Раньше проверка networkError стояла ПОСЛЕ цикла и до неё просто не доходило.
      const list = await dapi('GET', `/applications/${cfg.applicationId}/emojis`);
      if (list.networkError) return { ok: false, upstream: true, error: 'Discord недоступен — попробуйте ещё раз' };
      if (!list.ok) return { ok: false, upstream: true, error: 'Discord не отдал список эмодзи — попробуйте ещё раз' };

      const items = Array.isArray(list.data?.items) ? list.data.items
        : Array.isArray(list.data) ? list.data
        : [];
      const existing = new Map();
      for (const e of items) {
        if (e?.name && e?.id) existing.set(e.name, e.id);
      }

      const emojis = { ...cfg.emojis };
      let uploaded = 0, failed = 0;
      for (const [name, dataUri] of Object.entries(images)) {
        if (!/^[a-z0-9_]{2,32}$/i.test(name)) continue;
        if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) continue;
        // Одноимённое эмодзи заменяем, а не пропускаем. Раньше повторная загрузка
        // молча ничего не делала, и исправленную картинку (обрезанные поля, 128×128)
        // было не применить иначе как удалив эмодзи руками в Developer Portal.
        // У Discord нет способа заменить картинку у существующего эмодзи — PATCH
        // умеет только переименование, поэтому именно удалить и создать заново.
        if (existing.has(name)) {
          const del = await dapi('DELETE', `/applications/${cfg.applicationId}/emojis/${existing.get(name)}`);
          if (!del.ok) {
            // Не смогли удалить — оставляем как было, чтобы не потерять рабочий значок
            emojis[name] = existing.get(name);
            failed++;
            console.error('[dc] старое эмодзи не удалилось:', name, del.status, del.data?.message);
            continue;
          }
          delete emojis[name];
        }
        const r = await dapi('POST', `/applications/${cfg.applicationId}/emojis`, { name, image: dataUri });
        if (r.ok && r.data?.id) { emojis[name] = r.data.id; uploaded++; }
        else { failed++; console.error('[dc] эмодзи не загрузилось:', name, r.status, r.data?.message); }
      }
      const before = viewKey();
      cfg.emojis = emojis;
      saveConfig();
      // Новые значки школ должны появиться и в уже висящих анонсах, а не только в будущих
      afterViewChange(before);
      // Не рапортуем успех, если на деле не загрузилось ничего
      if (failed && !uploaded && !Object.keys(emojis).length) {
        return { ok: false, upstream: true, error: 'Discord отклонил загрузку иконок' };
      }
      return { ok: true, total: Object.keys(emojis).length, uploaded, failed };
    },

    // Разослать/обновить анонсы после сохранения состояния гильдии.
    // Логика та же, что у Телеграма: новое событие — анонсируем, удалённое —
    // убираем сообщение, изменившееся — перерисовываем.
    async syncEvents(oldState, newState) {
      if (!cfg.botToken) return;
      const oldSessions = oldState?.sessions || [];
      const newSessions = newState?.sessions || [];
      const oldIds = new Set(oldSessions.map(s => s.id));
      const newIds = new Set(newSessions.map(s => s.id));

      for (const s of newSessions) {
        if (!s.event) continue;      // это шаблон состава, а не событие
        if (oldIds.has(s.id)) continue;
        if (msgs[s.id]) continue;
        await announce(s, newState.players);
      }
      for (const s of oldSessions) {
        if (!msgs[s.id]) continue;
        if (newIds.has(s.id)) continue;
        await deleteMessages(s.id);
      }
      const oldById = new Map(oldSessions.map(s => [s.id, s]));
      const digest = (s) => JSON.stringify({ n: s.name, e: s.event, g: s.signups || {}, a: s.assignments || [] });
      const namesDigest = (st) => JSON.stringify((st?.players || []).map(p => [p.id, p.name, p.role, p.weapons]));
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

    // Обновить один анонс (после заявки через /api/signup)
    async refreshEvent(sessionId) {
      if (!cfg.botToken) return;
      renderQueue.schedule(sessionId);
    },

    // Привязки ника к аккаунту Discord (для офицерской админки).
    // alive = карточка игрока на месте. Мёртвая привязка НЕ удаляется автоматически:
    // признак «мертва» — это «такого игрока нет в составе», а состав может на секунду
    // прочитаться пустым (битый файл, идущий откат). Автоматика, поймавшая такую
    // секунду, стёрла бы регистрации всей гильдии, и восстановить их неоткуда —
    // discordlinks.json не в гите. Поэтому чистит только офицер, глазами и кнопкой.
    listLinks() {
      const state = readState();
      return Object.entries(links).map(([discordId, v]) => {
        const playerId = pidOf(v);
        const p = (state.players || []).find(x => x.id === playerId);
        return {
          discordId,
          playerId,
          alive: !!p,
          playerName: p ? p.name : '',
          // подписи на случай, когда карточки уже нет
          discordName: (typeof v === 'object' && v?.discordName) || '',
          lastPlayerName: (typeof v === 'object' && v?.playerName) || ''
        };
      });
    },

    unbind(discordId) {
      if (links[discordId]) { delete links[discordId]; saveLinks(); return true; }
      return false;
    },

    // Перенацелить привязку на другую карточку. Нужно, когда офицер удалил игрока и
    // завёл его заново руками: это новая карточка с новым номером, и связать её со
    // старым аккаунтом программа не может — только человек.
    rebind(discordId, playerId) {
      if (!discordId || !playerId) return { ok: false, error: 'Не хватает данных' };
      const prev = links[discordId];
      if (!prev) return { ok: false, error: 'Такой привязки нет' };
      const state = readState();
      const p = (state.players || []).find(x => x.id === playerId);
      if (!p) return { ok: false, error: 'Игрока нет в составе' };
      for (const [other, v] of Object.entries(links)) {
        if (other !== discordId && pidOf(v) === playerId) {
          return { ok: false, error: 'Этот ник уже привязан к другому аккаунту' };
        }
      }
      links[discordId] = {
        playerId,
        discordName: (typeof prev === 'object' && prev?.discordName) || '',
        playerName: p.name
      };
      saveLinks();
      return { ok: true };
    },

    /** id игрока по аккаунту Discord — этим сайт узнаёт вошедшего. Без сети. */
    playerIdFor(discordId) { return linkedPid(String(discordId || '')); },

    /**
     * Роли человека на сервере гильдии. Отдельный запрос про ОДНОГО участника:
     * список всех (`GET /guilds/{id}/members`) потребовал бы привилегированного
     * интента GUILD_MEMBERS, то есть лишнего тумблера в Developer Portal и лишнего
     * шага в инструкции офицеру. Здесь не требуется ничего.
     * null — Discord не ответил (это НЕ «ролей нет»).
     */
    async memberRoles(discordId) {
      if (!cfg.botToken || !cfg.guildId || !discordId) return null;
      const r = await dapi('GET', `/guilds/${cfg.guildId}/members/${discordId}`);
      if (!r.ok) return null;
      return Array.isArray(r.data?.roles) ? r.data.roles.map(String) : [];
    },

    /** Настроена ли офицерская роль. Без неё через Discord редактором не стать. */
    officerRoleId() { return cfg.officerRoleId; },

    // Опубликовать в канале регистрации сообщение с кнопкой. Офицер жмёт это
    // один раз со страницы настроек; дальше кнопка живёт в канале сама.
    async postRegisterMessage() {
      if (!cfg.botToken) return { ok: false, error: 'Бот не подключён' };
      if (!cfg.registerChannelId) return { ok: false, error: 'Канал регистрации не выбран' };
      const body = registerBody();
      const fp = bodyFingerprint(body);
      const prev = cfg.registerMessage;
      // Сообщение уже стоит в этом канале — правим его, а не вешаем второе.
      // Если офицер сменил канал, публикуем заново: старое остаётся там, где было.
      if (prev?.messageId && prev.channelId === cfg.registerChannelId) {
        const r = await dapi('PATCH', `/channels/${prev.channelId}/messages/${prev.messageId}`, body);
        if (r.ok) {
          cfg.registerMessage = { ...prev, fp };
          saveConfig();
          return { ok: true, updated: true };
        }
        // 10008 — сообщение удалили из канала: тогда публикуем новое, ниже.
        if (r.data?.code !== 10008) return { ok: false, error: r.data?.message || 'Discord отказал' };
      }
      const r = await dapi('POST', `/channels/${cfg.registerChannelId}/messages`, body);
      if (!r.ok || !r.data?.id) return { ok: false, error: r.data?.message || 'Discord отказал' };
      cfg.registerMessage = { channelId: cfg.registerChannelId, messageId: r.data.id, fp };
      saveConfig();
      return { ok: true };
    },

    // Поднять таймеры закрытия при старте процесса и подтянуть вид сообщений.
    start() {
      if (!cfg.botToken) return;
      rescheduleAll();
      // Старт процесса = деплой мог принести новую вёрстку. В сеть лезем не сразу:
      // пусть сайт сначала поднимется, анонсы подождут пять секунд.
      setTimeout(() => { resyncAll().catch(() => {}); }, RESYNC_DELAY_MS).unref?.();
    },

    // Снять все таймеры. Нужно тестам, чтобы процесс завершался: у ближайшего
    // события таймер закрытия может стоять на несколько суток вперёд и держать
    // цикл событий. В работе сервера не вызывается — там его держит HTTP-сервер.
    stop() {
      for (const m of [closeTimers, remindTimers, deleteTimers]) {
        for (const tmr of m.values()) clearTimeout(tmr);
        m.clear();
      }
    },

    // Частичное обновление настроек со страницы (кроме токена — он через setToken)
    updateSettings(body) {
      if (!body || typeof body !== 'object') return false;
      const before = viewKey();
      for (const k of ['guildId', 'pingRoleId', 'registerChannelId', 'registerRoleId', 'officerRoleId']) {
        if (typeof body[k] === 'string') cfg[k] = body[k].trim();
      }
      if (body.accessMode === 'open' || body.accessMode === 'closed') cfg.accessMode = body.accessMode;
      // Включить вход можно только когда есть чем: без секрета и приложения войти
      // нельзя, а отмечаться без входа при включённом флаге уже нельзя — сайт встал бы.
      if (typeof body.loginEnabled === 'boolean') {
        cfg.loginEnabled = body.loginEnabled && !!cfg.clientSecret && !!cfg.applicationId;
      }
      if (typeof body.lang === 'string' && LANGS.includes(body.lang)) cfg.lang = body.lang;
      if (typeof body.dmEnabled === 'boolean') cfg.dmEnabled = body.dmEnabled;
      if (body.remindBeforeMin !== undefined) {
        const n = Number(body.remindBeforeMin);
        if (Number.isFinite(n)) cfg.remindBeforeMin = Math.min(1440, Math.max(0, Math.round(n)));
      }
      if (body.routes && typeof body.routes === 'object' && !Array.isArray(body.routes)) {
        const routes = {};
        for (const [key, cell] of Object.entries(body.routes)) {
          // ключ клетки: `${день 0..6}:${prak|ranked|league}`
          if (!/^[0-6]:(prak|ranked|league)$/.test(key)) continue;
          // Не больше MAX_CHANNELS_PER_CELL каналов на клетку. Это страховка: тот же
          // предел продублирован в UI (components/DiscordSettings.tsx), и он там
          // объяснён офицеру. Если менять — менять в обоих местах, иначе панель молча
          // потеряет часть отмеченных галочек при сохранении.
          const ids = Array.isArray(cell?.discordChannelIds)
            ? cell.discordChannelIds.filter(x => typeof x === 'string' && /^\d{5,25}$/.test(x)).slice(0, MAX_CHANNELS_PER_CELL)
            : [];
          if (ids.length) routes[key] = { discordChannelIds: ids };
        }
        cfg.routes = routes;
      }
      saveConfig();
      afterViewChange(before);
      return true;
    },

    // Списки для страницы настроек — живьём из Discord, ничего не хардкодим
    async listGuilds() {
      const r = await dapi('GET', '/users/@me/guilds');
      if (!r.ok) return null;
      return (r.data || []).map(g => ({ id: g.id, name: g.name }));
    },

    async listChannels() {
      if (!cfg.guildId) return null;
      const r = await dapi('GET', `/guilds/${cfg.guildId}/channels`);
      if (!r.ok) return null;
      return (r.data || [])
        .filter(c => TEXT_CHANNEL_TYPES.has(c.type))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(c => ({ id: c.id, name: c.name, parentId: c.parent_id || '' }));
    },

    async listRoles() {
      if (!cfg.guildId) return null;
      const r = await dapi('GET', `/guilds/${cfg.guildId}/roles`);
      if (!r.ok) return null;
      return (r.data || [])
        .filter(role => role.name !== '@everyone')
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map(role => ({ id: role.id, name: role.name, color: role.color, managed: !!role.managed }));
    }
  };
}
