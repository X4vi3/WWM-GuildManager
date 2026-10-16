import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Всплывающий блок, привязанный к элементу-триггеру.
//
// Выделен из Hint: логика тут не в разметке, а в трёх граблях, на которые второй
// раз наступать не хочется.
//
// Почему position: fixed, а не absolute. Блок позиционируется по координатам
// триггера через getBoundingClientRect, поэтому не зависит от overflow родителей.
// В этом проекте уже было, что карточка обрезала выпадающий список — и карточка
// игрока в Штабе войны как раз такая, с обрезкой.
//
// Замер до отрисовки (useLayoutEffect): иначе блок успевает мигнуть в левом
// верхнем углу.
//
// Прокрутка и изменение размера окна закрывают блок: триггер уехал бы, а блок
// остался висеть на месте.

interface FloatingProps {
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number;
  id?: string;
  role?: string;
  className?: string;
  children: React.ReactNode;
}

const GAP = 6;
const MARGIN = 8;

const Floating: React.FC<FloatingProps> = ({
  anchor, open, onClose, width = 280, id, role = 'tooltip', className = '', children
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 80;
    const below = r.bottom + h + GAP < window.innerHeight;
    setPos({
      // Центрируем по триггеру, но не даём выйти за края окна
      left: Math.min(Math.max(MARGIN, r.left + r.width / 2 - width / 2), window.innerWidth - width - MARGIN),
      top: below ? r.bottom + GAP : Math.max(MARGIN, r.top - h - GAP)
    });
  }, [open, anchor, width, children]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const close = () => onClose();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      id={id}
      role={role}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width }}
      // pointer-events-none — чтобы сам блок не перехватывал мышь и не мешал
      // сработать mouseleave на триггере
      className={`z-[400] pointer-events-none bg-slate-800 border border-slate-700 rounded-lg shadow-lg px-3 py-2 text-xs text-slate-300 leading-relaxed ${className}`}
    >
      {children}
    </div>
  );
};

export default Floating;
