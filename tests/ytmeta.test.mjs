// Правила заливки на YouTube. Без сети, поэтому проверяются целиком.
//
// Цена ошибки тут выше обычной: заголовок уходит на публичный канал гильдии, а
// дата боя определяет, в какую пачку попадёт запись. Править потом — руками и
// по одному видео.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERR, classifyError, worthRetry, battleDate, buildTitle, sanitizeTitle, parseTitle,
  retryDelay, CHUNK_SIZE, MAX_PARALLEL, DAILY_LIMIT,
  durationSeconds, clock, videoFacts, ID_BATCH
} from '../server/ytmeta.mjs';

// ---------------------------------------------------------------- дата боя

const at = (iso) => ({ lastModified: new Date(iso).getTime() });

test('ГЛАВНОЕ: бой за полночь — берём самый ранний файл, а не самый поздний', () => {
  // Пишут с 23:50 до 00:30 по Москве: это ОДИН бой, и он пятничный.
  const msk = -180; // getTimezoneOffset для UTC+3
  const files = [at('2026-08-07T20:50:00Z'), at('2026-08-07T21:40:00Z'), at('2026-08-07T21:30:00Z')];
  assert.equal(battleDate(files, msk), '2026-08-07', 'по московскому это ещё 7-е (23:50)');
});

test('дата берётся в поясе человека, а не в UTC', () => {
  // 22:10 по Москве 7-го = 19:10 UTC того же дня; но 01:10 МСК 8-го = 22:10 UTC 7-го
  const msk = -180;
  assert.equal(battleDate([at('2026-08-07T22:10:00Z')], msk), '2026-08-08',
    'в UTC ещё 7-е, а у человека на часах уже 8-е — берём его дату');
});

test('пустой список файлов даты не выдумывает', () => {
  assert.equal(battleDate([]), '');
  assert.equal(battleDate([{ lastModified: 0 }]), '');
  assert.equal(battleDate(null), '');
});

// ---------------------------------------------------------------- заголовок

test('заголовок собирается как на десктопе', () => {
  assert.equal(
    buildTitle({ nick: 'Kaito', date: '2026-08-07', enemy: 'Enemy Guild' }),
    'Kaito [2026-08-07] vs Enemy Guild'
  );
});

test('префикс можно отключить для отдельного клипа', () => {
  assert.equal(
    buildTitle({ nick: 'Kaito', date: '2026-08-07', enemy: 'Enemy', prefix: false }),
    'vs Enemy'
  );
});

test('свой хвост заменяет «vs …», префикс остаётся', () => {
  assert.equal(
    buildTitle({ nick: 'Kaito', date: '2026-08-07', enemy: 'Enemy', tail: 'финалка на мосту' }),
    'Kaito [2026-08-07] финалка на мосту'
  );
});

test('заголовок чистится и режется по пределу YouTube', () => {
  assert.equal(sanitizeTitle('  а  <b>  б  '), 'а b б', 'угловые скобки YouTube не принимает');
  const long = buildTitle({ nick: 'N', date: '2026-08-07', enemy: 'я'.repeat(300) });
  assert.equal(long.length, 100, 'предел заголовка — 100 символов');
});

test('без вражеской гильдии «vs» не висит в воздухе', () => {
  // «Kaito [2026-08-07] vs» читается как обрезанный заголовок, а он публичный
  assert.equal(buildTitle({ nick: 'Kaito', date: '2026-08-07', enemy: '' }), 'Kaito [2026-08-07]');
});

// ------------------------------------------------- разбор заголовка (галерея)

test('разбор — обратная сторона сборки', () => {
  const title = buildTitle({ nick: 'Kaito-', date: '2026-08-06', enemy: 'Red Lotus' });
  assert.deepEqual(parseTitle(title), {
    nick: 'Kaito-', date: '2026-08-06', enemy: 'Red Lotus', tail: 'vs Red Lotus'
  });
});

test('ГЛАВНОЕ: заголовок без «vs» не выбрасываем — такие лежат на канале', () => {
  // Реальная запись с канала: набита десктопом и переименована руками
  const r = parseTitle('Kaito [2026-08-04] 123');
  assert.equal(r.nick, 'Kaito');
  assert.equal(r.date, '2026-08-04');
  assert.equal(r.enemy, '', 'соперника нет — фильтр по нему её просто не покажет');
  assert.equal(r.tail, '123', 'но сама запись остаётся видимой');
});

test('совсем чужой заголовок не ломает разбор', () => {
  const r = parseTitle('какое-то видео без всякого порядка');
  assert.deepEqual(r, { nick: '', date: '', enemy: '', tail: 'какое-то видео без всякого порядка' });
});

test('ник с пробелами и дефисами читается целиком', () => {
  assert.equal(parseTitle('Ночной Кот [2026-07-30] vs REQUIEM').nick, 'Ночной Кот');
  assert.equal(parseTitle('Kaito- [2026-07-30] vs IRONWOLF').nick, 'Kaito-');
});

test('соперник из нескольких слов не обрезается', () => {
  assert.equal(parseTitle('N [2026-08-01] vs Enemy Guild Name').enemy, 'Enemy Guild Name');
});

test('пустое и мусор не роняют разбор', () => {
  for (const bad of ['', null, undefined, 42]) {
    const r = parseTitle(bad);
    assert.equal(r.date, '', String(bad));
  }
});

// ---------------------------------------------------------------- ошибки

