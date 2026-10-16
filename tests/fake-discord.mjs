// Подменяет глобальный fetch в процессе сервера, чтобы Discord и Telegram отвечали
// так, как задано переменной FAKE_MODE. Подключается через `node --import`.
//
// Зачем. Самый опасный класс отказов у этого приложения — не баг в логике, а внешний
// сервис, который повёл себя не по учебнику: ответил 500, оборвал соединение, прислал
// HTML вместо JSON или начал душить лимитом. Так уже было: один
// недоступный Discord когда-то ронял весь сайт вместе с ботом. Проверять это на живом
// Discord невозможно — он по заказу не ломается. Поэтому ломаем сами.
//
// FAKE_MODE:
//   ok        — всё отвечает успешно (годно для проверки счастливого пути)
//   500       — Discord всегда отвечает 500
//   429       — Discord всегда душит лимитом с retry_after
//   network   — fetch бросает исключение (обрыв, DNS, блокировка)
//   garbage   — ответ 200, но тело — HTML, а не JSON
//   timeout   — запрос висит дольше таймаута
//   slow      — отвечает успешно, но через 300 мс

import fs from 'node:fs';

const MODE = process.env.FAKE_MODE || 'ok';
const realFetch = globalThis.fetch;

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' }
});

// Роли участников для проверки входа: { [discordUserId]: [roleId, …] }. Лежат в
// ФАЙЛЕ, а не в переменной окружения, чтобы тест мог снять роль на ходу и проверить
// то самое «убрал роль — через минуту пропала», не поднимая сервер заново.
const rolesOf = (userId) => {
  const file = process.env.FAKE_ROLES_FILE;
  if (!file) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[userId] || [];
  } catch { return []; }
};

// Правдоподобные ответы YouTube. Настоящий канал по заказу не ломается и не
// отдаёт предсказуемых цифр, а проверять надо именно поведение сайта.
const youtubeFor = (url, method) => {
  if (url.includes('oauth2.googleapis.com/token')) {
    return jsonResponse({
      access_token: 'fake-access', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/youtube.upload'
    });
  }
  if (url.includes('/youtube/v3/channels')) {
    return jsonResponse({ items: [{
      snippet: { title: 'Test Guild' },
      contentDetails: { relatedPlaylists: { uploads: 'UU-fake-uploads' } }
    }] });
  }
  if (url.includes('/youtube/v3/playlistItems')) {
    if (method === 'POST') return jsonResponse({ id: 'pli-fake' });
    const now = new Date().toISOString();
    // Названия настоящей формы: галерея разбирает их обратно на ник, дату и
    // соперника, и без этого проверять фильтры было бы не на чем. Седьмая
    // запись нарочно «неправильная» — на канале такие есть.
    const title = (i) => (i === 6
      ? 'просто ролик без разметки'
      : `${i % 2 ? 'Игрок2' : 'Игрок1'} [2026-08-0${i % 2 ? '1' : '4'}] vs ${i % 2 ? 'Другие' : 'Enemy'}`);
    return jsonResponse({ items: Array.from({ length: 7 }, (_, i) => ({
      contentDetails: { videoId: 'vid' + i, videoPublishedAt: now },
      snippet: { title: title(i), thumbnails: { medium: { url: `https://i.ytimg.com/vi/vid${i}/mqdefault.jpg` } } },
      status: { privacyStatus: 'unlisted' }
    })) });
  }
  if (url.includes('/youtube/v3/playlists')) {
    if (method === 'POST') return jsonResponse({ id: 'PL-fake', snippet: { title: 'Игрок1' }, status: { privacyStatus: 'unlisted' } });
    return jsonResponse({ items: [
      { id: 'PL-fake', snippet: { title: 'Игрок1' }, contentDetails: { itemCount: 4 }, status: { privacyStatus: 'unlisted' } },
      { id: 'PL-two', snippet: { title: 'Игрок2' }, contentDetails: { itemCount: 3 }, status: { privacyStatus: 'public' } }
    ] });
  }
  if (url.includes('/youtube/v3/videos')) {
    if (method !== 'GET') return jsonResponse({ id: 'vid-fake' });
    // Сверка «живо ли видео». vid3 нарочно НЕ отдаём — так выглядит удалённая
    // запись: в списке загрузок она ещё висит, а здесь её уже нет.
    // vid5 — с возрастным ограничением: встроенный плеер его не покажет.
    const ids = (new URL(url).searchParams.get('id') || '').split(',').filter(Boolean);
    const title = (i) => (i === 6
      ? 'просто ролик без разметки'
      : `${i % 2 ? 'Игрок2' : 'Игрок1'} [2026-08-0${i % 2 ? '1' : '4'}] vs ${i % 2 ? 'Другие' : 'Enemy'}`);
    return jsonResponse({ items: ids.filter(id => id !== 'vid3').map(id => {
      const i = Number(id.replace('vid', ''));
      return {
        id,
        snippet: {
          title: title(i), publishedAt: new Date().toISOString(),
          thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } }
        },
        status: { privacyStatus: 'unlisted', uploadStatus: 'processed', embeddable: true },
        contentDetails: {
          duration: 'PT7M4S',
          ...(id === 'vid5' ? { contentRating: { ytRating: 'ytAgeRestricted' } } : {})
        }
      };
    }) });
  }
  return null;
};

