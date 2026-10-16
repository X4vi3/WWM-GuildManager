# HTTP API

All routes live in `server/index.mjs` (search for `pathname === '/api/...'`). JSON in and
out unless noted. The frontend calls them through `services/api.ts`.

**Who may call:**

- **public** — anyone;
- **viewer** — anyone, unless Discord login is on with `accessMode: 'closed'`, then only
  players linked to a roster card (`canView`);
- **self/officer** — a player for themselves, an officer for anyone;
- **uploader** — a player linked to the roster (`uploaderNick`), for YouTube;
- **officer** — `canEdit`: the officer password as `Authorization: Bearer <base64 of
  password>`, or a Discord login with the officer role.

Failed password attempts are rate-limited per IP: 8 failures in 15 minutes → 10-minute
block (in memory; a restart clears it).

## State and live updates

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/state` | viewer | Whole guild state (players, sessions, map strategies) |
| PUT | `/api/state` | officer | Save the whole state; `silent: true` skips the bots. Also archives line-ups |
| GET | `/api/events` | viewer | Server-Sent Events: `state`, presence, `lifecycle`, `authrevoked`… |
| GET | `/api/lineups` | viewer | Line-up archive for auto-fill (fetched on button press) |
| POST | `/api/presence/claim` | public | "This is me" — only when Discord login is off (403 otherwise) |
| POST | `/api/presence/unclaim` | public | Undo the claim (same rule) |
| POST | `/api/signup` | self/officer | Set a sign-up status for an event; 409 when registration is closed |
| POST | `/api/unavailable` | self/officer | Mark a player away / back |
| GET | `/api/lifecycle` | public | When registration closes / announcements are deleted, per event type |
| PUT | `/api/lifecycle` | officer | Change those deadlines |

## Officer login and sessions

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/auth` | public | Check the officer password |
| POST | `/api/auth/change` | officer | Change the password (stored in `auth.json`); broadcasts `authrevoked` |
| GET | `/api/session` | public | Who am I and what may I do (refreshes the officer role from Discord) |
| GET | `/api/auth/discord/login` | public | Start Discord OAuth |
| GET | `/api/auth/discord/callback` | public | Discord OAuth return; sets the identity cookie |
| POST | `/api/auth/logout` | public | Clear the cookie |

## Discord

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/discord/interactions` | Discord (signed) | Buttons, selects, modals; Ed25519 check on raw body |
| GET | `/api/discord/config` | officer | Bot status and settings (secrets only as hints) |
| PUT | `/api/discord/config` | officer | Token, routing table, roles, language, login settings |
| POST | `/api/discord/secret` | officer | Set the OAuth client secret (never returned) |
| POST | `/api/discord/emojis` | officer | Upload weapon-school icons as application emojis (images sent by the browser) |
| POST | `/api/discord/register-message` | officer | Post or update the registration button message |
| GET | `/api/discord/links` | officer | Discord account ↔ player links |
| POST | `/api/discord/links/unbind` | officer | Remove a link |
| POST | `/api/discord/links/rebind` | officer | Point a link to another player card |
| POST | `/api/discord/refresh` | officer | Re-read roles and channels from Discord |
| GET | `/api/discord/guilds` | officer | Servers the bot is in |
| GET | `/api/discord/channels` | officer | Channels of the chosen server |
| GET | `/api/discord/roles` | officer | Roles of the chosen server |

## Telegram

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/tgconfig` | officer | Bot status and routing |
| PUT | `/api/tgconfig` | officer | Token and settings |
| GET | `/api/tglinks` | officer | Telegram account ↔ player links |
| POST | `/api/tglinks/unbind` | officer | Remove a link |

## YouTube

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/yt/setup` | officer | Whether keys are set (hints only) |
| POST | `/api/yt/keys` | officer | Set the Google OAuth client id/secret |
| GET | `/api/yt/connect` | officer | Start Google consent (full scope, then upload-only) |
| GET | `/api/yt/callback` | public | Google OAuth return |
| POST | `/api/yt/disconnect` | officer | Forget the channel keys |
| GET | `/api/yt/status` | uploader | Can I upload, my playlist |
| POST | `/api/yt/token` | uploader | Short-lived browser token for a direct upload |
| POST | `/api/yt/attach` | uploader | Put an uploaded video into the uploader's playlist |
| POST | `/api/yt/privacy` | uploader | Change visibility of a playlist together with its videos |
| GET | `/api/yt/gallery` | uploader | Channel recordings (cached 10 min; `?force=1` for officers) |
| PUT | `/api/yt/thumb` | officer | Thumbnail style: guild name, colours |
| GET | `/api/yt/thumb/bg` | public | Thumbnail background image |
| POST | `/api/yt/thumb/bg` | officer | Upload the background (data URI from the browser) |

## Everything else

Any other path is served from `STATIC_DIR` (the built frontend) with an `index.html`
fallback for client-side routes. Hashed files under `/assets/` are cached long-term.
Unhandled errors in a route return 500 instead of crashing the process.
