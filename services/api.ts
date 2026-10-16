import { Player, GuildWarSession, MapTemplate } from '../types';
import { LifecycleConfig } from './datetime';

// Бэкенд на том же домене (за Caddy). В dev — через прокси Vite на localhost:3001.
const BASE = '/api';

export interface AppState {
  players: Player[];
  sessions: GuildWarSession[];
  activeSessionId?: string | null; // устар.: больше не синхронизируется (локальный выбор)
  mapTemplates?: MapTemplate[];     // стратегии карты (общие для всех, синхронизируются)
}

// Привязка аккаунта Телеграма к нику (для офицерской админки)
export interface TgLink {
  telegramId: string;
  playerId: string;
  playerName: string;
}

// Состояние настройки бота (админка). Токен целиком не отдаётся — только подсказка.
export interface TgConfig {
  hasToken: boolean;
  connected: boolean;
  botUsername: string;
  tokenHint: string;
  chatId: string;
  chatTitle: string;
  threadId: string;
  threadName: string;
  siteUrl: string;
  dmEnabled: boolean;       // слать ли карточку события в личку подписавшимся
  remindBeforeMin: number;  // за сколько минут напоминать молчунам (0 — не напоминать)
  subscriberCount: number;  // сколько человек подписалось
  targets: TgTarget[];      // темы, о которых бот знает (добавляются через /sithere)
  routes: Record<string, TgRouteCell>; // `${день}:${тип}` -> темы
}

// Тема беседы, куда бот умеет писать
export interface TgTarget { threadId: string; name: string; }
export interface TgRouteCell { threadIds: string[]; }

// ---- Discord ----
// Клетка таблицы маршрутов: ключ `${день 0..6}:${prak|ranked|league}` -> куда публиковать
export interface RouteCell { discordChannelIds: string[]; }

// Состояние интеграции (токен целиком не отдаётся — только подсказка)
export interface DiscordConfig {
  hasToken: boolean;
  tokenHint: string;
  appName: string;
  botUsername: string;
  applicationId: string;
  hasPublicKey: boolean;
  guildId: string;
  pingRoleId: string;
  registerChannelId: string;
  registerRoleId: string;
  registerPosted: boolean;  // сообщение с кнопкой уже стоит в канале — повторное нажатие его обновит
  routes: Record<string, RouteCell>;
  emojiCount: number;       // сколько иконок школ загружено в Discord
  siteUrl: string;
  lang: 'ru' | 'en';        // язык сообщений Discord-бота (у Телеграма своего нет)
  dmEnabled: boolean;       // слать ли личку подписавшимся
  remindBeforeMin: number;  // за сколько минут напоминать молчунам (0 — не напоминать)
  subscriberCount: number;  // сколько человек подписалось на личку
  // Обращения Discord к нашему Interactions Endpoint. Discord не отдаёт наружу, принял
  // ли он адрес, поэтому единственный честный признак «команды доходят» — что у нас
  // была хотя бы одна проверенная подпись. Обнуляется при перезапуске бэкенда.
  endpointOkAt: number;        // 0 — ни одного обращения не было
  endpointFailAt: number;      // когда последний раз подпись не сошлась
  endpointFailCount: number;   // сколько всего таких случаев
  // ---- Вход на сайт через Discord ----
  officerRoleId: string;       // роль, дающая права редактора (отдельно от роли-гейта)
  accessMode: 'open' | 'closed';
  loginEnabled: boolean;
  hasClientSecret: boolean;
  secretHint: string;
}

// Привязка аккаунта Discord к нику (офицерская админка).
// alive = карточка игрока на месте. Мёртвые не удаляются сами: подписи ниже нужны,
// чтобы офицер вообще понял, чья это привязка, и мог её починить или снять.
export interface DiscordLink {
  discordId: string;
  playerId: string;
  playerName: string;
  alive: boolean;
  discordName: string;     // как человек подписан в Discord
  lastPlayerName: string;  // последний известный ник в составе
}

// Подключение канала YouTube (офицерская панель). Секреты наружу не отдаются.
export interface YtSetup {
  hasKeys: boolean;          // client_id и client_secret вписаны
  clientIdHint: string;
  hasToken: boolean;         // канал подключён (полный доступ для сервера)
  hasUploadToken: boolean;   // есть отдельный ключ только на загрузку
  redirectUri: string;       // это вставляют в Google Console
}

