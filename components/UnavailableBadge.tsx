import React, { useCallback, useId, useRef, useState } from 'react';
import { Unavailable } from '../types';
import { useLang } from '../services/i18n';
import { fmtDay } from '../services/datetime';
import Floating from './Floating';

// Значок «недоступен» у имени игрока. По наведению — карточка с причиной и сроком.
//
// Почему slate, а не цвет. Набор смысловых цветов в проекте закрыт, и все семь заняты
// (amber — бренд и режим офицера, red — атака и опасность, sky — деф и «на замену»,
// emerald — «иду», indigo — Discord, fuchsia — лига и босс). Недоступность — это
// «приглушённое, выключенное», то есть ровно slate. Заодно она и не должна кричать:
// человек в отпуске — не авария.
//
// Почему причина не влезает в сам бейдж. Карточка игрока стоит и в узкой колонке
// Штаба войны, где на имя-то не всегда хватает места. В бейдже — только срок, всё
// остальное по наведению.

const UnavailableBadge: React.FC<{ unavailable: Unavailable; compact?: boolean }> = ({ unavailable, compact = false }) => {
  const { t, lang } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const until = unavailable.until ? fmtDay(unavailable.until, lang) : '';
  const short = until ? `${t('Вернётся')} ${until}` : t('Недоступен');

  return (
    <>
      <span
        ref={ref}
        // tabIndex — чтобы причину можно было прочитать с клавиатуры, а не только мышью
        tabIndex={0}
        role="button"
        // Пустой title гасит НАСЛЕДУЕМУЮ подсказку предка. В Штабе войны на обёртке
        // карточки висит нативный title («Клик — выбрать… перетащите в группу»), и без
        // этого браузер показывал его поверх нашей карточки — ровно на том месте, где
        // написана дата возвращения. По стандарту title="" означает «подсказки нет» и
        // перебивает предка; убирать title у самой карточки нельзя, он там по делу.
        title=""
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={close}
        onFocus={() => setOpen(true)}
        onBlur={close}
        className={`inline-flex items-center gap-1 shrink-0 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 text-[11px] leading-none focus:outline-none focus:border-slate-600 transition-colors ${compact ? 'px-1 py-1' : 'px-2 py-1'}`}
      >
        <i className="fa-solid fa-plane-departure"></i>
        {!compact && <span>{short}</span>}
      </span>
      <Floating anchor={ref} open={open} onClose={close} id={id}>
        <div className="text-slate-200">
          {until ? `${t('Недоступен, вернётся')} ${until}` : t('Недоступен бессрочно')}
        </div>
        {unavailable.note && (
          <div className="mt-1 whitespace-pre-line break-words">{unavailable.note}</div>
        )}
        <div className="mt-1 text-slate-500">
          {t('Пометка поставлена')} {fmtDay(unavailable.since.slice(0, 10), lang)}
        </div>
      </Floating>
    </>
  );
};

export default UnavailableBadge;
