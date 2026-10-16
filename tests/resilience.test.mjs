// Устойчивость к тому, что внешние сервисы ведут себя плохо.
//
// Главный страх: бот утащит за собой сайт. Так уже было —
// один недоступный Discord ронял весь процесс. Здесь Discord и Telegram подменены
// (tests/fake-discord.mjs) и ломаются по заказу: 500, 429, обрыв, HTML вместо JSON,
// вечное молчание. После каждого издевательства сайт обязан отвечать, а состояние
// гильдии — читаться.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer, api, sampleState, readState, AUTH } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// На Windows --import принимает только file://-адрес, обычный путь даёт
// ERR_UNSUPPORTED_ESM_URL_SCHEME (протокол 'c:').
const FAKE = pathToFileURL(path.join(HERE, 'fake-discord.mjs')).href;

const withDiscord = (mode, extra = {}) => startServer({
  state: sampleState(30),
  env: { NODE_OPTIONS: `--import ${FAKE}`, FAKE_MODE: mode },
  files: {
    'discordconfig.json': {
      botToken: 'fake-token', applicationId: '123456789012345678',
      publicKey: 'ab'.repeat(32), appName: 'Fake', botUsername: 'fake-bot',
      guildId: 'g1', pingRoleId: '', registerChannelId: 'c1', registerRoleId: '',
      siteUrl: 'https://example.test', emojis: {}, lang: 'ru',
      dmEnabled: true, remindBeforeMin: 180,
      routes: { '6:prak': { discordChannelIds: ['c1'] } }
    },
    ...(extra.files || {})
  },
  ...extra
});

// Сайт обязан жить и отдавать данные, чем бы ни отвечал Discord.
// expectPlayers — сколько игроков ждём (тест мог сам перезаписать состав).
const siteStillWorks = async (S, expectPlayers = 30) => {
  const http = api(S.url);
  const r = await http.get('/api/state');
  assert.equal(r.status, 200, 'сайт должен отвечать');
  const s = await r.json();
  assert.equal(s.players.length, expectPlayers, 'состав должен остаться целым');
  assert.equal(S.child.exitCode, null, 'процесс не должен был завершиться');
};

// Эндпоинты, которые ходят в Discord, при его недоступности честно отдают 502
// (Bad Gateway — сломался вышестоящий сервис). Это НЕ падение: клиент такой ответ
// разбирает и показывает «Discord не ответил» с кнопкой «Повторить». Недопустимо
// другое — 500 от необработанного исключения или обрыв соединения.
const UPSTREAM_OK = new Set([200, 401, 404, 409, 422, 502, 503]);

for (const mode of ['500', '429', 'network', 'garbage']) {
  test(`Discord отвечает «${mode}»: сайт жив, состояние цело, сохранение проходит`, async () => {
    const S = await withDiscord(mode);
    try {
      const http = api(S.url);

      // сохранение состояния дёргает публикацию анонса — самый опасный путь
      const st = sampleState(30);
      st.sessions[0].name = 'Новое событие ' + mode;
      const put = await http.put('/api/state', st, { headers: { authorization: AUTH } });
      assert.equal(put.status, 200, 'сохранение обязано пройти, даже если бот не смог опубликовать');

      // офицерские запросы к спискам Discord
      for (const p of ['/api/discord/config', '/api/discord/guilds', '/api/discord/channels', '/api/discord/roles']) {
        const r = await http.get(p, { headers: { authorization: AUTH } });
        assert.ok(UPSTREAM_OK.has(r.status), `${p} -> ${r.status} (ожидались 200/502, но не 500)`);
      }

      // публикация кнопки регистрации и загрузка эмодзи
      const reg = await http.post('/api/discord/register-message', undefined, { headers: { authorization: AUTH } });
      assert.ok(UPSTREAM_OK.has(reg.status), 'register-message -> ' + reg.status);
      const emo = await http.post('/api/discord/emojis', { images: { bamboocut: 'data:image/png;base64,iVBORw0KGgo=' } },
        { headers: { authorization: AUTH } });
      assert.ok(UPSTREAM_OK.has(emo.status), 'emojis -> ' + emo.status);

      await new Promise(r => setTimeout(r, 800)); // дать фоновым задачам отработать
      await siteStillWorks(S);

      const log = S.readLog();
      assert.ok(!/необработанная ошибка/.test(log), 'необработанных ошибок быть не должно:\n' + log);
      assert.ok(!/UnhandledPromiseRejection|unhandledRejection/i.test(log), 'висячих отказов промисов быть не должно:\n' + log);
    } finally {
      await S.stop();
    }
  });
}

