// План по таймингам: кто в какой момент боя какой лагерь снимает и кто идёт на босса.
//
// Проверять тут есть что. Клетка хранит и ссылки на группы, и фамилии, и курицу, а
// правок над ней шесть штук — глазом такое не пересчитаешь, ошибка вышла бы тихой:
// таблица выглядит правдоподобно и просто врёт, кто куда бежит на 20-й минуте.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPlan, planFromLegacy, cellPlayers, hasChicken, scheduleOf,
  putPlayers, dropPlayers, putGroups, dropGroups, setChicken,
  purgePlayers, purgeSide, swapGroupRefs, countTasks,
  cellKey, TIMINGS, BOSS, CAMPS, barsOf, campRoster
} from '../server/timings.mjs';

const A = (playerId, side = 'defense', group = 1, extra = {}) => ({ playerId, side, group, ...extra });
const D = 'defense';

// Расстановка из сообщения офицера: три пачки дефа
const roster = [
  A('kaito'), A('jigx'), A('jsyco'), A('jaby'), A('jysh'),
  A('jazen', D, 2), A('jamoes', D, 2), A('mojo', D, 2), A('jemi', D, 2), A('psy', D, 2),
  A('jokjok', D, 3), A('pikpik', D, 3), A('nadira', D, 3), A('janzo', D, 3), A('zed', D, 3)
];

test('ГЛАВНОЕ: один боец получает разные задачи на разных таймингах', () => {
  // Ради этого всё и затевалось: в старой модели у junglePosition было одно значение,
  // и «на старте дальний топ, дальше ближний» записать было физически нечем.
  let plan = {};
  plan = putPlayers(plan, { side: D, timings: ['start'], spot: 'top_far', playerIds: ['jigx'] });
  plan = putPlayers(plan, { side: D, timings: ['25', '20', '15', '10', '5'], spot: 'top_near', playerIds: ['jigx'] });

  const sch = scheduleOf(plan, roster, D, 'jigx');
  assert.equal(sch.start.camp, 'top_far');
  assert.equal(sch['25'].camp, 'top_near');
  assert.equal(sch['5'].camp, 'top_near');
});

test('лагеря внутри тайминга взаимоисключающие: в двух местах не постоишь', () => {
  let plan = putPlayers({}, { side: D, timings: TIMINGS, spot: 'top_far', playerIds: ['kaito'] });
  plan = putPlayers(plan, { side: D, timings: ['20'], spot: 'bot_near', playerIds: ['kaito'] });

  assert.deepEqual(cellPlayers(plan, roster, D, '20', 'top_far'), [], 'из прежнего лагеря вышел');
  assert.deepEqual(cellPlayers(plan, roster, D, '20', 'bot_near'), ['kaito']);
  assert.deepEqual(cellPlayers(plan, roster, D, '25', 'top_far'), ['kaito'], 'остальные тайминги не тронуты');
});

test('лес и босс в одном тайминге уживаются — тайминг это окно, а не точка', () => {
  // Боссы формально на 25-й и 15-й, но выходят когда угодно, и человек с курицей
  // успевает и лагерь снять, и на босса сходить. Поэтому две задачи разом — норма.
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: BOSS, playerIds: ['kaito'] });

  const sch = scheduleOf(plan, roster, D, 'kaito');
  assert.equal(sch['25'].camp, 'top_far');
  assert.equal(sch['25'].boss, true);
});

test('босса на 20-й не бывает — запись туда молча не появляется', () => {
  const plan = putPlayers({}, { side: D, timings: ['20', '10'], spot: BOSS, playerIds: ['kaito'] });
  assert.deepEqual(plan, {}, 'клетки босса на небоссовых таймингах не создаются');
});

