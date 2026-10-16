// Подписанная печенька «кто ты». Без сети и без хранилища — поэтому покрыта тестами.
//
// Хранилища сессий нет намеренно: печенька несёт в себе id аккаунта Discord и срок,
// а подпись ключом сервера не даёт её подделать. Значит перезапуск процесса никого
// не выкидывает, а список живых сессий не надо ни держать, ни чистить.
//
// В печеньке лежит ТОЛЬКО личность — «ты вот этот аккаунт». Прав в ней нет: офицерство
// живёт в памяти сервера и обновляется отдельно, иначе снятая в Discord роль
// продолжала бы действовать до конца срока печеньки (то есть год).

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'wwm_session';
export const STATE_COOKIE = 'wwm_oauth';

// Год. На сайт заходят под начало гвг, раз в несколько дней; спрашивать вход каждый
// раз — верный способ, чтобы входом перестали пользоваться.
export const SESSION_MAX_AGE_MS = 365 * 24 * 3600_000;
// Столько живёт защита от подделки возврата: человеку хватает дойти до Discord и
// нажать «Авторизовать», а протухшая попытка не болтается в браузере месяцами.
export const STATE_MAX_AGE_MS = 10 * 60_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

const hmac = (data, key) => crypto.createHmac('sha256', key).update(data).digest();

// Сравнение постоянного времени: посимвольное выдаёт позицию расхождения, а по ней
// подпись подбирается за считанные попытки.
const sameSignature = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
};

/** Подписать произвольные данные. Возвращает строку вида `<данные>.<подпись>`. */
export const sign = (payload, key, { now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) => {
  const body = b64u(JSON.stringify({ ...payload, exp: now + maxAgeMs }));
  return `${body}.${b64u(hmac(body, key))}`;
};

/** Проверить подпись и срок. Любая неудача — null, разбирать причину наружу незачем. */
export const verify = (token, key, now = Date.now()) => {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!sameSignature(token.slice(dot + 1), b64u(hmac(body, key)))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (!Number.isFinite(data.exp) || data.exp <= now) return null;
  return data;
};

/** Разбор заголовка Cookie. Значение может содержать `=` (base64url его не даёт, но всё же). */
export const parseCookies = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* битая — пропускаем */ }
  }
  return out;
};

/**
 * Сборка заголовка Set-Cookie.
 * HttpOnly обязателен: печеньку не должен читать ни один скрипт на странице.
 * SameSite=Lax — печенька доезжает при возврате с Discord (обычный переход по ссылке),
 * но не уходит вместе с чужими фоновыми запросами.
 */
export const serializeCookie = (name, value, { maxAgeMs, secure = false } = {}) => {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  if (maxAgeMs !== undefined) bits.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  return bits.join('; ');
};

/** Печенька «удалить»: пустое значение и нулевой срок. */
export const clearCookie = (name, { secure = false } = {}) =>
  serializeCookie(name, '', { maxAgeMs: 0, secure });

/**
 * Адрес, на который Discord вернёт человека. Собираем из запроса, а не из настроек:
 * тот же приём, что и с адресом для интеракций в панели. Один сайт — один адрес,
 * и офицеру не приходится вписывать его дважды и в двух местах ошибаться.
 *
 * За Caddy протокол приходит в X-Forwarded-Proto: сам сокет внутри всегда http,
 * и без этого заголовка мы бы отдавали Discord адрес `http://`, который он не примет.
 */
export const requestOrigin = (req) => {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
};

export const isSecureRequest = (req) => requestOrigin(req).startsWith('https://');

export const callbackUrl = (req) => {
  const origin = requestOrigin(req);
  return origin ? `${origin}/api/auth/discord/callback` : '';
};
