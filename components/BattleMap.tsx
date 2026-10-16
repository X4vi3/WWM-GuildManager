import React, { useRef, useState, useMemo, useEffect } from 'react';
import {
  Player, Role, MapPosition,
  DrawShape, DrawPoint, ObjectiveType, ObjectiveMarker, MapText, MapTemplate
} from '../types';
import { ROLE_ICONS, ROLE_LABELS } from '../constants';
import { IMAGES } from '../images';
import { useT } from '../services/i18n';
import { Watermark, GLYPHS } from './decor';

interface BattleMapProps {
  players: Player[];
  mapTemplate: MapTemplate;          // активная стратегия карты (независима от событий)
  onUpdateMap: (next: MapTemplate) => void;
  isViewer?: boolean;
}

// Инструмент карты
type Tool = 'select' | 'pen' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// #rrggbb + прозрачность → rgba() (заливки зон и плашек текста)
const hexToRgba = (hex: string, a: number) => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
};

// Ограничивающий прямоугольник набора точек (в % карты)
const shapeBBox = (pts: DrawPoint[]) => {
  let minX = 100, minY = 100, maxX = 0, maxY = 0;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
};

const ZONE_DEFAULT_OPACITY = 0.25; // прозрачность заливки зон по умолчанию
// Координаты храним в процентах с 1 знаком после запятой: на карте ~700px это <1px,
// глазу незаметно, а JSON/трафик при сотнях точек на кисть худеют в разы.
const round1 = (n: number) => Math.round(n * 10) / 10;

// Размер шрифта подписи: по умолчанию и границы
const DEFAULT_TEXT_SIZE = 15;
const MIN_TEXT_SIZE = 9;
const MAX_TEXT_SIZE = 48;

// Где стоит панель инструментов рисования (снизу/слева) — локальный выбор каждого
const TOOLBAR_POS_KEY = 'wmgs_map_toolbar';

// ---- Сетка привязки ----
//
// Зачем. Зона рисуется двумя произвольными углами в процентах, и состыковать два
// прямоугольника вручную физически невозможно: промах в десятую долю процента — это
// щель или нахлёст. Отсюда обе жалобы разом, «сложить вместе не получается» и
// «не перемещаются» — второе про то же самое, просто при перетаскивании.
//
// Шаг задан в процентах ШИРИНЫ. По высоте он пересчитывается через фактические
// пропорции поля (`stepYof`), иначе «квадрат» выйдет прямоугольником: координаты по
// осям независимы, 2.4% ширины и 2.4% высоты — это разное число пикселей.
// Шаги КРАТНЫ друг другу, и это не косметика. Были 1.6 / 2.4 / 3.6: 2.4 не делится на
// 1.6, поэтому зона, посаженная на средний шаг, оказывалась между узлами мелкого — и две
// зоны, размеченные при разных шагах, состыковать было уже нельзя. При кратных шагах
// узлы крупной сетки лежат на средней, а средней на мелкой, поэтому что угодно
// стыкуется с чем угодно независимо от того, каким шагом это рисовали.
const GRID_STEPS: { label: string; v: number }[] = [
  { label: 'Мелкая', v: 1.2 },
  { label: 'Средняя', v: 2.4 },
  { label: 'Крупная', v: 4.8 }
];
const DEFAULT_GRID = 2.4;
const SNAP_KEY = 'wmgs_map_snap';

// Шаг по высоте, дающий на экране квадрат: доля ширины × отношение сторон поля.
const stepYof = (step: number, w: number, h: number) => (h > 0 ? step * (w / h) : step);
const snapTo = (v: number, step: number) => Math.round(v / step) * step;

// Сочетания клавиш. Списком в одном месте, а не россыпью по подсказкам: их девять, и
// пока они были размазаны по трём предложениям и подписям кнопок, половину было негде
// увидеть вовсе — про Ctrl+D и рамку выделения не знал никто.
//
// Подписи КОРОТКИЕ намеренно. Блок стоит в узкой боковой колонке, и длинное описание там
// переносится на три строки, а список из девяти таких превращается в простыню. Подробности
// живут во всплывающих подсказках у самих кнопок — здесь нужен указатель, а не инструкция.
//
// Просмотрщику показываем только доступное ему: приближение и перенос карты. Остальное
// требует права правки, и предлагать его значило бы врать.
const VIEW_KEYS: [string, string][] = [
  ['Ctrl + колесо', 'приблизить'],
  ['Пробел + мышь', 'двигать карту']
];
const EDIT_KEYS: [string, string][] = [
  ['Ctrl + Z', 'отменить'],
  ['Ctrl + Y', 'вернуть'],
  ['Ctrl + D', 'дублировать'],
  ['Delete', 'удалить выбранное'],
  ['Shift + клик', 'добавить к выделению'],
  ['Протяжка по пустому', 'рамка выделения'],
  ['Alt', 'строго по сетке']
];

// ---- Палитра рисования ----
const DRAW_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];
const DRAW_WIDTHS: { label: string; v: number }[] = [
  { label: 'Тонкая', v: 2 },
  { label: 'Средняя', v: 4 },
  { label: 'Толстая', v: 7 }
];

// ---- Встроенные тактические объекты WWM (изображения из assets) ----
const OBJECTIVE_CONFIG: Record<ObjectiveType, { label: string; img: string }> = {
  'tower-enemy': { label: 'Вражеская башня', img: IMAGES.towerEnemy },
  'tower-ally':  { label: 'Союзная башня',   img: IMAGES.towerAlly },
  'tree-enemy':  { label: 'Вражеский лес',   img: IMAGES.treeEnemy },
  'tree-ally':   { label: 'Союзный лес',     img: IMAGES.treeAlly },
  'goose-enemy': { label: 'Вражеский гусь',  img: IMAGES.gooseEnemy },
  'goose-ally':  { label: 'Союзный гусь',    img: IMAGES.gooseAlly },
  'boss':        { label: 'Босс',            img: IMAGES.boss },
  'mark-tank':   { label: 'Метка: Танк',     img: IMAGES.tank },
  'mark-heal':   { label: 'Метка: Хил',      img: IMAGES.healer },
  'mark-dps':    { label: 'Метка: ДД',       img: IMAGES.dps }
};
const OBJECTIVE_PALETTE: ObjectiveType[] = [
  'tower-enemy', 'tower-ally', 'tree-enemy', 'tree-ally',
  'goose-enemy', 'goose-ally', 'boss', 'mark-tank', 'mark-heal', 'mark-dps'
];

// Цвет токена по роли (карта больше не привязана к стороне атака/деф).
// Цвета — от игровых иконок ролей, см. ROLE_COLORS в constants.tsx.
const ROLE_RING: Record<Role, string> = {
  [Role.TANK]: 'ring-amber-400 bg-amber-950/90',
  [Role.HEALER]: 'ring-emerald-400 bg-emerald-950/90',
  [Role.DPS]: 'ring-sky-400 bg-sky-950/90'
};
const ROLE_DOT: Record<Role, string> = {
  [Role.TANK]: 'bg-amber-400',
  [Role.HEALER]: 'bg-emerald-400',
  [Role.DPS]: 'bg-sky-400'
};
const ROLE_ORDER: Record<Role, number> = { [Role.TANK]: 0, [Role.DPS]: 1, [Role.HEALER]: 2 };

// Сетка позиций по умолчанию (когда ставим бойцов «как есть»)
const GRID_COLS = 9;
const gridSlot = (i: number): MapPosition => ({
  x: clamp(10 + (i % GRID_COLS) * 9.5, 4, 96),
  y: clamp(12 + Math.floor(i / GRID_COLS) * 9, 4, 72)
});

