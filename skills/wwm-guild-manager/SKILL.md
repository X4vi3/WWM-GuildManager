---
name: wwm-guild-manager
description: Install, update, troubleshoot and modify WWM Guild Manager — a self-hosted Where Winds Meet guild site (roster, events, 30v30 war planner, map, Discord/Telegram bots, YouTube uploads). Use when someone asks to set the site up on a server, fix a broken installation (site down, HTTPS not working, bot buttons not responding, forgotten password), move it to another server or domain, back it up, or change its code.
---

# WWM Guild Manager

A guild headquarters for the game Where Winds Meet. One Node.js process serves both the
built React frontend and a JSON API; Caddy sits in front and handles HTTPS. Guild data is
a handful of JSON files in one folder. There is no database.

The person you are helping is most likely a guild officer, not a programmer. Explain what
you are about to do in plain words, prefer the installer over manual commands, and never
delete `/var/lib/wwm` — it is the guild's entire history.

## Quick facts (standard installation)

| What | Where |
|---|---|
| Installer (install, update, change domain, reset password) | `curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh \| sudo bash` |
| Code | `/opt/wwm` (git checkout, overwritten on update) |
| Guild data | `/var/lib/wwm` (owned by user `wwm`, mode 700) |
| Settings | `/etc/wwm/wwm.env` (domain, officer password, port) |
| Service | `systemctl status wwm`, logs: `journalctl -u wwm` |
| Web server | Caddy, config `/etc/caddy/Caddyfile`, logs: `journalctl -u caddy` |
| Backend port | `127.0.0.1:3001` (not reachable from outside) |
| Installer log | `/var/log/wwm-install.log` (full output of every install/update step) |
| Officer login | `https://<site>/#admin` + password |
| Supported OS | Ubuntu 22.04+, Debian 12, with systemd; ports 80/443 must be free |

## What to read next

- **Installing, updating, moving, backups, anything broken on a server** →
  [references/operations.md](references/operations.md)
- **Changing the code** — start with
  [references/architecture.md](references/architecture.md) (code map, data files, rules
  that are easy to break), then as needed:
  - [references/features.md](references/features.md) — every feature: how it works, why,
    and what was tried and rejected. Read the section before touching that feature.
  - [references/design.md](references/design.md) — the closed design system, layout rules
    and the maintainer's preferences. Read before any UI work.
  - [references/api.md](references/api.md) — every HTTP route and who may call it.
- **Connecting the Discord bot** (step-by-step for the officer, in Russian) →
  [../../docs/discord-setup.ru.md](../../docs/discord-setup.ru.md)

## Ground rules

1. **Re-run the installer before fixing things by hand.** It is idempotent: on an
   existing installation it offers update / change domain / reset password and rewrites
   the service, Caddy config and env file from scratch. Most broken states are fixed by
   option 1 (update).
2. **Back up `/var/lib/wwm` before anything risky**:
   `tar czf ~/wwm-backup-$(date +%F).tgz -C /var/lib wwm`.
3. **Bot tokens and keys live in `/var/lib/wwm`, not in env.** Discord, Telegram and
   YouTube are configured on the site's Integrations tab. Do not print the contents of
   `discordconfig.json`, `tgconfig.json`, `ytconfig.json`, `auth.json` or `session.key`
   to the user or anywhere else.
4. **HTTPS is required** for the Discord bot's buttons, Discord login and YouTube uploads.
   Without a domain the installer can use a free `<ip-with-dashes>.sslip.io` address.
5. **After changing code**, run `npm test`, `npx tsc --noEmit` and `npm run build` before shipping; users get
   changes by re-running the installer (option 1), which pulls `main`.