// Состояние заливки записей. ready=false означает, что кнопку нажимать нельзя —
// и причина известна ЗАРАНЕЕ, до того как человек выбрал файлы на четыре гигабайта.
export interface YtStatus {
  configured: boolean;      // ключи Google прописаны в службе
  ready: boolean;           // связь с каналом есть и ник известен
  nick: string;             // игровой ник — он же имя плейлиста
  dailyLimit: number;
  problem?: string;         // network | access | quota | api
  channel?: string;
  tokenScope?: string;   // что реально выдал Google браузеру
  uploadsToday?: number | null;
  playlist?: { id: string; privacy: 'unlisted' | 'public' } | null;
  // Оформление обложки: задаётся офицером и живёт в данных, а не в сборке
  thumb?: {
    guildName: string;
    goldTop: string;
    goldBottom: string;
    vsColor: string;
    hasBg: boolean;
  };
}

// Галерея записей канала. Приходит целиком одним ответом и фильтруется в
// браузере: пятьсот строк весят десятки килобайт, а фильтр на сервере означал бы
// запрос на каждое нажатие галочки.
export interface YtVideo {
  id: string;
  title: string;
  thumb: string;
  at: string;                // когда запись опубликована на канале (ISO)
  privacy: string;           // unlisted | public | private
  seconds: number;           // длительность; 0 — неизвестна
  // Почему запись не играется во встроенном плеере ('' — играется).
  // age — возрастное ограничение YouTube: снять его через API нельзя,
  // такие записи открываются только на самом YouTube.
  blocked: '' | 'age' | 'noembed' | 'processing';
}
export interface YtPlaylist {
  id: string;
  title: string;             // игровой ник владельца
  count: number;
  privacy: string;
}
export interface YtGallery {
  configured: boolean;
  me?: string;               // мой ник — чтобы подсветить свои записи
  channel?: string;
  videos: YtVideo[];
  playlists: YtPlaylist[];
  cached?: boolean;
  forbidden?: boolean;       // зашёл не привязанный к составу — списка ему не даём
}

// Кто я на сайте. Присылается на каждой загрузке страницы.
export interface Session {
  loginEnabled: boolean;
  accessMode: 'open' | 'closed';
  registerUrl: string;       // ссылка прямо в канал регистрации ('' — канал не выбран)
  user: {
    discordId: string;
    name: string;
    playerId: string;
    playerName: string;
    linked: boolean;         // привязан к живой карточке в составе
    officer: boolean;
  } | null;
}

export interface DiscordGuild { id: string; name: string; }
export interface DiscordChannel { id: string; name: string; parentId: string; }
export interface DiscordRole { id: string; name: string; color: number; managed: boolean; }

// Один человек = одно "присутствие" на сайте (привязано к браузеру, не к паролю)
export interface PresenceEntry {
  clientId: string;
  guestName: string;       // случайное имя ("Гусь3"), пока человек не выбрал себя в составе
  playerId: string | null; // выбранный участник гильдии, если закрепился
  isEditor: boolean;       // сейчас в режиме редактирования (вошёл по паролю)
}

const isState = (d: any): d is AppState =>
  d && Array.isArray(d.players) && Array.isArray(d.sessions);

