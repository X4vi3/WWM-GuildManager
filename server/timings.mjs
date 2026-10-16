// План по таймингам: кто в какой момент боя снимает какой лагерь и кто идёт на босса.
//
// Зачем отдельная сущность, а не поля в WarAssignment. Расстановка отвечает на вопрос
// «где боец стоит», и ответ у неё один на весь бой. Лес отвечает на вопрос «куда он
// бежит», и ответ меняется каждые пять минут: один и тот же человек на старте снимает
// дальний топ, на 25-й идёт туда же с курицей, а на 20-й — уже на ближний. Впихнуть это
// в одно поле junglePosition невозможно, поэтому план живёт рядом и хранится клетками.
//
// Клетка — это (сторона, тайминг, точка). В ней лежат ССЫЛКИ НА ГРУППЫ и поимённый
// список. Ссылка нужна потому, что офицер пишет «Гр.1 + двое», а не шесть фамилий:
// переставил человека между группами на доске — лес пересчитался сам, забытых хвостов
// не остаётся.
//
// Курица привязана к клетке, а не к человеку: боец может идти в лес без курицы и в тот
// же тайминг на босса с курицей. Одного флага carriesChicken на бойце для этого мало.
//
// Модуль чистый и без сети, как autofill.mjs: фронт импортирует ЭТОТ же файл (allowJs
// в tsconfig), поэтому проверяется ровно то, что работает.

// ---- Словарь ----

// Моменты спавна крипов. Счёт идёт вниз: '25' — это «на 25-й минуте». 'start' —
// открытие боя, когда лагеря снимают первый раз.
export const START = 'start';
export const TIMINGS = [START, '25', '20', '15', '10', '5'];

// Босс формально спавнится на 25-й и 15-й. Формально — потому что в игре он может
// выйти раньше или позже, но гильдии считают по старым таймингам, и человек с курицей
// успевает и лагерь снять, и на босса сходить. Поэтому тайминг — это окно, а не точка,
// и в одном тайминге у бойца может быть сразу две задачи.
export const BOSS = 'boss';
export const BOSS_TIMINGS = ['25', '15'];

// Лагеря — те же четыре, что и в JunglePosition (types.ts). Порядок совпадает с
// JUNGLE_POSITIONS в constants.tsx, чтобы столбцы таблицы и кнопки в карточке бойца
// шли одинаково: разный порядок в двух местах читается как ошибка.
export const CAMPS = ['top_near', 'top_far', 'bot_near', 'bot_far'];
export const SPOTS = [...CAMPS, BOSS];

export const SIDES = ['attack', 'defense'];
export const GROUPS = [1, 2, 3];

export const isCamp = (spot) => CAMPS.includes(spot);
export const bossAt = (timing) => BOSS_TIMINGS.includes(timing);

export const cellKey = (side, timing, spot) => `${side}:${timing}:${spot}`;

// ---- Клетки ----

export const emptyCell = () => ({ groups: [], players: [], chicken: [], exclude: [] });

// Читаем чужие данные (бэкап, старое сохранение) недоверчиво: мусор в клетке уронил бы
// отрисовку всей таблицы, а не одну ячейку.
export const normCell = (c) => ({
  groups: (Array.isArray(c?.groups) ? c.groups : []).map(Number).filter((g) => GROUPS.includes(g)),
  players: (Array.isArray(c?.players) ? c.players : []).filter((x) => typeof x === 'string' && x),
  chicken: (Array.isArray(c?.chicken) ? c.chicken : []).filter((x) => typeof x === 'string' && x),
  // «Гр.1, кроме вот этого» — без исключений ссылка на пачку была бы бесполезна ровно
  // там, где она нужнее всего: один человек из пачки почти всегда уходит отдельно.
  exclude: (Array.isArray(c?.exclude) ? c.exclude : []).filter((x) => typeof x === 'string' && x)
});

