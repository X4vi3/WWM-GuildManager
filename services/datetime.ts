// Помощники для времени событий с учётом часовых поясов.
// Идея: храним абсолютный момент (ISO instant) — startsAt. При создании человек вводит
// стенные часы (дату+время) в выбранном поясе, мы превращаем их в момент. Показываем —
// каждому в его поясе (на сайте) или в фиксированном (МСК в Телеге).

// Сроки закрытия регистрации приходят с сервера (GET /api/lifecycle) и настраиваются
// по типу события. До ответа сервера (и офлайн) работает умолчание — 10 минут.
export interface LifecycleTypeConfig {
  closeAfterMin: number;              // регистрация закрывается через N минут после старта
  deleteAfterMin: number | null;      // для анонсов в мессенджерах; null = не удалять
}
export type LifecycleConfig = Record<string, LifecycleTypeConfig>;

const DEFAULT_CLOSE_MIN = 10;
let lifecycleConfig: LifecycleConfig | null = null;

// Вызывается из App после загрузки конфига (и при живом обновлении по SSE)
export const setLifecycleConfig = (cfg: LifecycleConfig | null) => { lifecycleConfig = cfg; };

// Срок закрытия (мс) для типа события; неизвестный тип — умолчание
export const closeMsFor = (type?: string): number =>
  (lifecycleConfig?.[type ?? '']?.closeAfterMin ?? DEFAULT_CLOSE_MIN) * 60_000;

// Пояс устройства пользователя (для дефолта при создании и показа «своего» времени)
export const localTz = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow'; }
  catch { return 'Europe/Moscow'; }
};

// Дружелюбные подписи к часто используемым поясам гильдии
const TZ_LABELS: Record<string, string> = {
  'Europe/Moscow': 'МСК · Москва',
  'Europe/Paris': 'CET · Париж'
};
export const tzLabel = (tz: string): string => TZ_LABELS[tz] || tz;

// Смещение пояса (мс) в конкретный момент: (стенные часы пояса) − UTC
const tzOffsetMs = (instant: number, timeZone: string): number => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instant))) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - instant;
};

// Стенные часы (date=YYYY-MM-DD, time=HH:MM) в поясе tz → абсолютный момент (ISO).
// Возвращает null, если даты/времени нет.
export const zonedToInstant = (date?: string, time?: string, tz?: string): string | null => {
  if (!date || !time) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const zone = tz || localTz();
  const y = +dm[1], mo = +dm[2], d = +dm[3], h = +tm[1], mi = +tm[2];
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi);
  let instant = naiveUTC - tzOffsetMs(naiveUTC, zone);
  instant = naiveUTC - tzOffsetMs(instant, zone); // уточнение на случай перехода на летнее время
  return new Date(instant).toISOString();
};

// Обратно: момент → стенные часы в поясе (для предзаполнения формы при редактировании)
export const instantToZoned = (startsAt: string, tz: string): { date: string; time: string } => {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(startsAt))) map[p.type] = p.value;
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
};

// Показ момента в заданном поясе (по умолчанию — пояс зрителя): «пт, 30.06, 22:30»
export const fmtInstant = (startsAt: string, lang: 'ru' | 'en', tz?: string): string => {
  const dtf = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', {
    timeZone: tz || localTz(),
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  return dtf.format(new Date(startsAt)).replace(',', '');
};

// Стенной день (YYYY-MM-DD) словами: «24 августа» / «24 August».
// Именно словами и без пояса: это не момент времени, а дата, которую человек назвал
// сам («вернусь 24-го»). Гонять её через часовой пояс зрителя значит показать
// парижанину 23-е там, где написали 24-е.
export const fmtDay = (day: string, lang: 'ru' | 'en'): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return day || '';
  const dtf = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric', month: 'long', timeZone: 'UTC'
  });
  return dtf.format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
};

// Закрыта ли регистрация (прошёл настроенный срок после старта). Без startsAt — не закрывается.
export const isEventClosed = (startsAt?: string, type?: string, now: number = Date.now()): boolean =>
  !!startsAt && now > new Date(startsAt).getTime() + closeMsFor(type);
