// Галерея записей ГВГ на настоящем сервере, с поддельным YouTube.
//
// Главное здесь — не «сетка рисуется», а два свойства, которые молча ломаются:
// список записей «по ссылке» не должен уходить постороннему, и восемьдесят
// открытых вкладок не должны стоить восьмидесяти обращений к Google.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer, api, sampleState, AUTH } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = pathToFileURL(path.join(HERE, 'fake-discord.mjs')).href;

const discordConfig = () => ({
  botToken: 'fake-token', applicationId: '123456789012345678', publicKey: 'ab'.repeat(32),
  appName: 'Fake App', botUsername: 'fake-bot',
  guildId: 'g1', registerChannelId: 'c1',
  clientSecret: 'sekret', officerRoleId: 'r1',
  loginEnabled: true, accessMode: 'open',
  routes: {}, emojis: {}
});

const ytConfig = () => ({
  clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok'
});

// u1 привязан к p1 — в составе это «Игрок1», он же имя его плейлиста.
const boot = async ({ links = { u1: 'p1' }, yt = ytConfig() } = {}) => {
  const files = { 'discordconfig.json': discordConfig(), 'discordlinks.json': links };
  if (yt) files['ytconfig.json'] = yt;
  const S = await startServer({
    state: sampleState(5),
    files,
    env: { NODE_OPTIONS: `--import ${FAKE}`, FAKE_MODE: 'ok', FAKE_LOGIN_ID: 'u1' }
  });
  return { S, http: api(S.url) };
};

const jar = () => {
  const store = {};
  return {
    take(res) {
      for (const raw of (res.headers.getSetCookie?.() || [])) {
        const pair = raw.split(';')[0];
        const i = pair.indexOf('=');
        const v = pair.slice(i + 1).trim();
        if (v === '') delete store[pair.slice(0, i).trim()]; else store[pair.slice(0, i).trim()] = v;
      }
      return res;
    },
    head() { return { cookie: Object.entries(store).map(([k, v]) => `${k}=${v}`).join('; ') }; }
  };
};

const login = async (S) => {
  const c = jar();
  const go = c.take(await fetch(S.url + '/api/auth/discord/login', { redirect: 'manual' }));
  const state = new URL(go.headers.get('location') || '').searchParams.get('state') || '';
  c.take(await fetch(`${S.url}/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: c.head() }));
  return c;
};

// ---------------------------------------------------------------- доступ

test('ГЛАВНОЕ: постороннему список не отдаётся — «по ссылке» перестало бы что-то значить', async () => {
  const { S } = await boot();
  try {
    const r = await fetch(S.url + '/api/yt/gallery');
    assert.equal(r.status, 403, 'без привязки к составу записей не видно');
  } finally { await S.stop(); }
});

test('привязанный участник видит записи с разобранными полями', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    const r = await fetch(S.url + '/api/yt/gallery', { headers: c.head() });
    assert.equal(r.status, 200);
    const g = await r.json();

    assert.equal(g.configured, true);
    assert.equal(g.me, 'Игрок1', 'ник берётся с сервера из печеньки, а не из запроса');
    assert.equal(g.videos.length, 6, 'семь в списке загрузок, но одно уже удалено');

    const first = g.videos.find(v => v.id === 'vid0');
    assert.equal(first.title, 'Игрок1 [2026-08-04] vs Enemy');
    assert.ok(first.thumb.includes('vid0'), 'превью берём из ответа API, а не гадаем адрес');

    // Неразмеченный ролик из списка не выбрасывается: на канале такие есть,
    // и спрятать их значило бы «часть записей просто не видно».
    assert.ok(g.videos.some(v => v.title === 'просто ролик без разметки'));
  } finally { await S.stop(); }
});

test('ГЛАВНОЕ: удалённая запись в галерею не попадает', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    const g = await (await fetch(S.url + '/api/yt/gallery', { headers: c.head() })).json();
    // Список загрузок YouTube держит удалённое ещё какое-то время, поэтому
    // заголовки берём не из него, а сверкой через videos.list.
    assert.ok(!g.videos.some(v => v.id === 'vid3'), 'её отдал список загрузок, но её больше нет');
    assert.ok(g.videos.some(v => v.id === 'vid4'), 'соседние при этом на месте');
  } finally { await S.stop(); }
});

test('возрастное ограничение приезжает признаком: иначе на странице чёрный прямоугольник', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    const g = await (await fetch(S.url + '/api/yt/gallery', { headers: c.head() })).json();
    const aged = g.videos.find(v => v.id === 'vid5');
    assert.equal(aged.blocked, 'age');
    assert.equal(g.videos.find(v => v.id === 'vid0').blocked, '', 'обычные играются у нас');
    assert.equal(aged.seconds, 424, 'длительность нужна плитке');
  } finally { await S.stop(); }
});

test('плейлисты игроков приходят с видимостью — иначе «кто открыт всем» негде показать', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    const g = await (await fetch(S.url + '/api/yt/gallery', { headers: c.head() })).json();
    const mine = g.playlists.find(p => p.title === 'Игрок1');
    const other = g.playlists.find(p => p.title === 'Игрок2');
    assert.equal(mine.privacy, 'unlisted');
    assert.equal(other.privacy, 'public');
    assert.equal(other.count, 3);
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- кэш

test('второй запрос берётся из кэша: восемьдесят вкладок — одно обращение к Google', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    const a = await (await fetch(S.url + '/api/yt/gallery', { headers: c.head() })).json();
    const b = await (await fetch(S.url + '/api/yt/gallery', { headers: c.head() })).json();
    assert.equal(a.cached, false, 'первый собирает');
    assert.equal(b.cached, true, 'второй уже нет');
  } finally { await S.stop(); }
});

test('сбросить кэш может офицер, обычный участник — нет', async () => {
  const { S } = await boot();
  try {
    const c = await login(S);
    await fetch(S.url + '/api/yt/gallery', { headers: c.head() });

    const plain = await (await fetch(S.url + '/api/yt/gallery?force=1', { headers: c.head() })).json();
    assert.equal(plain.cached, true, 'кнопки обновления у обычного участника нет — и просьбу игнорируем');

    const officer = await (await fetch(S.url + '/api/yt/gallery?force=1', {
      headers: { ...c.head(), authorization: AUTH }
    })).json();
    assert.equal(officer.cached, false, 'офицер перечитывает канал');
  } finally { await S.stop(); }
});

// ---------------------------------------------------------------- канал не подключён

test('канал не подключён — пустая галерея, а не ошибка', async () => {
  const { S } = await boot({ yt: null });
  try {
    const c = await login(S);
    const r = await fetch(S.url + '/api/yt/gallery', { headers: c.head() });
    assert.equal(r.status, 200);
    const g = await r.json();
    assert.equal(g.configured, false);
    assert.deepEqual(g.videos, []);
  } finally { await S.stop(); }
});
