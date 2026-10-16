// Контракт HTTP-API: доступ, проверка входных данных, сохранность состояния.
// Всё гоняется на настоящем сервере во временной папке.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, sampleState, readState, PASSWORD, AUTH } from './helpers.mjs';

let S, http;
test.before(async () => { S = await startServer({ state: sampleState() }); http = api(S.url); });
test.after(async () => { await S.stop(); });

// ---------------------------------------------------------------- чтение
test('GET /api/state отдаёт состояние без пароля (режим просмотра)', async () => {
  const r = await http.get('/api/state');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.players.length, 30);
  assert.equal(s.sessions.length, 1);
});

test('GET /api/state не кэшируется — иначе зритель видит устаревший состав', async () => {
  const r = await http.get('/api/state');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});

// ---------------------------------------------------------------- вход
test('POST /api/auth: верный пароль — 200, неверный — 401', async () => {
  assert.equal((await http.post('/api/auth', { password: PASSWORD })).status, 200);
  assert.equal((await http.post('/api/auth', { password: 'не тот' })).status, 401);
});

test('пустой пароль не считается попыткой перебора и не блокирует', async () => {
  for (let i = 0; i < 12; i++) {
    const r = await http.post('/api/auth', { password: '' });
    assert.equal(r.status, 401, 'пустой пароль всегда 401, но не 429');
  }
  // после этого верный пароль обязан пройти
  assert.equal((await http.post('/api/auth', { password: PASSWORD })).status, 200);
});

