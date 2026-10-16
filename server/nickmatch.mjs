// Подбор ника в составе по тому, что человек напечатал в анкете.
//
// Зачем отдельным файлом: сети здесь нет вовсе, поэтому подбор можно гонять тестами
// (как вёрстку анонса в discord_embed.mjs). А проверять тут есть что — цена ошибки
// высокая: не нашли человека, значит завели ему дубль, а дубль потом руками сливать.
//
// Что ломалось раньше. Поиск был «точное совпадение, иначе имя СОДЕРЖИТ введённое»,
// и он промахивался в трёх обычных случаях:
//   1. напечатали длиннее, чем записано: в составе «Kaito», ввели «Kaitos» —
//      'kaito'.includes('kaitos') === false, человек уходил заводить дубль;
//   2. похожие буквы: заглавные А, В, Е, К, М, Н, О, Р, С, Т, У, Х в кириллице и
//      латинице выглядят ОДИНАКОВО. Ник, набранный в другой раскладке, не находился
//      никогда — для русскоязычной гильдии это главный источник дублей;
//   3. опечатка в один символ давала «тебя нет в составе».

// Кириллические буквы, неотличимые на глаз от латинских (после приведения к нижнему
// регистру: заглавная «В» → «в» → 'b'). Обе стороны сравнения сводятся к латинице,
// поэтому раскладка перестаёт иметь значение.
const LOOKALIKE = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o',
  р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's'
};

// Ник → сравнимый вид: нижний регистр, без диакритики, без клан-тегов в скобках,
// без пробелов и знаков, похожие буквы сведены к латинице.
export const normalizeNick = (s) => {
  let v = String(s ?? '').toLowerCase();
  v = v.replace(/[[({<][^\])}>]*[\])}>]/g, ' ');       // «[WWM] Ник», «(альт) Ник»
  v = v.normalize('NFD').replace(/[̀-ͯ]/g, '');   // é → e
  v = v.replace(/[Ѐ-ӿ]/g, (c) => LOOKALIKE[c] || c);
  // Оставляем латиницу, цифры и ту кириллицу, у которой латинского двойника нет
  return v.replace(/[^a-z0-9Ѐ-ӿ]/g, '');
};

// Расстояние Левенштейна с ранним выходом: если минимум в строке уже больше
// допустимого, дальше считать незачем. На составе в сотню ников это мгновенно.
export const editDistance = (a, b, limit = Infinity) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return limit + 1;
    prev = cur.slice();
  }
  return prev[b.length];
};

// Насколько ник похож на запрос. Меньше — ближе; Infinity — не показывать вовсе.
// Ступени намеренно разнесены: точное совпадение обязано стоять выше любого «похоже»,
// иначе человек с ником «Avi» увидит первым «Avicenna» и нажмёт не туда.
export const matchScore = (query, name) => {
  const q = normalizeNick(query);
  const n = normalizeNick(name);
  if (!q || !n) return Infinity;
  if (q === n) return 0;

  const diff = Math.abs(n.length - q.length) / 100;   // при равной ступени короче = ближе
  if (n.startsWith(q) || q.startsWith(n)) return 1 + diff;
  if (n.includes(q) || q.includes(n)) return 2 + diff;

  // Допуск на опечатки: два символа, а для длинных ников — треть длины.
  const limit = Math.max(2, Math.floor(Math.max(q.length, n.length) / 3));
  const d = editDistance(q, n, limit);
  return d <= limit ? 3 + d : Infinity;
};

// Кандидаты для первого экрана анкеты: самые похожие, лучший первым.
// players — уже отфильтрованные (непривязанные), фильтровать здесь нечем и незачем.
export const rankRoster = (players, query, limit = 5) => {
  const raw = String(query ?? '').trim().toLowerCase();
  // Буква в букву — весомее любой нормализации: если в составе есть и «Kaito», и
  // «-Kaito», напечатавший «Kaito» должен увидеть первым именно себя. Нормализация
  // делает их неразличимыми, поэтому нужен отдельный признак.
  const literal = (p) => (String(p.name ?? '').trim().toLowerCase() === raw ? 0 : 1);
  return (players || [])
    .map((p) => ({ player: p, score: matchScore(query, p.name) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) =>
      a.score - b.score ||
      literal(a.player) - literal(b.player) ||
      String(a.player.name).length - String(b.player.name).length ||
      String(a.player.name).localeCompare(String(b.player.name)))
    .slice(0, limit)
    .map((x) => x.player);
};

// Разбивка всего состава на группы по алфавиту — под ограничение Discord в 25 пунктов
// на выпадающий список. Групп получается столько, сколько нужно, и каждая подписана
// диапазоном букв, чтобы человек сразу понял, куда смотреть. Альтернатива —
// листание кнопками «дальше» — требует помнить страницу и ломается на перезапуске.
export const alphaGroups = (players, perGroup = 25) => {
  const sorted = [...(players || [])].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), 'ru', { sensitivity: 'base' })
  );
  const out = [];
  for (let i = 0; i < sorted.length; i += perGroup) {
    const chunk = sorted.slice(i, i + perGroup);
    const first = String(chunk[0]?.name ?? '').charAt(0).toUpperCase();
    const last = String(chunk[chunk.length - 1]?.name ?? '').charAt(0).toUpperCase();
    out.push({ from: first, to: last, players: chunk });
  }
  return out;
};
