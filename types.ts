
// Боевая роль персонажа (танк / хил / дд)
export enum Role {
  TANK = 'Tank',
  HEALER = 'Healer',
  DPS = 'DPS'
}

// Линия (топ / мид / бот)
export enum Lane {
  TOP = 'top',
  MID = 'mid',
  BOT = 'bot',
  UNASSIGNED = 'unassigned'
}

// Сторона / основная роль в войне гильдий
export enum Side {
  ATTACK = 'attack',  // Атака
  DEFENSE = 'defense' // Деф
}

// Доп-роль бойца (куда идёт боец) — взаимоисключающие
export enum SubRole {
  JUNGLE = 'jungle', // Лес
  BOSS = 'boss',     // Босс
  TOWER = 'tower'    // Тавер (спавн на башне, в основном в дефе)
}

// Позиция в лесу
export enum JunglePosition {
  TOP_NEAR = 'top_near', // Топ лес (ближний)
  TOP_FAR = 'top_far',   // Топ лес (дальний)
  BOT_NEAR = 'bot_near', // Бот лес (ближний)
  BOT_FAR = 'bot_far'    // Бот лес (дальний)
}

// Колл-роль: кто руководит командой во время боя
export enum CallRole {
  SHOTCALLER = 'shotcaller', // Шотколлер
  RL = 'rl',                 // Рейд-лидер
  CHICKEN = 'chicken_caller' // Коллер курицы: командует, когда её бросать на боссе
}

export const CALL_ROLES: CallRole[] = [CallRole.SHOTCALLER, CallRole.RL, CallRole.CHICKEN];

// ---- Тайминги войны ----
// Момент спавна крипов в лесу. Счёт идёт вниз: '25' — «на 25-й минуте». 'start' —
// открытие боя. Босс выходит на 25-й и 15-й, поэтому в этих таймингах у бойца может
// быть сразу две задачи: снять лагерь и сходить на босса (см. server/timings.mjs).
export type WarTiming = 'start' | '25' | '20' | '15' | '10' | '5';

// Точка на карте, куда боец идёт в этот тайминг: один из четырёх лагерей или босс
export type TimingSpot = JunglePosition | 'boss';

// Клетка плана — (сторона, тайминг, точка). Групповые ссылки живут рядом с поимённым
// списком: офицер пишет «Гр.1 + двое», и переставленный между группами боец должен
// пропадать из леса сам.
export interface TimingCell {
  groups: GroupNumber[];  // ссылки на группы этой стороны
  players: string[];      // playerId, добавленные поимённо
  chicken: string[];      // playerId тех, кто несёт курицу ИМЕННО в эту клетку
  // «Гр.1, кроме вот этого». Поимённая запись в другом лагере того же тайминга даёт
  // такое исключение сама — это основной случай: один из пачки почти всегда уходит
  // отдельно (см. cellPlayers в server/timings.mjs).
  exclude: string[];
}

// Ключ: `${side}:${timing}:${spot}` (cellKey в server/timings.mjs)
export type TimingPlan = Record<string, TimingCell>;

// Школы оружия (id совпадает с именем картинки в assets/upscayl_png_ultrasharp-4x_4x)
export enum WeaponSchool {
  BAMBOOCUT = 'bamboocut',
  HENGBLADE = 'hengblade',
  SPLENDOR = 'splendor',
  UMBRA = 'umbra',
  DMG_UMBRELLA = 'dmg_umbrella',
  NEW_UMBRELLA = 'new_umbrella',
  HEA = 'hea',
  MIGHT = 'might'
}

export const WEAPON_SCHOOLS: WeaponSchool[] = [
  WeaponSchool.BAMBOOCUT,
  WeaponSchool.HENGBLADE,
  WeaponSchool.SPLENDOR,
  WeaponSchool.UMBRA,
  WeaponSchool.DMG_UMBRELLA,
  WeaponSchool.NEW_UMBRELLA,
  WeaponSchool.HEA,
  WeaponSchool.MIGHT
];

