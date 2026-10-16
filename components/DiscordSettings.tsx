import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Glyph from './glyphs';
import {
  api, DiscordConfig, DiscordChannel, DiscordGuild, DiscordRole, RouteCell, TgConfig, YtStatus, YtSetup
} from '../services/api';
import { LifecycleConfig } from '../services/datetime';
import { EVENT_TYPES, EVENT_TYPE_LABELS, EVENT_TYPE_ICONS, WEAPON_SCHOOL_IMAGES } from '../constants';
import { GuildEventType, WEAPON_SCHOOLS, Player, Role } from '../types';
import { IMAGES } from '../images';
import { useT } from '../services/i18n';
import { toast, confirm } from './Notifications';
import LinksPanel from './LinksPanel';
import Hint from './Hint';

// Страница «Интеграции» (только офицер): Discord, Телеграм, сроки событий и
// таблица «кто к чему подключён». Раскладка в две колонки — раньше всё шло
// одним столбцом и страница тянулась вниз при пустых полях по бокам.

type EventType = GuildEventType;

// Сколько каналов можно отметить в одной клетке «день × тип». Тот же предел стоит на
// сервере (server/discord.mjs, MAX_CHANNELS_PER_CELL) — там он режет лишнее молча,
// поэтому здесь его нужно показать офицеру ДО сохранения.
const MAX_CHANNELS_PER_CELL = 5;

// Права, которые бот просит при добавлении на сервер. Ровно четыре — сверено с тем,
// какие запросы к Discord он реально делает (server/discord.mjs):
//
//   View Channels + Send Messages — публиковать анонс и сообщение с кнопкой,
//   Embed Links                   — анонс это embed, без этого он не отрисуется,
//   Use External Emojis           — значки школ оружия в анонсе.
//
// Чего он НЕ просит и почему (просить лишнее — пугать офицера и получать отказ):
//   Manage Roles     — роль-гейт регистрации только ПРОВЕРЯЕТ роль у нажавшего
//                      (passesGate читает interaction.member.roles), не выдаёт её.
//   Manage Messages  — бот правит и удаляет ТОЛЬКО свои сообщения, а для своих это
//                      право не требуется.
//   Read Msg History — историю канала бот не читает: он правит анонс по known id.
//   Add Reactions    — реакций бот не ставит ни одной.
const BOT_PERMISSION_LABELS = [
  'смотреть каналы', 'писать сообщения', 'вставлять ссылки', 'внешние эмодзи'
] as const;
const BOT_PERMISSIONS = [
  1 << 10,  // View Channels
  1 << 11,  // Send Messages
  1 << 14,  // Embed Links
  1 << 18   // Use External Emojis
].reduce((a, b) => a + b, 0);

// Ссылка-приглашение в современной форме. integration_type=0 обязателен: без него
// Discord для приложений, поддерживающих установку «пользователю», игнорирует наши
// scope и permissions и показывает вместо них Default Install Settings из Developer
// Portal — экран согласия тогда выглядит как «Add a bot / Create commands» без списка
// прав. С integration_type=0 запрашивается установка именно на сервер.
const inviteUrl = (applicationId: string) =>
  'https://discord.com/oauth2/authorize' +
  `?client_id=${encodeURIComponent(applicationId)}` +
  `&permissions=${BOT_PERMISSIONS}` +
  '&integration_type=0' +
  '&scope=bot';

// Иконки ролей — те же, что на сайте. Имена эмодзи должны проходить проверку сервера
// (`[a-z0-9_]{2,32}`), поэтому не «Tank», а role_tank.
const ROLE_EMOJI_NAMES: Record<Role, string> = {
  [Role.TANK]: 'role_tank',
  [Role.DPS]: 'role_dps',
  [Role.HEALER]: 'role_heal'
};

const ROLE_IMAGE_BY_ROLE: Record<Role, string> = {
  [Role.TANK]: IMAGES.tank,
  [Role.DPS]: IMAGES.dps,
  [Role.HEALER]: IMAGES.healer
};

// Сколько всего эмодзи должно быть залито: школы оружия плюс три роли.
const EXPECTED_EMOJI_COUNT = WEAPON_SCHOOLS.length + Object.keys(ROLE_EMOJI_NAMES).length;

// Discord рисует эмодзи в КВАДРАТНОЙ ячейке. Исходные иконки к этому не готовы:
// они неквадратные (примерно 170×200) и на 20–47% состоят из прозрачных полей.
// В результате сам рисунок занимал чуть больше половины ячейки, а остальное
// превращалось в воздух — из-за него два значка школ в анонсе стояли с большим
// разрывом, будто между ними пробел.
//
// Поэтому перед загрузкой: обрезаем прозрачные поля по фактическим границам рисунка
// и вписываем его в квадрат 128×128 (рекомендованный Discord размер — заодно уходит
// мыло от растягивания 42-пиксельных исходников).
const EMOJI_SIZE = 128;

const toEmojiImage = (src: string): Promise<string> => new Promise((resolve, reject) => {
  const img = new Image();
  img.onerror = () => reject(new Error('image'));
  img.onload = () => {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const probe = document.createElement('canvas');
      probe.width = w; probe.height = h;
      const pctx = probe.getContext('2d');
      if (!pctx) return reject(new Error('canvas'));
      pctx.drawImage(img, 0, 0);
      const data = pctx.getImageData(0, 0, w, h).data;

      // Границы непрозрачной части. Порог 8, а не 0: у апскейленных картинок по краю
      // остаётся почти прозрачный ореол, и по нему рамка вышла бы больше рисунка.
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; } // картинка целиком прозрачная
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

      const out = document.createElement('canvas');
      out.width = EMOJI_SIZE; out.height = EMOJI_SIZE;
      const octx = out.getContext('2d');
      if (!octx) return reject(new Error('canvas'));
      octx.imageSmoothingQuality = 'high';
      // Вписываем целиком, сохраняя пропорции: обрезать рисунок нельзя — у оружия
      // отрежется остриё.
      const scale = Math.min(EMOJI_SIZE / cw, EMOJI_SIZE / ch);
      const dw = cw * scale, dh = ch * scale;
      octx.drawImage(img, x0, y0, cw, ch, (EMOJI_SIZE - dw) / 2, (EMOJI_SIZE - dh) / 2, dw, dh);
      resolve(out.toDataURL('image/png'));
    } catch (e) {
      reject(e as Error);
    }
  };
  img.src = src;
});

// Пояснения к настройкам, которые невозможно понять по одной подписи. Ключ перевода
// в проекте — сама русская строка (services/i18n.tsx), поэтому тут лежат готовые
// русские тексты, а не короткие коды: с кодом вида 'hintGuild' в русском режиме на
// экране появился бы именно 'hintGuild'.
const HINTS = {
  invite: 'На первом экране согласия Discord показывает НЕ права, а доступы приложения: «Add a bot to a Server» и «Create commands». Это разные вещи. Доступы — про саму программу, поэтому они одинаковы, какой сервер ни выбери; права (смотреть каналы, писать, ссылки, эмодзи) — про конкретный сервер, и они на СЛЕДУЮЩЕМ экране: кнопка внизу подписана Continue, а не Authorize, — значит шаг не последний. «Create commands» мы не просим, Discord добавляет его к боту сам; вреда нет, слэш-команд у бота не бывает вовсе. Настоящая проверка не на этих экранах, а после: создайте событие в день с отмеченным каналом. Карточка вышла — прав хватает. Не вышла — Настройки сервера → Роли → бот, включить четыре права из списка выше (или выдать их только в нужном канале).',
  guild: 'Один бот может состоять сразу в нескольких серверах Discord. Здесь выбирается тот, где живёт гильдия: из него берутся списки каналов и ролей, в него уходят анонсы.',
  pingRole: 'Роль, которую бот упомянет над карточкой анонса, чтобы пришло уведомление. Упоминание стоит в тексте над карточкой, а не внутри неё — внутри Discord никого не пингует. Не выбрано — анонс выйдет тихо, без уведомления.',
  registerChannel: 'Канал, в котором живёт сообщение с кнопкой «Зарегистрироваться». Нажав её, игрок привязывает свой аккаунт Discord к нику в составе — после этого он может отмечаться на события кнопками прямо в анонсе.',
  registerRole: 'Кто вообще допущен до этой кнопки регистрации. Если роль выбрана, привязать себя смогут только те, у кого она есть — так на сервере с посторонними в состав не запишется случайный человек. Бот только ПРОВЕРЯЕТ наличие роли и никому её не выдаёт. Оставить «доступно всем» — сможет любой, кто видит канал.',
  postButton: 'Публикует в выбранном канале сообщение с кнопкой регистрации. Достаточно один раз: дальше сообщение живёт в канале само. Кнопка недоступна, пока выбранный канал не сохранён — иначе сообщение ушло бы не туда.',
  dm: 'Включено — тем, кто подписался на напоминания, бот пришлёт карточку события ещё и в личные сообщения. Выключено — карточка выйдет только в канале (или в теме беседы), в личку не уйдёт ничего. На сам анонс и на возможность отмечаться это не влияет, меняется только доставка.',
  remind: '«Молчун» — тот, кто на событие вообще не ответил: ни «иду», ни «не иду». За указанное число минут до начала бот напомнит в личку только им, чтобы не дёргать тех, кто уже определился. Ноль — не напоминать совсем.',
  emojis: 'Загружает в Discord иконки школ оружия и ролей (танк/дд/хил) как эмодзи приложения — их видно в анонсе вместо стандартных значков. Слоты эмодзи сервера они не занимают. Картинки берутся из вашего браузера: на сервере сайта их нет, они защищены авторским правом и в репозиторий не попадают. Повторная загрузка ЗАМЕНЯЕТ уже залитые значки, и Discord выдаёт им новые id — в уже опубликованных анонсах старые значки могут показаться текстом, пока анонс не обновится.',
  lifecycleClose: 'Через сколько минут после начала события закрыть запись. Закрытое событие остаётся видно и на сайте, и в анонсе, но кнопки отметиться исчезают — состав больше не меняется.',
  lifecycleDelete: 'Через сколько минут после начала удалить сообщение-анонс из канала и беседы. По умолчанию выключено: потерять историю обычно хуже, чем оставить лишний анонс. Нажмите значок в строке, чтобы включить.'
} as const;

