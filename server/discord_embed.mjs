// Вёрстка анонса события для Discord: текст-пинг, embed и кнопки записи.
// Вынесено отдельно от транспорта (discord.mjs), чтобы можно было проверять
// вёрстку тестами, не поднимая сеть.
//
// Ключевые решения:
//  - Время — родными метками Discord <t:unix:F> / <t:unix:R>. Каждый видит
//    в своём поясе, и RU/FR-проблема закрывается без единой строчки кода.
//  - Ники — через <@id>, если игрок привязал Discord. Такое упоминание
//    рендерится красиво и НЕ пингует (пинг только у роли в тексте над карточкой).
//  - Порядковые номера берутся из времени заявки (signupMeta.at).

import { langPack } from './botlang.mjs';

const TYPE_EMOJI = { prak: '⚔️', ranked: '🏅', league: '🏆' };
const TYPE_COLOR = { prak: 0xd97706, ranked: 0x2563eb, league: 0x7c3aed };
const TYPE_KEY = { prak: 'typePrak', ranked: 'typeRanked', league: 'typeLeague' };

// Колонки основного состава — по боевым ролям.
//
// emojiName — имя эмодзи приложения с иконкой роли, той же, что на сайте (заливается
// кнопкой «Загрузить иконки» на странице интеграций). Пока иконки не залиты,
// подставляется стандартное эмодзи: анонс должен выходить и без них.
const ROLE_COLUMNS = [
  { role: 'Tank', emoji: '🛡️', emojiName: 'role_tank', key: 'colTanks' },
  { role: 'DPS', emoji: '⚔️', emojiName: 'role_dps', key: 'colDps' },
  { role: 'Healer', emoji: '💚', emojiName: 'role_heal', key: 'colHeals' }
];

// Значок роли: своё эмодзи, если загружено, иначе стандартное. Стандартные Unicode
// Discord рисует заметно крупнее кастомных, поэтому свои ещё и аккуратнее смотрятся.
const roleIcon = (col, emojis) =>
  emojis?.[col.emojiName] ? `<:${col.emojiName}:${emojis[col.emojiName]}>` : col.emoji;

// Прочие статусы — отдельными строками под составом.
//
// «Не идут» помечен quiet: этот статус единственный, который ни на что не влияет при
// планировании (в отличие от «под вопросом» и «замены», где человека ещё можно
// дожать), поэтому он подаётся тише. Единственный способ сделать в embed текст
// МЕЛЬЧЕ и СЕРЕЕ — разметка subtext Discord: строка, начинающаяся с «-# ». Размера
// шрифта и цвета текста у полей embed нет (цветом управляется только полоска слева),
// поэтому вариантов ровно два: subtext или ничего.
//
// У quiet-статуса подпись со счётчиком уезжает внутрь самой строки, а имя поля
// остаётся пустым: имена полей Discord всегда рисует жирным и разметку в них не
// разбирает, так что жирное «Не идут — 35» продолжало бы цеплять глаз.
const OTHER_STATUSES = [
  { key: 'maybe', emoji: '❓', labelKey: 'stMaybe' },
  { key: 'sub', emoji: '🔄', labelKey: 'stSub' },
  { key: 'out', emoji: '❌', labelKey: 'stOut', quiet: true }
];

// Пустое имя поля: Discord не принимает пустую строку, поэтому символ нулевой ширины.
const BLANK_FIELD_NAME = '​';
// Разметка Discord «мелким серым» — работает только в начале строки.
const SUBTEXT = '-# ';

const CALL_ROLE_EMOJI = { shotcaller: '📣', rl: '👑' };
const SUB_ROLE_EMOJI = { jungle: '🌲', boss: '🐉', tower: '🗼' };

// Лимиты Discord: 1024 символа на поле, 6000 на весь embed, 25 полей.
const FIELD_LIMIT = 1024;
const EMBED_LIMIT = 6000;
// Запас под то, что мы не считаем (метки времени, служебные поля).
const EMBED_RESERVE = 120;

// Сколько символов embed уже занято. Discord складывает заголовок, описание, имя
// автора, подвал и ВСЕ поля вместе, и при перерасходе отклоняет сообщение целиком —
// то есть анонс просто не выйдет. Пока состав был единственным списком, до лимита
// было далеко; со списками ников по статусам — уже нет, поэтому считаем явно.
const embedUsed = (parts) =>
  (parts.title || '').length +
  (parts.description || '').length +
  (parts.author || '').length +
  (parts.footer || '').length +
  (parts.fields || []).reduce((s, f) => s + String(f.name).length + String(f.value).length, 0);

// Обрезаем список строк так, чтобы уложиться в лимит поля, и честно сообщаем,
// сколько человек не поместилось (молча терять людей из состава нельзя).
const fitLines = (lines, L = langPack('ru')) => {
  if (lines.length === 0) return L.empty;
  const out = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const more = L.andMore(lines.length - i);
    // Хватит ли места на строку, а следом ещё и на пометку об остатке
    if (len + lines[i].length + 1 > FIELD_LIMIT - (more.length + 1)) {
      out.push(more);
      break;
    }
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return out.join('\n');
};