test('ГЛАВНОЕ: квота отличается от отозванного доступа — советы разные', () => {
  const quota = { error: { errors: [{ reason: 'quotaExceeded' }] } };
  assert.equal(classifyError(403, quota), ERR.QUOTA);
  assert.equal(classifyError(403, { error: { errors: [{ reason: 'forbidden' }] } }), ERR.ACCESS);
  assert.equal(classifyError(401, {}), ERR.ACCESS);
});

test('все четыре «квотных» признака узнаются', () => {
  for (const reason of ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'uploadLimitExceeded']) {
    assert.equal(classifyError(403, { error: { errors: [{ reason }] } }), ERR.QUOTA, reason);
  }
});

test('запрос не дошёл вовсе — это сеть', () => {
  assert.equal(classifyError(0, null), ERR.NETWORK);
  assert.equal(classifyError(undefined, undefined), ERR.NETWORK);
});

test('5xx у Google считаем сетью: повторять имеет смысл', () => {
  assert.equal(classifyError(500, {}), ERR.NETWORK);
  assert.equal(classifyError(503, {}), ERR.NETWORK);
  assert.equal(worthRetry(ERR.NETWORK), true);
});

test('повторять отозванный доступ и кончившуюся квоту бессмысленно', () => {
  assert.equal(worthRetry(ERR.ACCESS), false);
  assert.equal(worthRetry(ERR.QUOTA), false);
  assert.equal(worthRetry(ERR.API), false);
});

test('прочее — это API, с кодом наружу', () => {
  assert.equal(classifyError(400, { error: { errors: [{ reason: 'badRequest' }] } }), ERR.API);
  assert.equal(classifyError(404, {}), ERR.API);
});

// ---------------------------------------------------------------- пределы

test('задержка растёт вдвое и имеет разброс', () => {
  assert.equal(retryDelay(0, () => 0.5), 1000);
  assert.equal(retryDelay(1, () => 0.5), 2000);
  assert.equal(retryDelay(3, () => 0.5), 8000);
  assert.ok(retryDelay(2, () => 0) < retryDelay(2, () => 1), 'разброс должен что-то менять');
});

test('константы не разъезжаются с тем, что записано в брифе', () => {
  assert.equal(CHUNK_SIZE, 16 * 1024 * 1024, 'кусок 16 МиБ проверен на десктопе');
  assert.equal(MAX_PARALLEL, 5, 'браузер держит 6 соединений к хосту, шестое — служебным');
  assert.equal(DAILY_LIMIT, 100);
});


// ---------------------------------------------------------------- длительность

test('длительность разбирается во всех формах, что шлёт YouTube', () => {
  assert.equal(durationSeconds('PT7M4S'), 424);
  assert.equal(durationSeconds('PT1H12M30S'), 4350);
  assert.equal(durationSeconds('PT45S'), 45);
  assert.equal(durationSeconds('PT2H'), 7200);
  assert.equal(durationSeconds('P1DT2H'), 93600, 'сутки бывают у трансляций');
});

test('мусор и пустое дают ноль, а не NaN на плитке', () => {
  assert.equal(durationSeconds(''), 0);
  assert.equal(durationSeconds(null), 0);
  assert.equal(durationSeconds('семь минут'), 0);
});

test('часы появляются только когда они есть', () => {
  assert.equal(clock(424), '7:04');
  assert.equal(clock(4350), '1:12:30');
  assert.equal(clock(59), '0:59');
});

test('нулевая длительность даёт пусто: врать про неё не надо', () => {
  assert.equal(clock(0), '');
  assert.equal(clock(undefined), '');
});

// ---------------------------------------------------------------- videos.list

const video = (extra = {}) => ({
  id: 'v1',
  snippet: { title: 'Kaito [2026-08-04] vs Enemy', publishedAt: '2026-08-04T20:00:00Z',
    thumbnails: { medium: { url: 'https://i.ytimg.com/vi/v1/mqdefault.jpg' } } },
  status: { privacyStatus: 'unlisted', uploadStatus: 'processed', embeddable: true },
  contentDetails: { duration: 'PT7M4S' },
  ...extra
});

test('обычная запись играется у нас и приносит всё нужное плитке', () => {
  const f = videoFacts(video());
  assert.equal(f.blocked, '', 'ничего не мешает');
  assert.equal(f.seconds, 424);
  assert.equal(f.privacy, 'unlisted');
  assert.ok(f.thumb.includes('v1'));
});

test('ГЛАВНОЕ: возрастное ограничение узнаётся — иначе на странице чёрный прямоугольник', () => {
  const f = videoFacts(video({
    contentDetails: { duration: 'PT7M4S', contentRating: { ytRating: 'ytAgeRestricted' } }
  }));
  assert.equal(f.blocked, 'age');
});

test('запрет встраивания и незаконченная обработка различаются: советы разные', () => {
  assert.equal(videoFacts(video({
    status: { privacyStatus: 'unlisted', uploadStatus: 'processed', embeddable: false }
  })).blocked, 'noembed');
  assert.equal(videoFacts(video({
    status: { privacyStatus: 'unlisted', uploadStatus: 'uploaded', embeddable: true }
  })).blocked, 'processing');
});

test('пустой contentRating не считается ограничением', () => {
  assert.equal(videoFacts(video({ contentDetails: { duration: 'PT1M', contentRating: {} } })).blocked, '');
});

test('огрызок ответа не роняет разбор', () => {
  const f = videoFacts({});
  assert.equal(f.id, '');
  assert.equal(f.seconds, 0);
  assert.equal(f.blocked, '');
});

test('пачка запросов не больше предела YouTube', () => {
  assert.equal(ID_BATCH, 50, 'больше 50 id в videos.list не влезает');
});
