# Features: how each one works and why

Each section explains the model, the decisions that are not obvious from the code, and
alternatives that were tried and rejected. Read the section for the feature you are
about to change. Code comments (in Russian) repeat many of these points next to the code.

## Game rules the model is built on

These come from Where Winds Meet itself and cannot be derived from the code:

- 30v30 guild war. Each side splits into **Attack (15)** and **Defense (15)**, each into
  **three groups of five**, each group on a lane (top / mid / bot). Attack goes for the
  enemy tower on its lane, defense holds the own tower.
- Jungle creeps spawn at minutes **25, 20, 15, 10 and 5**, plus the opening when camps
  are taken for the first time. Four camps: near/far TOP and near/far BOT.
- Bosses spawn "at 25 and 15" — nominally; in practice earlier or later. So a timing is a
  **window, not a point**: one player can take a camp and go to the boss in the same timing.
- A "chicken" is carried to the boss; a "chicken caller" calls it. Attack has no chicken.
- Event types: **practice** (prak), **ranked**, **league**. Sign-up statuses: `in`,
  `maybe`, `sub` (substitute), `out`.

## Events, templates and sign-ups

- `state.sessions` holds **both events and line-up templates**; an event has an `event`
  field (`GuildEventMeta`: type, opponent, `startsAt` ISO instant + `tz` it was entered
  in, note). Filter loops by `!!s.event`. In the UI they are separate (`EventsPanel`,
  `TemplateBar`); in data they are not.
- `signups: Record<playerId, status>` — shape must not change. Source and time are in
  `signupMeta: Record<playerId, {from, at}>`; `at` gives the order numbers in
  announcements and moves only when the status changes (re-tapping the same button does
  not move you down the queue).
- Each viewer sees event times in their **own** time zone; creation has a zone selector.
- Registration closes automatically after the start (`lifecycle.mjs`, per event type,
  configurable on the Integrations tab); the server rejects late `POST /api/signup` with
  409 (officers exempt). Announcement deletion is off by default (`deleteAfterMin: null`).
- `POST /api/signup` lets a viewer write **only their own** sign-up; officers can write
  anyone's.

## War room and auto-fill (`components/WarPlanner.tsx`, `server/autofill.mjs`)

Drag-and-drop board (dnd-kit) of Attack/Defense × groups, a pool of signed-up players with
coloured status dots, role counters.

**Drag and drop details that were bugs once:**
- The floating drag ghost (`position: fixed` in a portal) takes coordinates from the
  window `pointermove`, **not** from dnd-kit's `delta` — `delta` includes scroll
  compensation for the source node, and the ghost flew off by the scrolled distance.
- Drop targets snap only under the cursor or within `SNAP_PX` (24 px). A miss **cancels**
  the drag (the ghost fades and says "release to cancel"); the old `closestCenter`
  fallback always picked something, so there was no way to change your mind. Esc cancels.

**Auto-fill** places players where they usually play, from history:
- History lives in `lineups.json` (archive), because events are deleted weekly and the
  memory would reset. The server writes it on `PUT /api/state` (`archiveSessions`); the
  client cannot send it. Kept separate from `state.json` because state goes to every tab
  over SSE on every sign-up. Archive entries are stripped sessions (no map drawings, no
  sign-ups), same shape as a session so `buildHistory` reads both with one code path.
  Append/overwrite only — safe under `silent: true`. Older than `ARCHIVE_KEEP_DAYS` (180)
  drops out. Templates are not archived.
- Takes only players with status `in`.
- Weight by age, not "last N events" (`HALF_LIFE_DAYS = 28`), share computed **per
  player** so occasional players keep their spot. Templates don't age.
- Three passes: confident players to their spots → the rest into gaps (first where a
  required role is missing) → fix imbalance by swapping the **least confident** player of
  an over-represented role (`ROLE_MINIMUM`: tank 1, healer 1).
- **Already placed players are never moved** — the button means "fill the rest".
- Extra roles are tied to the slot: tower duty only carries over above 50% stability;
  jungle/boss/chicken are learned **per timing**.
