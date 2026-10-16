// Обложка видео — перенос один в один с десктопа (thumbs.py).
//
// Рисуем на canvas, а не свёрстанным блоком через html-to-image: макет один,
// фиксированный, 1280×720, и в нём важен попиксельный результат — обводка,
// тень, градиент по букве, автоподбор кегля. У html-to-image в этом проекте уже
// есть известная беда со шрифтами и внешними стилями (см. BattleOrderExport),
// а тут расхождение уедет на публичный канал.

const W = 1280;
const H = 720;
const FONT = 'Anton';
const OUTLINE = '#140d04';

// Фон приходит С СЕРВЕРА, а не из сборки. Раньше он импортировался из assets/,
// но эта папка у каждой установки своя и в гит не едет: другая гильдия не смогла
// бы подставить свою картинку, не пересобрав сайт, а сборка без файла падала бы.
export const BG_URL = '/api/yt/thumb/bg';

export interface ThumbStyle {
  guildName?: string;
  goldTop?: string;
  goldBottom?: string;
  vsColor?: string;
  hasBg?: boolean;
}

const cache = new Map<string, HTMLImageElement | null>();

// null — фона нет или он не загрузился. Это НЕ ошибка: обложка рисуется и на
// однотонной подложке, просто скромнее.
const loadBg = (url: string): Promise<HTMLImageElement | null> => {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { cache.set(url, img); resolve(img); };
    img.onerror = () => { cache.set(url, null); resolve(null); };
    img.src = url;
  });
};

const font = (px: number) => `${px}px "${FONT}", Impact, sans-serif`;

/** Подобрать кегль так, чтобы строка влезла по ширине. Шаг 2px, как на десктопе. */
const fitPx = (ctx: CanvasRenderingContext2D, text: string, maxW: number, maxPx: number, minPx = 24) => {
  let px = maxPx;
  while (px > minPx) {
    ctx.font = font(px);
    if (ctx.measureText(text).width <= maxW) break;
    px -= 2;
  }
  return px;
};

/** Высота строки. У canvas нет QFontMetrics, поэтому берём метрики шрифта. */
const lineHeight = (ctx: CanvasRenderingContext2D, px: number) => {
  ctx.font = font(px);
  const m = ctx.measureText('Ag');
  const asc = m.actualBoundingBoxAscent || px * 0.8;
  const desc = m.actualBoundingBoxDescent || px * 0.2;
  return { height: asc + desc * 1.4, ascent: asc };
};

/** Строка с тенью, тёмной обводкой и вертикальным градиентом — как в оригинале. */
const drawText = (
  ctx: CanvasRenderingContext2D, text: string, px: number, topY: number,
  topColor: string, bottomColor: string
) => {
  ctx.font = font(px);
  const { height, ascent } = lineHeight(ctx, px);
  const w = ctx.measureText(text).width;
  const x = (W - w) / 2;
  const baseline = topY + ascent;

  ctx.save();
  ctx.translate(0, Math.max(3, px * 0.045));
  ctx.fillStyle = 'rgba(0,0,0,0.67)';
  ctx.fillText(text, x, baseline);
  ctx.restore();

  ctx.lineWidth = Math.max(4, px * 0.09);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(text, x, baseline);

  const grad = ctx.createLinearGradient(0, topY, 0, topY + height);
  grad.addColorStop(0, topColor);
  grad.addColorStop(1, bottomColor);
  ctx.fillStyle = grad;
  ctx.fillText(text, x, baseline);
  return height;
};

/** «VS» с горизонтальными линиями по бокам. */
const drawVs = (ctx: CanvasRenderingContext2D, px: number, topY: number, vsColor: string) => {
  ctx.font = font(px);
  const { height, ascent } = lineHeight(ctx, px);
  const w = ctx.measureText('VS').width;
  const x = (W - w) / 2;

  ctx.lineWidth = Math.max(3, px * 0.09);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText('VS', x, topY + ascent);
  ctx.fillStyle = vsColor;
  ctx.fillText('VS', x, topY + ascent);

  const cy = topY + height / 2;
  ctx.strokeStyle = vsColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - 24 - 90, cy); ctx.lineTo(x - 24, cy);
  ctx.moveTo(x + w + 24, cy); ctx.lineTo(x + w + 24 + 90, cy);
  ctx.stroke();
};

