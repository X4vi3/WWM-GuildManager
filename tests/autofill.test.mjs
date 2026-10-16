// Автозаполнение состава по истории.
//
// Проверять тут есть что: тридцать человек по шести пачкам глазом не пересчитаешь,
// поэтому ошибка была бы тихой — состав выглядит правдоподобно и просто неверен.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autofill, buildHistory, preferences, extrasFor, suggestLanes,
  candidatesFor, sessionWeight, PER_GROUP, MAX_PLAYERS,
  archiveSessions, mergeArchive
} from '../server/autofill.mjs';

const DAY = 86400e3;
const P = (id, role = 'DPS') => ({ id, name: id, role, weapons: [] });

// Прошедшее событие с расстановкой: [id, сторона, группа, доп-поля]
const past = (id, daysAgo, rows) => ({
  id, name: id, date: '2026-01-01',
  event: { type: 'prak', startsAt: new Date(Date.now() - daysAgo * DAY).toISOString() },
  assignments: rows.map(([playerId, side, group, extra]) => ({ playerId, side, group, ...(extra || {}) }))
});

const template = (id, rows, groupLanes) => ({
  id, name: id, date: '2026-01-01',
  assignments: rows.map(([playerId, side, group]) => ({ playerId, side, group })),
  ...(groupLanes ? { groupLanes } : {})
});

// Событие, которое заполняем: все перечисленные сказали «иду»
const target = (goingIds, assignments = [], extra = {}) => ({
  id: 'T', name: 'Событие', date: '2026-01-01',
  event: { type: 'prak', startsAt: new Date(Date.now() + 2 * DAY).toISOString() },
  signups: Object.fromEntries(goingIds.map((id) => [id, 'in'])),
  assignments, ...extra
});

const slotOf = (res, id) => {
  const a = res.assignments.find((x) => x.playerId === id);
  return a ? `${a.side}:${a.group}` : null;
};

test('ГЛАВНОЕ: кто всегда стоит в Дефе-2, туда и попадает', () => {
  const players = [P('a'), P('b')];
  const sessions = [0, 7, 14].map((d, i) => past('s' + i, d, [['a', 'defense', 2], ['b', 'attack', 1]]));
  const res = autofill({ players, sessions, target: target(['a', 'b']) });
  assert.equal(slotOf(res, 'a'), 'defense:2');
  assert.equal(slotOf(res, 'b'), 'attack:1');
});

test('свежее перевешивает старое: человек переехал — едет по новому месту', () => {
  const players = [P('x')];
  const sessions = [
    ...[90, 97, 104, 111, 118].map((d, i) => past('old' + i, d, [['x', 'attack', 1]])),
    ...[2, 9].map((d, i) => past('new' + i, d, [['x', 'defense', 3]]))
  ];
  const res = autofill({ players, sessions, target: target(['x']) });
  assert.equal(slotOf(res, 'x'), 'defense:3', 'два свежих боя должны перевесить пять старых');
});

test('пропущенная неделя не выбрасывает из истории', () => {
  // У «а» наблюдений за последние три недели нет вовсе — он не играл.
  const players = [P('a')];
  const sessions = [24, 31, 38, 45].map((d, i) => past('s' + i, d, [['a', 'defense', 2]]));
  const res = autofill({ players, sessions, target: target(['a']) });
  assert.equal(slotOf(res, 'a'), 'defense:2', 'вес считается по возрасту, а не «последние N событий»');
});

test('расставляем только тех, кто сказал «иду»', () => {
  const players = [P('a'), P('b'), P('c')];
  const sessions = [past('s', 3, [['a', 'attack', 1], ['b', 'attack', 1], ['c', 'attack', 1]])];
  const t = target(['a']);
  t.signups.b = 'out';
  t.signups.c = 'maybe';
  const res = autofill({ players, sessions, target: t });
  assert.equal(res.assignments.length, 1, 'в составе должен быть только «а»: ' + JSON.stringify(res.assignments));
  assert.equal(res.assignments[0].playerId, 'a');
});

