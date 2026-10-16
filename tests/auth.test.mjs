// Вход на сайт через Discord — на настоящем сервере, с поддельным Discord.
//
// Чинится тут одна дыра: сегодня заявку за человека может поставить и снять кто
// угодно, кто открыл ссылку, и узнать, кто это сделал, невозможно. Поэтому главные
// проверки здесь — не «вход работает», а «без входа больше НЕЛЬЗЯ» и «выключенный
// флаг ничего не меняет».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer, api, sampleState, AUTH } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = pathToFileURL(path.join(HERE, 'fake-discord.mjs')).href;

// Настроенная интеграция: бот подключён, вход включён, офицерская роль — r1.
const discordConfig = (extra = {}) => ({
  botToken: 'fake-token', applicationId: '123456789012345678', publicKey: 'ab'.repeat(32),
  appName: 'Fake App', botUsername: 'fake-bot',
  guildId: 'g1', registerChannelId: 'c1',
  clientSecret: 'sekret', officerRoleId: 'r1',
  loginEnabled: true, accessMode: 'open',
  routes: {}, emojis: {},
  ...extra
});

// Роли участников лежат в файле — тест меняет их на ходу, как офицер в Discord.
const rolesFile = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wwm-roles-')), 'roles.json');
  const set = (obj) => fs.writeFileSync(f, JSON.stringify(obj));
  set({});
  return { path: f, set };
};

// Файл, куда подделка пишет по строке на каждое обращение к Discord за ролями.
const callsFile = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wwm-calls-')), 'calls.log');
  fs.writeFileSync(f, '');
  return { path: f, count: () => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length };
};

const boot = async ({ config = discordConfig(), links = { u1: 'p0' }, roles, calls, state, ttlMs = 300 } = {}) => {
  const S = await startServer({
    state: state || sampleState(5),
    files: { 'discordconfig.json': config, 'discordlinks.json': links },
    env: {
      NODE_OPTIONS: `--import ${FAKE}`,
      FAKE_MODE: 'ok',
      FAKE_ROLES_FILE: roles?.path || '',
      FAKE_LOGIN_ID: 'u1',
      FAKE_CALLS_FILE: calls?.path || '',
      OFFICER_TTL_MS: String(ttlMs)   // в проде минута; тут не ждать же её всерьёз
    }
  });
  return { S, http: api(S.url) };
};

