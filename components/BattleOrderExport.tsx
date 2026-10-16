import React from 'react';
import { Player, Side, Role, SubRole, GroupNumber, WarAssignment, GuildWarSession, Lane, CallRole } from '../types';
import {
  SIDE_LABELS, ROLE_LABELS, LANE_LABELS,
  GROUP_NUMBERS, PLAYERS_PER_GROUP,
  SUBROLE_LABELS, CALL_ROLE_LABELS,
  WEAPON_SCHOOL_IMAGES, WEAPON_SCHOOL_LABELS,
  groupLaneKey, DEFAULT_GROUP_LANES, getTowerInfo, CHICKEN_ICON,
  SPOT_LABELS, TIMING_LABELS
} from '../constants';
import { readPlan, barsOf, campRoster, countTasks, TIMINGS } from '../server/timings.mjs';
import { IMAGES } from '../images';
import { useT } from '../services/i18n';

// Скрытая «экспортная» вёрстка боевого приказа одной стороны (Атака или Деф).
// Рисуется офскрин и снимается в PNG (html-to-image). Группы — горизонтально по столбцам.
//
// Цвета здесь заданы шестнадцатеричными значениями, а не классами Tailwind: html-to-image
// снимает вычисленные стили, и внешние таблицы стилей до него доходят ненадёжно. Поэтому
// палитру приходится дублировать — значения ниже обязаны совпадать со шкалой из
// tailwind.config.js, иначе картинка выглядит из другого приложения (так и было:
// картинка осталась на старом синеватом slate, когда сайт перекрасили).
// Деление минуты на доске приказа. Полупрозрачный белый: одна и та же линия ложится и на
// тёмный фон, и на цветную заливку полосы, а непрозрачный цвет пришлось бы подбирать под
// каждую. Двадцать процентов — видно, но тише имени бойца и самой полосы.
const TICK = 'rgba(231,227,221,0.20)';

const C = {
  page: '#0b0b0b',      // slate-950
  card: '#131211',      // slate-900
  raised: '#1e1c1a',    // slate-800
  line: '#1e1c1a',      // рамка по умолчанию
  lineStrong: '#2c2926',// slate-700
  text: '#e7e3dd',      // slate-200
  dim: '#9a938a',       // slate-400
  faint: '#6b665f',     // slate-500
  amber: '#fbbf24',
  red: '#f87171',
  sky: '#7dd3fc',
  emerald: '#6ee7b7',
  fuchsia: '#e879f9'
};

// Приказ выгружается ДВУМЯ картинками, а не одной.
//
// Раньше состав и доска таймингов ехали в одном файле, и он рос: пятнадцать карточек, под
// ними пятнадцать строк расписания. Разрезано по вопросу, на который отвечает картинка:
//
// - 'roster'  — «где я стою»: три пачки со всеми ролями плюс сводка по лесу БЕЗ времени;
// - 'timings' — «что я делаю по минутам»: та же доска-гант, что и была, отдельным файлом.
//
// Сводка в первой картинке и доска во второй считаются ОДНИМ модулем (server/timings.mjs):
// два обхода одного плана однажды разошлись бы, и две картинки одного боя показывали бы
// разное — при том, что читать их будут рядом.
export type ExportVariant = 'roster' | 'timings';

interface Props {
  side: Side;
  session: GuildWarSession;
  players: Player[];
  variant: ExportVariant;
}

const isValid = (a: WarAssignment) =>
  (a.side === Side.ATTACK || a.side === Side.DEFENSE) && (a.group === 1 || a.group === 2 || a.group === 3);

// Те же иконки ролей, что и на сайте (PNG из assets)
const ROLE_IMG: Record<Role, string> = {
  [Role.TANK]: IMAGES.tank,
  [Role.HEALER]: IMAGES.healer,
  [Role.DPS]: IMAGES.dps
};

// Порядок в группе: танк → дд → хил (как на доске)
const ROLE_ORDER: Record<Role, number> = { [Role.TANK]: 0, [Role.DPS]: 1, [Role.HEALER]: 2 };

