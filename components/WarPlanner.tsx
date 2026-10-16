
import React, { useState, useMemo, useRef, useEffect } from 'react';
import Glyph from './glyphs';
import { createPortal } from 'react-dom';
import {
  DndContext, MouseSensor, TouchSensor, useSensor, useSensors,
  useDraggable, useDroppable, pointerWithin,
  type DragStartEvent, type DragEndEvent, type DragOverEvent, type CollisionDetection
} from '@dnd-kit/core';
import {
  Player, Role, Lane, Side, SubRole, JunglePosition, GroupNumber,
  WarAssignment, GuildWarSession, CallRole, CALL_ROLES, WeaponSchool, WEAPON_SCHOOLS
} from '../types';
import {
  ROLE_LABELS, ROLE_ICONS,
  SIDES, SIDE_LABELS, SIDE_ICONS, SIDE_STYLES,
  LANES, LANE_LABELS, LANE_FULL_LABELS, LANE_ICONS, LANE_COLORS,
  GROUP_NUMBERS, SUBROLE_LABELS, SUBROLE_ICONS, SUBROLE_STYLES,
  JUNGLE_POSITIONS, JUNGLE_LABELS, JUNGLE_SHORT, JUNGLE_TINY,
  CALL_ROLE_LABELS, CALL_ROLE_ICONS, CALL_ROLE_STYLES,
  WEAPON_SCHOOL_IMAGES, WEAPON_SCHOOL_LABELS,
  CHICKEN_LABEL, CHICKEN_ICON, CHICKEN_STYLE, TIMING_LABELS,
  MAX_WAR_PLAYERS, PLAYERS_PER_SIDE, PLAYERS_PER_GROUP,
  DEFAULT_GROUP_LANES, groupLaneKey, getTowerInfo,
  SIGNUP_STYLES, SIGNUP_LABELS
} from '../constants';
import PlayerCard from './PlayerCard';
import BattleOrderExport, { type ExportVariant } from './BattleOrderExport';
import TimingsBoard, { GroupHandle } from './TimingsBoard';
import TimingPickModal from './TimingPickModal';
import { confirm, toast } from './Notifications';
import { useT } from '../services/i18n';
import { api } from '../services/api';
// Подбор расстановки живёт чистым модулем без сети — тем же файлом, что покрыт
// тестами (tests/autofill.test.mjs). Вторая реализация на фронте означала бы, что
// проверяется одна, а работает другая.
import { autofill } from '../server/autofill.mjs';
// План по таймингам — тоже общий модуль: правки клеток нельзя проверить глазом,
// поэтому они живут чистыми функциями (tests/timings.test.mjs).
import {
  readPlan, cellPlayers, hasChicken, scheduleOf,
  putPlayers as planPutPlayers, dropPlayers as planDropPlayers,
  putGroups as planPutGroups, dropGroups as planDropGroups,
  setChicken as planSetChicken, purgePlayers as planPurgePlayers,
  swapGroupRefs as planSwapGroupRefs,
  countTasks,
  TIMINGS as ALL_TIMINGS, BOSS as BOSS_SPOT, BOSS_TIMINGS, CAMPS, bossAt
} from '../server/timings.mjs';

// Почему боец оказался в этой пачке — для подсказки под именем
interface FillReason { side: Side; group: GroupNumber; hits: number; total: number; share: number; }
interface FillResult {
  assignments: WarAssignment[];
  timings: Record<string, any>;
  groupLanes: Record<string, Lane>;
  reasons: Record<string, FillReason>;
  added: number;
  skipped: string[];
}

interface WarPlannerProps {
  players: Player[];
  // Все сессии — из них автозаполнение берёт историю «кто где обычно играет».
  // Копить ничего не надо: расстановки уже лежат в каждой сессии.
  sessions: GuildWarSession[];
  activeSession: GuildWarSession;
  onUpdateSession: (session: GuildWarSession) => void;
  onUpdatePlayer: (p: Player) => void;
  isViewer?: boolean;
  claimedPlayerId?: string | null;
  // Нужен только для чтения архива расстановок в Закрытом режиме: там /api/lineups
  // закрыт, и офицер по паролю без заголовка получил бы пустую историю.
  editKey?: string | null;
}

const isValidAssignment = (a: WarAssignment) =>
  (a.side === Side.ATTACK || a.side === Side.DEFENSE) &&
  (a.group === 1 || a.group === 2 || a.group === 3);

// Порядок ролей внутри группы: танк → дд → хил
const ROLE_ORDER: Record<Role, number> = { [Role.TANK]: 0, [Role.DPS]: 1, [Role.HEALER]: 2 };

// Точная детекция под курсором, а если он не над зоной — ближайшая группа.
// Насколько далеко от рамки цели курсор ещё считается попаданием. Двадцать четыре
// пикселя — это шов между панелями (gap-3 = 12px) с запасом: бросок ровно в щель между
// двумя пачками попадает в ту, что ближе, а не проваливается.
const SNAP_PX = 24;

// Ловим цель ПОД КУРСОРОМ, а рядом — только вплотную.
//
// Раньше запасным вариантом стоял `closestCenter` по всему списку, и отменить перенос было
// нечем: он всегда возвращал хоть что-то, поэтому боец прилипал к ближайшей пачке, куда бы
// его ни отпустили — хоть на пустое поле, хоть обратно на место, откуда взяли. Хуже того,
// closestCenter меряет от центра ПЕРЕТАСКИВАЕМОГО УЗЛА, а не от курсора: узел остаётся
// лежать на прежнем месте, и «ближайшей» оказывалась цель рядом с исходной позицией.
//
// Теперь: курсор внутри цели — попадание; курсор в двух сантиметрах от неё — промах, и
// отпускание не делает ничего (`onDragEnd` уходит по `if (!a || !o) return`). Плюс Esc
// отменяет перенос на любом этапе — это умеет сам dnd-kit.
const collisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) return within;

  const p = args.pointerCoordinates;
  if (!p) return [];

  const near: ReturnType<CollisionDetection> = [];
  for (const container of args.droppableContainers) {
    const r = args.droppableRects.get(container.id);
    if (!r) continue;
    // расстояние от точки до прямоугольника: ноль, если точка внутри
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance <= SNAP_PX) near.push({ id: container.id, data: { droppableContainer: container, value: distance } });
  }
  return near.sort((a, b) => (a.data!.value as number) - (b.data!.value as number));
};

// Что сейчас перетаскивается (для оверлея-призрака dnd-kit)
type ActiveDrag =
  | { type: 'player'; playerId: string; player: Player }
  | { type: 'group'; side: Side; group: GroupNumber }
  // Ручка группы во вкладке таймингов: кладёт в клетку ссылку на пачку целиком
  | { type: 'timingGroup'; side: Side; group: GroupNumber };

