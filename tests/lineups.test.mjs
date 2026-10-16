// Архив расстановок на настоящем сервере.
//
// Смысл фичи целиком в одном: события у нас разбирают и УДАЛЯЮТ раз в неделю. Пока
// история жила внутри событий, память автозаполнения обнулялась каждую неделю и
// людей расставляло наугад. Значит проверять надо не «архив записался», а «архив
// пережил удаление события».

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, AUTH } from './helpers.mjs';
import { autofill } from '../server/autofill.mjs';

const players = [
  { id: 'p1', name: 'Kaito', role: 'DPS', weapons: [] },
  { id: 'p2', name: 'Мурзик', role: 'Tank', weapons: [] }
];

const event = () => ({
  id: 'evt-1', name: 'Прак', date: '2026-07-30',
  event: { type: 'prak', startsAt: new Date(Date.now() - 86400e3).toISOString() },
  signups: { p1: 'in', p2: 'in' },
  // тяжёлое, чему в архиве делать нечего
  mapDrawings: [{ id: 'd', type: 'path', color: '#fff', width: 3,
    points: Array.from({ length: 300 }, () => ({ x: 1.5, y: 2.5 })) }],
  mapPositions: { p1: { x: 10, y: 20 } },
  assignments: [
    { playerId: 'p1', side: 'defense', group: 2 },
    { playerId: 'p2', side: 'attack', group: 1 }
  ]
});

let S, http;
test.before(async () => { S = await startServer({ state: { players, sessions: [] } }); http = api(S.url); });
test.after(async () => { await S.stop(); });

const save = (sessions, extra = {}) => http.put('/api/state', { players, sessions, ...extra }, {
  headers: { authorization: AUTH }
});
const lineups = async () => (await http.get('/api/lineups')).json();

test('GET /api/lineups отвечает пустым списком, пока ничего не было', async () => {
  const r = await http.get('/api/lineups');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('сохранили событие — расстановка попала в архив, тяжёлое отброшено', async () => {
  await save([event()]);
  const arch = await lineups();
  assert.equal(arch.length, 1);
  assert.equal(arch[0].assignments.length, 2);
  assert.equal(arch[0].mapDrawings, undefined, 'рисунки — две трети веса события');
  assert.equal(arch[0].mapPositions, undefined);
  assert.equal(arch[0].signups, undefined);
  assert.equal(arch[0].event.type, 'prak', 'тип и время нужны для веса по возрасту');
});

test('ГЛАВНОЕ: событие удалили — архив цел и расстановка восстанавливается', async () => {
  await save([]);   // офицер вычистил прошедшее, как делает каждую неделю
  const st = await (await http.get('/api/state')).json();
  assert.equal(st.sessions.length, 0, 'событий в состоянии не осталось');

  const arch = await lineups();
  assert.equal(arch.length, 1, 'а история обязана остаться');

  const target = {
    id: 'T', name: 'Новый прак',
    event: { type: 'prak', startsAt: new Date(Date.now() + 86400e3).toISOString() },
    signups: { p1: 'in', p2: 'in' }, assignments: []
  };
  const res = autofill({ players, sessions: st.sessions, archive: arch, target });
  const at = (id) => { const a = res.assignments.find(x => x.playerId === id); return `${a.side}:${a.group}`; };
  assert.equal(at('p1'), 'defense:2', 'без архива тут была бы случайная пачка');
  assert.equal(at('p2'), 'attack:1');
});

test('клиент не может затереть архив, прислав своё поле', async () => {
  await save([], { lineups: [], history: [] });
  assert.equal((await lineups()).length, 1, 'архив собирается сервером, а не принимается от клиента');
});

test('тихое сохранение архив не рушит — операция только добавляет', async () => {
  // импорт бэкапа и откат идут silent; для привязок такая чистка была бы опасна,
  // здесь наоборот: старый бэкап ВЕРНЁТ историю, которой не было
  const older = {
    id: 'evt-0', name: 'Старый прак', date: '2026-07-01',
    event: { type: 'ranked', startsAt: new Date(Date.now() - 5 * 86400e3).toISOString() },
    assignments: [{ playerId: 'p1', side: 'attack', group: 3 }]
  };
  await save([older], { silent: true });
  const arch = await lineups();
  assert.equal(arch.length, 2, 'обе записи на месте: ' + arch.map(r => r.id).join(', '));
});

test('сервер не ругался в лог', () => {
  assert.doesNotMatch(S.readLog(), /\[archive\]/, 'архив не должен падать: ' + S.readLog());
});
