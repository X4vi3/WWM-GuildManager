
import React, { useState } from 'react';
import { Player, Role, WeaponSchool, WEAPON_SCHOOLS, CallRole, CALL_ROLES } from '../types';
import { ROLE_LABELS, WEAPON_SCHOOL_LABELS, WEAPON_SCHOOL_IMAGES, CALL_ROLE_LABELS, CALL_ROLE_ICONS, CALL_ROLE_STYLES } from '../constants';
import { generateRandomPlayers } from '../services/demoData';
import PlayerCard from './PlayerCard';
import { useT } from '../services/i18n';
import { InkStroke, Watermark, GLYPHS } from './decor';

interface MemberManagerProps {
  players: Player[];
  isViewer?: boolean;
  onAdd: (p: Player) => void;
  onAddMany: (players: Player[]) => void;
  onUpdate: (p: Player) => void;
  onDelete: (id: string) => void;
  claimedPlayerId?: string | null;
  onClaim?: (playerId: string) => void;
  onUnclaim?: () => void;
  onUnavailable?: (p: Player) => void; // открыть окно «недоступен»
}

const MemberManager: React.FC<MemberManagerProps> = ({
  players,
  isViewer = false,
  onAdd,
  onAddMany,
  onUpdate,
  onDelete,
  claimedPlayerId = null,
  onClaim,
  onUnclaim,
  onUnavailable
}) => {
  const t = useT();
  const [isEditing, setIsEditing] = useState<Player | null>(null);
  const [search, setSearch] = useState('');

  const EMPTY_FORM: Omit<Player, 'id'> = {
    name: '',
    role: Role.DPS,
    weapons: [WEAPON_SCHOOLS[0], WEAPON_SCHOOLS[0]],
    callRoles: [],
    notes: '',
    autoSignup: false
  };

  const [formData, setFormData] = useState<Omit<Player, 'id'>>(EMPTY_FORM);

  const resetForm = () => setFormData(EMPTY_FORM);

  const setWeapon = (slot: 0 | 1, w: WeaponSchool) => {
    setFormData(fd => {
      const weapons = [...(fd.weapons || [WEAPON_SCHOOLS[0], WEAPON_SCHOOLS[0]])];
      weapons[slot] = w;
      return { ...fd, weapons };
    });
  };

  const toggleCallRole = (cr: CallRole) => {
    setFormData(fd => {
      const current = fd.callRoles || [];
      const callRoles = current.includes(cr) ? current.filter(x => x !== cr) : [...current, cr];
      return { ...fd, callRoles };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isViewer) return;
    if (isEditing) {
      onUpdate({ ...formData, id: isEditing.id });
      setIsEditing(null);
    } else {
      onAdd({ ...formData, id: Date.now().toString() });
    }
    resetForm();
  };

  const handleEdit = (p: Player) => {
    if (isViewer) return;
    setIsEditing(p);
    setFormData({
      name: p.name,
      role: p.role,
      weapons: p.weapons && p.weapons.length === 2 ? p.weapons : [WEAPON_SCHOOLS[0], WEAPON_SCHOOLS[0]],
      callRoles: p.callRoles || [],
      notes: p.notes,
      autoSignup: p.autoSignup || false,
      // Форма пересобирает игрока из перечисленных полей, поэтому всё, чего тут нет,
      // при сохранении пропадёт. Недоступность формой не правят (у неё своё окно), но
      // протащить её через форму обязаны — иначе правка ника снимала бы отпуск.
      unavailable: p.unavailable
    });
  };

  const handleCancelEdit = () => {
    setIsEditing(null);
    resetForm();
  };

  const handleGenerateDemo = () => {
    if (isViewer) return;
    onAddMany(generateRandomPlayers(30, players.map(p => p.name)));
  };

  const filteredPlayers = players.filter(p => {
    const q = search.toLowerCase();
    const weaponMatch = (p.weapons || []).some(w => WEAPON_SCHOOL_LABELS[w]?.toLowerCase().includes(q));
    return p.name.toLowerCase().includes(q) || weaponMatch;
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 h-full">
      <div className="lg:col-span-1 space-y-6">
        <div className={`bg-slate-900 border border-slate-800 p-6 rounded-lg relative overflow-hidden ${isViewer ? 'opacity-50' : ''}`}>
          <Watermark glyph={GLYPHS.guild} size={110} className="-right-3 -bottom-8 text-amber-500" />
          {isViewer && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/40 rounded-lg">
               <div className="bg-slate-900 border border-slate-700 px-4 py-2 rounded-lg text-[11px] font-semibold text-slate-400">
                  {t('Только просмотр')}
               </div>
            </div>
          )}
          <h2 className="cinzel text-2xl font-semibold mb-6 text-amber-500 border-b border-amber-900/50 pb-2">
            {isEditing ? t('Редактировать участника') : t('Добавить участника')}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">{t('Имя')}</label>
              <input
                type="text"
                required
                disabled={isViewer}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 focus:ring-1 focus:ring-amber-500 outline-none transition-colors text-sm"
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">{t('Роль')}</label>
              <select
                disabled={isViewer}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 outline-none text-sm"
                value={formData.role}
                onChange={e => setFormData({...formData, role: e.target.value as Role})}
              >
                <option value={Role.TANK}>{ROLE_LABELS[Role.TANK]}</option>
                <option value={Role.HEALER}>{ROLE_LABELS[Role.HEALER]}</option>
                <option value={Role.DPS}>{ROLE_LABELS[Role.DPS]}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-2">
                {t('Оружие · 2 школы')}
              </label>
              {[0, 1].map(slot => (
                <div key={slot} className="mb-2 last:mb-0">
                  <p className="text-[11px] text-slate-600 mb-1">{t('Школа')} {slot + 1}</p>
                  <div className="grid grid-cols-8 gap-1">
                    {WEAPON_SCHOOLS.map(w => {
                      const active = formData.weapons?.[slot] === w;
                      return (
                        <button
                          key={w}
                          type="button"
                          disabled={isViewer}
                          onClick={() => setWeapon(slot as 0 | 1, w)}
                          title={WEAPON_SCHOOL_LABELS[w]}
                          className={`aspect-square rounded-lg border flex items-center justify-center p-0.5 transition-colors
                            ${active ? 'border-amber-500 ring-2 ring-amber-500/40 bg-amber-950/20' : 'border-slate-800 bg-slate-950 hover:border-slate-600'}`}
                        >
                          <img src={WEAPON_SCHOOL_IMAGES[w]} alt={WEAPON_SCHOOL_LABELS[w]} className="w-full h-full object-contain" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">{t('Коллы — кто руководит (необязательно)')}</label>
              <div className="grid grid-cols-2 gap-2">
                {CALL_ROLES.map(cr => {
                  const active = (formData.callRoles || []).includes(cr);
                  const st = CALL_ROLE_STYLES[cr];
                  return (
                    <button
                      key={cr}
                      type="button"
                      disabled={isViewer}
                      onClick={() => toggleCallRole(cr)}
                      title={CALL_ROLE_LABELS[cr]}
                      className={`flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-semibold transition-colors
                        ${active ? `${st.bg} ${st.border} ${st.text}` : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600'}`}
                    >
                      <i className={`fa-solid ${CALL_ROLE_ICONS[cr]}`}></i>
                      {CALL_ROLE_LABELS[cr]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <button
                type="button"
                disabled={isViewer}
                onClick={() => setFormData(fd => ({ ...fd, autoSignup: !fd.autoSignup }))}
                title={t('Игрок будет сразу отмечен «Иду» в каждом новом событии, без своего участия')}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-semibold transition-colors
                  ${formData.autoSignup ? 'bg-emerald-950/30 border-emerald-700/60 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600'}`}
              >
                <i className="fa-solid fa-calendar-check"></i>
                {t('Авто-запись «Иду» на все события')}
              </button>
            </div>
            {!isViewer && (
              <div className="flex gap-2">
                <button type="submit" className="flex-1 bg-amber-600 hover:bg-amber-500 text-white font-semibold py-2 px-4 rounded-lg transition-colors">
                  {isEditing ? t('Сохранить изменения') : t('Добавить в состав')}
                </button>
                {isEditing && (
                  <button type="button" onClick={handleCancelEdit} className="px-4 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-sm font-semibold transition-colors">
                    {t('Отмена')}
                  </button>
                )}
              </div>
            )}
          </form>
        </div>
      </div>

      <div className="lg:col-span-3 space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="cinzel text-2xl font-semibold text-slate-200">{t('Состав гильдии')} ({players.length})</h2>
            <InkStroke className="max-w-[260px] mt-1" />
          </div>
          <div className="flex items-center gap-2">
             {!isViewer && import.meta.env.DEV && (
               <button
                 onClick={handleGenerateDemo}
                 title={t('Только для разработки: 30 случайных бойцов для демонстрации')}
                 className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-amber-700 text-slate-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
               >
                 <i className="fa-solid fa-dice text-amber-500"></i>
                 {t('+30 случайных')}
               </button>
             )}
             <div className="flex items-center gap-2">
               <i className="fa-solid fa-magnifying-glass text-slate-600"></i>
               <input
                 type="text"
                 placeholder={t('Поиск участников...')}
                 className="bg-slate-900 border border-slate-800 rounded-lg text-sm px-3 py-1 outline-none focus:border-amber-900"
                 value={search}
                 onChange={e => setSearch(e.target.value)}
               />
             </div>
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3 overflow-y-auto max-h-[calc(100vh-250px)] pr-2 custom-scrollbar">
          {players.length === 0 ? (
            <div className="col-span-full py-12 text-center text-slate-600 border-2 border-dashed border-slate-800 rounded-lg">
              <i className="fa-solid fa-users-slash text-4xl mb-3"></i>
              <p>{t('В гильдии пока нет участников.')}</p>
            </div>
          ) : filteredPlayers.length === 0 ? (
            <div className="col-span-full py-12 text-center text-slate-600 border-2 border-dashed border-slate-800 rounded-lg">
              <i className="fa-solid fa-magnifying-glass text-4xl mb-3"></i>
              <p>{t('Никто не найден по запросу')} «{search}».</p>
            </div>
          ) : (
            filteredPlayers.map(p => (
              <PlayerCard
                key={p.id}
                player={p}
                onEdit={isViewer ? undefined : handleEdit}
                onDelete={isViewer ? undefined : onDelete}
                isMe={claimedPlayerId === p.id}
                onClaimSelf={onClaim && claimedPlayerId !== p.id ? () => onClaim(p.id) : undefined}
                onUnclaimSelf={onUnclaim && claimedPlayerId === p.id ? onUnclaim : undefined}
                // Офицер помечает любого, игрок — только себя. Право проверяет и сервер;
                // здесь мы всего лишь не показываем кнопку, которая всё равно не сработает.
                onUnavailable={onUnavailable && (!isViewer || claimedPlayerId === p.id) ? onUnavailable : undefined}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default MemberManager;
