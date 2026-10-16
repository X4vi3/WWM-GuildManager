
import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { Player, GuildWarSession, GuildEventMeta, SignupStatus, MapTemplate } from './types';
import { storageService } from './services/storageService';
import { api, getClientId, subscribeEvents, PresenceEntry, Session } from './services/api';
import { DEFAULT_GROUP_LANES } from './constants';
import MemberManager from './components/MemberManager'; // вкладка по умолчанию — грузим сразу
import UnavailableModal from './components/UnavailableModal';
import PresenceBar from './components/PresenceBar';
import TemplateBar from './components/TemplateBar';
import MapStrategyBar from './components/MapStrategyBar';
// Тяжёлые вкладки грузим лениво (dnd-kit, рисование, html-to-image) — быстрее первый экран
const WarPlanner = lazy(() => import('./components/WarPlanner'));
const BattleMap = lazy(() => import('./components/BattleMap'));
const EventsPanel = lazy(() => import('./components/EventsPanel'));
const TransferPanel = lazy(() => import('./components/TransferPanel'));
const DiscordSettings = lazy(() => import('./components/DiscordSettings'));
// Заливка записей: страница тяжёлая (шрифт Anton + фон обложки), грузим лениво
const GvgUploader = lazy(() => import('./components/GvgUploader'));
const GvgGallery = lazy(() => import('./components/GvgGallery'));
import { NotificationHost, toast, confirm } from './components/Notifications';
import { useT, useLang } from './services/i18n';
import { setLifecycleConfig } from './services/datetime';
import { applyAway, isAway } from './server/away.mjs';
import {
  GuildState, ImportSummary, summaryTotal,
  buildBackup, downloadBackup, backupFilename
} from './services/transfer';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Хэш в конце ссылки, открывающий окно входа для офицеров (можно поменять).
// Обычные участники заходят по обычной ссылке и ничего этого не видят.
const EDITOR_HASH = 'admin';
const EDIT_KEY_STORAGE = 'wmgs_edit_key';
const CLAIM_KEY_STORAGE = 'wmgs_claimed_player_id';
const ACTIVE_SESSION_KEY = 'wmgs_active_session'; // какой шаблон открыт — ЛОКАЛЬНО (у каждого свой)
const ACTIVE_MAP_KEY = 'wmgs_active_map';         // какая стратегия карты открыта — ЛОКАЛЬНО

// Стратегия карты по умолчанию. Миграция: если стратегий ещё нет, собираем «Базовую»
// из старых map-полей сессий (карта раньше жила внутри сессии).
const makeDefaultMap = (sessions: GuildWarSession[]): MapTemplate => {
  const legacy: any = sessions.find(s =>
    (s as any).mapDrawings?.length || (s as any).mapObjectives?.length ||
    (s as any).mapTexts?.length || Object.keys((s as any).mapPositions || {}).length
  ) || {};
  return {
    id: 'map-default',
    name: 'Базовая',
    objectives: legacy.mapObjectives || [],
    drawings: legacy.mapDrawings || [],
    texts: legacy.mapTexts || [],
    positions: legacy.mapPositions || {}
  };
};

const makeInitialSession = (): GuildWarSession => ({
  id: 'initial-session',
  name: 'Операция «Страж ветров»',
  date: new Date().toISOString(),
  assignments: [],
  groupLanes: { ...DEFAULT_GROUP_LANES }
});