test('курица привязана к задаче, а не к человеку: кейс JiGX', () => {
  // В лесу без курицы, на боссе с курицей — одного флага на бойце для этого мало.
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jigx'] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: BOSS, playerIds: ['jigx'] });
  plan = setChicken(plan, roster, { side: D, timings: ['25'], spot: BOSS, playerIds: ['jigx'], on: true });

  assert.equal(hasChicken(plan, D, '25', 'top_near', 'jigx'), false);
  assert.equal(hasChicken(plan, D, '25', BOSS, 'jigx'), true);
});

test('курица без задачи не ставится', () => {
  const plan = setChicken({}, roster, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'], on: true });
  assert.equal(hasChicken(plan, D, '25', 'top_far', 'kaito'), false, 'некому исполнять — записи нет');
});

test('ссылка на группу раскрывается по составу, а не по снимку', () => {
  const plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [3] });
  assert.deepEqual(
    cellPlayers(plan, roster, D, '25', 'top_near'),
    ['jokjok', 'pikpik', 'nadira', 'janzo', 'zed']
  );

  // Боец ушёл из третьей пачки во вторую — из леса он обязан пропасть сам
  const moved = roster.map((a) => (a.playerId === 'nadira' ? { ...a, group: 2 } : a));
  assert.equal(cellPlayers(plan, moved, D, '25', 'top_near').includes('nadira'), false);
});

test('ссылка и фамилии живут в одной клетке и не задваиваются', () => {
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jokjok', 'jigx'] });
  const ids = cellPlayers(plan, roster, D, '25', 'top_near');
  assert.equal(ids.filter((x) => x === 'jigx').length, 1, 'уже пришедший через группу не дублируется');
  assert.ok(ids.includes('jokjok'), 'поимённый из другой пачки на месте');
});

