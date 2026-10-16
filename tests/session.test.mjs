// Подпись печеньки. Без сети и без сервера, поэтому проверяется здесь целиком.
//
// Это единственное, что стоит между «я Кайто» и «я кто угодно»: сервер верит
// печеньке на слово, потому что сам её подписал. Значит ошибка тут — не баг, а
// открытая дверь, и проверять надо не «работает», а «НЕ работает, когда не должно».

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  sign, verify, parseCookies, serializeCookie, clearCookie,
  requestOrigin, callbackUrl, isSecureRequest, SESSION_MAX_AGE_MS
} from '../server/session.mjs';

const KEY = crypto.randomBytes(32);
const OTHER = crypto.randomBytes(32);

test('своя печенька читается обратно', () => {
  const t = sign({ did: '42', name: 'Кайто' }, KEY);
  const back = verify(t, KEY);
  assert.equal(back.did, '42');
  assert.equal(back.name, 'Кайто');
});

test('ГЛАВНОЕ: подписанная чужим ключом не проходит', () => {
  assert.equal(verify(sign({ did: '42' }, OTHER), KEY), null);
});

test('подделка содержимого ломает подпись', () => {
  const t = sign({ did: '42' }, KEY);
  const [body, sig] = t.split('.');
  // подменяем «кто я» на другого человека, подпись оставляем прежнюю
  const evil = Buffer.from(JSON.stringify({ did: '999', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(verify(`${evil}.${sig}`, KEY), null);
  assert.ok(verify(`${body}.${sig}`, KEY), 'нетронутая при этом обязана работать');
});

test('протухшая не проходит', () => {
  const t = sign({ did: '42' }, KEY, { now: Date.now() - 2000, maxAgeMs: 1000 });
  assert.equal(verify(t, KEY), null);
});

test('мусор вместо печеньки не роняет проверку', () => {
  for (const bad of ['', 'абв', '...', 'a.b', null, undefined, 42, 'a'.repeat(5000)]) {
    assert.equal(verify(bad, KEY), null, `на входе ${String(bad).slice(0, 20)}`);
  }
});

test('срок по умолчанию — год: окно входа человек видит один раз', () => {
  const back = verify(sign({ did: '1' }, KEY), KEY);
  const days = (back.exp - Date.now()) / 86400000;
  assert.ok(days > 364 && days < 366, 'ожидали ~365 дней, вышло ' + Math.round(days));
  assert.equal(SESSION_MAX_AGE_MS, 365 * 24 * 3600_000);
});

test('разбор заголовка Cookie', () => {
  const c = parseCookies('a=1; wwm_session=abc.def; пусто=; кривая');
  assert.equal(c.a, '1');
  assert.equal(c.wwm_session, 'abc.def');
  assert.equal(c['пусто'], '');
  assert.equal(c['кривая'], undefined, 'кусок без = игнорируем, а не падаем');
});

test('печенька закрыта от скриптов и от чужих сайтов', () => {
  const h = serializeCookie('wwm_session', 'v', { maxAgeMs: 60_000, secure: true });
  assert.match(h, /HttpOnly/, 'без HttpOnly её прочитает любой скрипт на странице');
  assert.match(h, /SameSite=Lax/);
  assert.match(h, /Secure/);
  assert.match(h, /Max-Age=60\b/);
  assert.ok(!serializeCookie('x', 'v', {}).includes('Secure'), 'по http Secure ставить нельзя — печенька просто не доедет');
});

test('удаление печеньки — нулевой срок', () => {
  assert.match(clearCookie('wwm_session'), /Max-Age=0/);
});

test('адрес возврата берётся из запроса, за прокси — по X-Forwarded-Proto', () => {
  const req = (headers) => ({ headers, socket: {} });
  assert.equal(
    callbackUrl(req({ host: 'guild.example.com', 'x-forwarded-proto': 'https' })),
    'https://guild.example.com/api/auth/discord/callback'
  );
  assert.equal(requestOrigin(req({ host: 'localhost:3001' })), 'http://localhost:3001',
    'локально без прокси — http, иначе разработка не заведётся');
  assert.equal(isSecureRequest(req({ host: 'x', 'x-forwarded-proto': 'https' })), true);
  assert.equal(isSecureRequest(req({ host: 'x' })), false);
  assert.equal(requestOrigin(req({})), '', 'без Host адрес не выдумываем');
});