- Undo is offered only while the line-up is unchanged since the fill (`filledRef`), so it
  never erases the officer's later edits. Undo restores the timings plan too.
- The frontend imports **the same file** (`allowJs`) — one implementation, under tests.

## Timings: jungle and boss by minute (`server/timings.mjs`, `components/TimingsBoard.tsx`)

The line-up answers "where does the player stand" (one answer per fight); timings answer
"where does the player run" (changes every five minutes). That is why they are a separate
plan and not fields on `WarAssignment`.

- The plan is **cells** keyed `side:timing:spot` (five spots: four camps + boss).
- A cell references **a group** ("Group 1 + two more"), not a snapshot of names: moving a
  player between groups updates the jungle automatically. Swapping groups within a side
  carries the references (`swapGroupRefs`); across sides it does not.
- **A named entry beats a group reference** (the common case: "near TOP: Group 1" and
  "far TOP: <one player from Group 1>"). There is also an explicit `exclude`.
- The chicken belongs to **the task, not the player** (a player can go to a camp without
  it and to the boss with it in the same timing), and only to someone in the cell.
- Camps within a timing are mutually exclusive; boss + camp is allowed.
- **Timing order is never collapsed or reordered.** Merging identical rows was tried: the
  axis stopped going in time order and confused readers. Bulk entry ("25/15/10/5 at
  once") is an explicit action in the "pick timings" modal instead.
- Old line-ups without a plan are unfolded on the fly by `readPlan` from legacy
  `junglePosition`/`bossTime`/`carriesChicken`; the first edit removes the legacy fields.
  Only tower duty stays on the assignment. Always read through `readPlan`, write through
  the module's operations.
- Table design (one side at a time, grouped TOP / BOT / BOSS columns, rows as a single
  band per moment, top-aligned cells, names as text not chips, group references collapsed
  into "Gr.1 (5)" that expands **on click only**, nothing changes layout on hover, chicken
  slot always reserved, bell icon for the chicken caller only in boss cells). Every one
  of these fixed a concrete complaint — don't revert them casually.
- Under the editor sits the same read-only Gantt that goes into the image
  (`TimingsGantt`) — editing there is impossible on purpose (a row belongs to a player,
  a group reference can't be expressed).

## Battle order images (`components/BattleOrderExport.tsx`)

The site is the officer's workbench; **the image is read by fifteen players, each looking
for one line — their own.** Two images per side: **line-up** ("where do I stand") and
**timings** ("what do I do each minute"); one component with a `variant` flag.

- The timings image is a Gantt: a row per player, six columns by minute, one shared time
  axis with gridlines through all rows, the camp name written **inside** the bar. Three
  rejected forms: text in each card (minutes don't separate visually), bars inside each
  card (labels too far from bars), blocks per minute (you must find yourself six times).
  Rule: **a time axis works only when it is single and next to all rows at once.**
- `barsOf` cuts a schedule into **continuous** segments (a bar with a hole would lie);
  column indices come from it, never computed in the component.
- An empty lane row is still drawn ("you go nowhere" is an answer).
- The line-up image has a "Jungle" summary **without time** (`campRoster`, computed via
  `scheduleOf` — never re-implement cell walking). Nicks are coloured by role; the legend
  lists only what is present. An empty plan disables the timings button.
- Words, not schematics — see design.md.
- Images are rendered with html-to-image: colours must be inline hex, no Font Awesome.

## Tactical map (`components/BattleMap.tsx`)

Strategies (`state.mapTemplates`) are independent of events (events are recreated weekly
and a bound map would vanish). Tokens come from the whole roster. Data is in **percent of
the map**; zoom is a pure view transform.

- **Snapping to neighbours is primary, the grid is secondary.** Neighbour targets are
  edges and centres of other zones **plus the neighbour's own size repeated** (`LATTICE`
  = 3 steps each way) — so the first square sets the step for the whole row. Only
  `rect`/`ellipse` produce lattice targets. Threshold `SNAP_PX` = 12 screen px divided by
  zoom. Any edge of the dragged bounding box can snap; the dragged group is excluded from
  targets; a guide line shows what caught it. Snap computation stays outside state
  updaters (they must be pure).
- **Grid steps 1.2 / 2.4 / 4.8 (`GRID_STEPS`) must stay multiples of each other** so zones
  drawn at different steps still align. The step belongs to the map (`MapTemplate.grid`),
  not the user. It is in percent of width; height is converted via the real aspect
  (`stepYof`). The grid is visible only while snapping applies. **Alt inverts** the
  current snap state and disables neighbour snapping; `altHeld` is state (it changes what
  is drawn), listened on window, reset on `blur`.
- Multi-select is a list (`selectedIds`): Shift/Ctrl toggles, rubber band selects
  **touched** shapes, clicking an already selected shape keeps the selection, clicking
  empty space clears it. Ctrl+D duplicates with a one-cell offset and selects the copies.
- Zoom: plain wheel scrolls the page, **Ctrl+wheel zooms the map** (with a hint banner
  that disappears once zoomed), toward the cursor; pan with Space or middle button; pan is
  clamped; editing panels counter-scale (`uiScale = 1 / zoom`). Wheel listener must be
  `{ passive: false }`. The hint timer lives in a ref so effect cleanup can't orphan it.
- Zones have square corners (`rx=0`) and an exact hit area — rounding and padding broke
  docked zones.
- Opening the tab scrolls to the map once; the toolbar is `sticky bottom-3`.
- Canvas libraries (Konva, Fabric, Moveable) were deliberately not used: they would take
  over the interaction layer and kill inline text editing.

## Discord bot (`server/discord.mjs`, `discord_embed.mjs`, `msgsync.mjs`, `coalesce.mjs`)

Modelled after raid-helper. Transport is **HTTP interactions**, no gateway connection.

- The officer enters **only the bot token**; `applicationId` and the public key come from
  `/applications/@me`. No IDs in code or env. The invite link is built in the UI
  (`inviteUrl`) with commented permission bits.
- Signature (Ed25519) is verified on the **raw body bytes** (`readRawBody`) before
  `JSON.parse`. Reply within 3 seconds.
- Response `type: 7` replaces the message the button was on — right for ephemeral steps,
  wrong for a public announcement. `reply()` picks the type; never set it by hand.
- There is no API to check whether Discord accepted the Interactions Endpoint URL;
  `verifySignature` counts calls (`endpoint.lastOkAt`/`failCount`, in memory) and the
  panel shows "Discord has / has never contacted the site".
- Announcements: a routing table **7 days × 3 event types**, each cell lists channels
  (Discord and Telegram topics can share it); empty cell = don't post.
  `MAX_CHANNELS_PER_CELL` exists in both `discord.mjs` and `DiscordSettings.tsx` — change
  together.
- Embed layout in `discord_embed.mjs` (no network, tested): three columns by role, order
  numbers, weapon-school icons uploaded as **application emojis** (they don't use server
  slots; cleared when the token/application changes), extra-role and call-role marks.
  Limits: 25 fields, 1024 chars per field, 6000 per embed. Times use native
  `<t:unix:F|R>` tags; `<@id>` mentions render without pinging; one configured role is
  pinged above the card.
- **Edit coalescing**: both bots edit announcements only through `coalesce.mjs` — thirty
  clicks become one edit. The coalesced function must read fresh state when it runs.
- **Message sync**: each sent message stores a fingerprint of its content
  (`bodyFingerprint`, ignoring the "updated" timestamp). On start and on view-affecting
  settings changes (`viewKey`), messages are rebuilt and edited only if the fingerprint
  differs. Older than a day is skipped (`worthResync`). DMs are never mass-updated (rate
  limits). Error `10008` (message deleted by hand) removes the record.
- DMs: opt-in by the player, a card with the player's own status (no live counters — that
  would be dozens of edits per click), sent on creation plus a reminder to those who
  haven't answered.
- Bot language ru/en (`botlang.mjs`).

### Self-registration "ladder"

The player types a nick, then three steps, with "create a new player" last:
1. **Similar nicks as buttons** (up to 5, best match green).
2. **"I'm not here" → the whole roster** in alphabetical dropdowns.
3. **"I'm new"** → create a card with the typed nick.

Matching (`nickmatch.mjs`, tested) normalises case, diacritics, clan tags and
Cyrillic/Latin look-alike letters, then exact → prefix → contains → Levenshtein. Old
"exact or contains" search created duplicates when people typed a longer nick, used the
other keyboard layout, or made a typo. Discord limits shape the code: 25 options per
select, 5 rows per message, unique `custom_id` (`reg:pick:0…`), so at most four selects
plus the "I'm new" row. Nicks already bound to other accounts are hidden.

### Login with Discord (`server/session.mjs`)

Fixes one hole: without it, anyone with the link could claim any player and change their
sign-ups anonymously. Discord only **confirms identity once**; the site asks for
`identify` and checks guild membership and roles itself with the bot token.

- Off by default (`cfg.loginEnabled`); cannot be enabled without `clientSecret`. With it
  off, everything works as before. `accessMode: 'closed'` additionally hides the site from
  anyone not linked to a roster card (`canView`).
- **Discord is never on the request path.** Identity = cookie signature, nick =
  `discordlinks.json`, officer role = in-memory `officerRoles`. Roles are refreshed on
  page load (`GET /api/session`), by a one-minute background timer only for officers seen
  in the last hour, and by a button. Regular players cost Discord zero requests, so the
  guild can sign up even when Discord is down. A failed Discord call keeps the previous
  answer. One member is fetched (`/guilds/{id}/members/{userId}`), not the list — the
  list needs the privileged `GUILD_MEMBERS` intent.
- The cookie answers only "who are you", lasts a year, no permissions inside; signed with
  `session.key`; no session store.
- Links are never deleted automatically (a momentarily empty roster read would wipe the
  whole guild's registrations). A deleted player's link stays but has no effect. Links
  follow the **card id**, not the nick. Unbinding is the emergency lever; deleting a
  player to revoke access is wrong (it deletes sign-ups and line-ups). Link values are
  either an old plain id string or an object — both read via `pidOf`.
- Two officer doors, combined in `canEdit`: password (`officerOk`) or Discord role. The
  client must check `canEdit`, not the presence of a password — an officer logged in by
  role once edited "into the void" because the save path required both. `putState` sends
  the `Authorization` header only if a key exists.
- `prompt=none` skips the consent screen for returning users; on refusal it retries once
  with consent (`?consent=1`). The redirect URL is built from the request
  (`X-Forwarded-Proto`). Changing the app or disconnecting the bot clears `clientSecret`.
- With login on, presence identity comes from the cookie when connecting to SSE;
  `presence/claim`/`unclaim` return 403.

## Telegram bot (`server/telegram.mjs`)

Long polling — no HTTPS needed. Optional by design: never make Telegram required.

- The Bot API cannot list forum topics, so routing is set by commands **inside** the
  topic: `/setprac`, `/setranked`, `/setleague` (optional name), `/unsetprac…`, `/where`,
  `/sithere` (default topic), `/forgethere`. They write the same `routes` table as
  Discord.
- `tg_messages.json`/`discord_messages.json` store an **array** of messages per event; the
  old single-object form is unfolded on read — keep it readable.
- Players bind their account in a DM with the bot; officers can unbind
  (`/api/tglinks`).
- **Known limitation:** Telegram messages are Russian-only (the original guild's Russian
  half used Telegram). Making it follow `botlang.mjs` would be a welcome change.

## Live sync, presence, silent saves

- `PUT /api/state` saves and broadcasts over SSE (`GET /api/events`). Bot-originated
  changes go through `broadcastState(state, sessionId)` → `onBotStateChange`, which also
  re-renders the announcement in **both** messengers.
- `silent: true` skips the bots entirely — used by backup import and undo, otherwise
  restored past events would be re-announced and undo would delete live announcements.
- Dead SSE connections must clean themselves up: the 25-second ping checks
  `res.destroyed`/`socket.destroyed`/`writable` and a failed write triggers `drop`;
  `res.on('error')` and `req.on('error')` are subscribed; TCP keep-alive is on. `drop` is
  guarded by a flag. Test with an abrupt disconnect (RST), not by closing a tab.

## Backup export / import (`services/transfer.ts`, `components/TransferPanel.tsx`)

- Officer-only. Export is **strictly what is ticked** (no auto-adding players — sharing a
  strategy with an allied guild must not ship the roster); a warning offers to add them.
- **Import never deletes.** "Replace" overwrites matching ids and keeps the rest. The
  only destructive operation is "full rollback" in a separate danger zone.
- Players match by id; same nick with a different id asks "merge / two different"
  (default merge) and re-points assignments, sign-ups and map positions.
- Import is silent (see above). A snapshot is downloaded before applying, and the toast
  offers undo for 30 seconds.
- File format v2.1 with a `contents` field; v2.0 and v1 (map inside sessions) still read.

## Player unavailability (`server/away.mjs`)

`Player.unavailable = { since, note?, until? }`. "Away now" is **computed** from `until`
(`isAway`), never stored, so it expires by itself. The field is labelled "returns on".
Marking a player sets `out` on future events in the range and removes them from event
assignments (`!!s.event` only — templates are untouched); there is no undo, and the
dialog warns about it. Self or officer, same pure function on both paths.
`MemberManager`'s form rebuilds the player from listed fields, so `unavailable` is
threaded through it.

**Known limitation:** the return date ends at midnight **Moscow time** (`GUILD_TZ` in
`away.mjs`), a leftover from the original guild. A per-site time zone setting would be
the proper fix.

## GvG recordings on YouTube (`server/youtube.mjs`, `ytmeta.mjs`, `services/ytupload.ts`)

Pages `#upload` and `#records`, reachable from header icons, only for players linked to
the roster.

- **Video never passes through the server**: the browser uploads directly to Google
  (resumable upload); the server issues a short-lived token and files the video into a
  playlist. A VPS disk and bandwidth could not take gigabyte clips.
- Two Google keys: full scope for the server (playlists), and a separately granted
  **upload-only** key for browsers (Google cannot narrow an existing refresh token —
  `invalid_scope`). Without it the panel warns that browsers get full access.
- Playlist = the uploader's in-game nick, taken from the cookie by the server.
- Opponent is set **per recording**; titles are built by `buildTitle` and parsed back by
  `parseTitle` (gallery filters depend on it) — no free-form title tail.
- Privacy changes apply to the playlist **and** its videos together.
- Thumbnails are drawn in the browser on canvas (`ytthumb.ts`); guild name, colours and
  background live in data. The upload queue shows a frame from the file itself
  (`videoframe.ts`, a quarter into the clip, without reading the whole file).
- Gallery (`GET /api/yt/gallery`) reads the channel's **uploads list**, not every
  playlist (quota), cached 10 minutes per guild, re-checked through `videos.list` in
  batches of 50 (`ID_BATCH`) to drop deleted videos. Player embeds use a facade (preview
  first, one iframe on click). Filters offer only values that exist.
- Age restriction cannot be removed via API; such tiles link to YouTube and officers see
  how to fix it in Studio. `status.embeddable: true` is set explicitly on upload.

## Localization

Russian strings are the translation keys (`services/i18n.tsx`, `EN` dictionary, missing
keys fall back to Russian; duplicate keys fail compilation with TS1117). Labels from
`constants.tsx` are translated through a `Proxy`. Data created by the app is stored in
Russian (e.g. the default map strategy "Базовая"), so display code may need `t()` on it.
The HTML `<title>` and link preview are Russian regardless of UI language — a known gap.