test('курица достаётся и тому, кто пришёл через групповую ссылку', () => {
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = setChicken(plan, roster, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jysh'], on: true });
  assert.equal(hasChicken(plan, D, '25', 'top_near', 'jysh'), true);
});

test('снятый из состава исчезает из плана целиком', () => {
  let plan = putPlayers({}, { side: D, timings: TIMINGS, spot: 'top_far', playerIds: ['kaito', 'jigx'] });
  plan = setChicken(plan, roster, { side: D, timings: TIMINGS, spot: 'top_far', playerIds: ['kaito'], on: true });
  const after = purgePlayers(plan, ['kaito']);

  assert.deepEqual(cellPlayers(after, roster, D, '25', 'top_far'), ['jigx']);
  assert.equal(hasChicken(after, D, '25', 'top_far', 'kaito'), false, 'курица уходит вместе с бойцом');
});

test('пустые клетки не копятся в сохранении', () => {
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  plan = dropPlayers(plan, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  assert.deepEqual(plan, {});
});

test('обмен пачек внутри стороны тащит лесную задачу за людьми', () => {
  const plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  const after = swapGroupRefs(plan, D, 1, D, 3);
  assert.deepEqual(after[cellKey(D, '25', 'top_near')].groups, [3], 'ссылка поехала за пачкой');
});

test('обмен между сторонами ссылку не двигает: переносить её некуда', () => {
  const plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  const after = swapGroupRefs(plan, D, 1, 'attack', 2);
  assert.deepEqual(after[cellKey(D, '25', 'top_near')].groups, [1]);
});

test('purgeSide убирает только свою сторону', () => {
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  plan = putPlayers(plan, { side: 'attack', timings: ['25'], spot: 'top_far', playerIds: ['ally'] });
  const after = purgeSide(plan, D);
  assert.equal(after[cellKey(D, '25', 'top_far')], undefined);
  assert.ok(after[cellKey('attack', '25', 'top_far')]);
});

// ---- Старые составы ----

test('состав без таймингов разворачивается в план, ничего не теряя', () => {
  const legacy = {
    assignments: [
      A('kaito', D, 1, { subRoles: ['jungle'], junglePosition: 'top_far', carriesChicken: true }),
      A('jamoes', D, 2, { subRoles: ['boss'], bossTime: 15 }),
      A('janzo', D, 3, { subRoles: ['tower'] })
    ]
  };
  const plan = readPlan(legacy);

  for (const tm of TIMINGS) {
    assert.deepEqual(cellPlayers(plan, legacy.assignments, D, tm, 'top_far'), ['kaito'], `лес на всех таймингах (${tm})`);
    assert.equal(hasChicken(plan, D, tm, 'top_far', 'kaito'), true, 'вместе с курицей');
  }
  assert.deepEqual(cellPlayers(plan, legacy.assignments, D, '15', BOSS), ['jamoes']);
  assert.deepEqual(cellPlayers(plan, legacy.assignments, D, '25', BOSS), [], 'босс только тот, что был записан');
  // Тавер в план не едет: он про весь бой и остаётся доп-ролью расстановки
  assert.equal(Object.keys(plan).some((k) => k.includes('tower')), false);
});

test('старая одиночная доп-роль (subRole) тоже понимается', () => {
  const legacy = { assignments: [A('kaito', D, 1, { subRole: 'jungle', junglePosition: 'bot_near' })] };
  assert.deepEqual(cellPlayers(readPlan(legacy), legacy.assignments, D, 'start', 'bot_near'), ['kaito']);
});

test('появившееся поле timings главнее старых полей', () => {
  const session = {
    assignments: [A('kaito', D, 1, { subRoles: ['jungle'], junglePosition: 'top_far' })],
    timings: { [cellKey(D, '25', 'bot_far')]: { groups: [], players: ['kaito'], chicken: [] } }
  };
  const plan = readPlan(session);
  assert.deepEqual(cellPlayers(plan, session.assignments, D, '25', 'bot_far'), ['kaito']);
  assert.deepEqual(cellPlayers(plan, session.assignments, D, '25', 'top_far'), [], 'старое поле уже не читается');
});

test('мусор в сохранении не роняет разбор', () => {
  const session = {
    assignments: roster,
    timings: {
      [cellKey(D, '25', 'top_far')]: { groups: [9, 'x', 2], players: ['kaito', 42, null], chicken: 'нет' },
      [cellKey(D, '20', 'top_far')]: null
    }
  };
  const plan = readPlan(session);
  assert.deepEqual(plan[cellKey(D, '25', 'top_far')].groups, [2], 'несуществующие номера пачек отброшены');
  assert.deepEqual(plan[cellKey(D, '25', 'top_far')].players, ['kaito']);
  assert.equal(plan[cellKey(D, '20', 'top_far')], undefined);
});

// ---- Отрисовка ----

test('счётчик задач считает пары «боец и точка», а не людей', () => {
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: BOSS, playerIds: ['kaito'] });
  assert.equal(countTasks(plan, roster, D), 2);
});

test('лагерей ровно четыре и они совпадают с позициями в лесу', () => {
  assert.deepEqual(CAMPS, ['top_near', 'top_far', 'bot_near', 'bot_far']);
});

test('planFromLegacy не падает на битой расстановке', () => {
  assert.deepEqual(planFromLegacy([null, { playerId: 'x' }, { side: 'nope', group: 9 }]), {});
  assert.deepEqual(planFromLegacy(undefined), {});
});

test('dropGroups убирает ссылку, не трогая поимённых', () => {
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jokjok'] });
  plan = dropGroups(plan, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  assert.deepEqual(cellPlayers(plan, roster, D, '25', 'top_near'), ['jokjok']);
});

// ---- Ссылка на пачку и личные решения ----

test('ГЛАВНОЕ: поимённая запись сильнее ссылки на пачку', () => {
  // Кейс прямо из приказа: «Close camp TOP: Гр.1 + двое», и тут же «Far camp TOP: Kaito»
  // — а Kaito в этой самой первой пачке. Без правила он стоял бы в двух лагерях разом.
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });

  assert.equal(cellPlayers(plan, roster, D, '25', 'top_near').includes('kaito'), false);
  assert.deepEqual(cellPlayers(plan, roster, D, '25', 'top_far'), ['kaito']);
  assert.equal(scheduleOf(plan, roster, D, 'kaito')['25'].camp, 'top_far');
});

