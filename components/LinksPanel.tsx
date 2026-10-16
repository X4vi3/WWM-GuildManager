import React, { useEffect, useMemo, useState } from 'react';
import { api, TgLink, DiscordLink } from '../services/api';
import { Player } from '../types';
import { useT } from '../services/i18n';
import { toast, confirm } from './Notifications';

// Кто из состава к чему подключён. Логины и id видит только офицер — эта панель
// живёт на офицерской вкладке «Интеграции», обычным участникам она недоступна.

type Row = {
  player: Player | null;   // null — «висячая» привязка: игрока удалили из состава
  playerName: string;
  tg?: TgLink;
  dc?: DiscordLink;
};

const LinksPanel: React.FC<{ editKey: string; players: Player[]; reloadToken?: number }> =
  ({ editKey, players, reloadToken = 0 }) => {
  const t = useT();
  const [tgLinks, setTgLinks] = useState<TgLink[] | null>(null);
  const [dcLinks, setDcLinks] = useState<DiscordLink[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [q, setQ] = useState('');

  const load = () => {
    api.listTgLinks(editKey).then(setTgLinks);
    api.listDiscordLinks(editKey).then(setDcLinks);
  };
  useEffect(load, [editKey, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Row[] = useMemo(() => {
    const tgBy = new Map((tgLinks || []).map(l => [l.playerId, l]));
    const dcBy = new Map((dcLinks || []).map(l => [l.playerId, l]));

    const out: Row[] = players.map(p => ({
      player: p, playerName: p.name, tg: tgBy.get(p.id), dc: dcBy.get(p.id)
    }));

    // Привязки, чей игрок удалён из состава — их надо видеть, иначе они висят
    // невидимым мусором и занимают ник
    const known = new Set(players.map(p => p.id));
    for (const l of (tgLinks || [])) {
      if (!known.has(l.playerId)) out.push({ player: null, playerName: l.playerName, tg: l });
    }
    for (const l of (dcLinks || [])) {
      if (!known.has(l.playerId)) {
        // У мёртвой привязки playerName пуст: карточки уже нет. Имя берём из
        // подписей, которые сервер хранит рядом, — иначе строка была бы безымянной
        // и офицер не понял бы, чья она.
        const name = l.playerName || l.lastPlayerName || l.discordName || l.discordId;
        const existing = out.find(r => !r.player && r.tg?.playerId === l.playerId);
        if (existing) { existing.dc = l; if (!existing.playerName) existing.playerName = name; }
        else out.push({ player: null, playerName: name, dc: l });
      }
    }
    return out;
  }, [players, tgLinks, dcLinks]);

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter(r => {
      if (ql && !r.playerName.toLowerCase().includes(ql)) return false;
      const linked = !!(r.tg || r.dc);
      if (filter === 'linked') return linked;
      if (filter === 'unlinked') return !linked;
      return true;
    });
  }, [rows, filter, q]);

  const counts = useMemo(() => ({
    tg: rows.filter(r => r.tg).length,
    dc: rows.filter(r => r.dc).length,
    none: rows.filter(r => r.player && !r.tg && !r.dc).length,
    orphan: rows.filter(r => !r.player).length
  }), [rows]);

  const unbindTg = async (l: TgLink) => {
    if (!await confirm(t(`Отвязать Телеграм у «${l.playerName}»?`))) return;
    if (await api.unbindTgLink(editKey, l.telegramId)) { toast(t('Отвязано.'), 'success'); load(); }
    else toast(t('Не удалось отвязать.'), 'error');
  };
  const unbindDc = async (l: DiscordLink) => {
    if (!await confirm(t(`Отвязать Discord у «${l.playerName || l.lastPlayerName || l.discordId}»?`))) return;
    if (await api.unbindDiscordLink(editKey, l.discordId)) { toast(t('Отвязано.'), 'success'); load(); }
    else toast(t('Не удалось отвязать.'), 'error');
  };

  // Перенацелить привязку на другую карточку. Единственный способ обслужить случай
  // «офицер удалил игрока и завёл его заново руками»: это новая карточка с новым
  // номером, и связать её со старым аккаунтом может только человек.
  const rebindDc = async (l: DiscordLink, playerId: string) => {
    if (!playerId) return;
    const err = await api.rebindDiscordLink(editKey, l.discordId, playerId);
    if (err) return toast(err, 'error');
    toast(t('Привязка перенесена.'), 'success');
    load();
  };

  const loading = tgLinks === null || dcLinks === null;

  return (
    // Плоский раздел, как и остальные на странице интеграций: карточка внутри
    // обведённой группы давала вторую обводку вокруг той же самой вещи.
    <section className="min-w-0 border-t border-slate-800 pt-5">
      <div className="flex items-center gap-3 flex-wrap">
        <i className="fa-solid fa-link text-slate-500 text-sm"></i>
        <h3 className="cinzel text-lg font-semibold text-slate-200">{t('Кто к чему подключён')}</h3>
        {!loading && (
          <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
            <span><i className="fa-brands fa-telegram text-sky-500 mr-1"></i>{counts.tg}</span>
            <span><i className="fa-brands fa-discord text-indigo-400 mr-1"></i>{counts.dc}</span>
            <span title={t('никуда не привязаны')}><i className="fa-solid fa-user-slash mr-1"></i>{counts.none}</span>
          </span>
        )}
      </div>
      <p className="text-xs text-slate-400 mt-1">
        {t('Логины и ссылки на профили видны только офицерам.')}
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={t('Поиск по нику…')}
            className="flex-1 min-w-[160px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-600"
          />
          <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
            {([['all', 'Все'], ['linked', 'Привязаны'], ['unlinked', 'Без привязки']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setFilter(v)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${filter === v ? 'bg-indigo-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-slate-500 text-sm py-4 text-center"><i className="fa-solid fa-spinner fa-spin mr-2"></i>{t('Загрузка…')}</p>
        ) : shown.length === 0 ? (
          <p className="text-slate-600 text-sm py-4 text-center">{t('Никого не нашлось')}</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto custom-scrollbar -mx-1 px-1">
            <table className="w-full text-sm">
              <tbody>
                {shown.map((r, i) => (
                  <tr key={(r.player?.id || r.playerName) + i} className="border-b border-slate-800/50 last:border-0">
                    <td className="py-2 pr-2">
                      <span className={r.player ? 'text-slate-200' : 'text-slate-500 line-through'}>{r.playerName}</span>
                      {!r.player && (
                        <span className="ml-2 text-xs text-amber-500/80" title={t('Игрока нет в составе — привязка висит впустую')}>
                          {t('нет в составе')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 w-[46%]">
                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {r.tg ? (
                          <span className="inline-flex items-center gap-1.5 bg-sky-950/40 border border-sky-800/50 rounded-lg pl-2 pr-1 py-0.5">
                            <i className="fa-brands fa-telegram text-sky-400 text-xs"></i>
                            <a
                              href={`tg://user?id=${r.tg.telegramId}`}
                              className="text-[11px] text-sky-300 hover:underline font-mono"
                              title={t('Открыть профиль в Телеграме')}
                            >
                              {r.tg.telegramId}
                            </a>
                            <button
                              onClick={() => unbindTg(r.tg!)}
                              className="w-5 h-5 rounded-lg flex items-center justify-center text-slate-600 hover:text-red-400 transition-colors"
                              title={t('Отвязать')}
                            >
                              <i className="fa-solid fa-xmark text-[11px]"></i>
                            </button>
                          </span>
                        ) : null}
                        {r.dc ? (
                          <span className="inline-flex items-center gap-1.5 bg-indigo-950/40 border border-indigo-800/50 rounded-lg pl-2 pr-1 py-0.5">
                            <i className="fa-brands fa-discord text-indigo-400 text-xs"></i>
                            <a
                              href={`https://discord.com/users/${r.dc.discordId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] text-indigo-300 hover:underline font-mono"
                              title={t('Открыть профиль в Discord')}
                            >
                              {r.dc.discordId}
                            </a>
                            <button
                              onClick={() => unbindDc(r.dc!)}
                              className="w-5 h-5 rounded-lg flex items-center justify-center text-slate-600 hover:text-red-400 transition-colors"
                              title={t('Отвязать')}
                            >
                              <i className="fa-solid fa-xmark text-[11px]"></i>
                            </button>
                          </span>
                        ) : null}
                        {/* Висячую Discord-привязку можно перенацелить на живую
                            карточку — тогда человеку не придётся регистрироваться заново. */}
                        {!r.player && r.dc && (
                          <select
                            defaultValue="" onChange={e => rebindDc(r.dc!, e.target.value)}
                            className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] outline-none focus:border-indigo-600"
                          >
                            <option value="">{t('привязать к…')}</option>
                            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        {!r.tg && !r.dc && (
                          <span className="text-[11px] text-slate-700">{t('Нет привязок')}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {counts.orphan > 0 && (
          <p className="text-[11px] text-amber-500/80">
            <i className="fa-solid fa-triangle-exclamation mr-1"></i>
            {t(`Висячих привязок: ${counts.orphan}. Игроков удалили из состава, а привязка осталась — она занимает аккаунт.`)}
          </p>
        )}
      </div>
    </section>
  );
};

export default LinksPanel;
