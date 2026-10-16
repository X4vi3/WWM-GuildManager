import React, { useEffect, useState } from 'react';
import { Player } from '../types';
import { useT } from '../services/i18n';

// Окно «Игрок недоступен»: отпуск, болезнь, жизненные обстоятельства.
//
// Одно окно на два сценария — офицер открывает его с любой карточки, игрок со своей.
// Разводить их в две формы значило бы, что поля разъедутся, а точка входа для игрока
// окажется беднее офицерской без всякой причины.
//
// Почему предупреждение про заявки стоит в самом окне, а не всплывает после. Пометка
// снимает человека с будущих событий и освобождает его место в группах, и отмены у
// этого нет. Человек должен знать это ДО нажатия, а не увидеть последствия постфактум.

interface Props {
  player: Player;
  onSave: (mark: { note: string; until: string } | null) => void;
  onClose: () => void;
  busy?: boolean;
}

const UnavailableModal: React.FC<Props> = ({ player, onSave, onClose, busy = false }) => {
  const t = useT();
  const [note, setNote] = useState(player.unavailable?.note ?? '');
  const [until, setUntil] = useState(player.unavailable?.until ?? '');
  const marked = !!player.unavailable;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[310] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-lg overflow-hidden animate-in zoom-in-95 duration-200"
      >
        <div className="p-6">
          <h3 className="cinzel text-lg text-slate-100">
            {player.name} {t('недоступен')}
          </h3>

          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="away-note" className="block text-xs text-slate-400">{t('Причина')}</label>
              <input
                id="away-note"
                autoFocus
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={200}
                placeholder={t('Например: улетел в отпуск')}
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-600 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="away-until" className="block text-xs text-slate-400">{t('Вернётся')}</label>
              <input
                id="away-until"
                type="date"
                value={until}
                onChange={e => setUntil(e.target.value)}
                className="mt-1 w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-slate-600 transition-colors"
              />
              {/* Подпись объясняет ровно то, что иначе выяснится опытным путём:
                  в день возвращения человек уже играет, и дату можно не ставить. */}
              <p className="mt-1 text-xs text-slate-500">
                {until
                  ? t('В этот день уже играет. События до него — отказ.')
                  : t('Без даты — бессрочно, пока не снимете.')}
              </p>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              {t('Будущие события в этот срок получат «Не иду», место в группах освободится. Вернуть их обратно можно только вручную.')}
            </p>
          </div>

          <div className="pt-5 flex gap-2">
            <button
              disabled={busy}
              onClick={() => onSave({ note: note.trim(), until })}
              className="flex-1 px-4 py-2 rounded-lg bg-amber-600 text-slate-950 text-sm font-semibold hover:bg-amber-500 disabled:opacity-50 transition-colors"
            >
              {marked ? t('Сохранить') : t('Отметить')}
            </button>
            {marked && (
              <button
                disabled={busy}
                onClick={() => onSave(null)}
                className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 text-sm hover:border-slate-600 disabled:opacity-50 transition-colors"
              >
                {t('Снова доступен')}
              </button>
            )}
            <button
              disabled={busy}
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-800 text-slate-400 text-sm hover:border-slate-700 disabled:opacity-50 transition-colors"
            >
              {t('Отмена')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnavailableModal;
