// Подбор ника в анкете. Цена ошибки — дубль в составе, который потом сливать руками,
// поэтому проверяем и «находит кого надо», и «не находит кого не надо».

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNick, editDistance, matchScore, rankRoster, alphaGroups } from '../server/nickmatch.mjs';

const roster = [
  'Kaito', 'Kaitos', '-Kaito', 'aito', 'ait', 'Aitken',
  'Мурзик', 'Стрела', 'Кот', '[WWM] Ронин', 'Élodie'
].map((name, i) => ({ id: 'p' + i, name }));

const names = (list) => list.map((p) => p.name);

test('нормализация: регистр, знаки, клан-теги, диакритика', () => {
  assert.equal(normalizeNick('Kaito'), 'kaito');
  assert.equal(normalizeNick('-Kaito'), 'kaito');
  assert.equal(normalizeNick('  K a i t o  '), 'kaito');
  assert.equal(normalizeNick('[WWM] Ронин'), normalizeNick('Ронин'));
  assert.equal(normalizeNick('Élodie'), 'elodie');
  assert.equal(normalizeNick(''), '');
  assert.equal(normalizeNick(null), '');
});

test('похожие буквы кириллицы и латиницы сводятся к одному виду', () => {
  // Слева кириллические А, В, Е, К, М, Н, О, Р, С, Т, У, Х — на глаз неотличимы
  assert.equal(normalizeNick('ХАВИЕ'.replace(/И/g, 'I')), normalizeNick('XABIE'));
  assert.equal(normalizeNick('Ронин'), normalizeNick('Poнин'), 'кириллическая Р и латинская P');
  assert.equal(normalizeNick('Кот'), 'kot');
  assert.equal(normalizeNick('Мурзик').startsWith('m'), true);
});

test('расстояние Левенштейна считается и обрывается по лимиту', () => {
  assert.equal(editDistance('kaito', 'kaito'), 0);
  assert.equal(editDistance('kaito', 'kaitu'), 1);
  assert.equal(editDistance('kaito', 'kaitos'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.ok(editDistance('abcdef', 'zzzzzz', 2) > 2, 'при превышении лимита возвращается больше лимита');
});

test('ГЛАВНОЕ: ввели длиннее, чем записано в составе', () => {
  // Ровно то, на чём ломался старый поиск: 'kaito'.includes('kaitos') === false
  const got = names(rankRoster(roster, 'Kaitos'));
  assert.ok(got.includes('Kaitos'), 'точное совпадение обязано быть: ' + got.join(', '));
  assert.ok(got.includes('Kaito'), 'более короткий ник тоже обязан найтись: ' + got.join(', '));
});

test('точное совпадение всегда первое', () => {
  assert.equal(names(rankRoster(roster, 'ait'))[0], 'ait');
  assert.equal(names(rankRoster(roster, 'Kaito'))[0], 'Kaito');
  // Иначе человек с ником «ait» увидел бы первым «Aitken» и нажал не туда
  assert.notEqual(names(rankRoster(roster, 'ait'))[0], 'Aitken');
});

test('опечатка в один символ не отправляет заводить дубль', () => {
  assert.ok(names(rankRoster(roster, 'Kaitu')).includes('Kaito'));
  assert.ok(names(rankRoster(roster, 'Мурзек')).includes('Мурзик'));
});

test('ник в другой раскладке находится', () => {
  // «Kaito», где K и a набраны кириллицей — на экране выглядит идентично
  assert.ok(names(rankRoster(roster, 'Каito')).includes('Kaito'));
});

test('клан-тег в составе не мешает найти по чистому нику', () => {
  assert.ok(names(rankRoster(roster, 'Ронин')).includes('[WWM] Ронин'));
});

test('совсем чужой ник не подсовывает случайных людей', () => {
  assert.deepEqual(rankRoster(roster, 'Zzzqqwertypoiu'), []);
  assert.deepEqual(rankRoster(roster, ''), [], 'пустой запрос ничего не предлагает');
});

test('кандидатов не больше запрошенного', () => {
  assert.ok(rankRoster(roster, 'ait', 5).length <= 5);
  assert.equal(rankRoster(roster, 'ait', 2).length, 2);
});

test('весь состав режется на группы под лимит Discord в 25 пунктов', () => {
  const big = Array.from({ length: 57 }, (_, i) => ({ id: 'b' + i, name: 'Игрок' + String(i).padStart(2, '0') }));
  const groups = alphaGroups(big);
  assert.equal(groups.length, 3, '57 ников — три списка');
  assert.ok(groups.every((g) => g.players.length <= 25), 'ни одна группа не превышает лимит');
  assert.equal(groups.reduce((n, g) => n + g.players.length, 0), 57, 'никто не потерялся');
  // Группы подписаны буквами и идут по алфавиту
  assert.ok(groups.every((g) => g.from && g.to));
});

test('пустой состав не роняет разбивку', () => {
  assert.deepEqual(alphaGroups([]), []);
  assert.deepEqual(rankRoster([], 'кто угодно'), []);
});

test('матч самого себя всегда лучший возможный', () => {
  for (const p of roster) assert.equal(matchScore(p.name, p.name), 0, p.name);
});
