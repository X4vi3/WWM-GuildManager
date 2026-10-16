import React, { useState, useMemo, useEffect } from 'react';
import Glyph from './glyphs';
import { GuildWarSession, GuildEventMeta, GuildEventType, Player, SignupStatus } from '../types';
import {
  EVENT_TYPES, EVENT_TYPE_LABELS, EVENT_TYPE_ICONS, EVENT_TYPE_STYLES,
  SIGNUP_STATUSES, SIGNUP_SHORT, SIGNUP_ICONS, SIGNUP_STYLES
} from '../constants';
import { useT, useLang } from '../services/i18n';
import { localTz, tzLabel, zonedToInstant, instantToZoned, fmtInstant, isEventClosed } from '../services/datetime';
import { InkStroke, Watermark, GLYPHS } from './decor';

// Какие пояса предлагать при создании (плюс пояс устройства, если он другой)
const TZ_CHOICES = ['Europe/Moscow', 'Europe/Paris'];

interface EventsPanelProps {
  sessions: GuildWarSession[];
  activeSessionId: string | null;
  isViewer: boolean;
  players: Player[];
  claimedPlayerId: string | null;
  onSignup: (sessionId: string, playerId: string, status: SignupStatus | null) => void;
  onGoToRoster: () => void;
  // Вход через Discord включён, а человек не вошёл: кнопок заявки у него быть не
  // может, и отправлять его «отметиться в составе» бессмысленно — там теперь тоже
  // вход. Показываем прямую кнопку.
  needLogin?: boolean;
  onLogin?: () => void;
  onCreate: (meta: GuildEventMeta, name: string) => void;
  onUpdateMeta: (id: string, meta: GuildEventMeta, name: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
}

const isValidAssignment = (a: { side?: string; group?: number }) =>
  (a.side === 'attack' || a.side === 'defense') && (a.group === 1 || a.group === 2 || a.group === 3);

// Считаем только заявки существующих игроков — заявки удалённых из состава не должны
// раздувать счётчики.
const countStatus = (s: GuildWarSession, status: SignupStatus, playerIds: Set<string>) =>
  Object.entries(s.signups || {}).filter(([pid, v]) => v === status && playerIds.has(pid)).length;

const EMPTY: GuildEventMeta = { type: 'prak', opponent: '', date: '', time: '', note: '' };

const EventsPanel: React.FC<EventsPanelProps> = ({
  sessions, activeSessionId, isViewer, players, claimedPlayerId, onSignup, onGoToRoster, onCreate, onUpdateMeta, onDelete, onOpen,
  needLogin = false, onLogin
}) => {
  const t = useT();
  const { lang } = useLang();
  const [editingId, setEditingId] = useState<string | null>(null); // null — не редактируем; '' — новое
  const [form, setForm] = useState<GuildEventMeta>(EMPTY);
  const [name, setName] = useState('');
  const [, setTick] = useState(0); // раз в полминуты — чтобы событие само перешло в «Завершено»
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const fmtDate = (d?: string) => {
    if (!d) return '';
    try {
      return new Date(d + 'T00:00:00').toLocaleDateString(lang === 'en' ? 'en-GB' : 'ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' });
    } catch { return d; }
  };

  const playerIds = useMemo(() => new Set(players.map(p => p.id)), [players]);

  // В «События» показываем только настоящие события (с метаданными). Прочие шаблоны — отдельно.
  // Порядок: сначала активные (ближайшие сверху), завершённые — вниз.
  // Ключ у старых событий (без startsAt) приводим к тому же виду «дата T время»,
  // чтобы события одного дня сортировались по времени одинаково с новыми.
  const sortKey = (s: GuildWarSession) =>
    s.event?.startsAt || (s.event?.date ? `${s.event.date}T${s.event.time || ''}` : '');
  const sorted = useMemo(() => {
    return sessions.filter(s => !!s.event).sort((a, b) => {
      const ca = isEventClosed(a.event?.startsAt, a.event?.type) ? 1 : 0;
      const cb = isEventClosed(b.event?.startsAt, b.event?.type) ? 1 : 0;
      if (ca !== cb) return ca - cb;            // завершённые в конец
      const ka = sortKey(a), kb = sortKey(b);
      if (ka && kb) return ca ? kb.localeCompare(ka) : ka.localeCompare(kb); // активные ↑, завершённые ↓
      if (ka) return -1;
      if (kb) return 1;
      return 0;
    });
  }, [sessions]);

