# Architecture: how the code is built and what not to break

Code comments and commit messages in this repo are in **Russian**; keep that convention.
The UI is bilingual (see Localization below).

## Run it locally

```bash
npm install
EDIT_PASSWORD=dev node server/index.mjs   # API + static on :3001, data in server/data/
npm run dev                                # Vite on :3000, proxies /api to :3001
npm test                                   # node --test tests/*.test.mjs, no network needed
npx tsc --noEmit                           # type check (server .mjs files are not covered)
npm run build                              # must pass before shipping
```

Officer mode locally: open `http://localhost:3000/#admin`, password `dev`.

## Shape of the system

- **Frontend** — React 19 + TypeScript + Vite + Tailwind, everything in the repo root
  (`App.tsx`, `components/`, `services/`, `types.ts`, `constants.tsx`). Game images are
  imported from `assets/` through `images.ts` and bundled by Vite.
- **Backend** — `server/index.mjs`, plain Node (no npm dependencies at runtime). Serves
  `dist/`, the JSON API under `/api/*`, and Server-Sent Events for live updates.
- **Storage** — JSON files in `DATA_DIR`, written atomically (temp file + rename). The
  whole guild state is loaded in memory; there is exactly one server process.
- **Live sync** — every change goes `PUT /api/state` → server saves → broadcasts over SSE
  → all open tabs re-render.

### Environment variables (server)

| Var | Meaning |
|---|---|
| `EDIT_PASSWORD` | Officer password (required on first start; later `auth.json` wins) |
| `PORT` / `HOST` | Listen address; production uses `3001` / `127.0.0.1` |
| `DATA_DIR` | Data folder (default `server/data`) |
| `STATIC_DIR` | Built frontend (default `dist`) |
| `TELEGRAM_SITE_URL` | Public site URL used in Telegram messages |
| `TELEGRAM_BOT_TOKEN`, `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_REFRESH_TOKEN_UPLOAD` | Optional seeds on first start only; normally set from the Integrations tab |
| `OFFICER_TTL_MS`, `TG_API_BASE` | Tuning / tests |

### Data files (`DATA_DIR`)

| File | Contents |
|---|---|
| `state.json` | Players, sessions (events **and** line-up templates), map strategies |
| `lineups.json` | History of past line-ups, feeds auto-fill |
| `auth.json` | Officer password if changed on the site |
| `session.key` | Secret that signs login cookies |
| `lifecycle.json` | Per event type: when sign-ups close, when announcements are deleted |
| `links.json` | Links between players and messenger accounts |
| `discordconfig.json`, `discordlinks.json`, `discord_messages.json`, `discord_subs.json`, `discord_dms.json` | Discord bot config, account links, posted announcements, DM subscriptions and sent reminders |
| `tgconfig.json`, `tg_messages.json`, `tg_subs.json`, `tg_dms.json` | Same for Telegram |
| `ytconfig.json`, `ytthumb.json`, `ytthumb_bg` | YouTube keys, thumbnail style and background |

## Code map

Server (`server/`):

| File | Role |
|---|---|
| `index.mjs` | HTTP routes, auth and lockout, SSE, static files, wiring of all modules |
| `session.mjs` | Signed "who are you" cookie, Discord login helpers |
| `discord.mjs`, `discord_embed.mjs`, `botlang.mjs` | Discord bot over HTTP interactions (no gateway): announcements, buttons, registration, DMs; message layout; bot language |
| `telegram.mjs` | Telegram bot over long polling |
| `msgsync.mjs`, `coalesce.mjs` | Re-render already posted messages; debounce bursts of edits |
| `lifecycle.mjs` | Single source of truth for event deadlines |
| `timings.mjs` | Jungle/boss plan by minute of the fight |
| `autofill.mjs` | Line-up auto-fill from history |
| `away.mjs` | Player unavailability (vacation etc.) |
| `nickmatch.mjs` | Fuzzy nickname search for self-registration |
| `youtube.mjs`, `ytmeta.mjs` | Short-lived upload tokens and playlists; title rules |

Frontend: `App.tsx` (tabs, officer login, top bar), `components/WarPlanner.tsx` (war
room board), `components/BattleMap.tsx` (map editor), `components/EventsPanel.tsx`,
`components/MemberManager.tsx` (roster), `components/TimingsBoard.tsx`,
`components/BattleOrderExport.tsx` (order images), `components/DiscordSettings.tsx`
(Integrations tab), `components/GvgUploader.tsx` / `GvgGallery.tsx` (YouTube),
`services/api.ts` (all API calls), `services/i18n.tsx` (translations),
`services/transfer.ts` (selective export/import).

## Rules that are easy to break

1. **`sessions` holds both events and line-up templates.** An event is a session with an
   `event` field; without it, it is a template. Almost every loop over `sessions` must
   filter by `!!s.event`. Deleting a "template" can delete an event with its sign-ups and
   messenger announcements.
2. **`signups` is `Record<playerId, status>` and many files depend on that shape.** Source
   and time of a sign-up live in a separate `signupMeta: Record<playerId, {from, at}>`.
   Do not change the shape of `signups`.
3. **Silent saves.** `PUT /api/state` with `silent: true` must not touch the bots. Import
   and undo use it; otherwise restored past events get re-announced, and undo deletes
   live announcements.
4. **Both bots refresh together.** A bot that accepted a sign-up calls
   `broadcastState(state, sessionId)`; `onBotStateChange` in `index.mjs` pushes SSE and
   re-renders the announcement in Discord **and** Telegram. Without `sessionId` the other
   messenger never sees the sign-up.
5. **External services must never take the site down.** Route handlers are wrapped so an
   exception becomes a 500, not a crash. `dapi` (Discord) and `tg` (Telegram) return
   failures instead of throwing. Telegram must stay optional.
6. **Timings go through `server/timings.mjs`.** Read plans only via `readPlan` (it
   migrates old line-ups); edit only via its operations (they enforce mutually exclusive
   camps). Never touch `session.timings` directly.
7. **Event deadlines come from `lifecycle.mjs` only** — never hard-code minutes.
8. **Dead SSE connections must be cleaned up on failed pings**, not only on
   `req.on('close')`, or the "who is online" list fills with ghosts.
9. **Line endings are LF** (`.gitattributes`); `install.sh` with CRLF fails on Linux.

## Localization

`services/i18n.tsx`: the translation key is the **Russian string itself**; with `en`
selected the `EN` dictionary is used, missing keys fall back to Russian. Wrap new UI text
in `t('…')` and add the English line to `EN`. A duplicate key is a TypeScript compile
error (`TS1117`) — search before adding. Labels from `constants.tsx` are translated by a
`Proxy` and need no `t()`. Data created by the app (for example the default map
strategy name) is stored in Russian, so display code may need to translate it.

## Shipping a change

1. `npm test`, `npx tsc --noEmit` and `npm run build` pass; for UI changes, also look at
   the result in a browser — server tests can't catch a client that never sends a request.
2. Commit to `main` and push.
3. Servers get it when their owner re-runs the installer and picks "update"
   (or `WWM_ACTION=update`). There is no auto-update.