const BattleMap: React.FC<BattleMapProps> = ({ players, mapTemplate, onUpdateMap, isViewer = false }) => {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ kind: 'token' | 'objective' | 'text'; id: string; x: number; y: number } | null>(null);

  // Рисование
  const [tool, setTool] = useState<Tool>('select');
  const [drawColor, setDrawColor] = useState('#ef4444');
  const [drawWidth, setDrawWidth] = useState(4);
  const [drawing, setDrawing] = useState<DrawShape | null>(null);
  const [redoStack, setRedoStack] = useState<DrawShape[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [textResize, setTextResize] = useState<{ id: string; startSize: number; cx: number; cy: number; startDist: number; size: number } | null>(null);
  const lastTextClickRef = useRef<{ id: string; t: number } | null>(null);
  // Пунктир для новых линий/стрелок/зон
  const [dashOn, setDashOn] = useState(false);
  // Выделенная фигура (инструмент «Выбор»): двигать, ресайзить, перекрашивать, удалять
  // Выделение — СПИСОК. Одиночное это его частный случай: ручки за угол и панель свойств
  // показываются, когда выбран ровно один, потому что тянуть угол у пятерых разом нечего.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Рамка-резинка по пустому месту (в процентах карты)
  const [marquee, setMarquee] = useState<{ a: MapPosition; b: MapPosition } | null>(null);
  const [shapeDrag, setShapeDrag] = useState<{
    mode: 'move' | 'corner' | 'end';
    id: string;
    start: MapPosition;      // где нажали (для move)
    orig: DrawPoint[];       // исходные точки (corner: [зафикс. угол, тянущийся])
    points: DrawPoint[];     // живые точки на время перетаскивания
    // Групповой перенос: исходные и живые точки КАЖДОЙ выделенной фигуры. Одиночная
    // фигура — тот же механизм со списком из одного, отдельной ветки для неё нет.
    origAll?: Record<string, DrawPoint[]>;
    pointsAll?: Record<string, DrawPoint[]>;
    endIndex?: 0 | 1;        // какой конец тянем (line/arrow)
  } | null>(null);
  // Привязка ВЫКЛЮЧЕНА по умолчанию, а Alt её включает: обычное перетаскивание должно
  // оставаться обычным, сетка нужна только когда что-то собирают в плитку.
  //
  // Alt при этом не «включает», а ИНВЕРТИРУЕТ текущее состояние — так устроено в
  // чертёжных редакторах и в Blender. Одна клавиша закрывает оба случая: при выключенной
  // привязке она даёт разовую посадку на сетку, при включённой — разовую свободу.
  const [snapOn, setSnapOn] = useState<boolean>(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem(SNAP_KEY) === '1' : false)
  );
  const toggleSnap = () => setSnapOn(v => {
    try { localStorage.setItem(SNAP_KEY, v ? '0' : '1'); } catch { /* приватный режим */ }
    return !v;
  });
  // ---- Приближение карты ----
  //
  // Устроено как ЧИСТО ВИДОВОЕ преобразование: масштаб и сдвиг лежат на обёртке, а данные
  // остаются в процентах карты и не знают о зуме вовсе. Это не экономия кода, а условие
  // работоспособности: `pointFromEvent` считает проценты от `getBoundingClientRect()`
  // контейнера, а он УЧИТЫВАЕТ transform — поэтому рисование, привязка и перетаскивание
  // продолжают попадать туда же, куда попадали, без единой правки в них.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panDrag, setPanDrag] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [wheelHint, setWheelHint] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  // Сдвиг ограничен так, чтобы карту нельзя было утащить за край: при масштабе 1 сдвиг
  // всегда нулевой, дальше — не больше вылезшей части.
  const clampPan = (v: { x: number; y: number }, z: number) => {
    const el = viewportRef.current;
    const w = el?.clientWidth ?? 0, h = el?.clientHeight ?? 0;
    const mx = (w * (z - 1)) / 1, my = (h * (z - 1)) / 1;
    return { x: clamp(v.x, -mx, 0), y: clamp(v.y, -my, 0) };
  };

  // Приближение К ТОЧКЕ: под курсором (или под центром) остаётся то же место карты.
  // Зум «от угла» промахивается мимо того, что человек разглядывает, и его приходится
  // доводить сдвигом — то есть делать вручную работу, которую должен делать зум.
  const zoomAt = (next: number, cx?: number, cy?: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const z = clamp(round1(next), 1, 4);
    const r = el.getBoundingClientRect();
    const ax = cx === undefined ? r.width / 2 : cx - r.left;
    const ay = cy === undefined ? r.height / 2 : cy - r.top;
    setPan(prev => {
      const k = z / zoom;
      return clampPan({ x: ax - (ax - prev.x) * k, y: ay - (ay - prev.y) * k }, z);
    });
    setZoom(z);
  };
  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  // Панели правки лежат на сцене (иначе их не привязать к фигуре), но масштабироваться
  // вместе с картой им нельзя: это интерфейс, а не содержимое. Гасим масштаб обратно.
  const uiScale = 1 / zoom;

  // Alt держим в СОСТОЯНИИ, а не в ref: от него зависит, показывать ли сетку, а значит
  // нажатие обязано перерисовать. Иначе человек тянет с Alt и не видит, куда попадёт.
  const [altHeld, setAltHeld] = useState(false);

  const [toolbarPos, setToolbarPos] = useState<'bottom' | 'left'>(
    () => (localStorage.getItem(TOOLBAR_POS_KEY) === 'left' ? 'left' : 'bottom')
  );
  const toggleToolbarPos = () => setToolbarPos(p => {
    const next = p === 'left' ? 'bottom' : 'left';
    localStorage.setItem(TOOLBAR_POS_KEY, next);
    return next;
  });

  const drawings = mapTemplate.drawings || [];
  const objectives = mapTemplate.objectives || [];
  const mapTexts = mapTemplate.texts || [];
  const positions = mapTemplate.positions || {};
  const drawingActive = tool !== 'select' && !isViewer;

  // Запись изменений в активную стратегию карты
  const patch = (p: Partial<MapTemplate>) => onUpdateMap({ ...mapTemplate, ...p });

  // ---- Работа с выделенной фигурой ----
  const selectedShapeId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedShape = selectedShapeId ? drawings.find(s => s.id === selectedShapeId) ?? null : null;
  const selectedShapes = drawings.filter(s => selectedIds.includes(s.id));
  const setSelectedShapeId = (id: string | null) => setSelectedIds(id ? [id] : []);
  const patchSelected = (pp: Partial<DrawShape>) => {
    if (isViewer || selectedIds.length === 0) return;
    patch({ drawings: drawings.map(s => (selectedIds.includes(s.id) ? { ...s, ...pp } : s)) });
  };
  // Дублирование. Смещаем копию на одну клетку вправо-вниз, а не кладём ровно поверх:
  // копия точно поверх оригинала выглядит как «ничего не произошло», и человек жмёт ещё
  // раз, получая три штуки. Клетка — потому что при включённой привязке копия сразу
  // стоит на сетке, а при выключенной сдвиг всё равно виден.
  const duplicateSelected = () => {
    if (isViewer || selectedIds.length === 0) return;
    const dx = gridStep, dy = gridY;
    const copies = drawings
      .filter(sh => selectedIds.includes(sh.id))
      .map(sh => ({
        ...sh,
        id: uid('dr'),
        points: sh.points.map(pt => ({
          x: round1(clamp(pt.x + dx, 0.5, 99.5)),
          y: round1(clamp(pt.y + dy, 0.5, 99.5))
        }))
      }));
    setRedoStack([]);
    patch({ drawings: [...drawings, ...copies] });
    // Выделение переезжает на КОПИИ: следующее действие почти всегда про них — оттащить
    // на место. Оставь выделение на оригиналах, и человек утащил бы обратно то, что
    // только что размножил.
    setSelectedIds(copies.map(c => c.id));
  };

  const removeSelected = () => {
    if (isViewer || selectedIds.length === 0) return;
    patch({ drawings: drawings.filter(s => !selectedIds.includes(s.id)) });
    setSelectedIds([]);
  };
  const patchShape = (id: string, p: Partial<DrawShape>) => {
    if (isViewer) return;
    patch({ drawings: drawings.map(s => (s.id === id ? { ...s, ...p } : s)) });
  };
  const removeShape = (id: string) => {
    if (isViewer) return;
    patch({ drawings: drawings.filter(s => s.id !== id) });
    setSelectedShapeId(null);
  };
  const grabShape = (e: React.PointerEvent, s: DrawShape) => {
    if (isViewer || tool !== 'select') return;
    e.stopPropagation();
    try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
    setSelectedTextId(null);

    // Shift/Ctrl добавляет и убирает из выделения — так во всех редакторах.
    // Без модификатора: если фигура УЖЕ выделена, выделение сохраняем (иначе клик по
    // одной из пяти сбрасывал бы группу ровно в тот момент, когда её собрались тащить);
    // если нет — выделяем её одну.
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    let ids: string[];
    if (add) {
      ids = selectedIds.includes(s.id) ? selectedIds.filter(x => x !== s.id) : [...selectedIds, s.id];
      setSelectedIds(ids);
      if (!ids.includes(s.id)) return; // сняли выделение — тащить нечего
    } else {
      ids = selectedIds.includes(s.id) ? selectedIds : [s.id];
      setSelectedIds(ids);
    }

    const origAll: Record<string, DrawPoint[]> = {};
    for (const sh of drawings) if (ids.includes(sh.id)) origAll[sh.id] = sh.points;
    setShapeDrag({ mode: 'move', id: s.id, start: pointFromEvent(e), orig: s.points, points: s.points, origAll, pointsAll: origAll });
  };
  // Ресайз зоны за угол: fixed — противоположный угол, он остаётся на месте
  const grabShapeCorner = (e: React.PointerEvent, s: DrawShape, fixed: DrawPoint) => {
    if (isViewer) return;
    e.stopPropagation();
    try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
    setShapeDrag({ mode: 'corner', id: s.id, start: pointFromEvent(e), orig: [fixed, snapPt(pointFromEvent(e), [s.id])], points: s.points });
  };
  // Перетаскивание конца линии/стрелки
  const grabShapeEnd = (e: React.PointerEvent, s: DrawShape, endIndex: 0 | 1) => {
    if (isViewer) return;
    e.stopPropagation();
    try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
    setShapeDrag({ mode: 'end', id: s.id, start: pointFromEvent(e), orig: s.points, points: s.points, endIndex });
  };

  // При смене стратегии — сбрасываем локальные UI-состояния (история redo, правка текста, выделение)
  useEffect(() => { setRedoStack([]); setEditingTextId(null); setSelectedTextId(null); setTextResize(null); setSelectedIds([]); setShapeDrag(null); setMarquee(null); resetZoom(); }, [mapTemplate.id]);

  // Колесо: обычное крутит СТРАНИЦУ, Ctrl+колесо приближает карту. Это «кооперативная»
  // схема из встраиваемых карт, и она здесь обязательна: карта живёт посреди длинной
  // прокручиваемой страницы, и перехват обычного колеса означал бы, что мимо карты не
  // проскроллить. Вторая половина схемы — подсказка: без неё про Ctrl никто не узнает.
  // Таймер скрытия подсказки живёт в REF, а не в переменной эффекта, и уборка эффекта
  // его НЕ гасит. Иначе выходит так: покрутил колесом (подсказка появилась) → сразу
  // Ctrl+колесо → масштаб изменился → эффект перезапустился → уборка убила таймер, а
  // подсказка осталась на экране навсегда. И больше не пряталась: на приближённой карте
  // обработчик выходит раньше, чем дошёл бы до неё.
  const hintTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  // Приблизил — значит способ уже знает; подсказку убираем сразу.
  useEffect(() => { if (zoom > 1) setWheelHint(false); }, [zoom]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
        return;
      }
      if (zoom > 1) return; // уже приблизили — человек знает, как это делается
      setWheelHint(true);
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setWheelHint(false), 1400);
    };
    // passive: false — иначе preventDefault не сработает и страница уедет вместе с зумом
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  // Пробел — временная «рука», как в любом графическом редакторе. Держим отдельно от
  // Alt: у них разные задачи и их жмут одновременно.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    const off = () => setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', off);
    };
  }, []);

  // Открыли карту — показываем её целиком вместе с панелью инструментов.
  //
  // Раньше вкладка открывалась в позиции прокрутки страницы, то есть обычно наверху, и
  // панель оказывалась ниже сгиба: карта видна, а рисовать нечем — приходилось искать
  // прокруткой то, что должно быть под рукой сразу.
  //
  // Только ОДИН раз при открытии. Возвращать прокрутку на каждую перерисовку нельзя:
  // человек уводит страницу намеренно (посмотреть состав ниже), и дёргать её обратно
  // было бы хуже исходной беды.
  useEffect(() => {
    const el = focusRef.current;
    if (!el) return;
    // Кадр задержки: на момент монтирования карта ещё не знает своих размеров, и
    // прокрутка считалась бы по нулевой высоте.
    const id = requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(id);
  }, []);

  // Alt зажат — привязка снята. Слушаем на окне, а не на поле: клавишу нажимают уже
  // посреди перетаскивания, когда фокус где угодно. blur обязателен — уход в другое
  // окно по Alt+Tab иначе оставил бы привязку выключенной навсегда.
  useEffect(() => {
    const set = (e: KeyboardEvent) => setAltHeld(e.altKey);
    const off = () => setAltHeld(false);
    window.addEventListener('keydown', set);
    window.addEventListener('keyup', set);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', set);
      window.removeEventListener('keyup', set);
      window.removeEventListener('blur', off);
    };
  }, []);

  // Отслеживаем размер поля в пикселях (для корректной отрисовки рисунков/стрелок)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Список игроков (весь ростер гильдии): танк → дд → хил, потом по имени ----
  const roster = useMemo(
    () => [...players].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name)),
    [players]
  );

  const isPlaced = (id: string) => !!positions[id];
  const placedCount = players.filter(p => isPlaced(p.id)).length;

  const placePlayer = (p: Player) => {
    if (isViewer) return;
    patch({ positions: { ...positions, [p.id]: positions[p.id] ?? gridSlot(placedCount) } });
  };
  const removeToken = (id: string) => {
    if (isViewer) return;
    const next = { ...positions };
    delete next[id];
    patch({ positions: next });
  };
  const togglePlayer = (p: Player) => (isPlaced(p.id) ? removeToken(p.id) : placePlayer(p));
  const placeAll = () => {
    if (isViewer || roster.length === 0) return;
    const next = { ...positions };
    let i = 0;
    roster.forEach(p => { if (!next[p.id]) next[p.id] = gridSlot(i++); });
    patch({ positions: next });
  };
  const clearTokens = () => {
    if (isViewer || placedCount === 0) return;
    patch({ positions: {} });
  };

  // ---- Перетаскивание (токены / объекты / текст) + рисование ----
  const pointFromEvent = (e: React.PointerEvent): MapPosition => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: round1(clamp(((e.clientX - rect.left) / rect.width) * 100, 1.5, 98.5)),
      y: round1(clamp(((e.clientY - rect.top) / rect.height) * 100, 1.5, 98.5))
    };
  };

  // ---- Прилипание ----
  //
  // Два разных прилипания, и порядок между ними важнее их самих.
  //
  // 1. К КРАЯМ СОСЕДНИХ ФИГУР — всегда включено, срабатывает только вблизи. Это то, чего
  //    не хватало: сетка сажает углы на свои узлы, но соседний квадрат про эти узлы
  //    ничего не знает. Нарисован он был при другом шаге сетки или вовсе без неё — и
  //    прилипать ему не к чему, квадраты наезжают друг на друга.
  // 2. К СЕТКЕ — по кнопке, Alt инвертирует (как было).
  //
  // Края имеют ПРИОРИТЕТ над сеткой. Так же советует делать Adobe для своих smart guides,
  // и причина простая: сетка это подложка, а сосед — то, к чему на самом деле ровняются.
  // Узел сетки в двух пикселях от края соседа перетянул бы на себя и оставил щель.
  const gridStep = mapTemplate.grid ?? DEFAULT_GRID;
  const gridY = stepYof(gridStep, size.w, size.h);
  // Alt инвертирует: выключено + Alt = привязка к сетке, включено + Alt = свобода.
  const snapping = (snapOn !== altHeld) && !isViewer;
  // Alt означает «строго по сетке», поэтому прилипание к соседям он снимает: иначе две
  // системы тянули бы в разные стороны и не было бы способа встать точно на узел.
  const edgeSnapping = !isViewer && !altHeld;
  const zoneTool = tool === 'rect' || tool === 'ellipse';

  // Порог прилипания задан в ЭКРАННЫХ пикселях и делится на масштаб: на приближённой
  // карте он иначе охватывал бы всё большую часть карты и хватал бы дальних соседей.
  // Двенадцать экранных пикселей — примерно столько человек промахивается, целясь на
  // глаз. Липким это поле не делает: цели стоят с шагом соседа (обычно за полсотни
  // пикселей), поэтому между ними остаётся много места, где ничего не притягивает.
  const SNAP_PX = 12;
  // Сколько шагов соседа продолжать в каждую сторону. Три хватает на ряд из четырёх
  // квадратов от любого из них; больше — лишние цели по всей карте.
  const LATTICE = 3;
  const thX = size.w > 0 ? (SNAP_PX / (size.w * zoom)) * 100 : 0;
  const thY = size.h > 0 ? (SNAP_PX / (size.h * zoom)) * 100 : 0;

  // Куда прилипать. Две породы целей, и вторая — главная.
  //
  // 1. Края и середины всех остальных фигур. Середины — потому что ряд ровняют не только
  //    встык, но и по одной линии.
  // 2. ПРОДОЛЖЕНИЕ СОСЕДА ЕГО ЖЕ ШАГОМ: у каждой зоны берётся её собственная ширина и
  //    откладывается в обе стороны. Это и есть «квадраты принимают друг друга сетку».
  //    Без этого прилипал только тот, кого поднесли вплотную к краю: третий и четвёртый
  //    в ряду промахиваются уже на полклетки, до соседнего края далеко, и прилипать им
  //    не к чему. С продолжением первый нарисованный квадрат задаёт шаг всему ряду, и
  //    неважно, какой шаг стоит в сетке и включена ли она вообще.
  //
  // Продолжение строится только по ЗОНАМ. У кисти или стрелки габарит случайный, и его
  // «шаг» — бессмысленное число, которое только натащило бы ложных целей.
  const edgeTargets = (exclude: string[]) => {
    const xs: number[] = [], ys: number[] = [];
    for (const sh of drawings) {
      if (exclude.includes(sh.id)) continue;
      const b = shapeBBox(sh.points);
      xs.push(b.minX, b.maxX, b.cx);
      ys.push(b.minY, b.maxY, b.cy);
      if (sh.type !== 'rect' && sh.type !== 'ellipse') continue;
      const w = b.maxX - b.minX, h = b.maxY - b.minY;
      for (let k = -LATTICE; k <= LATTICE; k++) {
        if (k === 0) continue;
        if (w > 0.2) { xs.push(b.minX + k * w, b.maxX + k * w); }
        if (h > 0.2) { ys.push(b.minY + k * h, b.maxY + k * h); }
      }
    }
    return { xs, ys };
  };
  // Ближайшая цель в пределах порога, иначе null.
  const nearest = (targets: number[], v: number, th: number): number | null => {
    let best: number | null = null, bd = th;
    for (const t of targets) {
      const d = Math.abs(t - v);
      if (d <= bd) { bd = d; best = t; }
    }
    return best;
  };

  // Подсказка-линия в момент срабатывания. Без неё прилипание выглядит как «оно само
  // прыгает»: человек не видит, к чему именно его притянуло.
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });

  // Точка (угол рисуемой зоны): сначала края соседей, потом сетка — по каждой оси
  // отдельно, потому что по одной может быть сосед, а по другой нет.
  const snapPt = (p: MapPosition, exclude: string[] = []): MapPosition => {
    let { x, y } = p;
    let gx: number | null = null, gy: number | null = null;
    if (edgeSnapping) {
      const t = edgeTargets(exclude);
      gx = nearest(t.xs, x, thX);
      gy = nearest(t.ys, y, thY);
      if (gx !== null) x = gx;
      if (gy !== null) y = gy;
    }
    if (snapping) {
      if (gx === null) x = snapTo(x, gridStep);
      if (gy === null) y = snapTo(y, gridY);
    }
    setGuides({ x: gx, y: gy });
    return { x: round1(clamp(x, 0, 100)), y: round1(clamp(y, 0, 100)) };
  };

  // Перенос: прилипает ЛЮБОЙ край переносимого габарита, а не только левый верхний.
  // Иначе квадрат встык справа не поставить — его к соседу тянет правая сторона.
  const snapDelta = (bb: { minX: number; maxX: number; cx: number; minY: number; maxY: number; cy: number }, dx: number, dy: number, exclude: string[]) => {
    let gx: number | null = null, gy: number | null = null;
    if (edgeSnapping) {
      const t = edgeTargets(exclude);
      let bdx = thX, bdy = thY;
      for (const e of [bb.minX, bb.maxX, bb.cx]) {
        const hit = nearest(t.xs, e + dx, bdx);
        if (hit !== null) { bdx = Math.abs(hit - (e + dx)); gx = hit; dx = hit - e; }
      }
      for (const e of [bb.minY, bb.maxY, bb.cy]) {
        const hit = nearest(t.ys, e + dy, bdy);
        if (hit !== null) { bdy = Math.abs(hit - (e + dy)); gy = hit; dy = hit - e; }
      }
    }
    if (snapping) {
      if (gx === null) dx = snapTo(bb.minX + dx, gridStep) - bb.minX;
      if (gy === null) dy = snapTo(bb.minY + dy, gridY) - bb.minY;
    }
    setGuides({ x: gx, y: gy });
    return { dx, dy };
  };

  const startDrag = (e: React.PointerEvent, kind: 'token' | 'objective' | 'text', id: string) => {
    if (isViewer || drawingActive) return;
    e.stopPropagation();
    try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет активного указателя */ }
    setDrag({ kind, id, ...pointFromEvent(e) });
  };

  const onContainerPointerDown = (e: React.PointerEvent) => {
    // Панорамирование перехватывает нажатие раньше всего: средняя кнопка или зажатый
    // пробел. Средняя — потому что она не занята ничем и есть у всех; пробел — потому
    // что так во всех редакторах, и рука под пробелом уже лежит.
    if (e.button === 1 || spaceHeld) {
      e.preventDefault();
      try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
      setPanDrag({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
      return;
    }
    if (!drawingActive) {
      // Пустое место при инструменте «Выбор» — начало рамки-резинки. Без модификатора
      // это ещё и сброс выделения: нажатие по пустому всегда значило «снять», и менять
      // это нельзя, иначе снять выделение станет нечем.
      setSelectedTextId(null);
      if (!isViewer && tool === 'select') {
        if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSelectedIds([]);
        try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
        const pt = pointFromEvent(e);
        setMarquee({ a: pt, b: pt });
      } else {
        setSelectedIds([]);
      }
      return;
    }
    e.preventDefault();
    if (tool === 'text') { addText(pointFromEvent(e)); return; }
    try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
    const pt = pointFromEvent(e);
    if (tool === 'pen') {
      setDrawing({ id: uid('dr'), type: 'path', color: drawColor, width: drawWidth, points: [pt], dash: dashOn || undefined });
    } else if (tool === 'rect' || tool === 'ellipse') {
      const g = snapPt(pt);
      setDrawing({ id: uid('dr'), type: tool, color: drawColor, width: drawWidth, points: [g, g], dash: dashOn || undefined, fill: true, fillOpacity: ZONE_DEFAULT_OPACITY });
    } else {
      // arrow | line — две точки
      setDrawing({ id: uid('dr'), type: tool, color: drawColor, width: drawWidth, points: [pt, pt], dash: dashOn || undefined });
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (panDrag) {
      setPan(clampPan({ x: panDrag.px + (e.clientX - panDrag.x), y: panDrag.py + (e.clientY - panDrag.y) }, zoom));
      return;
    }
    if (textResize) {
      const dist = Math.hypot(e.clientX - textResize.cx, e.clientY - textResize.cy);
      const sz = clamp(Math.round(textResize.startSize * (dist / textResize.startDist)), MIN_TEXT_SIZE, MAX_TEXT_SIZE);
      setTextResize(tr => (tr ? { ...tr, size: sz } : tr));
      return;
    }
    if (drawing) {
      const pt = pointFromEvent(e);
      // Прилипание считаем ЗДЕСЬ, а не внутри обновителя состояния: оно рисует подсказку,
      // то есть трогает другое состояние, а обновитель обязан быть чистым — React вправе
      // выполнить его дважды.
      const zonePt = (drawing.type === 'rect' || drawing.type === 'ellipse')
        ? snapPt(pt, [drawing.id])
        : null;
      setDrawing(d => {
        if (!d) return d;
        if (zonePt) return { ...d, points: [d.points[0], zonePt] };
        if (d.type !== 'path') return { ...d, points: [d.points[0], pt] }; // 2-точечные фигуры
        const last = d.points[d.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.3) return d;
        return { ...d, points: [...d.points, pt] };
      });
      return;
    }
    if (marquee) {
      const pt = pointFromEvent(e);
      setMarquee(m => (m ? { ...m, b: pt } : m));
      return;
    }
    if (shapeDrag) {
      const pt = pointFromEvent(e);
      const sdNow = shapeDrag;
      // Прилипание — снаружи обновителя: оно рисует подсказку, то есть трогает другое
      // состояние, а обновитель обязан быть чистым.
      let mv: { dx: number; dy: number } | null = null;
      let cornerPt: MapPosition | null = null;
      if (sdNow.mode === 'move') {
        // Смещение считается ОДИН раз на всю группу и по фигуре, за которую взялись.
        // Привязывать каждую фигуру по отдельности нельзя: у группы поехало бы взаимное
        // расположение, а её тащат целиком именно чтобы оно не ехало.
        let dx = pt.x - sdNow.start.x, dy = pt.y - sdNow.start.y;
        const lead = drawings.find(x => x.id === sdNow.id);
        if (lead && (lead.type === 'rect' || lead.type === 'ellipse')) {
          // Габарит берём по ВСЕЙ переносимой группе, а цели прилипания — без неё самой:
          // иначе фигура липла бы к собственному краю и не двигалась вовсе.
          const moving = Object.keys(sdNow.origAll || { [sdNow.id]: 1 });
          const pts = Object.values(sdNow.origAll || { [sdNow.id]: sdNow.orig }).flat() as DrawPoint[];
          const g = snapDelta(shapeBBox(pts), dx, dy, moving);
          dx = g.dx; dy = g.dy;
        }
        mv = { dx, dy };
      } else if (sdNow.mode === 'corner') {
        cornerPt = snapPt(pt, [sdNow.id]);
      }
      setShapeDrag(sd => {
        if (!sd) return sd;
        if (sd.mode === 'move' && mv) {
          const shift = (pts: DrawPoint[]) => pts.map(p => ({
            x: round1(clamp(p.x + mv!.dx, 0.5, 99.5)),
            y: round1(clamp(p.y + mv!.dy, 0.5, 99.5))
          }));
          const pointsAll: Record<string, DrawPoint[]> = {};
          for (const [id, pts] of Object.entries(sd.origAll || {}) as [string, DrawPoint[]][]) pointsAll[id] = shift(pts);
          return { ...sd, points: shift(sd.orig), pointsAll };
        }
        if (sd.mode === 'corner' && cornerPt) return { ...sd, points: [sd.orig[0], cornerPt] }; // фикс. угол + курсор
        const pts = [...sd.orig];
        pts[sd.endIndex ?? 1] = pt;
        return { ...sd, points: pts };
      });
      return;
    }
    if (!drag) return;
    setDrag(d => (d ? { ...d, ...pointFromEvent(e) } : d));
  };

  const onUp = () => {
    setGuides({ x: null, y: null });
    if (panDrag) { setPanDrag(null); return; }
    if (textResize) {
      const tr = textResize;
      setTextResize(null);
      patch({ texts: mapTexts.map(tx => (tx.id === tr.id ? { ...tx, size: tr.size } : tx)) });
      return;
    }
    if (drawing) {
      const d = drawing;
      setDrawing(null);
      const valid = d.type === 'path'
        ? d.points.length > 1
        : Math.hypot(d.points[1].x - d.points[0].x, d.points[1].y - d.points[0].y) > 1.2;
      if (valid) {
        setRedoStack([]);
        patch({ drawings: [...drawings, d] });
      }
      return;
    }
    if (marquee) {
      const m = marquee;
      setMarquee(null);
      const x0 = Math.min(m.a.x, m.b.x), x1 = Math.max(m.a.x, m.b.x);
      const y0 = Math.min(m.a.y, m.b.y), y1 = Math.max(m.a.y, m.b.y);
      // Меньше половины процента — это не рамка, а обычный щелчок по пустому месту.
      if (x1 - x0 < 0.5 && y1 - y0 < 0.5) return;
      // Берём ЗАДЕТЫЕ, а не только целиком накрытые: обвести зону целиком на плотной
      // карте тяжело, а «задел — значит имел в виду» ошибается реже.
      const hit = drawings.filter(sh => {
        const b = shapeBBox(sh.points);
        return b.minX <= x1 && b.maxX >= x0 && b.minY <= y1 && b.maxY >= y0;
      }).map(sh => sh.id);
      setSelectedIds(prev => Array.from(new Set([...prev, ...hit])));
      return;
    }
    if (shapeDrag) {
      const sd = shapeDrag;
      setShapeDrag(null);
      const all = sd.pointsAll;
      patch({
        drawings: drawings.map(s => {
          if (all && all[s.id]) return { ...s, points: all[s.id] };
          return s.id === sd.id ? { ...s, points: sd.points } : s;
        })
      });
      return;
    }
    if (!drag) return;
    if (drag.kind === 'token') {
      patch({ positions: { ...positions, [drag.id]: { x: drag.x, y: drag.y } } });
    } else if (drag.kind === 'objective') {
      patch({ objectives: objectives.map(o => (o.id === drag.id ? { ...o, x: drag.x, y: drag.y } : o)) });
    } else {
      patch({ texts: mapTexts.map(tx => (tx.id === drag.id ? { ...tx, x: drag.x, y: drag.y } : tx)) });
    }
    setDrag(null);
  };

  // ---- Рисование: undo / redo / очистка ----
  const undoDraw = () => {
    if (isViewer || drawings.length === 0) return;
    const last = drawings[drawings.length - 1];
    setRedoStack(r => [...r, last]);
    patch({ drawings: drawings.slice(0, -1) });
  };
  const redoDraw = () => {
    if (isViewer || redoStack.length === 0) return;
    const shape = redoStack[redoStack.length - 1];
    setRedoStack(r => r.slice(0, -1));
    patch({ drawings: [...drawings, shape] });
  };
  const clearDrawings = () => {
    if (isViewer || drawings.length === 0) return;
    setRedoStack([]);
    setSelectedIds([]);
    patch({ drawings: [] });
  };

  // Горячие клавиши: Ctrl+Z — отменить, Ctrl+Y / Ctrl+Shift+Z — вернуть,
  // Delete/Backspace — удалить выделенную фигуру
  useEffect(() => {
    if (isViewer) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault();
        removeSelected();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const code = e.code; // не зависит от раскладки
      if (code === 'KeyD') { e.preventDefault(); duplicateSelected(); return; }
      if (code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undoDraw(); }
      else if (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redoDraw(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isViewer, drawings, redoStack, mapTemplate, selectedIds, gridStep, gridY]);

  // ---- Встроенные объекты ----
  const addObjective = (type: ObjectiveType) => {
    if (isViewer) return;
    const jitter = () => round1(clamp(50 + (Math.random() * 16 - 8), 8, 92));
    patch({ objectives: [...objectives, { id: uid('ob'), type, x: jitter(), y: jitter() }] });
    setTool('select');
  };
  const removeObjective = (id: string) => {
    if (isViewer) return;
    patch({ objectives: objectives.filter(o => o.id !== id) });
  };
  const clearObjectives = () => {
    if (isViewer || objectives.length === 0) return;
    patch({ objectives: [] });
  };

  // ---- Текстовые подписи ----
  const addText = (pt: MapPosition) => {
    if (isViewer) return;
    const id = uid('tx');
    patch({ texts: [...mapTexts, { id, x: pt.x, y: pt.y, text: '', color: drawColor, size: DEFAULT_TEXT_SIZE }] });
    setEditingTextId(id);
    setTool('select');
  };
  const startTextResize = (e: React.PointerEvent, tx: MapText) => {
    if (isViewer) return;
    e.stopPropagation();
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    try { el.setPointerCapture(e.pointerId); } catch { /* нет указателя */ }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + (tx.x / 100) * rect.width;
    const cy = rect.top + (tx.y / 100) * rect.height;
    const startDist = Math.max(6, Math.hypot(e.clientX - cx, e.clientY - cy));
    const startSize = tx.size ?? DEFAULT_TEXT_SIZE;
    setTextResize({ id: tx.id, startSize, cx, cy, startDist, size: startSize });
    setSelectedTextId(tx.id);
  };
  const commitText = (id: string, value: string) => {
    const v = value.trim();
    patch({ texts: v ? mapTexts.map(tx => (tx.id === id ? { ...tx, text: v } : tx)) : mapTexts.filter(tx => tx.id !== id) });
    setEditingTextId(null);
  };
  const removeText = (id: string) => {
    if (isViewer) return;
    patch({ texts: mapTexts.filter(tx => tx.id !== id) });
  };
  const setTextStyle = (id: string, p: Partial<MapText>) => {
    if (isViewer) return;
    patch({ texts: mapTexts.map(tx => (tx.id === id ? { ...tx, ...p } : tx)) });
  };

  // Рисунки для отрисовки: сохранённые (с подменой точек у перетаскиваемой) + текущий незавершённый
  const displayShapes = (drawing ? [...drawings, drawing] : drawings).map(s => {
    if (!shapeDrag) return s;
    if (shapeDrag.pointsAll && shapeDrag.pointsAll[s.id]) return { ...s, points: shapeDrag.pointsAll[s.id] };
    return s.id === shapeDrag.id ? { ...s, points: shapeDrag.points } : s;
  });
  // Точки выделенной фигуры с учётом живого перетаскивания (для ручек/панели)
  const selectedPoints = selectedShape
    ? (shapeDrag && shapeDrag.id === selectedShape.id ? shapeDrag.points : selectedShape.points)
    : null;

  // Панель инструментов рисования — снизу (горизонтальная) или слева (вертикальная).
  // Позиция переключается кнопкой-стрелкой и запоминается локально.
  const renderToolbar = (vertical: boolean) => (
    <div className={vertical
      ? 'bg-slate-900 border border-slate-800 rounded-lg p-2 flex flex-col items-center gap-2 shrink-0 self-start sticky top-24'
      // Нижняя панель ЛИПНЕТ к низу окна, пока колонка с картой в поле зрения. Карта
      // высотой в 88vh вместе с панелью и липкой шапкой в окно не помещается, и панель
      // уезжала за сгиб: карта видна, а рисовать нечем. Уменьшать ради этого карту не
      // годится — её как раз и разглядывают. Липкая панель решает то же самое даром:
      // при нехватке места она просто ложится поверх нижнего края карты.
      //
      // `sticky` работает только внутри своего контейнера, поэтому ниже, у состава,
      // панель не тащится за экраном — она остаётся в своей колонке.
      : 'mt-3 sticky bottom-3 z-20 bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex flex-wrap items-center gap-2 shadow-lg'}
    >
      {/* Инструменты */}
      <div className={`grid ${vertical ? 'grid-cols-2' : 'grid-flow-col'} gap-1 bg-slate-950 rounded-lg p-1 border border-slate-800`}>
        {([
          ['select', 'fa-solid fa-arrow-pointer', 'Выбор / перемещение'],
          ['pen', 'fa-solid fa-pen', 'Кисть'],
          ['arrow', 'fa-solid fa-arrow-right-long', 'Стрелка'],
          ['line', 'fa-solid fa-slash', 'Прямая'],
          ['rect', 'fa-regular fa-square', 'Прямоугольник (зона)'],
          ['ellipse', 'fa-regular fa-circle', 'Эллипс (зона)'],
          ['text', 'fa-solid fa-font', 'Текст']
        ] as const).map(([toolId, icon, label]) => (
          <button
            key={toolId}
            onClick={() => setTool(toolId)}
            title={t(label)}
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm transition-colors ${tool === toolId ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
          >
            <i className={icon}></i>
          </button>
        ))}
        {/* Пунктир — применяется к новым линиям/стрелкам/зонам */}
        <button
          onClick={() => setDashOn(v => !v)}
          title={t('Пунктир')}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${dashOn ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16"><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="2.5" strokeDasharray="4 3" strokeLinecap="round" /></svg>
        </button>
        {/* Привязка к сетке. Переключается прямо посреди рисования — так устроено во всех
            чертёжных редакторах, и это важно: понадобилась она обычно уже после того, как
            стало ясно, что угол не сходится. */}
        <button
          onClick={toggleSnap}
          title={t('Привязка к сетке (Alt — временно наоборот)')}
          // Кнопка показывает СЕЙЧАСНОЕ состояние привязки, а не положение переключателя:
          // с зажатым Alt оно другое, и без подсветки клавиша выглядела как «ничего не
          // делает». Разовое включение отличается кольцом — иначе Alt не отличить от
          // включённого насовсем, и человек отпустит клавишу, считая, что уже настроил.
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors
            ${snapping ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}
            ${altHeld ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-slate-950' : ''}`}
        >
          <i className="fa-solid fa-border-all text-sm"></i>
        </button>
      </div>

      {/* Шаг сетки. Показан ВСЕГДА, а не только при включённом переключателе: привязка
          по умолчанию выключена и включается разово через Alt — а шаг ей всё равно
          нужен, и задать его было бы нечем.
          Живёт у КАРТЫ, а не у человека: размечают вдвоём, и разные шаги означали бы,
          что зоны одного не стыкуются с зонами другого. */}
      {(
        <div className={`flex items-center gap-1 bg-slate-950 rounded-lg p-1 border border-slate-800 ${vertical ? 'flex-col' : ''}`}>
          {GRID_STEPS.map(g => (
            <button
              key={g.v}
              onClick={() => patch({ grid: g.v })}
              title={t('Шаг сетки')}
              className={`px-2 h-7 rounded text-xs transition-colors ${Math.abs(gridStep - g.v) < 0.01 ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
            >
              {t(g.label)}
            </button>
          ))}
        </div>
      )}

      {/* Цвета */}
      <div className={vertical ? 'grid grid-cols-2 gap-1.5 px-0.5' : 'flex items-center gap-1.5 px-1'}>
        {DRAW_COLORS.map(c => (
          <button
            key={c}
            onClick={() => setDrawColor(c)}
            title={c}
            className={`w-6 h-6 rounded-full border-2 transition-transform ${drawColor.toLowerCase() === c.toLowerCase() ? 'border-white scale-110' : 'border-slate-700'}`}
            style={{ background: c }}
          />
        ))}
        <label className="w-6 h-6 rounded-full border-2 border-slate-700 relative cursor-pointer flex items-center justify-center" title={t('Свой цвет')} style={{ background: drawColor }}>
          <i className="fa-solid fa-eye-dropper text-[11px] text-white mix-blend-difference pointer-events-none"></i>
          <input type="color" value={drawColor} onChange={e => setDrawColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
        </label>
      </div>

      {/* Толщина */}
      <div className={`flex ${vertical ? 'flex-col' : ''} items-center gap-1 bg-slate-950 rounded-lg p-1 border border-slate-800`}>
        {DRAW_WIDTHS.map(w => (
          <button
            key={w.v}
            onClick={() => setDrawWidth(w.v)}
            title={t(w.label)}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${drawWidth === w.v ? 'bg-amber-600' : 'hover:bg-slate-800'}`}
          >
            <span className="rounded-full bg-slate-100" style={{ width: `${w.v + 2}px`, height: `${w.v + 2}px` }}></span>
          </button>
        ))}
      </div>

      {/* Undo / Redo / Очистить */}
      <div className={`flex ${vertical ? 'flex-col' : ''} items-center gap-1 ${vertical ? '' : 'ml-auto'}`}>
        <button onClick={undoDraw} disabled={drawings.length === 0} title={t('Отменить (Ctrl+Z)')} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-default transition-colors">
          <i className="fa-solid fa-rotate-left"></i>
        </button>
        <button onClick={redoDraw} disabled={redoStack.length === 0} title={t('Вернуть (Ctrl+Y)')} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-300 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-default transition-colors">
          <i className="fa-solid fa-rotate-right"></i>
        </button>
        <button onClick={clearDrawings} disabled={drawings.length === 0} title={t('Очистить рисунки')} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-400 hover:bg-slate-800 disabled:opacity-30 disabled:cursor-default transition-colors">
          <i className="fa-solid fa-eraser"></i>
        </button>
      </div>

      {/* Переключатель положения панели */}
      <div className={vertical ? 'pt-1 border-t border-slate-800 w-full flex justify-center' : 'pl-1 border-l border-slate-800'}>
        <button
          onClick={toggleToolbarPos}
          title={vertical ? t('Панель — вниз') : t('Панель — влево')}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-500 hover:text-amber-400 hover:bg-slate-800 transition-colors"
        >
          <i className={`fa-solid ${vertical ? 'fa-arrow-down-long' : 'fa-arrow-left-long'}`}></i>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col xl:flex-row gap-6">
      {/* Карта + панель инструментов рисования.
          `scroll-mt-*` — запас под липкую шапку: без него прокрутка «к началу блока»
          ставит его верх ровно под шапку, и первые полсотни пикселей карты закрыты. */}
      <div ref={focusRef} className="flex-1 min-w-0 scroll-mt-[64px]">
        <div className={!isViewer && toolbarPos === 'left' ? 'flex items-start gap-3' : ''}>
        {!isViewer && toolbarPos === 'left' && renderToolbar(true)}
        <div className="flex-1 min-w-0">
        {/* ОКНО — постоянного размера и с обрезкой. Внутри него СЦЕНА, на которой лежит
            всё содержимое карты и которая двигается и масштабируется целиком.
            Разделение обязательно: обрезка обязана остаться на неподвижном элементе,
            иначе приближённая карта полезет за пределы страницы. */}
        <div
          ref={viewportRef}
          style={{ width: 'min(100%, calc(88vh * 13 / 10))' }}
          className="relative aspect-[13/10] mx-auto rounded-2xl overflow-hidden border border-slate-800 select-none touch-none bg-slate-950"
        >
        <div
          ref={containerRef}
          onPointerDown={onContainerPointerDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onContextMenu={e => { if (spaceHeld) e.preventDefault(); }}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0'
          }}
          className={`absolute inset-0
            ${panDrag ? 'cursor-grabbing' : spaceHeld ? 'cursor-grab' : drawingActive ? 'cursor-crosshair' : ''}`}
        >
          {/* Фон: карта крепости */}
          <img
            src={IMAGES.mapBg}
            alt={t('Карта')}
            className="absolute inset-0 w-full h-full object-contain bg-slate-950"
            draggable={false}
          />

          {/* Сетка привязки. Показывается только когда она сейчас что-то делает: выбран
              инструмент зоны или зону тащат. Постоянная сетка на карте — это шум поверх
              и без того плотной картинки, а невидимая привязка выглядит как «оно само
              прыгает». Видно её ровно в тот момент, когда она объясняет поведение. */}
          {snapping && size.w > 0 && (zoneTool || !!shapeDrag) && (
            <svg
              viewBox={`0 0 ${size.w} ${size.h}`}
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full z-[2] pointer-events-none"
            >
              {Array.from({ length: Math.floor(100 / gridStep) }, (_, i) => (i + 1) * gridStep).map(x => (
                <line key={`v${x}`} x1={(x / 100) * size.w} y1={0} x2={(x / 100) * size.w} y2={size.h} stroke="#f59e0b" strokeWidth="1" opacity="0.16" vectorEffect="non-scaling-stroke" />
              ))}
              {Array.from({ length: Math.floor(100 / gridY) }, (_, i) => (i + 1) * gridY).map(y => (
                <line key={`h${y}`} x1={0} y1={(y / 100) * size.h} x2={size.w} y2={(y / 100) * size.h} stroke="#f59e0b" strokeWidth="1" opacity="0.16" vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
          )}

          {/* Рамка-резинка. Пунктир и лёгкая заливка — как в любом редакторе; отдельным
              слоем поверх фигур, чтобы её было видно и на плотной карте. */}
          {marquee && size.w > 0 && (() => {
            const x0 = Math.min(marquee.a.x, marquee.b.x), x1 = Math.max(marquee.a.x, marquee.b.x);
            const y0 = Math.min(marquee.a.y, marquee.b.y), y1 = Math.max(marquee.a.y, marquee.b.y);
            return (
              <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full z-[4] pointer-events-none">
                <rect
                  x={(x0 / 100) * size.w} y={(y0 / 100) * size.h}
                  width={((x1 - x0) / 100) * size.w} height={((y1 - y0) / 100) * size.h}
                  fill="rgba(245,158,11,0.12)" stroke="#f59e0b" strokeWidth="1"
                  strokeDasharray="5 4" vectorEffect="non-scaling-stroke"
                />
              </svg>
            );
          })()}

          {/* Линии прилипания. Показываются ровно в момент срабатывания и ровно там, к
              чему притянуло: без них прилипание выглядит как «оно само прыгает». */}
          {size.w > 0 && (guides.x !== null || guides.y !== null) && (
            <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full z-[5] pointer-events-none">
              {guides.x !== null && (
                <line x1={(guides.x / 100) * size.w} y1={0} x2={(guides.x / 100) * size.w} y2={size.h}
                  stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              )}
              {guides.y !== null && (
                <line x1={0} y1={(guides.y / 100) * size.h} x2={size.w} y2={(guides.y / 100) * size.h}
                  stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
          )}

          {/* Слой рисования (кисть / стрелки / линии / зоны) */}
          {size.w > 0 && size.h > 0 && (
            <svg
              viewBox={`0 0 ${size.w} ${size.h}`}
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full z-[3] pointer-events-none"
            >
              {displayShapes.map(shape => (
                <DrawnShape
                  key={shape.id}
                  shape={shape}
                  w={size.w}
                  h={size.h}
                  interactive={!isViewer && tool === 'select'}
                  selected={selectedIds.includes(shape.id)}
                  onGrab={e => grabShape(e, shape)}
                />
              ))}
            </svg>
          )}

          {/* Встроенные объекты */}
          {objectives.map(o => {
            const cfg = OBJECTIVE_CONFIG[o.type];
            if (!cfg) return null;
            const dragging = drag?.kind === 'objective' && drag.id === o.id;
            const pos = dragging ? { x: drag.x, y: drag.y } : { x: o.x, y: o.y };
            return (
              <div
                key={o.id}
                onPointerDown={e => startDrag(e, 'objective', o.id)}
                title={t(cfg.label)}
                className={`absolute -translate-x-1/2 -translate-y-1/2 group/obj ${drawingActive ? 'pointer-events-none' : ''} ${isViewer ? '' : 'cursor-grab active:cursor-grabbing'} ${dragging ? 'z-40 scale-110' : 'z-[6]'}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              >
                <img src={cfg.img} alt={cfg.label} draggable={false} className="w-11 h-11 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)] pointer-events-none" />
                {!isViewer && (
                  <button
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => removeObjective(o.id)}
                    title={t('Убрать объект')}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-slate-900 border border-slate-600 text-slate-300 hover:text-red-400 text-[11px] opacity-0 group-hover/obj:opacity-100 flex items-center justify-center transition-opacity"
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>
            );
          })}

          {/* Текстовые подписи */}
          {mapTexts.map(tx => {
            const dragging = drag?.kind === 'text' && drag.id === tx.id;
            const pos = dragging ? { x: drag.x, y: drag.y } : { x: tx.x, y: tx.y };
            const editing = editingTextId === tx.id;
            return (
              <div
                key={tx.id}
                onPointerDown={e => {
                  if (editing || isViewer || drawingActive) return;
                  const now = Date.now();
                  const last = lastTextClickRef.current;
                  if (last && last.id === tx.id && now - last.t < 350) {
                    lastTextClickRef.current = null;
                    e.stopPropagation();
                    setEditingTextId(tx.id);
                    return;
                  }
                  lastTextClickRef.current = { id: tx.id, t: now };
                  setSelectedTextId(tx.id);
                  startDrag(e, 'text', tx.id);
                }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 group/txt ${drawingActive && !editing ? 'pointer-events-none' : ''} ${isViewer || editing ? '' : 'cursor-grab active:cursor-grabbing'} ${dragging ? 'z-40' : 'z-20'}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              >
                {(() => {
                  const sel = selectedTextId === tx.id;
                  const fs = (textResize && textResize.id === tx.id) ? textResize.size : (tx.size ?? DEFAULT_TEXT_SIZE);
                  const fillOn = tx.fill !== false;
                  const strokeOn = tx.stroke === true;
                  const fillColor = tx.fillColor ?? '#020617';
                  const fillOp = tx.fillOpacity ?? 0.55;
                  const strokeColor = tx.strokeColor ?? '#000000';
                  const strokeW = tx.strokeWidth ?? 1;
                  const showHandles = !isViewer && !editing && sel;
                  const ctrlBelow = tx.y < 16;
                  const spanStyle: React.CSSProperties = {
                    color: tx.color,
                    fontSize: fs,
                    background: fillOn ? hexToRgba(fillColor, fillOp) : 'transparent',
                    boxShadow: fillOn ? '0 1px 3px rgba(0,0,0,0.85)' : 'none',
                    WebkitTextStroke: strokeOn ? `${strokeW}px ${strokeColor}` : undefined,
                    paintOrder: 'stroke fill'
                  };
                  return (
                    <>
                      {editing ? (
                        <input
                          autoFocus
                          defaultValue={tx.text}
                          onPointerDown={e => e.stopPropagation()}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); commitText(tx.id, (e.target as HTMLInputElement).value); }
                            else if (e.key === 'Escape') { e.preventDefault(); commitText(tx.id, tx.text); }
                          }}
                          onBlur={e => commitText(tx.id, e.target.value)}
                          placeholder={t('Текст…')}
                          style={{ color: tx.color, fontSize: fs }}
                          className="bg-slate-950/95 border border-amber-500 rounded-lg px-1.5 py-0.5 font-semibold outline-none text-center min-w-[90px] shadow-lg leading-tight"
                        />
                      ) : (
                        <span
                          style={spanStyle}
                          className={`inline-block px-1.5 py-0.5 font-semibold whitespace-pre rounded-lg select-none leading-tight ${sel ? 'ring-1 ring-amber-400/80' : 'group-hover/txt:ring-1 group-hover/txt:ring-amber-400/40'}`}
                        >
                          {tx.text || '…'}
                        </span>
                      )}
                      {showHandles && (
                        <>
                          <span
                            onPointerDown={e => startTextResize(e, tx)}
                            title={t('Потяните, чтобы изменить размер')}
                            className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-lg bg-amber-500 border border-slate-950 cursor-nwse-resize touch-none"
                          />
                          <div
                            onPointerDown={e => e.stopPropagation()}
                            className={`absolute left-1/2 -translate-x-1/2 ${ctrlBelow ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} flex flex-col gap-1 bg-slate-900/95 border border-slate-700 rounded-lg px-1.5 py-1 shadow-lg z-50`}
                          >
                            {/* Цвет букв */}
                            <div className="flex items-center gap-1">
                              {DRAW_COLORS.map(c => (
                                <button key={c} onMouseDown={e => e.preventDefault()} onClick={() => setTextStyle(tx.id, { color: c })} title={c}
                                  className={`w-4 h-4 rounded-full border transition-transform ${tx.color.toLowerCase() === c.toLowerCase() ? 'border-white scale-110' : 'border-slate-600'}`}
                                  style={{ background: c }} />
                              ))}
                              <label className="w-4 h-4 rounded-full border border-slate-600 relative cursor-pointer" title={t('Цвет текста')} style={{ background: tx.color }}>
                                <input type="color" value={tx.color} onChange={e => setTextStyle(tx.id, { color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                              </label>
                            </div>
                            {/* Плашка и обводка: тумблеры + свой цвет у каждой */}
                            <div className="flex items-center gap-0.5">
                              <button onMouseDown={e => e.preventDefault()} onClick={() => setTextStyle(tx.id, { fill: !fillOn })} title={t('Заливка')} className={`w-5 h-5 rounded-lg flex items-center justify-center text-[11px] ${fillOn ? 'bg-amber-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}><i className="fa-solid fa-fill-drip"></i></button>
                              {fillOn && (
                                <label className="w-4 h-4 rounded-lg border border-slate-600 relative cursor-pointer shrink-0" title={t('Цвет плашки')} style={{ background: fillColor }}>
                                  <input type="color" value={fillColor} onChange={e => setTextStyle(tx.id, { fillColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                                </label>
                              )}
                              <span className="w-px h-3.5 bg-slate-700 mx-0.5"></span>
                              <button onMouseDown={e => e.preventDefault()} onClick={() => setTextStyle(tx.id, { stroke: !strokeOn })} title={t('Обводка')} className={`w-5 h-5 rounded-lg flex items-center justify-center text-[11px] ${strokeOn ? 'bg-amber-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}><i className="fa-solid fa-vector-square"></i></button>
                              {strokeOn && (
                                <>
                                  <label className="w-4 h-4 rounded-lg border border-slate-600 relative cursor-pointer shrink-0" title={t('Цвет обводки')} style={{ background: strokeColor }}>
                                    <input type="color" value={strokeColor} onChange={e => setTextStyle(tx.id, { strokeColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                                  </label>
                                  <button onMouseDown={e => e.preventDefault()} onClick={() => setTextStyle(tx.id, { strokeWidth: strokeW >= 3 ? 1 : strokeW + 1 })} title={t('Толщина обводки')} className="min-w-5 h-5 px-0.5 rounded-lg flex items-center justify-center text-[11px] text-slate-200 hover:bg-slate-700">
                                    {strokeW}px
                                  </button>
                                </>
                              )}
                              <span className="w-px h-3.5 bg-slate-700 mx-0.5"></span>
                              <button onMouseDown={e => e.preventDefault()} onClick={() => { removeText(tx.id); setSelectedTextId(null); }} title={t('Убрать подпись')} className="w-5 h-5 rounded-lg flex items-center justify-center text-[11px] text-slate-300 hover:text-red-400 hover:bg-slate-700"><i className="fa-solid fa-xmark"></i></button>
                            </div>
                            {/* Прозрачность плашки */}
                            {fillOn && (
                              <input
                                type="range" min={10} max={100} step={5}
                                value={Math.round(fillOp * 100)}
                                onChange={e => setTextStyle(tx.id, { fillOpacity: Number(e.target.value) / 100 })}
                                title={t('Прозрачность плашки')}
                                className="w-full h-1 accent-amber-500 cursor-pointer"
                              />
                            )}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })}

          {/* Токены игроков (размещённые) */}
          {roster.filter(p => isPlaced(p.id)).map(p => {
            const dragging = drag?.kind === 'token' && drag.id === p.id;
            const pos = dragging ? { x: drag.x, y: drag.y } : positions[p.id];
            return (
              <div
                key={p.id}
                onPointerDown={e => startDrag(e, 'token', p.id)}
                title={`${p.name} · ${ROLE_LABELS[p.role]}`}
                className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center group/tok ${drawingActive ? 'pointer-events-none' : ''} ${isViewer ? '' : 'cursor-grab active:cursor-grabbing'} ${dragging ? 'z-50 scale-110' : 'z-10'}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              >
                <div className={`w-7 h-7 rounded-full ring-2 ${ROLE_RING[p.role]} flex items-center justify-center text-white text-[11px] shadow-lg relative`}>
                  {ROLE_ICONS[p.role]}
                  {!isViewer && (
                    <button
                      onPointerDown={e => e.stopPropagation()}
                      onClick={() => removeToken(p.id)}
                      title={t('Убрать с карты')}
                      className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-slate-900 border border-slate-600 text-slate-300 hover:text-red-400 text-[11px] opacity-0 group-hover/tok:opacity-100 flex items-center justify-center transition-opacity z-10"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  )}
                </div>
                <span className="mt-1 px-1.5 rounded-lg bg-slate-950/85 text-[11px] font-semibold text-slate-100 whitespace-nowrap max-w-[72px] truncate leading-tight">
                  {p.name}
                </span>
              </div>
            );
          })}

          {/* Ручки и панель настроек выделенной фигуры */}
          {/* Панель группы. Ручек за угол тут нет намеренно: тянуть угол у пятерых фигур
              нечего, а вот перекрасить, сменить толщину и удалить — обычное дело.
              Стоит над серединой верхней кромки общей рамки, чтобы не закрывать сами
              фигуры и не убегать от курсора при переносе. */}
          {!isViewer && tool === 'select' && selectedShapes.length > 1 && !shapeDrag && (() => {
            const bb = shapeBBox(selectedShapes.flatMap(sh => sh.points));
            return (
              // Общей рамки вокруг группы нет намеренно: каждая выбранная фигура уже
              // обведена своим пунктиром, и вторая рамка поверх шести первых только
              // шумит. Габарит считаем всё равно — по нему ставится панель.
              <>
                <div
                  className="absolute z-[7] flex items-center gap-1.5 bg-slate-900/95 border border-slate-700 rounded-lg px-2 py-1.5 shadow-lg"
                  style={{
                    left: `${bb.cx}%`, top: `${Math.max(bb.minY, 4)}%`,
                    transform: `translate(-50%, calc(-100% - 6px)) scale(${uiScale})`,
                    transformOrigin: '50% 100%'
                  }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <span className="text-[11px] text-slate-400 whitespace-nowrap">{t('Выбрано')}: {selectedShapes.length}</span>
                  <span className="w-px h-3.5 bg-slate-700"></span>
                  <div className="flex items-center gap-1">
                    {DRAW_COLORS.map(c => (
                      <button key={c} onClick={() => patchSelected({ color: c })} title={c}
                        className="w-4 h-4 rounded-full border border-slate-600 hover:scale-110 transition-transform"
                        style={{ background: c }} />
                    ))}
                  </div>
                  <span className="w-px h-3.5 bg-slate-700"></span>
                  <div className="flex items-center gap-0.5">
                    {DRAW_WIDTHS.map(w => (
                      <button key={w.v} onClick={() => patchSelected({ width: w.v })} title={t(w.label)}
                        className="w-5 h-5 rounded-lg flex items-center justify-center hover:bg-slate-700">
                        <span className="rounded-full bg-slate-200" style={{ width: w.v + 2, height: w.v + 2 }} />
                      </button>
                    ))}
                  </div>
                  <span className="w-px h-3.5 bg-slate-700"></span>
                  <button onClick={duplicateSelected} title={t('Дублировать (Ctrl+D)')}
                    className="w-5 h-5 rounded-lg flex items-center justify-center text-slate-300 hover:bg-slate-700">
                    <i className="fa-regular fa-clone text-[11px]"></i>
                  </button>
                  <button onClick={removeSelected} title={t('Удалить выбранные')}
                    className="w-5 h-5 rounded-lg flex items-center justify-center text-slate-300 hover:bg-red-600 hover:text-white">
                    <i className="fa-solid fa-trash text-[11px]"></i>
                  </button>
                </div>
              </>
            );
          })()}

          {!isViewer && tool === 'select' && selectedShape && selectedPoints && (() => {
            const bb = shapeBBox(selectedPoints);
            const isZone = selectedShape.type === 'rect' || selectedShape.type === 'ellipse';
            const isSeg = selectedShape.type === 'line' || selectedShape.type === 'arrow';
            const fillOn = selectedShape.fill !== false;
            const panelBelow = bb.minY < 18; // фигура у верхнего края — панель под ней
            return (
              <>
                {isZone && ([[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.minX, bb.maxY], [bb.maxX, bb.maxY]] as const).map(([hx, hy], i) => {
                  // Курсор смотрит вдоль ТОЙ диагонали, по которой поедет угол: у левого
                  // верхнего и правого нижнего это «\», у двух других «/». Раньше на всех
                  // четырёх стояла одна «\», и половина углов показывала стрелку, ведущую
                  // не туда, куда потянется фигура.
                  // Считаем по координатам, а не по номеру в списке: порядок углов в
                  // массиве однажды поменяют, и номера тихо разъедутся со смыслом.
                  const nwse = (hx === bb.minX) === (hy === bb.minY);
                  return (
                    <span
                      key={i}
                      onPointerDown={e => grabShapeCorner(e, selectedShape, { x: hx === bb.minX ? bb.maxX : bb.minX, y: hy === bb.minY ? bb.maxY : bb.minY })}
                      className={`absolute w-3 h-3 rounded-lg bg-amber-500 border border-slate-950 shadow touch-none z-30
                        ${nwse ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
                      style={{ left: `${hx}%`, top: `${hy}%`, transform: 'translate(-50%,-50%)' }}
                    />
                  );
                })}
                {isSeg && selectedPoints.slice(0, 2).map((p, i) => (
                  <span
                    key={i}
                    onPointerDown={e => grabShapeEnd(e, selectedShape, i as 0 | 1)}
                    className="absolute w-3 h-3 rounded-full bg-amber-500 border border-slate-950 shadow cursor-grab active:cursor-grabbing touch-none z-30"
                    style={{ left: `${p.x}%`, top: `${p.y}%`, transform: 'translate(-50%,-50%)' }}
                  />
                ))}
                <div
                  onPointerDown={e => e.stopPropagation()}
                  className="absolute z-40 flex flex-col gap-1 bg-slate-900/95 border border-slate-700 rounded-lg px-1.5 py-1 shadow-lg"
                  style={{
                    left: `${clamp(bb.cx, 15, 85)}%`,
                    top: panelBelow ? `${bb.maxY}%` : `${bb.minY}%`,
                    transform: panelBelow
                      ? `translate(-50%, 14px) scale(${uiScale})`
                      : `translate(-50%, calc(-100% - 14px)) scale(${uiScale})`,
                    transformOrigin: panelBelow ? '50% 0%' : '50% 100%'
                  }}
                >
                  <div className="flex items-center gap-1">
                    {DRAW_COLORS.map(c => (
                      <button key={c} onClick={() => patchShape(selectedShape.id, { color: c })} title={c}
                        className={`w-4 h-4 rounded-full border transition-transform ${selectedShape.color.toLowerCase() === c.toLowerCase() ? 'border-white scale-110' : 'border-slate-600'}`}
                        style={{ background: c }} />
                    ))}
                    <label className="w-4 h-4 rounded-full border border-slate-600 relative cursor-pointer" title={t('Свой цвет')} style={{ background: selectedShape.color }}>
                      <input type="color" value={selectedShape.color} onChange={e => patchShape(selectedShape.id, { color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                    </label>
                  </div>
                  <div className="flex items-center gap-0.5">
                    {DRAW_WIDTHS.map(w => (
                      <button key={w.v} onClick={() => patchShape(selectedShape.id, { width: w.v })} title={t(w.label)}
                        className={`w-5 h-5 rounded-lg flex items-center justify-center ${selectedShape.width === w.v ? 'bg-amber-600' : 'hover:bg-slate-700'}`}>
                        <span className="rounded-full bg-slate-100" style={{ width: w.v + 1, height: w.v + 1 }}></span>
                      </button>
                    ))}
                    <span className="w-px h-3.5 bg-slate-700 mx-0.5"></span>
                    <button onClick={() => patchShape(selectedShape.id, { dash: !selectedShape.dash })} title={t('Пунктир')}
                      className={`w-5 h-5 rounded-lg flex items-center justify-center ${selectedShape.dash ? 'bg-amber-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
                      <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2.5" strokeLinecap="round" /></svg>
                    </button>
                    {isZone && (
                      <button onClick={() => patchShape(selectedShape.id, { fill: !fillOn })} title={t('Заливка')}
                        className={`w-5 h-5 rounded-lg flex items-center justify-center text-[11px] ${fillOn ? 'bg-amber-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>
                        <i className="fa-solid fa-fill-drip"></i>
                      </button>
                    )}
                    <span className="w-px h-3.5 bg-slate-700 mx-0.5"></span>
                    <button onClick={() => removeShape(selectedShape.id)} title={t('Удалить фигуру')}
                      className="w-5 h-5 rounded-lg flex items-center justify-center text-[11px] text-slate-300 hover:text-red-400 hover:bg-slate-700">
                      <i className="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                  {isZone && fillOn && (
                    <input
                      type="range" min={5} max={80} step={5}
                      value={Math.round((selectedShape.fillOpacity ?? ZONE_DEFAULT_OPACITY) * 100)}
                      onChange={e => patchShape(selectedShape.id, { fillOpacity: Number(e.target.value) / 100 })}
                      title={t('Прозрачность заливки')}
                      className="w-full h-1 accent-amber-500 cursor-pointer"
                    />
                  )}
                </div>
              </>
            );
          })()}

          {players.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
              <i className="fa-solid fa-users-slash text-5xl mb-4 opacity-30"></i>
              <p className="text-xs">{t('В гильдии пока нет участников.')}</p>
            </div>
          )}
        </div>

        {/* Управление приближением. Стоит НА ОКНЕ, а не на сцене: масштабируясь вместе
            с картой, кнопки к четырёхкратному стали бы величиной с ладонь. */}
        {zoom > 1 && (
          <div className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg bg-slate-950/85 border border-slate-700 px-2 py-1 text-[11px] text-slate-300">
            <i className="fa-solid fa-magnifying-glass-plus text-slate-500"></i>
            <span className="tnum">{zoom.toFixed(1)}×</span>
            <span className="text-slate-500">· {t('пробел или средняя кнопка — двигать')}</span>
          </div>
        )}

        {/* Подсказка про Ctrl. Вторая половина «кооперативной» схемы: без неё человек
            крутит колесо над картой, страница уезжает, и он решает, что зума нет. */}
        {wheelHint && (
          // Плашкой сверху, а не затемнением всей карты. Затемнение показывалось на
          // КАЖДУЮ прокрутку страницы мимо карты — то есть постоянно и там, где человек
          // вообще не про карту думал. Подсказка обязана попадаться на глаза, но не
          // закрывать собой то, ради чего сюда пришли.
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 pointer-events-none">
            <span className="block rounded-lg bg-slate-950/90 border border-slate-700 px-3 py-1.5 text-xs text-slate-200 whitespace-nowrap">
              {t('Ctrl + колесо — приблизить карту')}
            </span>
          </div>
        )}
        </div>

        </div>
        </div>

        {/* Панель инструментов снизу (если не перенесена влево) */}
        {!isViewer && toolbarPos === 'bottom' && renderToolbar(false)}
      </div>

      {/* Панель управления */}
      <div className="w-full xl:w-80 space-y-4">
        <div className="relative overflow-hidden bg-slate-900 border border-slate-800 rounded-lg p-4">
          <Watermark glyph={GLYPHS.map} size={96} className="-right-3 -bottom-7 text-amber-500" />
          <h3 className="cinzel text-lg font-semibold text-amber-500 mb-1">{t('Интерактивная карта')}</h3>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {isViewer
              ? t('Расстановка бойцов, объекты и стратегия (только просмотр).')
              : t('Добавляйте бойцов и объекты кликом, перетаскивайте их и рисуйте стрелки и пометки. Инструментом «Выбор» фигуру можно двигать, растягивать, перекрашивать и удалять. Всё синхронизируется с командой.')}
          </p>
          {/* Сочетания — определительным списком: слева клавиша, справа что она делает.
              Пары выровнены сеткой на всю строку, а не отступами внутри каждой, иначе
              описания стояли бы лесенкой из-за разной ширины клавиш. */}
          <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-[11px]">
            {[...(isViewer ? [] : EDIT_KEYS), ...VIEW_KEYS].map(([key, what]) => (
              <React.Fragment key={key}>
                <dt>
                  {/* font-sans обязателен: браузер рисует <kbd> моноширинным по умолчанию, а в
                      проекте гарнитуры ровно две — Inter на интерфейс и Alice на заголовки.
                      Третья, да ещё системная и разная на каждой машине, тут не нужна. */}
                  <kbd className="font-sans rounded-lg border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-slate-300 whitespace-nowrap">
                    {t(key)}
                  </kbd>
                </dt>
                <dd className="text-slate-500">{t(what)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>

        {/* Игроки */}
        {!isViewer && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-slate-400">
                {t('Игроки')} <span className="text-slate-400">{placedCount}/{players.length}</span>
              </p>
              <div className="flex items-center gap-2">
                <button onClick={placeAll} disabled={players.length === 0} className="text-xs text-slate-400 hover:text-amber-400 disabled:opacity-40">
                  {t('Все')}
                </button>
                <button onClick={clearTokens} disabled={placedCount === 0} className="text-xs text-slate-400 hover:text-red-400 disabled:opacity-40">
                  {t('Убрать')}
                </button>
              </div>
            </div>

            {roster.length === 0 ? (
              <p className="text-[11px] text-slate-600 leading-relaxed">{t('В гильдии пока нет участников.')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5 max-h-[40vh] overflow-y-auto custom-scrollbar pr-1">
                  {roster.map(p => {
                    const placed = isPlaced(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => togglePlayer(p)}
                        title={placed ? t('Убрать с карты') : t('Поставить на карту')}
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition-colors ${placed ? 'bg-amber-950/30 border-amber-600/70' : 'bg-slate-950 border-slate-800 hover:border-slate-600'}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ROLE_DOT[p.role]}`}></span>
                        <span className="w-5 h-5 shrink-0 flex items-center justify-center">{ROLE_ICONS[p.role]}</span>
                        <span className="text-[11px] font-semibold text-slate-200 truncate flex-1">{p.name}</span>
                        <i className={`fa-solid ${placed ? 'fa-circle-check text-amber-400' : 'fa-plus text-slate-600'} text-[11px]`}></i>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-600 mt-3 leading-relaxed">
                  {t('Клик — поставить/убрать бойца. На карте токен можно перетаскивать; ✕ — убрать.')}
                </p>
              </>
            )}
          </div>
        )}

        {/* Объекты карты */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">{t('Объекты карты')}</p>
            {objectives.length > 0 && !isViewer && (
              <button onClick={clearObjectives} className="text-xs text-slate-400 hover:text-red-400">
                {t('Очистить')} ({objectives.length})
              </button>
            )}
          </div>

          {isViewer ? (
            <p className="text-[11px] text-slate-600 leading-relaxed">{t('Тактические объекты, расставленные командиром.')}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {OBJECTIVE_PALETTE.map(type => {
                  const cfg = OBJECTIVE_CONFIG[type];
                  return (
                    <button
                      key={type}
                      onClick={() => addObjective(type)}
                      title={`${t('Поставить на карту')}: ${t(cfg.label)}`}
                      className="flex items-center gap-2 bg-slate-950 border border-slate-800 hover:border-amber-700 rounded-lg px-2 py-1.5 transition-colors"
                    >
                      <img src={cfg.img} alt={t(cfg.label)} className="w-7 h-7 object-contain shrink-0" />
                      <span className="text-[11px] font-semibold text-slate-300 truncate">{t(cfg.label)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-600 mt-3 leading-relaxed">
                {t('Клик — поставить объект в центр карты. Объект можно перетаскивать; наведите и нажмите ✕, чтобы убрать.')}
              </p>
            </>
          )}
        </div>

        {/* Легенда ролей */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-wrap gap-x-4 gap-y-2">
          <p className="w-full text-xs text-slate-400 mb-1">{t('Легенда')}</p>
          {[Role.TANK, Role.DPS, Role.HEALER].map(r => (
            <div key={r} className="flex items-center gap-2 text-xs text-slate-300">
              <span className={`w-4 h-4 rounded-full ring-2 ${ROLE_RING[r]} inline-block shrink-0`}></span>
              {ROLE_LABELS[r]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Отрисовка одной фигуры в пиксельных координатах поля.
// interactive — инструмент «Выбор»: фигура ловит клики (широкая невидимая хит-зона),
// selected — подсветка выделения (янтарный ореол / рамка).
const DrawnShape: React.FC<{
  shape: DrawShape;
  w: number;
  h: number;
  interactive?: boolean;
  selected?: boolean;
  onGrab?: (e: React.PointerEvent) => void;
}> = ({ shape, w, h, interactive, selected, onGrab }) => {
  const toPx = (p: DrawPoint) => ({ x: (p.x / 100) * w, y: (p.y / 100) * h });
  const dashArr = shape.dash ? `${6 + shape.width * 2} ${5 + shape.width * 2}` : undefined;
  const hitStyle: React.CSSProperties | undefined = interactive ? { pointerEvents: 'auto', cursor: 'move' } : undefined;
  const hitWidth = Math.max(16, shape.width + 12);
  const glow = { stroke: '#f59e0b', strokeWidth: shape.width + 7, opacity: 0.35, strokeLinecap: 'round' as const, vectorEffect: 'non-scaling-stroke' as const };

  // Зоны: прямоугольник / эллипс по двум противоположным углам
  if (shape.type === 'rect' || shape.type === 'ellipse') {
    const a = toPx(shape.points[0]);
    const b = toPx(shape.points[1]);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    const fillPaint = shape.fill !== false ? hexToRgba(shape.color, shape.fillOpacity ?? ZONE_DEFAULT_OPACITY) : 'none';
    const common = { stroke: shape.color, strokeWidth: shape.width, strokeDasharray: dashArr, vectorEffect: 'non-scaling-stroke' as const };
    return (
      <g>
        {selected && (shape.type === 'rect'
          ? <rect x={x - 4} y={y - 4} width={rw + 8} height={rh + 8} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
          : <ellipse cx={x + rw / 2} cy={y + rh / 2} rx={rw / 2 + 5} ry={rh / 2 + 5} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />)}
        {/* Углы прямые (rx=0). Скругление в три пикселя выглядело аккуратно на одиночной
            зоне, но у состыкованных квадратов оставляет на каждом стыке четыре светлых
            выемки — то есть ровно на том, ради чего сетку и делали. */}
        {shape.type === 'rect'
          ? <rect x={x} y={y} width={rw} height={rh} fill={fillPaint} {...common} />
          : <ellipse cx={x + rw / 2} cy={y + rh / 2} rx={rw / 2} ry={rh / 2} fill={fillPaint} {...common} />}
        {/* Хит-зона прямоугольника — точно по фигуре, без напуска. Напуск в 6 пикселей
            помогал попасть в одиночную зону, но у состыкованных перекрывает соседа:
            целишься в свой квадрат, а хватается тот, что рядом. У площадной фигуры
            запас и не нужен — в неё и так есть куда ткнуть. */}
        {interactive && (shape.type === 'rect'
          ? <rect x={x} y={y} width={rw} height={rh} fill="transparent" stroke="none" style={hitStyle} onPointerDown={onGrab} />
          : <ellipse cx={x + rw / 2} cy={y + rh / 2} rx={rw / 2 + 6} ry={rh / 2 + 6} fill="transparent" stroke="none" style={hitStyle} onPointerDown={onGrab} />)}
      </g>
    );
  }

  if (shape.type === 'path') {
    const pts = shape.points.map(toPx).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return (
      <g>
        {selected && <polyline points={pts} fill="none" {...glow} strokeLinejoin="round" />}
        <polyline
          points={pts}
          fill="none"
          stroke={shape.color}
          strokeWidth={shape.width}
          strokeDasharray={dashArr}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {interactive && <polyline points={pts} fill="none" stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" strokeLinejoin="round" style={hitStyle} onPointerDown={onGrab} />}
      </g>
    );
  }

  // line / arrow — отрезок (у стрелки наконечник)
  const s = toPx(shape.points[0]);
  const e = toPx(shape.points[1]);
  const dx = e.x - s.x, dy = e.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const head = Math.max(10, shape.width * 3);
  const spread = head * 0.55;
  const bx = e.x - ux * head, by = e.y - uy * head;
  const px = -uy, py = ux;
  const left = { x: bx + px * spread, y: by + py * spread };
  const right = { x: bx - px * spread, y: by - py * spread };
  return (
    <g>
      {selected && <line x1={s.x} y1={s.y} x2={e.x} y2={e.y} {...glow} />}
      <line x1={s.x} y1={s.y} x2={e.x} y2={e.y} stroke={shape.color} strokeWidth={shape.width} strokeDasharray={dashArr} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {shape.type === 'arrow' && (
        <polygon points={`${e.x.toFixed(1)},${e.y.toFixed(1)} ${left.x.toFixed(1)},${left.y.toFixed(1)} ${right.x.toFixed(1)},${right.y.toFixed(1)}`} fill={shape.color} />
      )}
      {interactive && <line x1={s.x} y1={s.y} x2={e.x} y2={e.y} stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" style={hitStyle} onPointerDown={onGrab} />}
    </g>
  );
};

export default BattleMap;