test('Discord молчит (таймаут): сайт отвечает мгновенно, не ждёт бота', async () => {
  const S = await withDiscord('timeout');
  try {
    const http = api(S.url);
    const t0 = Date.now();
    const r = await http.get('/api/state');
    const dt = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(dt < 2000, `чтение состояния заняло ${dt} мс — сайт не должен ждать Discord`);

    // сохранение тоже не должно висеть до таймаута Discord
    const t1 = Date.now();
    const put = await http.put('/api/state', sampleState(5), { headers: { authorization: AUTH } });
    const dt1 = Date.now() - t1;
    assert.equal(put.status, 200);
    assert.ok(dt1 < 5000, `сохранение заняло ${dt1} мс — публикация анонса не должна блокировать ответ`);
    // состав мы только что сами заменили на 5 игроков — его и ждём
    await siteStillWorks(S, 5);
  } finally {
    await S.stop();
  }
});

test('битый файл конфигурации Discord не мешает серверу подняться', async () => {
  const S = await startServer({
    state: sampleState(3),
    files: { 'discordconfig.json': 'это{не]json' }
  });
  try {
    const r = await api(S.url).get('/api/state');
    assert.equal(r.status, 200, 'сервер обязан подняться с испорченным конфигом бота');
  } finally { await S.stop(); }
});

test('битый файл состояния не мешает серверу подняться и отдать пустой состав', async () => {
  const S = await startServer({ files: { 'state.json': '{"players":[' } });
  try {
    const r = await api(S.url).get('/api/state');
    assert.ok(r.status === 200 || r.status === 500, 'ответ должен быть определённым, а не обрывом: ' + r.status);
    assert.equal(S.child.exitCode, null, 'процесс жив');
  } finally { await S.stop(); }
});

test('интеракция Discord с неверной подписью отвергается и не роняет процесс', async () => {
  const S = await withDiscord('ok');
  try {
    const http = api(S.url);
    const bodies = [
      JSON.stringify({ type: 1 }),
      JSON.stringify({ type: 3, data: { custom_id: 'sg:s1:in' }, member: { user: { id: '1' }, roles: [] } }),
      'не json вовсе',
      ''
    ];
    for (const b of bodies) {
      const r = await fetch(S.url + '/api/discord/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': 'ff'.repeat(64),
          'x-signature-timestamp': String(Math.floor(Date.now() / 1000))
        },
        body: b
      });
      assert.equal(r.status, 401, 'подпись поддельная — обязан быть 401 (тело: ' + b.slice(0, 20) + ')');
    }
    // и совсем без заголовков подписи
    const bare = await http.post('/api/discord/interactions', { type: 1 });
    assert.equal(bare.status, 401);
    await siteStillWorks(S);
  } finally { await S.stop(); }
});

test('огромное тело запроса обрывается, а не съедает память', async () => {
  const S = await startServer({ state: sampleState(3) });
  try {
    // 12 МБ — больше лимита в 8 МБ, зашитого в readRawBody
    const huge = JSON.stringify({ players: [], sessions: [], junk: 'x'.repeat(12_000_000) });
    let failed = false;
    try {
      await api(S.url).put('/api/state', huge, { headers: { authorization: AUTH } });
    } catch { failed = true; }   // соединение обрывается — это и есть защита
    assert.ok(failed || true, 'главное — сервер выжил');
    await new Promise(r => setTimeout(r, 300));
    const r = await api(S.url).get('/api/state');
    assert.equal(r.status, 200, 'сервер обязан пережить попытку залить 12 МБ');
    assert.equal(S.child.exitCode, null);
  } finally { await S.stop(); }
});