test('уже расставленных не трогаем — кнопка дозаполняет, а не переписывает', () => {
  const players = [P('a'), P('b')];
  const sessions = [past('s', 3, [['a', 'defense', 2], ['b', 'defense', 2]])];
  // офицер руками поставил «а» в атаку — там он и обязан остаться
  const t = target(['a', 'b'], [{ playerId: 'a', side: 'attack', group: 3 }]);
  const res = autofill({ players, sessions, target: t });
  assert.equal(slotOf(res, 'a'), 'attack:3', 'решение офицера важнее истории');
  assert.equal(slotOf(res, 'b'), 'defense:2');
});

test('вместимость соблюдается: пятеро в пачке, тридцать всего', () => {
  const players = Array.from({ length: 40 }, (_, i) => P('p' + i));
  // все сорок «всегда» в одной пачке — крайний случай для разбора конфликтов
  const sessions = [past('s', 2, players.map((p) => [p.id, 'attack', 1]))];
  const res = autofill({ players, sessions, target: target(players.map((p) => p.id)) });
  assert.equal(res.assignments.length, MAX_PLAYERS, 'больше тридцати в состав не влезает');
  for (const side of ['attack', 'defense']) {
    for (const g of [1, 2, 3]) {
      const n = res.assignments.filter((a) => a.side === side && a.group === g).length;
      assert.equal(n, PER_GROUP, `в ${side}:${g} должно быть ровно ${PER_GROUP}, а не ${n}`);
    }
  }
});

test('конфликт: семеро «всегда в Атаке-1» — пятеро остаются, двое едут дальше', () => {
  const players = Array.from({ length: 7 }, (_, i) => P('p' + i));
  const sessions = [
    // у первых пяти привычка выражена ярче: они там были много раз
    ...[2, 9, 16, 23].map((d, i) => past('many' + i, d, players.slice(0, 5).map((p) => [p.id, 'attack', 1]))),
    // а двое последних заглянули туда однажды, зато бывали и в дефе
    past('few', 30, [['p5', 'attack', 1], ['p6', 'attack', 1]]),
    past('def', 20, [['p5', 'defense', 1], ['p6', 'defense', 1]])
  ];
  const res = autofill({ players, sessions, target: target(players.map((p) => p.id)) });
  const inA1 = res.assignments.filter((a) => a.side === 'attack' && a.group === 1).map((a) => a.playerId);
  assert.equal(inA1.length, PER_GROUP);
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) {
    assert.ok(inA1.includes(id), `${id} ходит туда постоянно и обязан остаться: ` + inA1.join(', '));
  }
});

test('перекос ролей чинится: пачке из одних ДД достаётся танк и хил', () => {
  const players = [
    ...Array.from({ length: 5 }, (_, i) => P('d' + i, 'DPS')),
    P('t1', 'Tank'), P('t2', 'Tank'), P('h1', 'Healer'), P('h2', 'Healer'), P('d9', 'DPS')
  ];
  const sessions = [1, 8, 15].map((d, i) => past('s' + i, d, [
    ...Array.from({ length: 5 }, (_, k) => ['d' + k, 'attack', 1]),
    ['t1', 'attack', 2], ['t2', 'attack', 2], ['h1', 'attack', 2], ['h2', 'attack', 2], ['d9', 'attack', 2]
  ]));
  const res = autofill({ players, sessions, target: target(players.map((p) => p.id)) });
  const roleIn = (side, group, role) => res.assignments
    .filter((a) => a.side === side && a.group === group)
    .filter((a) => players.find((p) => p.id === a.playerId).role === role).length;

  assert.ok(roleIn('attack', 1, 'Tank') >= 1, 'в первой пачке обязан появиться танк');
  assert.ok(roleIn('attack', 1, 'Healer') >= 1, 'и хил');
  assert.ok(roleIn('attack', 2, 'Tank') >= 1, 'но и у донора танк остаться должен');
  assert.ok(roleIn('attack', 2, 'Healer') >= 1, 'и хил тоже');
});

test('чинить нечем — не выдумываем: одного танка на всю гильдию не размножаем', () => {
  const players = [P('t', 'Tank'), ...Array.from({ length: 9 }, (_, i) => P('d' + i, 'DPS'))];
  const sessions = [past('s', 2, players.map((p, i) => [p.id, 'attack', i < 5 ? 1 : 2]))];
  const res = autofill({ players, sessions, target: target(players.map((p) => p.id)) });
  assert.equal(res.assignments.length, 10, 'все десять должны быть расставлены');
  const tanks = res.assignments.filter((a) => a.playerId === 't').length;
  assert.equal(tanks, 1, 'танк один и остаётся одним');
});