// Дни недели пн…вс (в ключе клетки хранится номер по JS: вс=0)
const DAYS: { key: number; short: string; full: string }[] = [
  { key: 1, short: 'Пн', full: 'Понедельник' },
  { key: 2, short: 'Вт', full: 'Вторник' },
  { key: 3, short: 'Ср', full: 'Среда' },
  { key: 4, short: 'Чт', full: 'Четверг' },
  { key: 5, short: 'Пт', full: 'Пятница' },
  { key: 6, short: 'Сб', full: 'Суббота' },
  { key: 0, short: 'Вс', full: 'Воскресенье' }
];

const cellKey = (day: number, type: EventType) => `${day}:${type}`;

// Раскрывать список вверх, если снизу не хватает экрана (нижние строки таблицы).
// useLayoutEffect — замер до отрисовки, поэтому переворот не мигает.
const useFlipUp = (ref: React.RefObject<HTMLDivElement | null>) => {
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const noRoomBelow = r.bottom > window.innerHeight - 8;
    const roomAbove = r.top > r.height;   // над клеткой места хватает
    if (noRoomBelow && roomAbove) setUp(true);
  }, [ref]);
  return up;
};

// Общие классы всплывающего списка
const popupClass = (up: boolean, alignRight: boolean, accentBorder: string) =>
  `absolute z-50 w-56 bg-slate-900 border ${accentBorder} rounded-lg shadow-lg overflow-hidden ` +
  `${up ? 'bottom-full mb-1' : 'top-full mt-1'} ${alignRight ? 'right-0' : 'left-0'}`;

// ---------------------------------------------------------------------------
// Раздел настроек. Без карточки: рамка вокруг каждого блока внутри и без того
// обведённой группы давала двойную обводку, а вместе с внутренними отступами
// съедала половину высоты страницы. Разделяет блоки одна волосяная линия —
// по правилу проекта глубину даёт рамка и ступень поверхности, а не коробки.
//
// Без overflow-hidden: он обрезал выпадающие списки в нижних строках таблицы.
const Section: React.FC<{ icon: string; title: string; hint?: string; extra?: React.ReactNode; children: React.ReactNode }> =
  ({ icon, title, hint, extra, children }) => (
    <section className="min-w-0 border-t border-slate-800 pt-5">
      <div className="flex items-center gap-3 flex-wrap">
        <i className={`${icon} text-slate-500 text-sm`}></i>
        <h3 className="cinzel text-lg font-semibold text-slate-200">{title}</h3>
        {extra}
      </div>
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );

// Крупная группа: одна платформа (или «общее»). Раньше блоки шли вперемешку
// в две колонки, и было непонятно, что к Discord, а что к Телеграму.
// Теперь группа и есть единственная поверхность на странице: карточки у разделов
// внутри убраны, поэтому обводка ровно одна, а не вложенная сама в себя.
// Разделы внутри группы раскладываются газетными колонками, а не сеткой. Сетка
// выравнивала строки по самому высокому блоку, и рядом с длинным разделом под
// коротким зияла дыра в треть экрана; колонки просто перетекают, поэтому пустот
// не бывает в принципе, а ширина занята целиком. Пустых колонок тоже не бывает:
// невыведенный раздел не занимает места вовсе.
// Число колонок задаётся группой: у Телеграма и «Общих» разделов всего два, и
// третья колонка осталась бы пустой третью ширины.
const COLUMN_FLOW = '[&>*]:break-inside-avoid [&>*]:mb-8 [&>*]:last:mb-0 gap-x-10';
const COLUMNS: Record<number, string> = {
  2: `lg:columns-2 ${COLUMN_FLOW}`,
  3: `lg:columns-2 2xl:columns-3 ${COLUMN_FLOW}`
};

const Group: React.FC<{ icon: string; title: string; accent: string; cols?: 2 | 3 | 0; children: React.ReactNode }> =
  ({ icon, title, accent, cols = 3, children }) => (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-3 pl-1">
        <i className={`${icon} ${accent} text-base`}></i>
        <h2 className="text-xs text-slate-400">{title}</h2>
        <div className="flex-1 border-t border-slate-800"></div>
      </div>
      <div className={`bg-slate-900 border border-slate-800 rounded-2xl p-6 ${cols ? COLUMNS[cols] : 'space-y-6'}`}>
        {children}
      </div>
    </div>
  );