// Устаревшие спец-отряды (оставлены для обратной совместимости данных)
export interface TacticalGroup {
  id: string;
  name: string;
  icon: string;
  color: string;
}

// Игрок недоступен: отпуск, болезнь, жизненные обстоятельства.
// Правила и пересчёт заявок — в server/away.mjs (общий файл для фронта и сервера).
export interface Unavailable {
  since: string;   // когда пометили (ISO)
  note?: string;   // причина своими словами — видна всем, кто открыл сайт
  until?: string;  // YYYY-MM-DD, день возвращения по МСК. Нет поля — бессрочно
}

export interface Player {
  id: string;
  name: string;
  role: Role;
  weapons: WeaponSchool[]; // ровно 2 школы (могут совпадать)
  callRoles?: CallRole[];  // Шотколлер / РЛ (может быть оба или ни одного)
  notes?: string;
  autoSignup?: boolean; // авто-запись «Иду» на каждое новое событие (по просьбе самого игрока)
  unavailable?: Unavailable; // помечен недоступным; гаснет само по until
}

// Номер группы внутри стороны (1, 2 или 3)
export type GroupNumber = 1 | 2 | 3;

export interface WarAssignment {
  playerId: string;
  side: Side;            // Атака / Деф
  group: GroupNumber;    // Группа 1 / 2 / 3
  // Тавер — единственная доп-роль, которая осталась здесь: она про весь бой (боец
  // спавнится на башне), а не про момент. Лес, босс и курица уехали в план по
  // таймингам, потому что меняются от тайминга к таймингу.
  subRoles?: SubRole[];
  subRole?: SubRole;     // Устаревшее (одиночная доп-роль) — для старых сохранений

  // Устаревшие поля: до появления таймингов лес и босс были одни на весь бой.
  // Читаются только при развороте старых сохранений (planFromLegacy) и вычищаются
  // при первой же правке — держать две правды об одном нельзя.
  junglePosition?: JunglePosition;
  bossTime?: 15 | 25;
  carriesChicken?: boolean;

  // Устаревшие поля (старые сохранения) — больше не используются в UI
  lane?: Lane;
  groupId?: string | null;
}

// Позиция токена на карте (в процентах 0..100 от размера карты)
export interface MapPosition {
  x: number;
  y: number;
}

// ---- Слой рисования (аннотации стратегии на карте) ----
// Тип фигуры: кисть, стрелка, прямая линия, прямоугольник-зона, эллипс-зона
export type DrawShapeType = 'path' | 'arrow' | 'line' | 'rect' | 'ellipse';

// Точка пути в процентах от размера карты (0..100)
export interface DrawPoint { x: number; y: number; }

export interface DrawShape {
  id: string;
  type: DrawShapeType;
  color: string;          // цвет линии/обводки (у зон заливка того же цвета)
  width: number;          // толщина линии в пикселях
  points: DrawPoint[];    // path: множество точек; arrow/line: [начало, конец]; rect/ellipse: [угол, противоположный угол]
  dash?: boolean;         // пунктирная линия
  fill?: boolean;         // rect/ellipse: полупрозрачная заливка (по умолчанию есть)
  fillOpacity?: number;   // 0..1, прозрачность заливки зоны (по умолчанию 0.25)
}

// ---- Встроенные тактические маркеры (объекты карты WWM) ----
export type ObjectiveType =
  | 'tower-ally' | 'tower-enemy'   // башни
  | 'tree-ally' | 'tree-enemy'     // лес
  | 'goose-ally' | 'goose-enemy'   // гуси
  | 'boss'                          // босс
  | 'mark-tank' | 'mark-heal' | 'mark-dps'; // метки ролей

export interface ObjectiveMarker {
  id: string;
  type: ObjectiveType;
  x: number; // % от ширины карты
  y: number; // % от высоты карты
}

