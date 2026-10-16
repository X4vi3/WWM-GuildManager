import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, YtGallery, YtVideo } from '../services/api';
import { parseTitle, clock } from '../server/ytmeta.mjs';
import { useT, useLang } from '../services/i18n';
import { toast, confirm } from './Notifications';

// Галерея записей ГВГ: то, что уже лежит на канале гильдии, — не уходя на YouTube.
//
// Две вещи, из которых следует вся конструкция:
//
// 1. Записи гильдии «по ссылке» (unlisted). Никакой сторонний виджет и никакой
//    поиск их не покажет — увидеть их можно только тем же ключом, которым мы их
//    заливали. Поэтому список собирает наш сервер, а не браузер зрителя.
// 2. Проигрыватель встраивается ФАСАДОМ: сначала картинка, iframe появляется по
//    клику. Тридцать живых плееров на странице — это тридцать сторонних
//    подключений и мегабайты скриптов ради превью, которые никто не откроет.

interface Props {
  onUpload?: () => void;   // уйти на страницу заливки
  isOfficer?: boolean;
}

interface Row extends YtVideo {
  nick: string;
  enemy: string;
  date: string;            // дата боя из названия; пусто — берём дату публикации
  tail: string;
}

const dayOf = (r: Row) => r.date || (r.at ? r.at.slice(0, 10) : '');

// «4 августа», год добавляем только если он не нынешний: в списке за один сезон
// год повторяется в каждом заголовке и ничего не сообщает.
const dayLabel = (iso: string, lang: string) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'ru-RU', opts);
};