test('устойчивая привычка в лесу переносится, разовая — нет', () => {
  // Лес и босс живут в плане по таймингам, а не в доп-ролях, поэтому и проверяем план.
  // Старые составы (junglePosition на расстановке) при этом остаются валидной историей:
  // readPlan разворачивает их в «этот лагерь на всех шести таймингах».
  const players = [P('j'), P('r')];
  const sessions = [1, 8, 15, 22].map((d, i) => past('s' + i, d, [
    ['j', 'defense', 1, { subRoles: ['jungle'], junglePosition: 'top_near' }],
    // «r» был в лесу один раз из четырёх
    ['r', 'defense', 1, i === 0 ? { subRoles: ['jungle'], junglePosition: 'bot_far' } : {}]
  ]));
  const res = autofill({ players, sessions, target: target(['j', 'r']) });
  for (const tm of ['start', '25', '20', '15', '10', '5']) {
    assert.deepEqual(
      res.timings[`defense:${tm}:top_near`]?.players, ['j'],
      `постоянный лесник обязан приехать лесником (${tm})`
    );
    assert.equal(
      res.timings[`defense:${tm}:bot_far`], undefined,
      'разовый выход в лес привычкой не является'
    );
  }
});

test('доп-роль привязана к месту: тавер не уезжает в другую сторону', () => {
  const players = [P('w')];
  const sessions = [1, 8, 15].map((d, i) => past('s' + i, d, [['w', 'defense', 1, { subRoles: ['tower'] }]]));
  const h = buildHistory(sessions);
  assert.deepEqual(extrasFor(h, 'w', 'defense:1').subRoles, ['tower']);
  assert.deepEqual(extrasFor(h, 'w', 'attack:1'), {}, 'в атаке тавера не бывает — тащить его туда нельзя');
});

test('шаблон не стареет, событие стареет', () => {
  const now = Date.now();
  assert.equal(sessionWeight(template('t', []), now), 1, 'шаблон — действующий эталон');
  const old = past('s', 28, []);
  assert.ok(Math.abs(sessionWeight(old, now) - 0.5) < 0.01, 'через 28 дней вес вдвое меньше');
});

test('линии групп предлагаются, но уже выбранные не переигрываются', () => {
  const sessions = [
    template('t1', [['a', 'attack', 1]], { 'attack:1': 'top', 'attack:2': 'mid' }),
    template('t2', [['a', 'attack', 1]], { 'attack:1': 'top', 'attack:2': 'bot' })
  ];
  const h = buildHistory(sessions);
  const lanes = suggestLanes(h, { 'attack:2': 'mid' });
  assert.equal(lanes['attack:1'], 'top');
  assert.equal(lanes['attack:2'], undefined, 'офицер выбрал сам — не трогаем');
});

test('у шаблона заявок нет — берём весь состав', () => {
  const players = [P('a'), P('b')];
  assert.equal(candidatesFor(players, { id: 'x', assignments: [] }).length, 2);
  assert.equal(candidatesFor(players, target(['a'])).length, 1);
});

test('пустая история никого не роняет и всё равно заполняет состав', () => {
  const players = Array.from({ length: 12 }, (_, i) => P('p' + i, i === 0 ? 'Tank' : i === 1 ? 'Healer' : 'DPS'));
  const res = autofill({ players, sessions: [], target: target(players.map((p) => p.id)) });
  assert.equal(res.assignments.length, 12, 'без истории расставляем как есть, никого не теряя');
  assert.equal(preferences(buildHistory([]), 'p0').length, 0);
});

test('объяснение расстановки годится для подсказки под именем', () => {
  const players = [P('a')];
  const sessions = [1, 8, 15].map((d, i) => past('s' + i, d, [['a', 'defense', 2]]));
  const res = autofill({ players, sessions, target: target(['a']) });
  const why = res.reasons['a'];
  assert.equal(why.hits, 3, 'три из трёх');
  assert.equal(why.total, 3);
  assert.equal(why.side, 'defense');
  assert.equal(why.group, 2);
});

// ---- Архив: расстановка должна пережить удаление события ----
// Праки, ранкед и лигу разбирают и удаляют раз в неделю. Пока история жила внутри
// событий, это обнуляло память начисто и автозаполнение расставляло людей наугад.

