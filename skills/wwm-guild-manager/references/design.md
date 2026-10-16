# Design system and layout rules

Read this before adding or restyling any UI. The site went through a deliberate redesign
to stop looking machine-generated; new screens must follow the same closed set of tokens
or they will look foreign immediately.

**Leading principle: the interface is quiet by default and loud only where the data is.**
This is a tool people look at during a fight, not a showcase. Almost everything that
looked "generated" came down to one thing: every element shouted equally loudly (bold
everywhere, caps everywhere, accent on everything) and no value matched its neighbour.

## Surfaces and borders

The `slate` scale is **overridden** in `tailwind.config.js`: the stock bluish grey is
replaced by a neutral warm one ("ink and paper") so it doesn't fight the amber accent.
Class names are unchanged, so a repaint touches the whole app at once. The `body`
background (`index.css`) must equal `slate-950`, otherwise cards look pasted onto a
different colour.

| Role | Class |
|---|---|
| Input, deepest background, page | `bg-slate-950` `#0b0b0b` |
| Card, section | `bg-slate-900` `#131211` |
| Raised element, chip | `bg-slate-800` `#1e1c1a` |
| Default border | `border-slate-800` |
| Hover / emphasised border | `border-slate-700` |
| Main text | `text-slate-200` |
| Secondary text, field labels | `text-slate-400` |
| Muted, disabled | `text-slate-500` |

## Semantic colours — a closed set of seven families

| Colour | Meaning |
|---|---|
| `slate` | everything neutral |
| `amber` | brand, officer mode, default action, practice, chicken, **tank** |
| `red` | attack, danger, irreversible |
| `sky` | defense, Telegram, tower duty, "substitute", **DPS** |
| `emerald` | success, "connected", jungle, healer, "in" |
| `indigo` | Discord |
| `fuchsia` | third accent: league and boss |

- Role colours are **taken from the game's role icons** (`assets/tank|dps|healer.png`:
  tank `#edd39b`, DPS `#83e2f1`, healer `#a1edb8` → amber, sky, emerald). They are
  duplicated in four places and must change together: `ROLE_COLORS` (`constants.tsx`),
  `ROLE_RING`/`ROLE_DOT` (`BattleMap.tsx`), the counter tiles (`WarPlanner.tsx`) and
  `BattleOrderExport.tsx` (hex values there, because html-to-image does not see external
  stylesheets).
- `blue`, `green`, `cyan`, `orange` are **forbidden**: next to sky/emerald/amber they
  differ so little they read as a mistake.
- Lanes (top/mid/bot) are **not** colour-coded — there is always a word next to them,
  and colour in that spot is already taken by the side.
- Event type colours live in `EVENT_TYPE_STYLES` (`constants.tsx`); don't invent new ones.

## Icons: stock for verbs, own glyphs for the game

- **Font Awesome for interface verbs** (close, plus, trash, undo, upload). They should be
  invisible and identical everywhere.
- **Own glyphs (`components/glyphs.tsx`) for game concepts**: boss, tower, jungle,
  practice, ranked, league. Stock icons used to stand in (a random dragon, an
  observatory tower, a podium that from afar looked like a rude gesture) — the UI spoke
  about this game in the words of someone else's catalogue.
- **Don't swap the icon set wholesale** (e.g. to Lucide): it is itself the default of
  starter templates and AI tools now — one template for another.

How the glyphs are drawn (keep it this way when adding one):

- Traced from the **map markers** (`assets/boss.png`, `tower_blue.png`, `tree_blue.png`),
  so a badge and a map marker read as the same concept.
- **Filled, not outlined** — the map markers are filled.
- **Inline SVG**, coloured with `currentColor`, sized by a class from outside;
  `align-[-0.125em]` puts it on the same baseline an `<i>` icon had.
- **Each glyph has its own viewBox fitted to the drawing's real bounds** (`BOXES`,
  computed with `getBBox` by a script, not by eye). A shared `0 0 24 24` makes some
  glyphs look 1.5× smaller than others. Default size `1.05em` — measured so the glyph's
  height-to-font-size ratio matches Font Awesome.
- **Optical weight beats geometric weight** (the tree trunk is deliberately thicker).
- **Check at 12 and 16 px**, not 48 — earlier attempts fell apart exactly there.
- The battle-order image still uses emoji (♛ 📣 🔔) because Font Awesome classes don't
  survive html-to-image; inline glyphs would work there and are the obvious next step.

