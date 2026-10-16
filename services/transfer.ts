import { Player, GuildWarSession, MapTemplate } from '../types';

// Выборочный экспорт/импорт. Здесь только чистая логика (разбор файла, слияние
// состояний) — без React и без обращений к localStorage. Интерфейс живёт в
// components/TransferPanel.tsx, применение к состоянию — в App.tsx.

export const BACKUP_VERSION = '2.1';

export interface GuildState {
  players: Player[];
  sessions: GuildWarSession[];
  mapTemplates: MapTemplate[];
}

// Что именно офицер положил в файл. Нужно, чтобы импорт отличал «событий не было»
// от «события не выгружали» — в обоих случаях массив пустой.
export interface BackupContents {
  players: boolean;
  events: boolean;
  templates: boolean;
  maps: boolean;
}

export interface BackupFile {
  version: string;
  exportedAt: string;
  contents: BackupContents;
  players: Player[];
  sessions: GuildWarSession[];
  mapTemplates: MapTemplate[];
}

// В данных события и шаблоны составов лежат в одном массиве sessions; отличаются
// наличием метаданных event. Разделение есть только в интерфейсе.
export const isEvent = (s: GuildWarSession): boolean => !!s.event;
export const eventsOf = (sessions: GuildWarSession[]) => sessions.filter(isEvent);
export const templatesOf = (sessions: GuildWarSession[]) => sessions.filter(s => !isEvent(s));

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const normName = (s: string) => (s || '').trim().toLowerCase();

// Все playerId, на которые ссылаются выбранные составы и стратегии карты.
// Токены на карте лежат в positions по playerId, заявки — в signups.
export const referencedPlayerIds = (
  sessions: GuildWarSession[],
  maps: MapTemplate[]
): Set<string> => {
  const ids = new Set<string>();
  for (const s of sessions) {
    for (const a of s.assignments || []) if (a.playerId) ids.add(a.playerId);
    for (const pid of Object.keys(s.signups || {})) ids.add(pid);
  }
  for (const m of maps) for (const pid of Object.keys(m.positions || {})) ids.add(pid);
  return ids;
};

// ---------------------------------------------------------------- экспорт ----

export interface ExportSelection {
  players: boolean;
  sessionIds: string[]; // события И шаблоны — в данных это один массив
  mapIds: string[];
}

export const buildBackup = (state: GuildState, sel: ExportSelection): BackupFile => {
  const sessionSet = new Set(sel.sessionIds);
  const mapSet = new Set(sel.mapIds);
  const sessions = state.sessions.filter(s => sessionSet.has(s.id));
  const mapTemplates = state.mapTemplates.filter(m => mapSet.has(m.id));
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    contents: {
      players: sel.players,
      events: sessions.some(isEvent),
      templates: sessions.some(s => !isEvent(s)),
      maps: mapTemplates.length > 0
    },
    players: sel.players ? state.players : [],
    sessions,
    mapTemplates
  };
};

export const downloadBackup = (file: BackupFile, filename: string) => {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const backupFilename = (prefix = 'WindsMeet_GuildBackup') =>
  `${prefix}_${new Date().toISOString().split('T')[0]}.json`;

// ----------------------------------------------------------------- чтение ----

// Старые бэкапы (v1) хранили карту ВНУТРИ каждой сессии. Собираем стратегии по одной
// на каждую сессию, где что-то нарисовано, чтобы ничего не потерять.
const mapsFromLegacySessions = (sessions: any[]): MapTemplate[] => {
  const maps: MapTemplate[] = [];
  for (const s of sessions || []) {
    const drawings = Array.isArray(s?.mapDrawings) ? s.mapDrawings : [];
    const objectives = Array.isArray(s?.mapObjectives) ? s.mapObjectives : [];
    const texts = Array.isArray(s?.mapTexts) ? s.mapTexts : [];
    const positions = (s?.mapPositions && typeof s.mapPositions === 'object') ? s.mapPositions : {};
    if (drawings.length || objectives.length || texts.length || Object.keys(positions).length) {
      maps.push({ id: `map-${s.id}`, name: s.name || 'Карта', objectives, drawings, texts, positions });
    }
  }
  return maps;
};

// Понимает три формата: v2.1 (с contents), v2.0 (mapTemplates без contents) и v1
// (карта внутри сессий). Для старых считаем, что выгружали всё.
export const parseBackup = (raw: any): BackupFile | null => {
  if (!raw || !Array.isArray(raw.players) || !Array.isArray(raw.sessions)) return null;

  let mapTemplates: MapTemplate[];
  if (Array.isArray(raw.mapTemplates) && raw.mapTemplates.length) {
    mapTemplates = raw.mapTemplates;
  } else {
    mapTemplates = mapsFromLegacySessions(raw.sessions);
  }

  const c = raw.contents;
  const contents: BackupContents = (c && typeof c === 'object')
    ? {
        players: !!c.players,
        events: !!c.events,
        templates: !!c.templates,
        maps: !!c.maps
      }
    : {
        // старый формат — полный бэкап целиком
        players: true,
        events: true,
        templates: true,
        maps: true
      };

  return {
    version: typeof raw.version === 'string' ? raw.version : '1.0',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    contents,
    players: raw.players,
    sessions: raw.sessions,
    mapTemplates
  };
};

export const readBackupFile = async (file: File): Promise<BackupFile | null> =>
  new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        resolve(parseBackup(JSON.parse(e.target?.result as string)));
      } catch (err) {
        console.error('Failed to parse import file', err);
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });

// ----------------------------------------------------------------- импорт ----

// Что делать с одним элементом файла. Для новых — add/skip, для совпавших по id —
// skip/overwrite/copy.
export type ItemAction = 'add' | 'skip' | 'overwrite' | 'copy';
// Игроки идут целиком: заменить совпавших / добавить новых / не трогать.
export type PlayerMode = 'replace' | 'add' | 'skip';

// Игрок из файла, которого нет по id, но чей ник совпал с уже существующим.
// Обычно это один и тот же человек, заведённый заново после выхода из гильдии.
export interface PlayerNameMatch {
  incoming: Player;
  existing: Player;
}

export interface ImportPlan {
  playerMode: PlayerMode;
  items: Record<string, ItemAction>; // id сессии/стратегии -> действие
  merges: Record<string, string>;    // playerId из файла -> playerId в приложении ('' = не сливать)
}

export interface ImportSummary {
  playersAdded: number;
  playersUpdated: number;
  playersMerged: number;
  sessionsAdded: number;
  sessionsUpdated: number;
  sessionsCopied: number;
  mapsAdded: number;
  mapsUpdated: number;
  mapsCopied: number;
  skipped: number;
}

export const emptySummary = (): ImportSummary => ({
  playersAdded: 0, playersUpdated: 0, playersMerged: 0,
  sessionsAdded: 0, sessionsUpdated: 0, sessionsCopied: 0,
  mapsAdded: 0, mapsUpdated: 0, mapsCopied: 0, skipped: 0
});

export const summaryTotal = (s: ImportSummary): number =>
  s.playersAdded + s.playersUpdated + s.playersMerged +
  s.sessionsAdded + s.sessionsUpdated + s.sessionsCopied +
  s.mapsAdded + s.mapsUpdated + s.mapsCopied;

// Совпадения по нику при разных id — то, о чём надо спросить офицера.
export const findNameMatches = (current: Player[], incoming: Player[]): PlayerNameMatch[] => {
  const currentIds = new Set(current.map(p => p.id));
  const byName = new Map<string, Player>();
  for (const p of current) byName.set(normName(p.name), p);

  const out: PlayerNameMatch[] = [];
  for (const p of incoming) {
    if (currentIds.has(p.id)) continue;      // и так одно и то же
    const existing = byName.get(normName(p.name));
    if (existing) out.push({ incoming: p, existing });
  }
  return out;
};

// Стартовое состояние окна импорта: новое — берём, совпавшее — пропускаем,
// одинаковые ники — сливаем.
export const defaultPlan = (current: GuildState, incoming: BackupFile): ImportPlan => {
  const sessionIds = new Set(current.sessions.map(s => s.id));
  const mapIds = new Set(current.mapTemplates.map(m => m.id));
  const items: Record<string, ItemAction> = {};
  for (const s of incoming.sessions) items[s.id] = sessionIds.has(s.id) ? 'skip' : 'add';
  for (const m of incoming.mapTemplates) items[m.id] = mapIds.has(m.id) ? 'skip' : 'add';

  const merges: Record<string, string> = {};
  for (const m of findNameMatches(current.players, incoming.players)) {
    merges[m.incoming.id] = m.existing.id;
  }

  return { playerMode: incoming.contents.players ? 'add' : 'skip', items, merges };
};