test('битый JSON в /api/auth не роняет сервер', async () => {
  const r = await http.post('/api/auth', '{это не json');
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- запись
test('PUT /api/state без пароля — 401, состояние не меняется', async () => {
  const before = readState(S.dir);
  const r = await http.put('/api/state', { players: [], sessions: [] });
  assert.equal(r.status, 401);
  assert.deepEqual(readState(S.dir), before, 'состояние не должно было измениться');
});

test('PUT /api/state с неверным паролем — 401', async () => {
  const r = await http.put('/api/state', { players: [], sessions: [] },
    { headers: { authorization: 'Bearer ' + Buffer.from('чужой', 'utf8').toString('base64') } });
  assert.equal(r.status, 401);
});

test('ключ в base64 принимается', async () => {
  const r = await http.put('/api/state', sampleState(3), { headers: { authorization: AUTH } });
  assert.equal(r.status, 200);
});

test('пароль с кириллицей нельзя послать заголовком как есть — ради этого и base64', async () => {
  // В значение HTTP-заголовка можно положить только байты 0..255. Проверяем, что это
  // действительно так: если бы клиент слал пароль сырым, офицер с русским паролем
  // выглядел бы вошедшим, но ничего не сохранял.
  await assert.rejects(
    () => http.put('/api/state', sampleState(2), { headers: { authorization: 'Bearer ' + PASSWORD } }),
    'заголовок с кириллицей обязан отвергаться ещё до отправки'
  );
});

test('сырой ASCII-пароль в заголовке тоже работает (старые клиенты)', async () => {
  const S2 = await startServer({ state: sampleState(2), password: 'plain-ascii-pass' });
  try {
    const h = api(S2.url);
    const r = await h.put('/api/state', sampleState(2), { headers: { authorization: 'Bearer plain-ascii-pass' } });
    assert.equal(r.status, 200, 'сырой пароль (совместимость)');
    const r2 = await h.put('/api/state', sampleState(2), {
      headers: { authorization: 'Bearer ' + Buffer.from('plain-ascii-pass').toString('base64') } });
    assert.equal(r2.status, 200, 'и base64 от него же');
  } finally { await S2.stop(); }
});

test('PUT /api/state отвергает неверную форму, а не пишет мусор на диск', async () => {
  const before = readState(S.dir);
  for (const bad of [
    { players: 'нет', sessions: [] },
    { players: [], sessions: {} },
    { sessions: [] },
    { players: [] },
    null,
    42
  ]) {
    const r = await http.put('/api/state', bad, { headers: { authorization: AUTH } });
    assert.equal(r.status, 400, 'форма ' + JSON.stringify(bad));
  }
  assert.deepEqual(readState(S.dir), before, 'ни одна кривая форма не должна была записаться');
});

test('битый JSON в PUT /api/state — 400, файл цел', async () => {
  const before = readState(S.dir);
  const r = await http.put('/api/state', '{"players":[', { headers: { authorization: AUTH } });
  assert.equal(r.status, 400);
  assert.deepEqual(readState(S.dir), before);
});

test('сохранение переживает юникод: эмодзи и кириллица не превращаются в ромбики', async () => {
  const st = sampleState(2);
  // Длинная строка с эмодзи — чтобы тело гарантированно резалось на чанки
  const note = ('Прак против 🐔 гильдии «Ветер» — сбор 21:00 ' + '🎋'.repeat(4000));
  st.sessions[0].event.note = note;
  st.players[0].name = 'Игрок 🐉 Ω ñ 中文';
  const r = await http.put('/api/state', st, { headers: { authorization: AUTH } });
  assert.equal(r.status, 200);
  const saved = readState(S.dir);
  assert.equal(saved.sessions[0].event.note, note, 'заметка должна доехать целой');
  assert.equal(saved.players[0].name, 'Игрок 🐉 Ω ñ 中文');
  assert.ok(!JSON.stringify(saved).includes('�'), 'в состоянии не должно быть U+FFFD');
});

test('PUT сохраняет только известные поля и не тащит лишнее с клиента', async () => {
  const st = sampleState(2);
  st.somethingEvil = { a: 1 };
  st.players[0].extra = 'ok';   // внутри игрока произвольные поля допустимы
  const r = await http.put('/api/state', st, { headers: { authorization: AUTH } });
  assert.equal(r.status, 200);
  const saved = readState(S.dir);
  assert.equal(saved.somethingEvil, undefined, 'посторонние поля верхнего уровня не сохраняются');
  assert.equal(saved.players[0].extra, 'ok', 'поля внутри игрока сохраняются как есть');
  assert.deepEqual(Object.keys(saved).sort(), ['activeSessionId', 'mapTemplates', 'players', 'sessions']);
});

test('mapTemplates не теряются и приводятся к массиву', async () => {
  const st = sampleState(2);
  st.mapTemplates = [{ id: 't1', name: 'Стратегия' }];
  await http.put('/api/state', st, { headers: { authorization: AUTH } });
  assert.equal(readState(S.dir).mapTemplates.length, 1, 'шаблоны карты обязаны сохраниться');

  st.mapTemplates = 'сломано';
  await http.put('/api/state', st, { headers: { authorization: AUTH } });
  assert.deepEqual(readState(S.dir).mapTemplates, [], 'кривое значение превращается в пустой массив, а не роняет запись');
});

// ---------------------------------------------------------------- смена пароля
test('смена пароля требует текущий, отвергает короткий и работает', async () => {
  const S2 = await startServer({ state: sampleState(2) });
  const h = api(S2.url);
  try {
    assert.equal((await h.post('/api/auth/change', { newPassword: 'новыйдлинный' })).status, 401, 'без Bearer');
    assert.equal((await h.post('/api/auth/change', { newPassword: 'абв' },
      { headers: { authorization: AUTH } })).status, 422, 'слишком короткий');

    const ok = await h.post('/api/auth/change', { newPassword: 'новый-длинный-пароль' },
      { headers: { authorization: AUTH } });
    assert.equal(ok.status, 200);

    assert.equal((await h.post('/api/auth', { password: 'новый-длинный-пароль' })).status, 200, 'новый пароль работает');
    assert.equal((await h.post('/api/auth', { password: PASSWORD })).status, 401, 'старый больше не подходит');

    // и переживает перезапуск (auth.json)
    await S2.stop();
  } finally {
    await S2.stop();
  }
});

// ---------------------------------------------------------------- присутствие
test('присутствие: claim/unclaim не требуют пароля, но и не ломают состояние', async () => {
  const before = readState(S.dir);
  const r1 = await http.post('/api/presence/claim', { clientId: 'c1', playerId: 'p0' });
  assert.ok(r1.status < 500, 'claim не должен падать: ' + r1.status);
  const r2 = await http.post('/api/presence/unclaim', { clientId: 'c1' });
  assert.ok(r2.status < 500, 'unclaim не должен падать: ' + r2.status);
  assert.deepEqual(readState(S.dir), before, 'присутствие не трогает состояние гильдии');
});

// ---------------------------------------------------------------- прочее
test('неизвестный путь не роняет сервер', async () => {
  for (const p of ['/api/нет-такого', '/api/state/../../etc/passwd', '/%2e%2e/%2e%2e/secret', '/api/']) {
    const r = await http.get(p);
    assert.ok(r.status < 500, `${p} -> ${r.status}`);
  }
});

test('лишний метод на известном пути не роняет сервер', async () => {
  for (const m of ['DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const r = await fetch(S.url + '/api/state', { method: m });
    assert.ok(r.status < 500, `${m} -> ${r.status}`);
  }
});

test('после всех издевательств процесс жив и состояние читается', async () => {
  assert.equal(S.child.exitCode, null, 'сервер не должен был завершиться');
  const r = await http.get('/api/state');
  assert.equal(r.status, 200);
  const crashes = S.readLog().match(/необработанная ошибка/g) || [];
  assert.equal(crashes.length, 0, 'в журнале не должно быть необработанных ошибок:\n' + S.log.join(''));
});
