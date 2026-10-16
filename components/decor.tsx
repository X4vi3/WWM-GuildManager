import React from 'react';

// Декоративные wuxia-элементы: чернильный мазок и иероглиф-водяной знак.
//
// Иероглифы и их смыслы (проверены, традиционное написание — как в первоисточниках жанра):
//   風 fēng — «ветер» (отсылка к названию игры Where Winds Meet)
//   盟 méng — «союз/альянс» (гильдия; из 聯盟 — альянс)
//   戰 zhàn — «война/битва» (упрощ. 战)
//   陣 zhèn — «боевое построение/расстановка» (упрощ. 阵)
//   圖 tú  — «карта/чертёж» (из 地圖 — карта; упрощ. 图)
export const GLYPHS = {
  wind: '風',
  guild: '盟',
  war: '戰',
  formation: '陣',
  map: '圖'
} as const;

// Линейка под заголовком раздела.
//
// Раньше здесь был жирный «мазок туши» — две волнистые оранжевые кривые в 3.5px.
// На экране он читался не как приём, а как криво нарисованная закорючка, и спорил с
// самим заголовком. Уся-мотив в проекте теперь держит один элемент — иероглиф-водяной
// знак ниже; линейка же просто отбивает заголовок и молчит.
export const InkStroke: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span aria-hidden className={`block h-px w-full bg-amber-900/40 ${className}`} />
);

// Иероглиф-водяной знак на панели. Родитель должен быть relative + overflow-hidden.
//
// Это единственный декоративный приём, оставленный в приложении намеренно: он один
// несёт уся-мотив, поэтому всё остальное вокруг молчит. Размытие убрано — на 6%
// прозрачности размывать нечего, а нерезкий знак читался как артефакт рендера.
export const Watermark: React.FC<{ glyph: string; className?: string; size?: number }> = ({
  glyph, className = '', size = 96
}) => (
  <span
    aria-hidden
    className={`absolute pointer-events-none select-none leading-none ${className}`}
    style={{
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: size,
      opacity: 0.05
    }}
  >
    {glyph}
  </span>
);