export const isEmptyCell = (c) => !c || (!c.groups?.length && !c.players?.length);

// Убираем из плана пустые клетки: иначе он растёт от каждого случайного клика и
// раздувает сохранение, ничего при этом не выражая.
const compact = (plan) => {
  const out = {};
  for (const [k, v] of Object.entries(plan)) if (!isEmptyCell(v)) out[k] = v;
  return out;
};

const withCell = (plan, key, fn) => {
  const next = { ...plan };
  const cell = fn(next[key] ? { ...normCell(next[key]) } : emptyCell());
  next[key] = cell;
  return compact(next);
};

// ---- Чтение плана из сессии ----

const subRolesOf = (a) => (Array.isArray(a?.subRoles) && a.subRoles.length)
  ? a.subRoles
  : (a?.subRole ? [a.subRole] : []);

const isPlaced = (a) =>
  a && typeof a.playerId === 'string' &&
  SIDES.includes(a.side) && GROUPS.includes(a.group);

// Составы, собранные до появления таймингов, разворачиваются в план на лету: «Лес ·
// дальний топ · курица» — это дальний топ с курицей на всех шести таймингах, а «Босс
// 25′» — клетка босса на 25-й. Смысл сохраняется полностью, поэтому старые события
// продолжают кормить автозаполнение и рисоваться в картинке.
export const planFromLegacy = (assignments) => {
  const plan = {};
  const add = (side, timing, spot, id, chicken) => {
    const key = cellKey(side, timing, spot);
    const cell = plan[key] || (plan[key] = emptyCell());
    if (!cell.players.includes(id)) cell.players.push(id);
    if (chicken && !cell.chicken.includes(id)) cell.chicken.push(id);
  };
  for (const a of assignments || []) {
    if (!isPlaced(a)) continue;
    const subs = subRolesOf(a);
    if (subs.includes('jungle') && CAMPS.includes(a.junglePosition)) {
      for (const t of TIMINGS) add(a.side, t, a.junglePosition, a.playerId, !!a.carriesChicken);
    }
    if (subs.includes('boss')) {
      const t = String(a.bossTime || 25);
      if (bossAt(t)) add(a.side, t, BOSS, a.playerId, !!a.carriesChicken);
    }
  }
  return plan;
};

// Единственная точка входа для чтения. Если поля нет — разворачиваем старые данные;
// если есть — оно и есть правда, старые поля уже вычищены при первой же правке.
export const readPlan = (session) => {
  const raw = session?.timings;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const cell = normCell(v);
      if (!isEmptyCell(cell)) out[k] = cell;
    }
    return out;
  }
  return planFromLegacy(session?.assignments);
};

// Кто в клетке. Сначала люди из групповых ссылок (в порядке групп), потом поимённые.
//
// Поимённая запись СИЛЬНЕЕ ссылки на пачку. Это не тонкость, а основной случай: офицер
// пишет «Close camp TOP: Гр.1 + двое», и тут же отдельной строкой «Far camp TOP: Kaito»
// — а Kaito в той самой первой пачке. Без этого правила он оказался бы записан сразу в
// два лагеря, и таблица показывала бы человека там, куда он не пойдёт.
export const cellPlayers = (plan, assignments, side, timing, spot) => {
  const cell = plan?.[cellKey(side, timing, spot)];
  if (!cell) return [];
  const skip = new Set(cell.exclude || []);
  if (isCamp(spot)) {
    for (const other of CAMPS) {
      if (other === spot) continue;
      for (const id of plan[cellKey(side, timing, other)]?.players || []) skip.add(id);
    }
  }
  const out = [];
  const seen = new Set();
  for (const g of cell.groups || []) {
    for (const a of assignments || []) {
      if (isPlaced(a) && a.side === side && a.group === g && !seen.has(a.playerId) && !skip.has(a.playerId)) {
        seen.add(a.playerId);
        out.push(a.playerId);
      }
    }
  }
  for (const id of cell.players || []) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
};

