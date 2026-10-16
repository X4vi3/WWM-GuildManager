import React, { useCallback, useId, useRef, useState } from 'react';
import { useT } from '../services/i18n';
import Floating from './Floating';

// Значок «?» рядом с настройкой: по наведению (или с клавиатуры) показывает пояснение.
//
// Зачем отдельным компонентом. Половина настроек интеграций непонятна без контекста
// («роль для доступа» — доступа к чему?), а дописывать к каждой абзац прозы — это
// вернуть тот самый шум, от которого страницу чистили. Пояснение по требованию решает
// оба: экран остаётся тихим, а ответ есть.
//
// Само всплывающее окно живёт в Floating — там же его позиционирование и закрытие
// по Escape/прокрутке.
//
// Доступность: значок — настоящая кнопка, открывается и по фокусу с клавиатуры, а не
// только по мыши. Текст связан с кнопкой через aria-describedby.

const Hint: React.FC<{ text: string }> = ({ text }) => {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={t('Пояснение')}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={close}
        onFocus={() => setOpen(true)}
        onBlur={close}
        // preventDefault обязателен: значок стоит и внутри <label> (галочка лички), а
        // клик по любому потомку label переключил бы саму галочку.
        //
        // Именно setOpen(true), а не переключение: на мыши наведение уже открыло
        // подсказку, и переключение по клику сразу же её закрывало — выглядело как
        // сломанная кнопка. Закрытие делают уход мыши, потеря фокуса, Escape и прокрутка.
        // На тач-устройствах наведения нет: там тап открывает, тап мимо — снимает фокус.
        onClick={e => { e.preventDefault(); setOpen(true); }}
        className="inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full border border-slate-700 text-slate-500 text-[11px] leading-none align-middle hover:text-amber-400 hover:border-amber-700 focus:outline-none focus:text-amber-400 focus:border-amber-700 transition-colors"
      >
        ?
      </button>
      <Floating anchor={btnRef} open={open} onClose={close} id={id} className="whitespace-pre-line">
        {text}
      </Floating>
    </>
  );
};

export default Hint;
