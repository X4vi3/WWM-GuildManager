// Точка /api/unavailable: пометка «недоступен» с настоящим сервером.
//
// Логику пересчёта проверяет away.test.mjs на чистых функциях. Здесь — то, что
// чистой функцией не проверишь: кому вообще можно писать, что попадает на диск и
// переживает ли это перезапуск.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, readState, sampleState, AUTH } from './helpers.mjs';

let S, http;

before(async () => {
  S = await startServer({ state: sampleState(6) });
  http = api(S.url);
});
after(async () => { await S?.stop(); });

const officer = { headers: { authorization: AUTH } };
const mark = { note: 'Улетел в Тайланд', until: '2099-08-24' };

test('без прав пометку не поставить: иначе кого угодно снимут с прака анонимно', async () => {
  const r = await http.post('/api/unavailable', { playerId: 'p0', unavailable: mark });
  assert.equal(r.status, 403);
  assert.equal(readState(S.dir).players[0].unavailable, undefined);
});

test('чужую пометку не поставить даже закрепив свой ник', async () => {
  await http.post('/api/presence/claim', { clientId: 'c1', playerId: 'p1' });
  const r = await http.post('/api/unavailable', { clientId: 'c1', playerId: 'p2', unavailable: mark });
  assert.equal(r.status, 403);
});

test('ГЛАВНОЕ: себе пометку ставит сам игрок, без пароля офицера', async () => {
  await http.post('/api/presence/claim', { clientId: 'c1', playerId: 'p1' });
  const r = await http.post('/api/unavailable', { clientId: 'c1', playerId: 'p1', unavailable: { note: 'Семейные дела' } });
  assert.equal(r.status, 200);

  const p1 = readState(S.dir).players.find(p => p.id === 'p1');
  assert.equal(p1.unavailable.note, 'Семейные дела');
  assert.equal(p1.unavailable.until, undefined, 'без даты — бессрочно');
  assert.ok(p1.unavailable.since, 'момент пометки записан');
});

test('ГЛАВНОЕ: пометка ставит «Не иду» и освобождает место в составе', async () => {
  const r = await http.post('/api/unavailable', { playerId: 'p0', unavailable: mark }, officer);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).changed, 1, 'затронуто одно событие');

  const s = readState(S.dir).sessions[0];
  assert.equal(s.signups.p0, 'out');
  assert.equal(s.assignments.some(a => a.playerId === 'p0'), false);
  assert.ok(s.assignments.length > 0, 'чужие места в составе на месте');
});

test('офицер снимает пометку, но заявки не откатываются', async () => {
  await http.post('/api/unavailable', { playerId: 'p3', unavailable: mark }, officer);
  const r = await http.post('/api/unavailable', { playerId: 'p3', unavailable: null }, officer);
  assert.equal(r.status, 200);

  const st = readState(S.dir);
  assert.equal(st.players.find(p => p.id === 'p3').unavailable, undefined);
  assert.equal(st.sessions[0].signups.p3, 'out', 'отказ остаётся — возвращается человек сам');
});

test('дата возвращения только днём: время потребовало бы пояса', async () => {
  for (const until of ['24.08.2099', '2099-08-24T10:00:00Z', 'завтра', '2099-8-4']) {
    const r = await http.post('/api/unavailable', { playerId: 'p4', unavailable: { until } }, officer);
    assert.equal(r.status, 400, `${until} должно отлетать`);
  }
});

test('несуществующий игрок — 404, а не тихая запись в пустоту', async () => {
  const r = await http.post('/api/unavailable', { playerId: 'нет-такого', unavailable: mark }, officer);
  assert.equal(r.status, 404);
});

test('мусор в теле не роняет сервер', async () => {
  for (const body of ['не json', {}, { playerId: '' }, { playerId: 'p5', unavailable: 'да' }]) {
    const r = await http.post('/api/unavailable', body, officer);
    assert.ok(r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
  }
});

test('длинную записку сервер режет, а не хранит целиком', async () => {
  await http.post('/api/unavailable', { playerId: 'p5', unavailable: { note: 'я'.repeat(5000) } }, officer);
  const p5 = readState(S.dir).players.find(p => p.id === 'p5');
  assert.equal(p5.unavailable.note.length, 200);
});
