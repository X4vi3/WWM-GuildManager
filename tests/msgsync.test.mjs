// Подтягивание уже отправленных сообщений под текущий вид.
//
// Проверяем ровно то, ради чего фича делалась: после деплоя висящий анонс должен
// стать новым САМ, но при этом проход не должен слать ни одной лишней правки —
// иначе на каждом перезапуске мы будем без нужды дёргать Discord и упрёмся в лимиты.
//
// Discord подменён локально: считаем, какие запросы ушли бы в сеть.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiscord } from '../server/discord.mjs';
import { createLifecycle } from '../server/lifecycle.mjs';
import { fingerprint, worthResync, RESYNC_MAX_AGE_MS } from '../server/msgsync.mjs';

// ---- Чистая часть: отпечаток и срок давности ----

test('отпечаток: одинаковое тело — одинаковый, изменённое — другой', () => {
  const body = { embeds: [{ title: 'Прак', description: 'x' }], components: [] };
  assert.equal(fingerprint(body), fingerprint({ ...body }), 'один и тот же вид обязан давать один отпечаток');
  assert.notEqual(fingerprint(body), fingerprint({ ...body, components: [{ type: 1 }] }),
    'добавили кнопку — отпечаток должен измениться');
});

test('срок давности: свежее подтягиваем, прошлогоднее не трогаем', () => {
  const now = Date.now();
  assert.equal(worthResync(new Date(now + 86400e3).toISOString(), now), true, 'будущее');
  assert.equal(worthResync(new Date(now - 3600e3).toISOString(), now), true, 'час назад');
  assert.equal(worthResync(new Date(now - RESYNC_MAX_AGE_MS - 3600e3).toISOString(), now), false, 'позавчера');
  assert.equal(worthResync(undefined, now), true, 'без времени лучше обновить, чем оставить старым');
});

// ---- Сквозная часть: настоящий модуль Discord с подменённой сетью ----

const realFetch = globalThis.fetch;

// Записываем каждый обращённый к Discord вызов. messageStatus позволяет заставить
// Discord ответить «сообщения больше нет» (код 10008).
const spyFetch = (opts = {}) => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || input);
    if (!url.includes('discord.com')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url });
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (/\/channels\/[^/]+\/messages\/[^/]+$/.test(url) && method === 'PATCH') {
      if (opts.messageGone) return json({ message: 'Unknown Message', code: 10008 }, 404);
      return json({ id: 'm1' });
    }
    if (/\/channels\/[^/]+\/messages$/.test(url) && method === 'POST') return json({ id: 'm1' });
    return json({ ok: true });
  };
  return {
    calls,
    of: (method) => calls.filter(c => c.method === method),
    reset: () => { calls.length = 0; }
  };
};

// Маршруты сразу на все дни недели: какой именно день выпадет у события, для этой
// проверки неважно, а гадать про часовой пояс — лишний источник хрупкости.
const allDays = (type, channelIds) => {
  const routes = {};
  for (let d = 0; d < 7; d++) routes[`${d}:${type}`] = { discordChannelIds: channelIds };
  return routes;
};

const setup = ({ startsAt, cfg = {} } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwm-msgsync-'));
  const players = [{ id: 'p0', name: 'Kaito', role: 'DPS', weapons: [] }];
  const session = {
    id: 's1', name: 'Прак', date: '2026-01-01',
    event: { type: 'prak', startsAt: startsAt || new Date(Date.now() + 3 * 86400e3).toISOString() },
    signups: {}, assignments: []
  };
  const writeState = (sessions) =>
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ players, sessions }));
  writeState([session]);
  fs.writeFileSync(path.join(dir, 'discordconfig.json'), JSON.stringify({
    botToken: 'token', applicationId: '1', publicKey: 'ab'.repeat(32), guildId: 'g1',
    registerChannelId: 'c9', siteUrl: 'https://example.org', lang: 'ru',
    routes: allDays('prak', ['c1']),
    ...cfg
  }));
  const dc = createDiscord({ dataDir: dir, lifecycle: createLifecycle(dir), broadcastState: () => {} });
  return {
    dc, session, players, writeState,
    msgs: () => JSON.parse(fs.readFileSync(path.join(dir, 'discord_messages.json'), 'utf8')),
    config: () => JSON.parse(fs.readFileSync(path.join(dir, 'discordconfig.json'), 'utf8')),
    cleanup: () => {
      dc.stop();                    // иначе таймер закрытия события держит процесс
      globalThis.fetch = realFetch;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
};

// Опубликовать анонс так, как это делает сохранение состояния.
const publish = async (S) => S.dc.syncEvents({ players: S.players, sessions: [] },
  { players: S.players, sessions: [S.session] });

test('ГЛАВНОЕ: проход без изменений не шлёт в Discord ни одной правки', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await publish(S);
    assert.equal(spy.of('POST').length, 1, 'анонс должен был опубликоваться');
    spy.reset();

    await S.dc.resyncMessages();
    assert.deepEqual(spy.of('PATCH'), [], 'вид не менялся — в сеть идти незачем: ' + JSON.stringify(spy.calls));
  } finally { S.cleanup(); }
});

