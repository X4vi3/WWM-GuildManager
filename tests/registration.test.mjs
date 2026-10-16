// Анкета регистрации целиком: настоящий обработчик интеракций, без сети и подписи.
// handleInteraction возвращает то же, что ушло бы в Discord, поэтому проверять можно
// ровно то, что увидит человек: какие кнопки, в каком порядке, что попало в состав.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiscord } from '../server/discord.mjs';
import { createLifecycle } from '../server/lifecycle.mjs';

const setup = (names, links = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwm-reg-'));
  const players = names.map((name, i) => ({ id: 'p' + i, name, role: 'DPS', weapons: [] }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ players, sessions: [] }));
  fs.writeFileSync(path.join(dir, 'discordlinks.json'), JSON.stringify(links));
  const dc = createDiscord({ dataDir: dir, lifecycle: createLifecycle(dir), broadcastState: () => {} });
  return {
    dc, players,
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
    links: () => JSON.parse(fs.readFileSync(path.join(dir, 'discordlinks.json'), 'utf8')),
    // Значение привязки — либо старая строка с id игрока, либо новый объект с
    // подписями (имя в Discord, последний ник). Читать надо обе формы.
    linkOf: (uid) => {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'discordlinks.json'), 'utf8'))[uid];
      return typeof v === 'string' ? v : v?.playerId;
    },
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
};

const member = (id) => ({ user: { id }, roles: [] });
const typeNick = (nick, id = 'u1') => ({
  type: 5, guild_id: 'g1', member: member(id),
  data: { custom_id: 'reg:nick', components: [{ components: [{ value: nick }] }] }
});
// message.flags = 64 — нажали на эфемерном сообщении анкеты
const click = (customId, id = 'u1') => ({
  type: 3, guild_id: 'g1', member: member(id), message: { flags: 64 }, data: { custom_id: customId }
});
const choose = (customId, values, id = 'u1') => ({
  type: 3, guild_id: 'g1', member: member(id), message: { flags: 64 },
  data: { custom_id: customId, values }
});

const rowsOf = (r) => r?.data?.components || [];
const partsOf = (r) => rowsOf(r).flatMap((row) => row.components || []);
const buttonsOf = (r) => partsOf(r).filter((c) => c.type === 2);
const selectsOf = (r) => partsOf(r).filter((c) => c.type === 3);
const labelsOf = (r) => buttonsOf(r).map((b) => b.label);
const optionsOf = (r) => selectsOf(r).flatMap((s) => s.options || []).map((o) => o.label);

test('ГЛАВНОЕ: ввели длиннее, чем записано — человек находит себя, а не заводит дубль', async () => {
  const S = setup(['Kaito', 'Мурзик', 'Стрела']);
  try {
    const r = await S.dc.handleInteraction(typeNick('Kaitos'));
    assert.ok(labelsOf(r).includes('Kaito'), 'ожидали кнопку «Kaito», получили: ' + labelsOf(r).join(' | '));
    // и состав при этом не тронут
    assert.equal(S.state().players.length, 3);
  } finally { S.cleanup(); }
});

test('точное совпадение — первой кнопкой и выделено', async () => {
  const S = setup(['Avicenna', 'avi', 'avie']);
  try {
    const r = await S.dc.handleInteraction(typeNick('avi'));
    const btns = buttonsOf(r);
    assert.equal(btns[0].label, 'avi', 'первым должен быть точный: ' + labelsOf(r).join(' | '));
    assert.equal(btns[0].style, 3, 'первый кандидат — зелёной кнопкой');
  } finally { S.cleanup(); }
});

test('ник в другой раскладке находится', async () => {
  const S = setup(['Kaito', 'Ронин']);
  try {
    // «Каito»: К и а — кириллические, на экране неотличимы от латинских
    const r = await S.dc.handleInteraction(typeNick('Каito'));
    assert.ok(labelsOf(r).includes('Kaito'), 'получили: ' + labelsOf(r).join(' | '));
  } finally { S.cleanup(); }
});

test('на первом экране всегда есть выход: «меня здесь нет» и «я новенький»', async () => {
  const S = setup(['Kaito', 'Мурзик']);
  try {
    const r = await S.dc.handleInteraction(typeNick('Kait'));
    const ids = buttonsOf(r).map((b) => b.custom_id);
    assert.ok(ids.includes('reg:all'), 'нет кнопки «меня здесь нет»');
    assert.ok(ids.includes('reg:new'), 'нет кнопки «я новенький»');
  } finally { S.cleanup(); }
});

test('«меня здесь нет» показывает ВЕСЬ состав списком, печатать не надо', async () => {
  const S = setup(['Kaito', 'Мурзик', 'Стрела', 'Кот']);
  try {
    await S.dc.handleInteraction(typeNick('Kait'));
    const r = await S.dc.handleInteraction(click('reg:all'));
    const opts = optionsOf(r);
    for (const name of ['Kaito', 'Мурзик', 'Стрела', 'Кот']) {
      assert.ok(opts.includes(name), `${name} обязан быть в полном списке: ` + opts.join(' | '));
    }
    assert.ok(buttonsOf(r).some((b) => b.custom_id === 'reg:new'), 'и кнопка «я новенький» рядом');
  } finally { S.cleanup(); }
});

