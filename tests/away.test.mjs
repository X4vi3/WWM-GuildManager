// Недоступность игрока (отпуск, болезнь, жизненные обстоятельства).
//
// Проверять тут есть что: пометка правит чужие заявки и вынимает человека из уже
// собранных составов, причём необратимо — отмены нет. Ошибка была бы тихой:
// состав выглядит нормально и просто недосчитывается бойца.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAway, returnsAtMs, affectedSessions, applyAway, GUILD_TZ } from '../server/away.mjs';

const DAY = 86400e3;
const P = (id, extra = {}) => ({ id, name: id, role: 'DPS', weapons: [], ...extra });

// Событие в N днях от «сейчас»
const evt = (id, daysFromNow, extra = {}) => ({
  id, name: id, date: '2026-08-10',
  event: { type: 'prak', startsAt: new Date(NOW + daysFromNow * DAY).toISOString() },
  assignments: [],
  ...extra
});

// Шаблон расстановки — то же самое без поля event
const template = (id, extra = {}) => ({ id, name: id, date: '2026-08-10', assignments: [], ...extra });

const NOW = Date.parse('2026-08-10T12:00:00Z');

test('пояс дат — московский: «вернётся 24-го» это 24-е по Москве, а не по зрителю', () => {
  assert.equal(GUILD_TZ, 'Europe/Moscow');
  // 00:00 24 августа в Москве = 21:00 23 августа UTC
  assert.equal(returnsAtMs('2026-08-24'), Date.parse('2026-08-23T21:00:00Z'));
});

test('без даты недоступность бессрочна', () => {
  assert.equal(returnsAtMs(undefined), Infinity);
  assert.equal(isAway(P('a', { unavailable: { since: '2026-08-10T00:00:00Z' } }), NOW), true);
});

test('метка гаснет сама в день возвращения, хранить это не нужно', () => {
  const p = P('a', { unavailable: { since: '2026-08-10T00:00:00Z', until: '2026-08-24' } });
  assert.equal(isAway(p, Date.parse('2026-08-23T20:00:00Z')), true);  // ещё нет
  assert.equal(isAway(p, Date.parse('2026-08-23T21:00:00Z')), false); // полночь МСК — вернулся
  assert.equal(isAway(p, Date.parse('2026-08-30T00:00:00Z')), false);
});

test('игрок без пометки недоступным не считается', () => {
  assert.equal(isAway(P('a'), NOW), false);
});

test('ГЛАВНОЕ: событие в день возвращения не трогаем — человек уже играет', () => {
  const sessions = [
    evt('до', 5),    // 15 августа
    evt('после', 20) // 30 августа
  ];
  const ids = affectedSessions(sessions, { until: '2026-08-24' }, NOW).map((s) => s.id);
  assert.deepEqual(ids, ['до']);
});

test('прошедшие события не трогаем: там уже история, а не план', () => {
  const sessions = [evt('вчера', -1), evt('завтра', 1)];
  const ids = affectedSessions(sessions, { until: '2026-08-24' }, NOW).map((s) => s.id);
  assert.deepEqual(ids, ['завтра']);
});

test('ГЛАВНОЕ: шаблоны расстановки не трогаем — их собирают месяцами', () => {
  const sessions = [template('Стандарт 30'), evt('прак', 2)];
  const ids = affectedSessions(sessions, { until: '2026-08-24' }, NOW).map((s) => s.id);
  assert.deepEqual(ids, ['прак']);
});

test('без startsAt событие не трогаем: не знаем даже, прошло оно или нет', () => {
  const sessions = [{ id: 'старое', name: 'старое', date: '2026-08-01', event: { type: 'prak' }, assignments: [] }];
  assert.deepEqual(affectedSessions(sessions, {}, NOW), []);
});

test('бессрочная пометка достаёт до всех будущих событий', () => {
  const sessions = [evt('a', 1), evt('b', 400)];
  const ids = affectedSessions(sessions, {}, NOW).map((s) => s.id);
  assert.deepEqual(ids, ['a', 'b']);
});

test('ГЛАВНОЕ: пометка ставит «Не иду» и освобождает место в группе', () => {
  const players = [P('kolya'), P('vasya')];
  const sessions = [evt('прак', 2, {
    signups: { kolya: 'in', vasya: 'in' },
    assignments: [
      { playerId: 'kolya', side: 'attack', group: 2, subRoles: ['boss'], bossTime: 15 },
      { playerId: 'vasya', side: 'attack', group: 2 }
    ]
  })];

  const res = applyAway({ players, sessions }, 'kolya', { note: 'Тайланд', until: '2026-08-24' }, NOW);

  assert.equal(res.sessions[0].signups.kolya, 'out');
  assert.equal(res.sessions[0].signups.vasya, 'in', 'чужую заявку не трогаем');
  assert.deepEqual(res.sessions[0].assignments.map((a) => a.playerId), ['vasya']);
  assert.deepEqual(res.changed, ['прак']);

  const kolya = res.players.find((p) => p.id === 'kolya');
  assert.equal(kolya.unavailable.note, 'Тайланд');
  assert.equal(kolya.unavailable.until, '2026-08-24');
  assert.equal(kolya.unavailable.since, new Date(NOW).toISOString());
});

test('состояние не мутируется — иначе React не увидит изменение', () => {
  const players = [P('kolya')];
  const sessions = [evt('прак', 2, { signups: { kolya: 'in' }, assignments: [{ playerId: 'kolya', side: 'attack', group: 1 }] })];
  applyAway({ players, sessions }, 'kolya', { until: '2026-08-24' }, NOW);
  assert.equal(sessions[0].signups.kolya, 'in');
  assert.equal(sessions[0].assignments.length, 1);
  assert.equal(players[0].unavailable, undefined);
});

test('снятие пометки ничего не откатывает: «не иду» остаются', () => {
  const players = [P('kolya', { unavailable: { since: '2026-08-10T00:00:00Z', until: '2026-08-24' } })];
  const sessions = [evt('прак', 2, { signups: { kolya: 'out' }, assignments: [] })];

  const res = applyAway({ players, sessions }, 'kolya', null, NOW);

  assert.equal(res.players[0].unavailable, undefined);
  assert.equal(res.sessions[0].signups.kolya, 'out');
  assert.deepEqual(res.changed, []);
});

test('неизвестный игрок ничего не ломает', () => {
  const players = [P('kolya')];
  const sessions = [evt('прак', 2, { signups: { kolya: 'in' } })];
  const res = applyAway({ players, sessions }, 'нет-такого', { until: '2026-08-24' }, NOW);
  assert.equal(res.sessions[0].signups.kolya, 'in');
  assert.deepEqual(res.changed, []);
});

test('пустая записка не создаёт пустое поле', () => {
  const res = applyAway({ players: [P('a')], sessions: [] }, 'a', { note: '', until: '' }, NOW);
  assert.deepEqual(res.players[0].unavailable, { since: new Date(NOW).toISOString() });
});
