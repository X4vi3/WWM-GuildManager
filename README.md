# WWM Guild Manager

A self-hosted guild headquarters for **Where Winds Meet**: the roster, weekly events with sign-ups, the 30v30 guild war plan and a tactical map — in one place, shared live with the whole guild.

[Русская версия](README.ru.md)

![War room](screenshots/war-room.webp)

## Features

- **Guild roster** — role (tank / healer / DPS), two weapon schools, shotcaller and raid-leader marks, vacation status.
- **Events and sign-ups** — practices, ranked and league matches. Members sign themselves up: in, maybe or substitute.
- **War room** — 30 fighters split into Attack and Defense, three groups of five each, with lanes and towers. Auto-fill places people where they usually play, based on previous wars.
- **Jungle and boss timings** — who goes where at each minute of the fight.
- **Battle order** — the line-up and timings exported as images to post in Discord.
- **Tactical map** — the line-up on the fortress map, with arrows, zones and notes; several strategies per event.
- **Discord bot** — event announcements with sign-up buttons, member registration, reminders in DMs, login to the site with a Discord account.
- **Telegram bot** — the same announcements and sign-ups for guilds that live in Telegram.
- **GvG recordings** — members upload match videos to the guild's YouTube channel straight from the site; a gallery collects them.
- **Live sync** — everyone sees changes instantly, no page reload.
- **English and Russian** interface, switchable at any time.

| Roster | Events |
|---|---|
| ![Roster](screenshots/roster.webp) | ![Events](screenshots/events.webp) |

![Map](screenshots/map.webp)

## Installation

You need a server (VPS) with **Ubuntu 22.04+ or Debian 12**, at least **1 GB of RAM** and root access. The cheapest plan of any hosting provider is enough. A domain is optional.

Connect to the server over SSH and run one command:

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh | sudo bash
```

The installer asks three questions:

1. **Language** of the installer.
2. **How the site will be reached:**
   - a free address like `203-0-113-7.sslip.io` — HTTPS and everything works right away (the default);
   - your own domain — create an A record pointing to the server's IP first;
   - no domain, plain `http://` by IP — the Discord bot, Discord login, YouTube uploads and copying images to the clipboard will not work.
3. **Officer password** — press Enter and a random one is generated.

A couple of minutes later it prints the link to the site and the officer password. Everything else — Node.js, the Caddy web server, HTTPS certificates, the system service — is set up automatically.

### After installation

- The regular link opens the site for the guild. **Officers** open `https://your-site/#admin` and enter the password to start editing.
- The password can be changed on the site (key icon in the top bar).
- Bots and YouTube are set up on the **Integrations** tab, no server access needed. Step-by-step Discord guide: [docs/discord-setup.ru.md](docs/discord-setup.ru.md) (in Russian).

### Updating, changing the domain, resetting the password

Run the same command again. It opens a menu:

```
1) Update to the latest version
2) Change the domain
3) Reset the officer password
```

Guild data is kept during all of these.

### Backups

All guild data lives in one folder: `/var/lib/wwm`. To back it up, copy the folder; to restore, put it back and run `chown -R wwm:wwm /var/lib/wwm && systemctl restart wwm`. The site also has export and import of the roster and events (arrow icons in the top bar).

### If something goes wrong

| Problem | What to do |
|---|---|
| The site doesn't open | `systemctl status wwm` and `journalctl -u wwm -n 50` |
| HTTPS doesn't work | Check that the domain's A record points to the server; Caddy keeps retrying by itself. Log: `journalctl -u caddy -n 50` |
| "Ports 80/443 are already used" | Another web server (nginx, apache) is running. Stop it or use a separate server |
| Forgot the officer password | Run the install command again → "Reset the officer password" |

Unattended installation (for scripts):

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh \
  | sudo WWM_LANG=en WWM_ACTION=install WWM_DOMAIN=guild.example.com WWM_PASSWORD=change-me bash
```

`WWM_DOMAIN` accepts a domain, `sslip` (free address, default) or `none` (http). `WWM_ACTION` is `install`, `update`, `domain` or `password`.

## Using an AI assistant

The repo ships a skill for AI assistants (Claude, Codex, Cursor and others): [skills/wwm-guild-manager](skills/wwm-guild-manager/SKILL.md). Give your assistant access to the server or the code and ask it to install, update or fix the site — the skill tells it where everything lives and what not to break.

## Development

Requires Node.js 20+.

```bash
npm install
EDIT_PASSWORD=dev node server/index.mjs   # backend on :3001
npm run dev                                # frontend on :3000, proxies /api to the backend
npm test                                   # tests
```

React 19 + TypeScript + Vite + Tailwind on the frontend; a dependency-free Node.js server that keeps data in JSON files.

## License

[MIT](LICENSE). The license covers the code; game icons and the game name belong to their owners.

## Credits

Based on the [Where Winds Meet Guild Manager](https://github.com/The-Wizard-Coder/Where-Winds-Meet-Guild-Manager) project by The-Wizard-Coder.

Where Winds Meet and its in-game icons belong to their respective owners. This is a fan-made tool, not affiliated with the game's developers or publishers.