/** Шрифт должен быть готов до замеров, иначе кегль подберётся под запасной. */
export const ensureFont = async () => {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try { await (document as any).fonts.load(`100px "${FONT}"`); } catch { /* обойдёмся запасным */ }
};

export const renderThumb = async (
  { enemy = '', nick = '', date = '', style = {} }:
  { enemy?: string; nick?: string; date?: string; style?: ThumbStyle }
): Promise<HTMLCanvasElement> => {
  await ensureFont();
  const image = style.hasBg === false ? null : await loadBg(BG_URL);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas недоступен');

  if (image) {
    ctx.drawImage(image, 0, 0, W, H);
  } else {
    // Фон не загружен — рисуем спокойную подложку, чтобы текст всё равно читался
    const flat = ctx.createLinearGradient(0, 0, 0, H);
    flat.addColorStop(0, '#1e1c1a');
    flat.addColorStop(1, '#0b0b0b');
    ctx.fillStyle = flat;
    ctx.fillRect(0, 0, W, H);
  }

  // Затемнение, чтобы надпись читалась на любом кадре
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, 'rgba(0,0,0,0.27)');
  v.addColorStop(0.5, 'rgba(0,0,0,0.37)');
  v.addColorStop(1, 'rgba(0,0,0,0.59)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  const rad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.62);
  rad.addColorStop(0, 'rgba(0,0,0,0.43)');
  rad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'alphabetic';
  const goldTop = style.goldTop || '#FFEFB0';
  const goldBottom = style.goldBottom || '#E0A028';
  const vsColor = style.vsColor || '#F07178';
  // Название гильдии задаёт офицер. Пустое — просто не рисуем строку: чужое
  // имя на обложке хуже, чем его отсутствие.
  const g = String(style.guildName || '').trim().toUpperCase();
  const e = enemy.trim().toUpperCase();

  const guildPx = g ? fitPx(ctx, g, W * 0.72, 92) : 0;
  const vsPx = Math.max(30, Math.round((guildPx || 92) * 0.72));
  const enemyPx = e ? fitPx(ctx, e, W * 0.9, 150) : 0;

  const hGuild = g ? lineHeight(ctx, guildPx).height : 0;
  const hVs = lineHeight(ctx, vsPx).height;
  const hEnemy = e ? lineHeight(ctx, enemyPx).height : 0;

  const gap = Math.round(vsPx * 0.5);
  const total = (g ? hGuild + gap : 0) + hVs + (e ? gap + hEnemy : 0);
  let y = (H - total) / 2;

  if (g) {
    y += drawText(ctx, g, guildPx, y, goldTop, goldBottom);
    y += gap;
  }
  drawVs(ctx, vsPx, y, vsColor);
  y += hVs;
  if (e) {
    y += gap;
    drawText(ctx, e, enemyPx, y, '#FFFFFF', '#D7DCE6');
  }

  // Подпись в углу: ник и дата
  const corner = [nick.trim(), date.trim()].filter(Boolean).join(' · ');
  if (corner) {
    ctx.font = 'bold 22px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(corner).width;
    ctx.fillStyle = 'rgba(0,0,0,0.67)';
    ctx.fillText(corner, W - tw - 21, H - 21);
    ctx.fillStyle = '#E6E1D4';
    ctx.fillText(corner, W - tw - 22, H - 22);
  }

  return canvas;
};

export const thumbBlob = async (opts: Parameters<typeof renderThumb>[0]): Promise<Blob | null> => {
  try {
    const canvas = await renderThumb(opts);
    return await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  } catch {
    return null;   // обложка не критична: видео уже зальётся
  }
};
