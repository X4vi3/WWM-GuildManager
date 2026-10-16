// Правила заливки записей на YouTube: заголовок, дата боя, разбор ошибок.
//
// Без сети и без состояния, поэтому покрыто тестами (tests/ytmeta.test.mjs) и
// импортируется КАК ЕСТЬ и сервером, и фронтом (allowJs в tsconfig). Вторая
// реализация означала бы, что проверяется одна, а работает другая — а ошибиться
// тут легко: заголовок уходит на публичный канал гильдии и правится потом руками.

/** Категории отказов. У каждой свой текст и свой вывод для человека. */
export const ERR = {
  NETWORK: 'network',   // до YouTube ничего не доехало
  ACCESS: 'access',     // токен отозван или недействителен — чинится на сервере
  QUOTA: 'quota',       // кончился дневной лимит, сброс в полночь по тихоокеанскому
  API: 'api'            // всё остальное
};

// Признаки исчерпанной квоты. Именно reason, а не код: 403 бывает и про доступ.
const QUOTA_REASONS = new Set([
  'quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'uploadLimitExceeded'
]);

/**
 * Что это было за падение. На вход — статус и разобранное тело ответа Google
 * (или ничего, если запрос вообще не дошёл).
 */
export const classifyError = (status, body) => {
  if (!status) return ERR.NETWORK;                     // fetch не состоялся
  const errors = body?.error?.errors || [];
  const reason = errors[0]?.reason || body?.error?.status || '';
  if (QUOTA_REASONS.has(reason)) return ERR.QUOTA;
  if (status === 401) return ERR.ACCESS;
  if (status === 403) {
    // 403 без «квотного» reason — это обычно отозванный доступ
    return QUOTA_REASONS.has(reason) ? ERR.QUOTA : ERR.ACCESS;
  }
  if (status >= 500) return ERR.NETWORK;               // сервер Google прилёг — по сути та же сеть
  return ERR.API;
};

/** Стоит ли повторять. Сеть и 5xx — да; отозванный доступ и квота — бессмысленно. */
export const worthRetry = (kind) => kind === ERR.NETWORK;

/**
 * Дата боя по пачке файлов — время самого РАННЕГО.
 * Бои идут за полночь: запись, начатая в 23:50, и запись, начатая в 00:20, — это
 * один и тот же бой. Возьми мы «сегодня» или самый поздний файл, половина пачки
 * уехала бы под завтрашним числом.
 *
 * files: [{ lastModified: number }] — так их отдаёт браузер (File.lastModified),
 * это то же самое время изменения файла, что берёт десктоп через getmtime.
 */
export const battleDate = (files, tzOffsetMin = new Date().getTimezoneOffset()) => {
  const stamps = (files || []).map(f => Number(f?.lastModified)).filter(n => Number.isFinite(n) && n > 0);
  if (!stamps.length) return '';
  const earliest = Math.min(...stamps);
  // Дата в местном поясе человека, а не в UTC: бой в 23:50 по Москве в UTC уже завтра.
  const local = new Date(earliest - tzOffsetMin * 60000);
  return local.toISOString().slice(0, 10);
};

