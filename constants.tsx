
import React from 'react';
import type { GlyphName } from './components/glyphs';
import { Role, Lane, Side, SubRole, JunglePosition, GroupNumber, WeaponSchool, CallRole, CALL_ROLES, GuildEventType, SignupStatus } from './types';
import { IMAGES, WEAPON_IMAGES } from './images';
import { localize } from './services/i18n';

// «Самопереводящаяся» карта меток: значения переводятся на лету (localize) при чтении,
// поэтому в компонентах ничего менять не нужно — достаточно перерисовки при смене языка.
const loc = <K extends string>(m: Record<K, string>): Record<K, string> =>
  new Proxy(m, { get: (target, prop) => { const v = (target as any)[prop]; return typeof v === 'string' ? localize(v) : v; } }) as Record<K, string>;

// ---- Школы оружия ----
// Названия — как в игре (англ.), совпадают с именами файлов иконок. Не переводить.
export const WEAPON_SCHOOL_LABELS: Record<WeaponSchool, string> = {
  [WeaponSchool.BAMBOOCUT]: 'Bamboocut - Wind',
  [WeaponSchool.HENGBLADE]: 'Stonesplit - Strength',
  [WeaponSchool.SPLENDOR]: 'Bellstrike - Splendor',
  [WeaponSchool.UMBRA]: 'Bellstrike - Umbra',
  [WeaponSchool.DMG_UMBRELLA]: 'Silkbind - Jade',
  [WeaponSchool.NEW_UMBRELLA]: 'Bamboocut - Dust',
  [WeaponSchool.HEA]: 'Silkbind - Deluge',
  [WeaponSchool.MIGHT]: 'Stonesplit - Might'
};

export const WEAPON_SCHOOL_IMAGES: Record<WeaponSchool, string> = {
  [WeaponSchool.BAMBOOCUT]: WEAPON_IMAGES.bamboocut,
  [WeaponSchool.HENGBLADE]: WEAPON_IMAGES.hengblade,
  [WeaponSchool.SPLENDOR]: WEAPON_IMAGES.splendor,
  [WeaponSchool.UMBRA]: WEAPON_IMAGES.umbra,
  [WeaponSchool.DMG_UMBRELLA]: WEAPON_IMAGES.dmg_umbrella,
  [WeaponSchool.NEW_UMBRELLA]: WEAPON_IMAGES.new_umbrella,
  [WeaponSchool.HEA]: WEAPON_IMAGES.hea,
  [WeaponSchool.MIGHT]: WEAPON_IMAGES.might
};

// Палитра приложения закрыта семью семействами: slate (нейтральное), amber (бренд,
// офицер, действие по умолчанию), red (атака, опасность), sky (деф, Телеграм),
// emerald (успех, лес), indigo (Discord), fuchsia (третий акцент — лига и босс).
// blue/green/cyan/orange убраны: рядом со sky/emerald/amber они отличались настолько
// мало, что читались как ошибка, а не как решение.
// Цвет роли берётся ОТ ИГРОВОЙ ИКОНКИ этой роли (assets/tank|dps|healer.png), а не
// назначается произвольно: замер пикселей даёт танк #edd39b (песочный), ДД #83e2f1
// (голубой), хил #a1edb8 (зелёный) — то есть amber, sky, emerald. Раньше танк был
// голубым, а ДД красным, и подпись спорила с иконкой прямо рядом с собой.
// Менять только вместе с BattleMap (ROLE_RING/ROLE_DOT), WarPlanner (плитки счётчиков)
// и BattleOrderExport (там цвета продублированы шестнадцатеричными).
export const ROLE_COLORS = {
  [Role.TANK]: 'text-amber-400 border-amber-400 bg-amber-400/10',
  [Role.HEALER]: 'text-emerald-400 border-emerald-400 bg-emerald-400/10',
  [Role.DPS]: 'text-sky-400 border-sky-400 bg-sky-400/10'
};

// Короткие русские названия ролей: танк / хил / дд
export const ROLE_LABELS: Record<Role, string> = loc({
  [Role.TANK]: 'Танк',
  [Role.HEALER]: 'Хил',
  [Role.DPS]: 'ДД'
});

// ---- Колл-роли (кто руководит командой) ----
export { CALL_ROLES };

export const CALL_ROLE_LABELS: Record<CallRole, string> = loc({
  [CallRole.SHOTCALLER]: 'Шотколлер',
  [CallRole.RL]: 'РЛ',
  [CallRole.CHICKEN]: 'Коллер курицы'
});

export const CALL_ROLE_ICONS: Record<CallRole, string> = {
  [CallRole.SHOTCALLER]: 'fa-bullhorn',
  [CallRole.RL]: 'fa-crown',
  // Мегафон уже занят шотколлером, поэтому у коллера курицы своя иконка-сигнал
  [CallRole.CHICKEN]: 'fa-tower-broadcast'
};