// Таблица «день недели × тип события» — общая вёрстка для Discord и Телеграма
const RouteTable: React.FC<{
  days: { key: number; short: string; full: string }[];
  cellValue: (day: number, type: EventType) => string[];
  renderCell: (day: number, type: EventType, ids: string[]) => React.ReactNode;
  onFillColumn: (type: EventType) => void;
  t: (s: string) => string;
}> = ({ days, cellValue, renderCell, onFillColumn, t }) => (
  <table className="w-full table-fixed border-collapse">
    <thead>
      <tr>
        <th className="w-9"></th>
        {EVENT_TYPES.map(type => (
          <th key={type} className="p-1 text-center">
            <div className="text-xs text-slate-400 truncate">
              {EVENT_TYPE_LABELS[type]}
            </div>
            <button
              onClick={() => onFillColumn(type)}
              className="text-[11px] text-slate-600 hover:text-indigo-400 transition-colors"
              title={t('Скопировать первую заполненную клетку во все дни')}
            >
              <i className="fa-solid fa-arrows-up-down mr-0.5"></i>{t('все дни')}
            </button>
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {days.map(day => (
        <tr key={day.key} className="border-t border-slate-800/60">
          <td className="py-1.5 pr-1 text-[11px] text-slate-400" title={t(day.full)}>
            {t(day.short)}
          </td>
          {EVENT_TYPES.map(type => (
            <td key={type} className="p-1 align-top">{renderCell(day.key, type, cellValue(day.key, type))}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

// Выпадающий выбор каналов для одной клетки таблицы
const ChannelPicker: React.FC<{
  channels: DiscordChannel[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  alignRight: boolean;
  t: (s: string) => string;
}> = ({ channels, selected, onChange, onClose, alignRight, t }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? channels.filter(c => c.name.toLowerCase().includes(ql)) : channels;
  }, [channels, q]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  const up = useFlipUp(ref);

  return (
    <div ref={ref} className={popupClass(up, alignRight, 'border-indigo-500/40')}>
      <div className="p-2 border-b border-slate-800">
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('Поиск канала…')}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-indigo-600"
        />
      </div>
      <div className="px-3 pt-2 text-[11px] text-slate-600">
        {t('Отмечено')} {selected.length} {t('из')} {MAX_CHANNELS_PER_CELL}
      </div>
      <div className="max-h-52 overflow-y-auto custom-scrollbar py-1">
        {list.length === 0 ? (
          <p className="text-[11px] text-slate-600 text-center py-3">{t('Ничего не найдено')}</p>
        ) : list.map(c => (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            disabled={!selected.includes(c.id) && selected.length >= MAX_CHANNELS_PER_CELL}
            title={!selected.includes(c.id) && selected.length >= MAX_CHANNELS_PER_CELL
              ? t('Достигнут предел каналов на одну клетку') : ''}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-800/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <i className={`fa-solid ${selected.includes(c.id) ? 'fa-square-check text-indigo-400' : 'fa-square text-slate-700'}`}></i>
            <span className="text-slate-500">#</span>
            <span className="truncate text-slate-300">{c.name}</span>
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <button
          onClick={() => onChange([])}
          className="w-full text-[11px] text-slate-500 hover:text-red-400 py-2 border-t border-slate-800 transition-colors"
        >
          {t('Очистить клетку')}
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
const DiscordSettings: React.FC<{ editKey: string; players: Player[] }> = ({ editKey, players }) => {
  const t = useT();
  const [cfg, setCfg] = useState<DiscordConfig | null>(null);
  // null — ещё грузим, 'error' — Discord не ответил. Раньше оба состояния были null,
  // и при недоступном Discord панель навсегда показывала «Загрузка…».
  const [guilds, setGuilds] = useState<DiscordGuild[] | 'error' | null>(null);
  const [channels, setChannels] = useState<DiscordChannel[] | 'error' | null>(null);
  const [roles, setRoles] = useState<DiscordRole[] | 'error' | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleConfig | null>(null);

  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [openCell, setOpenCell] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Телеграм — здесь же, чтобы все интеграции жили на одной странице
  const [tg, setTg] = useState<TgConfig | null>(null);
  const [tgToken, setTgToken] = useState('');

  const [draft, setDraft] = useState<{
    guildId: string; pingRoleId: string; registerChannelId: string; registerRoleId: string;
    routes: Record<string, RouteCell>; dmEnabled: boolean; remindBeforeMin: number; lang: 'ru' | 'en';
    officerRoleId: string; accessMode: 'open' | 'closed'; loginEnabled: boolean;
  }>({
    guildId: '', pingRoleId: '', registerChannelId: '', registerRoleId: '',
    routes: {}, dmEnabled: true, remindBeforeMin: 180, lang: 'ru',
    officerRoleId: '', accessMode: 'open', loginEnabled: false
  });

  // Вход на сайт: секрет вводится и больше никогда не показывается наружу
  const [secret, setSecret] = useState('');
  // Меняется по кнопке «Обновить данные Discord» — по нему панель привязок
  // перечитывает себя. Своей копии списка здесь нет намеренно: панель одна.
  const [linksToken, setLinksToken] = useState(0);

  // Оформление обложки для записей ГВГ. Живёт в данных, а не в сборке: иначе
  // на обложках другой гильдии стояло бы чужое название.
  const [yt, setYt] = useState<YtStatus | null>(null);
  const [ytSetup, setYtSetup] = useState<YtSetup | null>(null);
  const [ytId, setYtId] = useState('');
  const [ytSecret, setYtSecret] = useState('');
  // Поле управляемое, а НЕ через defaultValue: настройки приезжают с сервера
  // после первой отрисовки, и неуправляемое поле их уже не принимает — оно
  // навсегда остаётся пустым, будто сохранённого названия нет вовсе.
  const [guildName, setGuildName] = useState('');
  const [thumbPreview, setThumbPreview] = useState('');
  const bgInput = useRef<HTMLInputElement>(null);

  const applyCfg = (c: DiscordConfig) => {
    setCfg(c);
    setDraft({
      guildId: c.guildId, pingRoleId: c.pingRoleId,
      registerChannelId: c.registerChannelId, registerRoleId: c.registerRoleId,
      routes: c.routes || {},
      dmEnabled: c.dmEnabled ?? true,
      remindBeforeMin: c.remindBeforeMin ?? 180,
      lang: c.lang || 'ru',
      officerRoleId: c.officerRoleId || '',
      accessMode: c.accessMode || 'open',
      loginEnabled: !!c.loginEnabled
    });
    setDirty(false);
  };

  useEffect(() => {
    api.getDiscordConfig(editKey).then(c => c && applyCfg(c));
    api.getLifecycle().then(l => l && setLifecycle(l));
    api.getTgConfig(editKey).then(c => c && setTg(c));
    api.getYtStatus().then(setYt);
    api.getYtSetup(editKey).then(setYtSetup);
  }, [editKey]);

  // Заполненная таблица 7×3 — это много кликов. Раньше её можно было потерять,
  // просто закрыв вкладку: dirty был, а предупреждения не было.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const loadGuilds = () => { setGuilds(null); api.listDiscordGuilds(editKey).then(setGuilds); };
  const loadGuildLists = () => {
    setChannels(null); setRoles(null);
    api.listDiscordChannels(editKey).then(setChannels);
    api.listDiscordRoles(editKey).then(setRoles);
  };

  useEffect(() => {
    if (!cfg?.hasToken) { setGuilds(null); return; }
    loadGuilds();
  }, [cfg?.hasToken, editKey]);

  useEffect(() => {
    if (!cfg?.hasToken || !cfg?.guildId) { setChannels(null); setRoles(null); return; }
    loadGuildLists();
  }, [cfg?.hasToken, cfg?.guildId, editKey]);

  const interactionsUrl = `${window.location.origin}/api/discord/interactions`;
  // В dev адрес выглядит как http://localhost:3000/... — его можно скопировать и вставить
  // в Developer Portal, но Discord до него не доберётся. Об этом лучше сказать прямо.
  const isLocalUrl = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(window.location.origin);
  const noGuilds = Array.isArray(guilds) && guilds.length === 0;
  // Сужаем один раз здесь: 'error' — это строка, и `(roles || []).map` на ней падал бы
  // в рантайме, а не показывал ошибку.
  const roleList = Array.isArray(roles) ? roles : [];
  const channelList = Array.isArray(channels) ? channels : [];
  const listsFailed = roles === 'error' || channels === 'error';
  const listsLoading = roles === null || channels === null;
  // Почему выпадающий список пуст и недоступен — иначе поле просто гаснет без причины.
  const listHint = listsFailed
    ? t('Discord не ответил — список не получен.')
    : listsLoading ? t('Загружаем список из Discord…') : '';
  const patch = (p: Partial<typeof draft>) => { setDraft(d => ({ ...d, ...p })); setDirty(true); };

  const setCell = (key: string, ids: string[]) => {
    if (ids.length > MAX_CHANNELS_PER_CELL) {
      toast(t(`В одну клетку можно отметить не больше ${MAX_CHANNELS_PER_CELL} каналов.`), 'info');
      return;
    }
    setDraft(d => {
      const routes = { ...d.routes };
      if (ids.length) routes[key] = { discordChannelIds: ids };
      else delete routes[key];
      return { ...d, routes };
    });
    setDirty(true);
  };

  const fillColumn = (type: EventType) => {
    const source = DAYS.map(d => draft.routes[cellKey(d.key, type)]).find(c => c?.discordChannelIds?.length);
    if (!source) { toast(t('Сначала заполните хотя бы один день в этом столбце.'), 'info'); return; }
    setDraft(d => {
      const routes = { ...d.routes };
      for (const day of DAYS) routes[cellKey(day.key, type)] = { discordChannelIds: [...source.discordChannelIds] };
      return { ...d, routes };
    });
    setDirty(true);
  };

  const connect = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    const r = await api.putDiscordConfig(editKey, { token: token.trim() });
    setBusy(false);
    if (r === 'invalid') { toast(t('Токен не принят Discord — проверьте, что скопировали целиком.'), 'error'); return; }
    if (r === 'unreachable') { toast(t('Discord не ответил. Токен, скорее всего, верный — попробуйте ещё раз через минуту.'), 'error'); return; }
    if (r === 'error') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    applyCfg(r); setToken('');
    toast(t('Бот подключён.'), 'success');
  };

  const disconnect = async () => {
    if (busy) return;
    // Действие необратимо: токен стирается, и его придётся выпускать заново в
    // Developer Portal. Кнопка стоит вплотную к «Обновить», промахнуться легко.
    const yes = await confirm(
      t('Отключить бота? Токен будет удалён, и в Developer Portal придётся выпустить новый.'),
      { confirmLabel: t('Отключить'), danger: true }
    );
    if (!yes) return;
    setBusy(true);
    const r = await api.putDiscordConfig(editKey, { token: '' });
    setBusy(false);
    if (typeof r === 'string') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    applyCfg(r);
    toast(t('Бот отключён.'), 'info');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const r = await api.putDiscordConfig(editKey, draft);
    setBusy(false);
    if (typeof r === 'string') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    applyCfg(r);
    toast(t('Настройки сохранены.'), 'success');
  };

  const saveLifecycle = async (
    type: string,
    field: 'closeAfterMin' | 'deleteAfterMin',
    value: number | null
  ) => {
    if (!lifecycle) return;
    const next: LifecycleConfig = { ...lifecycle, [type]: { ...lifecycle[type], [field]: value } };
    setLifecycle(next);
    const r = await api.putLifecycle(editKey, next);
    if (r === 'error') toast(t('Не удалось сохранить сроки.'), 'error');
    else setLifecycle(r);
  };

  const uploadEmojis = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Школы оружия и иконки ролей — одним заходом. Каждая проходит через обрезку
      // прозрачных полей (см. toEmojiImage), иначе в анонсе значки стоят с разрывом.
      const images: Record<string, string> = {};
      for (const school of WEAPON_SCHOOLS) {
        images[school] = await toEmojiImage(WEAPON_SCHOOL_IMAGES[school]);
      }
      for (const [role, name] of Object.entries(ROLE_EMOJI_NAMES)) {
        images[name] = await toEmojiImage(ROLE_IMAGE_BY_ROLE[role as Role]);
      }
      const r = await api.syncDiscordEmojis(editKey, images);
      if (r === 'error') { toast(t('Не удалось загрузить иконки — проверьте, что бот подключён.'), 'error'); return; }
      if (r.failed > 0) {
        toast(t(`Загружено ${r.uploaded}, не удалось ${r.failed}. Всего в Discord: ${r.total}.`), 'error');
      } else {
        toast(t(`Иконки в Discord: ${r.total}`), 'success');
      }
      const fresh = await api.getDiscordConfig(editKey);
      if (fresh) applyCfg(fresh);
    } catch {
      toast(t('Не удалось прочитать иконки.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const postRegisterMessage = async () => {
    if (busy) return;
    setBusy(true);
    const r = await api.postDiscordRegisterMessage(editKey);
    setBusy(false);
    if (r === 'error') { toast(t('Не удалось опубликовать — проверьте канал регистрации и права бота.'), 'error'); return; }
    toast(r === 'updated' ? t('Сообщение с кнопкой обновлено.') : t('Сообщение с кнопкой опубликовано.'), 'success');
    // Правим только этот признак: перечитать конфиг целиком нельзя — это сбросило бы
    // незаписанный черновик вместе с заполненной таблицей маршрутов.
    setCfg(c => (c ? { ...c, registerPosted: true } : c));
  };

  const connectTg = async () => {
    if (!tgToken.trim() || busy) return;
    setBusy(true);
    const r = await api.setTgToken(editKey, tgToken.trim());
    setBusy(false);
    if (r === 'invalid') { toast(t('Токен не принят Телеграмом — проверьте, что скопировали целиком.'), 'error'); return; }
    if (r === 'error') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    // Вместе с конфигом подтягиваем таблицу тем: у нового токена может быть
    // другой список известных тем, и черновик от прошлого бота показывать нельзя
    setTg(r); setTgToken('');
    toast(t('Бот подключён.'), 'success');
  };

  // Настройки лички Телеграма сохраняются сразу, отдельно от кнопки Discord
  const saveTgDm = async (patchDm: { dmEnabled?: boolean; remindBeforeMin?: number }) => {
    const r = await api.setTgToken(editKey, undefined, patchDm);
    if (typeof r === 'string') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    setTg(r);
  };

  // ---- Таблица тем Телеграма ----
  const topicName = (threadId: string) =>
    tg?.targets?.find(x => x.threadId === threadId)?.name || '…';

  const disconnectTg = async () => {
    if (busy) return;
    const yes = await confirm(
      t('Отключить бота Телеграма? Токен будет удалён, и новый придётся брать у @BotFather.'),
      { confirmLabel: t('Отключить'), danger: true }
    );
    if (!yes) return;
    setBusy(true);
    const r = await api.setTgToken(editKey, '');
    setBusy(false);
    if (typeof r === 'string') { toast(t('Не удалось сохранить — проверьте связь.'), 'error'); return; }
    setTg(r);
    toast(t('Бот отключён.'), 'info');
  };

  // ---- Обложка записей ГВГ ----

  useEffect(() => { setGuildName(yt?.thumb?.guildName ?? ''); }, [yt?.thumb?.guildName]);

  const loadYt = () => Promise.all([
    api.getYtStatus().then(setYt),
    api.getYtSetup(editKey).then(setYtSetup)
  ]);

  const saveYtKeys = async () => {
    setBusy(true);
    const r = await api.setYtKeys(editKey, ytId.trim(), ytSecret.trim());
    setBusy(false);
    if (!r) return toast(t('Не удалось сохранить.'), 'error');
    setYtSetup(r);
    setYtSecret('');
    toast(t('Сохранено.'), 'success');
  };

  const disconnectYt = async () => {
    const ok = await confirm(t('Отключить канал? Заливка перестанет работать, пока не подключите заново.'),
      { confirmLabel: t('Отключить'), danger: true });
    if (!ok) return;
    if (await api.ytDisconnect(editKey)) { await loadYt(); toast(t('Канал отключён.'), 'success'); }
    else toast(t('Не удалось отключить.'), 'error');
  };

  // Перерисовываем предпросмотр на «живом» примере: пустая обложка ничего не
  // говорит о том, как это будет выглядеть на канале.
  const drawThumbPreview = async (style?: YtStatus['thumb']) => {
    try {
      const { renderThumb } = await import('../services/ytthumb');
      const cv = await renderThumb({ enemy: 'Enemy Guild', nick: '', date: '', style });
      setThumbPreview(cv.toDataURL('image/jpeg', 0.8));
    } catch { setThumbPreview(''); }
  };
  useEffect(() => { if (yt?.thumb) drawThumbPreview(yt.thumb); }, [yt?.thumb]);

  const saveThumb = async (patchThumb: Record<string, string>) => {
    if (!(await api.setYtThumb(editKey, patchThumb))) return toast(t('Не удалось сохранить.'), 'error');
    await loadYt();
  };

  /** Фон: приводим к 1280×720 webp прямо в браузере — на сервер уедет ~20 КБ. */
  const uploadBg = async (file: File) => {
    setBusy(true);
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('image'));
        i.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('canvas');
      // Заполняем кадр целиком, обрезая лишнее по краям, — как на десктопе
      const scale = Math.max(1280 / img.width, 720 / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (1280 - w) / 2, (720 - h) / 2, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = cv.toDataURL('image/webp', 0.82);
      const ok = await api.setYtThumbBg(editKey, dataUrl);
      toast(ok ? t('Фон обновлён.') : t('Не удалось сохранить.'), ok ? 'success' : 'error');
      if (ok) { await loadYt(); await drawThumbPreview(yt?.thumb); }
    } catch {
      toast(t('Не удалось прочитать картинку.'), 'error');
    } finally { setBusy(false); }
  };

  const channelName = (id: string) => channelList.find(c => c.id === id)?.name || '…';
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => toast(t('Ссылка скопирована.'), 'success'))
      .catch(() => toast(t('Не удалось скопировать — выделите вручную.'), 'error'));
  };
  const copyUrl = () => copy(interactionsUrl);

  // ---- Вход на сайт ----
  const callbackUrl = `${window.location.origin}/api/auth/discord/callback`;

  const saveSecret = async () => {
    setBusy(true);
    const ok = await api.setDiscordSecret(editKey, secret.trim());
    setBusy(false);
    if (!ok) return toast(t('Не удалось сохранить.'), 'error');
    setSecret('');
    const c = await api.getDiscordConfig(editKey);
    if (c) applyCfg(c);
    toast(t('Сохранено.'), 'success');
  };

  // Списки каналов и ролей нигде не хранятся — они читались только при открытии
  // панели, поэтому созданная минуту назад роль и «не появлялась». Здесь же
  // немедленно перепроверяются права всех, кто сейчас на сайте.
  const refreshDiscord = async () => {
    setBusy(true);
    loadGuildLists();
    const ok = await api.refreshDiscord(editKey);
    setLinksToken(n => n + 1);
    setBusy(false);
    toast(ok ? t('Данные обновлены.') : t('Discord не ответил.'), ok ? 'success' : 'error');
  };


  const connected = !!cfg?.hasToken;


  // Клетка таблицы: короткая подпись вместо чипов, полный список — в подсказке.
  // Чипы раздували клетку и выталкивали горизонтальный скролл на всю страницу.
  const cellButton = (
    label: React.ReactNode, filled: boolean, onClick: () => void, title?: string
  ) => (
    <button
      onClick={onClick}
      title={title}
      className={`w-full min-w-0 text-left px-2 py-1.5 rounded-lg border text-[11px] truncate transition-colors ${
        filled
          ? 'border-indigo-700/60 bg-indigo-950/30 text-indigo-200 hover:border-indigo-500'
          : 'border-slate-800 bg-slate-950 text-slate-600 hover:border-slate-600'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-8">

      {/* ============================ DISCORD ============================ */}
      <Group icon="fa-brands fa-discord" title="Discord" accent="text-indigo-400">

          <Section
            icon="fa-solid fa-plug"
            title={t('Подключение')}
            extra={connected
              ? <span className="ml-auto text-xs text-emerald-400 whitespace-nowrap"><i className="fa-solid fa-circle-check mr-1"></i>{cfg!.botUsername || cfg!.appName}</span>
              : <span className="ml-auto text-xs text-slate-500 whitespace-nowrap">{t('Не подключён')}</span>}
          >
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  {connected ? t('Сменить токен бота') : t('Токен бота (Developer Portal → Bot → Reset Token)')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') connect(); }}
                    placeholder={connected ? cfg!.tokenHint : 'MTIzNDU2Nzg5…'}
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
                  />
                  <button onClick={connect} disabled={busy || !token.trim()} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap">
                    {busy ? <i className="fa-solid fa-spinner fa-spin"></i> : (connected ? t('Обновить') : t('Подключить'))}
                  </button>
                  {connected && (
                    <button onClick={disconnect} disabled={busy} className="px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-900/60 text-sm transition-colors" title={t('Отключить')}>
                      <i className="fa-solid fa-plug-circle-xmark"></i>
                    </button>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs text-slate-400 mb-1.5">
                  {t('Адрес для приёма команд (Interactions Endpoint URL)')}
                </p>
                <div className="flex gap-2">
                  <code className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-indigo-300 overflow-x-auto whitespace-nowrap">
                    {interactionsUrl}
                  </code>
                  <button onClick={copyUrl} className="px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-indigo-300 hover:border-indigo-800 text-sm transition-colors" title={t('Скопировать')}>
                    <i className="fa-solid fa-copy"></i>
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1.5">
                  {t('Вставьте этот адрес в Developer Portal → General Information → Interactions Endpoint URL.')}
                  {isLocalUrl && <> {t('Сейчас это локальный адрес — снаружи Discord до него не достанет.')}</>}
                </p>
                {connected && (
                  <p className="text-xs mt-1.5">
                    {cfg!.endpointOkAt
                      ? <span className="text-emerald-400">
                          <i className="fa-solid fa-circle-check mr-1"></i>
                          {t('Discord обращался к этому адресу, последний раз')} {new Date(cfg!.endpointOkAt).toLocaleTimeString()}
                        </span>
                      : <span className="text-amber-400">
                          <i className="fa-solid fa-circle-exclamation mr-1"></i>
                          {t('Discord ещё ни разу не обращался по этому адресу — значит адрес не сохранён в Developer Portal либо недоступен снаружи.')}
                        </span>}
                    {cfg!.endpointFailCount > 0 && (
                      <span className="text-red-400 block mt-1">
                        {t('Запросов с неверной подписью:')} {cfg!.endpointFailCount}. {t('Обычно это значит, что бота сменили, а адрес остался от старого приложения.')}
                      </span>
                    )}
                  </p>
                )}
              </div>

              {/* Приглашение бота. applicationId сервер отдаёт с самого подключения,
                  но до этого он никак не использовался, и офицер оставался один с
                  Developer Portal — это была главная дыра онбординга. */}
              {connected && cfg!.applicationId && (
                <div className={`rounded-lg border p-3 ${noGuilds ? 'border-amber-800/60 bg-amber-950/20' : 'border-slate-800'}`}>
                  <p className="text-xs text-slate-400">
                    {noGuilds
                      ? t('Бот пока не добавлен ни на один сервер — без этого он не увидит каналы и роли.')
                      : t('Добавить бота на ещё один сервер или обновить его права:')}
                  </p>
                  <a
                    href={inviteUrl(cfg!.applicationId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mt-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
                  >
                    <i className="fa-brands fa-discord"></i>
                    {t('Пригласить бота на сервер')}
                  </a>
                  {/* Список прав виден прямо здесь, чтобы офицер мог сверить его с
                      экраном согласия Discord: если там показано что-то другое —
                      значит Discord взял Default Install Settings из Developer Portal,
                      а не нашу ссылку. */}
                  <div className="mt-2 flex items-start gap-1.5">
                    <p className="text-xs text-slate-500">
                      {t('Ссылка просит ровно четыре права:')}{' '}
                      {BOT_PERMISSION_LABELS.map((k, i) => (
                        <span key={k}>{i > 0 ? ', ' : ''}<span className="text-slate-400">{t(k)}</span></span>
                      ))}.
                    </p>
                    <Hint text={t(HINTS.invite)} />
                  </div>
                </div>
              )}

              {connected && (
                <div className="grid sm:grid-cols-2 gap-3 pt-3 border-t border-slate-800">
                  <div className="min-w-0">
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">{t('Сервер гильдии')}<Hint text={t(HINTS.guild)} /></label>
                    {guilds === null ? (
                      <p className="text-slate-500 text-xs py-2"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}</p>
                    ) : guilds === 'error' ? (
                      <p className="text-red-400 text-xs py-2">
                        {t('Discord не ответил.')}{' '}
                        <button onClick={loadGuilds} className="underline hover:text-red-300">{t('Повторить')}</button>
                      </p>
                    ) : guilds.length === 0 ? (
                      <p className="text-amber-400 text-xs py-2">{t('Бот пока не добавлен ни на один сервер.')}</p>
                    ) : (
                      <select
                        value={draft.guildId}
                        onChange={e => patch({ guildId: e.target.value })}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
                      >
                        <option value="">{t('— выберите сервер —')}</option>
                        {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="min-w-0">
                    <label className="block text-xs text-slate-400 mb-1.5">{t('Язык сообщений бота')}</label>
                    <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                      {(['ru', 'en'] as const).map(l => (
                        <button
                          key={l}
                          onClick={() => patch({ lang: l })}
                          className={`flex-1 px-3 py-1.5 rounded-lg text-xs transition-colors ${draft.lang === l ? 'bg-indigo-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                          {l === 'ru' ? 'Русский' : 'English'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {connected && (
            <Section
              icon="fa-solid fa-table-cells"
              title={t('Куда публиковать анонсы')}
              hint={t('День недели × тип события. Пустая клетка — не публиковать.')}
            >
              {!cfg?.guildId ? (
                <p className="text-slate-500 text-sm">{t('Сначала выберите сервер и сохраните.')}</p>
              ) : channels === null ? (
                <p className="text-slate-500 text-sm"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка каналов…')}</p>
              ) : channels === 'error' ? (
                <p className="text-red-400 text-sm">
                  {t('Не удалось получить каналы — Discord не ответил.')}{' '}
                  <button onClick={loadGuildLists} className="underline hover:text-red-300">{t('Повторить')}</button>
                </p>
              ) : (
                <RouteTable
                  days={DAYS}
                  t={t}
                  onFillColumn={fillColumn}
                  cellValue={(day, type) => draft.routes[cellKey(day, type)]?.discordChannelIds || []}
                  renderCell={(day, type, ids) => {
                    const key = cellKey(day, type);
                    const last = type === EVENT_TYPES[EVENT_TYPES.length - 1];
                    return (
                      <div className="relative">
                        {cellButton(
                          ids.length === 0
                            ? <span className="opacity-60">—</span>
                            : ids.length === 1 ? <>#{channelName(ids[0])}</> : <>{ids.length} {t('каналов')}</>,
                          ids.length > 0,
                          () => setOpenCell(openCell === key ? null : key),
                          ids.length ? ids.map(id => '#' + channelName(id)).join(', ') : undefined
                        )}
                        {openCell === key && (
                          <ChannelPicker
                            t={t}
                            channels={channelList}
                            selected={ids}
                            onChange={next => setCell(key, next)}
                            onClose={() => setOpenCell(null)}
                            alignRight={last}
                          />
                        )}
                      </div>
                    );
                  }}
                />
              )}
            </Section>
          )}

          {connected && (
            <Section icon="fa-solid fa-user-shield" title={t('Роли и регистрация')}>
              <div className="space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">{t('Пинговать роль')}<Hint text={t(HINTS.pingRole)} /></label>
                    <select value={draft.pingRoleId} onChange={e => patch({ pingRoleId: e.target.value })} disabled={roleList.length === 0} title={listHint}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 disabled:opacity-50">
                      <option value="">{t('— не пинговать —')}</option>
                      {roleList.map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
                    </select>
                  </div>
                  <div className="min-w-0">
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">{t('Канал для регистрации')}<Hint text={t(HINTS.registerChannel)} /></label>
                    <select value={draft.registerChannelId} onChange={e => patch({ registerChannelId: e.target.value })} disabled={channelList.length === 0} title={listHint}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 disabled:opacity-50">
                      <option value="">{t('— не настроен —')}</option>
                      {channelList.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
                    </select>
                  </div>
                  <div className="min-w-0">
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 mb-1.5">{t('Роль для доступа')}<Hint text={t(HINTS.registerRole)} /></label>
                    <select value={draft.registerRoleId} onChange={e => patch({ registerRoleId: e.target.value })} disabled={roleList.length === 0} title={listHint}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 disabled:opacity-50">
                      <option value="">{t('— доступно всем —')}</option>
                      {roleList.map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={postRegisterMessage}
                      disabled={busy || !cfg?.registerChannelId || draft.registerChannelId !== cfg?.registerChannelId}
                      className="w-full px-3 py-2 rounded-lg border border-indigo-800 text-indigo-300 hover:bg-indigo-950/40 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
                    >
                      <i className={`fa-solid ${cfg?.registerPosted ? 'fa-rotate' : 'fa-paper-plane'} mr-2`}></i>
                      {cfg?.registerPosted ? t('Обновить сообщение') : t('Опубликовать кнопку')}
                    </button>
                    <span className="ml-2 self-center"><Hint text={t(HINTS.postButton)} /></span>
                  </div>
                </div>
                {listsFailed && (
                  <p className="text-xs text-red-400">
                    {t('Роли и каналы не загрузились — Discord не ответил.')}{' '}
                    <button onClick={loadGuildLists} className="underline hover:text-red-300">{t('Повторить')}</button>
                  </p>
                )}
                <p className="text-[11px] text-slate-600">
                  {t('Кнопку достаточно опубликовать один раз. Сначала сохраните выбранный канал.')}
                </p>
              </div>
            </Section>
          )}

          {connected && (
            <Section icon="fa-solid fa-right-to-bracket" title={t('Вход на сайт')}>
              <div className="space-y-4">
                <p className="text-xs text-slate-400">
                  {t('Пока выключено, сайт работает как раньше: отметиться может любой, кто нажал «это я». Включённый вход требует, чтобы человек подтвердил себя через Discord — и тогда за чужую строку он отметиться не сможет.')}
                </p>

                <div>
                  <p className="text-xs text-slate-400 mb-1.5">{t('Адрес возврата (Redirect URL)')}</p>
                  <div className="flex gap-2">
                    <code className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-indigo-300 overflow-x-auto whitespace-nowrap">
                      {callbackUrl}
                    </code>
                    <button onClick={() => copy(callbackUrl)} title={t('Скопировать')}
                      className="px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-indigo-300 hover:border-indigo-800 text-sm transition-colors">
                      <i className="fa-solid fa-copy"></i>
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {t('Вставьте его в Developer Portal → OAuth2 → Redirects.')}
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">{t('Client secret приложения')}</label>
                  <div className="flex gap-2">
                    <input
                      type="password" value={secret} onChange={e => setSecret(e.target.value)}
                      placeholder={cfg?.hasClientSecret ? t('задан ') + cfg.secretHint : t('вставьте секрет')}
                      className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
                    />
                    <button onClick={saveSecret} disabled={busy || !secret.trim()}
                      className="px-3 py-2 rounded-lg border border-indigo-800 text-indigo-300 hover:bg-indigo-950/40 disabled:opacity-40 text-sm font-semibold transition-colors">
                      {t('Сохранить')}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {t('Developer Portal → OAuth2 → Client Secret → Reset Secret. Это пароль: сайт его больше не покажет.')}
                  </p>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <label className="block text-xs text-slate-400 mb-1.5">{t('Роль офицера')}</label>
                    <select value={draft.officerRoleId} onChange={e => patch({ officerRoleId: e.target.value })}
                      disabled={roleList.length === 0} title={listHint}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 disabled:opacity-50">
                      <option value="">{t('— только по паролю —')}</option>
                      {roleList.map(r => <option key={r.id} value={r.id}>@{r.name}</option>)}
                    </select>
                    <p className="text-[11px] text-slate-600 mt-1">
                      {t('Отдельно от роли для доступа: та обычно широкая, и офицерами стали бы все.')}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <label className="block text-xs text-slate-400 mb-1.5">{t('Кто может смотреть сайт')}</label>
                    <select value={draft.accessMode} onChange={e => patch({ accessMode: e.target.value as 'open' | 'closed' })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600">
                      <option value="open">{t('Все — отмечаются только вошедшие')}</option>
                      <option value="closed">{t('Только те, у кого привязан ник')}</option>
                    </select>
                    <p className="text-[11px] text-slate-600 mt-1">
                      {t('Закрытый режим ломает привычку «кинул ссылку — посмотрели».')}
                    </p>
                  </div>
                </div>

                <label className={`flex items-center gap-3 ${cfg?.hasClientSecret ? 'cursor-pointer' : 'opacity-50'}`}>
                  <input
                    type="checkbox" checked={draft.loginEnabled} disabled={!cfg?.hasClientSecret}
                    onChange={e => patch({ loginEnabled: e.target.checked })}
                    className="w-4 h-4 accent-indigo-600"
                  />
                  <span className="text-sm text-slate-300">{t('Включить вход через Discord')}</span>
                </label>
                {!cfg?.hasClientSecret && (
                  <p className="text-xs text-slate-500">
                    {t('Сначала сохраните client secret — без него войти будет нечем, а отмечаться уже нельзя.')}
                  </p>
                )}

                <div className="pt-1 border-t border-slate-800">
                  <button onClick={refreshDiscord} disabled={busy}
                    className="px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 disabled:opacity-40 text-sm font-semibold transition-colors">
                    <i className="fa-solid fa-rotate mr-2"></i>{t('Обновить данные Discord')}
                  </button>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {t('Перечитывает каналы и роли и тут же перепроверяет права всех, кто на сайте. Обычно роль отпадает сама в течение минуты — эта кнопка нужна, когда ждать нельзя.')}
                  </p>
                </div>
              </div>
            </Section>
          )}


          {connected && (
            <Section icon="fa-solid fa-bell" title={t('Личные напоминания и иконки')}>
              <div className="space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={draft.dmEnabled} onChange={e => patch({ dmEnabled: e.target.checked })} className="w-4 h-4 accent-indigo-600" />
                  <span className="text-sm text-slate-300">{t('Присылать карточку события в личку')}</span>
                  <Hint text={t(HINTS.dm)} />
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="number" min={0} max={1440}
                    value={draft.remindBeforeMin}
                    onChange={e => patch({ remindBeforeMin: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })}
                    disabled={!draft.dmEnabled}
                    className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-indigo-600 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-500 flex items-center gap-1.5">{t('минут до старта — напомнить молчунам (0 — не напоминать)')}<Hint text={t(HINTS.remind)} /></span>
                </div>
                <p className="text-[11px] text-slate-600">
                  {t('Подписалось:')} <span className="text-slate-200">{cfg?.subscriberCount ?? 0}</span>
                </p>
                <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-slate-800">
                  <button onClick={uploadEmojis} disabled={busy}
                    className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-indigo-700 hover:text-indigo-300 disabled:opacity-40 text-sm font-semibold transition-colors whitespace-nowrap">
                    {busy ? <i className="fa-solid fa-spinner fa-spin mr-2"></i> : <i className="fa-solid fa-upload mr-2"></i>}
                    {t('Загрузить иконки')}
                  </button>
                  <Hint text={t(HINTS.emojis)} />
                  <p className="text-xs text-slate-500 flex-1 min-w-[160px]">
                    {cfg && cfg.emojiCount > 0
                      ? `${t('Загружено иконок:')} ${cfg.emojiCount} / ${EXPECTED_EMOJI_COUNT}`
                      : t('Пока не загружены — в анонсах будут стандартные значки.')}
                  </p>
                </div>
              </div>
            </Section>
          )}
      </Group>

      {/* ============================ ТЕЛЕГРАМ ============================ */}
      <Group icon="fa-brands fa-telegram" title={t('Телеграм')} accent="text-sky-400" cols={2}>

          <Section
            icon="fa-solid fa-plug"
            title={t('Подключение')}
            extra={tg?.connected
              ? <span className="ml-auto text-xs text-emerald-400 whitespace-nowrap"><i className="fa-solid fa-circle-check mr-1"></i>@{tg.botUsername}</span>
              : <span className="ml-auto text-xs text-slate-500 whitespace-nowrap">{t('Не подключён')}</span>}
          >
            {tg === null ? (
              <p className="text-slate-500 text-sm"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={tgToken}
                    onChange={e => setTgToken(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') connectTg(); }}
                    placeholder={tg.hasToken ? tg.tokenHint : t('Токен от @BotFather')}
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-700"
                  />
                  <button onClick={connectTg} disabled={busy || !tgToken.trim()} className="bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap">
                    {busy ? <i className="fa-solid fa-spinner fa-spin"></i> : (tg.hasToken ? t('Обновить') : t('Подключить'))}
                  </button>
                  {tg.hasToken && (
                    <button onClick={disconnectTg} disabled={busy} className="px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-900/60 text-sm transition-colors" title={t('Отключить')}>
                      <i className="fa-solid fa-plug-circle-xmark"></i>
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {tg.chatId
                    ? <>{t('Тема по умолчанию:')} <span className="text-slate-200 font-semibold">{tg.threadName || tg.chatTitle || t('беседа')}</span></>
                    : <span className="text-amber-400">{t('Беседа не выбрана — добавьте бота в беседу и напишите там /sithere')}</span>}
                </p>

                {tg.hasToken && (
                  <div className="pt-3 border-t border-slate-800 space-y-3">
                    <p className="text-xs text-slate-400">{t('Напоминания в личку')}</p>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={tg.dmEnabled} onChange={e => saveTgDm({ dmEnabled: e.target.checked })} className="w-4 h-4 accent-sky-600" />
                      <span className="text-sm text-slate-300">{t('Присылать карточку события в личку')}</span>
                  <Hint text={t(HINTS.dm)} />
                    </label>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="number" min={0} max={1440}
                        defaultValue={tg.remindBeforeMin}
                        onBlur={e => saveTgDm({ remindBeforeMin: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })}
                        disabled={!tg.dmEnabled}
                        className="w-20 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-sky-700 disabled:opacity-40"
                      />
                      <span className="text-xs text-slate-500 flex items-center gap-1.5">{t('минут до старта — напомнить молчунам (0 — не напоминать)')}<Hint text={t(HINTS.remind)} /></span>
                    </div>
                    <p className="text-[11px] text-slate-600">
                      {t('Игроки подписываются сами: /start или /notify в личке боту.')}
                      {' '}{t('Подписалось:')} <span className="text-slate-200">{tg.subscriberCount ?? 0}</span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </Section>

          {tg?.hasToken && (
            <Section
              icon="fa-solid fa-comments"
              title={t('Куда публиковать анонсы')}
              hint={t('Проще всего настроить командами в самой теме — Telegram не даёт боту список тем, узнать их иначе нельзя.')}
            >
              {!tg.targets || tg.targets.length === 0 ? (
                <div className="space-y-2 text-sm">
                  <p className="text-amber-400">{t('Бот пока не знает ни одной темы.')}</p>
                  <p className="text-slate-400">{t('Зайдите в нужную тему беседы и напишите:')}</p>
                  <ul className="text-xs text-slate-400 space-y-1">
                    <li><code className="text-sky-300">/setprac</code> — {t('праки сюда')}</li>
                    <li><code className="text-sky-300">/setranked</code> — {t('ранкед сюда')}</li>
                    <li><code className="text-sky-300">/setleague</code> — {t('лигу сюда')}</li>
                  </ul>
                  <p className="text-[11px] text-slate-600">
                    {t('Название можно задать сразу: /setprac Праки. /where — показать раскладку.')}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Список известных тем: иначе увидеть их можно было только
                      раскрыв клетку таблицы, и непонятно, запомнил ли бот /sithere */}
                  <div className="flex flex-wrap items-center gap-1.5 pb-3 border-b border-slate-800">
                    <span className="text-xs text-slate-400 mr-1">
                      {t('Бот знает темы:')}
                    </span>
                    {tg.targets.map(tgt => {
                      const isDefault = String(tgt.threadId || '') === String(tg.threadId || '');
                      return (
                        <span
                          key={tgt.threadId || 'root'}
                          className={`inline-flex items-center gap-1 text-[11px] rounded-lg px-2 py-0.5 border ${
                            isDefault
                              ? 'bg-sky-950/40 border-sky-800/50 text-sky-300'
                              : 'bg-slate-950 border-slate-800 text-slate-400'
                          }`}
                          title={isDefault ? t('Тема по умолчанию') : undefined}
                        >
                          {isDefault && <i className="fa-solid fa-star text-[11px]"></i>}
                          {tgt.name}
                        </span>
                      );
                    })}
                  </div>
                  {/* Раскладка только на просмотр: настраивается командами в самой
                      теме, потому что список тем форума Telegram боту не отдаёт.
                      Редактируемая таблица тут была лишней — заполнять её нечем. */}
                  <div className="space-y-1.5">
                    {EVENT_TYPES.map(type => {
                      const ids = [...new Set(
                        DAYS.map(d => (tg.routes?.[cellKey(d.key, type)]?.threadIds || []).join(','))
                      )].filter(Boolean);
                      const sameEveryDay = ids.length === 1;
                      const names = sameEveryDay
                        ? ids[0].split(',').map(topicName).join(', ')
                        : null;
                      return (
                        <div key={type} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 text-slate-300 truncate">
                            <Glyph name={EVENT_TYPE_ICONS[type]} className="w-[1.05em] h-[1.05em] opacity-60 mr-1.5" />
                            {EVENT_TYPE_LABELS[type]}
                          </span>
                          <i className="fa-solid fa-arrow-right text-slate-700 text-[11px]"></i>
                          {names ? (
                            <span className="text-sky-300">{names}</span>
                          ) : ids.length > 1 ? (
                            <span className="text-slate-400">{t('по-разному в разные дни')}</span>
                          ) : (
                            <span className="text-slate-600">{t('тема по умолчанию')}</span>
                          )}
                          <code className="ml-auto text-[11px] text-slate-700 whitespace-nowrap">
                            /set{type === 'prak' ? 'prac' : type === 'ranked' ? 'ranked' : 'league'}
                          </code>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-slate-600 pt-2 border-t border-slate-800">
                    {t('Настраивается командой в нужной теме. /where — показать раскладку, /unsetprac и т.п. — снять.')}
                  </p>
                </div>
              )}
            </Section>
          )}
      </Group>

      {/* ============================ ОБЩЕЕ ============================ */}
      {/* ============================ ЗАПИСИ ГВГ ============================ */}
      <Group icon="fa-brands fa-youtube" title={t('Записи ГВГ')} accent="text-slate-400" cols={2}>
        <Section icon="fa-solid fa-plug" title={t('Подключение канала')}
          extra={ytSetup?.hasToken
            ? <span className="ml-auto text-xs text-emerald-400 whitespace-nowrap"><i className="fa-solid fa-circle-check mr-1"></i>{yt?.channel || t('подключён')}</span>
            : <span className="ml-auto text-xs text-slate-500 whitespace-nowrap">{t('не подключён')}</span>}>
          <div className="space-y-4">
            <p className="text-xs text-slate-400">
              {t('Гильдия заливает записи на СВОЙ канал YouTube. Нужен проект Google — он бесплатный, но завести его придётся вручную.')}
            </p>

            <div>
              <p className="text-xs text-slate-400 mb-1.5">{t('Адрес возврата (Authorised redirect URI)')}</p>
              <div className="flex gap-2">
                <code className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-indigo-300 overflow-x-auto whitespace-nowrap">
                  {ytSetup?.redirectUri || '…'}
                </code>
                <button onClick={() => ytSetup && copy(ytSetup.redirectUri)} title={t('Скопировать')}
                  className="px-3 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-indigo-300 hover:border-indigo-800 text-sm transition-colors">
                  <i className="fa-solid fa-copy"></i>
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                {t('Google Cloud Console → APIs & Services → Credentials → OAuth client ID, тип Web application. Этот адрес вставляют в Authorised redirect URIs.')}
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="min-w-0">
                <label className="block text-xs text-slate-400 mb-1.5">Client ID</label>
                <input
                  value={ytId} onChange={e => setYtId(e.target.value)}
                  placeholder={ytSetup?.hasKeys ? ytSetup.clientIdHint : '…apps.googleusercontent.com'}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600"
                />
              </div>
              <div className="min-w-0">
                <label className="block text-xs text-slate-400 mb-1.5">Client secret</label>
                <div className="flex gap-2">
                  <input
                    type="password" value={ytSecret} onChange={e => setYtSecret(e.target.value)}
                    placeholder={ytSetup?.hasKeys ? t('задан') : t('вставьте секрет')}
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600"
                  />
                  <button onClick={saveYtKeys} disabled={busy || !ytId.trim() || !ytSecret.trim()}
                    className="px-3 py-2 rounded-lg border border-amber-700 text-amber-300 hover:bg-amber-950/30 disabled:opacity-40 text-sm font-semibold transition-colors">
                    {t('Сохранить')}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex items-center gap-3 flex-wrap">
              {/* Обычная ссылка, а не fetch: человек уходит к Google и возвращается,
                  как при входе через Discord. Согласий два подряд — полный доступ
                  серверу и узкий браузеру, — но кнопка одна: второй шаг запускается
                  из возврата сам. */}
              <a
                href={ytSetup?.hasKeys ? '/api/yt/connect' : undefined}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors
                  ${ytSetup?.hasKeys
                    ? 'bg-amber-600 hover:bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-600 cursor-not-allowed'}`}
              >
                <i className="fa-brands fa-youtube"></i>
                {ytSetup?.hasToken ? t('Переподключить канал') : t('Подключить канал')}
              </a>
              {ytSetup?.hasToken && (
                <button onClick={disconnectYt} className="text-xs text-slate-500 hover:text-red-400 transition-colors">
                  {t('Отключить')}
                </button>
              )}
            </div>

            <p className="text-[11px] text-slate-600">
              {t('Google спросит разрешение ДВА раза подряд: первое — чтобы сайт вёл плейлисты, второе — только на загрузку, его получает браузер. Второе право узкое нарочно: им нельзя удалить чужое видео.')}
            </p>

            {ytSetup?.hasToken && !ytSetup?.hasUploadToken && (
              <p className="text-[11px] text-amber-500/80">
                <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                {t('Второе разрешение не выдано — браузер получает полный доступ к каналу. Нажмите «Переподключить канал» и пройдите оба шага.')}
              </p>
            )}
          </div>
        </Section>

        <Section icon="fa-solid fa-image" title={t('Обложка записей')}
          hint={t('Так будут выглядеть обложки видео, которые заливает гильдия.')}>
          <div className="space-y-4">
            {!yt?.configured && (
              <p className="text-xs text-amber-500/80">
                <i className="fa-solid fa-triangle-exclamation mr-1.5"></i>
                {t('Канал ещё не подключён — заливать пока некуда. Оформление можно настроить заранее.')}
              </p>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <div className="min-w-0">
                <label className="block text-xs text-slate-400 mb-1.5">{t('Название гильдии на обложке')}</label>
                <input
                  value={guildName}
                  onChange={e => setGuildName(e.target.value)}
                  onBlur={e => saveThumb({ guildName: e.target.value })}
                  placeholder={t('например JADE COURT')}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600"
                />
                <p className="text-[11px] text-slate-600 mt-1">
                  {t('Пустое — строку не рисуем вовсе. Чужое имя на обложке хуже, чем его отсутствие.')}
                </p>
              </div>

              <div className="min-w-0">
                <label className="block text-xs text-slate-400 mb-1.5">{t('Цвета')}</label>
                <div className="flex items-center gap-3">
                  {([
                    ['goldTop', 'верх названия'],
                    ['goldBottom', 'низ названия'],
                    ['vsColor', '«VS»']
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
                      <input
                        type="color"
                        value={(yt?.thumb as any)?.[key] || '#FFFFFF'}
                        onChange={e => saveThumb({ [key]: e.target.value })}
                        className="w-7 h-7 rounded border border-slate-800 bg-slate-950 cursor-pointer"
                      />
                      {t(label)}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 items-start">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">{t('Фон обложки')}</label>
                <button
                  onClick={() => bgInput.current?.click()} disabled={busy}
                  className="px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 disabled:opacity-40 text-sm font-semibold transition-colors"
                >
                  <i className="fa-solid fa-upload mr-2"></i>
                  {yt?.thumb?.hasBg ? t('Заменить картинку') : t('Загрузить картинку')}
                </button>
                <input
                  ref={bgInput} type="file" accept="image/*" hidden
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadBg(f); }}
                />
                <p className="text-[11px] text-slate-600 mt-1.5">
                  {t('Обрежется по центру до 1280×720 и сожмётся прямо в браузере. Без картинки обложка рисуется на тёмной подложке.')}
                </p>
              </div>
              {thumbPreview && (
                <img src={thumbPreview} alt={t('Обложка')} className="w-full rounded-lg border border-slate-800" />
              )}
            </div>
          </div>
        </Section>
      </Group>

      <Group icon="fa-solid fa-sliders" title={t('Общие настройки')} accent="text-amber-400" cols={2}>
          <Section
            icon="fa-solid fa-hourglass-half"
            title={t('Жизненный цикл события')}
            hint={t('Отсчёт от начала события. Действует и на сайте, и в обоих ботах. Сохраняется сразу.')}
          >
            {lifecycle === null ? (
              <p className="text-slate-500 text-sm"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}</p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center text-xs text-slate-400">
                  <span></span>
                  <span className="text-center w-[92px] inline-flex items-center justify-center gap-1.5">
                    {t('Закрыть')}<Hint text={t(HINTS.lifecycleClose)} />
                  </span>
                  <span className="text-center w-[124px] inline-flex items-center justify-center gap-1.5">
                    {t('Удалить')}<Hint text={t(HINTS.lifecycleDelete)} />
                  </span>
                </div>
                {EVENT_TYPES.map(type => {
                  const del = lifecycle[type]?.deleteAfterMin ?? null;
                  return (
                    <div key={type} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
                      <p className="text-xs text-slate-300 truncate min-w-0">
                        <Glyph name={EVENT_TYPE_ICONS[type]} className="w-[1.05em] h-[1.05em] opacity-60 mr-1.5" />{EVENT_TYPE_LABELS[type]}
                      </p>
                      <div className="flex items-center gap-1 w-[92px]">
                        <input
                          type="number" min={0} max={1440}
                          value={lifecycle[type]?.closeAfterMin ?? 10}
                          onChange={e => saveLifecycle(type, 'closeAfterMin', Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
                          className="w-full min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-amber-600"
                        />
                        <span className="text-[11px] text-slate-500">{t('мин')}</span>
                      </div>
                      <div className="flex items-center gap-1 w-[124px]">
                        <input
                          type="number" min={0} max={10080}
                          disabled={del === null}
                          value={del === null ? '' : del}
                          onChange={e => saveLifecycle(type, 'deleteAfterMin', Math.max(0, Math.min(10080, Number(e.target.value) || 0)))}
                          className="w-full min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-amber-600 disabled:opacity-30"
                        />
                        <button
                          onClick={() => saveLifecycle(type, 'deleteAfterMin', del === null ? 180 : null)}
                          className={`w-7 h-7 shrink-0 rounded-lg border flex items-center justify-center transition-colors ${
                            del === null ? 'border-slate-800 text-slate-600 hover:text-slate-400' : 'border-red-900/60 text-red-400 bg-red-950/20'
                          }`}
                          title={del === null ? t('Включить удаление анонса') : t('Не удалять анонс')}
                        >
                          <i className={`fa-solid ${del === null ? 'fa-ban' : 'fa-trash'} text-[11px]`}></i>
                        </button>
                      </div>
                    </div>
                  );
                })}
                <p className="text-[11px] text-slate-600 pt-1 border-t border-slate-800">
                  {t('Удаление по умолчанию выключено — потерять историю хуже, чем оставить лишний анонс. Нажмите значок, чтобы включить.')}
                </p>
              </div>
            )}
          </Section>

          <LinksPanel editKey={editKey} players={players} reloadToken={linksToken} />
      </Group>

      {/* Сохранение настроек Discord (у Телеграма своя кнопка — они независимы) */}
      {connected && (
        <div className="sticky bottom-4 flex justify-end">
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors flex items-center gap-2"
          >
            {busy ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-brands fa-discord"></i>}
            {dirty ? t('Сохранить настройки Discord') : t('Всё сохранено')}
          </button>
        </div>
      )}
    </div>
  );
};

export default DiscordSettings;
