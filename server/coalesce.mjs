// Склейка правок (debounce по ключу): сколько бы изменений подряд ни пришло по одному
// ключу, run(key) выполнится один раз спустя delayMs после первого. Если изменения
// пришли, пока run уже выполнялся, — после завершения запустится ещё один круг.
//
// Зачем: у Телеграма (и Дискорда) жёсткие лимиты на редактирование сообщений. Когда
// 30 человек жмут кнопки записи, редактировать анонс на каждый клик нельзя — упрёмся
// в 429. Со склейкой потолок — одна правка на событие в delayMs, независимо от числа
// кликов. Общий слой: используется телеграм-модулем, дискорд-модуль подключится сюда же.
//
// ВАЖНО для вызывающих: run(key) должен сам читать СВЕЖЕЕ состояние в момент запуска,
// а не захватывать его при schedule() — иначе склеенная правка покажет устаревшие данные.

export function createCoalescer(run, delayMs = 1200) {
  const jobs = new Map(); // key -> { timer, running, again }

  const start = (key) => {
    const j = jobs.get(key);
    if (!j) return;
    j.timer = null;
    j.running = true;
    Promise.resolve()
      .then(() => run(key))
      .catch(() => {}) // ошибки правки не роняют процесс; следующий круг перерисует
      .finally(() => {
        j.running = false;
        if (j.again) { j.again = false; schedule(key); }
        else jobs.delete(key);
      });
  };

  const schedule = (key) => {
    let j = jobs.get(key);
    if (!j) { j = { timer: null, running: false, again: false }; jobs.set(key, j); }
    if (j.running) { j.again = true; return; } // правка в полёте — попросим ещё круг
    if (j.timer) return;                       // уже ждёт своего часа
    j.timer = setTimeout(() => start(key), delayMs);
  };

  // Снять ожидающую правку (например, событие удалили и его сообщения больше нет)
  const cancel = (key) => {
    const j = jobs.get(key);
    if (!j) return;
    if (j.timer) { clearTimeout(j.timer); j.timer = null; }
    j.again = false;
    if (!j.running) jobs.delete(key);
  };

  return { schedule, cancel };
}