// Правдоподобные ответы Discord на те запросы, которые делает бот
const okFor = (url, method, headers) => {
  const auth = String(headers?.authorization || headers?.Authorization || '');
  const yt = youtubeFor(url, method);
  if (yt) return yt;
  // Обмен кода на личность при входе через сайт
  if (url.includes('/oauth2/token')) return jsonResponse({ access_token: 'user-token', token_type: 'Bearer' });
  // Один конкретный участник — так сайт узнаёт роли вошедшего (привилегированный
  // интент для этого не нужен, в отличие от списка всех участников)
  const member = url.match(/\/guilds\/[^/]+\/members\/([^/?]+)/);
  if (member) {
    // Считаем обращения: обещание «обычный игрок не стоит Discord ни одного
    // запроса» проверяется только счётом, глазами его не увидеть.
    if (process.env.FAKE_CALLS_FILE) {
      try { fs.appendFileSync(process.env.FAKE_CALLS_FILE, member[1] + '\n'); } catch { /* не мешаем */ }
    }
    const roles = rolesOf(member[1]);
    // Значение "fail" вместо списка = Discord не отвечает про этого человека.
    // Так проверяется главное обещание: чужой сбой не отбирает права и не мешает
    // гильдии отмечаться на прак.
    if (roles === 'fail') return jsonResponse({ message: 'Internal Server Error' }, 500);
    return jsonResponse({ user: { id: member[1] }, roles });
  }
  // Раньше /users/@me стоял выше и перекрывал собой /users/@me/guilds — список
  // серверов подделка не отдавала вовсе. Порядок здесь значим.
  if (url.includes('/users/@me/guilds')) return jsonResponse([{ id: 'g1', name: 'Fake Guild' }]);
  if (url.includes('/users/@me')) {
    // «Bearer …» — это токен человека, полученный при входе; «Bot …» — токен бота.
    // Разные ответы: иначе вошедший на сайт оказался бы самим ботом.
    if (auth.startsWith('Bearer ')) {
      return jsonResponse({ id: process.env.FAKE_LOGIN_ID || 'u1', username: 'Игрок', global_name: 'Игрок' });
    }
    return jsonResponse({ id: '1', username: 'fake-bot' });
  }
  if (url.includes('/applications/@me')) {
    return jsonResponse({ id: '123456789012345678', name: 'Fake App', verify_key: 'ab'.repeat(32) });
  }
  if (/\/guilds\/[^/]+\/channels/.test(url)) {
    return jsonResponse([
      { id: 'c1', name: 'анонсы', type: 0 },
      { id: 'c2', name: 'голосовой', type: 2 },
      { id: 'c3', name: 'новости', type: 5 }
    ]);
  }
  if (/\/guilds\/[^/]+\/roles/.test(url)) {
    return jsonResponse([{ id: 'r1', name: 'Гильдия' }, { id: 'r2', name: '@everyone' }]);
  }
  if (url.includes('/emojis')) {
    if (method === 'GET') return jsonResponse({ items: [] });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ id: String(Math.floor(Math.random() * 1e18)), name: 'x' });
  }
  if (/\/channels\/[^/]+\/messages/.test(url)) {
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({ id: String(Date.now()), channel_id: 'c1' });
  }
  // Telegram
  if (url.includes('api.telegram.org')) {
    if (url.includes('getMe')) return jsonResponse({ ok: true, result: { username: 'fake_tg_bot' } });
    if (url.includes('getUpdates')) return jsonResponse({ ok: true, result: [] });
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  }
  return jsonResponse({ ok: true });
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input));
  const external = url.includes('discord.com') || url.includes('api.telegram.org')
    || url.includes('googleapis.com');
  if (!external) return realFetch(input, init);   // локальные запросы не трогаем

  const method = (init.method || 'GET').toUpperCase();
  switch (MODE) {
    case '500':
      return jsonResponse({ message: 'Internal Server Error', code: 0 }, 500);
    case '429':
      return jsonResponse({ message: 'You are being rate limited.', retry_after: 0.2, global: false }, 429);
    case 'network':
      throw new TypeError('fetch failed: соединение оборвано (подделка)');
    case 'garbage':
      return new Response('<html><body>503 Service Unavailable</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } });
    case 'timeout':
      await sleep(30_000);
      return jsonResponse({ ok: true });
    case 'slow':
      await sleep(300);
      return okFor(url, method, init.headers);
    default:
      return okFor(url, method, init.headers);
  }
};

if (process.env.FAKE_LOG === '1') console.log(`[fake] режим Discord/Telegram: ${MODE}`);
