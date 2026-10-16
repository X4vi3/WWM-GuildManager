
import { Player, GuildWarSession, MapTemplate } from '../types';

// Локальный кэш состояния (фолбэк, когда бэкенд недоступен). Файлы бэкапов —
// экспорт/импорт с выбором — живут в services/transfer.ts.

const PLAYERS_KEY = 'wmgs_players';
const SESSIONS_KEY = 'wmgs_sessions';
const MAPS_KEY = 'wmgs_maps';

export const storageService = {
  getPlayers: (): Player[] => {
    const data = localStorage.getItem(PLAYERS_KEY);
    return data ? JSON.parse(data) : [];
  },
  savePlayers: (players: Player[]) => {
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
  },
  getSessions: (): GuildWarSession[] => {
    const data = localStorage.getItem(SESSIONS_KEY);
    return data ? JSON.parse(data) : [];
  },
  saveSessions: (sessions: GuildWarSession[]) => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  },
  // Стратегии карты (рисунки/объекты/текст/позиции) — отдельная коллекция
  getMapTemplates: (): MapTemplate[] => {
    const data = localStorage.getItem(MAPS_KEY);
    return data ? JSON.parse(data) : [];
  },
  saveMapTemplates: (maps: MapTemplate[]) => {
    localStorage.setItem(MAPS_KEY, JSON.stringify(maps));
  }
};
