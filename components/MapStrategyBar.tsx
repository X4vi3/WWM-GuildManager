import React, { useState } from 'react';
import { MapTemplate } from '../types';
import { useT } from '../services/i18n';

interface MapStrategyBarProps {
  maps: MapTemplate[];
  activeMapId: string | null;
  isViewer: boolean;
  onSwitch: (id: string) => void;
  onCreate: (name: string, fromCurrent: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

// Переключатель стратегий карты. Переключать может любой (локальный просмотр);
// создание/переименование/удаление — только редактор.
const MapStrategyBar: React.FC<MapStrategyBarProps> = ({
  maps, activeMapId, isViewer, onSwitch, onCreate, onRename, onDelete
}) => {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const startRename = (m: MapTemplate) => { setEditingId(m.id); setEditName(m.name); };
  const commitRename = () => { if (editingId) onRename(editingId, editName); setEditingId(null); };
  const submitCreate = (fromCurrent: boolean) => { onCreate(newName, fromCurrent); setNewName(''); setCreating(false); };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 mr-0.5">
        <i className="fa-solid fa-map text-amber-500/70"></i>
        {t('Стратегии')}
      </span>

      {maps.map(m => {
        const isActive = m.id === activeMapId;
        if (editingId === m.id) {
          return (
            <span key={m.id} className="inline-flex items-center gap-1 bg-slate-950 border border-amber-600 rounded-lg pl-2 pr-1 py-1">
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                onBlur={commitRename}
                className="bg-transparent text-sm font-semibold text-slate-100 outline-none w-32"
              />
              <button onMouseDown={e => e.preventDefault()} onClick={commitRename} title={t('Сохранить')} className="text-emerald-400 hover:text-emerald-300 px-1">
                <i className="fa-solid fa-check text-xs"></i>
              </button>
            </span>
          );
        }
        return (
          <span
            key={m.id}
            className={`group/tpl inline-flex items-center rounded-lg border transition-colors overflow-hidden
              ${isActive ? 'bg-amber-700/90 border-amber-500 text-white shadow' : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-amber-700'}`}
          >
            <button
              onClick={() => onSwitch(m.id)}
              className="text-sm font-semibold pl-3 pr-2 py-1.5"
              title={isActive ? t('Активная стратегия') : t('Переключиться на стратегию')}
            >
              {/* Стратегия по умолчанию сохраняется с русским именем — переводим, пока её не переименовали */}
              {m.name === 'Базовая' ? t('Базовая') : m.name}
            </button>
            {!isViewer && isActive && (
              <span className="flex items-center pr-1.5 gap-0.5">
                <button onClick={() => startRename(m)} title={t('Переименовать')} className="px-1 text-white/70 hover:text-white">
                  <i className="fa-solid fa-pen text-[11px]"></i>
                </button>
                <button
                  onClick={() => onDelete(m.id)}
                  disabled={maps.length <= 1}
                  title={maps.length <= 1 ? t('Нельзя удалить единственную стратегию') : t('Удалить стратегию')}
                  className="px-1 text-white/70 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <i className="fa-solid fa-trash-can text-[11px]"></i>
                </button>
              </span>
            )}
          </span>
        );
      })}

      {!isViewer && (creating ? (
        <span className="inline-flex items-center gap-1.5 bg-slate-950 border border-amber-600/60 rounded-lg pl-2 pr-1.5 py-1">
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitCreate(false); if (e.key === 'Escape') { setCreating(false); setNewName(''); } }}
            placeholder={t('Название стратегии')}
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
          title={t('Новая стратегия карты')}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 hover:border-amber-600 hover:text-amber-400 transition-colors"
        >
          <i className="fa-solid fa-plus"></i>
          {t('Стратегия')}
        </button>
      ))}
    </div>
  );
};

export default MapStrategyBar;
