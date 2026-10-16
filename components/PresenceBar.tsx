import React, { useEffect, useRef, useState } from 'react';
import { Player } from '../types';
import { PresenceEntry } from '../services/api';
import { useT } from '../services/i18n';

// Кто сейчас на сайте. Раньше это была отдельная полоса под шапкой во всю ширину —
// целая строка ради двух чипов. Теперь компактная кнопка в углу: сколько человек,
// а имена — по клику. Информация редкая, постоянного места не заслуживает.

interface PresenceBarProps {
  presence: PresenceEntry[];
  players: Player[];
  myClientId: string;
}

const nameFor = (e: PresenceEntry, players: Player[]) =>
  (e.playerId && players.find(p => p.id === e.playerId)?.name) || e.guestName;

const PresenceBar: React.FC<PresenceBarProps> = ({ presence, players, myClientId }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (presence.length === 0) return null;

  const editors = presence.filter(e => e.isEditor);
  const ordered = [...editors, ...presence.filter(e => !e.isEditor)];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title={t('Кто сейчас на сайте')}
        aria-expanded={open}
        className="flex items-center gap-1.5 h-8 px-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
      >
        {/* Зелёная точка = кто-то онлайн; янтарная = среди них есть редактор */}
        <span className={`w-1.5 h-1.5 rounded-full ${editors.length ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
        <span className="text-xs font-semibold tabular-nums">{presence.length}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-slate-900 border border-slate-700 rounded-lg shadow-lg overflow-hidden z-50">
          <p className="px-3 pt-2.5 pb-1.5 text-xs text-slate-600 font-semibold">
            {t('На сайте')}
          </p>
          <ul className="pb-1.5 max-h-64 overflow-y-auto custom-scrollbar">
            {ordered.map(e => (
              <li key={e.clientId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <i className={`fa-solid ${e.isEditor ? 'fa-pen text-amber-500' : 'fa-eye text-slate-600'} text-xs w-3.5`}></i>
                <span className={`truncate ${e.isEditor ? 'text-amber-200' : 'text-slate-300'}`}>
                  {nameFor(e, players)}
                </span>
                {e.clientId === myClientId && (
                  <span className="ml-auto text-xs text-slate-600 shrink-0">{t('вы')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default PresenceBar;
