import React, { useMemo, useState } from 'react';
import Glyph from './glyphs';
import { GuildWarSession } from '../types';
import { EVENT_TYPE_LABELS, EVENT_TYPE_ICONS, EVENT_TYPE_STYLES } from '../constants';
import { useT } from '../services/i18n';
import { isEventClosed } from '../services/datetime';

// Панель штаба войны. В данных события и шаблоны составов лежат в ОДНОМ массиве
// sessions (событие отличается наличием event), и раньше панель показывала всё
// вперемешку под подписью «Шаблоны» — из-за чего казалось, будто при создании
// события заводится лишний шаблон. Здесь они разведены на две группы.

interface TemplateBarProps {
  sessions: GuildWarSession[];
  activeSessionId: string | null;
  isViewer: boolean;
  onSwitch: (id: string) => void;
  onCreate: (name: string, fromCurrent: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const TemplateBar: React.FC<TemplateBarProps> = ({
  sessions, activeSessionId, isViewer, onSwitch, onCreate, onRename, onDelete
}) => {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showPast, setShowPast] = useState(false);

  const startRename = (s: GuildWarSession) => { setEditingId(s.id); setEditName(s.name); };
  const commitRename = () => {
    if (editingId) onRename(editingId, editName);
    setEditingId(null);
  };
  const submitCreate = (fromCurrent: boolean) => {
    onCreate(newName, fromCurrent);
    setNewName('');
    setCreating(false);
  };

  // События — ближайшие первыми, завершённые отдельно и по умолчанию свёрнуты:
  // их со временем накапливается много, а нужны они редко.
  const { upcoming, past, templates } = useMemo(() => {
    const evts = sessions.filter(s => !!s.event);
    const key = (s: GuildWarSession) =>
      s.event?.startsAt || (s.event?.date ? `${s.event.date}T${s.event.time || ''}` : '');
    const done = (s: GuildWarSession) => isEventClosed(s.event?.startsAt, s.event?.type);
    return {
      upcoming: evts.filter(s => !done(s)).sort((a, b) => key(a).localeCompare(key(b))),
      past: evts.filter(done).sort((a, b) => key(b).localeCompare(key(a))),
      templates: sessions.filter(s => !s.event)
    };
  }, [sessions]);

  const renameBox = (s: GuildWarSession) => (
    <span key={s.id} className="inline-flex items-center gap-1 bg-slate-950 border border-amber-600 rounded-lg pl-2 pr-1 py-1">
      <input
        autoFocus
        value={editName}
        onChange={e => setEditName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
        onBlur={commitRename}
        className="bg-transparent text-sm font-semibold text-slate-100 outline-none w-28"
      />
      <button onMouseDown={e => e.preventDefault()} onClick={commitRename} title={t('Сохранить')} className="text-emerald-400 hover:text-emerald-300 px-1">
        <i className="fa-solid fa-check text-xs"></i>
      </button>
    </span>
  );

  // Фишка сессии. Для события — иконка и цвет типа, чтобы его нельзя было
  // спутать с обычным шаблоном; удаление события отдельно помечено красным.
  const chip = (s: GuildWarSession) => {
    if (editingId === s.id) return renameBox(s);
    const isActive = s.id === activeSessionId;
    const ev = s.event;
    const st = ev ? EVENT_TYPE_STYLES[ev.type] : null;
    const closed = ev ? isEventClosed(ev.startsAt, ev.type) : false;

    return (
      <span
        key={s.id}
        className={`inline-flex items-center rounded-lg border transition-colors overflow-hidden ${closed ? 'opacity-60' : ''}
          ${isActive
            ? (ev ? `${st!.bg} ${st!.border} ${st!.text} shadow ring-1 ring-inset ring-white/10` : 'bg-amber-700/90 border-amber-500 text-white shadow')
            : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-amber-700'}`}
      >
        <button
          onClick={() => onSwitch(s.id)}
          className="text-sm font-semibold pl-2.5 pr-2 py-1.5 flex items-center gap-1.5"
          title={isActive ? t('Открыто сейчас') : (ev ? t('Открыть расстановку на это событие') : t('Переключиться на этот шаблон'))}
        >
          {ev && <Glyph name={EVENT_TYPE_ICONS[ev.type]} className="w-[1.05em] h-[1.05em] opacity-80" />}
          {s.name}
          {closed && <i className="fa-solid fa-lock text-[11px] opacity-70" title={t('Завершено')}></i>}
        </button>
        {!isViewer && isActive && (
          <span className="flex items-center pr-1.5 gap-0.5">
            <button onClick={() => startRename(s)} title={t('Переименовать')} className="px-1 opacity-70 hover:opacity-100">
              <i className="fa-solid fa-pen text-[11px]"></i>
            </button>
            <button
              onClick={() => onDelete(s.id)}
              disabled={sessions.length <= 1}
              title={sessions.length <= 1
                ? t('Нельзя удалить единственную запись')
                : (ev ? t('Удалить СОБЫТИЕ вместе с заявками и анонсами') : t('Удалить шаблон'))}
              className="px-1 opacity-70 hover:opacity-100 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <i className="fa-solid fa-trash-can text-[11px]"></i>
            </button>
          </span>
        )}
      </span>
    );
  };

  const groupLabel = (icon: string, color: string, text: string, count: number) => (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 shrink-0">
      <i className={`fa-solid ${icon} ${color}`}></i>
      {text}
      {count > 0 && <span className="text-slate-700">({count})</span>}
    </span>
  );

  return (
    <div className="mb-4 space-y-2">
      {/* ---- События ---- */}
      {(upcoming.length > 0 || past.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {groupLabel('fa-calendar-days', 'text-sky-500/70', t('События'), upcoming.length)}
          {upcoming.map(chip)}
          {upcoming.length === 0 && (
            <span className="text-[11px] text-slate-700">{t('активных нет')}</span>
          )}
          {past.length > 0 && (
            <>
              {showPast && past.map(chip)}
              <button
                onClick={() => setShowPast(v => !v)}
                className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-dashed border-slate-800 text-slate-600 hover:text-slate-400 hover:border-slate-600 transition-colors"
              >
                <i className={`fa-solid ${showPast ? 'fa-chevron-up' : 'fa-clock-rotate-left'} mr-1`}></i>
                {showPast ? t('скрыть прошедшие') : `${t('прошедшие')} (${past.length})`}
              </button>
            </>
          )}
        </div>
      )}

      {/* ---- Шаблоны составов ---- */}
      <div className="flex flex-wrap items-center gap-2">
        {groupLabel('fa-layer-group', 'text-amber-500/70', t('Шаблоны составов'), templates.length)}
        {templates.map(chip)}

        {!isViewer && (creating ? (
          <span className="inline-flex items-center gap-1.5 bg-slate-950 border border-amber-600/60 rounded-lg pl-2 pr-1.5 py-1">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCreate(false); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
              placeholder={t('Название (Ранкед, Лига…)')}
              className="bg-transparent text-sm text-slate-100 placeholder:text-slate-600 outline-none w-40"
            />
            <button onClick={() => submitCreate(false)} title={t('Создать пустой')} className="text-[11px] font-semibold px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white">
              {t('Пустой')}
            </button>
            <button onClick={() => submitCreate(true)} title={t('Создать как копию текущего')} className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-700 text-slate-300 hover:border-amber-600 hover:text-white">
              {t('Копия')}
            </button>
            <button onClick={() => { setCreating(false); setNewName(''); }} title={t('Отмена')} className="text-slate-500 hover:text-slate-300 px-1">
              <i className="fa-solid fa-xmark text-xs"></i>
            </button>
          </span>
        ) : (
          <button
            onClick={() => setCreating(true)}
            title={t('Новый шаблон состава')}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 hover:border-amber-600 hover:text-amber-400 transition-colors"
          >
            <i className="fa-solid fa-plus"></i>
            {t('Шаблон')}
          </button>
        ))}
      </div>
    </div>
  );
};

export default TemplateBar;
