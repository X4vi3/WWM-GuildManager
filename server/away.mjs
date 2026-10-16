// Недоступность игрока: отпуск, болезнь, «пропал по жизненным обстоятельствам».
//
// Зачем отдельным файлом без сети: пометка не просто рисует бейдж — она правит
// чужие заявки и вынимает человека из уже собранных составов. Ошибка тут тихая и
// необратимая, поэтому подбор живёт чистой функцией и покрыт тестами, как
// autofill.mjs, nickmatch.mjs и discord_embed.mjs. Фронт импортирует этот же файл,
// чтобы реализация была одна (в tsconfig включён allowJs): офицер применяет пометку
// локально и сохраняет всё состояние целиком, зритель — через /api/unavailable, и
// оба обязаны получить одинаковый результат.
//
// Зеркало types.ts: сервер на .mjs, импортировать оттуда нельзя.

// Пояс, в котором читаются даты возвращения. Взят тот же, что у Телеграма: даты
// вводит русская часть гильдии, и «вернётся 24-го» должно значить 24-е по Москве
// у всех, независимо от того, из какого пояса смотрит зритель.
export const GUILD_TZ = 'Europe/Moscow';

// Смещение пояса (мс) в конкретный момент: (стенные часы пояса) − UTC.
// Повторяет services/datetime.ts — сервер тот файл не видит, а тащить сюда .ts
// нельзя. Меняется только вместе с ним.
const tzOffsetMs = (instant, timeZone) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(instant))) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - instant;
};

/**
 * Момент, когда недоступность кончается: полночь дня возвращения по поясу гильдии.
 *
 * Поле подписано «Вернётся», а не «до», намеренно: «недоступен до 24-го» каждый
 * понимает по-своему, а «вернётся 24-го» — однозначно. Поэтому событие в сам день
 * возвращения человеку уже доступно.
 *
 * Без даты недоступность бессрочна — Infinity, а не «никогда»: так все сравнения
 * ниже пишутся одинаково, без отдельной ветки на каждый случай.
 */
export const returnsAtMs = (until) => {
  if (!until) return Infinity;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(until));
  if (!m) return Infinity;
  const naiveUTC = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // Второй проход уточняет ответ на переходе на летнее время (в Москве его нет,
  // но пояс — настройка, и на Париже без этого можно промахнуться на час).
  const rough = naiveUTC - tzOffsetMs(naiveUTC, GUILD_TZ);
  return naiveUTC - tzOffsetMs(rough, GUILD_TZ);
};

/** Недоступен ли игрок прямо сейчас. Метка гаснет сама — хранить это не нужно. */
export const isAway = (player, now = Date.now()) => {
  const u = player?.unavailable;
  if (!u) return false;
  return now < returnsAtMs(u.until);
};

/**
 * Момент старта события. Источник правды — startsAt (абсолютный).
 *
 * Если его нет (совсем старые сохранения, где были только date/time), возвращаем
 * null и такое событие НЕ трогаем: лучше оставить лишнюю заявку, чем вычистить
 * человека из состава, про который мы не знаем даже, прошёл он или нет.
 */
const startMs = (session) => {
  const at = session?.event?.startsAt;
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * События, которых пометка касается: настоящие события (не шаблоны расстановки),
 * ещё не начавшиеся и попадающие в период отсутствия.
 *
 * Про шаблоны — главная ловушка проекта: в sessions лежат и события, и шаблоны, и
 * отличаются они только наличием event. Шаблон собирают месяцами и переиспользуют;
 * вычистить из него человека из-за двухнедельного отпуска значит сломать заготовку
 * навсегда, поэтому фильтр по s.event здесь обязателен.
 */
export const affectedSessions = (sessions, unavailable, now = Date.now()) => {
  const until = returnsAtMs(unavailable?.until);
  return (sessions || []).filter((s) => {
    if (!s?.event) return false;
    const at = startMs(s);
    return at !== null && at > now && at < until;
  });
};

/**
 * Применить пометку к состоянию. Возвращает новые players/sessions — ничего не
 * мутирует, чтобы React увидел изменение, а сервер мог сравнить до/после.
 *
 * mark = { note?, until? } — поставить, null — снять.
 *
 * Снятие НИЧЕГО не откатывает: проставленные «Не иду» остаются, человек
 * перезаписывается сам. Так «не иду», сказанное осознанно до отпуска, не пропадает
 * при возвращении, и нам не нужно помнить, кто какую заявку поставил.
 */
export const applyAway = ({ players, sessions }, playerId, mark, now = Date.now()) => {
  const exists = (players || []).some((p) => p.id === playerId);
  if (!exists) return { players: players || [], sessions: sessions || [], changed: [] };

  if (!mark) {
    return {
      players: (players || []).map((p) => {
        if (p.id !== playerId) return p;
        const next = { ...p };
        delete next.unavailable;
        return next;
      }),
      sessions: sessions || [],
      changed: []
    };
  }

  const unavailable = {
    since: new Date(now).toISOString(),
    ...(mark.note ? { note: String(mark.note) } : {}),
    ...(mark.until ? { until: String(mark.until) } : {})
  };

  const affected = new Set(affectedSessions(sessions, unavailable, now).map((s) => s.id));

  return {
    players: (players || []).map((p) => (p.id === playerId ? { ...p, unavailable } : p)),
    sessions: (sessions || []).map((s) => {
      if (!affected.has(s.id)) return s;
      const next = { ...s };
      // «Не иду» вместо молчания: офицер должен видеть отказ явно, иначе человек
      // выглядит как просто не ответивший и его продолжают ждать.
      next.signups = { ...(s.signups || {}), [playerId]: 'out' };
      next.signupMeta = { ...(s.signupMeta || {}), [playerId]: { from: 'site', at: new Date(now).toISOString() } };
      // Место в группе освобождается сразу: состав не должен врать в ту сторону,
      // где офицер узнаёт о дыре в момент боя.
      next.assignments = (s.assignments || []).filter((a) => a.playerId !== playerId);
      return next;
    }),
    changed: [...affected]
  };
};