/** Убираем то, что YouTube в заголовке не любит, и режем по пределу в 100 символов. */
export const sanitizeTitle = (s) => String(s ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * Итоговый заголовок: `<ник> [дата] vs <враг>`.
 * Хвост можно заменить целиком (человек правит строку руками), а префикс —
 * отключить для отдельного клипа, как на десктопе.
 */
export const buildTitle = ({ nick, date, enemy, tail = '', prefix = true }) => {
  // Без соперника «vs» не пишем: заголовок «Ник [дата] vs» выглядит обрезанным,
  // а такое уезжает на публичный канал и правится потом руками.
  const foe = String(enemy ?? '').trim();
  const body = tail != null && String(tail).trim()
    ? String(tail).trim()
    : (foe ? `vs ${foe}` : '');
  if (!prefix) return sanitizeTitle(body);
  const head = [nick, date ? `[${date}]` : ''].filter(Boolean).join(' ');
  return sanitizeTitle([head, body].filter(Boolean).join(' '));
};

/**
 * Разобрать заголовок обратно: `<ник> [дата] vs <враг>` → части.
 *
 * Нужно галерее: по этим трём полям работают фильтры «чей бой», «когда» и
 * «против кого» — того, чего у YouTube нет вовсе, там только строка целиком.
 *
 * Разбор нарочно снисходительный. На канале лежат записи, набитые ещё
 * десктопом и переименованные руками: бывает без «vs», бывает с произвольным
 * хвостом. Такие мы не выбрасываем — просто оставляем поля пустыми.
 */
export const parseTitle = (title) => {
  const s = String(title ?? '').trim();
  const m = s.match(/^(.*?)\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
  if (!m) return { nick: '', date: '', enemy: '', tail: s };
  const tail = m[3].trim();
  const vs = tail.match(/^vs\s+(.+)$/i);
  return {
    nick: m[1].trim(),
    date: m[2],
    enemy: vs ? vs[1].trim() : '',
    tail
  };
};

/** Сколько id влезает в один запрос videos.list. Предел YouTube, не наш. */
export const ID_BATCH = 50;

/** Длительность ISO 8601 (`PT1H2M3S`) в секунды. 0 — если не разобрали. */
export const durationSeconds = (iso) => {
  const m = String(iso ?? '').match(/^P(?:([\d.]+)D)?T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Math.round((+d || 0) * 86400 + (+h || 0) * 3600 + (+min || 0) * 60 + (+s || 0));
};

/** Секунды в «7:04» или «1:12:30». Ноль — пусто: врать про длительность не надо. */
export const clock = (sec) => {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  if (!n) return '';
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

/**
 * Свести ответ `videos.list` к тому, что нужно галерее.
 *
 * Зачем вообще второй запрос, если список загрузок уже дал заголовки: он даёт их
 * и у **удалённых** записей — YouTube выметает их из списка не сразу. Живые видео
 * `videos.list` возвращает, мёртвые молча пропускает, поэтому сверка по нему и
 * есть проверка «оно ещё существует».
 *
 * Заодно оттуда же берётся то, из-за чего плеер на странице оказывается пустым.
 * Возрастное ограничение YouTube ставит **сам**, а снять его через API нельзя:
 * `contentDetails` на запись не отдаётся вовсе. Значит показать такую запись во
 * встроенном плеере мы не можем в принципе — и единственное честное поведение
 * это сказать об этом и увести на YouTube, а не оставлять чёрный прямоугольник.
 */
export const videoFacts = (v) => {
  const sn = v?.snippet || {};
  const st = v?.status || {};
  const cd = v?.contentDetails || {};
  return {
    id: v?.id || '',
    title: sn.title || '',
    thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
    at: sn.publishedAt || '',
    privacy: st.privacyStatus || '',
    seconds: durationSeconds(cd.duration),
    // Пусто — играется у нас. Иначе причина, и она разная на вид для человека.
    blocked: cd.contentRating?.ytRating === 'ytAgeRestricted' ? 'age'
      : st.embeddable === false ? 'noembed'
        : (st.uploadStatus && st.uploadStatus !== 'processed') ? 'processing'
          : ''
  };
};

/** Куски по 16 МиБ — размер проверен на десктопе; файл в память целиком не читаем. */
export const CHUNK_SIZE = 16 * 1024 * 1024;

/**
 * Сколько клипов льём разом. Дело не только в канале человека: браузер держит
 * не больше ШЕСТИ одновременных соединений к одному хосту, а все куски уходят
 * на googleapis.com. Шестое место оставляем служебным запросам.
 */
export const MAX_PARALLEL = 5;

/** Дневной предел загрузок на весь проект Google (не на человека). */
export const DAILY_LIMIT = 100;

/** Задержка перед повтором: 1, 2, 4, 8 секунд плюс разброс, чтобы не бить в такт. */
export const retryDelay = (attempt, rnd = Math.random) =>
  Math.round((2 ** attempt) * 1000 * (0.75 + rnd() * 0.5));
