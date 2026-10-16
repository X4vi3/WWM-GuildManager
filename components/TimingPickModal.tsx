import React, { useEffect, useState } from 'react';
import { WAR_TIMINGS, TIMING_LABELS } from '../constants';
import { useT } from '../services/i18n';

// «Укажите тайминги» — окно, которое появляется при выборе лагеря в карточке бойца.
//
// Зачем спрашивать, а не подразумевать «на всё». Карточка — быстрый путь: в атаке лес
// расписывают в два клика и вглубь не лезут. Но у дефа один и тот же человек на старте
// стоит на дальнем топе, а с 25-й уходит на ближний, и молчаливое «на всё» такую правку
// тихо затирало бы. Спросив один раз, мы делаем выбор видимым.
//
// Окно не тормозит работу с пачкой: выделив семерых и ткнув лагерь, офицер отвечает на
// вопрос ОДИН раз на всю пачку, а не семь.
//
// Все тайминги отмечены заранее — «на всё» остаётся действием по умолчанию, и подпись
// кнопки честно меняется, чтобы не пришлось держать рядом две.

interface Props {
  title: string;      // куда ставим — «Топ лес (дальний)» и т.п.
  hint?: string;      // что сейчас стоит у бойца, если стоит
  onApply: (timings: string[]) => void;
  onClose: () => void;
}

const TimingPickModal: React.FC<Props> = ({ title, hint, onApply, onClose }) => {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set(WAR_TIMINGS as string[]));
  const all = picked.size === (WAR_TIMINGS as string[]).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && picked.size) onApply([...picked]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onApply, picked]);

  const toggle = (tm: string) => setPicked(prev => {
    const next = new Set(prev);
    next.has(tm) ? next.delete(tm) : next.add(tm);
    return next;
  });

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
          <h3 className="cinzel text-lg text-slate-100">{t('Укажите тайминги')}</h3>
          <p className="text-xs text-slate-400 mt-1">
            {title}{hint ? ` · ${hint}` : ''}
          </p>

          <div className="mt-6 grid grid-cols-3 gap-2">
            {(WAR_TIMINGS as string[]).map(tm => {
              const on = picked.has(tm);
              return (
                <button
                  key={tm}
                  onClick={() => toggle(tm)}
                  className={`py-3 rounded-lg text-xs font-semibold border transition-colors duration-200 tnum
                    ${on ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'}`}
                >
                  {TIMING_LABELS[tm]}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setPicked(all ? new Set() : new Set(WAR_TIMINGS as string[]))}
            className="mt-3 text-xs text-slate-500 hover:text-amber-400 transition-colors"
          >
            {all ? t('Снять все') : t('Отметить все')}
          </button>

          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-3 rounded-lg text-xs font-semibold border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
            >
              {t('Отмена')}
            </button>
            <button
              onClick={() => onApply([...picked])}
              disabled={picked.size === 0}
              className="px-6 py-3 rounded-lg text-xs font-semibold bg-amber-600 border border-amber-500 text-white hover:bg-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {all ? t('На всё') : `${t('Применить')} (${picked.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimingPickModal;