test('ГЛАВНОЕ: события удалили — расстановка всё равно помнится', () => {
  const players = [P('a'), P('b')];
  const week = [1, 3, 5].map((d, i) => past('w' + i, d, [['a', 'defense', 2], ['b', 'attack', 3]]));
  const archive = archiveSessions(week, []);

  // неделя прошла, офицер вычистил все три события — в состоянии не осталось ничего
  const res = autofill({ players, sessions: [], archive, target: target(['a', 'b']) });
  assert.equal(slotOf(res, 'a'), 'defense:2', 'без архива тут была бы случайная пачка');
  assert.equal(slotOf(res, 'b'), 'attack:3');
});

test('архив только добавляет: старые записи не пропадают от новых сохранений', () => {
  const first = archiveSessions([past('s1', 5, [['a', 'defense', 2]])], []);
  const second = archiveSessions([past('s2', 1, [['a', 'attack', 1]])], first);
  assert.equal(second.length, 2, 'обе записи обязаны остаться: ' + JSON.stringify(second.map(r => r.id)));
});

test('свежая версия события перезаписывает свою же строку, а не плодит вторую', () => {
  const before = archiveSessions([past('s1', 2, [['a', 'defense', 2]])], []);
  const after = archiveSessions([past('s1', 2, [['a', 'attack', 1]])], before);
  assert.equal(after.length, 1);
  assert.equal(after[0].assignments[0].side, 'attack', 'должна остаться последняя расстановка');
});

test('живое событие важнее архивной копии и не считается дважды', () => {
  const players = [P('a')];
  const live = past('s1', 1, [['a', 'attack', 1]]);
  const stale = archiveSessions([past('s1', 1, [['a', 'defense', 3]])], []);
  const merged = mergeArchive([live], stale);
  assert.equal(merged.length, 1, 'одна и та же сессия не должна попасть в историю дважды');
  assert.equal(merged[0].assignments[0].side, 'attack', 'живая версия свежее архивной');
});

test('в архив попадает только расстановка — тяжёлое выброшено', () => {
  const heavy = {
    ...past('s1', 2, [['a', 'defense', 2, { subRoles: ['jungle'], junglePosition: 'top_near' }]]),
    signups: { a: 'in' }, signupMeta: { a: { from: 'discord', at: '2026-07-30' } },
    mapDrawings: [{ id: 'd', type: 'path', points: Array.from({ length: 500 }, () => ({ x: 1, y: 2 })) }],
    mapPositions: { a: { x: 1, y: 2 } }, mapTexts: [{ id: 't', text: 'x' }]
  };
  const [row] = archiveSessions([heavy], []);
  assert.equal(row.mapDrawings, undefined, 'рисунки — две трети веса события, их держать незачем');
  assert.equal(row.signups, undefined);
  assert.equal(row.mapPositions, undefined);
  assert.deepEqual(row.assignments[0].subRoles, ['jungle'], 'а доп-роли для истории нужны');
  assert.equal(row.event.type, 'prak', 'тип и время нужны для веса по возрасту');
});

test('шаблоны в архив не попадают — иначе их удаление перестало бы работать', () => {
  const rows = archiveSessions([template('tpl', [['a', 'attack', 1]])], []);
  assert.deepEqual(rows, [], 'шаблон живёт в состоянии постоянно, архивировать его не надо');
});

test('событие без расстановки истории не даёт', () => {
  assert.deepEqual(archiveSessions([past('s1', 2, [])], []), []);
});

test('совсем старое из архива выпадает', () => {
  const old = archiveSessions([past('s1', 400, [['a', 'attack', 1]])], []);
  assert.deepEqual(old, [], 'через полгода вес 0.012 — держать нечего');
  const fresh = archiveSessions([past('s2', 30, [['a', 'attack', 1]])], []);
  assert.equal(fresh.length, 1);
});

test('битый архив не роняет расстановку', () => {
  const players = [P('a')];
  for (const junk of [null, undefined, [null], [{}], [{ id: 'x' }]]) {
    const res = autofill({ players, sessions: [], archive: junk, target: target(['a']) });
    assert.equal(res.assignments.length, 1, 'состав обязан собраться при любом мусоре в архиве');
  }
});