## Typography

- `Inter` for the whole interface. `Alice` (class `.cinzel`, the name is historical) only
  for section titles. Cinzel was removed because it has no Cyrillic. Never stretch the
  title face with caps and letter-spacing — "serif + CAPS + tracking" reads as a template.

| Purpose | Class |
|---|---|
| Section title | `text-2xl` |
| Subtitle | `text-lg` |
| Body | `text-sm` |
| Secondary text, field label | `text-xs` |
| Small caps rubric (`uppercase tracking-widest`) | `text-[11px]` |

- **No new bracketed sizes.** The only size below `text-xs` is `text-[11px]`; the only
  tracking is `tracking-widest`.
- **Weight:** `font-semibold` for titles and actions — it is the top weight, never use
  `font-bold` (there used to be 183 of them, and no hierarchy at all). Labels, badges and
  helper text have **no weight class**.
- **CAPS only for section rubrics**, a handful per screen. A field label is
  `text-xs text-slate-400` in normal case — seven caps labels in a row is the signature
  of a generated admin panel.
- Times and counters use tabular numbers (`tnum`).

## Spacing, radii, motion, decoration

- Spacing scale `1 2 3 4 6 8` (4/8/12/16/24/32 px). No half steps (`0.5`, `2.5`, `3.5`)
  in new code.
- Radii: `rounded-lg` by default (buttons, inputs, chips, panels), `rounded-2xl` for big
  cards and modals, `rounded-full` for pills and dots. Nothing else.
- Motion only signals a state change. Forbidden: content sliding in on tab switch,
  `animate-in` on static blocks, `transition-all` (use `transition-colors`; the only
  exception is the `grid-template-rows` expand trick). One duration: `duration-200`.
  `prefers-reduced-motion` is handled globally in `index.css`.
- Shadows on a dark background read as dirt, not depth: depth comes from the border and
  the surface step. Forbidden: gradients in panel/modal headers, coloured glows
  (`shadow-<colour>`), `shadow-2xl`, `backdrop-blur` with nothing underneath. The only
  decorative layer is a faint vignette on `body`.

## Width: use all of it

Pages use the **full available width**. Do not cap with `max-w-*` and centre a narrow
column — it is a working tool, and vertical scrolling is what must be reduced. The
maintainer has asked for this repeatedly and strongly.

Multi-block pages (e.g. Integrations) use **newspaper columns**, not a grid:
`lg:columns-2 2xl:columns-3` with `break-inside-avoid` on children (`COLUMNS` in
`components/DiscordSettings.tsx`). A `grid-cols-*` aligns rows to the tallest block and
leaves a hole under short ones; columns flow and a hidden block takes no space.

Check layouts by rendering at **1760, 1280 and 820 px**, not by eye.

## Layout traps

- `space-y-*` adds `margin-top` to every child except the first — including
  `position: fixed` ones. A full-screen overlay inside such a container is shifted down
  by the gap. Keep overlays outside (`createPortal` to `document.body`, as in
  `WarPlanner.tsx`).
- Grid/flex children don't shrink below their content without `min-w-0`; a wide table
  then pushes a horizontal scrollbar onto the whole page.
- `overflow-hidden` on a card clips dropdowns inside it.
- Dropdowns open upwards when there is little room below (`useFlipUp`).
- The header nav is centred with `flex-1` side blocks, not `justify-between` — otherwise
  it shifts when a viewer has no officer buttons.
- **Nothing should change layout on mouse movement.** Controls that appear on hover and
  push neighbours aside caused accidental edits in the timings table. Reserve the space
  (`w-4`) and only fade the control in.

## Maintainer preferences (learned the hard way)

- **No waiting on the user's path.** Designs where a click waits for Discord or another
  external service are rejected; prefer in-memory caches, background refresh, push over
  pull. A manual "resync" button is acceptable only as a supplement to automation. If
  every option involves waiting, keep looking (docs, the web) instead of picking the
  least bad one.
- An explicit extra step is fine when it is amortised over a group (e.g. the "pick
  timings" modal works on a whole group at once).
- **Battle-order images use words, not schematics.** Two attempts to replace lane names
  with mini-maps or arrows were rejected: reading one word is faster than decoding a
  picture, and an order has dozens of them. Don't propose graphic encoding again unless
  asked.
- Use the word **"timings"** for jungle/boss minutes, not "ticks".