// Цвет роли для ников в сводке по лесу. Значения те же, что у точек-счётчиков в шапке и
// у чипов на сайте (ROLE_COLORS), поэтому цвет читается одинаково везде.
//
// Взяты светлые ступени шкалы (300–400), а не насыщенные: строка сводки лежит на карточке
// #131211, и тёмный оттенок роли на ней сливался бы. Здесь у всех трёх контраст выше 10:1,
// то есть ник остаётся ником, а не цветным пятном.
const ROLE_COLOR: Record<Role, string> = {
  [Role.TANK]: C.amber,
  [Role.DPS]: C.sky,
  [Role.HEALER]: C.emerald
};

const chip = (text: string, bg: string, fg: string): React.ReactNode => (
  <span style={{ display: 'inline-flex', alignItems: 'center', background: bg, color: fg, fontSize: 12, lineHeight: 1, padding: '4px 8px', borderRadius: 6, whiteSpace: 'nowrap' }}>{text}</span>
);

// Счётчик роли: точка цветом роли, значение основным цветом. Раньше цветным было само
// число — получался «ряд KPI», где ярче всего светила не цифра, а её оформление.
const stat = (value: React.ReactNode, label: string, dot?: string): React.ReactNode => (
  <div style={{ textAlign: 'right' }}>
    <div style={{ color: C.text, fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
    <div style={{ color: C.dim, fontSize: 11, marginTop: 3, display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, display: 'inline-block' }} />}
      {label}
    </div>
  </div>
);

const BattleOrderExport = React.forwardRef<HTMLDivElement, Props>(({ side, session, players, variant }, ref) => {
  const t = useT();
  const assignments = (session.assignments || []).filter(isValid).filter(a => a.side === side);
  const playerById = (id: string) => players.find(p => p.id === id);
  const getSubRoles = (a: WarAssignment): SubRole[] => a.subRoles ?? (a.subRole ? [a.subRole] : []);
  const getLane = (group: GroupNumber): Lane => {
    const key = groupLaneKey(side, group);
    return session.groupLanes?.[key] ?? DEFAULT_GROUP_LANES[key] ?? Lane.UNASSIGNED;
  };

  const countRole = (r: Role) => assignments.filter(a => playerById(a.playerId)?.role === r).length;
  // Атака — красный, деф — sky: те же смыслы, что и на сайте (SIDE_STYLES в constants).
  const theme = side === Side.ATTACK
    ? { accent: C.red, markBg: '#2a1212', symbol: '⚔' }
    : { accent: C.sky, markBg: '#10222c', symbol: '🛡' };

  const dateStr = (() => {
    try { return new Date(session.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }); }
    catch { return ''; }
  })();

  // В карточке бойца остался только тавер: он про весь бой. Лес, босс и курица зависят
  // от момента, и раскладывать шесть таймингов внутри карточки бессмысленно — под
  // составом для них стоит таблица, где сразу видно, кто на лагере вместе с тобой.
  const tagsFor = (a: WarAssignment): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    if (getSubRoles(a).includes(SubRole.TOWER)) {
      out.push(<React.Fragment key="t">{chip(SUBROLE_LABELS[SubRole.TOWER], '#0d2431', C.sky)}</React.Fragment>);
    }
    return out;
  };

  const plan = readPlan(session);
  const nameOf = (id: string) => playerById(id)?.name || '—';

  // ---- Сводка по лесу без времени (только в 'roster') ----
  //
  // Шесть таймингов схлопываются в пять строк: четыре лагеря и босс. Схлопывание — то
  // самое место, где легко соврать, поэтому считает его server/timings.mjs, под тестами.
  //
  // Ник красится в цвет роли, а не сопровождается иконкой: в строке лагеря их было бы до
  // пятнадцати, и ряд одинаковых картинок читался бы как орнамент. Цвет расшифрован в
  // легенде внизу, поэтому догадываться не надо.
  const jungleRows: any[] = variant === 'roster' ? campRoster(plan, assignments, side) : [];

  const jungleRow = (row: any, i: number) => {
    const list = (row.players as any[])
      .map(e => ({ e, p: playerById(e.id)! }))
      .filter(x => x.p)
      .sort((x, y) =>
        x.e.group - y.e.group ||
        ROLE_ORDER[x.p.role] - ROLE_ORDER[y.p.role] ||
        x.p.name.localeCompare(y.p.name));
    return (
      <div key={row.spot} style={{
        display: 'grid', gridTemplateColumns: '168px 1fr', gap: 10,
        padding: '8px 12px', borderTop: i === 0 ? 'none' : `1px solid ${C.line}`
      }}>
        <span style={{ color: row.spot === 'boss' ? C.fuchsia : C.dim, fontSize: 12, fontWeight: 600 }}>
          {SPOT_LABELS[row.spot]}
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', columnGap: 9, rowGap: 5 }}>
          {list.map(({ e, p }, n) => (
            <span key={p.id} style={{ color: ROLE_COLOR[p.role], fontSize: 13, fontWeight: 600 }}>
              {p.name}
              {e.chicken ? ' ' + CHICKEN_ICON : ''}
              {/* Кочевник стоит в двух строках сразу — без пометки это выглядело бы как
                  два разных человека с одинаковым ником. Стрелка приглушена: она сноска
                  к нику, а не часть его. */}
              {e.moves ? <span style={{ color: C.faint, fontWeight: 400 }}> →</span> : null}
              {n < list.length - 1 ? <span style={{ color: C.faint, fontWeight: 400 }}>,</span> : null}
            </span>
          ))}
        </span>
      </div>
    );
  };

  // ---- Доска таймингов ----
  //
  // Долгая история, которую стоит держать в голове, чтобы не пойти по кругу.
  //
  // 1. Сначала расписание было ТЕКСТОМ в карточке бойца: «старт · 25′ · 20′ · 15′ —
  //    дальний топ». Минуты одинаковой длины с одинаковым разделителем не отделяются
  //    друг от друга глазом, и список менялся от бойца к бойцу — сравнить двоих нельзя.
  // 2. Потом это стало ПОЛОСАМИ на шкале, но шкала жила внутри каждой карточки, а
  //    подписи делений стояли один раз наверху колонки группы. Полоса пятого бойца
  //    оказывалась в пятистах пикселях от своей подписи: «вижу палочки и только спустя
  //    время догоняю, к чему они ведут».
  // 3. Потом расписание уехало вниз БЛОКАМИ ПО МИНУТАМ. Каждый блок читается легко, но
  //    боец должен найти себя в шести блоках подряд — «сидеть морщиться и искать себя».
  //
  // Правильный ответ был в форме из пункта 2, но её нельзя дробить: шкала работает только
  // когда ось ОДНА и стоит рядом со всеми строками сразу. Поэтому доска здесь одна на всю
  // сторону: строка на бойца, шесть колонок, подписи минут сверху и вертикальные линии
  // сетки НАСКВОЗЬ — по ним полоса и соотносится с минутой, где бы она ни была.
  //
  // Название лагеря написано ВНУТРИ полосы. Колонка шириной сто сорок пикселей вмещает
  // «Ближний ТОП» целиком даже в одну клетку, поэтому ни кодов, ни легенды не нужно:
  // читать нечего, всё написано словами там, где нарисовано.
  const BOARD = '168px repeat(6, minmax(0, 1fr))';

  // Полоса. Тёмная заливка со светлым текстом: залитая ярким прямоугольником строка
  // кричит громче имени бойца, а искать здесь будут именно имя.
  const bar = (key: string, row: number, from: number, to: number, text: string, color: string, bg: string) => (
    <span key={key} style={{
      gridRow: row, gridColumn: `${from + 2} / ${to + 3}`,
      background: bg, color, border: `1px solid ${color}33`,
      borderRadius: 5, fontSize: 11, lineHeight: 1.4,
      padding: '3px 8px', margin: '0 2px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      display: 'flex', alignItems: 'center'
    }}>{text}</span>
  );

  // Блок бойца: имя слева, под ним столько дорожек, сколько у него родов задач (лес и,
  // если ходит, босс). Имя занимает ВСЮ высоту блока и центрируется по ней — стоя на
  // первой дорожке, оно оказывалось выше своего же блока и не совпадало ни с чем.
  //
  // Деления минут рисуются ПОВЕРХ полос, а не под ними, и это главное.
  //
  // Раньше линия была фоновой клеткой, и полоса ложилась на неё сверху: у бойца, который
  // с 25-й до 5-й стоит в одном лагере, полоса шла сплошным прямоугольником через четыре
  // колонки без единого деления внутри. Определить по ней минуту было нечем — ровно на
  // это и пожаловались. Теперь деления пересекают полосы, и любая из них читается как
  // «с этой минуты по эту».
  //
  // Цвет полупрозрачный белый, а не сплошной: одна и та же линия ложится и на тёмный фон
  // страницы, и на заливку полосы — зелёную, янтарную, фуксиевую. Непрозрачный цвет
  // пришлось бы подбирать под каждую, а прозрачный работает поверх любой.
  const playerBoard = (key: string, label: React.ReactNode, lanes: React.ReactNode[][]) => (
    <div key={key} style={{ display: 'grid', gridTemplateColumns: BOARD, gridAutoRows: '26px', alignItems: 'center' }}>
      {/* Флекс, а не строчный поток: внутри инлайн-блок с иконкой роли, и в обычной строке
          он вставал на базовую линию лайнбокса, то есть выше центра дорожки. */}
      <span style={{
        gridColumn: 1, gridRow: `1 / span ${Math.max(1, lanes.length)}`, alignSelf: 'center',
        display: 'flex', alignItems: 'center', minWidth: 0,
        paddingRight: 10, overflow: 'hidden'
      }}>
        {label}
      </span>
      {lanes.map((bars, r) => (
        <React.Fragment key={r}>
          {bars}
          {/* Идут ПОСЛЕ полос: в гриде элементы одной клетки накладываются в порядке
              разметки, поэтому последний оказывается сверху. */}
          {(TIMINGS as string[]).map((tm: string, i: number) => (
            <span key={tm} style={{ gridRow: r + 1, gridColumn: i + 2, alignSelf: 'stretch', borderLeft: `1px solid ${TICK}` }} />
          ))}
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <div ref={ref} style={{ width: 1080, background: C.page, padding: 24, fontFamily: 'Inter, sans-serif', boxSizing: 'border-box' }}>
      {/* Шапка. Главное здесь — сторона, поэтому её название и есть заголовок; название
          события и дата уходят второй строкой. Раньше сторона была в рамке-бейдже
          крупнее заголовка, а над ней стояло разряжённое капсом «ШТАБ ВОЙНЫ». */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', borderBottom: `1px solid ${C.line}`, paddingBottom: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ display: 'inline-flex', width: 30, height: 30, borderRadius: 8, background: theme.markBg, color: theme.accent, alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}>
            {theme.symbol}
          </span>
          <div>
            <div style={{ color: theme.accent, fontSize: 22, fontWeight: 600, lineHeight: 1.15 }}>{SIDE_LABELS[side]}</div>
            {/* Вид картинки стоит в подзаголовке: две выгрузки одной стороны попадают в
                канал рядом, и различать их приходится глазом, а не по имени файла. */}
            <div style={{ color: C.faint, fontSize: 12, marginTop: 3 }}>
              {t('Штаб войны')} · {variant === 'roster' ? t('Состав') : t('Тайминги')}
              {session.name ? ' · ' + session.name : ''}{dateStr ? ' · ' + dateStr : ''}
            </div>
          </div>
        </div>
        {/* Счётчики отвечают на вопрос своей картинки: в составе это баланс ролей, в
            таймингах — сколько задач вообще расписано. Роли в гант не попадают. */}
        <div style={{ display: 'flex', gap: 22 }}>
          {variant === 'roster' ? <>
            {/* Цвет точки — от игровой иконки роли, как и на сайте (ROLE_COLORS) */}
            {stat(countRole(Role.TANK), ROLE_LABELS[Role.TANK], C.amber)}
            {stat(countRole(Role.DPS), ROLE_LABELS[Role.DPS], C.sky)}
            {stat(countRole(Role.HEALER), ROLE_LABELS[Role.HEALER], C.emerald)}
          </> : stat(countTasks(plan, assignments, side), t('Задач в плане'))}
          {stat(`${assignments.length}/15`, t('Всего'))}
        </div>
      </div>

      {variant === 'roster' && <>
      {/* Три группы — столбцами */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
        {GROUP_NUMBERS.map(group => {
          const lane = getLane(group);
          const tower = getTowerInfo(side, lane);
          const members = assignments
            .filter(a => a.group === group)
            .map(a => ({ a, p: playerById(a.playerId)! }))
            .filter(x => x.p)
            .sort((x, y) => ROLE_ORDER[x.p.role] - ROLE_ORDER[y.p.role] || x.p.name.localeCompare(y.p.name));
          return (
            <div key={group} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ background: C.raised, padding: '8px 11px', borderBottom: `1px solid ${C.lineStrong}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
                    <span style={{ display: 'inline-flex', width: 20, height: 20, borderRadius: 6, background: C.card, border: `1px solid ${C.lineStrong}`, color: theme.accent, alignItems: 'center', justifyContent: 'center', fontSize: 11, marginRight: 7 }}>{group}</span>
                    {t('Группа')} {group}
                  </span>
                  <span style={{ color: C.dim, fontSize: 12 }}>{LANE_LABELS[lane]}</span>
                </div>
                <div style={{ color: C.faint, fontSize: 11, marginTop: 4 }}>{tower ? tower.label : '—'} · {members.length}/{PLAYERS_PER_GROUP}</div>
              </div>
              <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 60 }}>
                {members.length === 0 ? (
                  <div style={{ color: C.faint, fontSize: 12, textAlign: 'center', padding: '14px 0' }}>{t('Пусто')}</div>
                ) : members.map(({ a, p }) => {
                  const calls = (p.callRoles || []);
                  const tags = tagsFor(a);
                  const weapons = (p.weapons || []).filter(w => WEAPON_SCHOOL_IMAGES[w]);
                  return (
                    <div key={p.id} style={{ background: '#1a1917', border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <img src={ROLE_IMG[p.role]} width={20} height={20} alt="" style={{ objectFit: 'contain', flexShrink: 0 }} />
                        <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                        {weapons.map((w, n) => (
                          <img key={n} src={WEAPON_SCHOOL_IMAGES[w]} title={WEAPON_SCHOOL_LABELS[w]} width={20} height={20} alt="" style={{ objectFit: 'contain', flexShrink: 0 }} />
                        ))}
                        {calls.map(cr => (
                          <span key={cr} title={CALL_ROLE_LABELS[cr]} style={{ color: C.amber, fontSize: 12 }}>
                            {cr === CallRole.RL ? '♛' : cr === CallRole.CHICKEN ? '🔔' : '📣'}
                          </span>
                        ))}
                      </div>
                      {tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 28 }}>{tags}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Лес списком: одна строка на точку, время убрано. Блок целиком исчезает, когда
          плана нет вовсе (ранкед, лига, просто не расписали) — пустой заголовок с пятью
          прочерками сообщал бы, что что-то потерялось. */}
      {jungleRows.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ color: C.dim, fontSize: 12, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: theme.accent }}>🌲</span>{t('Лес')}
          </div>
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'hidden' }}>
            {jungleRows.map(jungleRow)}
          </div>
        </div>
      )}
      </>}

      {variant === 'timings' && <>
      {/* Доска таймингов: одна на сторону, одна ось на всех. Почему именно так —
          в комментарии к BOARD выше, там же три предыдущие неудачные формы. */}
      <div style={{ marginTop: 20 }}>
        <div style={{ color: C.dim, fontSize: 12, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: theme.accent }}>⏱</span>{t('Тайминги')}
        </div>

        {/* Подписи минут — один раз на всю доску, прямо над первой строкой */}
        <div style={{ display: 'grid', gridTemplateColumns: BOARD, marginBottom: 6 }}>
          <span></span>
          {(TIMINGS as string[]).map((tm: string) => (
            <span key={tm} style={{
              color: C.dim, fontSize: 12, textAlign: 'center', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums', borderLeft: `1px solid ${TICK}`
            }}>
              {TIMING_LABELS[tm]}
            </span>
          ))}
        </div>

        {GROUP_NUMBERS.map(group => {
          const members = assignments
            .filter(a => a.group === group)
            .map(a => ({ a, p: playerById(a.playerId)! }))
            .filter(x => x.p)
            .sort((x, y) => ROLE_ORDER[x.p.role] - ROLE_ORDER[y.p.role] || x.p.name.localeCompare(y.p.name));
          if (!members.length) return null;
          return (
            // Пачки разделены явно: без этого четырнадцать строк читались одной кучей,
            // а группа — это то, чем боец меряет своё место в бою.
            <div key={group} style={{ marginTop: group === 1 ? 0 : 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                borderTop: group === 1 ? 'none' : `1px solid ${C.lineStrong}`,
                padding: group === 1 ? '0 0 6px' : '10px 0 6px'
              }}>
                <span style={{
                  display: 'inline-flex', width: 20, height: 20, borderRadius: 6,
                  background: C.raised, border: `1px solid ${C.lineStrong}`, color: theme.accent,
                  alignItems: 'center', justifyContent: 'center', fontSize: 11
                }}>{group}</span>
                <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{t('Группа')} {group}</span>
                <span style={{ color: C.faint, fontSize: 12 }}>· {LANE_LABELS[getLane(group)]}</span>
              </div>
              {members.map(({ p }, i) => {
                const { jungle, boss } = barsOf(plan, assignments, side, p.id);
                const label = (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <img src={ROLE_IMG[p.role]} width={16} height={16} alt="" style={{ objectFit: 'contain', flexShrink: 0 }} />
                    <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                  </span>
                );
                return (
                  <div key={p.id} style={{
                    background: i % 2 ? C.card : 'transparent',
                    borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
                    borderRadius: 6
                  }}>
                    {playerBoard(p.id, label, [
                      (jungle as any[]).map((b: any, n: number) => bar(
                        `b${n}`, 1, b.from, b.to,
                        `${SPOT_LABELS[b.camp]}${b.chicken ? ' ' + CHICKEN_ICON : ''}`,
                        C.emerald, '#10251d'
                      )),
                      ...((boss as any[]).length ? [(boss as any[]).map((b: any, n: number) => bar(
                        `s${n}`, 2, b.from, b.to,
                        `${SUBROLE_LABELS[SubRole.BOSS]}${b.chicken ? ' ' + CHICKEN_ICON : ''}`,
                        C.fuchsia, '#25102a'
                      ))] : [])
                    ])}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      </>}

      {/* Легенда. Цвет здесь несёт смысл — он тот же, что у чипов выше, — но сама
          строка приглушена: это сноска, а не содержимое приказа. У каждой картинки она
          своя: расшифровывать в таймингах значки, которых там нет, значит заставлять
          искать их глазами. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 14, paddingTop: 10, borderTop: `1px solid ${C.line}`, color: C.faint, fontSize: 11 }}>
        {variant === 'roster' ? <>
          {jungleRows.length > 0 && (
            <span>
              {t('Цвет ника')}: <span style={{ color: C.amber }}>{ROLE_LABELS[Role.TANK]}</span>
              {' · '}<span style={{ color: C.sky }}>{ROLE_LABELS[Role.DPS]}</span>
              {' · '}<span style={{ color: C.emerald }}>{ROLE_LABELS[Role.HEALER]}</span>
            </span>
          )}
          {/* Расшифровываем только то, что в этой картинке действительно есть: у атаки
              курицы не бывает, и строка про неё заставляла бы искать значок впустую. */}
          <span>
            <span style={{ color: C.sky }}>{SUBROLE_LABELS[SubRole.TOWER]}</span>
            {jungleRows.some((r: any) => r.players.some((p: any) => p.chicken)) && <> · <span style={{ color: C.amber }}>{CHICKEN_ICON} {t('Курица')}</span></>}
            {jungleRows.some((r: any) => r.players.some((p: any) => p.moves)) && <> · → {t('меняет точку за бой')}</>}
          </span>
          <span><span style={{ color: C.amber }}>♛</span> {CALL_ROLE_LABELS[CallRole.RL]} · <span style={{ color: C.amber }}>📣</span> {CALL_ROLE_LABELS[CallRole.SHOTCALLER]} · <span style={{ color: C.amber }}>🔔</span> {CALL_ROLE_LABELS[CallRole.CHICKEN]}</span>
        </> : (
          <span>
            <span style={{ color: C.emerald }}>{t('Лагерь в лесу')}</span> · <span style={{ color: C.fuchsia }}>{SUBROLE_LABELS[SubRole.BOSS]}</span> · <span style={{ color: C.amber }}>{CHICKEN_ICON} {t('Курица')}</span>
          </span>
        )}
      </div>
    </div>
  );
});

BattleOrderExport.displayName = 'BattleOrderExport';
export default BattleOrderExport;
