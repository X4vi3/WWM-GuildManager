
import React from 'react';
import { Player } from '../types';
import {
  ROLE_ICONS,
  WEAPON_SCHOOL_IMAGES, WEAPON_SCHOOL_LABELS,
  CALL_ROLE_ICONS, CALL_ROLE_LABELS, CALL_ROLE_STYLES
} from '../constants';
import { useT } from '../services/i18n';
import { isAway } from '../server/away.mjs';
import UnavailableBadge from './UnavailableBadge';

interface PlayerCardProps {
  player: Player;
  onEdit?: (p: Player) => void;
  onDelete?: (id: string) => void;
  className?: string;
  compact?: boolean;
  extra?: React.ReactNode; // доп-контент внутри карточки (напр. бейдж Лес/Босс)
  isMe?: boolean;             // этот ник закреплён за текущим браузером
  onClaimSelf?: () => void;   // "это я"
  onUnclaimSelf?: () => void; // снять закрепление
  onUnavailable?: (p: Player) => void; // открыть окно «недоступен»
}

const PlayerCard: React.FC<PlayerCardProps> = ({ player, onEdit, onDelete, className = '', compact = false, extra, isMe = false, onClaimSelf, onUnclaimSelf, onUnavailable }) => {
  const t = useT();
  // Недоступность вычисляется, а не хранится: метка гаснет сама в день возвращения.
  const away: boolean = isAway(player);
  const weapons = (player.weapons || []).filter(w => WEAPON_SCHOOL_IMAGES[w]);
  const callRoles = (player.callRoles || []).filter(cr => CALL_ROLE_STYLES[cr]);

  // Иконки школ оружия — крупные, без рамки
  const renderWeapons = (size: number) => (
    <span className="inline-flex items-center gap-0.5 shrink-0">
      {weapons.map((w, i) => (
        <img
          key={i}
          src={WEAPON_SCHOOL_IMAGES[w]}
          alt={WEAPON_SCHOOL_LABELS[w]}
          title={WEAPON_SCHOOL_LABELS[w]}
          className="object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
          style={{ width: size, height: size }}
        />
      ))}
    </span>
  );

  // Колл-роли (Шотколлер / РЛ) — заметные цветные значки у имени
  const renderCallRoles = () => callRoles.length === 0 ? null : (
    <span className="inline-flex items-center gap-1 shrink-0">
      {callRoles.map(cr => {
        const st = CALL_ROLE_STYLES[cr];
        return (
          <span
            key={cr}
            title={CALL_ROLE_LABELS[cr]}
            className={`inline-flex items-center justify-center w-5 h-5 rounded-lg border text-[11px] ${st.bg} ${st.border} ${st.text}`}
          >
            <i className={`fa-solid ${CALL_ROLE_ICONS[cr]}`}></i>
          </span>
        );
      })}
    </span>
  );

  return (
    <div className={`p-3 rounded-lg border transition-colors ${isMe ? 'border-amber-500 ring-2 ring-amber-400/60 bg-amber-950/10' : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/80'} ${className}`}>
      <div className="flex justify-between items-start gap-2">
        {/* Левая часть: роль, имя, оружие. У недоступного гаснет всё, кроме бейджа:
            он должен читаться как выключенный, но причина обязана остаться видимой.
            Поэтому приглушение висит на самих элементах, а не на общей обёртке —
            прозрачность родителя изнутри уже не отменить. */}
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${away ? 'opacity-40' : ''}`} title={player.role}>
            {ROLE_ICONS[player.role]}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {/* Имя обрезается только если реально не влезает в доступную ширину (в узких
                  карточках Штаба войны), а в широких карточках состава видно целиком. */}
              <h4 className={`font-semibold leading-tight truncate min-w-0 ${away ? 'text-slate-500' : 'text-slate-100'}`}>{player.name}</h4>
              {away && player.unavailable && <UnavailableBadge unavailable={player.unavailable} compact={compact} />}
              {renderCallRoles()}
              {player.autoSignup && (
                <span title={t('Авто-запись «Иду» на все события')} className="inline-flex items-center justify-center w-5 h-5 rounded-lg border text-[11px] bg-emerald-950/30 border-emerald-700/60 text-emerald-300 shrink-0">
                  <i className="fa-solid fa-calendar-check"></i>
                </span>
              )}
            </div>
            {weapons.length > 0 && (
              <div className={`mt-1 ${away ? 'opacity-40' : ''}`}>{renderWeapons(compact ? 30 : 34)}</div>
            )}
          </div>
        </div>

        {/* Правая часть: кнопки и бейджи доп-ролей */}
        {(onEdit || onDelete || extra || onClaimSelf || onUnclaimSelf || onUnavailable) && (
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {(onEdit || onDelete || onClaimSelf || onUnclaimSelf || onUnavailable) && (
              <div className="flex gap-2 items-center">
                {onUnavailable && (
                  <button
                    onClick={() => onUnavailable(player)}
                    title={away ? t('Изменить недоступность') : t('Отметить недоступным')}
                    className={`transition-colors ${away ? 'text-slate-300 hover:text-white' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                    <i className="fa-solid fa-plane-departure"></i>
                  </button>
                )}
                {isMe ? (
                  onUnclaimSelf && (
                    <button onClick={onUnclaimSelf} title={t('Это не я — снять закрепление')} className="text-amber-400 hover:text-amber-300 transition-colors">
                      <i className="fa-solid fa-link-slash"></i>
                    </button>
                  )
                ) : (
                  onClaimSelf && (
                    <button onClick={onClaimSelf} title={t('Это я')} className="text-slate-500 hover:text-amber-400 transition-colors">
                      <i className="fa-solid fa-circle-user"></i>
                    </button>
                  )
                )}
                {onEdit && (
                  <button onClick={() => onEdit(player)} title={t('Редактировать')} className="text-slate-400 hover:text-white transition-colors">
                    <i className="fa-solid fa-pen-to-square"></i>
                  </button>
                )}
                {onDelete && (
                  <button onClick={() => onDelete(player.id)} title={t('Удалить')} className="text-slate-500 hover:text-red-400 transition-colors">
                    <i className="fa-solid fa-trash-can"></i>
                  </button>
                )}
              </div>
            )}
            {/* Правая колонка не сжимается, поэтому её ширина напрямую отнимается у имени.
                В компактной карточке (штаб войны) держим её узкой: бейджи там становятся
                в столбик, зато имя остаётся видно. Имя — то, ради чего на карточку и
                смотрят; при широком лимите боец с лесом и боссом превращался в «..». */}
            {extra && (
              <div className={`flex flex-wrap justify-end gap-1 ${compact ? 'max-w-[116px]' : 'max-w-[170px]'}`}>{extra}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PlayerCard;