test('сменили язык бота — висящий анонс переписывается, а не остаётся русским', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await publish(S);
    spy.reset();

    // updateSettings сама зовёт подтягивание, но делает это не дожидаясь ответа
    S.dc.updateSettings({ lang: 'en' });
    await S.dc.resyncMessages();
    assert.equal(spy.of('PATCH').length, 1, 'ожидали ровно одну правку анонса: ' + JSON.stringify(spy.calls));
  } finally { S.cleanup(); }
});

test('отпечаток сохраняется рядом с сообщением', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await publish(S);
    const entry = S.msgs()['s1'][0];
    assert.ok(entry.fp, 'без отпечатка каждый проход слал бы правку заново');
    assert.equal(entry.channelId, 'c1');
  } finally { S.cleanup(); }
});

test('прошедшее давно не трогаем, даже когда вид поменялся', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await publish(S);
    // То же событие, но уже позавчерашнее: подтягивать его смысла нет, а лимиты
    // правок общие с живыми анонсами.
    const old = {
      ...S.session,
      event: { ...S.session.event, startsAt: new Date(Date.now() - RESYNC_MAX_AGE_MS - 3600e3).toISOString() }
    };
    S.writeState([old]);

    spy.reset();
    S.dc.updateSettings({ lang: 'en' });      // вид действительно изменился
    await S.dc.resyncMessages();
    assert.deepEqual(spy.of('PATCH'), [], 'старый анонс трогать не должны: ' + JSON.stringify(spy.calls));
  } finally { S.cleanup(); }
});

test('а свежее при той же смене — подтягивается', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await publish(S);
    spy.reset();
    S.dc.updateSettings({ lang: 'en' });
    await S.dc.resyncMessages();
    assert.equal(spy.of('PATCH').length, 1, 'ожидали правку живого анонса: ' + JSON.stringify(spy.calls));
  } finally { S.cleanup(); }
});

test('сообщение регистрации: второе нажатие правит существующее, а не вешает дубль', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    const first = await S.dc.postRegisterMessage();
    assert.equal(first.ok, true);
    assert.equal(spy.of('POST').length, 1, 'первый раз — публикация');
    assert.ok(S.config().registerMessage?.messageId, 'id обязан сохраниться, иначе обновлять нечего');

    spy.reset();
    const second = await S.dc.postRegisterMessage();
    assert.equal(second.ok, true);
    assert.equal(second.updated, true, 'второй раз — обновление');
    assert.deepEqual(spy.of('POST'), [], 'второго сообщения в канале быть не должно: ' + JSON.stringify(spy.calls));
    assert.equal(spy.of('PATCH').length, 1);
  } finally { S.cleanup(); }
});

test('сообщение регистрации подтягивается при проходе, если поменялся его текст', async () => {
  const spy = spyFetch();
  const S = setup();
  try {
    await S.dc.postRegisterMessage();
    spy.reset();
    await S.dc.resyncMessages();
    assert.deepEqual(spy.of('PATCH'), [], 'ничего не менялось — правки быть не должно');

    // Считать начинаем ДО смены настроек: она сама запускает проход, и правка
    // успевает уйти прямо в этом вызове.
    spy.reset();
    S.dc.updateSettings({ lang: 'en' });
    await S.dc.resyncMessages();
    assert.equal(spy.of('PATCH').length, 1, 'текст кнопки стал английским — сообщение надо обновить');
  } finally { S.cleanup(); }
});

test('удалённое из канала сообщение вычищается, а не опрашивается вечно', async () => {
  const spy = spyFetch({ messageGone: true });
  const S = setup();
  try {
    await publish(S);
    assert.ok(S.msgs()['s1'], 'запись о сообщении есть');

    S.dc.updateSettings({ lang: 'en' });   // заставляем попытаться править
    await S.dc.resyncMessages();
    assert.equal(S.msgs()['s1'], undefined, 'мёртвая запись должна исчезнуть');
  } finally { S.cleanup(); }
});
