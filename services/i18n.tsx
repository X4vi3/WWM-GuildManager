import React, { createContext, useContext, useState, useCallback } from 'react';

// Лёгкий i18n без зависимостей. Ключ перевода — сама русская строка: при ru возвращаем её
// как есть (ничего не ломается), при en — берём из словаря EN, а если перевода нет — снова
// русскую (мягкий фолбэк). Язык хранится локально (только для этого браузера).

export type Lang = 'ru' | 'en';
const LANG_KEY = 'wmgs_lang';

// EN[русская строка] = английский перевод
const EN: Record<string, string> = {
  // ---- Шапка / навигация ----
  'Стратегический штаб': 'Strategic HQ',
  'РЕДАКТОР': 'EDITOR',
  'ПРОСМОТР': 'VIEW',
  'Состав гильдии': 'Guild roster',
  'Штаб войны': 'War room',
  'Карта': 'Map',
  'Выйти': 'Log out',
  'Выйти из режима редактирования': 'Exit edit mode',
  'Экспорт данных гильдии': 'Export guild data',
  'Импорт данных гильдии': 'Import guild data',
  'Интеграции': 'Integrations',

  // ---- Страница интеграций (Discord) ----
  // (общие с телеграм-секцией строки — «Подключить», «Обновить», «Отключить»,
  //  «Бот не подключён», «Сменить токен бота» — уже ниже, не дублируем)
  'Подключение бота': 'Bot connection',
  'Приложение': 'Application',
  'Публичный ключ получен автоматически — вводить его вручную не нужно.':
    'The public key was fetched automatically — no need to enter it by hand.',
  'Токен бота (Developer Portal → Bot → Reset Token)': 'Bot token (Developer Portal → Bot → Reset Token)',
  'Адрес для приёма команд (Interactions Endpoint URL)': 'Interactions Endpoint URL',
  'Скопировать': 'Copy',
  'Ссылка скопирована.': 'Link copied.',
  'Не удалось скопировать — выделите вручную.': 'Could not copy — select it manually.',
  'Вставьте этот адрес в Developer Portal → General Information → Interactions Endpoint URL и сохраните. Discord сразу проверит его — бот должен быть уже подключён здесь, иначе проверка не пройдёт.':
    'Paste this into Developer Portal → General Information → Interactions Endpoint URL and save. Discord verifies it right away — connect the bot here first, otherwise the check fails.',
  'Токен не принят Discord — проверьте, что скопировали целиком.':
    'Discord rejected the token — make sure you copied all of it.',
  'Настройки сохранены.': 'Settings saved.',

  'Сервер гильдии': 'Guild server',
  'Загрузка списка серверов…': 'Loading servers…',
  'Бот пока не добавлен ни на один сервер. Пригласите его и обновите страницу.':
    'The bot is not on any server yet. Invite it and reload the page.',
  '— выберите сервер —': '— pick a server —',
  'Сохраните, чтобы подгрузить каналы и роли этого сервера.':
    'Save to load channels and roles for this server.',

  'Куда публиковать анонсы': 'Where to post announcements',
  'Клетка — это день недели и тип события. Пустая клетка означает «не публиковать».':
    'Each cell is a weekday and an event type. An empty cell means "do not post".',
  'Сначала выберите сервер и сохраните.': 'Pick a server and save first.',
  'Загрузка каналов…': 'Loading channels…',
  'Поиск канала…': 'Search channel…',
  'Ничего не найдено': 'Nothing found',
  'Очистить клетку': 'Clear cell',
  'на все дни': 'to all days',
  'Скопировать первую заполненную клетку во все дни': 'Copy the first filled cell to every day',
  'Сначала заполните хотя бы один день в этом столбце.': 'Fill at least one day in this column first.',

  'Роли и регистрация': 'Roles and registration',
  'Пинговать роль в анонсах': 'Ping this role in announcements',
  '— не пинговать —': '— no ping —',
  'Канал для регистрации': 'Registration channel',
  '— не настроен —': '— not set —',
  'Роль для доступа к регистрации': 'Role required to register',
  '— доступно всем —': '— open to everyone —',
  'Без этой роли человек не сможет завести себя в составе.':
    'Without this role a person cannot add themselves to the roster.',

  'Опубликовать кнопку': 'Post the button',
  'Опубликовать в канале сообщение с кнопкой регистрации': 'Post a message with the registration button',
  'Кнопку достаточно опубликовать один раз — дальше она живёт в канале сама. Сначала сохраните выбранный канал.':
    'You only need to post the button once — after that it lives in the channel. Save the chosen channel first.',
  'Сообщение с кнопкой опубликовано.': 'The button message has been posted.',
  'Не удалось опубликовать — проверьте канал регистрации и права бота.':
    'Could not post — check the registration channel and the bot permissions.',

  // ---- Доработки страницы интеграций ----
  'Не подключён': 'not connected',
  'Язык сообщений бота': 'Bot message language',
  'На нём бот пишет анонсы и отвечает игрокам.': 'The language the bot posts announcements and replies in.',
  'День недели × тип события. Пустая клетка — не публиковать.':
    'Weekday × event type. An empty cell means no posting.',
  'все дни': 'all days',
  'Пинговать роль': 'Ping role',
  'Роль для доступа': 'Role required',
  'Кнопку достаточно опубликовать один раз. Сначала сохраните выбранный канал.':
    'You only need to post the button once. Save the chosen channel first.',
  'Игроки подписываются сами — кнопкой в канале регистрации.':
    'Players opt in themselves, with a button in the registration channel.',
  'Присылать карточку события в личку': 'Send the event card by DM',
  'минут до старта — напомнить молчунам (0 — не напоминать)':
    'minutes before the start — remind those who stayed silent (0 — no reminder)',
  'Подписалось:': 'Opted in:',
  'Загрузить в Discord': 'Upload to Discord',
  'Жизненный цикл события': 'Event lifecycle',
  'Отсчёт от начала события. Закрытие действует и на сайте, и в ботах; удаление убирает сообщение-анонс из канала и беседы. Сохраняется сразу.':
    'Counted from the event start. Closing applies to the site and the bots; deletion removes the announcement message from the channel and the chat. Saved immediately.',
  'Включить удаление анонса': 'Enable announcement deletion',
  'Не удалять анонс': 'Never delete the announcement',
  'Удаление по умолчанию выключено — потерять историю хуже, чем оставить лишний анонс. Нажмите значок, чтобы включить.':
    'Deletion is off by default — losing history is worse than leaving an extra announcement. Click the icon to enable it.',
  'мин': 'min',
  'Токен от @BotFather': 'Token from @BotFather',
  'Бот пока не добавлен ни на один сервер.': 'The bot is not on any server yet.',

  // ---- Панель привязок ----
  'Кто к чему подключён': 'Who is linked to what',
  'Логины и ссылки на профили видны только офицерам.': 'Logins and profile links are visible to officers only.',
  'Поиск по нику…': 'Search by name…',
  'Привязаны': 'Linked', 'Без привязки': 'Not linked',
  'Никого не нашлось': 'Nobody found',
  'нет в составе': 'not on roster',
  'Нет привязок': 'no links',
  'никуда не привязаны': 'not linked anywhere',
  'Игрока нет в составе — привязка висит впустую': 'This player is off the roster — the link is dangling',
  'Открыть профиль в Телеграме': 'Open Telegram profile',
  'Открыть профиль в Discord': 'Open Discord profile',
  'Отвязано.': 'Unlinked.',
  'Не удалось отвязать.': 'Could not unlink.',

  'Иконки школ оружия': 'Weapon school icons',
  'Загрузить иконки в Discord': 'Upload icons to Discord',
  'Пока не загружены — в анонсах школы показываться не будут. Это эмодзи приложения: слоты сервера они не занимают.':
    'Not uploaded yet — schools will not show in announcements. These are application emoji: they use no server slots.',
  'Не удалось загрузить иконки — проверьте, что бот подключён.':
    'Could not upload the icons — make sure the bot is connected.',

  'Подключение': 'Connection',
  'Общие настройки': 'Common settings',
  'Личные напоминания и иконки': 'DM reminders and icons',
  'Загружено иконок:': 'Icons uploaded:',
  'каналов': 'channels',
  'тем': 'topics',
  'по умолч.': 'default',
  'Тема по умолчанию:': 'Default topic:',
  'Тема по умолчанию': 'Default topic',
  'Бот знает темы:': 'Topics the bot knows:',
  'Темы бот запоминает командой /sithere в нужной теме. /forgethere — забыть.':
    'The bot remembers topics via /sithere in the topic you want. /forgethere to forget one.',
  'Сохранить настройки Discord': 'Save Discord settings',
  'Отсчёт от начала события. Действует и на сайте, и в обоих ботах. Сохраняется сразу.':
    'Counted from the event start. Applies to the site and both bots. Saved immediately.',

  // ---- Панель штаба войны ----
  'активных нет': 'none active',
  'прошедшие': 'past',
  'скрыть прошедшие': 'hide past',
  'Открыто сейчас': 'Currently open',
  'Открыть расстановку на это событие': 'Open the line-up for this event',
  'Нельзя удалить единственную запись': 'Cannot delete the only entry',
  'Удалить СОБЫТИЕ вместе с заявками и анонсами': 'Delete the EVENT along with sign-ups and announcements',
  'Удалить СОБЫТИЕ': 'Delete the EVENT',
  'Удалить событие': 'Delete event',
  'Событие исчезнет из вкладки «События»': 'The event disappears from the Events tab',
  'Пропадут заявки': 'Sign-ups will be lost',
  'Анонсы в Discord и Телеграме будут удалены': 'Announcements in Discord and Telegram will be deleted',
  'Расстановка в штабе войны пропадёт': 'The war-room line-up will be lost',
  'Это нельзя отменить.': 'This cannot be undone.',

  'Напоминания в личку': 'DM reminders',
  'Игроки подписываются сами: /start или /notify в личке боту.':
    'Players opt in themselves: /start or /notify in a DM to the bot.',
  'Личные напоминания': 'Direct-message reminders',
  'Игроки подписываются сами — кнопкой там же, где регистрировались. Без подписки бот в личку не пишет.':
    'Players opt in themselves, with a button where they registered. Without opting in the bot never sends DMs.',
  'Присылать карточку события в личку подписавшимся': 'Send the event card by DM to everyone who opted in',
  'минут до старта — напомнить тем, кто не ответил (0 — не напоминать)':
    'minutes before the start — remind those who have not answered (0 — no reminder)',
  'Подписалось сейчас:': 'Opted in right now:',

  'Сроки закрытия регистрации': 'Registration cut-off',
  'Через сколько минут после начала события закрывается запись. Действует и на сайте, и в ботах. Сохраняется сразу.':
    'How many minutes after the start signups close. Applies to the site and the bots alike. Saved immediately.',
  'минут после старта': 'minutes after start',
  'Не удалось сохранить сроки.': 'Could not save the cut-off settings.',
  'Сохранить настройки': 'Save settings',
  'Всё сохранено': 'All saved',
  'Понедельник': 'Monday', 'Вторник': 'Tuesday', 'Среда': 'Wednesday', 'Четверг': 'Thursday',
  'Пятница': 'Friday', 'Суббота': 'Saturday', 'Воскресенье': 'Sunday',
  'Пн': 'Mon', 'Вт': 'Tue', 'Ср': 'Wed', 'Чт': 'Thu', 'Пт': 'Fri', 'Сб': 'Sat', 'Вс': 'Sun',

  // ---- Выборочный экспорт / импорт ----
  'Отметь, что положить в файл': 'Pick what goes into the file',
  'Выбери файл бэкапа': 'Choose a backup file',
  'Игроки гильдии': 'Guild roster',
  'Весь ростер целиком': 'The whole roster',
  'Шаблоны составов': 'Roster templates',
  'Стратегии карты': 'Map strategies',
  'все': 'all',
  'снять': 'none',
  'рис.': 'draw.',
  'ток.': 'tok.',
  'игр.': 'plr.',
  'соб.': 'evt.',
  'шабл.': 'tpl.',
  'страт.': 'strat.',
  'сост.': 'rosters',
  'слито': 'merged',
  'нов. сост.': 'new rosters',
  'нов. страт.': 'new strat.',
  'обновл.': 'updated',
  'В файл пойдёт:': 'File will contain:',
  'Выгрузить': 'Export',
  'Импортировать': 'Import',
  'Файл не выбран': 'No file selected',
  'Будет:': 'Result:',
  'В выбранном задействовано игроков:': 'Players involved in the selection:',
  'но сами игроки не отмечены. При восстановлении на чистом приложении составы и токены будут пустыми.':
    'but the players themselves are not selected. Restoring into a clean app will leave rosters and map tokens empty.',
  'Добавить игроков': 'Add those players',
  'Перетащи файл сюда или нажми, чтобы выбрать': 'Drop a file here, or click to choose one',
  'Заменить': 'Replace',
  'Добавить': 'Add',
  'Не трогать': 'Leave alone',
  'Совпавшие по id — перезаписать данными из файла, новых — добавить. Никто не удаляется.':
    'Matching by id are overwritten from the file, new ones are added. Nothing is deleted.',
  'Добавить только тех, кого ещё нет. Существующие карточки не меняются.':
    'Add only those missing. Existing cards stay untouched.',
  'Ростер не трогаем совсем.': 'The roster is left completely alone.',
  'Совпали по нику, но id разные:': 'Same nickname, different id:',
  'слить': 'merge',
  'два разных': 'two people',
  '«Слить» — составы и токены из файла будут указывать на текущего игрока.':
    '“Merge” — rosters and map tokens from the file will point at your current player.',
  'уже есть': 'exists',
  'новое': 'new',
  'пропустить': 'skip',
  'перезаписать': 'overwrite',
  'перезап.': 'overwr.',
  'копией': 'as copy',
  'добавить': 'add',
  '(из бэкапа)': '(from backup)',
  'Опасная зона': 'Danger zone',
  'Всё текущее будет стёрто у всей гильдии. Галочки выше игнорируются.':
    'Everything current will be wiped for the whole guild. The checkboxes above are ignored.',
  'Полный откат': 'Full rollback',
  'В «Штабе войны» они тоже показаны как шаблоны — там события и шаблоны в одном ряду.':
    'The War room lists them as templates too — events and templates share one row there.',
  'Только те, что без даты и соперника. События — в секции выше.':
    'Only those without a date or opponent. Events are in the section above.',
  'Сохранить бэкап текущего состояния перед импортом? Файл скачается к тебе — с ним можно вернуть всё как было в любой момент.':
    'Save a backup of the current state before importing? The file downloads to you and can restore everything at any time.',
  'Сохранить бэкап и импортировать': 'Save a backup and import',
  'Импортировать без бэкапа': 'Import without a backup',
  'Сохранить бэкап и откатить': 'Save a backup and roll back',
  'Откатить без бэкапа': 'Roll back without a backup',
  'Полный откат: всё текущее содержимое будет стёрто у всей гильдии и заменено содержимым файла.':
    'Full rollback: everything current will be wiped for the whole guild and replaced with the file’s contents.',
  'Останется:': 'What will remain:',
  'Откатить': 'Roll back',
  'Полный откат применён.': 'Full rollback applied.',
  'Импорт применён.': 'Import applied.',
  'Импорт отменён.': 'Import undone.',
  'Отменить': 'Undo',
  'После импорта состояние уже изменилось — возможно, правит кто-то ещё. Откатить всё равно? Их правки пропадут.':
    'The state has changed since the import — someone else may be editing. Roll back anyway? Their edits will be lost.',
  'Загрузка...': 'Loading...',
  'Загрузка тактического интерфейса...': 'Loading tactical interface...',
  'На сайте:': 'Online:',
  'Переподключение…': 'Reconnecting…',
  'Сохранение…': 'Saving…',
  'Сохранено': 'Saved',
  'Ошибка сохранения': 'Save failed',
  '(вы)': '(you)',
  'Сейчас редактирует': 'Currently editing',
  'Сейчас смотрит': 'Currently viewing',
  'Язык': 'Language',

  // ---- События / регистрация ----
  'События': 'Events',
  'События недели': 'This week’s events',
  'Новое событие': 'New event',
  'Создать': 'Create',
  'Создать событие': 'Create event',
  'Тип': 'Type',
  'Соперник': 'Opponent',
  'Дата': 'Date',
  'Время': 'Time',
  'Заметка': 'Note',
  'Название (необязательно)': 'Name (optional)',
  'Открыть штаб войны': 'Open war room',
  'Редактировать событие': 'Edit event',
  'Удалить это событие? Состав и заявки пропадут.': 'Delete this event? Its roster and signups will be lost.',
  'Событий пока нет': 'No events yet',
  'Офицеры создают события здесь — праки, ранкед, лига.': 'Officers create events here — pracs, ranked, league.',
  'Прак': 'Prac', 'Ранкед': 'Ranked', 'Лига': 'League',
  'Иду': 'In', 'Под вопросом': 'Maybe', 'На замену': 'Sub', 'Не иду': 'Out',
  'Вопрос': 'Maybe', 'Замена': 'Sub', 'Нет': 'No',
  'иду': 'in', 'под вопросом': 'maybe', 'замена': 'sub',
  'в составе': 'in roster',
  'Отметься в составе, чтобы записаться': 'Pick yourself in the roster to sign up',
  'Не удалось сохранить заявку — попробуйте ещё раз.': 'Couldn’t save your signup — try again.',
  'Только заявившиеся': 'signed up only',
  'Привязки ТГ': 'TG links',
  'Телеграм': 'Telegram',
  'Телеграм-бот': 'Telegram bot',
  'Настроить Телеграм-бота': 'Configure Telegram bot',
  'Бот подключён': 'Bot connected',
  'Бот не подключён': 'Bot not connected',
  'Бот подключён.': 'Bot connected.',
  'Бот отключён.': 'Bot disconnected.',
  'Пишу в:': 'Posting to:',
  'беседа': 'chat',
  'тема': 'topic',
  'без тем': 'no topics',
  'Беседа не выбрана — добавьте бота в беседу и напишите там /sithere': 'No chat selected — add the bot to a chat and type /sithere there',
  'Сменить токен бота': 'Change bot token',
  'Токен бота (от @BotFather)': 'Bot token (from @BotFather)',
  'Подключить': 'Connect',
  'Обновить': 'Update',
  'Отключить': 'Disconnect',
  'Токен не принят Телеграмом — проверьте, что скопировали целиком.': 'Telegram rejected the token — make sure you copied all of it.',
  'Не удалось сохранить — проверьте связь.': 'Couldn’t save — check your connection.',
  'Создайте бота у @BotFather и вставьте токен сюда.': 'Create a bot with @BotFather and paste the token here.',
  'Добавьте бота в беседу гильдии.': 'Add the bot to your guild chat.',
  'В нужной теме напишите /sithere. Если тем нет — бот начнёт писать сам.': 'Type /sithere in the topic you want. No topics — the bot starts posting on its own.',
  'Кто привязал Телеграм': 'Who linked Telegram',
  'Привязки Телеграма': 'Telegram links',
  'Пока никто не привязал Телеграм.': 'Nobody has linked Telegram yet.',
  'Отвязать': 'Unlink',
  'Отвязка освобождает ник — человек сможет привязаться заново через бота.': 'Unlinking frees the nick — the person can re-link via the bot.',
  'Часовой пояс времени': 'Time zone',
  'В каком поясе указано время. Каждый увидит его в своём.': 'Which zone the time is in. Everyone sees it in their own.',
  'Завершено': 'Finished',
  'твоё время': 'your time',
  'Регистрация закрыта': 'Sign-ups closed',

  // ---- Стратегии карты ----
  'Игроки': 'Players',
  'Базовая': 'Default',
  'Стратегии': 'Strategies',
  'Стратегия': 'Strategy',
  'Новая стратегия': 'New strategy',
  'Название стратегии': 'Strategy name',
  'Активная стратегия': 'Active strategy',
  'Переключиться на стратегию': 'Switch to this strategy',
  'Нельзя удалить единственную стратегию': 'Can’t delete the only strategy',
  'Удалить стратегию': 'Delete strategy',
  'Новая стратегия карты': 'New map strategy',
  'Удалить эту стратегию карты?': 'Delete this map strategy?',

  // ---- Вход / смена пароля ----
  'Смена пароля': 'Change password',
  'Вход для офицеров': 'Officer login',
  'Старый доступ слетит у всех': 'Everyone’s current access will be revoked',
  'Доступ к редактированию': 'Edit access',
  'Текущий пароль': 'Current password',
  'Пароль': 'Password',
  'Новый пароль (мин. 4 символа)': 'New password (min. 4 chars)',
  'Текущий пароль неверный': 'Current password is wrong',
  'Неверный пароль': 'Wrong password',
  'После смены все, кто редактировал со старым паролем, потеряют доступ. Новый пароль раздай только текущим офицерам.':
    'After the change, anyone editing with the old password loses access. Share the new password only with current officers.',
  'Сменить пароль': 'Change password',
  'Войти': 'Log in',
  'Отмена': 'Cancel',
  'Сменить пароль гильдии →': 'Change guild password →',
  'Сменить пароль гильдии': 'Change guild password',
  '← Войти с паролем': '← Log in with password',

  // ---- Тосты ----
  'Этот участник уже закреплён на другом устройстве.': 'This member is already claimed on another device.',
  'Пароль редактора больше не подходит — доступ к редактированию снят.': 'The editor password no longer works — edit access removed.',
  'Права редактора сняты — сохранить не удалось.': 'Editor rights were removed — could not save.',
  'Не удалось сохранить на сервер — проверьте связь.': 'Could not save to the server — check your connection.',
  'Данные гильдии импортированы.': 'Guild data imported.',
  'Не удалось прочитать файл — проверьте, что это корректный бэкап.': 'Could not read the file — make sure it’s a valid backup.',
  'Пароль гильдии сменили — доступ к редактированию снят.': 'The guild password was changed — edit access removed.',
  'Пароль гильдии изменили — доступ к редактированию снят.': 'The guild password was changed — edit access removed.',
  'Пароль изменён. Остальные редакторы потеряют доступ.': 'Password changed. Other editors will lose access.',
  'Новый пароль слишком короткий (минимум 4 символа).': 'New password is too short (min. 4 chars).',
  'Текущий пароль неверный.': 'Current password is wrong.',
  'Не удалось сменить пароль — проверьте связь.': 'Could not change password — check your connection.',
  'Картинка скопирована — вставьте в Discord (Ctrl+V).': 'Image copied — paste it into Discord (Ctrl+V).',
  'Буфер недоступен в этом браузере — картинка скачана.': 'Clipboard unavailable in this browser — image downloaded instead.',
  'Картинка скачана.': 'Image downloaded.',
  'Не удалось сформировать картинку.': 'Could not generate the image.',

  // ---- Состав гильдии (форма) ----
  'Добавить участника': 'Add member',
  'Редактировать участника': 'Edit member',
  'Имя': 'Name',
  'Роль': 'Role',
  'Оружие · 2 школы': 'Weapons · 2 schools',
  'Школа': 'School',
  'Коллы — кто руководит (необязательно)': 'Calls — who leads (optional)',
  'Авто-запись «Иду» на все события': 'Auto sign-up "In" for all events',
  'Игрок будет сразу отмечен «Иду» в каждом новом событии, без своего участия': 'The player will be marked "In" on every new event automatically, without needing to sign up',
  'Добавить в состав': 'Add to roster',
  'Удалить участника': 'Delete member',
  'Его заявки и место в составах пропадут.': 'Their signups and roster spots will be removed.',
  'Сохранить изменения': 'Save changes',
  'Только просмотр': 'View only',
  'Поиск участников...': 'Search members...',
  'Только для разработки: 30 случайных бойцов для демонстрации': 'Dev only: 30 random members for a demo',
  '+30 случайных': '+30 random',
  'В гильдии пока нет участников.': 'No members in the guild yet.',
  'Никто не найден по запросу': 'No one found for',
  'Это я': 'This is me',
  'Это не я — снять закрепление': 'Not me — unclaim',
  'Редактировать': 'Edit',
  'Удалить': 'Delete',

  // ---- Роли / стороны / линии / доп-роли (метки из constants) ----
  'Танк': 'Tank', 'Хил': 'Healer', 'ДД': 'DPS',
  'Атака': 'Attack', 'Деф': 'Def',
  'Топ': 'Top', 'Мид': 'Mid', 'Бот': 'Bot', 'Без линии': 'No lane',
  'Верхняя линия': 'Top lane', 'Средняя линия': 'Mid lane', 'Нижняя линия': 'Bot lane', 'Линия не назначена': 'No lane assigned',
  'Лес': 'Jungle', 'Босс': 'Boss', 'Тавер': 'Tower',
  'Топ лес (ближний)': 'Top jungle (near)', 'Топ лес (дальний)': 'Top jungle (far)',
  'Бот лес (ближний)': 'Bot jungle (near)', 'Бот лес (дальний)': 'Bot jungle (far)',
  'Топ ближ.': 'Top near', 'Топ дальн.': 'Top far', 'Бот ближ.': 'Bot near', 'Бот дальн.': 'Bot far',
  'Топ лес ближ.': 'Top jng near', 'Топ лес дальн.': 'Top jng far',
  'Бот лес ближ.': 'Bot jng near', 'Бот лес дальн.': 'Bot jng far',
  'Шотколлер': 'Shotcaller', 'РЛ': 'RL', 'Коллер курицы': 'Chicken caller',
  'Курица': 'Chicken',
  'Вражеская башня': 'Enemy tower', 'Союзная башня': 'Ally tower',
  'Вражеская башня · Бот': 'Enemy tower · Bot', 'Вражеская башня · Мид': 'Enemy tower · Mid', 'Вражеская башня · Топ': 'Enemy tower · Top',
  'Союзная башня · Бот': 'Ally tower · Bot', 'Союзная башня · Мид': 'Ally tower · Mid', 'Союзная башня · Топ': 'Ally tower · Top',

  // ---- Штаб войны ----
  'Доступный состав': 'Available roster',
  'сюда': 'here',
  'Гр.': 'Grp',
  '-я минута': 'th min',
  'Перетащите в группу · клик →': 'Drag into a group · click →',
  'Только наблюдение': 'View only',
  'Поиск...': 'Search...',
  'Отпустите здесь, чтобы снять': 'Drop here to remove',
  'Все бойцы распределены': 'Everyone is assigned',
  'Никого не найдено': 'No one found',
  'Перетащите в группу или кликните': 'Drag into a group or click',
  'Заполнить свободные слоты доступными бойцами': 'Fill empty slots with available members',
  'Авто': 'Auto',
  'Снять всех из состава войны': 'Remove everyone from the war roster',
  'Очистить': 'Clear',
  'Боевой состав': 'War roster',
  'Танки': 'Tanks', 'Хилы': 'Healers',
  'Лес/Босс/Тавер': 'Jungle/Boss/Tower',
  'Клик по бойцу — настроить справа. Ctrl/Shift+клик — несколько. Клик по номеру группы — вся группа.':
    'Click a member to edit on the right. Ctrl/Shift+click for several. Click a group number for the whole group.',
  'Снять выделение': 'Clear selection',
  // Подпись на «призраке» перетаскивания, когда под курсором нет цели
  'отпустить — отменить': 'release to cancel',
  'Картинка для Discord:': 'Image for Discord:',
  'Скачать картинку': 'Download image',
  'Скопировать картинку': 'Copy image',
  // Приказ выгружается двумя картинками: «Состав» и «Тайминги» (см. BattleOrderExport)
  'План таймингов пуст': 'No timings planned yet',
  'Цвет ника': 'Nickname colour',
  'меняет точку за бой': 'changes spot during the fight',
  'Доска': 'Board', 'Сетка': 'Grid', 'Тайминги': 'Timings',

  // ---- Тайминги (лес и босс по минутам боя) ----
  'старт': 'start',
  '25′': "25'", '20′': "20'", '15′': "15'", '10′': "10'", '5′': "5'",
  'Ближний ТОП': 'Near TOP', 'Дальний ТОП': 'Far TOP',
  'Ближний БОТ': 'Near BOT', 'Дальний БОТ': 'Far BOT',
  'Лагерь в лесу': 'Jungle camp',
  'В лесу': 'In jungle', 'На боссе': 'On boss',
  'ближний': 'near', 'дальний': 'far', 'и': 'and',
  'Так это увидят игроки — тот же вид уходит в картинку приказа':
    'This is what members will see — the same view goes into the order image',
  'Убрать всю пачку из этой клетки': 'Remove the whole group from this cell',
  'Показать состав пачки': 'Show who is in the group',
  'Свернуть состав пачки': 'Collapse the group',
  'Задач в плане': 'Tasks planned',
  'Укажите тайминги': 'Pick the timings',
  'На всё': 'All of them', 'Применить': 'Apply',
  'Отметить все': 'Select all', 'Снять все': 'Clear all',
  'Нажмите, чтобы снять со всех таймингов': 'Click to clear from every timing',
  'Спросим, на каких таймингах': 'We will ask which timings',
  'Сначала поставьте задачу — лагерь или босса': 'Set a task first — a camp or the boss',
  'Сначала поставьте бойца в состав этой стороны на доске': 'Put the member into this side on the board first',
  'Тяните бойца или ручку группы в клетку справа': 'Drag a member or a group handle into a cell on the right',
  'Перетащите в клетку — попадёт ссылка на группу целиком': 'Drag into a cell — the whole group goes in as a reference',
  'Перетащите в клетку таблицы': 'Drag into a table cell',
  'Тяните бойца или пачку из списка слева в клетку. 🐔 у имени ставит курицу на эту задачу. Клик по имени выделяет бойца: справа откроется карточка, а рядом появится ✕, чтобы убрать его отсюда.':
    'Drag a member or a group from the list on the left into a cell. The 🐔 next to a name sets a chicken for that task. Clicking a name selects the member: their card opens on the right and a ✕ appears to remove them from here.',
  'Клик — выделить бойца и открыть его карточку': 'Click to select the member and open their card',
  'Несёт курицу на эту задачу': 'Carries a chicken on this task',
  'Убрать курицу с этой задачи': 'Remove the chicken from this task',
  'Убрать из клетки': 'Remove from the cell',
  'Вычеркнуть из этой пачки здесь': 'Exclude from the group here',
  'Соберите состав на доске': 'Build the roster on the board',
  'Состав ещё не собран': 'Roster not built yet',
  'Распределите бойцов на доске или из списка слева': 'Assign members on the board or from the list on the left',
  'Боец': 'Member', 'Сторона': 'Side', 'Группа': 'Group', 'Линия': 'Lane', 'Башня': 'Tower', 'Лес / Босс': 'Jungle / Boss',
  'Перетащите, чтобы поменять группы местами': 'Drag to swap groups',
  'Пусто': 'Empty',
  'Клик — выбрать (Ctrl — несколько) · перетащите в группу или в список слева':
    'Click to select (Ctrl for several) · drag into a group or the list on the left',
  'Цель для добавления из пула + выделить всю группу': 'Target for adding from the pool + select the whole group',
  // Инспектор
  'Настройки бойцов': 'Member settings',
  'Данные': 'Details',
  'Доп-роли': 'Extra roles',
  'Позиция в лесу': 'Jungle position',
  'Какой босс': 'Which boss',
  'Какой колл': 'Calls',
  'Коллы': 'Calls',
  'Школы оружия': 'Weapon schools',
  'Несёт курицу': 'Carries chicken',
  'Снять из состава': 'Remove from roster',
  'Выбрано:': 'Selected:',

  // ---- Шаблоны ----
  'Шаблоны': 'Templates',
  'Шаблон:': 'Template:',
  'Новый шаблон': 'New template',
  'Пустой': 'Empty',
  'Копия': 'Copy',
  'Название (Ранкед, Лига…)': 'Name (Ranked, League…)',
  'Создать пустой': 'Create empty',
  'Создать как копию текущего': 'Create as a copy of the current one',
  'Активный шаблон': 'Active template',
  'Переключиться на этот шаблон': 'Switch to this template',
  'Переименовать': 'Rename',
  'Удалить шаблон': 'Delete template',
  'Нельзя удалить единственный шаблон': 'Can’t delete the only template',
  'Сохранить': 'Save',
  'Новый шаблон состава': 'New roster template',
  'Шаблон': 'Template',

  // ---- Недоступность игрока (отпуск, болезнь, жизненные обстоятельства) ----
  'Недоступен': 'Away',
  'недоступен': 'is away',
  'Недоступен, вернётся': 'Away, back on',
  'Недоступен бессрочно': 'Away indefinitely',
  'Пометка поставлена': 'Marked on',
  'Отметить недоступным': 'Mark as away',
  'Изменить недоступность': 'Edit away status',
  'Отметить': 'Mark',
  'Снова доступен': 'Back available',
  'Причина': 'Reason',
  'Например: улетел в отпуск': 'For example: on holiday abroad',
  'Вернётся': 'Back on',
  'В этот день уже играет. События до него — отказ.': 'Available again that day. Events before it get a decline.',
  'Без даты — бессрочно, пока не снимете.': 'No date — indefinite, until you clear it.',
  'Будущие события в этот срок получат «Не иду», место в группах освободится. Вернуть их обратно можно только вручную.':
    'Upcoming events in this period get a decline and the player’s slots are freed. Undoing that is manual.',
  'Не удалось сохранить — попробуйте ещё раз.': 'Could not save — please try again.',

  // ---- Подтверждения ----
  'Подтвердить': 'Confirm',
  'Снять всех бойцов из состава войны?': 'Remove everyone from the war roster?',
  'Снять всех': 'Remove all',
  'Расстановка в нём пропадёт.': 'Its layout will be lost.',

  // ---- Карта ----
  'Интерактивная карта': 'Interactive map',
  'Выбор / перемещение': 'Select / move',
  'Кисть': 'Brush',
  'Стрелка': 'Arrow',
  'Текст': 'Text',
  'Текст…': 'Text…',
  'Убрать подпись': 'Remove label',
  'Потяните, чтобы изменить размер': 'Drag to resize',
  'Заливка': 'Fill',
  'Обводка': 'Stroke',
  'Тонкая': 'Thin', 'Средняя': 'Medium', 'Толстая': 'Thick',
  'Свой цвет': 'Custom color',
  'Отменить (Ctrl+Z)': 'Undo (Ctrl+Z)',
  'Вернуть (Ctrl+Y)': 'Redo (Ctrl+Y)',
  'Очистить рисунки': 'Clear drawings',
  'Панель — влево': 'Dock toolbar left',
  'Панель — вниз': 'Dock toolbar bottom',
  'Прямая': 'Straight line',
  'Прямоугольник (зона)': 'Rectangle (zone)',
  'Эллипс (зона)': 'Ellipse (zone)',
  'Шаг сетки': 'Grid step',
  'Мелкая': 'Fine',
  'Крупная': 'Coarse',
  'Выбрано': 'Selected',
  'Удалить выбранные': 'Delete selected',
  'Привязка к сетке (Alt — временно наоборот)': 'Snap to grid (Alt inverts it)',
  'Дублировать (Ctrl+D)': 'Duplicate (Ctrl+D)',
  'пробел или средняя кнопка — двигать': 'space or middle button to pan',
  'Ctrl + колесо — приблизить карту': 'Ctrl + wheel to zoom the map',
  'Добавляйте бойцов и объекты кликом, перетаскивайте их и рисуйте стрелки и пометки. Инструментом «Выбор» фигуру можно двигать, растягивать, перекрашивать и удалять. Всё синхронизируется с командой.': 'Add fighters and objects with a click, drag them around, draw arrows and marks. With the Select tool a shape can be moved, resized, recoloured and deleted. Everything syncs with the team.',
  'Ctrl + колесо': 'Ctrl + wheel',
  'приблизить карту': 'zoom the map',
  'Пробел или средняя кнопка': 'Space or middle button',
  'двигать приближённую карту': 'pan the zoomed map',
  'Ctrl + Z': 'Ctrl + Z',
  'отменить': 'undo',
  'Ctrl + Y': 'Ctrl + Y',
  'вернуть': 'redo',
  'Ctrl + D': 'Ctrl + D',
  'дублировать выбранное': 'duplicate selection',
  'Delete': 'Delete',
  'удалить выбранное': 'delete selection',
  'Shift или Ctrl + клик': 'Shift or Ctrl + click',
  'добавить или убрать из выделения': 'add to or remove from selection',
  'Протянуть по пустому': 'Drag on empty space',
  'выделить рамкой несколько': 'marquee-select several',
  'Alt': 'Alt',
  'строго по сетке — иначе фигуры липнут к соседям': 'strictly to the grid — otherwise shapes stick to neighbours',
  'приблизить': 'zoom in',
  'Пробел + мышь': 'Space + mouse',
  'двигать карту': 'pan the map',
  'дублировать': 'duplicate',
  'Shift + клик': 'Shift + click',
  'добавить к выделению': 'add to selection',
  'Протяжка по пустому': 'Drag on empty space',
  'рамка выделения': 'marquee select',
  'строго по сетке': 'strictly to the grid',
  'Пунктир': 'Dashed',
  'Прозрачность заливки': 'Fill opacity',
  'Удалить фигуру': 'Delete shape',
  'Цвет текста': 'Text color',
  'Цвет плашки': 'Backdrop color',
  'Цвет обводки': 'Outline color',
  'Толщина обводки': 'Outline width',
  'Прозрачность плашки': 'Backdrop opacity',
  'Игроки команды': 'Team members',
  'Все': 'All', 'Убрать': 'Remove',
  'Соберите состав в «Штабе войны», чтобы добавлять бойцов на карту.': 'Build the roster in the War room to place members on the map.',
  'Поставить на карту': 'Place on the map', 'Убрать с карты': 'Remove from the map',
  'Клик — поставить/убрать бойца. На карте токен можно перетаскивать; ✕ — убрать.':
    'Click to add/remove a member. Drag the token on the map; ✕ to remove.',
  'Объекты карты': 'Map objects',
  'Тактические объекты, расставленные командиром.': 'Tactical objects placed by the commander.',
  'Клик — поставить объект в центр карты. Объект можно перетаскивать; наведите и нажмите ✕, чтобы убрать.':
    'Click to drop an object in the center. Drag objects; hover and click ✕ to remove.',
  'Убрать объект': 'Remove object',
  'Легенда': 'Legend',
  'Соберите состав в «Штабе войны»': 'Build the roster in the War room',
  'Расстановка бойцов, объекты и стратегия (только просмотр).': 'Member placement, objects and strategy (view only).',
  'Вражеский лес': 'Enemy jungle', 'Союзный лес': 'Ally jungle',
  'Вражеский гусь': 'Enemy goose', 'Союзный гусь': 'Ally goose',
  'Метка: Танк': 'Mark: Tank', 'Метка: Хил': 'Mark: Healer', 'Метка: ДД': 'Mark: DPS',

  // ---- Экспорт-картинка ----
  'ШТАБ ВОЙНЫ': 'WAR ROOM',
  'минута босса': 'boss minute',
  'курица': 'chicken',
  'шотколлер': 'shotcaller',
  'пусто': 'empty',
  'ВСЕГО': 'TOTAL',
  'ЛЕС': 'JNG',
  'БОСС': 'BOSS',
  'ТАВЕР': 'TWR',
  'ПКМ по картинке → «Копировать изображение», затем Ctrl+V в Discord':
    'Right-click the image → “Copy image”, then Ctrl+V in Discord',
  'Скачать': 'Download',
  'Закрыть': 'Close',
  'Всего': 'Total',
  'Загрузить иконки': 'Upload icons',
  'Не удалось прочитать иконки.': 'Could not read the icons.',
  'Пока не загружены — в анонсах будут стандартные значки.': 'Not uploaded yet — announcements will use the default icons.',
  'Иконки в Discord:': 'Icons in Discord:',

  // ---- Пояснения к настройкам интеграций (компонент Hint) ----
  'Если на экране согласия Discord показывает не эти права, а «Add a bot to a Server» и «Create commands» — значит он взял настройки из Developer Portal, а не из нашей ссылки. Лечится там же: Installation → Install Link → None, после чего вернитесь сюда и нажмите кнопку снова.':
    'If the Discord consent screen shows «Add a bot to a Server» and «Create commands» instead of these permissions, it took the settings from the Developer Portal rather than from our link. Fix it there: Installation → Install Link → None, then come back and press the button again.',
  'Один бот может состоять сразу в нескольких серверах Discord. Здесь выбирается тот, где живёт гильдия: из него берутся списки каналов и ролей, в него уходят анонсы.':
    'One bot can sit in several Discord servers at once. Pick the one where the guild lives: its channels and roles are listed here, and announcements go to it.',
  'Роль, которую бот упомянет над карточкой анонса, чтобы пришло уведомление. Упоминание стоит в тексте над карточкой, а не внутри неё — внутри Discord никого не пингует. Не выбрано — анонс выйдет тихо, без уведомления.':
    'The role the bot mentions above the announcement card so that a notification arrives. The mention sits in the text above the card, not inside it — inside an embed Discord pings nobody. Left empty, the announcement goes out quietly.',
  'Канал, в котором живёт сообщение с кнопкой «Зарегистрироваться». Нажав её, игрок привязывает свой аккаунт Discord к нику в составе — после этого он может отмечаться на события кнопками прямо в анонсе.':
    'The channel that holds the «Register» button message. Pressing it links a player\'s Discord account to their roster name — after that they can sign up for events with the buttons in the announcement itself.',
  'Кто вообще допущен до этой кнопки регистрации. Если роль выбрана, привязать себя смогут только те, у кого она есть — так на сервере с посторонними в состав не запишется случайный человек. Бот только ПРОВЕРЯЕТ наличие роли и никому её не выдаёт. Оставить «доступно всем» — сможет любой, кто видит канал.':
    'Who is allowed to use that register button at all. With a role picked, only people who have it can link themselves — so on a server with outsiders no random person ends up on the roster. The bot only CHECKS for the role, it never grants it. Leave «open to everyone» and anyone who sees the channel can do it.',
  'Публикует в выбранном канале сообщение с кнопкой регистрации. Достаточно один раз: дальше сообщение живёт в канале само. Кнопка недоступна, пока выбранный канал не сохранён — иначе сообщение ушло бы не туда.':
    'Posts the message with the register button in the chosen channel. Once is enough: after that the message lives in the channel on its own. The button stays disabled until the chosen channel is saved, otherwise the message would go to the wrong place.',
  'Включено — тем, кто подписался на напоминания, бот пришлёт карточку события ещё и в личные сообщения. Выключено — карточка выйдет только в канале (или в теме беседы), в личку не уйдёт ничего. На сам анонс и на возможность отмечаться это не влияет, меняется только доставка.':
    'On — people who opted in to reminders also get the event card in their direct messages. Off — the card only goes to the channel (or chat topic) and nothing is sent privately. This changes delivery only: the announcement itself and signing up are unaffected.',
  '«Молчун» — тот, кто на событие вообще не ответил: ни «иду», ни «не иду». За указанное число минут до начала бот напомнит в личку только им, чтобы не дёргать тех, кто уже определился. Ноль — не напоминать совсем.':
    'A «silent» player is one who did not answer at all — neither going nor not going. The given number of minutes before the start the bot reminds only them, so the ones who already decided are left alone. Zero means no reminder.',
  'Загружает в Discord иконки школ оружия и ролей (танк/дд/хил) как эмодзи приложения — их видно в анонсе вместо стандартных значков. Слоты эмодзи сервера они не занимают. Картинки берутся из вашего браузера: на сервере сайта их нет, они защищены авторским правом и в репозиторий не попадают. Повторная загрузка ЗАМЕНЯЕТ уже залитые значки, и Discord выдаёт им новые id — в уже опубликованных анонсах старые значки могут показаться текстом, пока анонс не обновится.':
    'Uploads the weapon school icons and the role icons (tank/dps/healer) to Discord as application emoji — they show in the announcement instead of the default ones. They take up none of the emoji slots of the server. The images come from your browser: the server of the site does not have them, they are copyrighted and never committed. Uploading again REPLACES the icons already there and Discord gives them new ids — in announcements already posted the old icons may show up as plain text until the announcement is updated.',
  'Через сколько минут после начала события закрыть запись. Закрытое событие остаётся видно и на сайте, и в анонсе, но кнопки отметиться исчезают — состав больше не меняется.':
    'How many minutes after the start to close sign-ups. A closed event stays visible both on the site and in the announcement, but the sign-up buttons disappear — the roster stops changing.',
  'Через сколько минут после начала удалить сообщение-анонс из канала и беседы. По умолчанию выключено: потерять историю обычно хуже, чем оставить лишний анонс. Нажмите значок в строке, чтобы включить.':
    'How many minutes after the start to delete the announcement message from the channel and the chat. Off by default: losing the history is usually worse than leaving an extra announcement. Click the icon in the row to enable it.',
  'смотреть каналы':
    'view channels',
  'писать сообщения':
    'send messages',
  'вставлять ссылки':
    'embed links',
  'внешние эмодзи':
    'external emoji',
  'Пояснение':
    'Explanation',
  'Ссылка просит ровно четыре права:':
    'The link asks for exactly four permissions:',

  // ---- Пропущенные переводы (полоса онлайна, темы Телеграма, разделы) ----
  'Кто сейчас на сайте': 'Who is on the site right now',
  'На сайте': 'On the site',
  'вы': 'you',
  'Загрузка…': 'Loading…',
  'Разделы': 'Sections',
  'Состав': 'Roster',
  'Бот пока не знает ни одной темы.': 'The bot does not know any topic yet.',
  'Зайдите в нужную тему беседы и напишите:': 'Open the topic you want in the chat and type:',
  'праки сюда': 'practice here',
  'ранкед сюда': 'ranked here',
  'лигу сюда': 'league here',
  'Название можно задать сразу: /setprac Праки. /where — показать раскладку.': 'You can set the name right away: /setprac Practice. /where shows the current mapping.',
  'Настраивается командой в нужной теме. /where — показать раскладку, /unsetprac и т.п. — снять.': 'Set up with a command inside the topic. /where shows the mapping, /unsetprac and similar clear it.',
  'Проще всего настроить командами в самой теме — Telegram не даёт боту список тем, узнать их иначе нельзя.': 'Easiest to set up with commands inside the topic — Telegram gives the bot no way to list topics.',

  // ---- Доработка панели интеграций ----
  'Discord не ответил. Токен, скорее всего, верный — попробуйте ещё раз через минуту.': 'Discord did not respond. The token is probably fine — try again in a minute.',
  'Отключить бота? Токен будет удалён, и в Developer Portal придётся выпустить новый.': 'Disconnect the bot? The token will be deleted and you will have to reset it in the Developer Portal.',
  'Отключить бота Телеграма? Токен будет удалён, и новый придётся брать у @BotFather.': 'Disconnect the Telegram bot? The token will be deleted and you will have to get a new one from @BotFather.',
  'Вставьте этот адрес в Developer Portal → General Information → Interactions Endpoint URL.': 'Paste this address into Developer Portal → General Information → Interactions Endpoint URL.',
  'Сейчас это локальный адрес — снаружи Discord до него не достанет.': 'This is a local address — Discord cannot reach it from outside.',
  'Discord обращался к этому адресу, последний раз': 'Discord has reached this address, last time',
  'Discord ещё ни разу не обращался по этому адресу — значит адрес не сохранён в Developer Portal либо недоступен снаружи.': 'Discord has never reached this address — either it is not saved in the Developer Portal or it is unreachable from outside.',
  'Запросов с неверной подписью:': 'Requests with a bad signature:',
  'Обычно это значит, что бота сменили, а адрес остался от старого приложения.': 'That usually means the bot was replaced while the address still points at the old application.',
  'Бот пока не добавлен ни на один сервер — без этого он не увидит каналы и роли.': 'The bot is not on any server yet — until then it cannot see channels or roles.',
  'Добавить бота на ещё один сервер или обновить его права:': 'Add the bot to another server or refresh its permissions:',
  'Пригласить бота на сервер': 'Invite the bot to a server',
  'Повторить': 'Retry',
  'Discord не ответил.': 'Discord did not respond.',
  'Не удалось получить каналы — Discord не ответил.': 'Could not load channels — Discord did not respond.',
  'Discord не ответил — список не получен.': 'Discord did not respond — the list was not loaded.',
  'Загружаем список из Discord…': 'Loading the list from Discord…',
  'Роли и каналы не загрузились — Discord не ответил.': 'Roles and channels did not load — Discord did not respond.',
  'Достигнут предел каналов на одну клетку': 'Channel limit for one cell reached',
  'Отмечено': 'Selected',
  'из': 'of',
  'по-разному в разные дни': 'varies by day',
  'тема по умолчанию': 'default topic',

  // ---- Вход на сайт через Discord ----
  'Вход на сайт': 'Site sign-in',
  'Войти через Discord': 'Sign in with Discord',
  'Войдите, чтобы отметиться': 'Sign in to sign up',
  'Гильдия': 'Guild',
  'Этот сайт доступен участникам гильдии.': 'This site is for guild members.',
  'Чтобы попасть внутрь, привяжи игровой ник в канале регистрации.':
    'To get in, link your in-game nickname in the registration channel.',
  'Открыть канал регистрации': 'Open the registration channel',
  'Пока выключено, сайт работает как раньше: отметиться может любой, кто нажал «это я». Включённый вход требует, чтобы человек подтвердил себя через Discord — и тогда за чужую строку он отметиться не сможет.':
    'While this is off, the site works as before: anyone who clicks “that is me” can sign up. With sign-in on, a person confirms who they are through Discord — and then cannot sign up on someone else’s behalf.',
  'Адрес возврата (Redirect URL)': 'Redirect URL',
  'Вставьте его в Developer Portal → OAuth2 → Redirects.':
    'Paste it into Developer Portal → OAuth2 → Redirects.',
  'Client secret приложения': 'Application client secret',
  'вставьте секрет': 'paste the secret',
  'задан ': 'set ',
  'Developer Portal → OAuth2 → Client Secret → Reset Secret. Это пароль: сайт его больше не покажет.':
    'Developer Portal → OAuth2 → Client Secret → Reset Secret. Treat it as a password: the site will not show it again.',
  'Роль офицера': 'Officer role',
  '— только по паролю —': '— password only —',
  'Отдельно от роли для доступа: та обычно широкая, и офицерами стали бы все.':
    'Separate from the access role: that one is usually broad, and everyone would become an officer.',
  'Кто может смотреть сайт': 'Who can view the site',
  'Все — отмечаются только вошедшие': 'Everyone — only signed-in members can sign up',
  'Только те, у кого привязан ник': 'Only people with a linked nickname',
  'Закрытый режим ломает привычку «кинул ссылку — посмотрели».':
    'Closed mode breaks the habit of sharing a link so people can just look.',
  'Включить вход через Discord': 'Enable Discord sign-in',
  'Сначала сохраните client secret — без него войти будет нечем, а отмечаться уже нельзя.':
    'Save the client secret first — without it there is nothing to sign in with, while signing up is already blocked.',
  'Обновить данные Discord': 'Refresh Discord data',
  'Перечитывает каналы и роли и тут же перепроверяет права всех, кто на сайте. Обычно роль отпадает сама в течение минуты — эта кнопка нужна, когда ждать нельзя.':
    'Re-reads channels and roles, then immediately re-checks the rights of everyone on the site. A removed role normally falls away on its own within a minute — this button is for when you cannot wait.',
  'Данные обновлены.': 'Data refreshed.',
  'Не удалось сохранить.': 'Could not save.',
  'Сохранено.': 'Saved.',

  'Привязать ник': 'Link your nickname',
  'Ник не привязан — отмечаться нельзя': 'No nickname linked — you cannot sign up',

  // ---- Заливка записей ГВГ на YouTube ----
  'Залить записи ГВГ': 'Upload GvG recordings',
  'Заливка не настроена': 'Uploading is not set up',
  'Офицер подключает канал в разделе «Интеграции» — там же, где Discord.':
    'An officer connects the channel under “Integrations”, next to Discord.',
  'Нужен привязанный ник': 'A linked nickname is required',
  'Плейлист называется вашим игровым ником, поэтому заливать можно только за себя.':
    'The playlist is named after your in-game nickname, so you can only upload for yourself.',
  'Перетащите записи сюда или нажмите, чтобы выбрать': 'Drop recordings here, or click to pick them',
  'Файлы не проходят через сайт — уходят прямо в YouTube по вашему интернету.':
    'Files do not pass through the site — they go straight to YouTube over your own connection.',
  'Вражеская гильдия': 'Enemy guild',
  'название соперника': 'opponent name',
  'Дата боя': 'Battle date',
  'Берётся из самого раннего файла: бой за полночь — это всё ещё вчерашний бой.':
    'Taken from the earliest file: a battle running past midnight is still the previous day’s battle.',
  'Эта пачка': 'This batch',
  'по ссылке': 'unlisted',
  'открыто': 'public',
  'открытый': 'public',
  'открытым': 'public',
  'скрытым («по ссылке»)': 'unlisted',
  'В открытом плейлисте скрытая запись всё равно находится поиском':
    'In a public playlist an unlisted video still turns up in search',
  'Мой плейлист': 'My playlist',
  'Появится при первой заливке — с той видимостью, что выбрана выше.':
    'It appears on the first upload, with the visibility chosen above.',
  'Сменить видимость плейлиста на %s? Все записи внутри тоже сменят её — иначе скрытые ролики в открытом плейлисте начинают находиться поиском.':
    'Change the playlist visibility to %s? Every video inside changes too — otherwise unlisted videos in a public playlist start turning up in search.',
  'Готово: записей затронуто %n': 'Done: %n videos affected',
  'Не удалось сменить видимость.': 'Could not change the visibility.',
  'Залить': 'Upload',
  'Остановить': 'Stop',
  'Повторить упавшие': 'Retry the failed ones',
  'Открыть видео': 'Open video',
  'без превью': 'no thumbnail',
  'залито, но в плейлист не попало': 'uploaded, but not added to the playlist',
  'Обложка': 'Thumbnail',
  'префикс': 'prefix',
  'канал гильдии': 'guild channel',
  'осталось': 'left',
  'ГБ': 'GB',
  'МБ': 'MB',
  'Проверить снова': 'Check again',
  'Связь оборвалась — до YouTube не дошло. Попробуйте ещё раз.':
    'The connection dropped — nothing reached YouTube. Try again.',
  'Доступ к каналу недействителен. Это чинится на сервере, не у вас.':
    'Channel access is no longer valid. That is fixed on the server, not on your side.',
  'Дневной лимит загрузок исчерпан. Сбросится в полночь по тихоокеанскому времени.':
    'The daily upload limit is used up. It resets at midnight Pacific time.',
  'YouTube сейчас не отвечает. Заливать нельзя.': 'YouTube is not responding right now. Uploading is unavailable.',
  'YouTube отказал.': 'YouTube refused the request.',
  'Отменено.': 'Cancelled.',

  'Пока вы на этой странице, браузер держит полный доступ к каналу — Google не умеет выдавать урезанный. Отдельный токен только на загрузку это чинит.':
    'While this page is open your browser holds full access to the channel — Google cannot issue a narrower one. A separate upload-only token fixes that.',

  // ---- Заливка: линейный порядок шагов ----
  'Записи ГВГ': 'GvG recordings',
  'Файлы уходят на канал гильдии прямо с вашего компьютера — сайт их не хранит и не пересылает.':
    'Files go to the guild channel straight from your computer — the site neither stores nor relays them.',
  'Выбрать записи': 'Choose recordings',
  'Добавить ещё файлы': 'Add more files',
  'или перетащите их сюда': 'or drop them here',
  'С кем бились': 'Who you fought',
  'название вражеской гильдии': 'enemy guild name',
  'Попадёт в название видео и на обложку.': 'Goes into the video title and onto the thumbnail.',
  'Взята из файлов, можно поправить.': 'Taken from the files; you can correct it.',
  'Кто сможет посмотреть': 'Who can watch',
  'только по ссылке': 'link only',
  'все на YouTube': 'everyone on YouTube',
  'В поиске не появятся, откроются только по ссылке.': 'They will not show up in search; only the link opens them.',
  'Появятся в поиске и на канале гильдии.': 'They will show up in search and on the guild channel.',
  'Убрать из списка': 'Remove from the list',
  'Название:': 'Title:',
  'соперник': 'opponent',
  'У каждой записи своя — видно в карточках.': 'Each recording has its own — shown on the cards.',
  'Одна на все записи — видно в карточках.': 'One for every recording — shown on the cards.',
  'Подставлять «ник [дата]» в начало названия': 'Prefix the title with "nickname [date]"',
  'кадр': 'frame',
  'обложка': 'cover',
  'Кадр из вашего файла. На YouTube он не уходит.': 'A frame from your file. It is not sent to YouTube.',
  'Обложка, которая уедет на YouTube.': 'The cover that will go to YouTube.',
  'Посмотреть запись — например, чтобы узнать соперника':
    'Watch the recording — handy for working out who you fought',
  'Соперник этой записи. Пусто — возьмётся общий.': "This recording's opponent. Leave empty to use the shared one.",
  'Идёт на все записи. Если за вечер бились с разными — впишите своего в строке.':
    'Applies to every recording. Fought different guilds tonight? Put each one on its own row.',
  'ник и дата': 'nickname and date',
  'Залить записи': 'Upload recordings',
  'Залить запись': 'Upload the recording',
  'Залить %n запись': 'Upload %n recording',
  'Залить %n записи': 'Upload %n recordings',
  'Залить %n записей': 'Upload %n recordings',
  'Всё залито': 'All uploaded',
  'Не закрывайте вкладку до конца заливки.': 'Keep this tab open until the upload finishes.',
  'сегодня залито %a из %b': 'uploaded today: %a of %b',
  'плейлист': 'playlist',
  'видят все': 'visible to everyone',
  'появится после первой заливки': 'appears after the first upload',
  'изменить': 'change',
  'доступ шире, чем нужно': 'access is broader than needed',

  // ---- Галерея записей ----
  'Канал %s · записей: %n': 'Channel %s · recordings: %n',
  'записей: %n': 'recordings: %n',
  'Перечитать канал': 'Re-read the channel',
  'Залить свои': 'Upload yours',
  'Все записи': 'All recordings',
  'Ваш плейлист': 'Your playlist',
  'Скрыть от поиска': 'Hide from search',
  'Открыть всем': 'Open to everyone',
  'Любой соперник': 'Any opponent',
  'Любая дата': 'Any date',
  'Сбросить': 'Clear',
  'найдено: %n': 'found: %n',
  'Под фильтр ничего не подошло.': 'Nothing matches the filter.',
  'На канале пока нет записей.': 'The channel has no recordings yet.',
  'Сбросить фильтры': 'Clear the filters',
  'без даты': 'no date',
  'Смотреть': 'Watch',
  'Открыть на YouTube': 'Open on YouTube',
  'Не удалось получить записи с канала.': 'Could not fetch recordings from the channel.',
  'Канал YouTube к сайту не подключён — записей пока нет.':
    'No YouTube channel is connected to the site — there are no recordings yet.',
  'Записи видны участникам гильдии: войдите через Discord и привяжите свой ник.':
    'Recordings are for guild members: sign in with Discord and link your nickname.',
  'Попробовать снова': 'Try again',
  'Возрастное ограничение YouTube': 'YouTube age restriction',
  'YouTube ещё обрабатывает запись': 'YouTube is still processing this one',
  'Встраивание запрещено': 'Embedding is disabled',
  'Записей с возрастным ограничением: %n. YouTube ставит его сам, и встроенный плеер такие не покажет — они открываются по ссылке на YouTube.':
    'Age-restricted recordings: %n. YouTube applies this on its own, and the embedded player will not show them — they open via a link on YouTube.',
  'Снимается только в YouTube Studio: Контент → выделить записи → Изменить → Аудитория.':
    'It can only be lifted in YouTube Studio: Content → select the videos → Edit → Audience.',

  // ---- Подключение канала YouTube ----
  'Подключение канала': 'Connecting the channel',
  'подключён': 'connected',
  'не подключён': 'not connected',
  'Гильдия заливает записи на СВОЙ канал YouTube. Нужен проект Google — он бесплатный, но завести его придётся вручную.':
    'The guild uploads recordings to its OWN YouTube channel. That needs a Google project — free, but you have to create it by hand.',
  'Адрес возврата (Authorised redirect URI)': 'Redirect URI (Authorised redirect URI)',
  'Google Cloud Console → APIs & Services → Credentials → OAuth client ID, тип Web application. Этот адрес вставляют в Authorised redirect URIs.':
    'Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type Web application. Paste this address into Authorised redirect URIs.',
  'задан': 'set',
  'Подключить канал': 'Connect the channel',
  'Переподключить канал': 'Reconnect the channel',
  'Отключить канал? Заливка перестанет работать, пока не подключите заново.':
    'Disconnect the channel? Uploading stops working until you connect it again.',
  'Канал отключён.': 'Channel disconnected.',
  'Не удалось отключить.': 'Could not disconnect.',
  'Google спросит разрешение ДВА раза подряд: первое — чтобы сайт вёл плейлисты, второе — только на загрузку, его получает браузер. Второе право узкое нарочно: им нельзя удалить чужое видео.':
    'Google asks for permission TWICE in a row: the first lets the site manage playlists, the second is upload-only and goes to the browser. The second one is deliberately narrow — it cannot delete anyone else’s video.',
  'Второе разрешение не выдано — браузер получает полный доступ к каналу. Нажмите «Переподключить канал» и пройдите оба шага.':
    'The second permission was not granted, so the browser gets full access to the channel. Press “Reconnect the channel” and go through both steps.',

  // ---- Оформление обложки записей ----
  'Обложка записей': 'Recording thumbnail',
  'Так будут выглядеть обложки видео, которые заливает гильдия.':
    'This is how the thumbnails of the guild uploads will look.',
  'Канал ещё не подключён — заливать пока некуда. Оформление можно настроить заранее.':
    'The channel is not connected yet, so there is nowhere to upload. You can still set the design up in advance.',
  'Название гильдии на обложке': 'Guild name on the thumbnail',
  'например JADE COURT': 'for example JADE COURT',
  'Пустое — строку не рисуем вовсе. Чужое имя на обложке хуже, чем его отсутствие.':
    'Leave it empty and the line is not drawn at all — someone else’s name on your thumbnail is worse than none.',
  'Цвета': 'Colours',
  'верх названия': 'name, top',
  'низ названия': 'name, bottom',
  '«VS»': '“VS”',
  'Фон обложки': 'Thumbnail background',
  'Загрузить картинку': 'Upload an image',
  'Заменить картинку': 'Replace the image',
  'Обрежется по центру до 1280×720 и сожмётся прямо в браузере. Без картинки обложка рисуется на тёмной подложке.':
    'It is cropped from the centre to 1280×720 and compressed right in the browser. Without an image the thumbnail is drawn on a dark backdrop.',
  'Фон обновлён.': 'Background updated.',
  'Не удалось прочитать картинку.': 'Could not read the image.',

  'Изменить название и фон': 'Change the name and background',

  'Файлы': 'Files',
  'своё название': 'custom title',
  'название появится, когда впишете соперника': 'the title appears once you name the opponent',
  'не закрывайте вкладку': 'keep this tab open',

  // ---- Привязки ----
  'Привязки': 'Account links',
  'Кто из Discord каким игроком записан. Привязку выдаёт бот при регистрации.':
    'Which Discord account belongs to which player. The bot creates the link during registration.',
  'Пока никто не привязался.': 'Nobody has linked an account yet.',
  'В составе': 'In the roster',
  'Нет в составе': 'Not in the roster',
  'Карточки игрока больше нет, поэтому прав такая привязка не даёт. Если человека завели заново — выберите его в списке, и повторная регистрация не понадобится.':
    'The player card is gone, so this link grants nothing. If the person was added again, pick them from the list — they will not have to register a second time.',
  'привязать к…': 'link to…',
  'неизвестно': 'unknown',
  'Привязка перенесена.': 'Link moved.',
  'Отвязка срабатывает мгновенно и ничего не разрушает. Удалять игрока из состава ради отзыва прав не нужно — это снесёт его заявки и расстановки.':
    'Unbinding takes effect immediately and destroys nothing. Do not delete a player from the roster just to revoke access — that wipes their sign-ups and lineups.',
  // %s — имя человека. Подставляется на месте, чтобы строка целиком попадала в
  // словарь: шаблонная строка с ${} ключом стать не может и осталась бы русской.
  'Отвязать %s? Человек перестанет быть кем-либо на сайте.':
    'Unbind %s? They will stop being anyone on the site.',
};

// Модульный язык (для localize вне React — напр. для «самопереводящихся» меток-Proxy
// в constants). Держится в синхроне с провайдером.
let _lang: Lang = (typeof localStorage !== 'undefined' && (localStorage.getItem(LANG_KEY) as Lang)) || 'ru';
export const localize = (s: string): string => (_lang === 'en' ? (EN[s] ?? s) : s);

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string; }
const LangCtx = createContext<Ctx>({ lang: 'ru', setLang: () => {}, t: (s) => s });

export const LangProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem(LANG_KEY) as Lang) || 'ru');
  const setLang = (l: Lang) => { _lang = l; localStorage.setItem(LANG_KEY, l); setLangState(l); };
  const t = useCallback((s: string) => (lang === 'en' ? (EN[s] ?? s) : s), [lang]);
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
};

export const useLang = () => useContext(LangCtx);
export const useT = () => useContext(LangCtx).t;