test('выбор из полного списка привязывает ник', async () => {
  const S = setup(['Kaito', 'Мурзик']);
  try {
    await S.dc.handleInteraction(typeNick('кто-то'));
    const r = await S.dc.handleInteraction(choose('reg:pick:0', ['p0']));
    assert.equal(S.linkOf('u1'), 'p0', 'привязка обязана сохраниться на диск');
    assert.match(JSON.stringify(r), /Kaito/, 'в ответе должно быть имя, к которому привязались');
  } finally { S.cleanup(); }
});

test('совсем чужой ник ведёт к полному составу, а НЕ сразу к заведению нового', async () => {
  const S = setup(['Kaito', 'Мурзик']);
  try {
    const r = await S.dc.handleInteraction(typeNick('Zzqqwertyuio'));
    assert.ok(selectsOf(r).length > 0, 'ожидали список состава, а не анкету новичка');
    // роль на этом шаге ещё не спрашиваем — сначала дай найти себя
    assert.ok(!selectsOf(r).some((s) => s.custom_id === 'reg:role'), 'роль спрашивать рано');
  } finally { S.cleanup(); }
});

test('занятые кем-то ники не предлагаются', async () => {
  const S = setup(['Kaito', 'Kaitos'], { u9: 'p1' });   // «Kaitos» уже за другим аккаунтом
  try {
    const r = await S.dc.handleInteraction(typeNick('Kaitos'));
    assert.ok(!labelsOf(r).includes('Kaitos'), 'занятый ник не должен предлагаться');
    const all = await S.dc.handleInteraction(click('reg:all'));
    assert.ok(!optionsOf(all).includes('Kaitos'), 'и в полном списке его быть не должно');
  } finally { S.cleanup(); }
});

test('новичок заводится с тем ником, который ввёл', async () => {
  const S = setup(['Kaito']);
  try {
    await S.dc.handleInteraction(typeNick('Новобранец'));
    await S.dc.handleInteraction(click('reg:new'));
    await S.dc.handleInteraction(choose('reg:role', ['Tank']));
    await S.dc.handleInteraction(choose('reg:weapons', ['bamboocut', 'hengblade']));
    const players = S.state().players;
    const made = players.find((p) => p.name === 'Новобранец');
    assert.ok(made, 'новичок обязан появиться в составе: ' + players.map((p) => p.name).join(', '));
    assert.equal(made.role, 'Tank');
    assert.deepEqual(made.weapons, ['bamboocut', 'hengblade']);
    assert.equal(S.linkOf('u1'), made.id, 'и сразу быть привязан');
  } finally { S.cleanup(); }
});

test('ОШИБКА, которую чиним: «я новенький» без ника не заводит безымянного игрока', async () => {
  const S = setup(['Kaito']);
  try {
    // анкета «потерялась» — ника в памяти нет, а человек жмёт «я новенький»
    const r = await S.dc.handleInteraction(click('reg:new'));
    assert.ok(!selectsOf(r).some((s) => s.custom_id === 'reg:role'), 'роль спрашивать нельзя');
    await S.dc.handleInteraction(choose('reg:role', ['Tank']));
    await S.dc.handleInteraction(choose('reg:weapons', ['bamboocut', 'hengblade']));
    const names = S.state().players.map((p) => p.name);
    assert.deepEqual(names, ['Kaito'], 'в составе не должно появиться пустых имён: ' + JSON.stringify(names));
  } finally { S.cleanup(); }
});

test('большой состав режется на списки и укладывается в лимиты Discord', async () => {
  const S = setup(Array.from({ length: 60 }, (_, i) => 'Боец' + String(i).padStart(2, '0')));
  try {
    await S.dc.handleInteraction(typeNick('Zzqqwertyuio'));
    const r = await S.dc.handleInteraction(click('reg:all'));
    assert.ok(rowsOf(r).length <= 5, 'в сообщении Discord не больше пяти рядов, получили ' + rowsOf(r).length);
    for (const s of selectsOf(r)) {
      assert.ok((s.options || []).length <= 25, 'в списке не больше 25 пунктов');
      assert.ok(s.placeholder, 'у каждого списка должна быть подпись с буквами');
    }
    const ids = selectsOf(r).map((s) => s.custom_id);
    assert.equal(new Set(ids).size, ids.length, 'custom_id списков обязаны быть разными');
  } finally { S.cleanup(); }
});

test('пустой ник не начинает анкету', async () => {
  const S = setup(['Kaito']);
  try {
    const r = await S.dc.handleInteraction(typeNick('   '));
    assert.equal(selectsOf(r).length, 0);
    assert.equal(buttonsOf(r).length, 0);
  } finally { S.cleanup(); }
});