const WarPlanner: React.FC<WarPlannerProps> = ({ players, sessions, activeSession, onUpdateSession, onUpdatePlayer, isViewer = false, claimedPlayerId = null, editKey = null }) => {
  const t = useT();
  const [viewMode, setViewMode] = useState<'board' | 'timings'>('board');
  // Какую сторону показывает таблица таймингов. Своя переменная, а не selectedSide:
  // тот отвечает за «куда добавлять из пула» на доске, и связав их, мы бы дёргали
  // цель добавления при каждом переключении вкладки.
  const [timingSide, setTimingSide] = useState<Side>(Side.DEFENSE);
  const [selectedSide, setSelectedSide] = useState<Side>(Side.ATTACK);
  const [selectedGroup, setSelectedGroup] = useState<GroupNumber>(1);
  // Единое выделение бойцов: 1 или несколько (Ctrl/Shift+клик). Заменяет и модалку, и балк-режим.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Какой лагерь ставим прямо сейчас — открыта модалка «Укажите тайминги»
  const [campPick, setCampPick] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [signedUpOnly, setSignedUpOnly] = useState(false); // фильтр пула: только заявившиеся

  // Drag-and-drop (dnd-kit): что сейчас перетаскивается — для красивого оверлея-призрака.
  // MouseSensor стартует после 8px (клик не превращается в драг), TouchSensor — после
  // удержания 180мс (тап и прокрутка на телефоне продолжают работать).
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  // Свой оверлей-призрак: position:fixed в портале на body (его ничего не обрезает,
  // в отличие от DragOverlay внутри контейнера доски со скроллом).
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  // Есть ли под курсором цель. Нужно, чтобы призрак сам сказал: отпустишь здесь — ничего
  // не произойдёт. Без этого «промах» неотличим от «сейчас положу», и передумать страшно.
  const [overTarget, setOverTarget] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } })
  );

  // Экспорт боевого приказа в картинку: сторона (Атака / Деф) × вид (состав / тайминги).
  //
  // Офскрин-макетов из-за этого четыре, и держим мы их картой по ключу, а не отдельными
  // переменными: с четырьмя ref'ами каждая ветка «какой узел снимать» пишется вручную,
  // и пятый вид приказа потребовал бы править её же в третий раз.
  const exportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const exportKey = (side: Side, variant: ExportVariant) => `${side}:${variant}`;
  const [exporting, setExporting] = useState<string | null>(null);
  // Картинка для предпросмотра, когда нативное копирование недоступно (например, сайт по HTTP —
  // Clipboard API работает только в защищённом контексте/HTTPS). Тогда показываем модалку,
  // где можно «ПКМ → Копировать изображение» или скачать.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // html-to-image рисует через нативный SVG foreignObject (пиксель-в-пиксель как DOM).
  // Предзагружаем модуль, чтобы при копировании не было await перед clipboard.write —
  // иначе теряется «активация по жесту» и Brave/Chrome отклоняют запись в буфер.
  const htmlToImageRef = useRef<typeof import('html-to-image') | null>(null);
  useEffect(() => { import('html-to-image').then(m => { htmlToImageRef.current = m; }).catch(() => {}); }, []);

  const downloadPng = async (mod: typeof import('html-to-image'), node: HTMLElement, opts: any, tag: string) => {
    try { await (document as any).fonts?.ready; } catch {}
    const url = await mod.toPng(node, opts);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wwm_${tag}_${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const exportSide = async (side: Side, variant: ExportVariant, mode: 'download' | 'copy') => {
    if (exporting) return;
    const node = exportRefs.current[exportKey(side, variant)];
    if (!node) return;
    setExporting(exportKey(side, variant));
    const opts = { pixelRatio: 2, backgroundColor: '#0a0b0c', cacheBust: true };
    // Вид попадает в имя файла: обе картинки одной стороны лежат в одной папке загрузок,
    // и «wwm_ataka_2026-09-04.png» рядом с таким же вторым различить нечем.
    const tag = `${side === Side.ATTACK ? 'ataka' : 'def'}_${variant === 'roster' ? 'sostav' : 'timings'}`;
    try {
      const mod = htmlToImageRef.current || await import('html-to-image');

      if (mode === 'copy') {
        // Нативное копирование в буфер требует защищённого контекста (HTTPS/localhost).
        const canNativeCopy = window.isSecureContext && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
        if (canNativeCopy) {
          try {
            // Promise-ClipboardItem: clipboard.write вызывается сразу (картинка готовится внутри),
            // поэтому «жест» не теряется — работает в Brave/Chrome.
            const item = new ClipboardItem({
              'image/png': mod.toBlob(node, opts).then(b => { if (!b) throw new Error('blob'); return b; })
            });
            await navigator.clipboard.write([item]);
            toast(t('Картинка скопирована — вставьте в Discord (Ctrl+V).'), 'success');
            return;
          } catch (err) {
            console.error('clipboard.write не сработал, открываю предпросмотр:', err);
            // упадём в предпросмотр ниже
          }
        }
        // HTTP / буфер запрещён → показываем картинку: ПКМ → «Копировать изображение»
        try { await (document as any).fonts?.ready; } catch {}
        setPreviewUrl(await mod.toPng(node, opts));
        return;
      }

      await downloadPng(mod, node, opts, tag);
      toast(t('Картинка скачана.'), 'success');
    } catch (err) {
      console.error('Не удалось сформировать картинку:', err);
      toast(t('Не удалось сформировать картинку.'), 'error');
    } finally {
      setExporting(null);
    }
  };

  const assignments = activeSession.assignments || [];
  const signups = activeSession.signups || {};

  const validAssignments = useMemo(() => assignments.filter(isValidAssignment), [assignments]);
  const assignedIds = useMemo(() => new Set(validAssignments.map(a => a.playerId)), [validAssignments]);

  // ---- План по таймингам ----
  // Читаем через readPlan: у сессий, собранных до таймингов, поля нет, и план
  // разворачивается из старых junglePosition/bossTime/carriesChicken на лету.
  const plan = useMemo(() => readPlan(activeSession), [activeSession]);

  // Любая запись плана заодно вычищает старые поля из расстановки. Оставить их
  // означало бы держать две правды об одном: карточка показывала бы старое значение,
  // а таблица новое, и разошлись бы они в первый же вечер.
  const stripLegacy = (list: WarAssignment[]): WarAssignment[] => list.map(a => {
    const subs = (a.subRoles ?? (a.subRole ? [a.subRole] : [])).filter(s => s === SubRole.TOWER);
    const { junglePosition, bossTime, carriesChicken, subRole, ...rest } = a;
    return subs.length ? { ...rest, subRoles: subs } : { ...rest, subRoles: [] };
  });

  const updatePlan = (next: Record<string, any>, extra?: Partial<GuildWarSession>) => {
    if (isViewer) return;
    onUpdateSession({ ...activeSession, ...extra, timings: next, assignments: stripLegacy(assignments) });
  };

  // Операции над планом — тонкие обёртки над общим модулем. Логика (взаимоисключающие
  // лагеря, курица только тому, кто в клетке стоит) живёт там и покрыта тестами.
  const planOps = {
    putPlayers: (a: any) => updatePlan(planPutPlayers(plan, a)),
    dropPlayers: (a: any) => updatePlan(planDropPlayers(plan, a)),
    putGroups: (a: any) => updatePlan(planPutGroups(plan, a)),
    dropGroups: (a: any) => updatePlan(planDropGroups(plan, a)),
    setChicken: (a: any) => updatePlan(planSetChicken(plan, validAssignments, a))
  };

  const unassignedPlayers = useMemo(
    () => players.filter(p => !assignedIds.has(p.id)),
    [players, assignedIds]
  );

  const filteredUnassigned = useMemo(
    () => unassignedPlayers.filter(p =>
      p.name.toLowerCase().includes(search.toLowerCase()) &&
      (!signedUpOnly || ['in', 'maybe', 'sub'].includes(signups[p.id]))
    ),
    [unassignedPlayers, search, signedUpOnly, signups]
  );

  const playerById = (id: string) => players.find(p => p.id === id);

  // Внутри группы автосортировка: сверху танки, затем дд, затем хилы (потом по имени)
  const playersIn = (side: Side, group: GroupNumber) =>
    validAssignments
      .filter(a => a.side === side && a.group === group)
      .map(a => ({ assignment: a, player: playerById(a.playerId)! }))
      .filter(item => item.player)
      .sort((x, y) =>
        ROLE_ORDER[x.player.role] - ROLE_ORDER[y.player.role] ||
        x.player.name.localeCompare(y.player.name)
      );

  // ---- Линия группы ----
  const getGroupLane = (side: Side, group: GroupNumber): Lane => {
    const key = groupLaneKey(side, group);
    return activeSession.groupLanes?.[key] ?? DEFAULT_GROUP_LANES[key] ?? Lane.UNASSIGNED;
  };

  const setGroupLane = (side: Side, group: GroupNumber, lane: Lane) => {
    if (isViewer) return;
    const groupLanes = { ...(activeSession.groupLanes || {}), [groupLaneKey(side, group)]: lane };
    onUpdateSession({ ...activeSession, groupLanes });
  };

  // Боец сменил сторону — его задачи в лесу больше не его: клетки плана привязаны к
  // стороне, и оставшаяся запись тихо расписала бы человека туда, куда он не придёт.
  // Смена группы плану не мешает: групповые ссылки на то и ссылки.
  const purgeMoved = (ids: string[], side: Side): Record<string, any> | null => {
    const moved = ids.filter(id => {
      const cur = assignments.find(a => a.playerId === id);
      return cur && isValidAssignment(cur) && cur.side !== side;
    });
    return moved.length ? planPurgePlayers(plan, moved) : null;
  };

  // Раз пишем план — старые поля с расстановки уходят той же записью. Иначе у сессии
  // разом оказались бы и timings, и junglePosition: читается первое, правится первое,
  // а второе тихо остаётся жить и однажды всплывёт в чужом коде как «а вот же оно».
  const savePlanned = (nextAssignments: WarAssignment[], nextPlan: Record<string, any> | null) => {
    onUpdateSession({
      ...activeSession,
      assignments: nextPlan ? stripLegacy(nextAssignments) : nextAssignments,
      ...(nextPlan ? { timings: nextPlan } : {})
    });
  };

  // ---- Назначения ----
  // Назначить бойца в конкретную (сторона, группа). При перемещении уже
  // назначенного бойца сохраняем его доп-роль (тавер) и расписание по таймингам.
  const assignTo = (playerId: string, side: Side, group: GroupNumber) => {
    if (isViewer) return;
    const existing = assignments.find(a => a.playerId === playerId);
    const alreadyAssigned = existing && isValidAssignment(existing);
    if (!alreadyAssigned && validAssignments.length >= MAX_WAR_PLAYERS) return;
    const next: WarAssignment[] = [
      ...assignments.filter(a => a.playerId !== playerId),
      existing ? { ...existing, side, group } : { playerId, side, group }
    ];
    savePlanned(next, purgeMoved([playerId], side));
  };

  const assignToTarget = (playerId: string) => assignTo(playerId, selectedSide, selectedGroup);

  const updateAssignment = (playerId: string, patch: Partial<WarAssignment>) => {
    if (isViewer) return;
    const next = assignments.map(a => (a.playerId === playerId ? { ...a, ...patch } : a));
    onUpdateSession({ ...activeSession, assignments: next });
  };

  const removePlayer = (playerId: string) => {
    if (isViewer) return;
    // Снятый из состава обязан исчезнуть и из плана: иначе он остался бы расписан
    // на лагерь, в который уже не придёт, и клетка выглядела бы занятой.
    savePlanned(assignments.filter(a => a.playerId !== playerId), planPurgePlayers(plan, [playerId]));
    setSelectedIds(prev => { if (!prev.has(playerId)) return prev; const n = new Set(prev); n.delete(playerId); return n; });
  };

  // Перенести сразу нескольких бойцов в (сторона, группа) — одним обновлением.
  // Уже назначенные сохраняют доп-роль/позицию; ёмкость стороны (15) не превышаем
  // (если мест не хватает — лишние остаются там, где были).
  const moveManyTo = (ids: string[], side: Side, group: GroupNumber) => {
    if (isViewer || ids.length === 0) return;
    const moving = new Set(ids);
    const base = assignments.filter(a => !moving.has(a.playerId));
    let capacity = MAX_WAR_PLAYERS - base.filter(isValidAssignment).length;
    const added: WarAssignment[] = [];
    for (const id of ids) {
      const existing = assignments.find(a => a.playerId === id);
      if (capacity <= 0) { if (existing) added.push(existing); continue; } // нет мест — оставить как было
      added.push(existing ? { ...existing, side, group } : { playerId: id, side, group });
      capacity--;
    }
    savePlanned([...base, ...added], purgeMoved(ids, side));
  };

  // Снять сразу нескольких из состава войны.
  const removeMany = (ids: string[]) => {
    if (isViewer || ids.length === 0) return;
    const moving = new Set(ids);
    savePlanned(assignments.filter(a => !moving.has(a.playerId)), planPurgePlayers(plan, ids));
    setSelectedIds(prev => { const n = new Set(prev); ids.forEach(id => n.delete(id)); return n; });
  };

  // Если тащим одного из нескольких выделенных — едет вся выборка; иначе только он.
  const dragIds = (playerId: string): string[] =>
    selectedIds.has(playerId) && selectedIds.size > 1 ? [...selectedIds] : [playerId];

  // ---- Drag-and-drop (dnd-kit) ----
  const draggingAssigned = activeDrag?.type === 'player' && assignedIds.has(activeDrag.playerId);

  const pointerFromEvent = (ev: Event | null): { x: number; y: number } => {
    const e = ev as MouseEvent & TouchEvent;
    if (e && 'clientX' in e && typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY };
    const t = e && e.touches && e.touches[0];
    return t ? { x: t.clientX, y: t.clientY } : { x: 0, y: 0 };
  };

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as ActiveDrag | undefined;
    if (d?.type === 'player' || d?.type === 'group' || d?.type === 'timingGroup') setActiveDrag(d);
    setDragPoint(pointerFromEvent(e.activatorEvent));
    setOverTarget(false);
  };
  const onDragOver = (e: DragOverEvent) => setOverTarget(!!e.over);
  // Призрак следует за НАСТОЯЩИМ курсором, а не за `delta` из dnd-kit.
  //
  // Это не придирка, а починка. В `delta` входит поправка на прокрутку: пока идёт драг,
  // dnd-kit подкручивает смещение, чтобы перетаскиваемый УЗЕЛ СТРАНИЦЫ оставался под
  // пальцем, — узел ведь уезжает вместе с прокруткой. Наш призрак прокруткой не движется
  // вовсе, он `position: fixed`, и та же поправка утаскивала его от курсора ровно на
  // прокрученное расстояние: подвёл к краю окна, включилась автопрокрутка — и карточка
  // ушла на сотни пикселей вверх (замерено: 987 пикселей прокрутки = 987 пикселей мимо).
  //
  // Заметно это стало во вкладке таймингов, потому что там страница длинная и почти любой
  // перенос задевает край окна. На доске колонки со своей высотой, окно почти не ездит —
  // и та же ошибка не проявлялась.
  //
  // Слушаем оба события: `pointermove` покрывает мышь и современный тач, `touchmove`
  // остаётся страховкой — dnd-kit на телефоне гасит у него действие по умолчанию, и
  // полагаться на то, что указательные события придут следом, не стоит.
  useEffect(() => {
    if (!activeDrag) return;
    const move = (e: PointerEvent | TouchEvent) => {
      const p = pointerFromEvent(e as Event);
      if (p.x || p.y) setDragPoint(p);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', move);
    };
  }, [activeDrag]);

  const onDragCancel = () => { setActiveDrag(null); setDragPoint(null); setOverTarget(false); };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    setDragPoint(null);
    setOverTarget(false);
    if (isViewer) return;
    const a = e.active.data.current as ActiveDrag | undefined;
    const o = e.over?.data.current as { type: string; side?: Side; group?: GroupNumber } | undefined;
    if (!a || !o) return;
    if (a.type === 'player') {
      const ids = dragIds(a.playerId);
      if (o.type === 'group' && o.side && o.group) moveManyTo(ids, o.side, o.group);
      else if (o.type === 'cell') dropIntoCell(ids, o as any);
      else if (o.type === 'pool') removeMany(ids);
    } else if (a.type === 'group' && o.type === 'group' && o.side && o.group) {
      swapGroups(`${a.side}:${a.group}`, o.side, o.group);
    } else if (a.type === 'timingGroup' && o.type === 'cell') {
      const cell = o as any;
      if (cell.side === a.side) planOps.putGroups({ side: cell.side, timings: cell.timings, spot: cell.spot, groups: [a.group] });
    }
  };

  // Бросок бойца в клетку таблицы таймингов. В план попадают только те, кто уже стоит
  // в составе ЭТОЙ стороны: клетка привязана к стороне, и записать туда чужого значило
  // бы расписать человека на войну, в которой его нет.
  const dropIntoCell = (ids: string[], cell: { side: Side; timings: string[]; spot: string }) => {
    const mine = ids.filter(id => {
      const a = assignments.find(x => x.playerId === id);
      return a && isValidAssignment(a) && a.side === cell.side;
    });
    if (!mine.length) {
      toast(t('Сначала поставьте бойца в состав этой стороны на доске'), 'error');
      return;
    }
    if (cell.spot === BOSS_SPOT && !cell.timings.some((tm: string) => bossAt(tm))) return;
    planOps.putPlayers({ side: cell.side, timings: cell.timings, spot: cell.spot, playerIds: mine });
  };

  // Поменять две группы местами (состав + линия переезжают вместе)
  const swapGroups = (fromKey: string, toSide: Side, toGroup: GroupNumber) => {
    if (isViewer) return;
    const [fSideStr, fGroupStr] = fromKey.split(':');
    const fSide = fSideStr as Side;
    const fGroup = Number(fGroupStr) as GroupNumber;
    if (fSide === toSide && fGroup === toGroup) return;
    const next = assignments.map(a => {
      if (isValidAssignment(a) && a.side === fSide && a.group === fGroup) return { ...a, side: toSide, group: toGroup };
      if (isValidAssignment(a) && a.side === toSide && a.group === toGroup) return { ...a, side: fSide, group: fGroup };
      return a;
    });
    const gl = { ...(activeSession.groupLanes || {}) };
    const fk = groupLaneKey(fSide, fGroup);
    const tk = groupLaneKey(toSide, toGroup);
    const fLane = gl[fk] ?? DEFAULT_GROUP_LANES[fk] ?? Lane.UNASSIGNED;
    const tLane = gl[tk] ?? DEFAULT_GROUP_LANES[tk] ?? Lane.UNASSIGNED;
    gl[fk] = tLane;
    gl[tk] = fLane;
    // Групповые ссылки в лесу едут за людьми (внутри стороны это перенумерация),
    // а поимённые записи уехавших на другую сторону вычищаются.
    const swapped = planSwapGroupRefs(plan, fSide, fGroup, toSide, toGroup);
    const movedIds = fSide === toSide
      ? []
      : validAssignments.filter(a =>
          (a.side === fSide && a.group === fGroup) || (a.side === toSide && a.group === toGroup)
        ).map(a => a.playerId);
    onUpdateSession({
      ...activeSession,
      assignments: stripLegacy(next),
      groupLanes: gl,
      timings: movedIds.length ? planPurgePlayers(swapped, movedIds) : swapped
    });
  };
  // Автозаполнение по истории: кто в какой пачке обычно играет. Прежняя кнопка
  // раскладывала неназначенных ПОДРЯД, не глядя ни на заявки, ни на историю — в
  // состав ехали и ответившие «не иду», поэтому пользы от неё не было.
  //
  // Уже расставленных не трогаем: это «дозаполни остальных», а не «перепиши мою
  // работу», — иначе кнопку страшно нажимать.
  const [undoFill, setUndoFill] = useState<WarAssignment[] | null>(null);
  // Откат обязан вернуть и план: автозаполнение дописывает лес по истории, и «Отменить»,
  // вернувшее только расстановку, оставило бы людей расписанными на лагеря без причины.
  const [undoPlan, setUndoPlan] = useState<Record<string, any> | null>(null);
  const [fillWhy, setFillWhy] = useState<Record<string, FillReason>>({});
  const [filling, setFilling] = useState(false);
  // Что именно положило автозаполнение. Как только расстановка изменилась любым
  // другим способом, откат и подсказки пропадают: иначе «Отменить» стёрло бы
  // правки, сделанные офицером уже после заполнения.
  const filledRef = useRef<WarAssignment[] | null>(null);
  const canUndo = !!undoFill && filledRef.current === assignments;

  const autoAssign = async () => {
    if (isViewer || filling) return;
    // Архив тянем прямо сейчас, а не при загрузке страницы: события могли удалить
    // уже после того, как вкладку открыли, и тогда копия была бы неполной.
    setFilling(true);
    const archive = await api.getLineups(editKey);
    setFilling(false);
    const res = autofill({ players, sessions, archive, target: activeSession }) as FillResult;
    if (res.added <= 0) {
      toast(t('Заполнять некого: все, кто идёт, уже расставлены.'), 'info');
      return;
    }
    setUndoFill(assignments);
    setUndoPlan(activeSession.timings ?? null);
    setFillWhy(res.reasons);
    filledRef.current = res.assignments;
    onUpdateSession({
      ...activeSession,
      assignments: res.assignments,
      timings: res.timings,
      groupLanes: { ...res.groupLanes, ...(activeSession.groupLanes || {}) }
    });
    const left = res.skipped.length;
    toast(left
      ? `${t('Расставлено')}: ${res.added}. ${t('Не хватило мест')}: ${left}`
      : `${t('Расставлено по привычным местам')}: ${res.added}`, 'success');
  };

  const revertFill = () => {
    if (isViewer || !undoFill) return;
    // Поля timings не было — значит сессия жила на старых полях, и возвращать надо
    // именно отсутствие поля, а не пустой план: иначе развернуть старые данные снова
    // будет уже нечем.
    const restored: GuildWarSession = { ...activeSession, assignments: undoFill };
    if (undoPlan) restored.timings = undoPlan; else delete restored.timings;
    onUpdateSession(restored);
    setUndoFill(null);
    setUndoPlan(null);
    setFillWhy({});
    filledRef.current = null;
  };

  // Подсказка под именем: «обычно Деф-2 (7 из 9)». Дёшево и сразу видно, догадка
  // это или решение офицера.
  const fillHint = (playerId: string): string => {
    const why = canUndo ? fillWhy[playerId] : undefined;
    if (!why) return '';
    if (!why.hits) return t('Поставлен на свободное место — истории нет');
    return `${t('Обычно')} ${SIDE_LABELS[why.side]}-${why.group} (${why.hits} ${t('из')} ${why.total})`;
  };

  const clearAll = async () => {
    if (isViewer || validAssignments.length === 0) return;
    const ok = await confirm(t('Снять всех бойцов из состава войны?'), { confirmLabel: t('Снять всех'), danger: true });
    if (!ok) return;
    // План уходит вместе с составом: лес без бойцов — это расписание для пустого места.
    onUpdateSession({ ...activeSession, assignments: [], timings: {} });
    setSelectedIds(new Set());
  };

  // Доп-роли бойца как массив (с поддержкой старого одиночного поля subRole)
  const getSubRoles = (a?: WarAssignment): SubRole[] =>
    a ? (a.subRoles ?? (a.subRole ? [a.subRole] : [])) : [];

  // ---- Выделение бойцов (1 или несколько) ----
  const selectedAssignments = validAssignments.filter(a => selectedIds.has(a.playerId));
  const selectedPlayers = players.filter(p => selectedIds.has(p.id));
  const single = selectedPlayers.length === 1 ? selectedPlayers[0] : null;        // ровно один — для школ
  const singleA = selectedIds.size === 1 ? selectedAssignments[0] ?? null : null;

  const selectOnly = (id: string) => setSelectedIds(new Set([id]));
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => setSelectedIds(new Set());
  const onCardClick = (e: React.MouseEvent, id: string) => {
    if (isViewer) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(id); else selectOnly(id);
  };
  const selectGroup = (side: Side, group: GroupNumber) => {
    if (isViewer) return;
    setSelectedIds(new Set(playersIn(side, group).map(m => m.player.id)));
  };

  // ---- Счётчики ----
  const roleCount = (role: Role) =>
    validAssignments.filter(a => playerById(a.playerId)?.role === role).length;
  const sideCount = (side: Side) => validAssignments.filter(a => a.side === side).length;

  // Сколько бойцов стороны заняты в перечисленных точках хотя бы на одном тайминге
  const planCount = (side: Side, spotList: string[]) => {
    let n = 0;
    for (const a of validAssignments) {
      if (a.side !== side) continue;
      for (const tm of ALL_TIMINGS) {
        let found = false;
        for (const sp of spotList) {
          if (cellPlayers(plan, validAssignments, side, tm, sp).includes(a.playerId)) { found = true; break; }
        }
        if (found) { n++; break; }
      }
    }
    return n;
  };
  // Сколько человек вообще заняты лесом и боссом — плитка счётчиков над доской
  const jungleHeads = SIDES.reduce((n, s) => n + planCount(s, CAMPS), 0);
  const bossHeads = SIDES.reduce((n, s) => n + planCount(s, [BOSS_SPOT]), 0);

  // ---- Редактирование выделенных бойцов (1 или несколько — одинаково) ----
  // Доп-роль: если есть у ВСЕХ выделенных — снять у всех, иначе добавить всем.
  // Осталась одна — Тавер: она про весь бой, а лес и босс уехали в тайминги.
  const toggleSubRoleSel = (sub: SubRole) => {
    if (isViewer || selectedIds.size === 0) return;
    const allHave = selectedAssignments.length > 0 && selectedAssignments.every(a => getSubRoles(a).includes(sub));
    const next = assignments.map(a => {
      if (!selectedIds.has(a.playerId) || !isValidAssignment(a)) return a;
      const cur = getSubRoles(a);
      const subRoles = allHave ? cur.filter(s => s !== sub) : (cur.includes(sub) ? cur : [...cur, sub]);
      return { ...a, subRoles, subRole: undefined };
    });
    onUpdateSession({ ...activeSession, assignments: next });
  };

  // Выделенные, разложенные по сторонам: клетки плана привязаны к стороне, поэтому
  // одна кнопка в карточке при смешанном выделении даёт две правки, а не одну.
  const selectionBySide = (): [Side, string[]][] => {
    const m = new Map<Side, string[]>();
    for (const a of selectedAssignments) {
      if (!m.has(a.side)) m.set(a.side, []);
      m.get(a.side)!.push(a.playerId);
    }
    return [...m.entries()];
  };

  // Сводка по выделению для кнопки: попаданий из скольких возможных. Из неё
  // получается три состояния — залито (везде), пунктир (частично), пусто (нигде) —
  // тем же языком, каким уже говорят доп-роли при мультивыделении.
  type Stat = { hit: number; total: number; state: 'all' | 'some' | 'none' };
  const statOf = (hit: number, total: number): Stat =>
    ({ hit, total, state: hit === 0 ? 'none' : hit >= total ? 'all' : 'some' });

  const campStat = (spot: string): Stat => {
    let hit = 0, total = 0;
    for (const a of selectedAssignments) for (const tm of ALL_TIMINGS) {
      total++;
      if (cellPlayers(plan, validAssignments, a.side, tm, spot).includes(a.playerId)) hit++;
    }
    return statOf(hit, total);
  };

  const bossStat = (tm: string): Stat => {
    let hit = 0;
    for (const a of selectedAssignments) {
      if (cellPlayers(plan, validAssignments, a.side, tm, BOSS_SPOT).includes(a.playerId)) hit++;
    }
    return statOf(hit, selectedAssignments.length);
  };

  // Курица считается только там, где у бойца есть сама задача: курица без задачи —
  // запись, которую некому исполнить, и в знаменателе ей не место.
  const chickenStat = (where: 'jungle' | 'boss'): Stat => {
    const spots: string[] = where === 'jungle' ? CAMPS : [BOSS_SPOT];
    const times: string[] = where === 'jungle' ? ALL_TIMINGS : BOSS_TIMINGS;
    let hit = 0, total = 0;
    for (const a of selectedAssignments) for (const tm of times) for (const sp of spots) {
      if (!cellPlayers(plan, validAssignments, a.side, tm, sp).includes(a.playerId)) continue;
      total++;
      if (hasChicken(plan, a.side, tm, sp, a.playerId)) hit++;
    }
    return statOf(hit, total);
  };

  // Поставить выделенных в лагерь на перечисленных таймингах
  const applyCamp = (spot: string, timings: string[]) => {
    if (isViewer) return;
    let next = plan;
    for (const [side, ids] of selectionBySide()) {
      next = planPutPlayers(next, { side, timings, spot, playerIds: ids });
    }
    updatePlan(next);
  };

  // Снять выделенных из лагеря целиком. Модалка тут не нужна: убрать — однозначно,
  // уточнять нечего, а лишний вопрос на каждое снятие только злит.
  const clearCamp = (spot: string) => {
    if (isViewer) return;
    let next = plan;
    for (const [side, ids] of selectionBySide()) {
      next = planDropPlayers(next, { side, timings: ALL_TIMINGS, spot, playerIds: ids });
    }
    updatePlan(next);
  };

  // Босс: модалки нет — 25-я и 15-я это и есть тайминги, спрашивать нечего
  const toggleBossSel = (tm: string) => {
    if (isViewer) return;
    const on = bossStat(tm).state !== 'all';
    let next = plan;
    for (const [side, ids] of selectionBySide()) {
      next = on
        ? planPutPlayers(next, { side, timings: [tm], spot: BOSS_SPOT, playerIds: ids })
        : planDropPlayers(next, { side, timings: [tm], spot: BOSS_SPOT, playerIds: ids });
    }
    updatePlan(next);
  };

  // Курица из карточки — быстрый путь: ставит её на ВСЕ задачи бойца этого рода.
  // Точечно (курица только на 20-й) — во вкладке таймингов, прямо на фишке.
  const toggleChickenSel = (where: 'jungle' | 'boss') => {
    if (isViewer) return;
    const on = chickenStat(where).state !== 'all';
    const spots: string[] = where === 'jungle' ? CAMPS : [BOSS_SPOT];
    const times: string[] = where === 'jungle' ? ALL_TIMINGS : BOSS_TIMINGS;
    let next = plan;
    for (const [side, ids] of selectionBySide()) {
      for (const spot of spots) {
        next = planSetChicken(next, validAssignments, { side, timings: times, spot, playerIds: ids, on });
      }
    }
    updatePlan(next);
  };

  const moveSel = (side: Side, group: GroupNumber) => {
    if (isViewer) return;
    const ids = selectedAssignments.map(a => a.playerId);
    const next = assignments.map(a => (selectedIds.has(a.playerId) && isValidAssignment(a)) ? { ...a, side, group } : a);
    savePlanned(next, purgeMoved(ids, side));
  };
  const removeSel = () => {
    if (isViewer || selectedIds.size === 0) return;
    savePlanned(assignments.filter(a => !selectedIds.has(a.playerId)), planPurgePlayers(plan, [...selectedIds]));
    clearSelection();
  };
  const setRoleSel = (role: Role) => {
    if (isViewer) return;
    selectedPlayers.forEach(p => onUpdatePlayer({ ...p, role }));
  };
  const toggleCallSel = (cr: CallRole) => {
    if (isViewer) return;
    const allHave = selectedPlayers.length > 0 && selectedPlayers.every(p => (p.callRoles || []).includes(cr));
    selectedPlayers.forEach(p => {
      const cur = p.callRoles || [];
      const callRoles = allHave ? cur.filter(x => x !== cr) : (cur.includes(cr) ? cur : [...cur, cr]);
      onUpdatePlayer({ ...p, callRoles });
    });
  };
  const setWeaponSel = (slot: 0 | 1, w: WeaponSchool) => {
    if (isViewer || !single) return;
    const weapons = [...(single.weapons && single.weapons.length === 2 ? single.weapons : [WEAPON_SCHOOLS[0], WEAPON_SCHOOLS[0]])];
    weapons[slot] = w;
    onUpdatePlayer({ ...single, weapons });
  };
  // Сводное состояние по выделению: есть у всех / у части / ни у кого
  const subRoleState = (sub: SubRole): 'all' | 'some' | 'none' => {
    if (selectedAssignments.length === 0) return 'none';
    const n = selectedAssignments.filter(a => getSubRoles(a).includes(sub)).length;
    return n === 0 ? 'none' : n === selectedAssignments.length ? 'all' : 'some';
  };
  const callState = (cr: CallRole): 'all' | 'some' | 'none' => {
    if (selectedPlayers.length === 0) return 'none';
    const n = selectedPlayers.filter(p => (p.callRoles || []).includes(cr)).length;
    return n === 0 ? 'none' : n === selectedPlayers.length ? 'all' : 'some';
  };

  // Строчка под кнопками лагерей: что у бойца стоит сейчас. Пунктирная кнопка честно
  // говорит «не везде», но не говорит где — это и добирает подпись. Показываем только
  // при одном выделенном: для пачки из семерых такая строка была бы простынёй.
  const campSummary = useMemo(() => {
    if (!singleA) return '';
    const sch = scheduleOf(plan, validAssignments, singleA.side, singleA.playerId);
    const runs = new Map<string, string[]>();
    for (const tm of ALL_TIMINGS as string[]) {
      const camp = sch[tm].camp;
      if (!camp) continue;
      if (!runs.has(camp)) runs.set(camp, []);
      runs.get(camp)!.push(tm);
    }
    if (!runs.size) return '';
    return [...runs.entries()]
      .map(([camp, tms]) => `${JUNGLE_SHORT[camp as JunglePosition]}: ${tms.map(x => TIMING_LABELS[x]).join(' · ')}`)
      .join(' · ');
  }, [plan, singleA, validAssignments]);

  // ---- Бейджи на карточке доски ----
  // Расписание сворачивается до читаемого: один лагерь на все шесть таймингов — это
  // просто «Топ лес дальн.», а если тайминги разные, рядом встаёт их число. Разворачивать
  // шесть строк на карточке шириной в двести пикселей бессмысленно — за подробностями
  // человек идёт во вкладку таймингов.
  const renderBadges = (a: WarAssignment): React.ReactNode[] | undefined => {
    const items: React.ReactNode[] = [];
    const sch = scheduleOf(plan, validAssignments, a.side, a.playerId);

    const camps = new Map<string, { n: number; chicken: boolean }>();
    const bossTimes: string[] = [];
    let bossChicken = false;
    for (const tm of ALL_TIMINGS) {
      const row = sch[tm];
      if (row.camp) {
        const cur = camps.get(row.camp) || { n: 0, chicken: false };
        camps.set(row.camp, { n: cur.n + 1, chicken: cur.chicken || row.campChicken });
      }
      if (row.boss) { bossTimes.push(tm); bossChicken = bossChicken || row.bossChicken; }
    }

    // Лес — ОДНА фишка, даже если лагерей несколько. Карточка на доске отвечает на
    // вопрос «кто в этой пачке», и имя в ней главнее: две-три лесные фишки вытесняли
    // имя в многоточие, то есть ломали ровно то, ради чего карточка существует.
    // Многоточие означает «не всё время здесь» — за подробностями во вкладку таймингов.
    if (camps.size) {
      const [camp, info] = [...camps.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const varies = camps.size > 1 || info.n < ALL_TIMINGS.length;
      const anyChicken = [...camps.values()].some(c => c.chicken);
      const st = SUBROLE_STYLES[SubRole.JUNGLE];
      // «Не весь бой здесь» показывает ПУНКТИР рамки, а не многоточие в тексте: рядом
      // с обрезанной подписью «Топ ближ.…» читалось как оборванное слово, а не как
      // состояние. Пунктир — тот же язык, каким доп-роли говорят «есть у части».
      items.push(
        <span key="jungle"
          title={[...camps.entries()].map(([c, i]) => `${JUNGLE_SHORT[c as JunglePosition]} — ${i.n}`).join(' · ')}
          className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border ${varies ? 'border-dashed' : ''} ${st.bg} ${st.text} ${st.border}`}>
          <Glyph name="jungle" />
          {JUNGLE_TINY[camp as JunglePosition]}
          {anyChicken && <span className="not-italic leading-none">{CHICKEN_ICON}</span>}
        </span>
      );
    }
    if (bossTimes.length) {
      const bs = SUBROLE_STYLES[SubRole.BOSS];
      items.push(
        <span key="boss" className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border ${bs.bg} ${bs.text} ${bs.border}`}>
          {/* Слово «Босс» несёт иконка дракона — дублировать его текстом значит
              отнимать место у имени бойца в той же строке. */}
          <Glyph name="boss" />
          {bossTimes.join('·')}′
          {bossChicken && <span className="not-italic leading-none">{CHICKEN_ICON}</span>}
        </span>
      );
    }
    if (getSubRoles(a).includes(SubRole.TOWER)) {
      const ts = SUBROLE_STYLES[SubRole.TOWER];
      items.push(
        <span key="tower" className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border ${ts.bg} ${ts.text} ${ts.border}`}>
          <Glyph name={SUBROLE_ICONS[SubRole.TOWER]} />{SUBROLE_LABELS[SubRole.TOWER]}
        </span>
      );
    }
    return items.length ? items : undefined;
  };
  // ---- Панель группы (доска) ----
  const renderGroupPanel = (side: Side, group: GroupNumber, isOver: boolean) => {
    const lane = getGroupLane(side, group);
    const tower = getTowerInfo(side, lane);
    const members = playersIn(side, group);
    const styles = SIDE_STYLES[side];
    const isTarget = selectedSide === side && selectedGroup === group;
    const over = members.length > PLAYERS_PER_GROUP;
    const groupAllSelected = members.length > 0 && members.every(m => selectedIds.has(m.player.id));
    const dropHint = isOver && !isViewer && activeDrag != null;

    return (
      <div
        className={`rounded-lg border bg-slate-900 overflow-hidden transition-colors duration-200
          ${dropHint
            ? 'border-amber-500 ring-2 ring-amber-500/60 bg-amber-950/20'
            : activeDrag && !isViewer
              ? 'border-dashed border-slate-600'
              : isTarget && !isViewer
                ? `${styles.border} ring-1 ring-inset ${side === Side.ATTACK ? 'ring-red-600/40' : 'ring-sky-600/40'}`
                : 'border-slate-800'}`}
      >
        {/* Заголовок группы */}
        <div className="p-3 border-b border-slate-800 bg-slate-950 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {!isViewer && <GroupGrip side={side} group={group} />}
          <button
            onClick={() => {
              if (isViewer) return;
              setSelectedSide(side); setSelectedGroup(group); // цель для добавления из пула
              selectGroup(side, group);                       // и выделяем всю группу для правки
            }}
            className="flex items-center gap-2 group/g text-left min-w-0"
            title={isViewer ? undefined : t('Цель для добавления из пула + выделить всю группу')}
          >
            <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold border ${groupAllSelected ? 'bg-amber-500 text-slate-950 border-amber-400' : `${styles.bg} ${styles.text} ${styles.border}`}`}>
              {groupAllSelected ? <i className="fa-solid fa-check"></i> : group}
            </span>
            <div className="leading-none">
              <span className="text-xs font-semibold text-slate-200">{t('Группа')} {group}</span>
              <span className={`block text-[11px] font-semibold mt-1 ${over ? 'text-amber-400' : 'text-slate-500'}`}>
                {members.length} / {PLAYERS_PER_GROUP}
              </span>
            </div>
          </button>
          </div>

          {/* Выбор линии */}
          <div className="flex items-center gap-1.5">
            <span className={LANE_COLORS[lane]}>{LANE_ICONS[lane]}</span>
            <select
              disabled={isViewer}
              value={lane}
              onChange={e => setGroupLane(side, group, e.target.value as Lane)}
              className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 px-1.5 py-1 outline-none focus:border-amber-700 disabled:opacity-60"
            >
              {LANES.map(l => <option key={l} value={l}>{LANE_LABELS[l]}</option>)}
              <option value={Lane.UNASSIGNED}>{LANE_LABELS[Lane.UNASSIGNED]}</option>
            </select>
          </div>
        </div>

        {/* Башня */}
        {tower && (
          <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] border-b border-slate-800
            bg-slate-950 text-slate-400">
            <i className={`fa-solid ${tower.icon} ${tower.owner === 'enemy' ? 'text-red-500/80' : 'text-sky-500/80'}`}></i>
            {tower.label}
          </div>
        )}

        {/* Слоты игроков */}
        <div className="p-2.5 space-y-2 min-h-[80px]">
          {members.length === 0 && !dropHint ? (
            <button
              onClick={() => { if (!isViewer) { setSelectedSide(side); setSelectedGroup(group); } }}
              disabled={isViewer}
              className="w-full py-5 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg hover:text-slate-400 hover:border-slate-700 transition-colors disabled:cursor-default"
            >
              <i className="fa-solid fa-plus mr-1.5 opacity-50"></i>
              {t('Пусто')}
            </button>
          ) : (
            members.map(({ player, assignment }) => {
              const sel = selectedIds.has(player.id);
              return (
                <DraggablePlayerCard
                  key={player.id}
                  id={player.id}
                  data={{ type: 'player', playerId: player.id, player }}
                  disabled={isViewer}
                  onClick={(e) => onCardClick(e, player.id)}
                  title={[fillHint(player.id), isViewer ? '' : t('Клик — выбрать (Ctrl — несколько) · перетащите в группу или в список слева')]
                    .filter(Boolean).join('\n') || undefined}
                  wrapperClass={`relative group/m ${isViewer ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <PlayerCard
                    player={player}
                    compact
                    extra={renderBadges(assignment)}
                    isMe={player.id === claimedPlayerId}
                    className={`transition-colors ${sel ? 'border-amber-500 ring-2 ring-amber-400/70' : 'group-hover/m:border-amber-600/40'}`}
                  />
                </DraggablePlayerCard>
              );
            })
          )}
          {/* Линия-вставка «сюда» при наведении перетаскиваемой карточки */}
          {dropHint && (
            <div className="flex items-center gap-2 px-1 py-0.5">
              <span className="h-0.5 flex-1 bg-amber-500 rounded-full"></span>
              <span className="text-[11px] text-amber-400">{t('сюда')}</span>
              <span className="h-0.5 flex-1 bg-amber-500 rounded-full"></span>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ---- Пара кнопок одной выгрузки: скачать + положить в буфер ----
  //
  // Приказ уезжает ДВУМЯ картинками — состав и тайминги, — и у каждой оба способа отправки
  // равноправны: одну прикладывают файлом, вторую вставляют в канал из буфера. Поэтому в
  // шапке четыре кнопки, а не одна с выпадающим списком: список прячет за лишний клик
  // ровно то действие, ради которого сюда и пришли.
  const renderExportPair = (side: Side, variant: ExportVariant) => {
    const busy = exporting === exportKey(side, variant);
    const label = variant === 'roster' ? t('Состав') : t('Тайминги');
    // Плана нет — снимать нечего: получилась бы картинка из одной пустой сетки.
    const empty = variant === 'timings' && countTasks(plan, assignments, side) === 0;
    const why = t('План таймингов пуст');
    return (
      <span className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
        <button
          onClick={() => exportSide(side, variant, 'download')}
          disabled={busy || empty}
          title={empty ? why : `${t('Скачать картинку')}: ${SIDE_LABELS[side]} · ${label}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40 disabled:hover:text-slate-400"
        >
          <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-download'}`}></i>
          {label}
        </button>
        <button
          onClick={() => exportSide(side, variant, 'copy')}
          disabled={busy || empty}
          title={empty ? why : `${t('Скопировать картинку')}: ${SIDE_LABELS[side]} · ${label}`}
          className="inline-flex items-center justify-center w-8 h-8 border-l border-slate-800 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40 disabled:hover:text-slate-400"
        >
          <i className="fa-solid fa-copy text-xs"></i>
        </button>
      </span>
    );
  };

  // ---- Колонка стороны (доска) ----
  const renderSideColumn = (side: Side) => {
    const styles = SIDE_STYLES[side];
    const count = sideCount(side);
    // Характер стороны читается по сплошной заливке квадратика с иконкой и цвету
    // заголовка; сама шапка — обычная поверхность карточки.
    return (
      <div key={side} className="flex flex-col gap-3">
        <div className="relative overflow-hidden flex items-center justify-between px-4 py-3 rounded-lg bg-slate-900 border border-slate-800">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${styles.accent} text-white`}>
              <i className={`fa-solid ${SIDE_ICONS[side]}`}></i>
            </div>
            <h3 className={`cinzel text-lg font-semibold ${styles.text}`}>{SIDE_LABELS[side]}</h3>
          </div>
          <div className="flex items-center gap-2">
            {renderExportPair(side, 'roster')}
            {renderExportPair(side, 'timings')}
            <span className={`text-sm font-semibold ml-1 ${count === PLAYERS_PER_SIDE ? 'text-emerald-400' : count > PLAYERS_PER_SIDE ? 'text-amber-400' : 'text-slate-300'}`}>
              {count} / {PLAYERS_PER_SIDE}
            </span>
          </div>
        </div>
        {/* Три группы стороны — горизонтально */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          {GROUP_NUMBERS.map(g => (
            <DroppableZone key={g} id={`g:${side}:${g}`} data={{ type: 'group', side, group: g }} disabled={isViewer}>
              {(isOver) => renderGroupPanel(side, g, isOver)}
            </DroppableZone>
          ))}
        </div>
      </div>
    );
  };

  // ---- Строки таблицы (сетка) ----
  const gridRows = useMemo(() => {
    const sideOrder: Record<Side, number> = { [Side.ATTACK]: 0, [Side.DEFENSE]: 1 };
    return [...validAssignments]
      .map(a => ({ a, p: playerById(a.playerId)! }))
      .filter(r => r.p)
      .sort((x, y) =>
        sideOrder[x.a.side] - sideOrder[y.a.side] ||
        x.a.group - y.a.group ||
        x.p.name.localeCompare(y.p.name)
      );
  }, [validAssignments, players]);

  // ---- Боковой список для вкладки таймингов ----
  // Состав выбранной стороны, разложенный по пачкам. Рядом с номером пачки — ручка:
  // потянув её, в клетку попадает ССЫЛКА на группу целиком, а не пять фамилий. Именно
  // так офицер и пишет приказ («G1 + двое»), и именно поэтому переставленный между
  // группами боец уходит из леса сам.
  const renderTimingRoster = () => {
    const rows = GROUP_NUMBERS.map(g => ({ group: g, members: playersIn(timingSide, g) }));
    const styles = SIDE_STYLES[timingSide];
    return (
      <div className="w-full lg:w-80 flex flex-col gap-4">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col h-[calc(100vh-180px)]">
          <div className="mb-3">
            <h3 className="cinzel text-lg font-semibold flex justify-between items-center gap-2">
              <span className={styles.text}>{SIDE_LABELS[timingSide]}</span>
              <span className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded-lg font-sans">
                {sideCount(timingSide)}
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {isViewer ? t('Только наблюдение') : t('Тяните бойца или ручку группы в клетку справа')}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
            {rows.every(r => r.members.length === 0) ? (
              <div className="text-center py-12 text-slate-700">
                <i className="fa-solid fa-people-group text-3xl mb-3 opacity-20"></i>
                <p className="text-xs opacity-40">{t('Соберите состав на доске')}</p>
              </div>
            ) : rows.map(({ group, members }) => (
              <div key={group}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <GroupHandle side={timingSide} group={group} count={members.length} disabled={isViewer || members.length === 0} />
                  <span className="text-[11px] text-slate-500">{LANE_LABELS[getGroupLane(timingSide, group)]}</span>
                </div>
                <div className="space-y-2">
                  {members.length === 0 ? (
                    <p className="text-[11px] text-slate-700 px-1">{t('Пусто')}</p>
                  ) : members.map(({ player, assignment }) => (
                    <DraggablePlayerCard
                      key={player.id}
                      id={`troster:${player.id}`}
                      data={{ type: 'player', playerId: player.id, player }}
                      disabled={isViewer}
                      onClick={(e) => onCardClick(e, player.id)}
                      title={isViewer ? undefined : t('Перетащите в клетку таблицы')}
                      wrapperClass={`relative ${isViewer ? '' : 'cursor-grab active:cursor-grabbing group/m'}`}
                    >
                      <PlayerCard
                        player={player}
                        compact
                        extra={renderBadges(assignment)}
                        isMe={player.id === claimedPlayerId}
                        className={`transition-colors ${selectedIds.has(player.id) ? 'border-amber-500 ring-2 ring-amber-400/70' : 'group-hover/m:border-amber-600/40'}`}
                      />
                    </DraggablePlayerCard>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };
  // ---- ПРИПАРКОВАНО: вид «Сетка» ----
  //
  // Плоская таблица всего состава: боец, роль, сторона, группа, линия, башня, лес.
  // Из переключателя видов убрана — её место занял вид «Тайминги», а самой сеткой в
  // гильдии не пользовались. Код оставлен целиком и намеренно: вернуть — это добавить
  // 'grid' обратно в переключатель и вызвать renderGrid(), а не писать заново.
  // Столбец «Лес / Босс» она берёт из renderBadges, поэтому переезд на тайминги её
  // уже не касается: бейджи считаются из плана и здесь тоже.
  const renderGrid = () => (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden duration-300">
            {gridRows.length === 0 ? (
              <div className="py-24 text-center text-slate-700">
                <i className="fa-solid fa-table-cells-large text-6xl mb-5 opacity-10"></i>
                <p className="cinzel">{t('Состав ещё не собран')}</p>
                <p className="text-xs text-slate-600 mt-2">{t('Распределите бойцов на доске или из списка слева')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="bg-slate-950/60 text-[11px] text-slate-500">
                      <th className="px-4 py-3 font-semibold">{t('Боец')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Роль')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Сторона')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Группа')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Линия')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Башня')}</th>
                      <th className="px-3 py-3 font-semibold">{t('Лес / Босс')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gridRows.map(({ a, p }) => {
                      const lane = getGroupLane(a.side, a.group);
                      const tower = getTowerInfo(a.side, lane);
                      const st = SIDE_STYLES[a.side];
                      return (
                        <tr
                          key={p.id}
                          onClick={(e) => onCardClick(e, p.id)}
                          className={`border-t border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors ${selectedIds.has(p.id) ? 'bg-amber-950/30' : ''}`}
                        >
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0">
                                {ROLE_ICONS[p.role]}
                              </span>
                              <span className="font-semibold text-slate-100">{p.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-slate-300">{ROLE_LABELS[p.role]}</td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1.5 text-xs ${st.text}`}>
                              <i className={`fa-solid ${SIDE_ICONS[a.side]}`}></i>
                              {SIDE_LABELS[a.side]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-300 font-semibold">{t('Гр.')} {a.group}</td>
                          <td className="px-3 py-2.5">
                            <span className={`inline-flex items-center gap-1.5 font-semibold ${LANE_COLORS[lane]}`}>
                              {LANE_ICONS[lane]} {LANE_LABELS[lane]}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-slate-400 text-xs">
                            {tower ? (
                              <span className="inline-flex items-center gap-1.5">
                                <i className={`fa-solid ${tower.icon} ${tower.owner === 'enemy' ? 'text-red-500/80' : 'text-sky-500/80'}`}></i>
                                {tower.label}
                              </span>
                            ) : <span className="text-slate-700">—</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            {renderBadges(a)
                              ? <span className="inline-flex flex-wrap items-center gap-1">{renderBadges(a)}</span>
                              : <span className="text-slate-700">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
    <div className="flex flex-col lg:flex-row gap-6 h-full relative">

      {/* САЙДБАР. На доске это пул неназначенных, во вкладке таймингов — состав
          выбранной стороны: в клетку можно положить только того, кто уже стоит в
          составе этой стороны, поэтому показывать там неназначенных было бы враньём. */}
      {viewMode === 'timings' ? renderTimingRoster() : (
      <div className={`w-full lg:w-80 flex flex-col gap-4 ${isViewer ? 'opacity-60 cursor-not-allowed grayscale-[0.5]' : ''}`}>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col h-[calc(100vh-180px)]">
          <div className="mb-3">
            <h3 className="cinzel text-lg font-semibold text-amber-500 flex justify-between items-center">
              {t('Доступный состав')}
              <span className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded-lg font-sans">
                {unassignedPlayers.length}
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {isViewer ? t('Только наблюдение') : `${t('Перетащите в группу · клик →')} ${SIDE_LABELS[selectedSide]} ${t('Гр.')}${selectedGroup}`}
            </p>
          </div>

          {/* Выбор цели назначения */}
          {!isViewer && (
            <div className="mb-3 space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                {SIDES.map(s => {
                  const st = SIDE_STYLES[s];
                  const active = selectedSide === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setSelectedSide(s)}
                      className={`py-1.5 rounded-lg text-xs border transition-colors flex items-center justify-center gap-1.5
                        ${active ? `${st.accent} border-transparent text-white` : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'}`}
                    >
                      <i className={`fa-solid ${SIDE_ICONS[s]}`}></i>
                      {SIDE_LABELS[s]}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {GROUP_NUMBERS.map(g => (
                  <button
                    key={g}
                    onClick={() => setSelectedGroup(g)}
                    className={`py-1.5 rounded-lg text-xs border transition-colors
                      ${selectedGroup === g ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'}`}
                  >
                    {t('Гр.')} {g}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Поиск */}
          <div className="mb-2 relative">
            <i className="fa-solid fa-magnifying-glass text-slate-600 absolute left-2.5 top-1/2 -translate-y-1/2 text-xs"></i>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('Поиск...')}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs pl-7 pr-2 py-1.5 outline-none focus:border-amber-800"
            />
          </div>

          {/* Фильтр: только заявившиеся (если на событие есть заявки) */}
          {Object.values(signups).some(v => v === 'in' || v === 'maybe' || v === 'sub') && (
            <button
              onClick={() => setSignedUpOnly(v => !v)}
              className={`mb-2 w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold py-1.5 rounded-lg border transition-colors
                ${signedUpOnly ? 'bg-emerald-950/40 border-emerald-700/60 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'}`}
            >
              <i className={`fa-solid ${signedUpOnly ? 'fa-filter-circle-xmark' : 'fa-filter'}`}></i>{t('Только заявившиеся')}
            </button>
          )}

          <DroppableZone
            id="pool"
            data={{ type: 'pool' }}
            disabled={isViewer || !draggingAssigned}
            className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar rounded-lg transition-colors"
            activeClassName="ring-2 ring-inset ring-red-500/50 bg-red-950/10"
          >
            {() => (<>
            {draggingAssigned && (
              <div className="text-center py-2 text-[11px] font-semibold text-red-400/70 border border-dashed border-red-900/50 rounded-lg">
                <i className="fa-solid fa-user-minus mr-1.5"></i>{t('Отпустите здесь, чтобы снять')}
              </div>
            )}
            {filteredUnassigned.length === 0 ? (
              <div className="text-center py-12 text-slate-700">
                <i className="fa-solid fa-people-group text-3xl mb-3 opacity-20"></i>
                <p className="text-xs opacity-40">
                  {unassignedPlayers.length === 0 ? t('Все бойцы распределены') : t('Никого не найдено')}
                </p>
              </div>
            ) : (
              filteredUnassigned.map(p => {
                const st = signups[p.id];
                return (
                <DraggablePlayerCard
                  key={p.id}
                  id={p.id}
                  data={{ type: 'player', playerId: p.id, player: p }}
                  disabled={isViewer}
                  onClick={() => !isViewer && assignToTarget(p.id)}
                  title={isViewer ? undefined : t('Перетащите в группу или кликните')}
                  wrapperClass={`relative ${isViewer ? 'cursor-default' : 'cursor-grab active:cursor-grabbing group'}`}
                >
                  <PlayerCard
                    player={p}
                    compact
                    isMe={p.id === claimedPlayerId}
                    className={`${isViewer ? '' : 'group-hover:border-amber-600/50 group-hover:bg-slate-800/50 transition-colors'}`}
                  />
                  {st && (
                    <span title={SIGNUP_LABELS[st]}
                      className={`absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-slate-900 ${SIGNUP_STYLES[st].dot}`}></span>
                  )}
                </DraggablePlayerCard>
                );
              })
            )}
            </>)}
          </DroppableZone>

          {!isViewer && (
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              <button
                onClick={canUndo ? revertFill : autoAssign}
                disabled={filling || (!canUndo && (unassignedPlayers.length === 0 || validAssignments.length >= MAX_WAR_PLAYERS))}
                title={canUndo
                  ? t('Вернуть расстановку, которая была до автозаполнения')
                  : (activeSession.event
                    ? t('Расставить записавшихся по местам, где они обычно играют')
                    : t('Расставить состав по местам, где бойцы обычно играют'))}
                className="flex items-center justify-center gap-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-amber-700 text-slate-300 text-[11px] font-semibold py-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <i className={`fa-solid ${canUndo ? 'fa-rotate-left text-slate-400' : 'fa-wand-magic-sparkles text-amber-500'}`}></i>
                {canUndo ? t('Отменить') : t('Авто')}
              </button>
              <button
                onClick={clearAll}
                disabled={validAssignments.length === 0}
                title={t('Снять всех из состава войны')}
                className="flex items-center justify-center gap-1.5 bg-slate-950 hover:bg-red-950/40 border border-slate-800 hover:border-red-900/60 text-slate-300 hover:text-red-400 text-[11px] font-semibold py-2 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <i className="fa-solid fa-eraser"></i>
                {t('Очистить')}
              </button>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-slate-800 space-y-2">
            <div className="flex justify-between text-xs">
               <span className="text-slate-400 text-xs">{t('Боевой состав')}</span>
               <span className={validAssignments.length === MAX_WAR_PLAYERS ? 'text-emerald-400 font-semibold' : 'text-slate-200'}>
                  {validAssignments.length} / {MAX_WAR_PLAYERS}
               </span>
            </div>
            <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-900">
               <div
                className={`h-full transition-colors duration-200 ${validAssignments.length === MAX_WAR_PLAYERS ? 'bg-emerald-500' : 'bg-amber-600'}`}
                style={{ width: `${Math.min(100, (validAssignments.length / MAX_WAR_PLAYERS) * 100)}%` }}
               />
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ПАНЕЛЬ-ИНСПЕКТОР: настройки выделенного(ых) бойца(ов) — справа */}
      {selectedIds.size > 0 && (
        <div className="w-full lg:w-80 shrink-0 lg:order-last self-start bg-slate-900 border border-amber-500/30 rounded-2xl overflow-hidden max-h-[calc(100vh-160px)] overflow-y-auto custom-scrollbar animate-in fade-in slide-in-from-right-2 duration-200">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
            <div className="min-w-0">
              <h3 className="cinzel text-amber-500 text-base truncate">
                {single ? single.name : `${t('Выбрано:')} ${selectedIds.size}`}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {single && singleA ? `${SIDE_LABELS[singleA.side]} · ${t('Гр.')}${singleA.group}` : (isViewer ? t('Данные') : t('Настройки бойцов'))}
              </p>
            </div>
            <button onClick={clearSelection} title={t('Снять выделение')} className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:text-white hover:bg-slate-800 transition-colors shrink-0">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div className="p-4 space-y-5">
            {/* Роль */}
            {!isViewer && (
              <div>
                <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-shield-halved text-amber-500/50"></i>{t('Роль')}</label>
                <div className="grid grid-cols-3 gap-2">
                  {[Role.TANK, Role.DPS, Role.HEALER].map(r => {
                    const active = selectedPlayers.length > 0 && selectedPlayers.every(p => p.role === r);
                    return (
                      <button key={r} onClick={() => setRoleSel(r)}
                        className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors ${active ? 'bg-amber-600 border-amber-500 text-white shadow' : 'bg-slate-900 border-slate-800 text-slate-400 hover:bg-slate-800'}`}>
                        {ROLE_LABELS[r]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Школы оружия (когда выделен ровно один боец) */}
            {single && !isViewer && (
              <div>
                <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-khanda text-amber-500/50"></i>{t('Школы оружия')}</label>
                {[0, 1].map(slot => (
                  <div key={slot} className="mb-1.5 last:mb-0">
                    <div className="grid grid-cols-8 gap-1">
                      {WEAPON_SCHOOLS.map(w => {
                        const active = single.weapons?.[slot] === w;
                        return (
                          <button key={w} type="button" onClick={() => setWeaponSel(slot as 0 | 1, w)} title={WEAPON_SCHOOL_LABELS[w]}
                            className={`aspect-square rounded-lg border flex items-center justify-center p-0.5 transition-colors ${active ? 'border-amber-500 ring-2 ring-amber-500/40 bg-amber-950/20' : 'border-slate-800 bg-slate-950 hover:border-slate-600'}`}>
                            <img src={WEAPON_SCHOOL_IMAGES[w]} alt={WEAPON_SCHOOL_LABELS[w]} className="w-full h-full object-contain" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Сторона */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-flag text-amber-500/50"></i>{t('Сторона')}</label>
              <div className="grid grid-cols-2 gap-2">
                {SIDES.map(s => {
                  const st = SIDE_STYLES[s];
                  const active = selectedAssignments.length > 0 && selectedAssignments.every(a => a.side === s);
                  return (
                    <button key={s} disabled={isViewer} onClick={() => moveSel(s, singleA ? singleA.group : selectedGroup)}
                      className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2
                        ${active ? `${st.accent} border-transparent text-white shadow-lg` : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:border-slate-600'}`}`}>
                      <i className={`fa-solid ${SIDE_ICONS[s]}`}></i>{SIDE_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Группа */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-users text-amber-500/50"></i>{t('Группа')}</label>
              <div className="grid grid-cols-3 gap-2">
                {GROUP_NUMBERS.map(g => {
                  const active = selectedAssignments.length > 0 && selectedAssignments.every(a => a.group === g);
                  return (
                    <button key={g} disabled={isViewer} onClick={() => moveSel(singleA ? singleA.side : selectedSide, g)}
                      className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors
                        ${active ? 'bg-amber-600 border-amber-500 text-white shadow-lg' : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      {t('Гр.')} {g}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Доп-роли. Осталась одна — Тавер: она про весь бой (боец спавнится на
                башне), а лес, босс и курица зависят от момента и живут в таймингах. */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-star text-amber-500/50"></i>{t('Доп-роли')}</label>
              <div className="grid grid-cols-3 gap-2">
                {[SubRole.TOWER].map(sr => {
                  const st = SUBROLE_STYLES[sr];
                  const state = subRoleState(sr);
                  return (
                    <button key={sr} disabled={isViewer} onClick={() => toggleSubRoleSel(sr)}
                      className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-1.5
                        ${state === 'all' ? `${st.solid} border-transparent text-white shadow` : state === 'some' ? `${st.bg} ${st.border} ${st.text} border-dashed` : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      <Glyph name={SUBROLE_ICONS[sr]} />{SUBROLE_LABELS[sr]}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Лагерь в лесу. Кнопка — быстрый путь, а не второе хранилище: она пишет
                в те же тайминги, что и таблица. Пунктир значит «стоит не везде», и
                подпись под кнопками говорит, где именно. */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2">
                <Glyph name="jungle" className="w-[1.05em] h-[1.05em] text-emerald-500/50" />{t('Лагерь в лесу')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {JUNGLE_POSITIONS.map(jp => {
                  const stat = campStat(jp);
                  return (
                    <button key={jp} disabled={isViewer}
                      onClick={() => stat.state === 'all' ? clearCamp(jp) : setCampPick(jp)}
                      title={stat.state === 'all' ? t('Нажмите, чтобы снять со всех таймингов') : t('Спросим, на каких таймингах')}
                      className={`py-2 px-2 rounded-lg text-[11px] font-semibold border transition-colors
                        ${stat.state === 'all'
                          ? 'bg-emerald-800/40 border-emerald-500 text-emerald-300 shadow'
                          : stat.state === 'some'
                            ? 'bg-emerald-950/40 border-emerald-700/70 border-dashed text-emerald-400'
                            : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      {JUNGLE_LABELS[jp]}
                      {stat.state === 'some' && <span className="block tnum opacity-70 mt-0.5">{stat.hit}/{stat.total}</span>}
                    </button>
                  );
                })}
              </div>
              {campSummary && <p className="text-[11px] text-slate-500 mt-2">{campSummary}</p>}
            </div>

            {/* Босс. Модалки тут нет: 25-я и 15-я — это и есть тайминги, уточнять нечего. */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><Glyph name="boss" className="w-[1.05em] h-[1.05em] text-fuchsia-500/50" />{t('Какой босс')}</label>
              <div className="grid grid-cols-2 gap-2">
                {(BOSS_TIMINGS as string[]).map(tm => {
                  const stat = bossStat(tm);
                  return (
                    <button key={tm} disabled={isViewer} onClick={() => toggleBossSel(tm)}
                      className={`py-2 px-2 rounded-lg text-[11px] font-semibold border transition-colors
                        ${stat.state === 'all'
                          ? 'bg-fuchsia-800/40 border-fuchsia-500 text-fuchsia-300 shadow'
                          : stat.state === 'some'
                            ? 'bg-fuchsia-950/40 border-fuchsia-700/70 border-dashed text-fuchsia-400'
                            : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      {tm}{t('-я минута')}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Курица. Их две, потому что курица привязана к задаче, а не к человеку:
                боец может идти в лес без курицы и в тот же тайминг на босса с ней. */}
            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2">
                <span className="not-italic leading-none">{CHICKEN_ICON}</span>{t('Курица')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([['jungle', t('В лесу')], ['boss', t('На боссе')]] as const).map(([where, label]) => {
                  const stat = chickenStat(where);
                  const none = stat.total === 0; // нет самой задачи — курице не на что вешаться
                  return (
                    <button key={where} disabled={isViewer || none} onClick={() => toggleChickenSel(where)}
                      title={none ? t('Сначала поставьте задачу — лагерь или босса') : undefined}
                      className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-1.5
                        ${stat.state === 'all'
                          ? `${CHICKEN_STYLE.solid} border-transparent text-white shadow`
                          : stat.state === 'some'
                            ? `${CHICKEN_STYLE.bg} ${CHICKEN_STYLE.border} ${CHICKEN_STYLE.text} border-dashed`
                            : `bg-slate-900 border-slate-800 text-slate-400 ${(isViewer || none) ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      <span className="not-italic leading-none">{CHICKEN_ICON}</span>{label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-bullhorn text-amber-500/50"></i>{t('Коллы')}</label>
              <div className="grid grid-cols-2 gap-2">
                {CALL_ROLES.map(cr => {
                  const st = CALL_ROLE_STYLES[cr];
                  const state = callState(cr);
                  return (
                    <button key={cr} disabled={isViewer} onClick={() => toggleCallSel(cr)}
                      className={`py-2.5 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-2
                        ${state === 'all' ? `${st.bg} ${st.border} ${st.text}` : state === 'some' ? `${st.bg} ${st.border} ${st.text} border-dashed opacity-80` : `bg-slate-900 border-slate-800 text-slate-400 ${isViewer ? 'opacity-40' : 'hover:bg-slate-800'}`}`}>
                      <i className={`fa-solid ${CALL_ROLE_ICONS[cr]}`}></i>{CALL_ROLE_LABELS[cr]}
                    </button>
                  );
                })}
              </div>
            </div>

            {!isViewer && (
              <div className="pt-3 border-t border-slate-800">
                <button onClick={removeSel}
                  className="w-full py-2.5 rounded-lg border border-red-900/30 text-red-500 hover:bg-red-950/50 transition-colors text-xs font-semibold">
                  <i className="fa-solid fa-user-minus mr-2"></i>{t('Снять из состава')}{selectedIds.size > 1 ? ` (${selectedIds.size})` : ''}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ОСНОВНАЯ ОБЛАСТЬ */}
      <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-y-auto px-2 custom-scrollbar">
        {/* Статистика.
            Раньше это был шаблонный «ряд KPI»: цветная полоса в 4px слева, капсовая
            подпись и крупное число — то есть громче всего кричала полоса, а не цифра.
            Теперь цвет роли ушёл в точку рядом с подписью, а самым заметным в плитке
            стало значение, за которым сюда и смотрят. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col gap-1">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden></span>{t('Танки')}
            </span>
            <span className="text-2xl font-semibold text-slate-200 tnum">{roleCount(Role.TANK)}</span>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col gap-1">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400" aria-hidden></span>{t('ДД')}
            </span>
            <span className="text-2xl font-semibold text-slate-200 tnum">{roleCount(Role.DPS)}</span>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col gap-1">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden></span>{t('Хилы')}
            </span>
            <span className="text-2xl font-semibold text-slate-200 tnum">{roleCount(Role.HEALER)}</span>
          </div>
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg flex flex-col gap-1">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400" aria-hidden></span>{t('Лес/Босс/Тавер')}
            </span>
            <span className="text-2xl font-semibold text-slate-200 tnum">{jungleHeads} / {bossHeads} / {validAssignments.filter(a => getSubRoles(a).includes(SubRole.TOWER)).length}</span>
          </div>
        </div>

        {/* Подсказка по выделению */}
        {!isViewer && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <i className="fa-solid fa-arrow-pointer text-amber-500/60"></i>
            {t('Клик по бойцу — настроить справа. Ctrl/Shift+клик — несколько. Клик по номеру группы — вся группа.')}
            {selectedIds.size > 0 && (
              <button onClick={clearSelection} className="ml-1 text-amber-400 hover:text-amber-300">
                {t('Снять выделение')} ({selectedIds.size})
              </button>
            )}
          </div>
        )}

        {viewMode === 'board' ? (
          <div className="flex flex-col gap-6">
            {SIDES.map(s => renderSideColumn(s))}
          </div>
        ) : viewMode === 'timings' ? (
          <TimingsBoard
            players={players}
            assignments={validAssignments}
            plan={plan}
            side={timingSide}
            onSide={setTimingSide}
            isViewer={isViewer}
            claimedPlayerId={claimedPlayerId}
            dragging={!!activeDrag}
            groupLanes={activeSession.groupLanes || {}}
            selectedIds={selectedIds}
            onSelect={(id, e) => onCardClick(e, id)}
            ops={planOps}
          />
        ) : null}
      </div>

      {/* Переключатель вида — вертикально, в самом правом краю (правее групп) */}
      <div className="flex flex-row lg:flex-col gap-2 shrink-0">
        {(['board', 'timings'] as const).map(m => {
          const active = viewMode === m;
          const icon = m === 'board' ? 'fa-chess-board' : 'fa-stopwatch';
          const label = m === 'board' ? t('Доска') : t('Тайминги');
          const activeCls = m === 'board'
            ? 'bg-amber-600/10 border-amber-500/40 text-amber-500'
            : 'bg-indigo-600/10 border-indigo-500/40 text-indigo-400';
          return (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border px-3 py-3 lg:w-20 transition-colors font-semibold text-[11px]
                ${active ? activeCls : 'bg-slate-900/50 border-slate-800 text-slate-500 hover:text-slate-300'}`}
            >
              <i className={`fa-solid ${icon} text-lg`}></i>
              {label}
            </button>
          );
        })}
      </div>

    </div>

    {/* Свой парящий «призрак»: position:fixed в портале на body — его ничего не обрезает.
        Следует за курсором (window pointermove), не перехватывает события (pointer-events:none). */}
    {activeDrag && dragPoint && createPortal(
      <div
        style={{
          position: 'fixed',
          left: dragPoint.x,
          top: dragPoint.y,
          transform: 'translate(-50%, -50%) rotate(-4deg)',
          zIndex: 99999,
          pointerEvents: 'none',
          width: activeDrag.type === 'player' ? 240 : undefined,
          // Нет цели — призрак гаснет: отпускание здесь ничего не сделает, и видно это
          // ДО того, как палец отпущен, а не после.
          opacity: overTarget ? 1 : 0.45,
          transition: 'opacity 120ms ease-out'
        }}
      >
        {activeDrag.type === 'player' ? (
          (() => {
            const count = selectedIds.has(activeDrag.playerId) && selectedIds.size > 1 ? selectedIds.size : 1;
            return (
              <div className="relative">
                {/* Стопка-силуэт сзади, когда тащим несколько */}
                {count > 1 && (
                  <>
                    <div className="absolute inset-0 rounded-lg bg-slate-900 border border-amber-500/40 -translate-x-2 translate-y-2 -rotate-3"></div>
                    <div className="absolute inset-0 rounded-lg bg-slate-900 border border-amber-500/50 -translate-x-1 translate-y-1 -rotate-1"></div>
                  </>
                )}
                <PlayerCard
                  player={activeDrag.player}
                  compact
                  isMe={activeDrag.player.id === claimedPlayerId}
                  className="relative border-amber-500 ring-2 ring-amber-400/70 bg-slate-900 shadow-lg"
                />
                {count > 1 && (
                  <span className="absolute -top-2 -right-2 min-w-6 h-6 px-1.5 rounded-full bg-amber-500 text-slate-950 text-xs font-semibold flex items-center justify-center shadow-lg ring-2 ring-slate-950">
                    {count}
                  </span>
                )}
              </div>
            );
          })()
        ) : (
          <div className="inline-block px-3 py-2 rounded-lg bg-amber-600 text-white text-xs font-semibold shadow-lg">
            <i className="fa-solid fa-grip-vertical mr-2"></i>{SIDE_LABELS[activeDrag.side]} · {t('Гр.')}{activeDrag.group}
          </div>
        )}
        {/* Подпись появляется только на промахе: это ответ на «я передумал, а он всё
            равно куда-то влепится» — теперь видно, что отпускание здесь безопасно. */}
        {!overTarget && (
          <div className="mt-2 text-center">
            <span className="inline-block px-2 py-0.5 rounded-md bg-slate-950/90 border border-slate-800 text-[11px] text-slate-400">
              {t('отпустить — отменить')}
            </span>
          </div>
        )}
      </div>,
      document.body
    )}

    {/* «Укажите тайминги» — открывается кликом по лагерю в карточке бойца. Работает и
        на пачке: выделив семерых, офицер отвечает на вопрос один раз, а не семь. */}
    {campPick && createPortal(
      <TimingPickModal
        title={JUNGLE_LABELS[campPick as JunglePosition]}
        hint={campSummary || undefined}
        onApply={(timings) => { applyCamp(campPick, timings); setCampPick(null); }}
        onClose={() => setCampPick(null)}
      />,
      document.body
    )}

    {/* Предпросмотр картинки (когда буфер недоступен, напр. сайт по HTTP) — ПКМ → копировать */}
    {previewUrl && createPortal(
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setPreviewUrl(null)}>
        <div className="bg-slate-900 border border-amber-500/30 rounded-2xl shadow-lg max-w-[92vw] max-h-[92vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-4 p-3 border-b border-slate-800/60">
            <p className="text-xs text-amber-400 flex items-center gap-2 min-w-0">
              <i className="fa-solid fa-arrow-pointer shrink-0"></i>
              <span className="truncate">{t('ПКМ по картинке → «Копировать изображение», затем Ctrl+V в Discord')}</span>
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={previewUrl}
                download={`wwm_${new Date().toISOString().slice(0, 10)}.png`}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-2 rounded-lg border border-amber-600/50 bg-amber-600/10 text-amber-400 hover:bg-amber-600/20 transition-colors"
              >
                <i className="fa-solid fa-download"></i>{t('Скачать')}
              </a>
              <button onClick={() => setPreviewUrl(null)} className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" title={t('Закрыть')}>
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>
          <div className="overflow-auto p-3 custom-scrollbar">
            <img src={previewUrl} alt="" className="max-w-full h-auto rounded-lg block" />
          </div>
        </div>
      </div>,
      document.body
    )}

    {/* Скрытые офскрин-макеты для экспорта в картинку (снимаются html-to-image).
        Четыре штуки: две стороны × два вида приказа. Рисуются заранее и всегда, чтобы
        клик по кнопке не ждал ни монтирования, ни загрузки шрифтов. */}
    <div style={{ position: 'fixed', left: -99999, top: 0, zIndex: -1 }} aria-hidden>
      {SIDES.map(side => (['roster', 'timings'] as const).map(variant => (
        <BattleOrderExport
          key={exportKey(side, variant)}
          ref={node => { exportRefs.current[exportKey(side, variant)] = node; }}
          side={side}
          variant={variant}
          session={activeSession}
          players={players}
        />
      )))}
    </div>
    </DndContext>
  );
};

// ---- dnd-kit обёртки ----

// Перетаскиваемая карточка бойца. Клик не превращается в драг (см. сенсоры),
// поэтому onClick (открыть модалку / отметить в балк-выборе) продолжает работать.
const DraggablePlayerCard: React.FC<{
  id: string;
  data: Record<string, unknown>;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  wrapperClass?: string;
  children: React.ReactNode;
}> = ({ id, data, disabled, onClick, title, wrapperClass = '', children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data, disabled });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={title}
      className={`${wrapperClass} ${isDragging ? 'opacity-40' : ''}`}
    >
      {children}
    </div>
  );
};

// Ручка-грип в шапке группы — перетаскивание группы целиком (поменять группы местами)
const GroupGrip: React.FC<{ side: Side; group: GroupNumber }> = ({ side, group }) => {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `grip:${side}:${group}`,
    data: { type: 'group', side, group }
  });
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title={t('Перетащите, чтобы поменять группы местами')}
      className={`cursor-grab active:cursor-grabbing text-slate-600 hover:text-amber-400 px-0.5 shrink-0 ${isDragging ? 'opacity-40' : ''}`}
    >
      <i className="fa-solid fa-grip-vertical"></i>
    </span>
  );
};

// Зона приёма (группа / список). Отдаёт детям флаг наведения для подсветки.
const DroppableZone: React.FC<{
  id: string;
  data: Record<string, unknown>;
  disabled?: boolean;
  className?: string;
  activeClassName?: string;
  children: (isOver: boolean) => React.ReactNode;
}> = ({ id, data, disabled, className = '', activeClassName = '', children }) => {
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled });
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? activeClassName : ''}`}>
      {children(isOver)}
    </div>
  );
};

export default WarPlanner;
