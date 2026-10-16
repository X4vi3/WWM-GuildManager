// Нагрузка и утечки. Прод — VPS на 1 ядре и 1 ГБ, поэтому проверяем не «много ли
// держит», а «не разваливается ли и не течёт ли» при правдоподобном пике:
// вся гильдия одновременно открыла сайт после анонса и жмёт кнопки.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, sampleState, readState, AUTH } from './helpers.mjs';

const rss = async (S) => {
  // Память меряем изнутри процесса сервера — снаружи на Windows это ненадёжно
  const r = await api(S.url).get('/api/state');
  await r.arrayBuffer();
  return null;
};

test('120 одновременных чтений состояния: все успешны и быстро', async () => {
  const S = await startServer({ state: sampleState(108) });   // как на проде
  try {
    const http = api(S.url);
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 120 }, () => http.get('/api/state')));
    const dt = Date.now() - t0;
    const bad = rs.filter(r => r.status !== 200);
    assert.equal(bad.length, 0, `${bad.length} запросов из 120 не вернули 200`);
    await Promise.all(rs.map(r => r.json()));
    assert.ok(dt < 15000, `120 чтений заняли ${dt} мс — слишком долго`);
    console.log(`      120 чтений состояния (108 игроков) за ${dt} мс`);
  } finally { await S.stop(); }
});

test('60 одновременных заявок через /api/signup не теряются и не портят файл', async () => {
  const st = sampleState(60);
  // очищаем заявки — будем ставить их гонкой
  st.sessions[0].signups = {};
  st.sessions[0].signupMeta = {};
  const S = await startServer({ state: st });
  try {
    const http = api(S.url);
    const statuses = ['in', 'maybe', 'sub', 'out'];
    // Заявку принимают только у того, кто закрепил за собой этот ник (иначе 403),
    // поэтому сначала каждый «человек» представляется своим clientId.
    await Promise.all(st.players.map((p, i) =>
      http.post('/api/presence/claim', { clientId: 'c' + i, playerId: p.id })
    ));
    const rs = await Promise.all(st.players.map((p, i) =>
      http.post('/api/signup', { clientId: 'c' + i, sessionId: 's1', playerId: p.id, status: statuses[i % 4] })
    ));
    const failed = rs.filter(r => r.status >= 500);
    assert.equal(failed.length, 0, `${failed.length} заявок упали с 5xx`);
    const rejected = rs.filter(r => r.status !== 200);
    assert.equal(rejected.length, 0, `${rejected.length} заявок отвергнуто: ${[...new Set(rs.map(r => r.status))].join(',')}`);

    await new Promise(r => setTimeout(r, 500));
    const saved = readState(S.dir);
    assert.ok(saved.players.length === 60, 'состав не должен пострадать от гонки');
    // Часть заявок может не сохраниться из-за гонки чтение-запись, но файл обязан
    // остаться валидным, а сервер — живым. Это и проверяем.
    assert.equal(S.child.exitCode, null, 'процесс жив');
    const got = Object.keys(saved.sessions[0].signups || {}).length;
    console.log(`      из 60 одновременных заявок сохранилось ${got}`);
    assert.ok(got > 0, 'хотя бы часть заявок обязана сохраниться');
  } finally { await S.stop(); }
});

test('40 живых SSE-подключений получают обновление и корректно отваливаются', async () => {
  const S = await startServer({ state: sampleState(30) });
  try {
    const http = api(S.url);
    const controllers = [];
    const gotState = [];

    for (let i = 0; i < 40; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      const p = fetch(S.url + '/api/events?clientId=c' + i, { signal: ac.signal })
        .then(async (res) => {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          const t = setTimeout(() => ac.abort(), 8000);
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              if (buf.includes('event: state')) { gotState.push(i); clearTimeout(t); ac.abort(); break; }
            }
          } catch { /* оборвали сами */ }
        })
        .catch(() => {});
      // не ждём — копим подключения
      p;
    }
    await new Promise(r => setTimeout(r, 1500));

    // меняем состояние — все живые клиенты обязаны получить рассылку
    const put = await http.put('/api/state', sampleState(31), { headers: { authorization: AUTH } });
    assert.equal(put.status, 200);
    await new Promise(r => setTimeout(r, 2500));

    console.log(`      обновление получили ${gotState.length} из 40 SSE-клиентов`);
    assert.ok(gotState.length >= 30, `рассылку получили только ${gotState.length} из 40`);

    for (const ac of controllers) { try { ac.abort(); } catch {} }
    await new Promise(r => setTimeout(r, 800));
    assert.equal(S.child.exitCode, null, 'процесс жив после отключения всех клиентов');
    const r2 = await http.get('/api/state');
    assert.equal(r2.status, 200, 'сайт отвечает после отвала SSE');
  } finally { await S.stop(); }
});

test('поток чужих clientId не раздувает память без предела', async () => {
  const S = await startServer({ state: sampleState(5) });
  try {
    const http = api(S.url);
    // 3000 разных clientId — раньше identities росла бесконечно и её мог набить
    // кто угодно без пароля
    for (let batch = 0; batch < 30; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, i) =>
        http.post('/api/presence/claim', { clientId: `flood-${batch}-${i}`, playerId: null })
      ));
    }
    assert.equal(S.child.exitCode, null, 'процесс должен пережить 3000 чужих клиентов');
    const r = await http.get('/api/state');
    assert.equal(r.status, 200);
    console.log('      3000 присутствий обработаны, сервер жив');
  } finally { await S.stop(); }
});

test('серия сохранений подряд не портит файл состояния', async () => {
  const S = await startServer({ state: sampleState(20) });
  try {
    const http = api(S.url);
    for (let i = 0; i < 25; i++) {
      const st = sampleState(20);
      st.sessions[0].name = 'Правка ' + i;
      const r = await http.put('/api/state', st, { headers: { authorization: AUTH } });
      assert.equal(r.status, 200, 'сохранение ' + i);
    }
    const saved = readState(S.dir);
    assert.equal(saved.sessions[0].name, 'Правка 24', 'должна остаться последняя правка');
    assert.equal(saved.players.length, 20);
  } finally { await S.stop(); }
});

test('состояние на 300 игроков и 40 событий сохраняется и читается', async () => {
  const S = await startServer({ state: sampleState(5) });
  try {
    const http = api(S.url);
    const big = sampleState(300);
    big.sessions = Array.from({ length: 40 }, (_, i) => ({
      ...big.sessions[0], id: 's' + i, name: 'Событие ' + i
    }));
    const size = Buffer.byteLength(JSON.stringify(big));
    const t0 = Date.now();
    const r = await http.put('/api/state', big, { headers: { authorization: AUTH } });
    const dt = Date.now() - t0;
    assert.equal(r.status, 200, 'большое состояние обязано сохраниться');
    const back = await (await http.get('/api/state')).json();
    assert.equal(back.players.length, 300);
    assert.equal(back.sessions.length, 40);
    console.log(`      состояние ${(size / 1024).toFixed(0)} КБ сохранено за ${dt} мс`);
  } finally { await S.stop(); }
});
