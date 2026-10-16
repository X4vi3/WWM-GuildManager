import React, { useMemo, useState } from 'react';
import { GuildWarSession, MapTemplate } from '../types';
import {
  GuildState, BackupFile, ImportPlan, ItemAction, PlayerMode, ImportSummary,
  ExportSelection, PlayerNameMatch,
  buildBackup, downloadBackup, backupFilename, readBackupFile,
  applyImport, rollbackTo, defaultPlan, findNameMatches, emptySummary,
  referencedPlayerIds, eventsOf, templatesOf, isEvent
} from '../services/transfer';
import { useT } from '../services/i18n';
import { choose } from './Notifications';

// Окно выборочного экспорта/импорта. Одно дерево на оба режима: игроки (целиком),
// события, шаблоны составов, стратегии карты. Импорт ничего не удаляет — единственное
// исключение вынесено в «опасную зону» внизу (полный откат).

interface Props {
  mode: 'export' | 'import';
  state: GuildState;
  // next — новое состояние; rollback — был ли это полный откат;
  // saveBackup — скачивать ли снимок текущего состояния перед применением (спрашиваем в диалоге)
  onApply: (next: GuildState, summary: ImportSummary, rollback: boolean, saveBackup: boolean) => void;
  onClose: () => void;
}

const shortDate = (d?: string) => {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}.${m[2]}` : d;
};

const sessionMeta = (s: GuildWarSession) => {
  const parts: string[] = [];
  const d = shortDate(s.event?.date);
  if (d) parts.push(d);
  if (s.event?.time) parts.push(s.event.time);
  const n = (s.assignments || []).length;
  if (n) parts.push(`${n}`);
  return parts;
};

const sessionTitle = (s: GuildWarSession) =>
  s.event?.opponent ? `${s.name || ''} vs ${s.event.opponent}`.trim() : (s.name || '—');

const Section: React.FC<{
  title: string;
  count: number;
  hint?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, count, hint, children, actions }) => (
  <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/40">
    <div className="px-3.5 py-2.5 bg-slate-900/60 border-b border-slate-800">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400">{title}</span>
        <span className="text-[11px] font-semibold text-slate-500">({count})</span>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
      {hint && <p className="text-[11px] text-slate-500 mt-1 leading-snug">{hint}</p>}
    </div>
    {children}
  </div>
);

const BulkBtn: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    onClick={onClick}
    className="text-[11px] text-slate-500 hover:text-amber-400 border border-slate-800 hover:border-amber-900/60 rounded-lg px-2 py-1 transition-colors"
  >
    {children}
  </button>
);

const Radio: React.FC<{ on: boolean; onClick: () => void; label: string; danger?: boolean }> = ({ on, onClick, label, danger }) => (
  <button
    onClick={onClick}
    className={`text-[11px] font-semibold rounded-lg px-2 py-1 border transition-colors ${
      on
        ? (danger ? 'border-red-600/60 bg-red-600/15 text-red-300' : 'border-amber-600/60 bg-amber-600/15 text-amber-300')
        : 'border-slate-800 text-slate-500 hover:text-slate-300'
    }`}
  >
    {label}
  </button>
);

const TransferPanel: React.FC<Props> = ({ mode, state, onApply, onClose }) => {
  const t = useT();

  const events = useMemo(() => eventsOf(state.sessions), [state.sessions]);
  const templates = useMemo(() => templatesOf(state.sessions), [state.sessions]);

  // ------------------------------------------------------------- экспорт ----
  const [expPlayers, setExpPlayers] = useState(true);
  const [expSessions, setExpSessions] = useState<Record<string, boolean>>(
    () => Object.fromEntries(state.sessions.map(s => [s.id, true]))
  );
  const [expMaps, setExpMaps] = useState<Record<string, boolean>>(
    () => Object.fromEntries(state.mapTemplates.map(m => [m.id, true]))
  );

  const expSelection: ExportSelection = useMemo(() => ({
    players: expPlayers,
    sessionIds: state.sessions.filter(s => expSessions[s.id]).map(s => s.id),
    mapIds: state.mapTemplates.filter(m => expMaps[m.id]).map(m => m.id)
  }), [expPlayers, expSessions, expMaps, state]);

  // Сколько игроков задействовано в выбранном — для предупреждения о битых ссылках
  const neededPlayers = useMemo(() => {
    if (expPlayers) return 0;
    const sessSet = new Set(expSelection.sessionIds);
    const mapSet = new Set(expSelection.mapIds);
    const ids = referencedPlayerIds(
      state.sessions.filter(s => sessSet.has(s.id)),
      state.mapTemplates.filter(m => mapSet.has(m.id))
    );
    let n = 0;
    for (const p of state.players) if (ids.has(p.id)) n++;
    return n;
  }, [expPlayers, expSelection, state]);

  const doExport = () => {
    downloadBackup(buildBackup(state, expSelection), backupFilename());
    onClose();
  };

  // -------------------------------------------------------------- импорт ----
  const [file, setFile] = useState<BackupFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const nameMatches: PlayerNameMatch[] = useMemo(
    () => (file ? findNameMatches(state.players, file.players) : []),
    [file, state.players]
  );

  const loadFile = async (f: File) => {
    setBusy(true);
    const parsed = await readBackupFile(f);
    setBusy(false);
    if (!parsed) { setFileError(true); setFile(null); setPlan(null); return; }
    setFileError(false);
    setFileName(f.name);
    setFile(parsed);
    setPlan(defaultPlan(state, parsed));
  };

  const incEvents = file ? eventsOf(file.sessions) : [];
  const incTemplates = file ? templatesOf(file.sessions) : [];
  const existingSessionIds = useMemo(() => new Set(state.sessions.map(s => s.id)), [state.sessions]);
  const existingMapIds = useMemo(() => new Set(state.mapTemplates.map(m => m.id)), [state.mapTemplates]);

  const setItem = (id: string, action: ItemAction) =>
    setPlan(p => (p ? { ...p, items: { ...p.items, [id]: action } } : p));

  const setBulk = (ids: string[], action: ItemAction, exists: (id: string) => boolean) =>
    setPlan(p => {
      if (!p) return p;
      const items = { ...p.items };
      for (const id of ids) {
        // «добавить» имеет смысл только для новых; у совпавших это был бы пропуск
        items[id] = exists(id) ? action : (action === 'skip' ? 'skip' : 'add');
      }
      return { ...p, items };
    });

  const setPlayerMode = (m: PlayerMode) => setPlan(p => (p ? { ...p, playerMode: m } : p));
  const setMerge = (incomingId: string, existingId: string) =>
    setPlan(p => (p ? { ...p, merges: { ...p.merges, [incomingId]: existingId } } : p));

  const preview = useMemo(() => {
    if (!file || !plan) return null;
    return applyImport(state, file, plan, t('(из бэкапа)'));
  }, [file, plan, state, t]);

  const doImport = async () => {
    if (!file || !plan || !preview) return;
    const r = await choose(
      t('Сохранить бэкап текущего состояния перед импортом? Файл скачается к тебе — с ним можно вернуть всё как было в любой момент.'),
      {
        primaryLabel: t('Сохранить бэкап и импортировать'),
        secondaryLabel: t('Импортировать без бэкапа'),
        cancelLabel: t('Отмена')
      }
    );
    if (r === 'cancel') return;
    onApply(preview.state, preview.summary, false, r === 'primary');
  };

  const doRollback = async () => {
    if (!file) return;
    const next = rollbackTo(file);
    const r = await choose(
      `${t('Полный откат: всё текущее содержимое будет стёрто у всей гильдии и заменено содержимым файла.')} ` +
      `${t('Останется:')} ${next.players.length} ${t('игр.')}, ${eventsOf(next.sessions).length} ${t('соб.')}, ` +
      `${templatesOf(next.sessions).length} ${t('шабл.')}, ${next.mapTemplates.length} ${t('страт.')}`,
      {
        primaryLabel: t('Сохранить бэкап и откатить'),
        secondaryLabel: t('Откатить без бэкапа'),
        cancelLabel: t('Отмена'),
        danger: true
      }
    );
    if (r === 'cancel') return;
    // при откате сводка не нужна — состояние берётся из файла целиком
    onApply(next, emptySummary(), true, r === 'primary');
  };

  // ---------------------------------------------------------------- вид ----
  const isExport = mode === 'export';

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center p-4 py-10 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-lg overflow-hidden animate-in zoom-in-95 duration-200"
      >
        {/* заголовок */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800">
          <div className="w-9 h-9 rounded-lg bg-amber-600/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
            <i className={`fa-solid ${isExport ? 'fa-download' : 'fa-upload'}`}></i>
          </div>
          <div>
            <h2 className="cinzel text-lg font-semibold text-slate-200">
              {isExport ? t('Экспорт данных гильдии') : t('Импорт данных гильдии')}
            </h2>
            <p className="text-[11px] text-slate-500">
              {isExport ? t('Отметь, что положить в файл') : (fileName || t('Выбери файл бэкапа'))}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-slate-200 transition-colors">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto">
          {isExport ? (
            <>
              {/* --- игроки --- */}
              <Section title={t('Игроки гильдии')} count={state.players.length}>
                <label className="flex items-center gap-3 px-3.5 py-3 cursor-pointer hover:bg-slate-900/40 transition-colors">
                  <input
                    type="checkbox"
                    checked={expPlayers}
                    onChange={e => setExpPlayers(e.target.checked)}
                    className="w-4 h-4 accent-amber-600"
                  />
                  <span className="text-xs text-slate-300">{t('Весь ростер целиком')}</span>
                </label>
              </Section>

              {/* --- события --- */}
              {events.length > 0 && (
                <Section
                  title={t('События')}
                  count={events.length}
                  hint={t('В «Штабе войны» они тоже показаны как шаблоны — там события и шаблоны в одном ряду.')}
                  actions={
                    <>
                      <BulkBtn onClick={() => setExpSessions(p => ({ ...p, ...Object.fromEntries(events.map(s => [s.id, true])) }))}>{t('все')}</BulkBtn>
                      <BulkBtn onClick={() => setExpSessions(p => ({ ...p, ...Object.fromEntries(events.map(s => [s.id, false])) }))}>{t('снять')}</BulkBtn>
                    </>
                  }
                >
                  <div className="divide-y divide-slate-900">
                    {events.map(s => (
                      <label key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-slate-900/40 transition-colors">
                        <input type="checkbox" checked={!!expSessions[s.id]} onChange={e => setExpSessions(p => ({ ...p, [s.id]: e.target.checked }))} className="w-4 h-4 accent-amber-600" />
                        <span className="text-xs text-slate-300 flex-1 truncate">{sessionTitle(s)}</span>
                        <span className="text-[11px] text-slate-600 shrink-0">{sessionMeta(s).join(' · ')}</span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}

              {/* --- шаблоны --- */}
              {templates.length > 0 && (
                <Section
                  title={t('Шаблоны составов')}
                  count={templates.length}
                  hint={t('Только те, что без даты и соперника. События — в секции выше.')}
                  actions={
                    <>
                      <BulkBtn onClick={() => setExpSessions(p => ({ ...p, ...Object.fromEntries(templates.map(s => [s.id, true])) }))}>{t('все')}</BulkBtn>
                      <BulkBtn onClick={() => setExpSessions(p => ({ ...p, ...Object.fromEntries(templates.map(s => [s.id, false])) }))}>{t('снять')}</BulkBtn>
                    </>
                  }
                >
                  <div className="divide-y divide-slate-900">
                    {templates.map(s => (
                      <label key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-slate-900/40 transition-colors">
                        <input type="checkbox" checked={!!expSessions[s.id]} onChange={e => setExpSessions(p => ({ ...p, [s.id]: e.target.checked }))} className="w-4 h-4 accent-amber-600" />
                        <span className="text-xs text-slate-300 flex-1 truncate">{s.name}</span>
                        <span className="text-[11px] text-slate-600 shrink-0">{(s.assignments || []).length}</span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}

              {/* --- стратегии --- */}
              {state.mapTemplates.length > 0 && (
                <Section
                  title={t('Стратегии карты')}
                  count={state.mapTemplates.length}
                  actions={
                    <>
                      <BulkBtn onClick={() => setExpMaps(Object.fromEntries(state.mapTemplates.map(m => [m.id, true])))}>{t('все')}</BulkBtn>
                      <BulkBtn onClick={() => setExpMaps(Object.fromEntries(state.mapTemplates.map(m => [m.id, false])))}>{t('снять')}</BulkBtn>
                    </>
                  }
                >
                  <div className="divide-y divide-slate-900">
                    {state.mapTemplates.map(m => (
                      <label key={m.id} className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-slate-900/40 transition-colors">
                        <input type="checkbox" checked={!!expMaps[m.id]} onChange={e => setExpMaps(p => ({ ...p, [m.id]: e.target.checked }))} className="w-4 h-4 accent-amber-600" />
                        <span className="text-xs text-slate-300 flex-1 truncate">{m.name}</span>
                        <span className="text-[11px] text-slate-600 shrink-0">
                          {(m.drawings || []).length} {t('рис.')} · {Object.keys(m.positions || {}).length} {t('ток.')}
                        </span>
                      </label>
                    ))}
                  </div>
                </Section>
              )}

              {/* --- предупреждение о битых ссылках --- */}
              {neededPlayers > 0 && (
                <div className="border border-amber-900/50 bg-amber-950/20 rounded-lg p-3.5">
                  <div className="flex items-start gap-2.5">
                    <i className="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>
                    <div className="flex-1">
                      <p className="text-xs text-amber-200 leading-snug">
                        {t('В выбранном задействовано игроков:')} {neededPlayers}, {t('но сами игроки не отмечены. При восстановлении на чистом приложении составы и токены будут пустыми.')}
                      </p>
                      <button
                        onClick={() => setExpPlayers(true)}
                        className="mt-2.5 text-[11px] font-semibold text-amber-300 hover:text-amber-100 border border-amber-800/60 hover:border-amber-600 rounded-lg px-2.5 py-1.5 transition-colors"
                      >
                        {t('Добавить игроков')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {/* --- выбор файла --- */}
              {!file && (
                <label
                  className="block border-2 border-dashed border-slate-800 hover:border-amber-800 rounded-lg p-8 text-center cursor-pointer transition-colors"
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); }}
                >
                  <input type="file" accept=".json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
                  <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-file-arrow-up'} text-2xl text-slate-600`}></i>
                  <p className="text-xs text-slate-400 mt-3">{t('Перетащи файл сюда или нажми, чтобы выбрать')}</p>
                  {fileError && <p className="text-xs text-red-400 mt-2">{t('Не удалось прочитать файл — проверьте, что это корректный бэкап.')}</p>}
                </label>
              )}

              {file && plan && (
                <>
                  {/* --- игроки --- */}
                  <Section title={t('Игроки гильдии')} count={file.players.length}>
                    <div className="px-3.5 py-3 space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <Radio on={plan.playerMode === 'replace'} onClick={() => setPlayerMode('replace')} label={t('Заменить')} />
                        <Radio on={plan.playerMode === 'add'} onClick={() => setPlayerMode('add')} label={t('Добавить')} />
                        <Radio on={plan.playerMode === 'skip'} onClick={() => setPlayerMode('skip')} label={t('Не трогать')} />
                      </div>
                      <p className="text-[11px] text-slate-500 leading-snug">
                        {plan.playerMode === 'replace' && t('Совпавшие по id — перезаписать данными из файла, новых — добавить. Никто не удаляется.')}
                        {plan.playerMode === 'add' && t('Добавить только тех, кого ещё нет. Существующие карточки не меняются.')}
                        {plan.playerMode === 'skip' && t('Ростер не трогаем совсем.')}
                      </p>

                      {/* совпадения по нику */}
                      {nameMatches.length > 0 && (
                        <div className="border border-amber-900/50 bg-amber-950/20 rounded-lg p-3 space-y-2">
                          <p className="text-xs text-amber-200 leading-snug">
                            <i className="fa-solid fa-triangle-exclamation mr-1.5"></i>
                            {t('Совпали по нику, но id разные:')}
                          </p>
                          {nameMatches.map(m => (
                            <div key={m.incoming.id} className="flex items-center gap-2">
                              <span className="text-xs text-slate-300 flex-1 truncate">{m.incoming.name}</span>
                              <Radio on={!!plan.merges[m.incoming.id]} onClick={() => setMerge(m.incoming.id, m.existing.id)} label={t('слить')} />
                              <Radio on={!plan.merges[m.incoming.id]} onClick={() => setMerge(m.incoming.id, '')} label={t('два разных')} />
                            </div>
                          ))}
                          <p className="text-[11px] text-amber-200/70 leading-snug">
                            {t('«Слить» — составы и токены из файла будут указывать на текущего игрока.')}
                          </p>
                        </div>
                      )}
                    </div>
                  </Section>

                  {/* --- события / шаблоны / стратегии --- */}
                  {([
                    { title: t('События'), items: incEvents as (GuildWarSession | MapTemplate)[], exists: (id: string) => existingSessionIds.has(id) },
                    { title: t('Шаблоны составов'), items: incTemplates as (GuildWarSession | MapTemplate)[], exists: (id: string) => existingSessionIds.has(id) },
                    { title: t('Стратегии карты'), items: file.mapTemplates as (GuildWarSession | MapTemplate)[], exists: (id: string) => existingMapIds.has(id) }
                  ]).map(group => group.items.length > 0 && (
                    <Section
                      key={group.title}
                      title={group.title}
                      count={group.items.length}
                      actions={
                        <>
                          <BulkBtn onClick={() => setBulk(group.items.map(i => i.id), 'skip', group.exists)}>{t('пропустить')}</BulkBtn>
                          <BulkBtn onClick={() => setBulk(group.items.map(i => i.id), 'overwrite', group.exists)}>{t('перезап.')}</BulkBtn>
                          <BulkBtn onClick={() => setBulk(group.items.map(i => i.id), 'copy', group.exists)}>{t('копией')}</BulkBtn>
                        </>
                      }
                    >
                      <div className="divide-y divide-slate-900">
                        {group.items.map(item => {
                          const collides = group.exists(item.id);
                          const action = plan.items[item.id] ?? 'skip';
                          const isSession = 'assignments' in item;
                          return (
                            <div key={item.id} className="px-3.5 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-300 flex-1 truncate">
                                  {isSession ? sessionTitle(item as GuildWarSession) : (item as MapTemplate).name}
                                </span>
                                <span className={`text-[11px] shrink-0 ${collides ? 'text-amber-500' : 'text-emerald-600'}`}>
                                  {collides ? t('уже есть') : t('новое')}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 mt-1.5">
                                {collides ? (
                                  <>
                                    <Radio on={action === 'skip'} onClick={() => setItem(item.id, 'skip')} label={t('пропустить')} />
                                    <Radio on={action === 'overwrite'} onClick={() => setItem(item.id, 'overwrite')} label={t('перезаписать')} />
                                    <Radio on={action === 'copy'} onClick={() => setItem(item.id, 'copy')} label={t('копией')} />
                                  </>
                                ) : (
                                  <>
                                    <Radio on={action !== 'skip'} onClick={() => setItem(item.id, 'add')} label={t('добавить')} />
                                    <Radio on={action === 'skip'} onClick={() => setItem(item.id, 'skip')} label={t('пропустить')} />
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Section>
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* подвал */}
        <div className="px-5 py-4 border-t border-slate-800 space-y-3">
          {isExport ? (
            <div className="flex items-center gap-3">
              <p className="text-[11px] text-slate-500 flex-1">
                {t('В файл пойдёт:')} {expPlayers ? state.players.length : 0} {t('игр.')} ·{' '}
                {expSelection.sessionIds.filter(id => isEvent(state.sessions.find(s => s.id === id)!)).length} {t('соб.')} ·{' '}
                {expSelection.sessionIds.length - expSelection.sessionIds.filter(id => isEvent(state.sessions.find(s => s.id === id)!)).length} {t('шабл.')} ·{' '}
                {expSelection.mapIds.length} {t('страт.')}
              </p>
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-200 text-sm transition-colors">
                {t('Отмена')}
              </button>
              <button
                onClick={doExport}
                disabled={!expPlayers && expSelection.sessionIds.length === 0 && expSelection.mapIds.length === 0}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-semibold transition-colors"
              >
                {t('Выгрузить')}
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <p className="text-[11px] text-slate-500 flex-1">
                  {preview
                    ? `${t('Будет:')} +${preview.summary.playersAdded} ${t('игр.')} · ${preview.summary.sessionsAdded + preview.summary.sessionsCopied} ${t('нов. сост.')} · ${preview.summary.sessionsUpdated} ${t('обновл.')} · ${preview.summary.mapsAdded + preview.summary.mapsCopied} ${t('нов. страт.')} · ${preview.summary.mapsUpdated} ${t('обновл.')}`
                    : t('Файл не выбран')}
                </p>
                <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 hover:text-slate-200 text-sm transition-colors">
                  {t('Отмена')}
                </button>
                <button
                  onClick={doImport}
                  disabled={!preview}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-semibold transition-colors"
                >
                  {t('Импортировать')}
                </button>
              </div>

              {file && (
                <div className="border border-red-900/50 bg-red-950/20 rounded-lg p-3.5 flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-red-400">{t('Опасная зона')}</p>
                    <p className="text-[11px] text-red-200/70 leading-snug mt-0.5">
                      {t('Всё текущее будет стёрто у всей гильдии. Галочки выше игнорируются.')}
                    </p>
                  </div>
                  <button
                    onClick={doRollback}
                    className="shrink-0 px-4 py-2 rounded-lg border border-red-800 text-red-300 hover:bg-red-600 hover:text-white text-xs font-semibold transition-colors"
                  >
                    {t('Полный откат')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TransferPanel;