export const hasChicken = (plan, side, timing, spot, playerId) =>
  !!plan?.[cellKey(side, timing, spot)]?.chicken?.includes(playerId);

// Расписание одного бойца: что он делает в каждый тайминг. Нужно и карточке (показать
// «на 4 из 6 таймингов»), и бейджам на доске, и автозаполнению.
export const scheduleOf = (plan, assignments, side, playerId) => {
  const out = {};
  for (const timing of TIMINGS) {
    const row = { camp: null, campChicken: false, boss: false, bossChicken: false };
    for (const camp of CAMPS) {
      if (cellPlayers(plan, assignments, side, timing, camp).includes(playerId)) {
        row.camp = camp;
        row.campChicken = hasChicken(plan, side, timing, camp, playerId);
        break; // лагеря взаимоисключающие — в двух местах одновременно не постоишь
      }
    }
    if (bossAt(timing) && cellPlayers(plan, assignments, side, timing, BOSS).includes(playerId)) {
      row.boss = true;
      row.bossChicken = hasChicken(plan, side, timing, BOSS, playerId);
    }
    out[timing] = row;
  }
  return out;
};

// ---- Правка плана ----

// Поставить бойцов в точку на перечисленных таймингах. Лагеря внутри тайминга
// взаимоисключающие: поставив человека на ближний топ, снимаем его с остальных трёх,
// иначе он молча оказался бы записан в двух местах сразу.
export const putPlayers = (plan, { side, timings, spot, playerIds }) => {
  let next = plan;
  for (const timing of timings) {
    if (spot === BOSS && !bossAt(timing)) continue; // босса на 20-й не бывает
    if (isCamp(spot)) {
      for (const other of CAMPS) {
        if (other !== spot) next = dropPlayers(next, { side, timings: [timing], spot: other, playerIds });
      }
    }
    next = withCell(next, cellKey(side, timing, spot), (cell) => ({
      ...cell,
      players: [...cell.players, ...playerIds.filter((id) => !cell.players.includes(id))],
      // Вернули того, кого раньше вычеркнули из пачки — исключение снимаем, иначе он
      // остался бы вычеркнутым навсегда и клетка тихо теряла бы человека.
      exclude: cell.exclude.filter((id) => !playerIds.includes(id))
    }));
  }
  return next;
};

export const dropPlayers = (plan, { side, timings, spot, playerIds }) => {
  let next = plan;
  const gone = new Set(playerIds);
  for (const timing of timings) {
    const key = cellKey(side, timing, spot);
    if (!next[key]) continue;
    next = withCell(next, key, (cell) => ({
      ...cell,
      players: cell.players.filter((id) => !gone.has(id)),
      chicken: cell.chicken.filter((id) => !gone.has(id)),
      // В клетке есть ссылка на пачку — одного удаления из списка мало: человек вернётся
      // через неё же. Поэтому вычёркиваем явно.
      exclude: cell.groups.length
        ? [...new Set([...cell.exclude, ...playerIds])]
        : cell.exclude
    }));
  }
  return next;
};

export const putGroups = (plan, { side, timings, spot, groups }) => {
  let next = plan;
  for (const timing of timings) {
    if (spot === BOSS && !bossAt(timing)) continue;
    if (isCamp(spot)) {
      for (const other of CAMPS) {
        if (other !== spot) next = dropGroups(next, { side, timings: [timing], spot: other, groups });
      }
    }
    next = withCell(next, cellKey(side, timing, spot), (cell) => ({
      ...cell,
      groups: [...cell.groups, ...groups.filter((g) => !cell.groups.includes(g))]
    }));
  }
  return next;
};

export const dropGroups = (plan, { side, timings, spot, groups }) => {
  let next = plan;
  const gone = new Set(groups);
  for (const timing of timings) {
    const key = cellKey(side, timing, spot);
    if (!next[key]) continue;
    next = withCell(next, key, (cell) => ({ ...cell, groups: cell.groups.filter((g) => !gone.has(g)) }));
  }
  return next;
};