  const startCreate = () => { setForm({ ...EMPTY, tz: localTz() }); setName(''); setEditingId(''); };
  const startEdit = (s: GuildWarSession) => {
    if (s.event) {
      const tz = s.event.tz || localTz();
      // если есть абсолютный момент — показываем стенные часы в его поясе
      const wall = s.event.startsAt ? instantToZoned(s.event.startsAt, tz) : { date: s.event.date || '', time: s.event.time || '' };
      setForm({ ...EMPTY, ...s.event, tz, date: wall.date, time: wall.time });
    } else {
      setForm({ ...EMPTY, tz: localTz() });
    }
    setName(s.name || '');
    setEditingId(s.id);
  };
  const cancel = () => { setEditingId(null); };
  const submit = () => {
    const tz = form.tz || localTz();
    const startsAt = zonedToInstant(form.date, form.time, tz);
    const meta: GuildEventMeta = {
      type: form.type,
      opponent: form.type === 'prak' ? (form.opponent || '').trim() : undefined,
      date: form.date || undefined,
      time: form.time || undefined,
      tz: startsAt ? tz : undefined,
      startsAt: startsAt || undefined,
      note: (form.note || '').trim() || undefined
    };
    const resolved = name.trim()
      || (meta.type === 'prak' && meta.opponent ? `vs ${meta.opponent}` : EVENT_TYPE_LABELS[meta.type]);
    if (editingId) onUpdateMeta(editingId, meta, resolved);
    else onCreate(meta, resolved);
    setEditingId(null);
  };

  const setType = (type: GuildEventType) => setForm(f => ({ ...f, type }));