// Значение HTTP-заголовка не может содержать символы вне 0..255, а пароль офицера
// вполне бывает с кириллицей — тогда fetch падает с TypeError ДО отправки, и
// выглядит это как «вошёл, но ничего не сохраняется». Поэтому ключ кодируем в
// base64 (как Basic-аутентификация). btoa сам не умеет юникод, поэтому сначала
// переводим в байты UTF-8. Сервер принимает и base64, и старую сырую форму.
const authHeader = (key: string): string => {
  const bytes = new TextEncoder().encode(key);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Bearer ${btoa(bin)}`;
};

const CLIENT_ID_KEY = 'wmgs_client_id';

// Случайный, постоянный (хранится в браузере) ID — отличает людей друг от друга для присутствия
export const getClientId = (): string => {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
};

export const api = {
  // Прочитать состояние гильдии (публично, для просмотра)
  // key нужен в Закрытом режиме: там чтение состояния закрыто, и офицер, вошедший
  // ПАРОЛЕМ (а не через Discord), без заголовка получал 403 — сайт открывался пустым.
  // У вошедшего через Discord печенька уходит сама, ему ключ не нужен.
  async getState(key?: string | null): Promise<AppState | null> {
    try {
      const r = await fetch(`${BASE}/state`, {
        cache: 'no-store',
        headers: key ? { authorization: authHeader(key) } : {}
      });
      if (!r.ok) return null;
      const data = await r.json();
      return isState(data) ? data : null;
    } catch {
      return null;
    }
  },

  // Сроки закрытия регистрации по типу события (публично; см. services/datetime.ts)
  // Архив расстановок прошедших событий — память автозаполнения. Живёт отдельно от
  // состояния именно затем, чтобы пережить удаление события: у нас разобранные праки
  // удаляют раз в неделю, и вся история иначе обнулялась бы каждую неделю.
  // Запрашивается по нажатию кнопки, а не при загрузке: нужен только там.
  async getLineups(key?: string | null): Promise<unknown[]> {
    try {
      const r = await fetch(`${BASE}/lineups`, {
        cache: 'no-store',
        headers: key ? { authorization: authHeader(key) } : {}
      });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];   // архив недоступен — расставим по тому, что есть в состоянии
    }
  },

  async getLifecycle(): Promise<LifecycleConfig | null> {
    try {
      const r = await fetch(`${BASE}/lifecycle`, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },

  // Проверить пароль редактора (вернёт true, если верный)
  async auth(password: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      return r.ok;
    } catch {
      return false;
    }
  },

  // Сохранить состояние (только с верным паролем-ключом).
  // silent — «тихое» сохранение: сервер не трогает Телеграм (ни анонсов, ни удалений).
  // Нужно для импорта: иначе бот принял бы вернувшиеся из бэкапа события за новые.
  // key === null — офицер по роли в Discord: заголовка нет, право подтверждает
  // печенька. Слать `Bearer` от пустого ключа нельзя — это просто неверный пароль.
  async putState(
    state: AppState,
    key: string | null,
    opts?: { silent?: boolean }
  ): Promise<'ok' | 'unauthorized' | 'error'> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (key) headers.authorization = authHeader(key);
      const r = await fetch(`${BASE}/state`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(opts?.silent ? { ...state, silent: true } : state)
      });
      if (r.status === 401 || r.status === 403) return 'unauthorized';
      return r.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  },

  // Сменить пароль редактора (нужен текущий пароль-ключ). 'weak' — новый слишком короткий.
  async changePassword(currentKey: string, newPassword: string): Promise<'ok' | 'unauthorized' | 'weak' | 'error'> {
    try {
      const r = await fetch(`${BASE}/auth/change`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(currentKey) },
        body: JSON.stringify({ newPassword })
      });
      if (r.status === 401 || r.status === 403) return 'unauthorized';
      if (r.status === 422) return 'weak';
      return r.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  },

  // Закрепить ник за собой (выбрать себя в составе гильдии)
  async claimPlayer(clientId: string, playerId: string): Promise<'ok' | 'taken' | 'error'> {
    try {
      const r = await fetch(`${BASE}/presence/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, playerId })
      });
      if (r.status === 409) return 'taken';
      return r.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  },

  // Снять закрепление (если выбрал не себя по ошибке)
  async unclaimPlayer(clientId: string): Promise<'ok' | 'error'> {
    try {
      const r = await fetch(`${BASE}/presence/unclaim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      return r.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  },

  // Заявка на событие. status: 'in'|'maybe'|'out'|'sub' или null (снять заявку).
  // Сервер разрешает писать только СВОЮ заявку (по привязке «это я» к clientId);
  // офицер с ключом (editKey) может ставить любому.
  async signup(
    clientId: string,
    sessionId: string,
    playerId: string,
    status: 'in' | 'maybe' | 'out' | 'sub' | null,
    editKey?: string
  ): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (editKey) headers['authorization'] = authHeader(editKey);
      const r = await fetch(`${BASE}/signup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientId, sessionId, playerId, status })
      });
      return r.ok;
    } catch {
      return false;
    }
  },

  // Пометить игрока недоступным (null — снять). Себе может любой закреплённый,
  // любому — офицер. Сервер сам проставит «Не иду» и освободит места в составах.
  async setUnavailable(
    clientId: string,
    playerId: string,
    unavailable: { note?: string; until?: string } | null,
    editKey?: string
  ): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (editKey) headers['authorization'] = authHeader(editKey);
      const r = await fetch(`${BASE}/unavailable`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientId, playerId, unavailable })
      });
      return r.ok;
    } catch {
      return false;
    }
  },

  // Список привязок Телеграма (только офицер). Пусто/ошибка → [].
  async listTgLinks(key: string): Promise<TgLink[]> {
    try {
      const r = await fetch(`${BASE}/tglinks`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data.links) ? data.links : [];
    } catch {
      return [];
    }
  },

  // Принудительно отвязать аккаунт Телеграма от ника (офицер)
  async unbindTgLink(key: string, telegramId: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/tglinks/unbind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ telegramId })
      });
      return r.ok;
    } catch {
      return false;
    }
  },

  // Текущее состояние настройки бота (офицер)
  async getTgConfig(key: string): Promise<TgConfig | null> {
    try {
      const r = await fetch(`${BASE}/tgconfig`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },

  // Сохранить сроки закрытия/удаления по типам событий (офицер)
  async putLifecycle(key: string, cfg: LifecycleConfig): Promise<LifecycleConfig | 'error'> {
    try {
      const r = await fetch(`${BASE}/lifecycle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify(cfg)
      });
      return r.ok ? await r.json() : 'error';
    } catch {
      return 'error';
    }
  },

  // ---- Discord (всё под паролем офицера) ----
  async getDiscordConfig(key: string): Promise<DiscordConfig | null> {
    try {
      const r = await fetch(`${BASE}/discord/config`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },

  // Сохранить настройки. token передаётся только когда его меняют ('' — отключить бота).
  async putDiscordConfig(
    key: string,
    body: Partial<{
      token: string; guildId: string; pingRoleId: string; registerChannelId: string;
      registerRoleId: string; routes: Record<string, RouteCell>;
      dmEnabled: boolean; remindBeforeMin: number; lang: 'ru' | 'en';
      officerRoleId: string; accessMode: 'open' | 'closed'; loginEnabled: boolean;
    }>
  ): Promise<DiscordConfig | 'invalid' | 'unreachable' | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify(body)
      });
      // Сервер различает «Discord отверг токен» и «Discord не ответил», и это разные
      // советы офицеру: в первом случае перевводить токен, во втором — просто подождать.
      // Раньше клиент схлопывал оба в 'invalid', и человек перевводил заведомо верный токен.
      if (r.status === 422) {
        let msg = '';
        try { msg = String((await r.json())?.error || ''); } catch { /* тело не разобралось */ }
        return /не ответил|unreachable/i.test(msg) ? 'unreachable' : 'invalid';
      }
      return r.ok ? await r.json() : 'error';
    } catch {
      return 'error';
    }
  },

  // Живые списки из Discord.
  //
  // Возвращаем 'error' вместо null, когда запрос не удался. Раньше и «ещё не грузили»,
  // и «Discord не ответил» давали одно и то же значение, поэтому панель при недоступном
  // Discord навсегда показывала «Загрузка каналов…» — выглядело как зависшая страница.
  async listDiscordGuilds(key: string): Promise<DiscordGuild[] | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/guilds`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? (await r.json()).guilds : 'error';
    } catch { return 'error'; }
  },

  async listDiscordChannels(key: string): Promise<DiscordChannel[] | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/channels`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? (await r.json()).channels : 'error';
    } catch { return 'error'; }
  },

  async listDiscordRoles(key: string): Promise<DiscordRole[] | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/roles`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? (await r.json()).roles : 'error';
    } catch { return 'error'; }
  },

  // Загрузить иконки школ как эмодзи приложения. Картинки берём из сборки фронта
  // и шлём как data:image/png;base64 — на сервере папки assets/ нет.
  async syncDiscordEmojis(key: string, images: Record<string, string>): Promise<{ total: number; uploaded: number; failed: number } | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/emojis`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ images })
      });
      return r.ok ? await r.json() : 'error';
    } catch { return 'error'; }
  },

  // Опубликовать в канале регистрации сообщение с кнопкой (один раз)
  // 'updated' — сообщение уже стояло в канале и было переписано, а не продублировано
  async postDiscordRegisterMessage(key: string): Promise<'ok' | 'updated' | 'error'> {
    try {
      const r = await fetch(`${BASE}/discord/register-message`, {
        method: 'POST', headers: { authorization: authHeader(key) }
      });
      if (!r.ok) return 'error';
      const body = await r.json().catch(() => ({}));
      return body?.updated ? 'updated' : 'ok';
    } catch { return 'error'; }
  },

  async listDiscordLinks(key: string): Promise<DiscordLink[]> {
    try {
      const r = await fetch(`${BASE}/discord/links`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      if (!r.ok) return [];
      return (await r.json()).links || [];
    } catch { return []; }
  },

  async unbindDiscordLink(key: string, discordId: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/discord/links/unbind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ discordId })
      });
      return r.ok;
    } catch { return false; }
  },

  // Перенацелить привязку на другую карточку — случай «удалил игрока и завёл заново».
  // Возвращает текст ошибки, если ник уже занят или карточки нет.
  async rebindDiscordLink(key: string, discordId: string, playerId: string): Promise<string | null> {
    try {
      const r = await fetch(`${BASE}/discord/links/rebind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ discordId, playerId })
      });
      if (r.ok) return null;
      return (await r.json().catch(() => ({})))?.error || 'Не получилось';
    } catch { return 'Сервер не ответил'; }
  },

  // ---- Заливка записей ГВГ на YouTube ----
  // Все ручки ходят по печеньке: ник сервер берёт из неё сам, в запросе его нет.

  async getYtStatus(): Promise<YtStatus> {
    const off: YtStatus = { configured: false, ready: false, nick: '', dailyLimit: 100 };
    try {
      const r = await fetch(`${BASE}/yt/status`, { cache: 'no-store' });
      return r.ok ? await r.json() : off;
    } catch { return off; }
  },

  async getYtToken(): Promise<{ accessToken: string; scope: string; expiresAt: number } | null> {
    try {
      const r = await fetch(`${BASE}/yt/token`, { method: 'POST' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /** Положить залитое видео в свой плейлист. Чей он — решает сервер по печеньке. */
  async ytAttach(videoId: string, privacy: 'unlisted' | 'public'): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/yt/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId, privacy })
      });
      return r.ok;
    } catch { return false; }
  },

  /** Сменить видимость плейлиста вместе со всеми записями внутри. */
  async ytPrivacy(privacy: 'unlisted' | 'public'):
    Promise<{ total: number; changed: number; failed: number } | null> {
    try {
      const r = await fetch(`${BASE}/yt/privacy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ privacy })
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /**
   * Записи канала для галереи. `force` (только офицеру) сбрасывает кэш сервера —
   * обычное открытие вкладки берёт из него и Google не тревожит.
   */
  async getYtGallery(force = false): Promise<YtGallery | null> {
    try {
      const r = await fetch(`${BASE}/yt/gallery${force ? '?force=1' : ''}`, { cache: 'no-store' });
      if (r.status === 403) return { configured: true, videos: [], playlists: [], forbidden: true };
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /** Состояние подключения канала: что уже вписано и что осталось. */
  async getYtSetup(key: string): Promise<YtSetup | null> {
    try {
      const r = await fetch(`${BASE}/yt/setup`, { headers: { authorization: authHeader(key) }, cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  /** Ключи приложения Google. Смена ключей сбрасывает подключение: они от другого приложения. */
  async setYtKeys(key: string, clientId: string, clientSecret: string): Promise<YtSetup | null> {
    try {
      const r = await fetch(`${BASE}/yt/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ clientId, clientSecret })
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  },

  async ytDisconnect(key: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/yt/disconnect`, {
        method: 'POST', headers: { authorization: authHeader(key) }
      });
      return r.ok;
    } catch { return false; }
  },

  /** Оформление обложки: название гильдии и цвета. Меняет только офицер. */
  async setYtThumb(key: string, patch: Record<string, string>): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/yt/thumb`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify(patch)
      });
      return r.ok;
    } catch { return false; }
  },

  /** Фон обложки. Картинка идёт из браузера офицера: на сервере assets/ нет. */
  async setYtThumbBg(key: string, dataUrl: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/yt/thumb/bg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ image: dataUrl })
      });
      return r.ok;
    } catch { return false; }
  },

  // ---- Вход через Discord ----

  // Кто я. Печенька уходит сама, поэтому ключа тут не нужно.
  async getSession(): Promise<Session> {
    const off: Session = { loginEnabled: false, accessMode: 'open', registerUrl: '', user: null };
    try {
      const r = await fetch(`${BASE}/session`, { cache: 'no-store' });
      if (!r.ok) return off;
      return await r.json();
    } catch { return off; }   // сервер молчит — ведём себя как без входа
  },

  async logout(): Promise<void> {
    try { await fetch(`${BASE}/auth/logout`, { method: 'POST' }); } catch { /* и так уйдём */ }
  },

  // Client secret приложения. Наружу он не отдаётся никогда — только признак «задан».
  async setDiscordSecret(key: string, clientSecret: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/discord/secret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify({ clientSecret })
      });
      return r.ok;
    } catch { return false; }
  },

  // «Обновить данные Discord»: немедленно перепроверить права всех, кто на сайте.
  // Списки каналов и ролей панель перечитывает сама — они нигде не хранятся.
  async refreshDiscord(key: string): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/discord/refresh`, {
        method: 'POST', headers: { authorization: authHeader(key) }
      });
      return r.ok;
    } catch { return false; }
  },

  // Настройки Телеграма: токен (пустой — отключить) и/или параметры лички.
  async setTgToken(
    key: string,
    token?: string,
    dm?: { dmEnabled?: boolean; remindBeforeMin?: number; routes?: Record<string, TgRouteCell> }
  ): Promise<TgConfig | 'invalid' | 'error'> {
    try {
      const body: Record<string, unknown> = { ...(dm || {}) };
      if (typeof token === 'string') body.token = token;
      const r = await fetch(`${BASE}/tgconfig`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: authHeader(key) },
        body: JSON.stringify(body)
      });
      if (r.status === 422) return 'invalid';
      if (!r.ok) return 'error';
      return await r.json();
    } catch {
      return 'error';
    }
  }
};

// Живой поток событий с сервера (SSE поверх fetch, чтобы можно было слать заголовок Authorization —
// обычный EventSource заголовки не поддерживает). Сам переподключается при разрыве.
// Возвращает функцию остановки подписки.
export function subscribeEvents(
  clientId: string,
  editKey: string | null,
  handlers: {
    onState?: (s: AppState) => void;
    onPresence?: (p: PresenceEntry[]) => void;
    onStatus?: (connected: boolean) => void;
    onAuthRevoked?: () => void;
    onLifecycle?: (cfg: LifecycleConfig) => void;
  }
): () => void {
  let stopped = false;
  let abort: AbortController | null = null;

  const run = async () => {
    while (!stopped) {
      abort = new AbortController();
      try {
        const headers: Record<string, string> = {};
        if (editKey) headers['authorization'] = authHeader(editKey);
        const res = await fetch(`${BASE}/events?clientId=${encodeURIComponent(clientId)}`, {
          headers,
          signal: abort.signal,
          cache: 'no-store'
        });
        if (!res.ok || !res.body) throw new Error('stream');
        if (!stopped) handlers.onStatus?.(true); // поток открыт — связь есть

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (event === 'authrevoked') { handlers.onAuthRevoked?.(); continue; }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (event === 'state' && handlers.onState) handlers.onState(parsed);
              if (event === 'presence' && handlers.onPresence) handlers.onPresence(parsed);
              if (event === 'lifecycle' && handlers.onLifecycle) handlers.onLifecycle(parsed);
            } catch {}
          }
        }
      } catch {
        // соединение упало — переподключимся ниже
      }
      if (stopped) break;
      handlers.onStatus?.(false); // связь потеряна, идём на переподключение
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  run();
  return () => { stopped = true; abort?.abort(); };
}