// Стили бейджа колл-роли: насыщенный цвет, чтобы было видно
export const CALL_ROLE_STYLES: Record<CallRole, { text: string; bg: string; border: string; solid: string }> = {
  [CallRole.SHOTCALLER]: { text: 'text-amber-300', bg: 'bg-amber-500/15', border: 'border-amber-500/50', solid: 'bg-amber-500' },
  [CallRole.RL]: { text: 'text-sky-300', bg: 'bg-sky-500/15', border: 'border-sky-500/50', solid: 'bg-sky-500' },
  // Коллер курицы — там же, где сама курица (янтарь), но приглушённее РЛ и шотколлера:
  // это про один момент боя, а не про командование всю войну.
  [CallRole.CHICKEN]: { text: 'text-amber-400/90', bg: 'bg-amber-600/10', border: 'border-amber-700/50', solid: 'bg-amber-700' }
};

export const ROLE_ICONS = {
  [Role.TANK]: <img src={IMAGES.tank} alt={ROLE_LABELS[Role.TANK]} draggable={false} className="w-full h-full object-contain pointer-events-none" />,
  [Role.HEALER]: <img src={IMAGES.healer} alt={ROLE_LABELS[Role.HEALER]} draggable={false} className="w-full h-full object-contain pointer-events-none" />,
  [Role.DPS]: <img src={IMAGES.dps} alt={ROLE_LABELS[Role.DPS]} draggable={false} className="w-full h-full object-contain pointer-events-none" />
};

// ---- Стороны (Атака / Деф) ----
export const SIDES: Side[] = [Side.ATTACK, Side.DEFENSE];

export const SIDE_LABELS: Record<Side, string> = loc({
  [Side.ATTACK]: 'Атака',
  [Side.DEFENSE]: 'Деф'
});

export const SIDE_ICONS: Record<Side, string> = {
  [Side.ATTACK]: 'fa-khanda',
  [Side.DEFENSE]: 'fa-shield-halved'
};

export const SIDE_STYLES: Record<Side, { text: string; border: string; bg: string; accent: string }> = {
  [Side.ATTACK]: { text: 'text-red-400', border: 'border-red-900/50', bg: 'bg-red-950/20', accent: 'bg-red-600' },
  [Side.DEFENSE]: { text: 'text-sky-400', border: 'border-sky-900/50', bg: 'bg-sky-950/20', accent: 'bg-sky-600' }
};

// ---- Линии ----
export const LANES: Lane[] = [Lane.TOP, Lane.MID, Lane.BOT];

export const LANE_LABELS: Record<Lane, string> = loc({
  [Lane.TOP]: 'Топ',
  [Lane.MID]: 'Мид',
  [Lane.BOT]: 'Бот',
  [Lane.UNASSIGNED]: 'Без линии'
});

export const LANE_FULL_LABELS: Record<Lane, string> = loc({
  [Lane.TOP]: 'Верхняя линия',
  [Lane.MID]: 'Средняя линия',
  [Lane.BOT]: 'Нижняя линия',
  [Lane.UNASSIGNED]: 'Линия не назначена'
});

export const LANE_ICONS: Record<Lane, React.ReactElement> = {
  [Lane.TOP]: <i className="fa-solid fa-arrow-up"></i>,
  [Lane.MID]: <i className="fa-solid fa-arrows-left-right"></i>,
  [Lane.BOT]: <i className="fa-solid fa-arrow-down"></i>,
  [Lane.UNASSIGNED]: <i className="fa-solid fa-circle-question"></i>
};

// Линия цветом не кодируется: рядом с ней всегда стоит подпись («Топ/Мид/Бот») или
// выпадающий список с тем же словом, а цвет в этом месте уже занят стороной
// (атака/деф) и доп-ролью. Три лишних цвета только спорили с ними за внимание.
export const LANE_COLORS: Record<Lane, string> = {
  [Lane.TOP]: 'text-slate-400',
  [Lane.MID]: 'text-slate-400',
  [Lane.BOT]: 'text-slate-400',
  [Lane.UNASSIGNED]: 'text-slate-500'
};

// ---- Доп-роли ----
export const SUBROLES: SubRole[] = [SubRole.JUNGLE, SubRole.BOSS, SubRole.TOWER];

export const SUBROLE_LABELS: Record<SubRole, string> = loc({
  [SubRole.JUNGLE]: 'Лес',
  [SubRole.BOSS]: 'Босс',
  [SubRole.TOWER]: 'Тавер'
});

