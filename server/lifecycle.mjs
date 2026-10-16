// Жизненный цикл событий: через сколько минут после старта закрывается регистрация
// и (в будущем — для анонсов в мессенджерах) через сколько удалять сообщение.
// Настраивается по типу события (прак/ранкед/лига) и хранится в data/lifecycle.json.
//
// Это ЕДИНСТВЕННЫЙ источник правды о сроках: сайт, Телеграм и Дискорд берут значение
// отсюда. Раньше «10 минут» были захардкожены в четырёх местах независимо.

import fs from 'node:fs';
import path from 'node:path';

const TYPES = ['prak', 'ranked', 'league'];

// closeAfterMin — через сколько минут после старта закрывается запись;
// deleteAfterMin — через сколько минут после старта удалить сообщение-анонс
// (null = не удалять никогда, это умолчание: терять историю по неосторожности хуже,
// чем оставить лишний анонс в канале).
const defaultsForType = () => ({ closeAfterMin: 10, deleteAfterMin: null });

const clampInt = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function createLifecycle(dataDir) {
  const FILE = path.join(dataDir, 'lifecycle.json');

  const cfg = {};
  for (const t of TYPES) cfg[t] = defaultsForType();
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const t of TYPES) {
      const s = saved?.[t];
      if (!s || typeof s !== 'object') continue;
      const close = clampInt(s.closeAfterMin, 0, 1440);
      if (close !== null) cfg[t].closeAfterMin = close;
      if (s.deleteAfterMin === null) cfg[t].deleteAfterMin = null;
      else {
        const del = clampInt(s.deleteAfterMin, 0, 10080);
        if (del !== null) cfg[t].deleteAfterMin = del;
      }
    }
  } catch { /* файла нет — работаем на умолчаниях */ }

  const save = () => {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    fs.renameSync(tmp, FILE); // атомарно
  };

  return {
    // Срок закрытия регистрации (мс) для типа события. Неизвестный тип — умолчание.
    closeMsFor(type) {
      return (cfg[type]?.closeAfterMin ?? 10) * 60_000;
    },

    // Через сколько (мс) после старта удалять сообщение-анонс. null — не удалять.
    deleteMsFor(type) {
      const min = cfg[type]?.deleteAfterMin;
      return (min === null || min === undefined) ? null : min * 60_000;
    },

    // Конфиг целиком (для GET /api/lifecycle и страницы настроек)
    get() {
      return JSON.parse(JSON.stringify(cfg));
    },

    // Частичное обновление из UI: { prak: { closeAfterMin: 15 }, ... }.
    // Неизвестные типы и кривые значения молча пропускаются, валидные — применяются.
    set(next) {
      if (!next || typeof next !== 'object') return false;
      let changed = false;
      for (const t of TYPES) {
        const s = next[t];
        if (!s || typeof s !== 'object') continue;
        if ('closeAfterMin' in s) {
          const close = clampInt(s.closeAfterMin, 0, 1440);
          if (close !== null && close !== cfg[t].closeAfterMin) { cfg[t].closeAfterMin = close; changed = true; }
        }
        if ('deleteAfterMin' in s) {
          const del = s.deleteAfterMin === null ? null : clampInt(s.deleteAfterMin, 0, 10080);
          if (del !== undefined && del !== cfg[t].deleteAfterMin) { cfg[t].deleteAfterMin = del; changed = true; }
        }
      }
      if (changed) save();
      return true;
    }
  };
}