// Простейшая банка печенек: fetch их сам не хранит.
const jar = () => {
  const store = {};
  return {
    take(res) {
      for (const raw of (res.headers.getSetCookie?.() || [])) {
        const pair = raw.split(';')[0];
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (v === '') delete store[k]; else store[k] = v;
      }
      return res;
    },
    head() { return { cookie: Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ') }; },
    has(name) { return !!store[name]; },
    set(name, value) { store[name] = value; }
  };
};

/** Пройти вход целиком: уход на Discord и возврат с кодом. */
const login = async (S, c = jar()) => {
  const go = c.take(await fetch(S.url + '/api/auth/discord/login', { redirect: 'manual' }));
  const location = go.headers.get('location') || '';
  const state = new URL(location).searchParams.get('state') || '';
  const back = c.take(await fetch(
    `${S.url}/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: c.head() }
  ));
  return { c, location, state, back };
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- флаг выключен

test('ГЛАВНОЕ: выключенный флаг ничего не меняет — «это я» по-прежнему даёт заявку', async () => {
  const { S, http } = await boot({ config: discordConfig({ loginEnabled: false }) });
  try {
    const s = await (await http.get('/api/session')).json();
    assert.equal(s.loginEnabled, false);
    assert.equal(s.user, null);

    await http.post('/api/presence/claim', { clientId: 'c1', playerId: 'p0' });
    const r = await http.post('/api/signup', { clientId: 'c1', sessionId: 's1', playerId: 'p0', status: 'in' });
    assert.equal(r.status, 200, 'выкат не должен останавливать гильдию посреди недели');

    assert.equal((await http.get('/api/state')).status, 200, 'смотреть можно без всякого входа');
  } finally { await S.stop(); }
});

test('без client secret флаг включить нельзя — иначе сайт запрётся снаружи', async () => {
  const { S, http } = await boot({ config: discordConfig({ clientSecret: '', loginEnabled: true }) });
  try {
    const s = await (await http.get('/api/session')).json();
    assert.equal(s.loginEnabled, false, 'секрета нет — вход не считается настроенным');
    const st = await (await http.get('/api/discord/config', { headers: { authorization: AUTH } })).json();
    assert.equal(st.hasClientSecret, false);
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- флаг включён

test('включённый флаг закрывает анонимную заявку: «это я» больше не пропуск', async () => {
  const { S, http } = await boot();
  try {
    await http.post('/api/presence/claim', { clientId: 'c1', playerId: 'p0' });
    const r = await http.post('/api/signup', { clientId: 'c1', sessionId: 's1', playerId: 'p0', status: 'in' });
    assert.equal(r.status, 403, 'ровно эта дыра и чинится');
  } finally { await S.stop(); }
});

test('вход целиком: уход на Discord, возврат, печенька, своя заявка', async () => {
  const { S, http } = await boot();
  try {
    const { c, location, back } = await login(S);

    const u = new URL(location);
    assert.equal(u.host, 'discord.com');
    assert.equal(u.searchParams.get('scope'), 'identify', 'просим минимум — только «узнать, кто вы»');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.match(u.searchParams.get('redirect_uri') || '', /\/api\/auth\/discord\/callback$/);

    assert.equal(back.status, 302);
    assert.ok(c.has('wwm_session'), 'после возврата печенька обязана появиться');

    const s = await (await http.get('/api/session', { headers: c.head() })).json();
    assert.equal(s.user?.discordId, 'u1');
    assert.equal(s.user?.playerId, 'p0');
    assert.equal(s.user?.linked, true);

    const mine = await http.post('/api/signup',
      { sessionId: 's1', playerId: 'p0', status: 'in' }, { headers: c.head() });
    assert.equal(mine.status, 200, 'за себя — можно');
  } finally { await S.stop(); }
});

test('ГЛАВНОЕ: за чужого отметиться нельзя', async () => {
  const { S, http } = await boot();
  try {
    const { c } = await login(S);
    const alien = await http.post('/api/signup',
      { sessionId: 's1', playerId: 'p1', status: 'out' }, { headers: c.head() });
    assert.equal(alien.status, 403, 'отписать соседа с прака — то, ради чего всё затевалось');
  } finally { await S.stop(); }
});

test('подделанная печенька не пускает', async () => {
  const { S, http } = await boot();
  try {
    const bad = { cookie: 'wwm_session=' + Buffer.from(JSON.stringify({ did: 'u1', exp: Date.now() + 1e9 })).toString('base64url') + '.notarealsignature' };
    const r = await http.post('/api/signup', { sessionId: 's1', playerId: 'p0', status: 'in' }, { headers: bad });
    assert.equal(r.status, 403);
    const s = await (await http.get('/api/session', { headers: bad })).json();
    assert.equal(s.user, null);
  } finally { await S.stop(); }
});

test('чужой state на возврате не меняется на личность', async () => {
  const { S } = await boot();
  try {
    const c = jar();
    c.take(await fetch(S.url + '/api/auth/discord/login', { redirect: 'manual' }));
    // код принесли, а метка не та, что мы выдавали
    const back = await fetch(`${S.url}/api/auth/discord/callback?code=abc&state=чужое`, {
      redirect: 'manual', headers: c.head()
    });
    assert.equal(back.status, 302);
    assert.match(back.headers.get('location') || '', /login=state/);
    assert.ok(!(back.headers.getSetCookie?.() || []).some(x => /^wwm_session=[^;]+/.test(x)),
      'печеньку выдавать нельзя');
  } finally { await S.stop(); }
});

test('выход убирает печеньку', async () => {
  const { S, http } = await boot();
  try {
    const { c } = await login(S);
    c.take(await http.post('/api/auth/logout', {}, { headers: c.head() }));
    assert.equal(c.has('wwm_session'), false);
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- привязки

test('удалили игрока — привязка цела, но прав не даёт', async () => {
  const { S, http } = await boot();
  try {
    const { c } = await login(S);
    // офицер вычистил состав
    const st = sampleState(5);
    st.players = st.players.filter(p => p.id !== 'p0');
    await http.put('/api/state', st, { headers: { authorization: AUTH } });

    const s = await (await http.get('/api/session', { headers: c.head() })).json();
    assert.equal(s.user?.linked, false, 'доступ пропадает в ту же секунду');
    const r = await http.post('/api/signup', { sessionId: 's1', playerId: 'p0', status: 'in' }, { headers: c.head() });
    assert.equal(r.status, 403);

    const links = await (await http.get('/api/discord/links', { headers: { authorization: AUTH } })).json();
    const dead = links.links.find(l => l.discordId === 'u1');
    assert.equal(dead.alive, false);
    assert.ok(dead, 'сама запись обязана остаться — откат и импорт её оживят');
  } finally { await S.stop(); }
});

test('перепривязка чинит случай «удалил и завёл заново»', async () => {
  const { S, http } = await boot();
  try {
    const { c } = await login(S);
    const st = sampleState(5);
    st.players = st.players.filter(p => p.id !== 'p0');
    st.players.push({ id: 'p-new', name: '-Kaito', role: 'DPS', weapons: [] });
    await http.put('/api/state', st, { headers: { authorization: AUTH } });

    const r = await http.post('/api/discord/links/rebind', { discordId: 'u1', playerId: 'p-new' },
      { headers: { authorization: AUTH } });
    assert.equal(r.status, 200);

    const s = await (await http.get('/api/session', { headers: c.head() })).json();
    assert.equal(s.user?.playerId, 'p-new', 'человек снова свой, без повторной регистрации');
  } finally { await S.stop(); }
});

test('перепривязать на занятый ник нельзя', async () => {
  const { S, http } = await boot({ links: { u1: 'p0', u9: 'p1' } });
  try {
    const r = await http.post('/api/discord/links/rebind', { discordId: 'u1', playerId: 'p1' },
      { headers: { authorization: AUTH } });
    assert.equal(r.status, 400);
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- офицер

test('роль в Discord даёт права редактора без пароля', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const { S, http } = await boot({ roles });
  try {
    const { c } = await login(S);
    const s = await (await http.get('/api/session', { headers: c.head() })).json();
    assert.equal(s.user?.officer, true);
    const put = await http.put('/api/state', sampleState(5), { headers: c.head() });
    assert.equal(put.status, 200, 'редактировать можно, пароль не нужен');
  } finally { await S.stop(); }
});

test('без офицерской роли редактировать нельзя', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r9'] });
  const { S, http } = await boot({ roles });
  try {
    const { c } = await login(S);
    const put = await http.put('/api/state', sampleState(5), { headers: c.head() });
    assert.equal(put.status, 401);
  } finally { await S.stop(); }
});

test('ГЛАВНОЕ: сняли роль — права отпадают сами, без единого нажатия', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const { S, http } = await boot({ roles, ttlMs: 200 });
  try {
    const { c } = await login(S);
    assert.equal((await http.put('/api/state', sampleState(5), { headers: c.head() })).status, 200);

    roles.set({ u1: [] });                       // офицера сняли в Discord
    await sleep(900);                            // фоновая проверка (в проде — минута)

    const put = await http.put('/api/state', sampleState(5), { headers: c.head() });
    assert.equal(put.status, 401, 'кикнутый офицер больше не редактор');
  } finally { await S.stop(); }
});

test('кнопка «Обновить данные Discord» отбирает права немедленно', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const { S, http } = await boot({ roles, ttlMs: 600_000 });   // фоновая проверка заведомо не успеет
  try {
    const { c } = await login(S);
    assert.equal((await http.put('/api/state', sampleState(5), { headers: c.head() })).status, 200);

    roles.set({ u1: [] });
    const r = await http.post('/api/discord/refresh', {}, { headers: { authorization: AUTH } });
    assert.equal(r.status, 200);

    const put = await http.put('/api/state', sampleState(5), { headers: c.head() });
    assert.equal(put.status, 401, 'это и есть «прямо сейчас» вместо ожидания');
  } finally { await S.stop(); }
});

test('пароль работает всегда, даже когда Discord молчит', async () => {
  const roles = rolesFile();
  roles.set({ u1: 'fail' });          // Discord отвечает 500 на вопрос о ролях
  const { S, http } = await boot({ roles });
  try {
    const put = await http.put('/api/state', sampleState(5), { headers: { authorization: AUTH } });
    assert.equal(put.status, 200, 'запасная дверь от Discord не зависит');
  } finally { await S.stop(); }
});

test('Discord недоступен — гильдия продолжает отмечаться на прак', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const { S, http } = await boot({ roles, ttlMs: 200 });
  try {
    const { c } = await login(S);
    roles.set({ u1: 'fail' });
    await sleep(600);
    // заявка не спрашивает Discord вовсе: кто ты — в печеньке, какой у тебя ник — у нас на диске
    const r = await http.post('/api/signup', { sessionId: 's1', playerId: 'p0', status: 'in' }, { headers: c.head() });
    assert.equal(r.status, 200);
  } finally { await S.stop(); }
});

test('Discord молчит — прежний ответ про роль не теряется', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const { S, http } = await boot({ roles, ttlMs: 200 });
  try {
    const { c } = await login(S);
    roles.set({ u1: 'fail' });
    await sleep(600);
    const put = await http.put('/api/state', sampleState(5), { headers: c.head() });
    assert.equal(put.status, 200, 'чужой сбой не должен выбивать работающего офицера');
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- закрытый режим

test('Закрытый режим пускает только привязанных', async () => {
  const { S, http } = await boot();
  try {
    // включаем закрытый уже на живом сервере: helpers ждут ответа /api/state при старте
    const upd = await http.put('/api/discord/config', { accessMode: 'closed' },
      { headers: { authorization: AUTH } });
    assert.equal(upd.status, 200);

    assert.equal((await http.get('/api/state')).status, 403, 'посторонний внутрь не попадает');
    assert.equal((await http.get('/api/lineups')).status, 403);

    const { c } = await login(S);
    assert.equal((await http.get('/api/state', { headers: c.head() })).status, 200);

    assert.equal((await http.get('/api/state', { headers: { authorization: AUTH } })).status, 200,
      'пароль — запасная дверь и здесь');
  } finally { await S.stop(); }
});

test('в Закрытый режим не попасть просто «войдя через Discord» без привязки', async () => {
  const { S, http } = await boot({ links: {} });   // аккаунт ни к кому не привязан
  try {
    await http.put('/api/discord/config', { accessMode: 'closed' }, { headers: { authorization: AUTH } });
    const { c } = await login(S);
    const r = await http.get('/api/state', { headers: c.head() });
    assert.equal(r.status, 403, 'иначе ссылка в чужом чате пустила бы кого угодно');
  } finally { await S.stop(); }
});

test('непривязанному показывают, куда идти привязываться', async () => {
  const { S, http } = await boot({ links: {} });
  try {
    const { c } = await login(S);
    const s = await (await http.get('/api/session', { headers: c.head() })).json();
    assert.equal(s.user?.linked, false);
    assert.equal(s.registerUrl, 'https://discord.com/channels/g1/c1');
  } finally { await S.stop(); }
});

test('ГЛАВНОЕ: обычный игрок не стоит Discord ни одного лишнего запроса', async () => {
  const roles = rolesFile();
  roles.set({ u1: [] });                       // вошёл рядовой участник, не офицер
  const calls = callsFile();
  const { S, http } = await boot({ roles, calls, ttlMs: 200 });
  try {
    const { c } = await login(S);
    const after = calls.count();
    // Заявки и просмотр Discord не спрашивают вовсе
    for (let i = 0; i < 5; i++) {
      await http.post('/api/signup', { sessionId: 's1', playerId: 'p0', status: 'in' }, { headers: c.head() });
      await http.get('/api/state', { headers: c.head() });
    }
    await sleep(900);                          // четыре фоновых тика подряд
    assert.equal(calls.count(), after,
      `фоновая проверка не должна опрашивать не-офицеров: было ${after}, стало ${calls.count()}`);
  } finally { await S.stop(); }
});

test('офицера фоновая проверка, наоборот, опрашивает', async () => {
  const roles = rolesFile();
  roles.set({ u1: ['r1'] });
  const calls = callsFile();
  const { S } = await boot({ roles, calls, ttlMs: 200 });
  try {
    await login(S);
    const after = calls.count();
    await sleep(900);
    assert.ok(calls.count() > after, 'иначе снятая роль не отпала бы сама');
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- кто на сайте

/** Прочитать один кадр presence из SSE. Иначе список «на сайте» никак не достать. */
const presenceOf = async (S, cookie) => {
  const ac = new AbortController();
  const res = await fetch(S.url + '/api/events?clientId=cX', {
    headers: cookie, signal: ac.signal
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const i = buf.indexOf('event: presence');
      if (i >= 0) {
        const line = buf.slice(i).split('\n').find(l => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      }
    }
  } finally { clearTimeout(timer); ac.abort(); }
  return null;
};

test('ГЛАВНОЕ: вошедший через Discord виден остальным по нику, а не «Гусём»', async () => {
  // Личность в присутствии ставил только ручной claim, а при включённом входе
  // кнопки «это я» нет вовсе — поэтому привязанный показывался всем гостем.
  const { S } = await boot({ links: { u1: 'p3' } });
  try {
    const { c } = await login(S);
    const list = await presenceOf(S, c.head());
    assert.ok(list, 'presence не пришёл');
    const me = list.find(e => e.clientId === 'cX');
    assert.ok(me, 'меня нет в списке на сайте');
    assert.equal(me.playerId, 'p3', 'ник берётся из печеньки, а не из «это я»');
  } finally { await S.stop(); }
});

test('без входа человек остаётся гостем — и это правильно', async () => {
  const { S } = await boot();
  try {
    const list = await presenceOf(S, {});
    const me = list.find(e => e.clientId === 'cX');
    assert.equal(me.playerId, null);
    assert.match(me.guestName, /Гусь/);
  } finally { await S.stop(); }
});

test('удалили из состава — в присутствии снова гость, привязка не спасает', async () => {
  const { S } = await boot({ links: { u1: 'нет-такого-игрока' } });
  try {
    const { c } = await login(S);
    const list = await presenceOf(S, c.head());
    const me = list.find(e => e.clientId === 'cX');
    assert.equal(me.playerId, null, 'карточки нет — и представляться нечем');
  } finally { await S.stop(); }
});

test('при включённом входе «это я» больше не принимается: иначе можно назваться кем угодно', async () => {
  const { S, http } = await boot();
  try {
    const r = await http.post('/api/presence/claim', { clientId: 'c9', playerId: 'p0' });
    assert.equal(r.status, 403, 'личность даёт печенька, а не тело запроса');
    const u = await http.post('/api/presence/unclaim', { clientId: 'c9' });
    assert.equal(u.status, 403);
  } finally { await S.stop(); }
});

test('сервер не ругался в лог', async () => {
  const { S } = await boot();
  try {
    await login(S);
    assert.doesNotMatch(S.readLog(), /необработанная ошибка/, S.readLog());
  } finally { await S.stop(); }
});