const hashWantsLogin = () =>
  window.location.hash.replace(/^#\/?/, '').toLowerCase() === EDITOR_HASH;

// Вкладки получают свой URL через хеш (#roster / #events / #war-room / #map),
// чтобы ссылкой можно было делиться и работали «назад/вперёд». #admin — отдельный
// спец-хеш входа, вкладкой не считается.
// 'integrations' — офицерская страница (Discord и сроки событий). В навигации её
// видит только редактор; зрителя, попавшего по прямой ссылке, уводим на состав.
// 'records' и 'upload' — галерея записей и их заливка. В навигации их НЕТ
// намеренно: это не основной контент, попадают туда иконкой в шапке. Но хеши
// свои имеют, чтобы ссылкой можно было поделиться и работали «назад/вперёд».
// Иконка ведёт в галерею: смотрят записи все и часто, заливают немногие и редко.
type TabId = 'events' | 'roster' | 'war-room' | 'map' | 'integrations' | 'upload' | 'records';
const TABS: TabId[] = ['events', 'roster', 'war-room', 'map', 'integrations', 'upload', 'records'];
const OFFICER_TABS: TabId[] = ['integrations'];
const tabFromHash = (): TabId | null => {
  const h = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  return (TABS as string[]).includes(h) ? (h as TabId) : null;
};

const App: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useLang();
  const [activeTab, setActiveTab] = useState<TabId>(() => tabFromHash() ?? 'roster');
  const [players, setPlayers] = useState<Player[]>([]);
  const [sessions, setSessions] = useState<GuildWarSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => localStorage.getItem(ACTIVE_SESSION_KEY));
  // Стратегии карты — синхронизируются; выбор активной — локальный (как у событий)
  const [mapTemplates, setMapTemplates] = useState<MapTemplate[]>([]);
  const [activeMapId, setActiveMapId] = useState<string | null>(() => localStorage.getItem(ACTIVE_MAP_KEY));
  const [loading, setLoading] = useState(true);
  // Окно выборочного экспорта/импорта (одно на оба режима)
  const [transferMode, setTransferMode] = useState<'export' | 'import' | null>(null);

  // Кого сейчас помечаем недоступным (одно окно на офицера и на самого игрока)
  const [unavailableFor, setUnavailableFor] = useState<Player | null>(null);

  // ---- Авторизация ----
  const [editKey, setEditKey] = useState<string | null>(() => localStorage.getItem(EDIT_KEY_STORAGE));
  const [showLogin, setShowLogin] = useState(false);
  const [loginMode, setLoginMode] = useState<'login' | 'change'>('login');
  const [loginInput, setLoginInput] = useState('');     // в режиме смены — текущий пароль
  const [newPwInput, setNewPwInput] = useState('');     // новый пароль
  const [loginError, setLoginError] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);

  // ---- Вход через Discord ----
  // Пока флаг выключен, session.loginEnabled = false и всё ниже не влияет ни на что.
  const [session, setSession] = useState<Session>(
    { loginEnabled: false, accessMode: 'open', registerUrl: '', user: null }
  );
  // Пока сервер не ответил, мы НЕ ЗНАЕМ, включён ли вход. Умолчание «выключен»
  // выбрано, чтобы сайт без Discord работал сразу, но из-за него на долю секунды
  // успевала мелькнуть цепочка «это я / это не я», которой при включённом входе
  // быть не должно. Поэтому кнопки закрепления ждут ответа.
  const [sessionReady, setSessionReady] = useState(false);
  const me = session.user;
  // Две двери офицера: пароль через #admin (от Discord не зависит) и роль в Discord.
  const canEdit = !!editKey || !!me?.officer;
  const isViewer = !canEdit;
  const needLogin = session.loginEnabled && !me;

  const lastSavedRef = useRef<string>('');
  const saveTimer = useRef<number | undefined>(undefined);
  const savedFlashTimer = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef(false); // true, пока наше изменение ещё не улетело на сервер
  const activeSessionIdRef = useRef<string | null>(null); // последний известный активный шаблон (для applyState)
  const activeMapIdRef = useRef<string | null>(null);     // последняя известная активная стратегия карты
  const justChangedPwRef = useRef(false); // мы сами только что сменили пароль — не выбивать себя
  const silentSaveRef = useRef(false);    // следующее сохранение — импорт: не дёргать Телеграм
  // Снимок для кнопки «Отменить» в тосте после импорта. applied — что мы отправили,
  // чтобы заметить, если за эти секунды другой офицер успел что-то поправить.
  const undoRef = useRef<{ snapshot: GuildState; applied: string } | null>(null);

  // ---- Индикаторы для пользователя ----
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle'); // состояние сохранения (редактор)
  const [connected, setConnected] = useState(true); // живая связь с сервером (SSE)

  // ---- Присутствие: кто сейчас на сайте, кто закрепил за собой ник ----
  const [clientId] = useState<string>(getClientId);
  const [claimedPlayerId, setClaimedPlayerId] = useState<string | null>(() => localStorage.getItem(CLAIM_KEY_STORAGE));
  const [presence, setPresence] = useState<PresenceEntry[]>([]);

  // Кто я в составе. При включённом входе это говорит Discord, а не кнопка «это я»:
  // именно в ней и была дыра — она не требовала вообще ничего, поэтому отписать
  // человека с прака мог любой, кто открыл ссылку, и следов не оставалось.
  const myPlayerId = session.loginEnabled ? (me?.linked ? me.playerId : null) : claimedPlayerId;

  // Синхронизируем активный шаблон/стратегию в ref + сохраняем локально (выбор у каждого свой)
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (activeSessionId) localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  }, [activeSessionId]);
  useEffect(() => {
    activeMapIdRef.current = activeMapId;
    if (activeMapId) localStorage.setItem(ACTIVE_MAP_KEY, activeMapId);
    else localStorage.removeItem(ACTIVE_MAP_KEY);
  }, [activeMapId]);

  // Переключение вкладки: меняем состояние и пишем хеш в URL (новая запись в истории —
  // чтобы «назад/вперёд» ходили по вкладкам). Используем во всех кнопках навигации.
  const navTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    if (window.location.hash.replace(/^#\/?/, '').toLowerCase() !== tab) window.location.hash = tab;
  }, []);
  // Реакция на смену хеша (кнопки браузера «назад/вперёд» или прямой переход по ссылке)
  useEffect(() => {
    const onHash = () => { const tab = tabFromHash(); if (tab) setActiveTab(tab); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Офицерские вкладки зрителю не показываем: если попал по прямой ссылке или
  // потерял доступ (сменили пароль) — уводим на состав, чтобы не висел на пустом.
  useEffect(() => {
    if (!canEdit && OFFICER_TABS.includes(activeTab)) navTab('roster');
  }, [canEdit, activeTab, navTab]);

  // ---- Загрузка состояния (бэкенд → локальный кэш как фолбэк) ----
  // ВАЖНО: activeSessionId/activeMapId НЕ синхронизируются между пользователями — локальный выбор.
  // С сервера приходят players+sessions+mapTemplates; свой открытый шаблон/стратегию сохраняем.
  const applyState = useCallback((p: Player[], s: GuildWarSession[], maps?: MapTemplate[]) => {
    const sessionsToUse = s.length > 0 ? s : [makeInitialSession()];
    const mapsToUse = (maps && maps.length) ? maps : [makeDefaultMap(sessionsToUse)];
    const prev = activeSessionIdRef.current;
    const nextActive = prev && sessionsToUse.some(x => x.id === prev) ? prev : sessionsToUse[0].id;
    const prevMap = activeMapIdRef.current;
    const nextMap = prevMap && mapsToUse.some(m => m.id === prevMap) ? prevMap : mapsToUse[0].id;
    setPlayers(p);
    setSessions(sessionsToUse);
    setMapTemplates(mapsToUse);
    if (nextActive !== prev) { setActiveSessionId(nextActive); activeSessionIdRef.current = nextActive; }
    if (nextMap !== prevMap) { setActiveMapId(nextMap); activeMapIdRef.current = nextMap; }
    lastSavedRef.current = JSON.stringify({ players: p, sessions: sessionsToUse, mapTemplates: mapsToUse });
  }, []);

  const loadAll = useCallback(async () => {
    // Сроки закрытия регистрации — с сервера (до/без ответа работает умолчание в datetime.ts)
    // Ключ нужен в Закрытом режиме: там чтение состояния закрыто, и офицер, вошедший
    // паролем, без него получал 403 — сайт открывался пустым. editKey в зависимостях
    // не случайно: войдя в режим редактора уже на открытой странице, состав надо
    // подтянуть заново, а не оставлять человека перед пустым экраном.
    const [remote, lifecycleCfg] = await Promise.all([api.getState(editKey), api.getLifecycle()]);
    if (lifecycleCfg) setLifecycleConfig(lifecycleCfg);
    if (remote) {
      applyState(remote.players, remote.sessions, remote.mapTemplates);
    } else {
      // Бэкенд недоступен — показываем локальный кэш (офлайн / dev без сервера)
      applyState(storageService.getPlayers(), storageService.getSessions(), storageService.getMapTemplates());
    }
    setLoading(false);
  }, [applyState, editKey]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // При каждой загрузке перепроверяем сохранённый пароль на сервере. Если его сменили,
  // пока нас не было (мы не получили live-сигнал authrevoked) — снимаем доступ сразу,
  // а не ждём первой неудачной попытки сохранить.
  useEffect(() => {
    const key = localStorage.getItem(EDIT_KEY_STORAGE);
    if (!key) return;
    api.auth(key).then(ok => {
      if (!ok) {
        localStorage.removeItem(EDIT_KEY_STORAGE);
        setEditKey(null);
        toast(t('Пароль гильдии сменили — доступ к редактированию снят.'), 'error');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Живая синхронизация: и зрители, и редакторы получают изменения друг друга мгновенно (SSE)
  useEffect(() => {
    const stop = subscribeEvents(clientId, editKey, {
      onState: (s) => {
        if (pendingSaveRef.current) return; // у нас своё несохранённое изменение — не затираем
        const serialized = JSON.stringify({ players: s.players, sessions: s.sessions, mapTemplates: s.mapTemplates ?? [] });
        if (serialized === lastSavedRef.current) return; // это же самое мы только что отправили
        applyState(s.players, s.sessions, s.mapTemplates);
      },
      onPresence: setPresence,
      onStatus: setConnected,
      // Офицер сменил сроки закрытия — применяем и перерисовываем карточки событий
      onLifecycle: (cfg) => { setLifecycleConfig(cfg); setSessions(prev => [...prev]); },
      onAuthRevoked: async () => {
        if (justChangedPwRef.current) return; // мы сами сменили пароль — себя не трогаем
        const key = localStorage.getItem(EDIT_KEY_STORAGE);
        if (!key) return; // мы и так только смотрим
        const stillValid = await api.auth(key);
        if (!stillValid) {
          localStorage.removeItem(EDIT_KEY_STORAGE);
          setEditKey(null);
          toast(t('Пароль гильдии изменили — доступ к редактированию снят.'), 'error');
        }
      }
    });
    return stop;
  }, [clientId, editKey, applyState]);

  // При первом подключении — заново заявить серверу о своём закреплённом нике
  // (после перезапуска сервера). Только когда вход выключен: иначе личность даёт
  // печенька, а этот вызов ещё и повторял бы старый выбор из localStorage,
  // оставшийся с тех времён, когда входа не было.
  useEffect(() => {
    if (!sessionReady || session.loginEnabled) return;
    if (!claimedPlayerId) return;
    api.claimPlayer(clientId, claimedPlayerId).then(res => {
      if (res === 'taken') {
        localStorage.removeItem(CLAIM_KEY_STORAGE);
        setClaimedPlayerId(null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, sessionReady, session.loginEnabled]);

  // Кто я — спрашиваем при загрузке страницы и при возврате на вкладку. Именно здесь
  // (и только здесь) сервер ходит в Discord за офицерской ролью: дали роль — обновил
  // страницу и уже редактор, ждать фоновой минуты не нужно.
  const loadSession = useCallback(() => {
    api.getSession().then(s => { setSession(s); setSessionReady(true); });
  }, []);
  useEffect(() => {
    loadSession();
    const onFocus = () => loadSession();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadSession]);

  const startDiscordLogin = () => { window.location.href = '/api/auth/discord/login'; };

  const claimSelf = async (playerId: string) => {
    // Вход включён — «это я» больше ничего не доказывает: доказывает Discord.
    if (session.loginEnabled) return startDiscordLogin();
    const res = await api.claimPlayer(clientId, playerId);
    if (res === 'ok') {
      localStorage.setItem(CLAIM_KEY_STORAGE, playerId);
      setClaimedPlayerId(playerId);
    } else if (res === 'taken') {
      toast(t('Этот участник уже закреплён на другом устройстве.'), 'error');
    }
  };

  const unclaimSelf = async () => {
    if (session.loginEnabled) {
      await api.logout();
      loadSession();
      return;
    }
    await api.unclaimPlayer(clientId);
    localStorage.removeItem(CLAIM_KEY_STORAGE);
    setClaimedPlayerId(null);
  };

  // ---- Сохранение: локальный кэш всегда + бэкенд (с дебаунсом) если редактор ----
  useEffect(() => {
    if (loading) return;
    // activeSessionId/activeMapId намеренно НЕ синхронизируются — это локальный выбор.
    // mapTemplates (стратегии карты) — общие, синхронизируются.
    const serialized = JSON.stringify({ players, sessions, mapTemplates });
    storageService.savePlayers(players);
    storageService.saveSessions(sessions);
    storageService.saveMapTemplates(mapTemplates);
    if (serialized === lastSavedRef.current) return; // ничего не менялось
    lastSavedRef.current = serialized;
    // Право писать даёт ЛЮБАЯ из двух дверей: пароль или роль офицера в Discord.
    // Требовать здесь ещё и editKey — значит молча ничего не сохранять офицеру,
    // вошедшему ролью: он правит состав и создаёт события, всё выглядит рабочим,
    // а на сервер не уходит ни одного запроса. Анонсы при этом тоже не приходят,
    // потому что событие до сервера не доехало.
    if (!canEdit) return;

    pendingSaveRef.current = true;
    setSaveStatus('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const silent = silentSaveRef.current; // импорт/откат — Телеграм не трогаем
      silentSaveRef.current = false;
      try {
        const res = await api.putState({ players, sessions, mapTemplates }, editKey, { silent });
        if (res === 'unauthorized') {
          setSaveStatus('error');
          if (editKey) {
            localStorage.removeItem(EDIT_KEY_STORAGE);
            setEditKey(null);
            toast(t('Пароль редактора больше не подходит — доступ к редактированию снят.'), 'error');
          } else {
            // Вошли ролью, а роль сняли. Про пароль тут говорить нечего — его нет.
            toast(t('Права редактора сняты — сохранить не удалось.'), 'error');
          }
        } else if (res === 'error') {
          setSaveStatus('error');
          toast(t('Не удалось сохранить на сервер — проверьте связь.'), 'error');
        } else {
          setSaveStatus('saved');
          window.clearTimeout(savedFlashTimer.current);
          savedFlashTimer.current = window.setTimeout(() => setSaveStatus('idle'), 2000);
        }
      } finally {
        pendingSaveRef.current = false;
      }
    }, 600);
  }, [players, sessions, mapTemplates, canEdit, editKey, loading]);

  // ---- Окно входа по «секретной» ссылке (#admin) ----
  // Ссылка #admin — это вход для офицеров. Если человек УЖЕ редактор, входить ему
  // некуда: окно не показываем вовсе (раньше его молча кидало в «смену пароля» —
  // именно на это жаловались офицеры с действующим доступом). Сменить пароль
  // редактор может кнопкой в шапке. Хеш специально не вычищаем: ключ при загрузке
  // ревалидируется асинхронно, и если доступ уже сняли — canEdit станет false,
  // эффект перезапустится и покажет вход.
  useEffect(() => {
    const update = () => {
      const want = hashWantsLogin();
      setLoginMode('login');
      setShowLogin(want && !canEdit);
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [canEdit]);

  // Открыть смену пароля вручную (кнопка в шапке у редактора)
  const openChangePassword = () => {
    setLoginMode('change');
    setLoginError(false);
    setLoginInput('');
    setNewPwInput('');
    setShowLogin(true);
  };

  // После входа/отмены убираем #admin и ставим хеш текущей вкладки (replaceState —
  // без события hashchange, чтобы не дёргать обработчики входа).
  const clearHash = () => {
    history.replaceState(null, '', window.location.pathname + window.location.search + '#' + activeTab);
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError(false);
    const ok = await api.auth(loginInput);
    setLoginBusy(false);
    if (ok) {
      localStorage.setItem(EDIT_KEY_STORAGE, loginInput);
      setEditKey(loginInput);
      setLoginInput('');
      setShowLogin(false);
      clearHash();
    } else {
      setLoginError(true);
    }
  };

  const submitChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginBusy) return;
    const currentKey = canEdit ? (editKey as string) : loginInput;
    if (!currentKey || !newPwInput) return;
    setLoginBusy(true);
    setLoginError(false);
    justChangedPwRef.current = true; // помечаем ДО запроса — чтобы свой же authrevoked не выбил нас
    const res = await api.changePassword(currentKey, newPwInput);
    setLoginBusy(false);
    if (res === 'ok') {
      localStorage.setItem(EDIT_KEY_STORAGE, newPwInput);
      setEditKey(newPwInput);
      setLoginInput('');
      setNewPwInput('');
      setShowLogin(false);
      clearHash();
      toast(t('Пароль изменён. Остальные редакторы потеряют доступ.'), 'success');
      window.setTimeout(() => { justChangedPwRef.current = false; }, 5000);
    } else {
      justChangedPwRef.current = false;
      if (res === 'weak') toast(t('Новый пароль слишком короткий (минимум 4 символа).'), 'error');
      else if (res === 'unauthorized') { setLoginError(true); toast(t('Текущий пароль неверный.'), 'error'); }
      else toast(t('Не удалось сменить пароль — проверьте связь.'), 'error');
    }
  };

  const cancelLogin = () => {
    setShowLogin(false);
    setLoginInput('');
    setNewPwInput('');
    setLoginError(false);
    clearHash();
  };

  const logout = () => {
    localStorage.removeItem(EDIT_KEY_STORAGE);
    setEditKey(null);
  };

  // ---- Изменения данных (только редактор) ----
  const handleAddPlayer = (p: Player) => {
    if (isViewer) return;
    setPlayers(prev => [...prev, p]);
  };
  const handleAddPlayers = (newPlayers: Player[]) => {
    if (isViewer || newPlayers.length === 0) return;
    setPlayers(prev => [...prev, ...newPlayers]);
  };
  const handleUpdatePlayer = (p: Player) => {
    if (isViewer) return;
    const before = players.find(prevP => prevP.id === p.id);
    setPlayers(prev => prev.map(prevP => (prevP.id === p.id ? p : prevP)));
    // Включили авто-запись — сразу проставляем «Иду» во всех событиях, где у него ещё нет заявки.
    // Недоступного пропускаем по той же причине, что и при создании события.
    if (p.autoSignup && !before?.autoSignup && !isAway(p)) {
      setSessions(prev => prev.map(s => {
        if (!s.event || (s.signups || {})[p.id]) return s;
        return { ...s, signups: { ...(s.signups || {}), [p.id]: 'in' } };
      }));
    }
  };
  // Пометить игрока недоступным (mark = null — снять).
  //
  // Пересчёт делает та же чистая функция, что и на сервере (away.mjs): она ставит
  // «Не иду» на будущие события в этот срок и освобождает место в группах. Офицер
  // применяет её локально и сохраняет состояние целиком обычным путём; игрок прав
  // на это не имеет, поэтому идёт через свою точку — ровно как с заявками.
  const setUnavailable = async (playerId: string, mark: { note: string; until: string } | null) => {
    const next = applyAway({ players, sessions }, playerId, mark);
    setPlayers(next.players);
    setSessions(next.sessions);
    setUnavailableFor(null);
    if (canEdit) return; // редактор: сохранит общий save-эффект
    const ok = await api.setUnavailable(clientId, playerId, mark, editKey || undefined);
    if (!ok) { toast(t('Не удалось сохранить — попробуйте ещё раз.'), 'error'); loadAll(); }
  };

  const handleDeletePlayer = async (id: string) => {
    if (isViewer) return;
    const target = players.find(p => p.id === id);
    const ok = await confirm(`${t('Удалить участника')} «${target?.name ?? ''}»? ${t('Его заявки и место в составах пропадут.')}`, { confirmLabel: t('Удалить'), danger: true });
    if (!ok) return;
    setPlayers(prev => prev.filter(p => p.id !== id));
    // Вычищаем все следы: назначения, заявки на события, токен на картах —
    // иначе счётчики «Иду» считают удалённых, а на карте висят токены-сироты.
    setSessions(prev => prev.map(s => {
      const next: GuildWarSession = { ...s, assignments: s.assignments.filter(a => a.playerId !== id) };
      if (next.signups && id in next.signups) {
        const signups = { ...next.signups };
        delete signups[id];
        next.signups = signups;
      }
      return next;
    }));
    setMapTemplates(prev => prev.map(m => {
      if (!m.positions || !(id in m.positions)) return m;
      const positions = { ...m.positions };
      delete positions[id];
      return { ...m, positions };
    }));
  };

  // ---- Выборочный экспорт / импорт ----

  // Записать новое состояние и протолкнуть его на сервер тихо (без Телеграма).
  const pushState = useCallback((next: GuildState) => {
    applyState(next.players, next.sessions, next.mapTemplates);
    silentSaveRef.current = true;
    lastSavedRef.current = ''; // принудительно отметить как изменение, чтобы улетело на бэкенд
    setPlayers(p => [...p]);
  }, [applyState]);

  // Откат последнего импорта. Состояние могло уйти вперёд — например, другой офицер
  // что-то поправил за эти секунды; тогда честно предупреждаем, что его правки пропадут.
  const undoTransfer = useCallback(async () => {
    const u = undoRef.current;
    if (!u) return;
    if (lastSavedRef.current && lastSavedRef.current !== u.applied) {
      const ok = await confirm(
        t('После импорта состояние уже изменилось — возможно, правит кто-то ещё. Откатить всё равно? Их правки пропадут.'),
        { confirmLabel: t('Откатить'), danger: true }
      );
      if (!ok) return;
    }
    pushState(u.snapshot);
    undoRef.current = null;
    toast(t('Импорт отменён.'), 'success');
  }, [pushState, t]);

  // Применение результата импорта/отката из окна. Снимок текущего состояния скачиваем,
  // только если офицер выбрал это в диалоге; кнопка «Отменить» в тосте работает в любом случае.
  const applyTransfer = (next: GuildState, summary: ImportSummary, rollback: boolean, saveBackup: boolean) => {
    if (isViewer) return;
    const snapshot: GuildState = { players, sessions, mapTemplates };
    if (saveBackup) {
      downloadBackup(
        buildBackup(snapshot, {
          players: true,
          sessionIds: sessions.map(s => s.id),
          mapIds: mapTemplates.map(m => m.id)
        }),
        backupFilename('WindsMeet_ПередИмпортом')
      );
    }

    // Показать стратегию, которая приехала или обновилась — иначе кажется, что ничего не изменилось
    const before = new Map(mapTemplates.map(m => [m.id, JSON.stringify(m)]));
    const changedMap = next.mapTemplates.find(m => before.get(m.id) !== JSON.stringify(m));

    pushState(next);
    if (changedMap) { setActiveMapId(changedMap.id); activeMapIdRef.current = changedMap.id; }

    undoRef.current = {
      snapshot,
      applied: JSON.stringify({ players: next.players, sessions: next.sessions, mapTemplates: next.mapTemplates })
    };
    setTransferMode(null);

    const msg = rollback
      ? t('Полный откат применён.')
      : `${t('Импорт применён.')} +${summary.playersAdded} ${t('игр.')}, ` +
        `+${summary.sessionsAdded + summary.sessionsCopied} ${t('сост.')}, ` +
        `+${summary.mapsAdded + summary.mapsCopied} ${t('страт.')}` +
        (summary.playersMerged ? `, ${summary.playersMerged} ${t('слито')}` : '');
    toast(msg, 'success', 30000, { label: t('Отменить'), onClick: undoTransfer });
  };

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeMap = mapTemplates.find(m => m.id === activeMapId) ?? mapTemplates[0];

  const handleUpdateSession = (updatedSession: GuildWarSession) => {
    if (isViewer) return;
    setSessions(prev => prev.map(s => (s.id === updatedSession.id ? updatedSession : s)));
  };

  // ---- Шаблоны составов (Ранкед / Лига / Праки и т.п.) — общие для всех ----
  // Переключение шаблона/события — ЛОКАЛЬНОЕ, доступно всем (у каждого свой просмотр)
  const switchTemplate = (id: string) => {
    setActiveSessionId(id);
  };

  const createTemplate = (name: string, fromCurrent: boolean) => {
    if (isViewer) return;
    const id = `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const title = name.trim() || t('Новый шаблон');
    const base = sessions.find(s => s.id === activeSessionId);
    let next: GuildWarSession;
    if (fromCurrent && base) {
      next = { ...JSON.parse(JSON.stringify(base)), id, name: title, date: new Date().toISOString() };
    } else {
      next = { ...makeInitialSession(), id, name: title };
    }
    setSessions(prev => [...prev, next]);
    setActiveSessionId(id);
  };

  const renameTemplate = (id: string, name: string) => {
    if (isViewer) return;
    const title = name.trim();
    if (!title) return;
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, name: title } : s)));
  };

  const deleteTemplate = async (id: string) => {
    if (isViewer || sessions.length <= 1) return;
    const target = sessions.find(s => s.id === id);
    // События и шаблоны лежат в одном массиве, и раньше оба удалялись с одинаковым
    // безобидным вопросом «Расстановка пропадёт». Но у события пропадает гораздо
    // больше: заявки игроков и анонсы в Discord с Телеграмом. Про это надо сказать прямо.
    const signupCount = Object.keys(target?.signups ?? {}).length;
    const message = target?.event
      ? [
          `${t('Удалить СОБЫТИЕ')} «${target.name}»?`,
          '',
          `• ${t('Событие исчезнет из вкладки «События»')}`,
          signupCount > 0 ? `• ${t('Пропадут заявки')}: ${signupCount}` : '',
          `• ${t('Анонсы в Discord и Телеграме будут удалены')}`,
          `• ${t('Расстановка в штабе войны пропадёт')}`,
          '',
          t('Это нельзя отменить.')
        ].filter(Boolean).join('\n')
      : `${t('Удалить шаблон')} «${target?.name ?? ''}»? ${t('Расстановка в нём пропадёт.')}`;

    const ok = await confirm(message, {
      confirmLabel: target?.event ? t('Удалить событие') : t('Удалить'),
      danger: true
    });
    if (!ok) return;
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== id);
      if (activeSessionId === id && remaining.length) setActiveSessionId(remaining[0].id);
      return remaining;
    });
  };

  // ---- События (праки / ранкед / лига) ----
  const createEvent = (meta: GuildEventMeta, name: string) => {
    if (isViewer) return;
    const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // Игроки с авто-записью сразу отмечены «Иду», без своего участия
    const signups: Record<string, SignupStatus> = {};
    // Недоступного авто-запись не касается: иначе человек в отпуске числился бы
    // «Иду», и офицер собрал бы состав на того, кого нет.
    for (const p of players) if (p.autoSignup && !isAway(p)) signups[p.id] = 'in';
    const next: GuildWarSession = { ...makeInitialSession(), id, name, event: meta, signups };
    setSessions(prev => [...prev, next]);
    setActiveSessionId(id);
  };

  const updateEventMeta = (id: string, meta: GuildEventMeta, name: string) => {
    if (isViewer) return;
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, event: meta, name } : s)));
  };

  const deleteEvent = async (id: string) => {
    if (isViewer) return;
    const ok = await confirm(t('Удалить это событие? Состав и заявки пропадут.'), { confirmLabel: t('Удалить'), danger: true });
    if (!ok) return;
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== id);
      if (activeSessionId === id) setActiveSessionId(remaining[0]?.id ?? null);
      return remaining;
    });
  };

  const openEvent = (id: string) => { setActiveSessionId(id); navTab('war-room'); };

  // Заявка игрока на событие. Локально обновляем сразу; редактор сохраняет обычным
  // путём (PUT всего состояния), зритель — через точку /api/signup (пишет только свою).
  const setSignup = async (sessionId: string, playerId: string, status: SignupStatus | null) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s;
      const signups = { ...(s.signups || {}) };
      if (status === null) delete signups[playerId]; else signups[playerId] = status;
      return { ...s, signups };
    }));
    if (canEdit) return; // редактор: сохранит общий save-эффект
    const ok = await api.signup(clientId, sessionId, playerId, status);
    if (!ok) { toast(t('Не удалось сохранить заявку — попробуйте ещё раз.'), 'error'); loadAll(); }
  };

  // ---- Стратегии карты (общие для всех; выбор активной — локальный) ----
  const updateMap = (next: MapTemplate) => {
    if (isViewer) return;
    setMapTemplates(prev => prev.map(m => (m.id === next.id ? next : m)));
  };
  const switchMap = (id: string) => setActiveMapId(id);
  const createMap = (name: string, fromCurrent: boolean) => {
    if (isViewer) return;
    const id = `map-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const base = mapTemplates.find(m => m.id === activeMapId);
    const title = name.trim() || t('Новая стратегия');
    const next: MapTemplate = fromCurrent && base
      ? { ...JSON.parse(JSON.stringify(base)), id, name: title }
      : { id, name: title, objectives: [], drawings: [], texts: [], positions: {} };
    setMapTemplates(prev => [...prev, next]);
    setActiveMapId(id);
  };
  const renameMap = (id: string, name: string) => {
    if (isViewer || !name.trim()) return;
    setMapTemplates(prev => prev.map(m => (m.id === id ? { ...m, name: name.trim() } : m)));
  };
  const deleteMap = async (id: string) => {
    if (isViewer || mapTemplates.length <= 1) return;
    const ok = await confirm(t('Удалить эту стратегию карты?'), { confirmLabel: t('Удалить'), danger: true });
    if (!ok) return;
    setMapTemplates(prev => {
      const remaining = prev.filter(m => m.id !== id);
      if (activeMapId === id) setActiveMapId(remaining[0]?.id ?? null);
      return remaining;
    });
  };

  // Окно входа по паролю. Вынесено в переменную, потому что нужно в ДВУХ местах:
  // на обычной странице и на экране Закрытого режима. Пока его рисовали только
  // внизу основного рендера, запасная дверь #admin из закрытого сайта была
  // недостижима — экран возвращался раньше, и окно просто не доходило до DOM.
  const loginModal = showLogin && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200" onClick={cancelLogin}>
        <form
          onSubmit={loginMode === 'change' ? submitChange : submitLogin}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-sm bg-slate-900 border border-amber-500/30 rounded-2xl shadow-lg overflow-hidden animate-in zoom-in-95 duration-300"
        >
          <div className="p-5 border-b border-slate-800 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-600/20 border border-amber-500/30 flex items-center justify-center">
              <i className={`fa-solid ${loginMode === 'change' ? 'fa-key' : 'fa-lock'} text-amber-500`}></i>
            </div>
            <div>
              <h3 className="cinzel text-amber-500 text-lg">
                {loginMode === 'change' ? t('Смена пароля') : t('Вход для офицеров')}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {loginMode === 'change' ? t('Старый доступ слетит у всех') : t('Доступ к редактированию')}
              </p>
            </div>
          </div>
          <div className="p-6 space-y-4">
            {/* Текущий пароль: в режиме входа — это пароль; в смене показываем только если не залогинен */}
            {(loginMode === 'login' || !canEdit) && (
              <input
                type="password"
                autoFocus
                value={loginInput}
                onChange={e => { setLoginInput(e.target.value); setLoginError(false); }}
                placeholder={loginMode === 'change' ? t('Текущий пароль') : t('Пароль')}
                className={`w-full bg-slate-950 border rounded-lg px-3 py-2.5 text-sm outline-none transition-colors ${loginError ? 'border-red-600 focus:border-red-500' : 'border-slate-800 focus:border-amber-600'}`}
              />
            )}

            {loginMode === 'change' && (
              <input
                type="password"
                autoFocus={canEdit}
                value={newPwInput}
                onChange={e => setNewPwInput(e.target.value)}
                placeholder={t('Новый пароль (мин. 4 символа)')}
                className="w-full bg-slate-950 border border-slate-800 focus:border-amber-600 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors"
              />
            )}

            {loginError && (
              <p className="text-[11px] text-red-400 font-semibold flex items-center gap-1.5">
                <i className="fa-solid fa-circle-exclamation"></i>
                {loginMode === 'change' ? t('Текущий пароль неверный') : t('Неверный пароль')}
              </p>
            )}

            {loginMode === 'change' && (
              <p className="text-[11px] text-slate-500 leading-relaxed flex items-start gap-1.5">
                <i className="fa-solid fa-triangle-exclamation text-amber-500/70 mt-0.5"></i>
                {t('После смены все, кто редактировал со старым паролем, потеряют доступ. Новый пароль раздай только текущим офицерам.')}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={loginMode === 'change' ? (loginBusy || !newPwInput || (!canEdit && !loginInput)) : (loginBusy || !loginInput)}
                className="flex-1 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loginBusy ? <i className="fa-solid fa-spinner fa-spin"></i> : (loginMode === 'change' ? t('Сменить пароль') : t('Войти'))}
              </button>
              <button
                type="button"
                onClick={cancelLogin}
                className="px-4 py-2.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-sm font-semibold transition-colors"
              >
                {t('Отмена')}
              </button>
            </div>

            {/* Переключатель режимов */}
            <button
              type="button"
              onClick={() => { setLoginMode(m => m === 'change' ? 'login' : 'change'); setLoginError(false); }}
              className="w-full text-center text-xs text-slate-400 hover:text-amber-400 transition-colors pt-1"
            >
              {loginMode === 'change'
                ? (canEdit ? null : t('← Войти с паролем'))
                : t('Сменить пароль гильдии →')}
            </button>
          </div>
        </form>
      </div>
  );

  // Закрытый режим: внутрь пускаем только привязанных. «Просто вошёл через Discord»
  // не считается — войти может любой человек с аккаунтом, и ссылка, попавшая в чужой
  // чат, пустила бы постороннего. Привязку выдаёт бот и только после роль-гейта.
  if (session.loginEnabled && session.accessMode === 'closed' && !me?.linked && !editKey) {
    return (
      <div className="min-h-screen text-slate-200 flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
          <h1 className="cinzel text-2xl mb-2">{t('Гильдия')}</h1>
          <p className="text-sm text-slate-400 mb-6">
            {me
              ? t('Чтобы попасть внутрь, привяжи игровой ник в канале регистрации.')
              : t('Этот сайт доступен участникам гильдии.')}
          </p>
          {me ? (
            <>
              {session.registerUrl && (
                <a
                  href={session.registerUrl}
                  className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
                >
                  <i className="fa-brands fa-discord"></i>{t('Открыть канал регистрации')}
                </a>
              )}
              <button onClick={unclaimSelf} className="mt-3 text-xs text-slate-500 hover:text-slate-300 transition-colors">
                {t('Выйти')}
              </button>
            </>
          ) : (
            <button
              onClick={startDiscordLogin}
              className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
            >
              <i className="fa-brands fa-discord"></i>{t('Войти через Discord')}
            </button>
          )}
        </div>
        {/* Запасная дверь офицера. Пароль от Discord не зависит вовсе, и именно
            здесь он нужнее всего: если адрес возврата вписан с ошибкой или Discord
            лёг, войти больше нечем. */}
        {loginModal}
        <NotificationHost />
      </div>
    );
  }

  return (
    // Фон даёт body (градиенты+виньетка в index.css) — здесь без непрозрачной заливки
    <div className="min-h-screen text-slate-200">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50">
        {/* Одна строка вместо трёх. Раньше шапка занимала ~200px: название игры,
            подзаголовок «Стратегический штаб», бейдж роли, отдельный ряд иконок
            экспорта и ещё полоса присутствия. Всё это — обвязка вокруг того
            единственного, зачем сюда приходят: переключиться между вкладками. */}
        <div className="max-w-[2400px] mx-auto px-6 h-14 flex items-center gap-4">
          {/* Слева — навигация, она же главное действие в шапке */}
          <nav className="flex items-center gap-1 min-w-0 overflow-x-auto custom-scrollbar" aria-label={t('Разделы')}>
            {([
              ['roster', 'fa-users', 'Состав гильдии'],
              ['events', 'fa-calendar-days', 'События'],
              ['war-room', 'fa-chess-knight', 'Штаб войны'],
              ['map', 'fa-map-location-dot', 'Карта'],
              ['integrations', 'fa-plug', 'Интеграции']
            ] as const).filter(([tab]) => canEdit || !OFFICER_TABS.includes(tab)).map(([tab, icon, label]) => {
              const active = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => navTab(tab)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative px-3 h-14 text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap
                    ${active ? 'text-white' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <i className={`fa-solid ${icon} text-xs ${active ? 'text-amber-500' : 'opacity-60'}`}></i>
                  {t(label)}
                  {/* Подчёркивание вместо заливки: активная вкладка читается сразу,
                      но не спорит по весу с содержимым страницы */}
                  {active && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-amber-500 rounded-full"></span>}
                </button>
              );
            })}
          </nav>

          {/* Правый край: состояние, кто на сайте, действия офицера */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!connected && (
              <span title={t('Переподключение…')} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                <i className="fa-solid fa-plug-circle-exclamation animate-pulse"></i>
                <span className="hidden lg:inline">{t('Переподключение…')}</span>
              </span>
            )}
            {canEdit && saveStatus === 'saving' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                <i className="fa-solid fa-spinner fa-spin"></i>
                <span className="hidden lg:inline">{t('Сохранение…')}</span>
              </span>
            )}
            {canEdit && saveStatus === 'saved' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 animate-in fade-in duration-200">
                <i className="fa-solid fa-circle-check"></i>
                <span className="hidden lg:inline">{t('Сохранено')}</span>
              </span>
            )}
            {canEdit && saveStatus === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                <i className="fa-solid fa-circle-exclamation"></i>
                <span className="hidden lg:inline">{t('Ошибка сохранения')}</span>
              </span>
            )}

            <PresenceBar presence={presence} players={players} myClientId={clientId} />

            {/* Заливка записей ГВГ. Не вкладка: к основному содержимому сайта она
                отношения не имеет, а видна только тому, кто привязан — плейлист
                называется его ником, и заливать можно только за себя. */}
            {me?.linked && (
              <button
                onClick={() => navTab('records')}
                title={t('Записи ГВГ')}
                aria-label={t('Записи ГВГ')}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                  ${activeTab === 'records' || activeTab === 'upload' ? 'text-amber-500' : 'text-slate-500 hover:text-amber-400 hover:bg-slate-800/60'}`}
              >
                <i className="fa-brands fa-youtube text-base"></i>
              </button>
            )}

            <span className="w-px h-6 bg-slate-800 mx-1" aria-hidden="true"></span>

            {/* Язык — две буквы без рамки: настройка редкая, места занимать не должна */}
            <div className="flex items-center text-xs font-semibold" title={t('Язык')}>
              {(['ru', 'en'] as const).map((l, i) => (
                <React.Fragment key={l}>
                  {i > 0 && <span className="text-slate-700 mx-0.5">/</span>}
                  <button
                    onClick={() => setLang(l)}
                    className={`px-1 py-1 uppercase transition-colors ${lang === l ? 'text-amber-500' : 'text-slate-600 hover:text-slate-400'}`}
                  >
                    {l}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {/* Кто я по Discord. Индиго — цвет Discord по общим правилам проекта. */}
            {session.loginEnabled && (
              <>
                <span className="w-px h-6 bg-slate-800 mx-1" aria-hidden="true"></span>
                {me ? (
                  <>
                    {/* Ник не привязан — сказать об этом прямо. Иначе непонятно, почему
                        своя строка в составе не подсвечена и кнопок заявки нет: в шапке
                        стоит имя, и выглядит так, будто всё в порядке. */}
                    {!me.linked && session.registerUrl && (
                      <a
                        href={session.registerUrl} target="_blank" rel="noreferrer"
                        title={t('Ник не привязан — отмечаться нельзя')}
                        className="inline-flex items-center gap-1.5 px-2 h-8 rounded-lg text-xs font-semibold text-amber-400 border border-amber-500/30 hover:bg-amber-950/30 transition-colors"
                      >
                        <i className="fa-solid fa-link-slash"></i>
                        <span className="hidden lg:inline">{t('Привязать ник')}</span>
                      </a>
                    )}
                    <button
                      onClick={unclaimSelf}
                      title={t('Выйти')}
                      className="inline-flex items-center gap-1.5 px-2 h-8 rounded-lg text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition-colors max-w-[12rem]"
                    >
                      <i className="fa-brands fa-discord text-indigo-400"></i>
                      <span className="truncate">{me.linked ? me.playerName : me.name}</span>
                      <i className="fa-solid fa-arrow-right-from-bracket text-slate-500"></i>
                    </button>
                  </>
                ) : (
                  <button
                    onClick={startDiscordLogin}
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold bg-slate-900 border border-slate-800 text-slate-200 hover:border-slate-700 transition-colors"
                  >
                    <i className="fa-brands fa-discord text-indigo-400"></i>
                    {t('Войти')}
                  </button>
                )}
              </>
            )}

            {canEdit && (
              <>
                <span className="w-px h-6 bg-slate-800 mx-1" aria-hidden="true"></span>
                {([
                  ['fa-download', 'Экспорт данных гильдии', () => setTransferMode('export'), 'hover:text-amber-400'],
                  ['fa-upload', 'Импорт данных гильдии', () => setTransferMode('import'), 'hover:text-amber-400'],
                  ['fa-key', 'Сменить пароль гильдии', openChangePassword, 'hover:text-amber-400'],
                  ['fa-arrow-right-from-bracket', 'Выйти из режима редактирования', logout, 'hover:text-red-400']
                  // Выход из режима редактирования — про пароль. Тому, кто редактор
                  // по роли в Discord, эта кнопка ничего не даёт: права снимаются
                  // ролью, а не здесь.
                ] as const).filter(([icon]) => icon !== 'fa-arrow-right-from-bracket' || !!editKey).map(([icon, label, onClick, hover]) => (
                  <button
                    key={icon}
                    onClick={onClick}
                    title={t(label)}
                    aria-label={t(label)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 ${hover} hover:bg-slate-800/60 transition-colors`}
                  >
                    <i className={`fa-solid ${icon} text-sm`}></i>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[2400px] mx-auto p-6">
        {!loading && activeTab === 'war-room' && (
          <TemplateBar
            sessions={sessions}
            activeSessionId={activeSessionId}
            isViewer={isViewer}
            onSwitch={switchTemplate}
            onCreate={createTemplate}
            onRename={renameTemplate}
            onDelete={deleteTemplate}
          />
        )}
        {!loading && activeTab === 'map' && (
          <MapStrategyBar
            maps={mapTemplates}
            activeMapId={activeMapId}
            isViewer={isViewer}
            onSwitch={switchMap}
            onCreate={createMap}
            onRename={renameMap}
            onDelete={deleteMap}
          />
        )}
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <p className="text-slate-500"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка...')}</p>
          </div>
        ) : (
        <Suspense fallback={<div className="flex items-center justify-center h-96"><p className="text-slate-500"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка...')}</p></div>}>
        {/* key={activeTab} — плавное появление содержимого при переключении вкладки */}
        {/* key оставлен намеренно: он сбрасывает состояние вкладки при переключении.
            Анимации въезда здесь больше нет — из-за неё всё содержимое страницы
            заново заезжало снизу на каждый клик по навигации. */}
        <div key={activeTab}>
        {activeTab === 'events' ? (
          <EventsPanel
            sessions={sessions}
            activeSessionId={activeSessionId}
            isViewer={isViewer}
            players={players}
            claimedPlayerId={myPlayerId}
            onSignup={setSignup}
            onGoToRoster={() => navTab('roster')}
            needLogin={needLogin}
            onLogin={startDiscordLogin}
            onCreate={createEvent}
            onUpdateMeta={updateEventMeta}
            onDelete={deleteEvent}
            onOpen={openEvent}
          />
        ) : activeTab === 'roster' ? (
          // При включённом входе личность назначает Discord, поэтому «это я» и «это
          // не я» в составе не показываем вовсе. Полумера — убрать только «это я» —
          // как раз и путала: оставшаяся «это не я» делала выход из аккаунта,
          // человека выбрасывало на авторизацию и привязывало обратно к нему же.
          <MemberManager
            players={players}
            isViewer={isViewer}
            onAdd={handleAddPlayer}
            onAddMany={handleAddPlayers}
            onUpdate={handleUpdatePlayer}
            onDelete={handleDeletePlayer}
            claimedPlayerId={myPlayerId}
            onClaim={session.loginEnabled || !sessionReady ? undefined : claimSelf}
            onUnclaim={session.loginEnabled || !sessionReady ? undefined : unclaimSelf}
            onUnavailable={setUnavailableFor}
          />
        ) : activeTab === 'map' ? (
          activeMap ? (
            <BattleMap
              players={players}
              isViewer={isViewer}
              mapTemplate={activeMap}
              onUpdateMap={updateMap}
            />
          ) : (
            <div className="flex items-center justify-center h-96">
              <p className="text-slate-500">{t('Загрузка тактического интерфейса...')}</p>
            </div>
          )
        ) : activeTab === 'integrations' ? (
          // Ключ пустой у того, кто редактор по роли в Discord: его запросы
          // подтверждает печенька, а не заголовок. Раньше здесь стояло `canEdit &&
          // editKey`, и такой офицер видел вкладку, но получал пустоту.
          canEdit ? <DiscordSettings editKey={editKey || ''} players={players} /> : null
        ) : activeTab === 'upload' ? (
          <GvgUploader isOfficer={canEdit} onSettings={() => navTab('integrations')} onGallery={() => navTab('records')} />
        ) : activeTab === 'records' ? (
          <GvgGallery isOfficer={canEdit} onUpload={() => navTab('upload')} />
        ) : activeSession ? (
          <WarPlanner
            players={players}
            sessions={sessions}
            isViewer={isViewer}
            editKey={editKey}
            activeSession={activeSession}
            onUpdateSession={handleUpdateSession}
            onUpdatePlayer={handleUpdatePlayer}
            claimedPlayerId={myPlayerId}
          />
        ) : (
          <div className="flex items-center justify-center h-96">
            <p className="text-slate-500">{t('Загрузка тактического интерфейса...')}</p>
          </div>
        )}
        </div>
        </Suspense>
        )}
      </main>

      {/* Выборочный экспорт / импорт (офицер) */}
      {transferMode && canEdit && (
        <Suspense fallback={null}>
          <TransferPanel
            mode={transferMode}
            state={{ players, sessions, mapTemplates }}
            onApply={applyTransfer}
            onClose={() => setTransferMode(null)}
          />
        </Suspense>
      )}

      {unavailableFor && (
        <UnavailableModal
          player={unavailableFor}
          onSave={mark => setUnavailable(unavailableFor.id, mark)}
          onClose={() => setUnavailableFor(null)}
        />
      )}

      {/* Окно входа / смены пароля (по секретной ссылке #admin) */}
      {loginModal}

      <NotificationHost />
    </div>
  );
};

export default App;