const GvgGallery: React.FC<Props> = ({ onUpload, isOfficer }) => {
  const t = useT();
  const { lang } = useLang();
  const [data, setData] = useState<YtGallery | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Три оси, о которых просили: игрок, соперник, дата. Все три — выбор из того,
  // что на канале ЕСТЬ, а не поле для ввода: набранная руками дата или название
  // гильдии с опечаткой дают пустой экран, и человек решает, что записей нет.
  const [who, setWho] = useState('');        // ник игрока или '' — все
  const [foe, setFoe] = useState('');
  const [day, setDay] = useState('');
  const [playing, setPlaying] = useState(''); // единственный живой плеер

  const load = useCallback(async (force = false) => {
    setBusy(true);
    const r = await api.getYtGallery(force);
    setBusy(false);
    if (!r) { setFailed(true); return; }
    setFailed(false);
    setData(r);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Разбор названия — тем же кодом, что его собирал (`server/ytmeta.mjs`).
  // Второй разборщик однажды разошёлся бы с первым, и фильтр начал бы врать.
  const rows: Row[] = useMemo(() => {
    const list = (data?.videos || []).map(v => ({ ...v, ...parseTitle(v.title) })) as Row[];
    return list.sort((a, b) => {
      const d = dayOf(b).localeCompare(dayOf(a));
      return d || a.nick.localeCompare(b.nick) || b.at.localeCompare(a.at);
    });
  }, [data]);

  // Кто вообще заливал. Считаем по самим записям, а не по плейлистам: плейлист
  // мог остаться пустым, а запись — лежать вне плейлиста, если его сборка
  // сорвалась. Плейлисты добавляем сверху, чтобы их видимость было где показать.
  const people = useMemo(() => {
    const m = new Map<string, { nick: string; count: number; privacy: string }>();
    for (const p of (data?.playlists || [])) {
      if (p.title) m.set(p.title, { nick: p.title, count: 0, privacy: p.privacy });
    }
    for (const r of rows) {
      if (!r.nick) continue;
      const rec = m.get(r.nick) || { nick: r.nick, count: 0, privacy: '' };
      rec.count++;
      m.set(r.nick, rec);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.nick.localeCompare(b.nick));
  }, [rows, data?.playlists]);

  // Соперники и дни — только те, что реально встречаются, с числом записей.
  // Пустой список сразу видно: выбирать не из чего, и это честнее, чем поле
  // ввода, в которое можно вписать что угодно.
  const foes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.enemy) m.set(r.enemy, (m.get(r.enemy) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);

  const allDays = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const d = dayOf(r); if (d) m.set(d, (m.get(d) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  const shown = useMemo(() => rows.filter(r => {
    if (who && r.nick !== who) return false;
    if (foe && r.enemy !== foe) return false;
    if (day && dayOf(r) !== day) return false;
    return true;
  }), [rows, who, foe, day]);

  // Раскладываем по дням: стена одинаковых плиток не читается, а по дате как раз
  // и ищут — «что было в прошлый вторник».
  const days = useMemo(() => {
    const out: { day: string; items: Row[] }[] = [];
    for (const r of shown) {
      const d = dayOf(r);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(r);
      else out.push({ day: d, items: [r] });
    }
    return out;
  }, [shown]);

  const aged = useMemo(() => rows.filter(r => r.blocked === 'age'), [rows]);

  const dirty = !!(who || foe || day);
  const reset = () => { setWho(''); setFoe(''); setDay(''); };

  const myPlaylist = people.find(p => p.nick === data?.me);

  // Видимость своего плейлиста — тот же рычаг, что на странице заливки: он
  // нужен там, где человек видит результат, а не только в момент отправки.
  const flip = async () => {
    if (!myPlaylist) return;
    const next = myPlaylist.privacy === 'public' ? 'unlisted' : 'public';
    const word = next === 'public' ? t('открытым') : t('скрытым («по ссылке»)');
    const ok = await confirm(
      t('Сменить видимость плейлиста на %s? Все записи внутри тоже сменят её — иначе скрытые ролики в открытом плейлисте начинают находиться поиском.').replace('%s', word),
      { confirmLabel: t('Сменить') }
    );
    if (!ok) return;
    setBusy(true);
    const r = await api.ytPrivacy(next);
    setBusy(false);
    if (!r) return toast(t('Не удалось сменить видимость.'), 'error');
    toast(t('Готово: записей затронуто %n').replace('%n', String(r.changed)), 'success');
    load(true);
  };

  // ---------------------------------------------------------------- экраны

  if (!data && !failed) {
    return <p className="text-slate-500 text-sm py-10 text-center">
      <i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}
    </p>;
  }

  if (failed || data?.forbidden || (data && !data.configured)) {
    return (
      <div className="max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
        <i className="fa-brands fa-youtube text-2xl text-slate-700"></i>
        <p className="text-sm text-slate-400 mt-3">
          {data?.forbidden
            ? t('Записи видны участникам гильдии: войдите через Discord и привяжите свой ник.')
            : failed
              ? t('Не удалось получить записи с канала.')
              : t('Канал YouTube к сайту не подключён — записей пока нет.')}
        </p>
        {failed && (
          <button onClick={() => load(true)} className="mt-4 px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-slate-600 text-sm font-semibold transition-colors">
            {t('Попробовать снова')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <h1 className="cinzel text-2xl font-semibold text-slate-100">{t('Записи ГВГ')}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {data?.channel
              ? t('Канал %s · записей: %n').replace('%s', data.channel).replace('%n', String(rows.length))
              : t('записей: %n').replace('%n', String(rows.length))}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isOfficer && (
            <button
              onClick={() => load(true)} disabled={busy}
              title={t('Перечитать канал')}
              className="w-9 h-9 rounded-lg border border-slate-800 text-slate-500 hover:text-slate-300 hover:border-slate-700 transition-colors disabled:opacity-50"
            ><i className={`fa-solid fa-rotate text-xs ${busy ? 'fa-spin' : ''}`}></i></button>
          )}
          {onUpload && (
            <button
              onClick={onUpload}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-slate-950 text-sm font-semibold transition-colors"
            ><i className="fa-solid fa-arrow-up-from-bracket mr-2"></i>{t('Залить свои')}</button>
          )}
        </div>
      </div>

      {/* Возрастное ограничение ставит сам YouTube, а снять его через API нельзя.
          Молчать об этом нельзя тоже: иначе часть записей просто «не работает». */}
      {!!aged.length && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3 text-sm text-slate-400">
          <i className="fa-solid fa-user-lock text-slate-600 mr-2"></i>
          {t('Записей с возрастным ограничением: %n. YouTube ставит его сам, и встроенный плеер такие не покажет — они открываются по ссылке на YouTube.')
            .replace('%n', String(aged.length))}
          {/* Править записи в Studio может только тот, у кого доступ к каналу.
              Обычному игроку такой совет — тупик, поэтому он его не видит. */}
          {isOfficer && (
            <span className="text-slate-500">
              {' '}
              {t('Снимается только в YouTube Studio: Контент → выделить записи → Изменить → Аудитория.')}
            </span>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] items-start">

        {/* ------------- кто заливал: плейлисты игроков ------------- */}
        <aside className="min-w-0 lg:sticky lg:top-20">
          <div className="text-[11px] uppercase tracking-widest text-slate-500 px-2 pb-2">{t('Игроки')}</div>
          {/* Высота ограничена и на узком экране: в гильдии под сотню человек, и
              без этого список сам по себе стал бы страницей перед содержимым. */}
          <div className="space-y-0.5 max-h-64 lg:max-h-[70vh] overflow-y-auto">
            <button
              onClick={() => setWho('')}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors
                ${!who ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900'}`}
            >
              <span className="truncate">{t('Все записи')}</span>
              <span className="ml-auto text-xs text-slate-500 tabular-nums">{rows.length}</span>
            </button>
            {people.map(p => (
              <button
                key={p.nick}
                onClick={() => setWho(w => w === p.nick ? '' : p.nick)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors
                  ${who === p.nick ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900'}`}
              >
                <span className="truncate">{p.nick}</span>
                {p.nick === data?.me && <span className="text-[11px] text-amber-500">{t('вы')}</span>}
                {p.privacy === 'public' && (
                  <i className="fa-solid fa-globe text-[10px] text-slate-600" title={t('видят все')}></i>
                )}
                <span className="ml-auto text-xs text-slate-500 tabular-nums">{p.count}</span>
              </button>
            ))}
          </div>

          {myPlaylist && (
            <div className="mt-4 pt-3 border-t border-slate-800 px-2">
              <p className="text-xs text-slate-500">
                {t('Ваш плейлист')} · {myPlaylist.privacy === 'public' ? t('видят все') : t('только по ссылке')}
              </p>
              <button
                onClick={flip} disabled={busy}
                className="mt-1.5 text-xs text-slate-400 hover:text-amber-400 underline transition-colors disabled:opacity-50"
              >
                {myPlaylist.privacy === 'public' ? t('Скрыть от поиска') : t('Открыть всем')}
              </button>
            </div>
          )}
        </aside>

        {/* ------------- фильтры и сетка ------------- */}
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={foe} onChange={e => setFoe(e.target.value)}
              className={`bg-slate-950 border rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600 transition-colors
                ${foe ? 'border-amber-700 text-slate-200' : 'border-slate-800 text-slate-400'}`}
            >
              <option value="">{t('Любой соперник')}</option>
              {foes.map(([name, n]) => <option key={name} value={name}>{name} · {n}</option>)}
            </select>
            <select
              value={day} onChange={e => setDay(e.target.value)}
              className={`bg-slate-950 border rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-600 transition-colors
                ${day ? 'border-amber-700 text-slate-200' : 'border-slate-800 text-slate-400'}`}
            >
              <option value="">{t('Любая дата')}</option>
              {allDays.map(([d, n]) => <option key={d} value={d}>{dayLabel(d, lang)} · {n}</option>)}
            </select>
            {dirty && (
              <button onClick={reset} className="px-3 py-2 rounded-lg text-xs text-slate-500 hover:text-slate-300 transition-colors">
                <i className="fa-solid fa-xmark mr-1.5"></i>{t('Сбросить')}
              </button>
            )}
            <span className="ml-auto text-xs text-slate-600 tabular-nums">
              {shown.length === rows.length
                ? ''
                : t('найдено: %n').replace('%n', String(shown.length))}
            </span>
          </div>

          {!shown.length && (
            <div className="border border-dashed border-slate-800 rounded-2xl py-16 text-center">
              <p className="text-sm text-slate-500">
                {rows.length ? t('Под фильтр ничего не подошло.') : t('На канале пока нет записей.')}
              </p>
              {dirty && (
                <button onClick={reset} className="mt-3 text-xs text-amber-500 hover:text-amber-400 underline">
                  {t('Сбросить фильтры')}
                </button>
              )}
            </div>
          )}

          {days.map(({ day, items }) => (
            <section key={day || 'без даты'}>
              <div className="flex items-baseline gap-3 pb-2">
                <h2 className="text-[11px] uppercase tracking-widest text-slate-500">
                  {dayLabel(day, lang) || t('без даты')}
                </h2>
                <span className="text-xs text-slate-600 tabular-nums">{items.length}</span>
                <span className="flex-1 h-px bg-slate-900"></span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {items.map(v => (
                  <article key={v.id} className="min-w-0">
                    <div className="relative aspect-video rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
                      {playing === v.id ? (
                        <iframe
                          src={`https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`}
                          title={v.title}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          className="absolute inset-0 w-full h-full"
                        />
                      ) : v.blocked ? (
                        // Встроенный плеер такую запись не покажет при всём желании:
                        // возрастное ограничение YouTube ставит сам, а снять его
                        // через API нельзя. Кнопка «играть» тут была бы обманом,
                        // поэтому карточка честно уводит на YouTube и говорит почему.
                        <a
                          href={`https://youtu.be/${v.id}`} target="_blank" rel="noreferrer"
                          className="group absolute inset-0 block"
                        >
                          {v.thumb && (
                            <img
                              src={v.thumb} alt="" loading="lazy"
                              className="absolute inset-0 w-full h-full object-cover opacity-40 group-hover:opacity-60 transition-opacity"
                            />
                          )}
                          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center bg-slate-950/60">
                            <i className={`fa-solid ${v.blocked === 'processing' ? 'fa-hourglass-half' : 'fa-user-lock'} text-slate-500`}></i>
                            <span className="text-xs text-slate-400">
                              {v.blocked === 'age' ? t('Возрастное ограничение YouTube')
                                : v.blocked === 'processing' ? t('YouTube ещё обрабатывает запись')
                                  : t('Встраивание запрещено')}
                            </span>
                            <span className="text-[11px] text-slate-500 group-hover:text-amber-400 transition-colors">
                              {t('Открыть на YouTube')} <i className="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                            </span>
                          </span>
                        </a>
                      ) : (
                        <button
                          onClick={() => setPlaying(v.id)}
                          className="group absolute inset-0 w-full h-full"
                          aria-label={t('Смотреть')}
                        >
                          {v.thumb && (
                            <img
                              src={v.thumb} alt="" loading="lazy"
                              className="absolute inset-0 w-full h-full object-cover"
                            />
                          )}
                          <span className="absolute inset-0 flex items-center justify-center bg-slate-950/30 group-hover:bg-slate-950/10 transition-colors">
                            <span className="w-12 h-12 rounded-full bg-slate-950/70 group-hover:bg-red-600 flex items-center justify-center transition-colors">
                              <i className="fa-solid fa-play text-slate-100 text-sm ml-0.5"></i>
                            </span>
                          </span>
                        </button>
                      )}
                      {/* Длительность — единственная цифра, которой на плитке не хватало */}
                      {playing !== v.id && clock(v.seconds) && (
                        <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-slate-950/80 text-[11px] text-slate-300 tabular-nums pointer-events-none">
                          {clock(v.seconds)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-2 mt-1.5 min-w-0">
                      <span className={`text-sm truncate ${v.nick === data?.me ? 'text-amber-500' : 'text-slate-300'}`}>
                        {v.nick || v.title}
                      </span>
                      {v.enemy && <span className="text-xs text-slate-500 truncate">vs {v.enemy}</span>}
                      <a
                        href={`https://youtu.be/${v.id}`} target="_blank" rel="noreferrer"
                        title={t('Открыть на YouTube')}
                        className="ml-auto text-slate-600 hover:text-slate-400 transition-colors"
                      ><i className="fa-solid fa-arrow-up-right-from-square text-[11px]"></i></a>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};

export default GvgGallery;
