import React from 'react';
import Glyph from './glyphs';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { Player, Side, GroupNumber, WarAssignment, SubRole, CallRole } from '../types';
import {
  SIDES, SIDE_LABELS, SIDE_ICONS, SIDE_STYLES, SUBROLE_LABELS,
  TIMING_LABELS, CHICKEN_ICON, CALL_ROLE_LABELS, PLAYERS_PER_SIDE,
  GROUP_NUMBERS, LANE_LABELS, SPOT_LABELS, ROLE_ICONS,
  DEFAULT_GROUP_LANES, groupLaneKey
} from '../constants';
import { useT } from '../services/i18n';
import {
  TIMINGS, SPOTS, BOSS, bossAt, cellKey, cellPlayers, hasChicken, countTasks, barsOf
} from '../server/timings.mjs';

// Расписание леса и босса по минутам боя: строка — момент, столбец — куда бежать.
//
// Первая версия была сеткой из тридцати одинаковых коробок с рамкой у каждой и читалась
// как пустой каркас: все элементы кричали одинаково громко, четыре лагеря шли под
// четырьмя одинаковыми значками дерева, а половину площади занимали прочерки в пустых
// клетках. Что исправлено и почему:
//
// 1. Столбцы сгруппированы по смыслу — ТОП, БОТ и отдельно БОСС. Лагерей не четыре
//    равных, а две пары плюс объект другого рода. Группировка держится пробелом и одной
//    волосяной линией на стык, а не рамкой вокруг каждой ячейки.
// 2. Строка стала цельной полосой-моментом: одна поверхность на всю ширину вместо шести
//    отдельных коробок. Пустой момент приглушён — заполненные обязаны доминировать.
// 3. Появилась иерархия размера. Время — самое крупное в строке, потому что именно по
//    нему ищут; всё остальное мельче и тише.
// 4. Люди, попавшие в клетку через ссылку на пачку, потеряли обводку чипа и стали
//    строкой мелкого текста. Они следствие ссылки, а не решение офицера: семь одинаковых
//    чипов сливались в кашу, из которой не читалось, кого поставили руками.
// 5. Прочерки и надписи «нет босса» убраны. Пустая клетка пуста — это и есть ответ,
//    а повторённая четыре раза заглушка только шумит.
//
// Скрытого состояния нет намеренно: никаких «сейчас я редактирую вот эти тайминги».
// Что видишь — то и записано, поэтому промахнуться моментом невозможно.

// Столбцы заданы одной строкой на всю таблицу: шапка и строки обязаны стоять по одним
// вертикалям, иначе таблица перестаёт быть таблицей.
const COLS = 'grid grid-cols-[104px_repeat(4,minmax(0,1fr))_minmax(0,0.9fr)] gap-x-3';

// Стык групп столбцов. Пробел здесь не справляется: колонки узкие, и без линии
// «дальний ТОП» и «ближний БОТ» читаются как соседи одной пары.
const SEAM = 'border-l border-slate-700 pl-3 -ml-3';

const EMPTY: Set<string> = new Set();

interface Props {
  players: Player[];
  assignments: WarAssignment[];
  plan: Record<string, any>;
  side: Side;
  onSide: (s: Side) => void;
  isViewer: boolean;
  claimedPlayerId: string | null;
  dragging: boolean;
  groupLanes: Record<string, string>;
  selectedIds: Set<string>;
  onSelect: (id: string, e: React.MouseEvent) => void;
  // Правки клеток идут через готовые операции из server/timings.mjs — здесь только вызов
  ops: {
    dropPlayers: (a: any) => void;
    dropGroups: (a: any) => void;
    setChicken: (a: any) => void;
  };
}