// То же, но ники в ОДНУ строку через запятую — для статусов «вопрос/замена/нет».
// budget задаётся снаружи: у этих полей остаток общего лимита embed может быть
// меньше 1024, и знать об этом должен вызывающий.
const fitInline = (names, L = langPack('ru'), budget = FIELD_LIMIT) => {
  if (names.length === 0) return L.empty;
  const limit = Math.min(FIELD_LIMIT, budget);
  const out = [];
  let len = 0;
  for (let i = 0; i < names.length; i++) {
    const more = L.andMore(names.length - i);
    // Хватит ли места на ник, а следом ещё и на пометку об остатке
    if (len + names[i].length + 2 > limit - (more.length + 2)) {
      out.push(more);
      break;
    }
    out.push(names[i]);
    len += names[i].length + 2;
  }
  // Совсем нет места даже на один ник — честно сообщаем количество, а не молчим
  return out.length ? out.join(', ') : L.andMore(names.length);
};

// Момент → метка Discord. :F — «29 июля 2026 г., 21:30», :R — «через 3 часа».
const ts = (iso, style) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;

const esc = (s) => String(s ?? '').replace(/([*_`~|\\])/g, '\\$1');

// Значки школ оружия: свои эмодзи приложения, если загружены, иначе ничего.
const weaponBadges = (player, emojis) => {
  if (!emojis) return '';
  const parts = [];
  for (const w of (player.weapons || [])) {
    const id = emojis[w];
    if (id) parts.push(`<:${w}:${id}>`);
  }
  return parts.length ? ' ' + parts.join('') : '';
};

// Доп-роли (лес/босс/тавер) берутся из расстановки в штабе войны, а не из заявки
const subRoleBadges = (session, playerId) => {
  const a = (session.assignments || []).find(x => x.playerId === playerId);
  if (!a) return '';
  const subs = a.subRoles || (a.subRole ? [a.subRole] : []);
  const parts = subs.map(s => SUB_ROLE_EMOJI[s]).filter(Boolean);
  if (a.carriesChicken) parts.push('🐔');
  return parts.length ? ' ' + parts.join('') : '';
};

const callRoleBadges = (player) =>
  (player.callRoles || []).map(r => CALL_ROLE_EMOJI[r]).filter(Boolean).join('');

// Игроки с нужным статусом, в порядке подачи заявки (по signupMeta.at).
// Без меты (заявки, сделанные до появления поля) — в конец, по алфавиту.
const orderedFor = (session, players, status) => {
  const byId = new Map(players.map(p => [p.id, p]));
  const meta = session.signupMeta || {};
  const rows = [];
  for (const [pid, st] of Object.entries(session.signups || {})) {
    if (st !== status) continue;
    const player = byId.get(pid);
    if (!player) continue; // игрока удалили из состава — в анонсе не показываем
    rows.push({ player, at: meta[pid]?.at || '' });
  }
  rows.sort((a, b) => {
    if (a.at && b.at) return a.at.localeCompare(b.at);
    if (a.at) return -1;
    if (b.at) return 1;
    return a.player.name.localeCompare(b.player.name);
  });
  return rows.map(r => r.player);
};

// Ник как его показывать в Discord: упоминанием, если игрок привязал аккаунт (тогда
// его видно кликабельно и без пинга), иначе просто именем из состава.
const displayName = (player, links) => {
  const discordId = links?.[player.id];
  return discordId ? `<@${discordId}>` : esc(player.name);
};

// Одна строка участника: «3. 📣 @Ник 🎋🗡 🌲»
const playerLine = (n, player, session, links, emojis) => {
  const call = callRoleBadges(player);
  return `${n}. ${call ? call + ' ' : ''}${displayName(player, links)}${weaponBadges(player, emojis)}${subRoleBadges(session, player.id)}`;
};

// Войны идут 30 на 30 — от этого считается прогресс набора
const ROSTER_TARGET = 30;

// Текстовый индикатор набора: ▰▰▰▰▱▱▱▱▱▱ 12 / 30
const progressBar = (n, target) => {
  const filled = Math.max(0, Math.min(10, Math.round((n / target) * 10)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}  **${n} / ${target}**`;
};

export const buildAnnounce = (session, players, opts = {}) => {
  const { closed = false, links = {}, emojis = null, pingRoleId = '', siteUrl = '', lang = 'ru' } = opts;
  const L = langPack(lang);
  const ev = session.event || {};
  const type = ev.type || 'prak';
  const typeLabel = L[TYPE_KEY[type]] || L.event;

  // Раскладка «две зоны»: шапка (тип мелко над заголовком, время, прогресс набора),
  // ниже — состав тремя колонками, а под ним ответившие «вопрос/замена/нет» — каждый
  // статус отдельной строкой ников. Раньше они были свёрнуты в одни счётчики, из
  // соображения «для планирования важен состав, а не список отказов»; на практике
  // офицеру нужно видеть именно кто ответил, чтобы понимать, кого дожимать.
  // Билдов у них нет намеренно: школы и доп-роли значимы только для основы, а список
  // из тридцати ников со значками превратил бы карточку в стену.
  const title = type === 'prak' && ev.opponent
    ? `vs ${esc(ev.opponent)}`
    : esc(session.name || typeLabel);

  const goingAll = orderedFor(session, players, 'in');

  const descParts = [];
  if (ev.startsAt) descParts.push(`🗓 ${ts(ev.startsAt, 'F')} · ${ts(ev.startsAt, 'R')}`);
  else if (ev.date || ev.time) descParts.push(`🗓 ${esc([ev.date, ev.time].filter(Boolean).join(' '))}`);
  if (ev.note) descParts.push(`📝 ${esc(ev.note)}`);
  descParts.push('', progressBar(goingAll.length, ROSTER_TARGET));
  if (closed) descParts.push('', L.closed);

  // Зона состава — три колонки по ролям, сквозная нумерация внутри колонки
  const fields = [];
  for (const col of ROLE_COLUMNS) {
    const list = goingAll.filter(p => p.role === col.role);
    fields.push({
      name: `${roleIcon(col, emojis)} ${L[col.key]} — ${list.length}`,
      value: fitLines(list.map((p, i) => playerLine(i + 1, p, session, links, emojis)), L),
      inline: true
    });
  }

  // Остальные ответы: на каждый статус — своя строка с никами через запятую, как это
  // давно делает Телеграм (announceText в telegram.mjs), чтобы два бота показывали
  // одно и то же. Статусы, по которым никто не ответил, не показываем вовсе.
  const authorName = `${TYPE_EMOJI[type]} ${typeLabel.toUpperCase()}`;
  const description = descParts.join('\n') || undefined;
  const footerText = L.goingCount(goingAll.length);
  let used = embedUsed({ title, description, author: authorName, footer: footerText, fields });

  for (const st of OTHER_STATUSES) {
    const list = orderedFor(session, players, st.key);
    if (list.length === 0) continue;
    // У тихой строки эмодзи убрано: Unicode Discord рисует в полный размер, и
    // рядом с мелким серым текстом ❌ смотрелся втрое крупнее самой строки.
    const label = st.quiet
      ? `${L[st.labelKey]} — ${list.length}`
      : `${st.emoji} ${L[st.labelKey]} — ${list.length}`;
    const name = st.quiet ? BLANK_FIELD_NAME : label;
    const prefix = st.quiet ? `${SUBTEXT}${label} · ` : '';
    // Остаток общего лимита embed под этот список — с учётом того, что подпись
    // quiet-статуса живёт внутри значения и тоже занимает место. Если места не
    // осталось совсем, поле не добавляем: лучше карточка без строки отказов, чем
    // анонс, который Discord отклонит целиком.
    const room = Math.min(
      FIELD_LIMIT - prefix.length,
      EMBED_LIMIT - EMBED_RESERVE - used - name.length - prefix.length
    );
    if (room <= 0) break;
    const value = prefix + fitInline(list.map(p => displayName(p, links)), L, room);
    fields.push({ name, value, inline: false });
    used += name.length + value.length;
  }

  const embed = {
    author: { name: authorName },
    title,
    description,
    color: TYPE_COLOR[type] ?? 0x64748b,
    fields,
    footer: { text: footerText },
    // Discord сам покажет «· сегодня в 21:00» рядом с подвалом — видно свежесть карточки
    timestamp: new Date().toISOString()
  };

  const components = closed ? [] : [{
    type: 1, // ряд кнопок
    components: [
      { type: 2, style: 3, label: L.btnIn, emoji: { name: '✅' }, custom_id: `sg:${session.id}:in` },
      { type: 2, style: 2, label: L.btnMaybe, emoji: { name: '❓' }, custom_id: `sg:${session.id}:maybe` },
      { type: 2, style: 2, label: L.btnSub, emoji: { name: '🔄' }, custom_id: `sg:${session.id}:sub` },
      { type: 2, style: 4, label: L.btnOut, emoji: { name: '❌' }, custom_id: `sg:${session.id}:out` }
    ]
  }];

  // Ссылка на сайт — отдельной кнопкой-ссылкой, она живёт и после закрытия
  if (siteUrl) {
    components.push({
      type: 1,
      components: [{ type: 2, style: 5, label: L.openOnSite, url: siteUrl }]
    });
  }

  return {
    // Пинг роли — только в тексте над карточкой. Внутри embed упоминания не пингуют.
    content: pingRoleId && !closed ? `<@&${pingRoleId}>` : '',
    embeds: [embed],
    components,
    // Страхуемся: разрешаем пинговать ровно одну настроенную роль и никого больше
    allowed_mentions: pingRoleId && !closed ? { parse: [], roles: [pingRoleId] } : { parse: [] }
  };
};

export const __test = { fitLines, fitInline, orderedFor, embedUsed, FIELD_LIMIT, EMBED_LIMIT };