// ---- Текстовая подпись на карте ----
export interface MapText {
  id: string;
  x: number; // % от ширины карты
  y: number; // % от высоты карты
  text: string;
  color: string;    // цвет букв
  size?: number;    // размер шрифта в px (по умолчанию DEFAULT_TEXT_SIZE)
  fill?: boolean;   // плашка-подложка под текстом (по умолчанию true)
  stroke?: boolean; // обводка букв (по умолчанию false)
  fillColor?: string;   // цвет плашки (по умолчанию тёмный)
  fillOpacity?: number; // 0..1 прозрачность плашки (по умолчанию 0.55)
  strokeColor?: string; // цвет обводки букв (по умолчанию чёрный)
  strokeWidth?: number; // толщина обводки в px (по умолчанию 1)
}

// ---- События (праки / ранкед / лига) ----
export type GuildEventType = 'prak' | 'ranked' | 'league';

// Статус заявки игрока на событие
export type SignupStatus = 'in' | 'maybe' | 'out' | 'sub';

// Откуда пришла заявка: с сайта, из Телеграма или из Дискорда
export type SignupSource = 'site' | 'tg' | 'discord';

// Служебные данные заявки. Лежат ОТДЕЛЬНО от signups (см. GuildWarSession.signupMeta):
// сами статусы читают/пишут много мест, и менять их форму нельзя.
export interface SignupMetaEntry {
  from: SignupSource; // источник — для значка «откуда записался»
  at: string;         // момент заявки (ISO) — из него порядковые номера в анонсах
}

export interface GuildEventMeta {
  type: GuildEventType;
  opponent?: string;  // соперник (для прака)
  date?: string;      // YYYY-MM-DD — стенные часы в поясе tz (для формы и старых данных)
  time?: string;      // HH:MM — стенные часы в поясе tz
  tz?: string;        // IANA-пояс, в котором введены date/time (напр. 'Europe/Moscow')
  startsAt?: string;  // абсолютный момент (ISO). Источник правды для показа в любом поясе и авто-завершения
  note?: string;
}

// ---- Стратегия карты (независима от событий; своя коллекция, переключается локально) ----
export interface MapTemplate {
  id: string;
  name: string;
  objectives: ObjectiveMarker[];
  drawings: DrawShape[];
  texts: MapText[];
  // Шаг сетки привязки в процентах ШИРИНЫ карты. Живёт у карты, а не у человека:
  // офицеры размечают одну и ту же карту вдвоём, и разные шаги означали бы, что зоны
  // одного не стыкуются с зонами другого — то есть ровно та беда, от которой сетка.
  grid?: number;
  positions: Record<string, MapPosition>; // playerId -> позиция токена
}

export interface GuildWarSession {
  id: string;
  name: string;
  date: string;
  // Метаданные события: тип, соперник, дата/время. Если нет — обычный «состав».
  event?: GuildEventMeta;
  // Заявки игроков на это событие: playerId -> статус. Синхронизируется.
  signups?: Record<string, SignupStatus>;
  // Источник и время каждой заявки (playerId -> {from, at}). Пишется сервером
  // при записи через /api/signup и ботами; при слиянии импорта едет вместе с signups.
  signupMeta?: Record<string, SignupMetaEntry>;
  assignments: WarAssignment[];
  // План по таймингам: кто когда какой лагерь снимает и кто идёт на босса.
  // Нет поля — сессия собрана до появления таймингов, и план разворачивается из
  // старых полей assignments на лету (readPlan в server/timings.mjs).
  timings?: TimingPlan;
  // Линия для каждой (сторона, группа). Ключ: `${side}:${group}` -> Lane
  groupLanes?: Record<string, Lane>;
  // Позиции токенов игроков на интерактивной карте (ключ — playerId)
  mapPositions?: Record<string, MapPosition>;
  // Аннотации-рисунки на карте (кисть / стрелки) — синхронизируются
  mapDrawings?: DrawShape[];
  // Встроенные тактические маркеры (башни, лес, гуси, босс, метки) — синхронизируются
  mapObjectives?: ObjectiveMarker[];
  // Текстовые подписи на карте — синхронизируются
  mapTexts?: MapText[];
  // Устаревшее: пользовательские спец-отряды
  groups?: TacticalGroup[];
}
