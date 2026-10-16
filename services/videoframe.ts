// Кадр из локального файла — чтобы видеть, ЧТО за запись, а не только обложку,
// которую мы сами и нарисовали.
//
// Ничего никуда не уходит: браузер умеет открыть файл с диска по blob-адресу и
// декодировать его сам. Файл при этом целиком в память НЕ читается — элемент
// <video> тянет только те куски, которые нужны для нужной секунды, поэтому кадр
// из четырёхгигабайтного клипа стоит примерно столько же, сколько из стамегабайтного.

/** Куда перематываем: доля от длительности. Начало боя — это загрузка и чёрный экран. */
const AT = 0.25;

/** Ширина картинки. Больше незачем: она показывается плиткой в карточке. */
const W = 480;

/** Сколько ждём. Кодек может оказаться неподдерживаемым, и тогда ждать нечего. */
const TIMEOUT_MS = 12_000;

/**
 * Достать кадр из файла. Возвращает data-URL или пустую строку.
 *
 * Пустая строка — это НЕ ошибка и не повод ругаться: браузер играет только те
 * кодеки, которые знает. Запись с HEVC там, где системного декодера нет, кадра
 * не даст, и карточка спокойно покажет нарисованную обложку.
 */
export const grabFrame = (file: File): Promise<string> => new Promise((resolve) => {
  if (typeof document === 'undefined') return resolve('');

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  let done = false;

  const finish = (data: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    video.removeAttribute('src');
    video.load();               // отпускаем декодер, иначе он живёт до сборки мусора
    URL.revokeObjectURL(url);
    resolve(data);
  };

  const timer = setTimeout(() => finish(''), TIMEOUT_MS);

  video.preload = 'metadata';
  video.muted = true;
  (video as any).playsInline = true;

  video.onloadedmetadata = () => {
    const d = Number(video.duration);
    // Живая трансляция или битые метаданные дают Infinity — тогда просто с начала
    const at = Number.isFinite(d) && d > 1 ? Math.min(d * AT, d - 0.2) : 0;
    try { video.currentTime = at; } catch { finish(''); }
  };

  video.onseeked = () => {
    try {
      const ratio = video.videoHeight / video.videoWidth || 9 / 16;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = Math.round(W * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return finish('');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', 0.7));
    } catch {
      // Кадр из защищённого источника канвас «пачкает» и наружу не отдаёт
      finish('');
    }
  };

  video.onerror = () => finish('');
  video.src = url;
});
