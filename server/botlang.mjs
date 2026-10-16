// Язык сообщений Discord-бота. Только Discord: в Телеграме сидит русская часть
// гильдии, там переключатель не нужен и не делается.
//
// Всё, что видит игрок в Discord, живёт здесь. Строки-функции принимают подстановки.

const RU = {
  // ---- Типы событий и роли ----
  typePrak: 'Прак', typeRanked: 'Ранкед', typeLeague: 'Лига', event: 'Событие',
  roleTank: 'Танк', roleDps: 'ДД', roleHeal: 'Хил',
  colTanks: 'Танки', colDps: 'ДД', colHeals: 'Хилы',

  // ---- Статусы ----
  stIn: 'Иду', stMaybe: 'Под вопросом', stSub: 'Замена', stOut: 'Не идут',
  btnIn: 'Иду', btnMaybe: 'Вопрос', btnSub: 'Замена', btnOut: 'Не иду',

  // ---- Анонс ----
  closed: '🔒 **Регистрация закрыта**',
  goingCount: (n) => `Идут: ${n}`,
  andMore: (n) => `…и ещё ${n}`,
  openOnSite: 'Открыть на сайте',
  empty: '—',

  // ---- Нажатие кнопки записи ----
  saved: (label) => `Записал: **${label}**.`,
  notLinked: 'Сначала привяжи свой ник — нажми кнопку регистрации в канале гильдии или зайди на сайт.',
  eventGone: 'Событие не найдено — возможно, его удалили.',
  regClosed: 'Регистрация на это событие уже закрыта.',
  playerGone: 'Твой ник пропал из состава — напиши офицеру.',
  unknownStatus: 'Неизвестный статус.',

  // ---- Регистрация ----
  regTitle: '📋 Регистрация в составе гильдии',
  regDesc:
    'Нажми кнопку и введи свой игровой ник — я найду тебя в составе и привяжу аккаунт. ' +
    'Если тебя ещё нет, спрошу роль и школы оружия и заведу карточку.\n\n' +
    'После привязки сможешь записываться на события кнопками под анонсами.',
  regGate: (roleId) => `\n\nКнопка работает у тех, у кого есть роль <@&${roleId}>.`,
  regButton: 'Зарегистрироваться',
  regNoAccess: 'Регистрация доступна только участникам гильдии. Если ты в гильдии, но кнопка не работает — напиши офицеру.',
  regModalTitle: 'Регистрация в гильдии',
  regNickLabel: 'Твой игровой ник',
  regNickPlaceholder: 'как в игре',
  regEmptyNick: 'Пустой ник — попробуй ещё раз.',
  // Анкета идёт лесенкой: похожие → весь состав → «я новенький». Заводить нового
  // игрока предлагаем последним, иначе человек с опечаткой делает себе дубль.
  regSimilar: (nick) => `Вот кто похож на **${nick}**. Нажми на себя:`,
  regNoneSimilar: (nick) => `Похожих на **${nick}** не нашёл. Посмотри весь состав — вдруг ты записан иначе.`,
  regNotMe: 'Меня здесь нет',
  regAllList: 'Весь состав. Найди себя в списке:',
  regAllEmpty: 'В составе не осталось свободных ников — похоже, ты новенький.',
  regNewbie: 'Я новенький',
  regGroup: (from, to) => `Ники ${from}–${to}`,
  regNickLost: 'Ник потерялся — начни заново кнопкой в канале.',
  regAskRoleAgain: 'Хорошо, заведём тебя заново. Кем играешь?',
  regRolePlaceholder: 'Боевая роль',
  regAskWeapons: 'Теперь выбери **две** школы оружия:',
  regWeaponsPlaceholder: 'Две школы',
  regNeedTwo: 'Нужно ровно две школы. Начни заново.',
  regLost: 'Анкета потерялась — начни заново кнопкой в канале.',
  regNickGone: 'Этого ника уже нет в составе. Попробуй заново.',
  regTaken: 'Этот ник уже привязан к другому аккаунту. Напиши офицеру.',
  regDone: (name) => `Готово! Ты привязан как **${name}**.\nТеперь жми кнопки под анонсами, чтобы записываться.`,
  regWasThere: (name) => `Ты уже был в составе — привязал как **${name}**.`,
  regCreated: (name, role) =>
    `Готово! Завёл тебя как **${name}** (${role}).\nТеперь жми кнопки под анонсами, чтобы записываться на события.`,
  regAlready: (name) => `Ты уже привязан как **${name}**.\nЖми кнопки под анонсами, чтобы записываться.`,
  unlink: 'Отвязать',
  unlinked: 'Отвязал. Можешь привязаться заново кнопкой в канале регистрации.',

  // ---- Личка и подписка ----
  subOn: '🔔 Личные напоминания **включены**.',
  subOff: '🔕 Личные напоминания выключены. Включи — и я буду присылать карточку события в личку.',
  subEnable: 'Включить напоминания',
  subDisable: 'Выключить напоминания',
  subNeedLink: 'Сначала привяжи ник.',
  subDone: '🔔 Готово! Буду присылать карточку события в личку — там же можно и ответить.',
  subGone: '🔕 Больше не пишу в личку. Включить обратно можно там же, где регистрировался.',
  subButton: 'Напоминания в личку',
  dmYourAnswer: (label) => `Твой ответ: **${label}**`,
  dmNoAnswer: '— не ответил —',
  dmFooter: 'Ответить можно прямо отсюда',

  notReady: 'Эта функция ещё настраивается. Загляни позже!'
};

