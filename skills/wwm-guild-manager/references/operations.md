# Operations: install, update, move, back up, fix

All commands run on the server as root (or with `sudo`).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh | sudo bash
```

Interactive questions: installer language, how the site is reached (free sslip.io
address / own domain / plain http by IP), officer password (Enter = random). Takes 1–3
minutes. At the end it prints the site link, the officer link (`/#admin`) and the password.

Unattended (no terminal needed — use this when you drive the server yourself):

```bash
curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh \
  | sudo WWM_LANG=en WWM_ACTION=install WWM_DOMAIN=sslip WWM_PASSWORD='S3cret-pass' bash
```

| Variable | Values |
|---|---|
| `WWM_LANG` | `en`, `ru` |
| `WWM_ACTION` | `install`, `update`, `domain`, `password` |
| `WWM_DOMAIN` | a domain, `sslip` (free `<ip>.sslip.io`, default), `none` (http only) |
| `WWM_PASSWORD` | 6+ chars from `A-Za-z0-9._@#%+=:,!?-`; empty = random |
| `WWM_REPO`, `WWM_BRANCH` | another git repo / branch (forks, testing) |

What it does, in order: checks OS and free ports 80/443 → installs git, Node.js 22
(NodeSource) and Caddy → adds a 1 GB swap file if RAM < 1.8 GB and no swap → creates
system user `wwm` and `/var/lib/wwm` → clones the repo to `/opt/wwm` → moves data from an
old layout (`/opt/wwm/server/data`) if `/var/lib/wwm` is empty → `npm ci` + `vite build`
into `dist.new`, then swaps it with `dist` → writes `/etc/wwm/wwm.env`, the systemd unit
and the Caddyfile → opens 80/443 in ufw if ufw is active → starts and waits for
`/api/session` → waits up to a minute for HTTPS.

## Update, change domain, reset password

Run the same install command; on an existing installation it shows a menu. Unattended:
`WWM_ACTION=update`, `WWM_ACTION=domain WWM_DOMAIN=new.example.com`,
`WWM_ACTION=password WWM_PASSWORD=...`.

- Update = `git fetch` + `reset --hard origin/main` in `/opt/wwm`, rebuild, restart.
  Data in `/var/lib/wwm` is untouched. Local edits in `/opt/wwm` are lost — by design.
- Password reset rewrites `EDIT_PASSWORD` and deletes `/var/lib/wwm/auth.json` (a
  password changed on the site is stored there and takes precedence over the env value).

## Back up and restore

```bash
tar czf ~/wwm-backup-$(date +%F).tgz -C /var/lib wwm          # back up
systemctl stop wwm                                             # restore:
tar xzf wwm-backup-YYYY-MM-DD.tgz -C /var/lib
chown -R wwm:wwm /var/lib/wwm && chmod 700 /var/lib/wwm
systemctl start wwm
```

The backup contains bot tokens and the session key — treat it as a secret.

## Move to another server

1. Back up `/var/lib/wwm` on the old server and copy the archive to the new one.
2. Install on the new server (same or new address).
3. Restore the archive as above.
4. If the address changed, update it everywhere outside the server:
   - Discord Developer Portal → General Information → **Interactions Endpoint URL**:
     `https://<new>/api/discord/interactions`
   - Discord Developer Portal → OAuth2 → **Redirects**:
     `https://<new>/api/auth/discord/callback` (only if Discord login is used)
   - Google Cloud Console → OAuth client → **Authorized redirect URIs**:
     `https://<new>/api/yt/callback` (only if YouTube uploads are used)
   - Telegram needs nothing: the bot uses long polling.
5. Tell the guild the new link. With an sslip.io address the link changes with the IP.

## Diagnosis

Start with:

```bash
systemctl status wwm caddy --no-pager
journalctl -u wwm -n 80 --no-pager
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/session   # backend alive?
cat /etc/caddy/Caddyfile; grep -v PASSWORD /etc/wwm/wwm.env                  # config (hide the password)
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Site down, `wwm` failed | Missing/broken build, bad env, crash on start | Read `journalctl -u wwm`; then re-run installer → update |
| `Not found (нет собранной статики …)` | `dist` missing | Re-run installer → update |
| 502 from Caddy | Backend not running | `systemctl restart wwm`, read its log |
| HTTPS fails, http works | DNS A record points elsewhere, or 80/443 blocked by the hosting firewall | `getent ahostsv4 <domain>` must return the server IP; open 80+443 in the hosting panel; `journalctl -u caddy -n 50` shows ACME errors |
| Certificate errors on sslip.io | Let's Encrypt rate limit for the shared sslip.io domain | Caddy retries and also falls back to ZeroSSL; wait, or use an own domain |
| Installer: "ports 80/443 already used" | nginx/apache/another Caddy | `ss -ltnp '( sport = :80 or sport = :443 )'`; stop that service or use another server |
| Build killed / out of memory | Tiny VPS | Check `free -m` and `swapon --show`; the installer adds swap only if none exists |
| Discord buttons do nothing / "interaction failed" | Interactions Endpoint URL not set or wrong, site not on HTTPS, or the backend was down | Check the URL in the Developer Portal; the Integrations tab shows whether Discord has contacted the site since the last restart |
| Bot posts nothing | Token revoked, bot not invited, no channel chosen | Integrations tab shows the bot status; re-paste the token there |
| Officer password rejected | Wrong password, or 8 failed tries → 10-minute lockout per IP | Wait 10 minutes or `systemctl restart wwm` (clears lockouts); reset via installer |
| Live updates lag or stop | A proxy buffering SSE | The Caddyfile must keep `flush_interval -1`; re-run installer to rewrite it |
| Data looks old after restore | Files owned by root | `chown -R wwm:wwm /var/lib/wwm`, restart |

## Manual layout (if you must change it by hand)

`/etc/wwm/wwm.env`:

```
WWM_DOMAIN=guild.example.com
EDIT_PASSWORD=...
PORT=3001
HOST=127.0.0.1
DATA_DIR=/var/lib/wwm
STATIC_DIR=/opt/wwm/dist
TELEGRAM_SITE_URL=https://guild.example.com
```

The unit runs `node /opt/wwm/server/index.mjs` as `wwm` with `ProtectSystem=strict` and
`ReadWritePaths=/var/lib/wwm` — the process can write only to the data folder. Any
manual change to these three files is overwritten the next time the installer runs.
