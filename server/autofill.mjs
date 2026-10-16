// Автозаполнение состава по тому, кто где обычно играет.
//
// Зачем отдельным файлом без сети: расстановку тридцати человек по шести пачкам
// глазом не проверить — ошибка тут тихая. Поэтому подбор живёт чистой функцией и
// покрыт тестами, как nickmatch.mjs и discord_embed.mjs. Фронт импортирует этот же
// файл, чтобы реализация была одна (в tsconfig включён allowJs).
//
// Копить историю не нужно — она уже есть. Каждая сессия хранит и расстановку, и план
// по таймингам, поэтому автозаполнение работает на всём архиве с первого дня. Составы,
// собранные до появления таймингов, разворачиваются readPlan на лету и тоже участвуют.
//
// Что было раньше: кнопка авто-расстановки брала неназначенных ПОДРЯД и раскладывала
// по пятёркам, не глядя ни на заявки, ни на историю. В состав ехали и те, кто ответил
// «не иду». Пользы от неё не было, поэтому она заменена, а не дополнена.

// План по таймингам живёт отдельным модулем: он нужен и фронту, и экспорту, и здесь.
import {
  readPlan, cellPlayers, hasChicken, putPlayers, setChicken,
  TIMINGS, BOSS, BOSS_TIMINGS, CAMPS, bossAt
} from './timings.mjs';

// Зеркало types.ts и constants.tsx: сервер на .mjs, импортировать оттуда нельзя.
// Меняется только вместе с правилами самой игры.
export const SIDES = ['attack', 'defense'];
export const GROUPS = [1, 2, 3];
export const PER_GROUP = 5;
export const MAX_PLAYERS = 30;

// Через сколько дней наблюдение весит вдвое меньше. Считаем именно по возрасту, а
// не «последние N событий»: пропущенная человеком неделя не должна выбрасывать его
// из истории — он просто не дал наблюдений за эти дни, а прежние остаются в силе.
export const HALF_LIFE_DAYS = 28;

// Насколько устойчивой должна быть привычка, чтобы тащить доп-роль (лес/босс/тавер/
// курица) в новый состав. Разовое не тащим.
const EXTRA_MIN_SHARE = 0.5;

// Сколько кого нужно в пятёрке. Остальные места — ДД.
export const ROLE_MINIMUM = { Tank: 1, Healer: 1, DPS: 0 };

export const slotKey = (side, group) => `${side}:${group}`;
export const ALL_SLOTS = SIDES.flatMap((side) => GROUPS.map((group) => slotKey(side, group)));
const parseSlot = (key) => {
  const [side, group] = String(key).split(':');
  return { side, group: Number(group) };
};

const isValid = (a) =>
  a && typeof a.playerId === 'string' &&
  (a.side === 'attack' || a.side === 'defense') &&
  (a.group === 1 || a.group === 2 || a.group === 3);

// Доп-роли бойца с поддержкой старого одиночного поля subRole
const subRolesOf = (a) => (Array.isArray(a?.subRoles) && a.subRoles.length)
  ? a.subRoles
  : (a?.subRole ? [a.subRole] : []);