const TimingsBoard: React.FC<Props> = ({
  players, assignments, plan, side, onSide, isViewer, claimedPlayerId,
  dragging, groupLanes, selectedIds, onSelect, ops
}) => {
  const t = useT();
  const nameOf = (id: string) => players.find(p => p.id === id)?.name || '—';
  // Кто коллит курицу — постоянная роль бойца, и ставится она в его карточке. Но со
  // вкладки таймингов туда не вело ничего, и вопрос «где протыкать коллера» оставался
  // без ответа. Показываем колокольчик прямо у имени: он и отвечает, и ведёт в карточку
  // (клик по имени открывает её справа).
  //
  // Только в клетках босса. Роль эта на весь бой, и повторённый в каждой из тридцати
  // клеток колокольчик перестал бы что-либо значить, а коллят курицу именно на боссе.
  const chickenCallers = new Set(players.filter(p => (p.callRoles || []).includes(CallRole.CHICKEN)).map(p => p.id));
  const total = countTasks(plan, assignments, side);
  const sideCount = assignments.filter(a => a.side === side).length;

  const renderCell = (timings: string[], spot: string, seam: boolean) => {
    const lead = timings[0];
    const boss = spot === BOSS;
    const possible = !boss || timings.some(bossAt);
    const ids = possible ? cellPlayers(plan, assignments, side, lead, spot) : [];
    const groups: GroupNumber[] = possible ? (plan[cellKey(side, lead, spot)]?.groups || []) : [];
    const named = new Set<string>(possible ? (plan[cellKey(side, lead, spot)]?.players || []) : []);
    const chicken = new Set(ids.filter(id => hasChicken(plan, side, lead, spot, id)));
    const namedIds = ids.filter(id => named.has(id));
    const viaGroup = ids.filter(id => !named.has(id));
    const empty = ids.length === 0 && groups.length === 0;

    const callers = boss ? chickenCallers : EMPTY;

    const chickenAction = (id: string) => () =>
      ops.setChicken({ side, timings, spot, playerIds: [id], on: !chicken.has(id) });

    return (
      <CellZone
        key={spot}
        id={`cell:${side}:${timings.join(',')}:${spot}`}
        data={{ type: 'cell', side, timings, spot }}
        disabled={isViewer || !possible}
        className={seam ? SEAM : ''}
      >
        {(over) => (
          <div
            className={`h-full min-h-8 rounded-lg transition-colors duration-200
              ${over ? 'bg-amber-950/40 ring-1 ring-amber-600'
                : dragging && possible && !isViewer ? 'ring-1 ring-slate-800' : ''}`}
          >
            {empty ? (
              <span className="sr-only">{t('Пусто')}</span>
            ) : viaGroup.length > 0 ? (
              // Подпись пачки стоит В ОДНОЙ строке с именами, а не отдельной строкой над
              // ними. Отдельной строкой клетка становилась двухстрочной, и соседние
              // однострочные клетки съезжали относительно неё — строка выглядела кривой,
              // хотя выравнивание было верным.
              <GroupBlock
                // Кроме пачки в клетке никого — разворачиваем сразу. Свёрнутая подпись в
                // пустой клетке читается как «тут почти ничего нет», хотя там пять человек.
                defaultOpen={namedIds.length === 0}
                label={groups.map(g => `${t('Гр.')}${g}`).join(', ')}
                ids={viaGroup}
                lead={namedIds.length > 0 ? (
                  <NameList
                    ids={namedIds}
                    nameOf={nameOf} claimedPlayerId={claimedPlayerId} selectedIds={selectedIds}
                    chicken={chicken} callers={callers} isViewer={isViewer} onSelect={onSelect}
                    onChicken={chickenAction}
                    onRemove={(id) => ops.dropPlayers({ side, timings, spot, playerIds: [id] })}
                  />
                ) : null}
                nameOf={nameOf} claimedPlayerId={claimedPlayerId} selectedIds={selectedIds}
                chicken={chicken} callers={callers} isViewer={isViewer}
                onSelect={onSelect}
                onChicken={chickenAction}
                onRemove={(id) => ops.dropPlayers({ side, timings, spot, playerIds: [id] })}
                onDropGroup={() => ops.dropGroups({ side, timings, spot, groups })}
              />
            ) : (
              <p className="text-xs leading-6 text-slate-200">
                <NameList
                  ids={namedIds}
                  nameOf={nameOf} claimedPlayerId={claimedPlayerId} selectedIds={selectedIds}
                  chicken={chicken} callers={callers} isViewer={isViewer} onSelect={onSelect}
                  onChicken={chickenAction}
                  onRemove={(id) => ops.dropPlayers({ side, timings, spot, playerIds: [id] })}
                />
              </p>
            )}
          </div>
        )}
      </CellZone>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Полоса стороны. Без рамки и фона: это управление над таблицей, а ещё одна
          карточка стала бы четвёртой горизонтальной коробкой подряд. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {SIDES.map(s => {
            const st = SIDE_STYLES[s];
            const active = side === s;
            return (
              <button key={s} onClick={() => onSide(s)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold border transition-colors duration-200
                  ${active ? `${st.accent} border-transparent text-white` : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'}`}>
                <i className={`fa-solid ${SIDE_ICONS[s]}`}></i>{SIDE_LABELS[s]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-6 text-xs text-slate-500">
          <span>
            {t('В составе')}{' '}
            <span className={`font-semibold tnum ${sideCount === PLAYERS_PER_SIDE ? 'text-emerald-400' : 'text-slate-200'}`}>
              {sideCount}/{PLAYERS_PER_SIDE}
            </span>
          </span>
          <span>
            {t('Задач в плане')} <span className="font-semibold tnum text-slate-200">{total}</span>
          </span>
        </div>
      </div>

      {/* Таблица скроллится вбок целиком: пять узких колонок на телефоне сложились бы
          в тридцать строк подряд и перестали быть таблицей. */}
      <div className="overflow-x-auto custom-scrollbar">
        <div className="min-w-[900px] flex flex-col gap-2">
          {/* Шапка в два яруса: сверху рубрика группы, снизу сам лагерь. Одна рубрика на
              пару объясняет столбцы лучше, чем четыре одинаковых значка дерева. */}
          <div className={`${COLS} px-4`}>
            <span></span>
            {/* Слово «Лес» в рубрике обязательно. Без него оставались стрелка и «ТОП»,
                и было непонятно, какие столбцы про лес, а какой про босса — значка
                дерева для этого мало. */}
            <span className="col-span-2 text-[11px] uppercase tracking-widest text-emerald-500/80 flex items-center gap-2">
              <Glyph name="jungle" />{SUBROLE_LABELS[SubRole.JUNGLE]} · {t('Топ')}
            </span>
            <span className={`col-span-2 text-[11px] uppercase tracking-widest text-emerald-500/80 flex items-center gap-2 ${SEAM}`}>
              <Glyph name="jungle" />{SUBROLE_LABELS[SubRole.JUNGLE]} · {t('Бот')}
            </span>
            <span className={`text-[11px] uppercase tracking-widest text-fuchsia-500/80 flex items-center gap-2 ${SEAM}`}>
              <Glyph name="boss" />{t('Босс')}
            </span>
          </div>
          <div className={`${COLS} px-4 pb-1`}>
            <span></span>
            {/* Ближний и дальний — то, ЧТО именно ищут в этой таблице, поэтому набраны
                не тише всего, а заметно. Приглушённой подписью в 11 пикселей столбец
                опознать не получалось: строки высокие, шапка далеко. */}
            <span className="text-sm font-semibold text-slate-300">{t('ближний')}</span>
            <span className="text-sm font-semibold text-slate-300">{t('дальний')}</span>
            <span className={`text-sm font-semibold text-slate-300 ${SEAM}`}>{t('ближний')}</span>
            <span className="text-sm font-semibold text-slate-300">{t('дальний')}</span>
            <span className={`text-sm font-semibold text-slate-300 tnum ${SEAM}`}>25′ {t('и')} 15′</span>
          </div>

          {/* Шесть строк, всегда и в порядке боя. Схлопывание одинаковых тут было и
              переставляло строки местами — «старт», «25 · 15 · 10 · 5», «20», — потому что
              совпадало содержимое, а не время. Ось, идущая не по времени, читателю не ось.
              Быстрый ввод не пострадал: «сразу на 25/15/10/5» делает модалка в карточке. */}
          {(TIMINGS as string[]).map((tm: string) => {
            const filled = SPOTS.some(sp => cellPlayers(plan, assignments, side, tm, sp).length > 0);
            return (
              <div
                key={tm}
                // Клетки выровнены по ВЕРХУ. Центрирование пробовалось и не годится: когда
                // в одной клетке две строки, а в соседней одна, центрированная однострочная
                // не совпадает ни с чем — глазу не за что зацепиться при чтении строки.
                // По верху первые строки всех клеток стоят на одной линии, а продолжение
                // свисает вниз — так устроена любая таблица с ячейками разной высоты.
                className={`${COLS} items-start px-4 py-3 rounded-lg transition-colors duration-200
                  ${filled ? 'bg-slate-900' : 'bg-slate-900/40'}`}
              >
                {/* Время — якорь строки и самое заметное в ней: по нему и ищут */}
                <span className={`text-sm font-semibold tnum leading-6 ${filled ? 'text-slate-200' : 'text-slate-600'}`}>
                  {TIMING_LABELS[tm]}
                </span>
                {renderCell([tm], 'top_near', false)}
                {renderCell([tm], 'top_far', false)}
                {renderCell([tm], 'bot_near', true)}
                {renderCell([tm], 'bot_far', false)}
                {renderCell([tm], BOSS, true)}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <TimingsGantt
          players={players} assignments={assignments} plan={plan} side={side}
          claimedPlayerId={claimedPlayerId} groupLanes={groupLanes}
        />
      </div>

      {!isViewer && (
        <p className="text-xs text-slate-500 flex items-center gap-2">
          <i className="fa-solid fa-arrow-pointer text-amber-500/60"></i>
          {t('Тяните бойца или пачку из списка слева в клетку. 🐔 у имени ставит курицу на эту задачу. Клик по имени выделяет бойца: справа откроется карточка, а рядом появится ✕, чтобы убрать его отсюда.')}
        </p>
      )}
    </div>
  );
};

// Правило таблицы: **ничто не меняет раскладку от движения мыши.**
//
// Сначала 🐔 и ✕ показывались при наведении, и это оказалось источником случайных правок:
// появляясь, они раздвигали строку — ведёшь курсор к «Nadira», по пути задеваешь соседа,
// он распухает, «Nadira» уезжает вправо, и клик попадает в чужую курицу. Так в данных и
// завелась курица у бойца, которого в приказе с ней нет.
//
// Потом управление показывалось только у выделенного — раскладка перестала прыгать, но
// поставить курицу стало в два клика, а это самое частое действие в таблице.
//
// Итог: **место под курицу зарезервировано всегда**, поэтому появление её не двигает
// ничего, а сама она проступает при наведении на своё же имя. Один клик, ноль сдвигов.
// Крестик остаётся у выделенного: удаление редкое и необратимое, и лишний шаг тут кстати.

// Пачка в клетке. Подпись «Гр.1» с числом стоит в одной строке с поимёнными бойцами,
// а состав пачки разворачивается под ними.
//
// Открытие раньше держалось на CSS `group-hover` плюс клике, и эти два механизма дрались:
// закрываешь кликом, курсор всё ещё над подписью — CSS тут же открывает обратно, и клик
// выглядит сломанным. Поэтому состояние целиком в JS: наведение открывает, пока человек
// не решил иначе, а клик закрепляет своё решение и перебивает наведение. Тач-устройства
// и клавиатура работают тем же кодом, отдельных правил для них не нужно.
const GroupBlock: React.FC<{
  label: string;
  defaultOpen?: boolean;
  lead?: React.ReactNode;
  ids: string[];
  nameOf: (id: string) => string;
  claimedPlayerId: string | null;
  selectedIds: Set<string>;
  chicken: Set<string>;
  callers: Set<string>;
  isViewer: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onChicken: (id: string) => () => void;
  onRemove: (id: string) => void;
  onDropGroup: () => void;
}> = ({ label, defaultOpen = false, lead, ids, nameOf, claimedPlayerId, selectedIds, chicken, callers, isViewer, onSelect, onChicken, onRemove, onDropGroup }) => {
  const t = useT();
  // Только клик. Наведение открывало пачку само, дралось с кликом и раздвигало строку
  // от движения мыши — то же самое, из-за чего в таблице накликивались чужие курицы.
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div className="text-xs leading-6">
      {/* Поимённые бойцы идут ПЕРВОЙ строкой, пачка — отдельным блоком под ними.
          Пока подпись пачки стояла в одной строке с именами, её состав уезжал под
          последнее из них: список имён переносится, и «Jemi, psy» оказывались под
          «Jyshtare», читаясь как его продолжение. Теперь состав стоит ровно под словом
          «Гр.3», а первой строкой клетки всегда идёт имя — по ним и выравнивается строка. */}
      {lead && <p className="text-slate-200">{lead}</p>}
      <p>
        <span className="group/chip whitespace-nowrap text-amber-500">
          <button
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 align-baseline"
          >
            {label}
            <span className="text-slate-500 tnum">{ids.length}</span>
            <i className={`fa-solid fa-chevron-down text-slate-600 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}></i>
          </button>
          {!isViewer && (
            <button
              onClick={onDropGroup}
              aria-label={t('Убрать всю пачку из этой клетки')}
              className="w-6 h-6 -my-1 inline-flex items-center justify-center text-slate-600 hover:text-red-400 transition-colors duration-200"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
          )}
        </span>
      </p>

      {/* Состав пачки отбит слева янтарной чертой и отступом. Без неё он висел третьей
          строкой сразу под поимёнными бойцами и читался как продолжение последнего из
          них: «Jemi, psy» выглядели приписанными к «Jyshtare», а не к «Гр.3».
          Раскрытие — grid-template-rows 0fr → 1fr: высота едет сама, без замеров в JS. */}
      <div className={`grid transition-[grid-template-rows] duration-200 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <p className="overflow-hidden text-slate-400 border-l border-amber-700/40 pl-2 ml-1">
          <NameList
            ids={ids}
            nameOf={nameOf} claimedPlayerId={claimedPlayerId} selectedIds={selectedIds}
            chicken={chicken} callers={callers} isViewer={isViewer}
            onSelect={onSelect} onChicken={onChicken} onRemove={onRemove}
            removeTitle={t('Вычеркнуть из этой пачки здесь')}
          />
        </p>
      </div>
    </div>
  );
};

// Та же доска, что уходит в картинку приказа, — прямо под редактором.
//
// Офицер раскладывает людей по клеткам «лагерь × минута», а гильдия читает результат
// в обратной раскладке: строка на бойца, минуты по горизонтали. Держать эти два вида в
// голове одновременно тяжело, и владелец на это и пожаловался. Поэтому итог показан тут
// же, в том же виде, в каком его увидят: положил человека в клетку — сразу видно, как
// это прочитает он сам.
//
// Редактировать отсюда нельзя намеренно. Ссылку на пачку («Гр.1») в такой раскладке
// выразить нечем — строка принадлежит бойцу, а не пачке, — и редактор здесь заставил бы
// разворачивать пачки в фамилии, то есть терять то, ради чего ссылки и заведены.
// Деление минуты. Продублировано с картинкой приказа шестнадцатеричным значением, а не
// классом Tailwind: html-to-image внешних таблиц стилей не видит, и в картинке цвет
// задаётся инлайном. Менять только в паре.
const TICK = 'rgba(231,227,221,0.20)';

const GANTT = 'grid grid-cols-[176px_repeat(6,minmax(0,1fr))]';

const GanttPlayer: React.FC<{
  label: React.ReactNode;
  lanes: { from: number; to: number; text: string; boss?: boolean }[][];
}> = ({ label, lanes }) => (
  // Имя занимает ВСЮ высоту блока и центрируется по ней. Стоя на первой дорожке, оно
  // оказывалось выше собственного блока: у бойца с боссом дорожек две, и подпись
  // не совпадала ни с чем.
  <div className={`${GANTT} items-center`} style={{ gridAutoRows: '28px' }}>
    {/* Флекс, а не строчный поток: внутри лежит инлайн-блок с иконкой роли, и в обычной
        строке он вставал на базовую линию 24-пиксельного лайнбокса, то есть выше центра
        дорожки. `flex items-center` центрирует его по фактической высоте блока — без
        подгонки пикселями и независимо от того, одна дорожка у бойца или две. */}
    <span className="col-start-1 self-center flex items-center min-w-0 pr-3" style={{ gridRow: `1 / span ${Math.max(1, lanes.length)}` }}>
      {label}
    </span>
    {lanes.map((bars, r) => (
      <React.Fragment key={r}>
        {bars.map((b, i) => (
          <span
            key={i}
            style={{ gridRow: r + 1, gridColumn: `${b.from + 2} / ${b.to + 3}` }}
            className={`truncate rounded-lg border px-2 py-1 text-xs self-center
              ${b.boss
                ? 'border-fuchsia-800/60 bg-fuchsia-950/50 text-fuchsia-300'
                : 'border-emerald-800/60 bg-emerald-950/50 text-emerald-300'}`}
          >
            {b.text}
          </span>
        ))}
        {/* Деления минут идут ПОСЛЕ полос, то есть поверх них: в гриде элементы одной
            клетки накладываются в порядке разметки. Полоса, растянутая с 25-й до 5-й,
            иначе шла сплошным прямоугольником, и минуту на ней было не определить.
            Цвет полупрозрачный белый (TICK): одна и та же линия ложится и на тёмный фон,
            и на зелёную, янтарную или фуксиевую заливку. */}
        {(TIMINGS as string[]).map((tm: string, i: number) => (
          <span key={tm} className="self-stretch" style={{ gridRow: r + 1, gridColumnStart: i + 2, borderLeft: `1px solid ${TICK}` }} />
        ))}
      </React.Fragment>
    ))}
  </div>
);

const TimingsGantt: React.FC<{
  players: Player[];
  assignments: WarAssignment[];
  plan: Record<string, any>;
  side: Side;
  claimedPlayerId: string | null;
  groupLanes: Record<string, string>;
}> = ({ players, assignments, plan, side, claimedPlayerId, groupLanes }) => {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500 flex items-center gap-2">
        <i className="fa-solid fa-eye text-slate-600"></i>
        {t('Так это увидят игроки — тот же вид уходит в картинку приказа')}
      </p>

      <div className="overflow-x-auto custom-scrollbar">
        <div className="min-w-[820px] flex flex-col">
          {/* Ось — одна на всю доску, подписи стоят над своими же колонками */}
          <div className={`${GANTT} pb-2`}>
            <span></span>
            {(TIMINGS as string[]).map((tm: string) => (
              <span key={tm} className="text-xs font-semibold text-slate-400 text-center tnum border-l border-slate-800">
                {TIMING_LABELS[tm]}
              </span>
            ))}
          </div>

          {GROUP_NUMBERS.map(group => {
            const members = assignments
              .filter(a => a.side === side && a.group === group)
              .map(a => players.find(p => p.id === a.playerId))
              .filter((p): p is Player => !!p);
            if (!members.length) return null;
            const laneKey = groupLaneKey(side, group);
            const lane = groupLanes[laneKey] ?? DEFAULT_GROUP_LANES[laneKey];
            return (
              <div key={group} className={group === 1 ? '' : 'mt-4 border-t border-slate-700 pt-3'}>
                <div className="flex items-center gap-2 pb-2">
                  <span className="w-6 h-6 rounded-lg bg-slate-800 border border-slate-700 text-amber-500 text-xs flex items-center justify-center">
                    {group}
                  </span>
                  <span className="text-xs font-semibold text-slate-200">{t('Группа')} {group}</span>
                  <span className="text-xs text-slate-500">· {LANE_LABELS[lane as never]}</span>
                </div>
                {members.map((p, i) => {
                  const { jungle, boss } = barsOf(plan, assignments, side, p.id);
                  const mine = p.id === claimedPlayerId;
                  return (
                    <div key={p.id} className={`rounded-lg ${i % 2 ? 'bg-slate-900' : ''} ${i ? 'border-t border-slate-800' : ''}`}>
                      <GanttPlayer
                        label={
                          <span className="inline-flex items-center gap-2 min-w-0">
                            <span className="w-4 h-4 shrink-0">{ROLE_ICONS[p.role]}</span>
                            <span className={`text-xs font-semibold truncate ${mine ? 'text-amber-400' : 'text-slate-200'}`}>{p.name}</span>
                          </span>
                        }
                        lanes={[
                          (jungle as any[]).map(b => ({
                            from: b.from, to: b.to,
                            text: `${SPOT_LABELS[b.camp]}${b.chicken ? ' ' + CHICKEN_ICON : ''}`
                          })),
                          ...((boss as any[]).length ? [(boss as any[]).map(b => ({
                            from: b.from, to: b.to, boss: true,
                            text: `${SUBROLE_LABELS[SubRole.BOSS]}${b.chicken ? ' ' + CHICKEN_ICON : ''}`
                          }))] : [])
                        ]}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// Перечисление имён. Точка-разделитель приклеена к СЛЕДУЮЩЕМУ имени неразрывным
// пробелом и завёрнута вместе с ним в `whitespace-nowrap`: одного неразрывного пробела
// мало, потому что имя — атомарный inline-блок, и браузер всё равно рвал строку перед
// ним, оставляя в конце висячую точку, похожую на опечатку. Перенос теперь возможен
// только по обычному пробелу МЕЖДУ парами «точка + имя».
const NameList: React.FC<{
  ids: string[];
  nameOf: (id: string) => string;
  claimedPlayerId: string | null;
  selectedIds: Set<string>;
  chicken: Set<string>;
  callers: Set<string>;
  isViewer: boolean;
  removeTitle?: string;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onChicken: (id: string) => () => void;
  onRemove: (id: string) => void;
}> = ({ ids, nameOf, claimedPlayerId, selectedIds, chicken, callers, isViewer, removeTitle, onSelect, onChicken, onRemove }) => (
  <>
    {ids.map((id, i) => (
      <React.Fragment key={id}>
        {i > 0 && ' '}
        <span className="whitespace-nowrap">
          {i > 0 && <span className="text-slate-600">·{'\u00a0'}</span>}
          <PersonName
            name={nameOf(id)} mine={id === claimedPlayerId} chicken={chicken.has(id)}
            caller={callers.has(id)}
            selected={selectedIds.has(id)} isViewer={isViewer} removeTitle={removeTitle}
            onSelect={(e) => onSelect(id, e)}
            onChicken={onChicken(id)}
            onRemove={() => onRemove(id)}
          />
        </span>
      </React.Fragment>
    ))}
  </>
);

// Имя в клетке. Обводки нет ни у кого: двенадцать обведённых имён в одной клетке
// читались как каркас, а не как состав. Все имена одного цвета — откуда человек взялся,
// говорит подпись «из Гр.1» перед списком, а не оттенок, который надо угадывать.
const PersonName: React.FC<{
  name: string; mine: boolean; chicken: boolean; caller: boolean;
  selected: boolean; isViewer: boolean; removeTitle?: string;
  onSelect: (e: React.MouseEvent) => void;
  onChicken: () => void;
  onRemove: () => void;
}> = ({ name, mine, chicken, caller, selected, isViewer, removeTitle, onSelect, onChicken, onRemove }) => {
  const t = useT();
  const chickenLabel = chicken ? t('Убрать курицу с этой задачи') : t('Несёт курицу на эту задачу');
  return (
    <span className={`group/chip inline-flex items-center gap-1 align-baseline rounded-lg
      ${selected ? 'bg-amber-950/40 px-2 text-amber-200 ring-1 ring-amber-700/60'
        : mine ? 'text-amber-400' : ''}`}>
      <button
        onClick={onSelect}
        className="hover:underline decoration-dotted underline-offset-4 transition-colors duration-200"
      >
        {name}
      </button>
      {caller && (
        <span title={CALL_ROLE_LABELS[CallRole.CHICKEN]} aria-label={CALL_ROLE_LABELS[CallRole.CHICKEN]}
          className="not-italic leading-none">🔔</span>
      )}
      {/* Место под курицу занято всегда — поэтому её появление ничего не двигает */}
      {(!isViewer || chicken) && (
        <span className="inline-flex w-4 justify-center">
          {isViewer
            ? <span className="not-italic leading-none">{CHICKEN_ICON}</span>
            : (
              <button
                onClick={onChicken} title={chickenLabel} aria-label={chickenLabel} aria-pressed={chicken}
                className={`not-italic leading-none transition-opacity duration-200
                  ${chicken ? '' : 'grayscale opacity-0 group-hover/chip:opacity-60 hover:opacity-100 focus-visible:opacity-100'}`}
              >
                {CHICKEN_ICON}
              </button>
            )}
        </span>
      )}
      {selected && !isViewer && (
        <button
          onClick={onRemove}
          aria-label={removeTitle || t('Убрать из клетки')}
          className="w-5 h-5 inline-flex items-center justify-center text-slate-400 hover:text-red-400 transition-colors duration-200"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      )}
    </span>
  );
};

// Клетка-приёмник. Живёт внутри DndContext штаба, поэтому свой контекст не заводит.
const CellZone: React.FC<{
  id: string;
  data: Record<string, unknown>;
  disabled: boolean;
  className?: string;
  children: (over: boolean) => React.ReactNode;
}> = ({ id, data, disabled, className = '', children }) => {
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled });
  return <div ref={setNodeRef} className={`min-w-0 ${className}`}>{children(isOver && !disabled)}</div>;
};

// Ручка группы в боковом списке — тянется в клетку и кладёт туда ССЫЛКУ на группу,
// а не пять фамилий: переставленный между группами боец должен уходить из леса сам.
export const GroupHandle: React.FC<{ side: Side; group: GroupNumber; count: number; disabled?: boolean }> = ({ side, group, count, disabled }) => {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tgrp:${side}:${group}`,
    data: { type: 'timingGroup', side, group },
    disabled
  });
  return (
    <span
      ref={setNodeRef} {...attributes} {...listeners}
      className={`inline-flex items-center gap-2 px-2 py-1 rounded-lg border text-xs font-semibold transition-colors duration-200
        ${disabled ? 'border-slate-800 bg-slate-900 text-slate-600'
          : 'border-amber-700/60 bg-amber-600/10 text-amber-300 cursor-grab active:cursor-grabbing hover:border-amber-600'}
        ${isDragging ? 'opacity-40' : ''}`}
    >
      <i className="fa-solid fa-grip-vertical text-slate-600"></i>
      {t('Гр.')}{group}
      <span className="text-slate-500 tnum">{count}</span>
    </span>
  );
};

export default TimingsBoard;