const EN = {
  typePrak: 'Practice', typeRanked: 'Ranked', typeLeague: 'League', event: 'Event',
  roleTank: 'Tank', roleDps: 'DPS', roleHeal: 'Healer',
  colTanks: 'Tanks', colDps: 'DPS', colHeals: 'Healers',

  stIn: 'Going', stMaybe: 'Tentative', stSub: 'Bench', stOut: 'Not going',
  btnIn: 'Going', btnMaybe: 'Tentative', btnSub: 'Bench', btnOut: 'Not going',

  closed: '🔒 **Sign-ups closed**',
  goingCount: (n) => `Going: ${n}`,
  andMore: (n) => `…and ${n} more`,
  openOnSite: 'Open on the site',
  empty: '—',

  saved: (label) => `Saved: **${label}**.`,
  notLinked: 'Link your in-game name first — press the registration button in the guild channel, or use the site.',
  eventGone: 'Event not found — it may have been deleted.',
  regClosed: 'Sign-ups for this event are already closed.',
  playerGone: 'Your name is no longer on the roster — ask an officer.',
  unknownStatus: 'Unknown status.',

  regTitle: '📋 Guild roster registration',
  regDesc:
    'Press the button and type your in-game name — I will find you on the roster and link your account. ' +
    'If you are not there yet, I will ask for your role and weapon schools and create your card.\n\n' +
    'Once linked, you can sign up for events with the buttons under each announcement.',
  regGate: (roleId) => `\n\nThe button works for members with the <@&${roleId}> role.`,
  regButton: 'Register',
  regNoAccess: 'Registration is for guild members only. If you are in the guild but the button does not work, ask an officer.',
  regModalTitle: 'Guild registration',
  regNickLabel: 'Your in-game name',
  regNickPlaceholder: 'exactly as in game',
  regEmptyNick: 'Empty name — try again.',
  regSimilar: (nick) => `Here is who looks like **${nick}**. Tap yourself:`,
  regNoneSimilar: (nick) => `Nothing close to **${nick}**. Check the full roster — you may be listed differently.`,
  regNotMe: 'I am not here',
  regAllList: 'Full roster. Find yourself:',
  regAllEmpty: 'No unclaimed names left on the roster — looks like you are new.',
  regNewbie: 'I am new',
  regGroup: (from, to) => `Names ${from}–${to}`,
  regNickLost: 'Lost your name — start again with the button in the channel.',
  regAskRoleAgain: 'All right, let us add you from scratch. What do you play?',
  regRolePlaceholder: 'Combat role',
  regAskWeapons: 'Now pick **two** weapon schools:',
  regWeaponsPlaceholder: 'Two schools',
  regNeedTwo: 'Exactly two schools are required. Start over.',
  regLost: 'Your form was lost — start again with the button in the channel.',
  regNickGone: 'That name is no longer on the roster. Try again.',
  regTaken: 'That name is already linked to another account. Ask an officer.',
  regDone: (name) => `Done! You are linked as **${name}**.\nNow use the buttons under announcements to sign up.`,
  regWasThere: (name) => `You were already on the roster — linked you as **${name}**.`,
  regCreated: (name, role) =>
    `Done! Added you as **${name}** (${role}).\nNow use the buttons under announcements to sign up for events.`,
  regAlready: (name) => `You are already linked as **${name}**.\nUse the buttons under announcements to sign up.`,
  unlink: 'Unlink',
  unlinked: 'Unlinked. You can link again with the button in the registration channel.',

  subOn: '🔔 Direct-message reminders are **on**.',
  subOff: '🔕 Direct-message reminders are off. Turn them on and I will send the event card to your DMs.',
  subEnable: 'Turn on reminders',
  subDisable: 'Turn off reminders',
  subNeedLink: 'Link your name first.',
  subDone: '🔔 Done! I will send the event card to your DMs — you can answer right there.',
  subGone: '🔕 No more DMs. You can turn them back on where you registered.',
  subButton: 'DM reminders',
  dmYourAnswer: (label) => `Your answer: **${label}**`,
  dmNoAnswer: '— no answer yet —',
  dmFooter: 'You can answer right here',

  notReady: 'This feature is still being set up. Check back later!'
};

const PACKS = { ru: RU, en: EN };

// Словарь для языка. Неизвестный язык — русский (исторический язык проекта).
export const langPack = (lang) => PACKS[lang] || RU;
export const LANGS = ['ru', 'en'];