// Курица ставится только тому, кто в этой клетке реально стоит: курица без задачи —
// это запись, которую некому исполнить.
export const setChicken = (plan, assignments, { side, timings, spot, playerIds, on }) => {
  let next = plan;
  for (const timing of timings) {
    const key = cellKey(side, timing, spot);
    if (!next[key]) continue;
    const inCell = new Set(cellPlayers(next, assignments, side, timing, spot));
    next = withCell(next, key, (cell) => {
      const keep = cell.chicken.filter((id) => !playerIds.includes(id));
      return {
        ...cell,
        chicken: on ? [...keep, ...playerIds.filter((id) => inCell.has(id))] : keep
      };
    });
  }
  return next;
};

// Снять бойца из состава войны — он обязан исчезнуть и из плана, иначе останется
// расписан на лагерь, в который уже не придёт.
export const purgePlayers = (plan, playerIds) => {
  const gone = new Set(playerIds);
  const out = {};
  for (const [key, raw] of Object.entries(plan)) {
    const cell = normCell(raw);
    const next = {
      groups: cell.groups,
      players: cell.players.filter((id) => !gone.has(id)),
      chicken: cell.chicken.filter((id) => !gone.has(id)),
      exclude: cell.exclude.filter((id) => !gone.has(id))
    };
    if (!isEmptyCell(next)) out[key] = next;
  }
  return out;
};

// Две группы поменялись местами на доске. Внутри одной стороны это чистая
// перенумерация — приложение меняет местами и линии, поэтому люди остаются на своём
// месте боя, и лесная задача обязана поехать за ними.
//
// Обмен МЕЖДУ сторонами ссылки не трогает намеренно: клетки привязаны к стороне, и
// перенести их «на ту сторону» некуда — там свой план. Ссылка в этом случае честно
// значит «кто бы ни был первой пачкой дефа», а поимённые записи уехавших вычищаются
// отдельно (purgePlayers), потому что они были про конкретного человека.
export const swapGroupRefs = (plan, aSide, aGroup, bSide, bGroup) => {
  const out = {};
  for (const [key, raw] of Object.entries(plan)) {
    const cell = normCell(raw);
    const side = key.split(':')[0];
    const groups = cell.groups.map((g) => {
      if (side === aSide && g === aGroup && aSide === bSide) return bGroup;
      if (side === bSide && g === bGroup && aSide === bSide) return aGroup;
      return g;
    });
    out[key] = { ...cell, groups: [...new Set(groups)] };
  }
  return compact(out);
};

export const purgeSide = (plan, side) => {
  const out = {};
  for (const [key, cell] of Object.entries(plan)) if (!key.startsWith(`${side}:`)) out[key] = cell;
  return out;
};

// ---- Отрисовка ----

// Порядок таймингов не схлопывается и не переставляется НИКОГДА.
//
// Схлопывание одинаковых строк здесь было, и казалось удачным: офицер пишет «Cycling
// jungle (25/15/10/5)» одной строкой, и таблица делала то же. Но содержимое совпадает не
// по хронологии, а по составу, и порядок начинал скакать: «старт», «25 · 15 · 10 · 5»,
// «20». Владелец споткнулся ровно об это — «почему минуты поделены на 25 и 15, 20, 10 и 5,
// что странно». Ось времени, которая идёт не по времени, читателю не ось.
//
// Быстрый ввод от отказа не пострадал: «поставить сразу на 25/15/10/5» делает модалка
// «Укажите тайминги» в карточке бойца — там это явное действие, а не побочный эффект
// того, что строки случайно совпали.