test('личное решение действует только в своём тайминге', () => {
  let plan = putGroups({}, { side: D, timings: TIMINGS, spot: 'top_near', groups: [1] });
  plan = putPlayers(plan, { side: D, timings: ['20'], spot: 'top_far', playerIds: ['kaito'] });
  assert.equal(cellPlayers(plan, roster, D, '25', 'top_near').includes('kaito'), true, 'на 25-й он по-прежнему с пачкой');
});

test('можно вычеркнуть одного из пачки, никуда его не отправляя', () => {
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = dropPlayers(plan, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jaby'] });
  const ids = cellPlayers(plan, roster, D, '25', 'top_near');
  assert.equal(ids.includes('jaby'), false, 'вычеркнутый не возвращается через ссылку');
  assert.equal(ids.includes('jigx'), true, 'остальная пачка на месте');
});

test('возвращённый в клетку перестаёт быть вычеркнутым', () => {
  let plan = putGroups({}, { side: D, timings: ['25'], spot: 'top_near', groups: [1] });
  plan = dropPlayers(plan, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jaby'] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: 'top_near', playerIds: ['jaby'] });
  assert.equal(cellPlayers(plan, roster, D, '25', 'top_near').includes('jaby'), true);
});

// ---- Полосы на общей шкале ----
// Полоса рисуется одним прямоугольником от колонки до колонки, поэтому отрезок обязан
// быть непрерывным. Ошибка на единицу тут тихая: полоса просто укажет не на ту минуту.

test('ГЛАВНОЕ: дырка в середине разрывает полосу, а не рисуется сплошной', () => {
  // «25 · 15 · 10 · 5» — это ДВЕ полосы: на 20-й человек в другом месте
  const plan = putPlayers({}, { side: D, timings: ['25', '15', '10', '5'], spot: 'top_far', playerIds: ['kaito'] });
  const { jungle } = barsOf(plan, roster, D, 'kaito');
  assert.deepEqual(jungle.map((b) => [b.from, b.to]), [[1, 1], [3, 5]]);
});

test('весь бой на одном месте — одна полоса во всю ширину', () => {
  const plan = putPlayers({}, { side: D, timings: TIMINGS, spot: 'bot_far', playerIds: ['jamoes'] });
  const { jungle } = barsOf(plan, roster, D, 'jamoes');
  assert.equal(jungle.length, 1);
  assert.deepEqual([jungle[0].from, jungle[0].to], [0, TIMINGS.length - 1]);
});

test('смена лагеря разрывает полосу там, где сменился', () => {
  let plan = putPlayers({}, { side: D, timings: ['start'], spot: 'top_far', playerIds: ['jigx'] });
  plan = putPlayers(plan, { side: D, timings: ['25', '20', '15', '10', '5'], spot: 'top_near', playerIds: ['jigx'] });
  const { jungle } = barsOf(plan, roster, D, 'jigx');
  assert.deepEqual(jungle.map((b) => [b.camp, b.from, b.to]), [['top_far', 0, 0], ['top_near', 1, 5]]);
});

test('курица разрывает полосу: место то же, задача другая', () => {
  let plan = putPlayers({}, { side: D, timings: TIMINGS, spot: 'bot_near', playerIds: ['mojo'] });
  plan = setChicken(plan, roster, { side: D, timings: ['20'], spot: 'bot_near', playerIds: ['mojo'], on: true });
  const { jungle } = barsOf(plan, roster, D, 'mojo');
  assert.deepEqual(jungle.map((b) => [b.chicken, b.from, b.to]), [[false, 0, 1], [true, 2, 2], [false, 3, 5]]);
});

test('босс на 25 и 15 — две отдельные метки, между ними 20-я', () => {
  const plan = putPlayers({}, { side: D, timings: ['25', '15'], spot: BOSS, playerIds: ['jamoes'] });
  const { boss } = barsOf(plan, roster, D, 'jamoes');
  assert.deepEqual(boss.map((b) => [b.from, b.to]), [[1, 1], [3, 3]]);
});

test('у бойца без задач полос нет', () => {
  assert.deepEqual(barsOf({}, roster, D, 'janzo'), { jungle: [], boss: [] });
});

// ---- Сводка по точкам без времени (блок «ЛЕС» в простом приказе) ----
//
// Простой приказ показывает лагеря СПИСКОМ, без шкалы минут. Схлопывание времени и есть
// то место, где легче всего соврать: потерять вторую задачу кочевника или приписать
// курицу туда, где её нет.

test('ГЛАВНОЕ: кочевник стоит в обеих строках и помечен как меняющий лагерь', () => {
  let plan = putPlayers({}, { side: D, timings: ['start'], spot: 'top_far', playerIds: ['jigx'] });
  plan = putPlayers(plan, { side: D, timings: ['25', '20', '15', '10', '5'], spot: 'top_near', playerIds: ['jigx'] });

  const rows = campRoster(plan, roster, D);
  const at = (spot) => rows.find((r) => r.spot === spot)?.players || [];
  assert.deepEqual(at('top_far').map((p) => [p.id, p.moves]), [['jigx', true]]);
  assert.deepEqual(at('top_near').map((p) => [p.id, p.moves]), [['jigx', true]]);
});

test('кто весь бой на одном лагере — не кочевник', () => {
  const plan = putPlayers({}, { side: D, timings: TIMINGS, spot: 'bot_far', playerIds: ['mojo'] });
  const [row] = campRoster(plan, roster, D);
  assert.deepEqual(row.players, [{ id: 'mojo', group: 2, chicken: false, moves: false }]);
});

test('курица считается по точке: в лесу без неё, на боссе с ней', () => {
  // Ровно тот случай, ради которого курица привязана к задаче, а не к бойцу.
  let plan = putPlayers({}, { side: D, timings: ['25'], spot: 'top_far', playerIds: ['kaito'] });
  plan = putPlayers(plan, { side: D, timings: ['25'], spot: BOSS, playerIds: ['kaito'] });
  plan = setChicken(plan, roster, { side: D, timings: ['25'], spot: BOSS, playerIds: ['kaito'], on: true });

  const rows = campRoster(plan, roster, D);
  const at = (spot) => rows.find((r) => r.spot === spot)?.players || [];
  assert.deepEqual(at('top_far').map((p) => p.chicken), [false]);
  assert.deepEqual(at(BOSS).map((p) => p.chicken), [true]);
  assert.equal(at(BOSS)[0].moves, false, 'поход на босса лагерем не считается');
});

test('ссылка на пачку разворачивается в фамилии, исключённый не попадает', () => {
  let plan = putGroups({}, { side: D, timings: TIMINGS, spot: 'top_near', groups: [2] });
  plan = dropPlayers(plan, { side: D, timings: TIMINGS, spot: 'top_near', playerIds: ['psy'] });

  const [row] = campRoster(plan, roster, D);
  assert.equal(row.spot, 'top_near');
  assert.deepEqual(row.players.map((p) => p.id), ['jazen', 'jamoes', 'mojo', 'jemi']);
});

test('пустой план — пустая сводка, чужая сторона не подмешивается', () => {
  assert.deepEqual(campRoster({}, roster, D), []);
  const plan = putPlayers({}, { side: 'attack', timings: ['25'], spot: 'bot_near', playerIds: ['kaito'] });
  assert.deepEqual(campRoster(plan, roster, D), [], 'kaito стоит в дефе, запись — в атаке');
});
