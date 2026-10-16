// Общая обвязка тестов: поднять настоящий сервер на ВРЕМЕННОЙ папке данных.
//
// Никакой тест не должен видеть server/data — там живое состояние гильдии. Поэтому
// DATA_DIR всегда указывает в os.tmpdir(), а порт берётся свободный, чтобы тесты не
// дрались с запущенным dev-сервером.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = path.join(HERE, '..', 'server', 'index.mjs');
export const PASSWORD = 'test-пароль-Ω';           // намеренно с кириллицей и юникодом
export const AUTH = 'Bearer ' + Buffer.from(PASSWORD, 'utf8').toString('base64');

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Правдоподобное состояние гильдии: игроки, событие с заявками всех статусов.
export const sampleState = (players = 30) => {
  const roles = ['Tank', 'DPS', 'Healer'];
  const schools = ['bamboocut', 'hengblade', 'splendor', 'umbra', 'dmg_umbrella', 'new_umbrella', 'hea', 'might'];
  const list = Array.from({ length: players }, (_, i) => ({
    id: 'p' + i,
    name: `Игрок${i}`,
    role: roles[i % 3],
    weapons: [schools[i % 8], schools[(i + 3) % 8]],
    callRoles: i === 0 ? ['rl'] : i === 1 ? ['shotcaller'] : []
  }));
  const signups = {}, signupMeta = {};
  const statuses = ['in', 'maybe', 'sub', 'out'];
  list.forEach((p, i) => {
    signups[p.id] = statuses[i % 4];
    signupMeta[p.id] = { at: new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString() };
  });
  // Событие ЗАВТРА, а не в зашитый день. С фиксированной датой набор тестов протухал
  // молча: сервер закрывает запись через настроенный срок после начала, и в первый
  // же день после этой даты заявки начинали получать 409 «запись закрыта» — падение,
  // которое выглядит как поломка кода, хотя сломались часы.
  const soon = new Date(Date.now() + 24 * 3600_000);
  return {
    players: list,
    sessions: [{
      id: 's1',
      name: 'Тестовое событие',
      date: soon.toISOString().slice(0, 10),
      event: { type: 'prak', opponent: 'Enemy', startsAt: soon.toISOString(), tz: 'Europe/Moscow', note: 'заметка' },
      signups,
      signupMeta,
      assignments: list.slice(0, 10).map((p, i) => ({
        playerId: p.id, side: i < 5 ? 'attack' : 'defense', group: (i % 3) + 1, subRoles: []
      })),
      groupLanes: {},
      mapPositions: {}
    }],
    activeSessionId: 's1',
    mapTemplates: []
  };
};

// Поднять сервер. Возвращает { url, dir, stop, log } — log копит stdout/stderr,
// чтобы тест мог проверить, что процесс не ругался.
export const startServer = async (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwm-test-'));
  if (opts.state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(opts.state));
  for (const [file, obj] of Object.entries(opts.files || {})) {
    fs.writeFileSync(path.join(dir, file), typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  const port = await freePort();
  // Вывод сервера пишем в ФАЙЛ, а не в pipe. На Windows убийство дочернего процесса
  // с открытыми pipe-каналами роняет libuv (Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING) в src\win\async.c) и вешает прогон тестов.
  const logFile = path.join(dir, 'server.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      EDIT_PASSWORD: opts.password ?? PASSWORD,
      STATIC_DIR: opts.staticDir || path.join(dir, 'no-static'),
      ...(opts.env || {})
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  });
  const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const log = { join: () => readLog(), toString: readLog, get text() { return readLog(); } };

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('сервер не поднялся: ' + readLog());
    try {
      const r = await fetch(url + '/api/state', { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch { /* ещё не слушает */ }
    if (Date.now() > deadline) throw new Error('сервер не ответил за 15 с: ' + readLog());
    await new Promise(r => setTimeout(r, 100));
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    }
    try { fs.closeSync(logFd); } catch { /* уже закрыт */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows иногда держит файл */ }
  };
  return { url, dir, stop, log, readLog, child, port, logFile };
};

export const api = (url) => ({
  get: (p, init) => fetch(url + p, init),
  put: (p, body, init = {}) => fetch(url + p, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init
  }),
  post: (p, body, init = {}) => fetch(url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    ...init
  })
});

export const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