const remapSession = (s: GuildWarSession, idMap: Record<string, string>): GuildWarSession => {
  const next: GuildWarSession = {
    ...s,
    assignments: (s.assignments || []).map(a =>
      idMap[a.playerId] ? { ...a, playerId: idMap[a.playerId] } : a
    )
  };
  if (s.signups) {
    const signups: Record<string, any> = {};
    for (const [pid, status] of Object.entries(s.signups)) signups[idMap[pid] ?? pid] = status;
    next.signups = signups;
  }
  // Служебные данные заявок (источник/время) едут вместе с signups
  if (s.signupMeta) {
    const meta: Record<string, any> = {};
    for (const [pid, m] of Object.entries(s.signupMeta)) meta[idMap[pid] ?? pid] = m;
    next.signupMeta = meta;
  }
  return next;
};

const remapMap = (m: MapTemplate, idMap: Record<string, string>): MapTemplate => {
  const positions: MapTemplate['positions'] = {};
  for (const [pid, pos] of Object.entries(m.positions || {})) positions[idMap[pid] ?? pid] = pos;
  return { ...m, positions };
};

// Слияние файла с текущим состоянием по плану. Ничего не удаляет: «заменить» — это
// перезапись совпавших по id, всё остальное остаётся на месте.
export const applyImport = (
  current: GuildState,
  incoming: BackupFile,
  plan: ImportPlan,
  copySuffix = '(из бэкапа)'
): { state: GuildState; summary: ImportSummary } => {
  const summary = emptySummary();

  // Слитые игроки: ссылки из файла перевешиваем на уже существующего человека,
  // карточку из файла не заводим.
  const idMap: Record<string, string> = {};
  for (const [from, to] of Object.entries(plan.merges)) if (to) idMap[from] = to;
  summary.playersMerged = Object.keys(idMap).length;

  const incomingPlayers = incoming.players.filter(p => !idMap[p.id]);
  const incomingSessions = incoming.sessions.map(s => remapSession(s, idMap));
  const incomingMaps = incoming.mapTemplates.map(m => remapMap(m, idMap));

  // ---- игроки ----
  let players = [...current.players];
  if (plan.playerMode !== 'skip') {
    const haveIds = new Set(players.map(p => p.id));
    if (plan.playerMode === 'replace') {
      const byId = new Map(incomingPlayers.map(p => [p.id, p]));
      players = players.map(p => {
        const repl = byId.get(p.id);
        if (repl) summary.playersUpdated++;
        return repl ?? p;
      });
    }
    const fresh = incomingPlayers.filter(p => !haveIds.has(p.id));
    players = [...players, ...fresh];
    summary.playersAdded = fresh.length;
  }

  // ---- сессии (события + шаблоны) ----
  const sessions = [...current.sessions];
  for (const inc of incomingSessions) {
    const action = plan.items[inc.id] ?? 'skip';
    if (action === 'skip') { summary.skipped++; continue; }
    const idx = sessions.findIndex(s => s.id === inc.id);
    if (action === 'copy') {
      sessions.push({ ...inc, id: newId(isEvent(inc) ? 'evt' : 'tpl'), name: `${inc.name} ${copySuffix}` });
      summary.sessionsCopied++;
    } else if (action === 'overwrite') {
      if (idx >= 0) { sessions[idx] = inc; summary.sessionsUpdated++; }
      else { sessions.push(inc); summary.sessionsAdded++; }
    } else if (idx < 0) {
      sessions.push(inc);
      summary.sessionsAdded++;
    } else {
      summary.skipped++; // «добавить», но такой уже есть
    }
  }

  // ---- стратегии карты ----
  const mapTemplates = [...current.mapTemplates];
  for (const inc of incomingMaps) {
    const action = plan.items[inc.id] ?? 'skip';
    if (action === 'skip') { summary.skipped++; continue; }
    const idx = mapTemplates.findIndex(m => m.id === inc.id);
    if (action === 'copy') {
      mapTemplates.push({ ...inc, id: newId('map'), name: `${inc.name} ${copySuffix}` });
      summary.mapsCopied++;
    } else if (action === 'overwrite') {
      if (idx >= 0) { mapTemplates[idx] = inc; summary.mapsUpdated++; }
      else { mapTemplates.push(inc); summary.mapsAdded++; }
    } else if (idx < 0) {
      mapTemplates.push(inc);
      summary.mapsAdded++;
    } else {
      summary.skipped++;
    }
  }

  return { state: { players, sessions, mapTemplates }, summary };
};

// Полный откат: состояние становится ровно содержимым файла. Единственная операция,
// которая удаляет; вызывается только из «опасной зоны» с подтверждением.
export const rollbackTo = (file: BackupFile): GuildState => ({
  players: file.players,
  sessions: file.sessions,
  mapTemplates: file.mapTemplates
});