// Вес наблюдения. Шаблон не стареет: это не запись о прошедшем бое, а действующий
// эталон состава, который офицер собрал осознанно.
export const sessionWeight = (session, now) => {
  if (!session?.event) return 1;
  const t = new Date(session.event.startsAt || session.date || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return 0.5; // событие без времени — половинный вес
  const days = Math.max(0, (now - t) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
};

const bump = (map, key, w) => map.set(key, (map.get(key) || 0) + w);

// ---- Архив расстановок ----
//
// Зачем он вообще нужен. История лежала прямо в событиях, а события удаляют — у нас
// это делают раз в неделю, разобрав праки, ранкед и лигу. Значит память обнулялась
// каждую неделю и автозаполнение расставляло людей наугад. Поэтому расстановка
// сохраняется ОТДЕЛЬНО и переживает удаление события.
//
// Запись — это то же событие, только сильно похудевшее: остаются имя, время, тип и
// сама расстановка. Всё тяжёлое (рисунки на карте, заявки, позиции токенов) выброшено,
// а рисунки — это две трети веса события. Форма нарочно совпадает с сессией: тогда
// разбор истории читает архив тем же кодом, и второго разборщика, который однажды
// разойдётся с первым, не появляется.
//
// Шаблоны сюда НЕ попадают. Они и так живут в состоянии постоянно, а их удаление —
// это осознанное «такой состав больше не эталон». Архивируй мы их, удаление
// перестало бы работать как решение.
export const ARCHIVE_KEEP_DAYS = 180;

const trimAssignment = (a) => {
  const out = { playerId: a.playerId, side: a.side, group: a.group };
  const subs = subRolesOf(a);
  if (subs.length) out.subRoles = subs;
  if (a.junglePosition) out.junglePosition = a.junglePosition;
  if (a.bossTime) out.bossTime = a.bossTime;
  if (a.carriesChicken) out.carriesChicken = true;
  return out;
};

// Слить свежие события в архив. Операция ТОЛЬКО добавляющая: строки не удаляются,
// а перезаписываются свежей версией той же сессии. Поэтому её безопасно выполнять
// и при тихом сохранении (импорт бэкапа, откат) — потерять тут нечего, а импорт
// старого бэкапа наоборот вернёт историю, которой не было.
export const archiveSessions = (sessions, prev = [], { now = Date.now(), keepDays = ARCHIVE_KEEP_DAYS } = {}) => {
  const byId = new Map();
  for (const row of prev || []) if (row?.id) byId.set(row.id, row);

  for (const s of sessions || []) {
    if (!s?.event) continue;
    const list = (s.assignments || []).filter(isValid);
    if (!list.length) continue; // событие без расстановки истории не даёт
    // План по таймингам едет в архив вместе с расстановкой. Он лёгкий (пара десятков
    // идентификаторов), а без него автозаполнение ослепло бы на лес ровно так же, как
    // когда-то слепло на состав из-за удаления событий.
    const plan = readPlan(s);
    byId.set(s.id, {
      id: s.id,
      name: s.name || '',
      event: { type: s.event.type, startsAt: s.event.startsAt || s.date || null },
      assignments: list.map(trimAssignment),
      ...(Object.keys(plan).length ? { timings: plan } : {}),
      ...(s.groupLanes && Object.keys(s.groupLanes).length ? { groupLanes: s.groupLanes } : {})
    });
  }

  // Полгода — это вес 0.012 от свежего, то есть ничего. Дальше держать незачем.
  const cutoff = now - keepDays * 86400000;
  const at = (r) => new Date(r?.event?.startsAt || 0).getTime();
  return [...byId.values()]
    .filter((r) => { const t = at(r); return !(t > 0) || t >= cutoff; })
    .sort((a, b) => at(a) - at(b));
};

// Живые сессии плюс архив, без задвоения. Живая версия важнее архивной: её только
// что могли поправить, а строка в архиве осталась от предыдущего сохранения.
export const mergeArchive = (sessions, archive) => {
  const live = new Set((sessions || []).map((s) => s?.id));
  return [...(sessions || []), ...(archive || []).filter((r) => r?.id && !live.has(r.id))];
};

// ---- Разбор истории ----
// slots:   playerId -> { слот -> {w, hits} }  — где человек стоял
// extras:  playerId -> { слот -> {w, tower} } — доп-роль на весь бой
// timings: playerId -> { `слот|тайминг` -> {w, camps, campAny, campChicken, boss, bossChicken} }
// lanes:   ключ линии -> { линия -> w }
//
// Лес и босс считаются ПО ТАЙМИНГАМ, а не одной кучей: человек, который на старте
// снимает дальний топ, а с 25-й уходит на ближний, при подсчёте «одной кучей» получил
// бы среднее по больнице и не попал бы никуда.
export const buildHistory = (sessions, { now = Date.now(), excludeId = null } = {}) => {
  const slots = new Map();
  const extras = new Map();
  const timings = new Map();
  const lanes = new Map();

  for (const s of sessions || []) {
    if (!s || s.id === excludeId) continue;
    const list = (s.assignments || []).filter(isValid);
    if (!list.length) continue;
    const w = sessionWeight(s, now);
    if (!(w > 0)) continue;

    // Разворачиваем план один раз на сессию: групповые ссылки надо раскрыть, а делать
    // это заново на каждого бойца и каждый тайминг — тридцать тысяч лишних проходов.
    const plan = readPlan(s);
    const idx = new Map();
    for (const side of SIDES) {
      for (const timing of TIMINGS) {
        for (const spot of [...CAMPS, BOSS]) {
          if (spot === BOSS && !bossAt(timing)) continue;
          const ids = cellPlayers(plan, list, side, timing, spot);
          if (ids.length) idx.set(`${side}|${timing}|${spot}`, ids);
        }
      }
    }

    for (const a of list) {
      const key = slotKey(a.side, a.group);
      if (!slots.has(a.playerId)) slots.set(a.playerId, new Map());
      const mine = slots.get(a.playerId);
      const cur = mine.get(key) || { w: 0, hits: 0 };
      mine.set(key, { w: cur.w + w, hits: cur.hits + 1 });

      if (!extras.has(a.playerId)) extras.set(a.playerId, new Map());
      const ex = extras.get(a.playerId);
      const e = ex.get(key) || { w: 0, tower: 0 };
      e.w += w;
      if (subRolesOf(a).includes('tower')) e.tower += w;
      ex.set(key, e);

      if (!timings.has(a.playerId)) timings.set(a.playerId, new Map());
      const tm = timings.get(a.playerId);
      for (const timing of TIMINGS) {
        const tkey = `${key}|${timing}`;
        const row = tm.get(tkey) || {
          w: 0, camps: new Map(), campAny: 0, campChicken: 0, boss: 0, bossChicken: 0
        };
        row.w += w;
        for (const camp of CAMPS) {
          if (!(idx.get(`${a.side}|${timing}|${camp}`) || []).includes(a.playerId)) continue;
          row.campAny += w;
          bump(row.camps, camp, w);
          if (hasChicken(plan, a.side, timing, camp, a.playerId)) row.campChicken += w;
          break; // лагеря взаимоисключающие
        }
        if (bossAt(timing) && (idx.get(`${a.side}|${timing}|${BOSS}`) || []).includes(a.playerId)) {
          row.boss += w;
          if (hasChicken(plan, a.side, timing, BOSS, a.playerId)) row.bossChicken += w;
        }
        tm.set(tkey, row);
      }
    }

    for (const [key, lane] of Object.entries(s.groupLanes || {})) {
      if (!lane) continue;
      if (!lanes.has(key)) lanes.set(key, new Map());
      bump(lanes.get(key), lane, w);
    }
  }

  return { slots, extras, timings, lanes };
};

// Куда игрок обычно попадает — от самого частого к редкому. share считается ВНУТРИ
// игрока: редко играющий тоже заслуживает своё место, важна доля, а не количество.
export const preferences = (history, playerId) => {
  const mine = history.slots.get(playerId);
  if (!mine || !mine.size) return [];
  let total = 0, hitsTotal = 0;
  for (const v of mine.values()) { total += v.w; hitsTotal += v.hits; }
  if (!(total > 0)) return [];
  return [...mine.entries()]
    .map(([slot, v]) => ({ slot, share: v.w / total, hits: v.hits, total: hitsTotal, weight: v.w }))
    .sort((a, b) => b.share - a.share || b.hits - a.hits || a.slot.localeCompare(b.slot));
};

// Насколько мы уверены, что человека надо ставить именно туда. Два множителя:
// насколько ярко выражена привычка и сколько вообще накоплено наблюдений. Без
// второго один-единственный выход давал бы долю 1.0 и перебивал бы тех, кто
// стабильно ходит в свою пачку десятками боёв.
export const confidenceOf = (prefs) => {
  if (!prefs.length) return 0;
  const evidence = prefs.reduce((sum, p) => sum + p.weight, 0);
  return prefs[0].share * (evidence / (evidence + 1));
};

// Доп-роль для конкретного слота — только устойчивая. Считаем в том слоте, куда
// человек назначен сейчас: «тавер» живёт в дефе, и тащить его в атаку неверно.
// Осталась одна доп-роль: лес, босс и курица уехали в план по таймингам.
export const extrasFor = (history, playerId, slot) => {
  const ex = history.extras.get(playerId)?.get(slot);
  if (!ex || !(ex.w > 0)) return {};
  return ex.tower / ex.w >= EXTRA_MIN_SHARE ? { subRoles: ['tower'] } : {};
};

// Что человек обычно делает в лесу на каждом тайминге — только устойчивое.
//
// Устойчивость считается ОТДЕЛЬНО по каждому таймингу, потому что и привычка у людей
// отдельная: на старте вся пачка идёт снимать лагерь вместе, а с 25-й туда бегает один
// человек с курицей. Одна общая доля смешала бы эти два разных факта в один средний
// и не воспроизвела бы ни того, ни другого.
//
// Курица считается внутри задачи, а не от всех наблюдений: важно «когда он идёт на
// босса, он идёт с курицей», а не «как часто он вообще носит курицу».
export const timingsFor = (history, playerId, slot) => {
  const mine = history.timings?.get(playerId);
  if (!mine) return {};
  const best = (m) => {
    let bestKey = null, bestW = 0;
    for (const [k, w] of m) if (w > bestW) { bestKey = k; bestW = w; }
    return bestKey;
  };
  const out = {};
  for (const timing of TIMINGS) {
    const row = mine.get(`${slot}|${timing}`);
    if (!row || !(row.w > 0)) continue;
    const entry = {};
    if (row.campAny / row.w >= EXTRA_MIN_SHARE) {
      const camp = best(row.camps);
      if (camp) {
        entry.camp = camp;
        entry.campChicken = row.campChicken / row.campAny >= EXTRA_MIN_SHARE;
      }
    }
    if (bossAt(timing) && row.boss / row.w >= EXTRA_MIN_SHARE) {
      entry.boss = true;
      entry.bossChicken = row.bossChicken / row.boss >= EXTRA_MIN_SHARE;
    }
    if (entry.camp || entry.boss) out[timing] = entry;
  }
  return out;
};

// Дописать в план привычные задачи новичков расстановки. Только ДОписать: клетки,
// которые офицер уже заполнил, и задачи тех, кто стоял в составе до нажатия кнопки,
// не трогаем — по той же причине, по которой автозаполнение не переставляет людей.
export const fillTimings = (history, plan, assignments, newIds) => {
  let next = plan;
  const fresh = new Set(newIds);
  for (const a of assignments) {
    if (!fresh.has(a.playerId)) continue;
    const slot = slotKey(a.side, a.group);
    const sched = timingsFor(history, a.playerId, slot);
    for (const [timing, row] of Object.entries(sched)) {
      if (row.camp) {
        next = putPlayers(next, { side: a.side, timings: [timing], spot: row.camp, playerIds: [a.playerId] });
        if (row.campChicken) {
          next = setChicken(next, assignments, { side: a.side, timings: [timing], spot: row.camp, playerIds: [a.playerId], on: true });
        }
      }
      if (row.boss) {
        next = putPlayers(next, { side: a.side, timings: [timing], spot: BOSS, playerIds: [a.playerId] });
        if (row.bossChicken) {
          next = setChicken(next, assignments, { side: a.side, timings: [timing], spot: BOSS, playerIds: [a.playerId], on: true });
        }
      }
    }
  }
  return next;
};

// Самая частая линия для каждой пары «сторона:группа»
export const suggestLanes = (history, existing = {}) => {
  const out = {};
  for (const [key, m] of history.lanes) {
    if (existing[key]) continue; // офицер уже выбрал — не переигрываем
    let bestLane = null, bestW = 0;
    for (const [lane, w] of m) if (w > bestW) { bestLane = lane; bestW = w; }
    if (bestLane) out[key] = bestLane;
  }
  return out;
};

// Кого вообще расставляем. У события — тех, кто сказал «иду»: расставлять
// ответивших «не иду» бессмысленно, и именно этого не умела прежняя кнопка.
// У шаблона заявок нет, поэтому берём весь состав.
export const candidatesFor = (players, session) => {
  const list = players || [];
  if (!session?.event) return list;
  const signups = session.signups || {};
  return list.filter((p) => signups[p.id] === 'in');
};

// ---- Расстановка ----
export const autofill = ({ players, sessions, archive = [], target, now = Date.now() }) => {
  const byId = new Map((players || []).map((p) => [p.id, p]));
  const history = buildHistory(mergeArchive(sessions, archive), { now, excludeId: target?.id });

  // Уже расставленных не трогаем: кнопка обязана ДОзаполнять, а не переписывать
  // работу офицера — иначе её страшно нажимать.
  const kept = (target?.assignments || []).filter(isValid).filter((a) => byId.has(a.playerId));
  const taken = new Set(kept.map((a) => a.playerId));
  const seats = new Map(ALL_SLOTS.map((k) => [k, []]));
  for (const a of kept) seats.get(slotKey(a.side, a.group))?.push(a.playerId);

  const pool = candidatesFor(players, target).filter((p) => !taken.has(p.id));
  const info = new Map(pool.map((p) => {
    const prefs = preferences(history, p.id);
    return [p.id, { prefs, confidence: confidenceOf(prefs) }];
  }));

  const roleOf = (id) => byId.get(id)?.role || 'DPS';
  const freeSeats = () => ALL_SLOTS.reduce((n, k) => n + (PER_GROUP - seats.get(k).length), 0);
  const has = (slot, role) => seats.get(slot).filter((id) => roleOf(id) === role).length;
  const missingRoles = (slot) =>
    Object.entries(ROLE_MINIMUM).filter(([role, min]) => min > 0 && has(slot, role) < min).map(([r]) => r);

  const place = (id, slot) => {
    if (seats.get(slot).length >= PER_GROUP) return false;
    seats.get(slot).push(id);
    taken.add(id);
    return true;
  };

  // Проход 1 — уверенные. Сначала те, у кого привычка выражена ярче: у них больше
  // прав на своё место, а гуляющие потом займут что осталось.
  const known = pool.filter((p) => info.get(p.id).prefs.length)
    .sort((a, b) => info.get(b.id).confidence - info.get(a.id).confidence);
  for (const p of known) {
    if (freeSeats() <= 0) break;
    for (const pref of info.get(p.id).prefs) {
      if (place(p.id, pref.slot)) break;
    }
  }

  // Проход 2 — остальные (без истории и те, кому не хватило места). Затыкаем дыры,
  // начиная с пачек, где не хватает обязательной роли.
  const rest = pool.filter((p) => !taken.has(p.id));
  for (const p of rest) {
    if (freeSeats() <= 0) break;
    const open = ALL_SLOTS.filter((k) => seats.get(k).length < PER_GROUP);
    const wanted = open.filter((k) => missingRoles(k).includes(roleOf(p.id)));
    const target1 = (wanted.length ? wanted : open)
      .sort((a, b) => seats.get(a).length - seats.get(b).length)[0];
    if (target1) place(p.id, target1);
  }

  // Проход 3 — починка перекоса. Уверенных не трогаем: платит тот, кто и так гуляет.
  // Меняем местами лишнего (роль сверх минимума) на нужного из пачки, где его избыток.
  for (const role of ['Tank', 'Healer']) {
    for (const needy of ALL_SLOTS) {
      if (has(needy, role) >= ROLE_MINIMUM[role]) continue;
      const donor = ALL_SLOTS
        .filter((k) => k !== needy && has(k, role) > ROLE_MINIMUM[role])
        .sort((a, b) => has(b, role) - has(a, role))[0];
      if (!donor) continue; // столько танков/хилов в гильдии просто нет — не выдумываем

      const conf = (id) => info.get(id)?.confidence ?? Infinity; // расставленных ранее не двигаем
      const giver = seats.get(donor).filter((id) => roleOf(id) === role)
        .sort((a, b) => conf(a) - conf(b))[0];
      // Отдаём того, чья роль в пачке представлена сверх минимума, — иначе, забрав
      // его, мы бы создали в этой пачке новую нехватку вместо починенной.
      const spare = seats.get(needy)
        .filter((id) => has(needy, roleOf(id)) > (ROLE_MINIMUM[roleOf(id)] || 0))
        .sort((a, b) => conf(a) - conf(b))[0];
      if (!giver || !spare) continue;

      seats.set(donor, seats.get(donor).map((id) => (id === giver ? spare : id)));
      seats.set(needy, seats.get(needy).map((id) => (id === spare ? giver : id)));
    }
  }

  // ---- Собираем результат ----
  const keptById = new Map(kept.map((a) => [a.playerId, a]));
  const assignments = [];
  const reasons = {};
  const fresh = [];
  for (const slot of ALL_SLOTS) {
    const { side, group } = parseSlot(slot);
    for (const id of seats.get(slot)) {
      if (keptById.has(id)) { assignments.push(keptById.get(id)); continue; }
      assignments.push({ playerId: id, side, group, ...extrasFor(history, id, slot) });
      fresh.push(id);
      const prefs = info.get(id)?.prefs || [];
      const hit = prefs.find((p) => p.slot === slot);
      reasons[id] = hit
        ? { side, group, hits: hit.hits, total: hit.total, share: hit.share }
        : { side, group, hits: 0, total: prefs[0]?.total || 0, share: 0 };
    }
  }

  // План дописываем последним: fillTimings нужен готовый список расстановки, чтобы
  // раскрывать групповые ссылки и понимать, кто вообще в клетке стоит.
  const timings = fillTimings(history, readPlan(target), assignments, fresh);

  return {
    assignments,
    timings,
    groupLanes: suggestLanes(history, target?.groupLanes || {}),
    reasons,
    added: assignments.length - kept.length,
    skipped: pool.filter((p) => !taken.has(p.id)).map((p) => p.id)
  };
};