// Свои глифы, а не Font Awesome: стоковый набор подставлял под игровые понятия что
// нашлось (дракон из общего каталога, обсерватория вместо вышки). См. components/glyphs.tsx.
export const SUBROLE_ICONS: Record<SubRole, GlyphName> = {
  [SubRole.JUNGLE]: 'jungle',
  [SubRole.BOSS]: 'boss',
  [SubRole.TOWER]: 'tower'
};

// Цвета бейджей доп-ролей
export const SUBROLE_STYLES: Record<SubRole, { solid: string; text: string; border: string; bg: string }> = {
  [SubRole.JUNGLE]: { solid: 'bg-emerald-600', text: 'text-emerald-400', border: 'border-emerald-900/50', bg: 'bg-emerald-950/40' },
  [SubRole.BOSS]:   { solid: 'bg-fuchsia-600', text: 'text-fuchsia-400', border: 'border-fuchsia-900/50', bg: 'bg-fuchsia-950/40' },
  [SubRole.TOWER]:  { solid: 'bg-sky-600',     text: 'text-sky-400',     border: 'border-sky-900/50',     bg: 'bg-sky-950/40' }
};

// ---- Курица (несёт курицу в лес/на босса) — стакается с доп-ролью ----
export const CHICKEN_LABEL = 'Курица';
export const CHICKEN_ICON = '🐔'; // эмодзи-курица (рендерим как текст в <span>, не через fa-solid)
// Курицу опознаёт эмодзи, поэтому отдельного цвета ей не нужно — оранжевый рядом с
// янтарным читался как случайный оттенок того же цвета.
export const CHICKEN_STYLE = { solid: 'bg-amber-600', text: 'text-amber-300', border: 'border-amber-600/50', bg: 'bg-amber-600/15' };

// ---- Позиции в лесу ----
export const JUNGLE_POSITIONS: JunglePosition[] = [
  JunglePosition.TOP_NEAR,
  JunglePosition.TOP_FAR,
  JunglePosition.BOT_NEAR,
  JunglePosition.BOT_FAR
];

export const JUNGLE_LABELS: Record<JunglePosition, string> = loc({
  [JunglePosition.TOP_NEAR]: 'Топ лес (ближний)',
  [JunglePosition.TOP_FAR]: 'Топ лес (дальний)',
  [JunglePosition.BOT_NEAR]: 'Бот лес (ближний)',
  [JunglePosition.BOT_FAR]: 'Бот лес (дальний)'
});

// Совсем короткие подписи для бейджа на карточке бойца. Слово «лес» выброшено:
// рядом стоит иконка дерева, и повторять существительное текстом незачем — а место
// на карточке шириной в двести пикселей отнимает у имени, ради которого она и нужна.
export const JUNGLE_TINY: Record<JunglePosition, string> = loc({
  [JunglePosition.TOP_NEAR]: 'Топ ближ.',
  [JunglePosition.TOP_FAR]: 'Топ дальн.',
  [JunglePosition.BOT_NEAR]: 'Бот ближ.',
  [JunglePosition.BOT_FAR]: 'Бот дальн.'
});

// Короткие подписи позиции в лесу
export const JUNGLE_SHORT: Record<JunglePosition, string> = loc({
  [JunglePosition.TOP_NEAR]: 'Топ лес ближ.',
  [JunglePosition.TOP_FAR]: 'Топ лес дальн.',
  [JunglePosition.BOT_NEAR]: 'Бот лес ближ.',
  [JunglePosition.BOT_FAR]: 'Бот лес дальн.'
});

// ---- Тайминги войны ----
// Словарь и вся логика плана — в server/timings.mjs (общий файл фронта и тестов).
// Здесь только подписи: держать русский текст в .mjs нельзя, он не переводится.
export { TIMINGS as WAR_TIMINGS, BOSS_TIMINGS, BOSS as BOSS_SPOT, CAMPS, SPOTS, START as START_TIMING } from './server/timings.mjs';

// Подпись тайминга в таблице и на чипах. Число оставляем числом: «25′» короче любой
// расшифровки и совпадает с тем, как это произносят на войне.
export const TIMING_LABELS: Record<string, string> = loc({
  start: 'старт',
  '25': '25′',
  '20': '20′',
  '15': '15′',
  '10': '10′',
  '5': '5′'
});

// Столбцы таблицы таймингов. Лагеря названы коротко (полные подписи — в JUNGLE_LABELS),
// иначе пять столбцов не помещаются даже на широком экране.
export const SPOT_LABELS: Record<string, string> = loc({
  top_near: 'Ближний ТОП',
  top_far: 'Дальний ТОП',
  bot_near: 'Ближний БОТ',
  bot_far: 'Дальний БОТ',
  boss: 'Босс'
});