  const renderForm = () => (
    <div className="bg-slate-900 border border-amber-600/40 rounded-2xl p-5 mb-5 max-w-md">
      <h3 className="cinzel text-lg font-semibold text-amber-500 mb-4">{editingId ? t('Редактировать событие') : t('Новое событие')}</h3>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-slate-400 mb-2">{t('Тип')}</label>
          <div className="grid grid-cols-1 gap-2">
            {EVENT_TYPES.map(tp => {
              const st = EVENT_TYPE_STYLES[tp];
              const active = form.type === tp;
              return (
                <button key={tp} onClick={() => setType(tp)}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold border transition-colors
                    ${active ? `${st.solid} border-transparent text-white` : `bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600`}`}>
                  <Glyph name={EVENT_TYPE_ICONS[tp]} />{EVENT_TYPE_LABELS[tp]}
                </button>
              );
            })}
          </div>
        </div>

        {form.type === 'prak' && (
          <div>
            <label className="block text-xs text-slate-400 mb-1">{t('Соперник')}</label>
            <input type="text" value={form.opponent || ''} onChange={e => setForm(f => ({ ...f, opponent: e.target.value }))}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-700 transition-colors" />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">{t('Дата')}</label>
            <input type="date" value={form.date || ''} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-700 transition-colors [color-scheme:dark]" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">{t('Время')}</label>
            <input type="time" value={form.time || ''} onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-700 transition-colors [color-scheme:dark]" />
          </div>
        </div>

        {form.time && (
          <div>
            <label className="block text-xs text-slate-400 mb-1">{t('Часовой пояс времени')}</label>
            <select value={form.tz || localTz()} onChange={e => setForm(f => ({ ...f, tz: e.target.value }))}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-700 [color-scheme:dark]">
              {Array.from(new Set([localTz(), ...TZ_CHOICES])).map(z => (
                <option key={z} value={z}>{tzLabel(z)}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-600">{t('В каком поясе указано время. Каждый увидит его в своём.')}</p>
          </div>
        )}

        <div>
          <label className="block text-xs text-slate-400 mb-1">{t('Название (необязательно)')}</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-700 transition-colors" />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">{t('Заметка')}</label>
          <input type="text" value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-700 transition-colors" />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={submit} className="flex-1 bg-amber-600 hover:bg-amber-500 text-white font-semibold py-2.5 rounded-lg transition-colors">
            {editingId ? t('Сохранить') : t('Создать событие')}
          </button>
          <button onClick={cancel} className="px-4 py-2.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-sm font-semibold transition-colors">
            {t('Отмена')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="cinzel text-2xl font-semibold text-amber-500 flex items-center gap-3">
            <i className="fa-solid fa-calendar-days"></i>{t('События недели')}
          </h2>
          <InkStroke className="max-w-[260px] mt-1" />
        </div>
        {/* Список привязок жил здесь отдельной модалкой — переехал на вкладку
            «Интеграции», где видно и Telegram, и Discord, и висячие привязки */}
        {!isViewer && editingId === null && (
          <button onClick={startCreate} className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors">
            <i className="fa-solid fa-plus"></i>{t('Новое событие')}
          </button>
        )}
      </div>

      {editingId !== null && renderForm()}

      {sorted.length === 0 ? (
        <div className="relative overflow-hidden py-16 text-center text-slate-600 border-2 border-dashed border-slate-800 rounded-2xl">
          <Watermark glyph={GLYPHS.wind} size={120} className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300" />
          <i className="fa-solid fa-calendar-xmark text-4xl mb-3 opacity-30"></i>
          <p className="font-semibold">{t('Событий пока нет')}</p>
          {!isViewer && <p className="text-xs text-slate-600 mt-1">{t('Офицеры создают события здесь — праки, ранкед, лига.')}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {sorted.map(s => {
            const type = s.event?.type;
            const st = type ? EVENT_TYPE_STYLES[type] : null;
            const active = s.id === activeSessionId;
            const inN = countStatus(s, 'in', playerIds), maybeN = countStatus(s, 'maybe', playerIds), subN = countStatus(s, 'sub', playerIds);
            const rosterN = (s.assignments || []).filter(isValidAssignment).length;
            const closed = isEventClosed(s.event?.startsAt, s.event?.type);
            const startsAt = s.event?.startsAt;
            return (
              <div key={s.id} className={`relative overflow-hidden bg-slate-900 border rounded-2xl p-4 flex flex-col gap-3 transition-colors duration-200 ${closed ? 'opacity-60' : 'hover:bg-slate-800/40'} ${active ? 'border-amber-500 ring-1 ring-amber-500/40' : 'border-slate-800 hover:border-slate-700'}`}>
                <Watermark glyph={GLYPHS.war} size={92} className="-right-2 -bottom-6 text-amber-500" />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {type ? (
                      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-lg border ${st!.bg} ${st!.border} ${st!.text}`}>
                        <Glyph name={EVENT_TYPE_ICONS[type]} />{EVENT_TYPE_LABELS[type]}
                      </span>
                    ) : (
                      <span className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-lg border bg-slate-800 border-slate-700 text-slate-400">{t('Состав')}</span>
                    )}
                    <p className="mt-2 text-base font-semibold text-slate-100 truncate">
                      {type === 'prak' && s.event?.opponent ? `vs ${s.event.opponent}` : (s.name || EVENT_TYPE_LABELS[type || 'prak'])}
                    </p>
                    {closed && <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-slate-400 bg-slate-800 border border-slate-700 rounded-lg px-1.5 py-0.5"><i className="fa-solid fa-lock"></i>{t('Завершено')}</span>}
                  </div>
                  {startsAt ? (
                    <div className="text-right text-xs text-slate-400 whitespace-nowrap shrink-0">
                      <div><i className="fa-solid fa-clock mr-1 opacity-60"></i>{fmtInstant(startsAt, lang)}</div>
                      <div className="mt-0.5 text-[11px] text-slate-600">{t('твоё время')}</div>
                    </div>
                  ) : (s.event?.date || s.event?.time) ? (
                    <div className="text-right text-xs text-slate-400 whitespace-nowrap shrink-0">
                      {s.event?.date && <div><i className="fa-solid fa-calendar mr-1 opacity-60"></i>{fmtDate(s.event.date)}</div>}
                      {s.event?.time && <div className="mt-0.5"><i className="fa-solid fa-clock mr-1 opacity-60"></i>{s.event.time}</div>}
                    </div>
                  ) : null}
                </div>

                {s.event?.note && <p className="text-xs text-slate-500 italic -mt-1">{s.event.note}</p>}

                <div className="py-2 border-y border-slate-800/60 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span><span className={`font-semibold ${SIGNUP_STYLES.in.text}`}>{inN}</span> {t('иду')}</span>
                    <span><span className={`font-semibold ${SIGNUP_STYLES.maybe.text}`}>{maybeN}</span> {t('под вопросом')}</span>
                    <span><span className={`font-semibold ${SIGNUP_STYLES.sub.text}`}>{subN}</span> {t('замена')}</span>
                    <span className="ml-auto">{t('в составе')} <span className="font-semibold text-slate-200">{rosterN}/30</span></span>
                  </div>
                  {/* Стек-бар наполнения: 30 слотов, закрашены цветами статусов (иду/вопрос/замена) */}
                  <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-950 border border-slate-800/60" title={`${inN + maybeN + subN}/30`}>
                    {inN > 0 && <span className={`${SIGNUP_STYLES.in.solid} transition-colors duration-500`} style={{ width: `${Math.min(100, (inN / 30) * 100)}%` }}></span>}
                    {maybeN > 0 && <span className={`${SIGNUP_STYLES.maybe.solid} transition-colors duration-500`} style={{ width: `${Math.min(100, (maybeN / 30) * 100)}%` }}></span>}
                    {subN > 0 && <span className={`${SIGNUP_STYLES.sub.solid} transition-colors duration-500`} style={{ width: `${Math.min(100, (subN / 30) * 100)}%` }}></span>}
                  </div>
                </div>

                {/* Моя заявка */}
                {closed ? (
                  <div className="text-center text-[11px] font-semibold text-slate-500 py-1.5 border border-dashed border-slate-800 rounded-lg">
                    <i className="fa-solid fa-lock mr-1.5"></i>{t('Регистрация закрыта')}
                  </div>
                ) : claimedPlayerId ? (
                  <div className="grid grid-cols-4 gap-1.5">
                    {SIGNUP_STATUSES.map(stt => {
                      const active = (s.signups || {})[claimedPlayerId] === stt;
                      const sty = SIGNUP_STYLES[stt];
                      return (
                        <button key={stt}
                          onClick={() => onSignup(s.id, claimedPlayerId, active ? null : stt)}
                          className={`flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors active:scale-95
                            ${active ? `${sty.bg} ${sty.border} ${sty.text}` : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600'}`}>
                          <i className={`fa-solid ${SIGNUP_ICONS[stt]} text-[11px]`}></i>{SIGNUP_SHORT[stt]}
                        </button>
                      );
                    })}
                  </div>
                ) : needLogin ? (
                  <button onClick={onLogin}
                    className="w-full py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 hover:text-indigo-300 hover:border-indigo-700 text-[11px] font-semibold transition-colors">
                    <i className="fa-brands fa-discord mr-1.5"></i>{t('Войдите, чтобы отметиться')}
                  </button>
                ) : (
                  <button onClick={onGoToRoster}
                    className="w-full py-1.5 rounded-lg border border-dashed border-slate-700 text-slate-400 hover:text-amber-400 hover:border-amber-700 text-[11px] font-semibold transition-colors">
                    <i className="fa-solid fa-user-check mr-1.5"></i>{t('Отметься в составе, чтобы записаться')}
                  </button>
                )}

                <div className="flex items-center gap-2 mt-auto">
                  <button onClick={() => onOpen(s.id)} className="flex-1 inline-flex items-center justify-center gap-2 bg-slate-950 hover:bg-slate-800 border border-slate-700 hover:border-amber-700 text-slate-200 text-xs font-semibold py-2 rounded-lg transition-colors">
                    <i className="fa-solid fa-chess-board text-amber-500"></i>{t('Открыть штаб войны')}
                  </button>
                  {!isViewer && (
                    <>
                      <button onClick={() => startEdit(s)} title={t('Редактировать событие')} className="w-9 h-9 rounded-lg border border-slate-800 text-slate-400 hover:text-white hover:border-slate-600 transition-colors"><i className="fa-solid fa-pen text-xs"></i></button>
                      <button onClick={() => onDelete(s.id)} title={t('Удалить')} className="w-9 h-9 rounded-lg border border-slate-800 text-slate-500 hover:text-red-400 hover:border-red-900/60 transition-colors"><i className="fa-solid fa-trash-can text-xs"></i></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default EventsPanel;