// Расписание бойца НЕПРЕРЫВНЫМИ отрезками — под полосы на общей шкале времени.
//
// Отличие от segmentsOf принципиальное: там отрезки собираются по совпадению задачи и
// могут быть несмежными («25, 15, 10, 5» — один отрезок через дырку на 20-й). Здесь
// отрезок обязан быть непрерывным, потому что рисуется одной полосой: полоса с дыркой
// посередине соврала бы, что человек стоит там и на 20-й.
//
// from/to — индексы в TIMINGS, то есть номера колонок. Считать их в компоненте нельзя:
// сдвиг на единицу тут даёт полосу, которая молча указывает не на ту минуту.
export const barsOf = (plan, assignments, side, playerId) => {
  const sch = scheduleOf(plan, assignments, side, playerId);
  const jungle = [];
  const boss = [];
  let cur = null;
  let bcur = null;

  TIMINGS.forEach((timing, i) => {
    const row = sch[timing];

    const key = row.camp ? `${row.camp}|${row.campChicken ? '1' : ''}` : null;
    if (cur && cur.key !== key) { jungle.push(cur); cur = null; }
    if (key) {
      if (cur) cur.to = i;
      else cur = { key, camp: row.camp, chicken: row.campChicken, from: i, to: i };
    }

    const bkey = row.boss ? (row.bossChicken ? '1' : '0') : null;
    if (bcur && bcur.key !== bkey) { boss.push(bcur); bcur = null; }
    if (bkey) {
      if (bcur) bcur.to = i;
      else bcur = { key: bkey, chicken: row.bossChicken, from: i, to: i };
    }
  });

  if (cur) jungle.push(cur);
  if (bcur) boss.push(bcur);
  return { jungle, boss };
};

// Кто где стоит, если убрать из плана ВРЕМЯ. Нужно простому приказу: шкалы минут там нет,
// и вопрос стоит иначе — «кого я увижу на этом лагере», а не «когда он там будет».
//
// Считается через scheduleOf, а не своим обходом клеток: там уже разобраны ссылки на
// пачки, исключения и взаимоисключимость лагерей. Второй обход тех же правил однажды
// разошёлся бы с первым, и две картинки одного боя показывали бы разное.
//
// moves — боец за бой стоит больше чем в одном лагере. Такой попадает в ОБЕ строки (иначе
// одна из его задач молча исчезла бы из приказа), и без пометки читался бы как два разных
// человека с одинаковым ником. Считается только по лагерям: босс — другой род задачи,
// ходить на него из лагеря нормально, и переходом это не является.
export const campRoster = (plan, assignments, side) => {
  const rows = new Map(SPOTS.map(spot => [spot, []]));
  for (const a of assignments || []) {
    if (!isPlaced(a) || a.side !== side) continue;
    const sch = scheduleOf(plan, assignments, side, a.playerId);
    const camps = new Map(); // лагерь → несёт ли он там курицу хоть на одном тайминге
    let boss = false;
    let bossChicken = false;
    for (const timing of TIMINGS) {
      const row = sch[timing];
      if (row.camp) camps.set(row.camp, !!camps.get(row.camp) || row.campChicken);
      if (row.boss) { boss = true; bossChicken = bossChicken || row.bossChicken; }
    }
    for (const [camp, chicken] of camps) {
      rows.get(camp).push({ id: a.playerId, group: a.group, chicken, moves: camps.size > 1 });
    }
    if (boss) rows.get(BOSS).push({ id: a.playerId, group: a.group, chicken: bossChicken, moves: false });
  }
  return SPOTS.map(spot => ({ spot, players: rows.get(spot) })).filter(r => r.players.length > 0);
};

// Сколько всего задач в плане стороны — для счётчика в шапке
export const countTasks = (plan, assignments, side) => {
  let n = 0;
  for (const timing of TIMINGS) {
    for (const spot of SPOTS) {
      if (spot === BOSS && !bossAt(timing)) continue;
      n += cellPlayers(plan, assignments, side, timing, spot).length;
    }
  }
  return n;
};