export const SPOT_ICONS: Record<string, string> = {
  top_near: 'fa-tree',
  top_far: 'fa-tree',
  bot_near: 'fa-tree',
  bot_far: 'fa-tree',
  boss: 'fa-dragon'
};

// ---- Группы ----
export const GROUP_NUMBERS: GroupNumber[] = [1, 2, 3];

// Состав войны: всего 30, по 15 на сторону, по 5 в группе
export const MAX_WAR_PLAYERS = 30;
export const PLAYERS_PER_SIDE = 15;
export const PLAYERS_PER_GROUP = 5;

// Линия группы по умолчанию (атака гр.1 → бот, гр.2 → мид, гр.3 → топ; в дефе аналогично)
export const DEFAULT_GROUP_LANES: Record<string, Lane> = {
  'attack:1': Lane.BOT,
  'attack:2': Lane.MID,
  'attack:3': Lane.TOP,
  'defense:1': Lane.BOT,
  'defense:2': Lane.MID,
  'defense:3': Lane.TOP
};

export const groupLaneKey = (side: Side, group: GroupNumber) => `${side}:${group}`;

// Башня, к которой относится группа: атака → вражеская башня линии, деф → союзная башня линии
export interface TowerInfo {
  owner: 'ally' | 'enemy';
  lane: Lane;
  label: string;
  icon: string;
}

export const getTowerInfo = (side: Side, lane: Lane): TowerInfo | null => {
  if (lane === Lane.UNASSIGNED) return null;
  const owner = side === Side.ATTACK ? 'enemy' : 'ally';
  const ownerLabel = localize(owner === 'enemy' ? 'Вражеская башня' : 'Союзная башня');
  return {
    owner,
    lane,
    label: `${ownerLabel} · ${LANE_LABELS[lane]}`,
    // Иконка одна на обе стороны — владельца различает цвет (красный/синий)
    icon: 'fa-tower-observation'
  };
};

// ---- События (праки / ранкед / лига) ----
export const EVENT_TYPES: GuildEventType[] = ['prak', 'ranked', 'league'];

export const EVENT_TYPE_LABELS: Record<GuildEventType, string> = loc({
  prak: 'Прак',
  ranked: 'Ранкед',
  league: 'Лига'
});

export const EVENT_TYPE_ICONS: Record<GuildEventType, GlyphName> = {
  prak: 'prak',
  ranked: 'ranked',
  league: 'league'
};

// Цвета карточки события по типу: прак — янтарь, ранкед — синий, лига — фиолет
export const EVENT_TYPE_STYLES: Record<GuildEventType, { text: string; border: string; bg: string; solid: string }> = {
  prak:   { text: 'text-amber-300',   border: 'border-amber-700/60',   bg: 'bg-amber-950/30',   solid: 'bg-amber-600' },
  ranked: { text: 'text-sky-300',     border: 'border-sky-700/60',     bg: 'bg-sky-950/30',     solid: 'bg-sky-600' },
  league: { text: 'text-fuchsia-300', border: 'border-fuchsia-700/60', bg: 'bg-fuchsia-950/30', solid: 'bg-fuchsia-600' }
};

// ---- Статусы заявки ----
export const SIGNUP_STATUSES: SignupStatus[] = ['in', 'maybe', 'sub', 'out'];

export const SIGNUP_LABELS: Record<SignupStatus, string> = loc({
  in: 'Иду',
  maybe: 'Под вопросом',
  sub: 'На замену',
  out: 'Не иду'
});

// Короткие подписи для кнопок
export const SIGNUP_SHORT: Record<SignupStatus, string> = loc({
  in: 'Иду',
  maybe: 'Вопрос',
  sub: 'Замена',
  out: 'Нет'
});

export const SIGNUP_ICONS: Record<SignupStatus, string> = {
  in: 'fa-check',
  maybe: 'fa-question',
  sub: 'fa-right-left',
  out: 'fa-xmark'
};

// Цвета статусов: иду — зелёный, вопрос — янтарь, замена — синий, не иду — красный
export const SIGNUP_STYLES: Record<SignupStatus, { dot: string; text: string; bg: string; border: string; solid: string }> = {
  in:    { dot: 'bg-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-950/40', border: 'border-emerald-600/60', solid: 'bg-emerald-600' },
  maybe: { dot: 'bg-amber-400',   text: 'text-amber-300',   bg: 'bg-amber-950/40',   border: 'border-amber-600/60',   solid: 'bg-amber-600' },
  sub:   { dot: 'bg-sky-400',     text: 'text-sky-300',     bg: 'bg-sky-950/40',     border: 'border-sky-600/60',     solid: 'bg-sky-600' },
  out:   { dot: 'bg-red-400',     text: 'text-red-300',     bg: 'bg-red-950/40',     border: 'border-red-600/60',     solid: 'bg-red-600' }
};
