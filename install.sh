#!/usr/bin/env bash
# WWM Guild Manager — установщик / installer.
#
# Ставит сайт на чистый сервер Ubuntu или Debian одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/X4vi3/WWM-GuildManager/main/install.sh | sudo bash
#
# Повторный запуск той же команды не ломает установку, а открывает меню:
# обновить сайт, сменить домен, сбросить пароль офицеров.
#
# Без вопросов (для автоматизации): задайте переменные окружения
#   WWM_LANG=ru|en
#   WWM_ACTION=install|update|domain|password
#   WWM_DOMAIN=guild.example.com | sslip (бесплатный адрес, по умолчанию) | none (http без домена)
#   WWM_PASSWORD=...   (не задан — придумается случайный)
#
# Где что лежит после установки:
#   /opt/wwm            код сайта (перезаписывается при обновлении)
#   /var/lib/wwm        данные гильдии — состав, события, настройки ботов
#   /etc/wwm/wwm.env    настройки запуска (домен, пароль)
#   служба systemd      wwm   (journalctl -u wwm — журнал)

set -euo pipefail

# Откуда брать код. Форк может поменять это под себя.
REPO_URL="${WWM_REPO:-https://github.com/X4vi3/WWM-GuildManager.git}"
BRANCH="${WWM_BRANCH:-main}"

APP_DIR=/opt/wwm
DATA_DIR=/var/lib/wwm
CONF_DIR=/etc/wwm
ENV_FILE=$CONF_DIR/wwm.env
SERVICE=wwm
APP_USER=wwm
PORT=3001
NODE_MAJOR=22

L="${WWM_LANG:-}"

# ---------- вывод ----------

# m "по-русски" "in English" — печатает строку на выбранном языке
m() { if [ "$L" = ru ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$(m "$1" "$2")"; }
ok()   { printf '\033[32m✔ %s\033[0m\n' "$(m "$1" "$2")"; }
warn() { printf '\033[33m! %s\033[0m\n' "$(m "$1" "$2")"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$(m "$1" "$2")" >&2; exit 1; }

# Вопрос читаем с терминала, а не из stdin: при `curl | bash` stdin занят самим скриптом.
# Сам файл /dev/tty есть всегда, а открыть его можно только при живом терминале.
has_tty() { { : >/dev/tty; } 2>/dev/null; }

ask() {
  local __var=$1 __prompt __reply
  __prompt=$(m "$2" "$3")
  if ! has_tty; then
    printf -v "$__var" '%s' ''
    return
  fi
  printf '%s ' "$__prompt" >/dev/tty
  IFS= read -r __reply </dev/tty || __reply=''
  printf -v "$__var" '%s' "$__reply"
}

ask_secret() {
  local __var=$1 __prompt __reply
  __prompt=$(m "$2" "$3")
  if ! has_tty; then
    printf -v "$__var" '%s' ''
    return
  fi
  printf '%s ' "$__prompt" >/dev/tty
  IFS= read -rs __reply </dev/tty || __reply=''
  printf '\n' >/dev/tty
  printf -v "$__var" '%s' "$__reply"
}

confirm() {
  local reply
  ask reply "$1 [д/н]" "$2 [y/n]"
  case "$reply" in [yYдД]*) return 0 ;; *) return 1 ;; esac
}

# ---------- проверки ----------

check_system() {
  [ "$(id -u)" -eq 0 ] || die "Запустите от root: добавьте sudo перед bash." "Run as root: put sudo before bash."
  [ -r /etc/os-release ] || die "Не удалось определить систему. Нужен Ubuntu или Debian." "Unknown OS. Ubuntu or Debian is required."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-} ${ID_LIKE:-}" in
    *ubuntu*|*debian*) ;;
    *) die "Поддерживаются только Ubuntu и Debian (у вас: ${PRETTY_NAME:-?})." "Only Ubuntu and Debian are supported (found: ${PRETTY_NAME:-?})." ;;
  esac
  command -v systemctl >/dev/null || die "Нет systemd — на таком сервере установка не сработает." "systemd is missing — this server is not supported."
}

# Порты 80 и 443 нужны Caddy. Если их держит что-то другое (nginx, apache),
# сертификат не выпустится, и честнее остановиться сразу.
check_ports() {
  command -v ss >/dev/null || return 0
  local busy
  busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)
  if [ -n "$busy" ]; then
    printf '%s\n' "$busy"
    die "Порты 80/443 уже заняты другой программой (см. выше). Освободите их или ставьте на отдельный сервер." \
        "Ports 80/443 are already used by another program (see above). Free them or use a separate server."
  fi
}

public_ip() {
  local ip=''
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') && [ -n "$ip" ] && break
  done
  printf '%s' "$ip"
}

# ---------- вопросы ----------

choose_lang() {
  [ -n "$L" ] && return
  local reply
  if has_tty; then
    printf 'Language / Язык:  1) English  2) Русский  [1]: ' >/dev/tty
    IFS= read -r reply </dev/tty || reply=''
  fi
  case "${reply:-}" in 2|ru|RU|р*|Р*) L=ru ;; *) L=en ;; esac
}

# Бесплатный адрес вида 1-2-3-4.sslip.io: сервис отвечает на него IP-адресом,
# зашитым в само имя, так что HTTPS работает без покупки домена.
sslip_name() { printf '%s.sslip.io' "$(printf '%s' "$1" | tr . -)"; }

# Что не работает без HTTPS (сверено с кодом): Discord требует https для адреса,
# куда шлёт нажатия кнопок бота, Google — для возврата после входа в YouTube,
# браузер — для копирования картинки в буфер.
explain_http_limits() {
  m "     не будут работать: бот Discord и вход через Discord, загрузка записей на YouTube," \
    "     will not work: the Discord bot and Discord login, uploading recordings to YouTube,"
  m "     копирование картинки приказа в буфер (останется скачивание файлом)," \
    "     copying the battle order image to the clipboard (downloading the file still works),"
  m "     а пароль офицеров пойдёт по сети незашифрованным." \
    "     and the officer password travels over the network unencrypted."
  m "     Работает всё остальное: состав, война, карта, события, запись, Telegram-бот." \
    "     Everything else works: roster, war room, map, events, sign-ups, Telegram bot."
}

ask_domain() {
  local ip=$1 domain="${WWM_DOMAIN:-}" choice
  if [ -z "$domain" ] && [ -z "${WWM_ACTION:-}" ]; then
    echo
    m "Как будет открываться сайт?" "How will the site be reached?"
    if [ -n "$ip" ]; then
      m "  1) Бесплатный адрес $(sslip_name "$ip") — HTTPS, всё работает сразу" \
        "  1) Free address $(sslip_name "$ip") — HTTPS, everything works right away"
      m "     минус: адрес привязан к IP сервера; при переезде он сменится, и Discord придётся настроить заново" \
        "     downside: the address is tied to the server IP; if you move servers it changes and Discord must be set up again"
    fi
    m "  2) Свой домен, например guild.example.com — заранее создайте у регистратора A-запись → ${ip:-IP сервера}" \
      "  2) Your own domain, e.g. guild.example.com — first create an A record at your registrar → ${ip:-server IP}"
    m "  3) Без домена и HTTPS: http://${ip:-IP-сервера}" \
      "  3) No domain, no HTTPS: http://${ip:-server-IP}"
    explain_http_limits
    if [ -n "$ip" ]; then
      ask choice "Выбор [1]:" "Choice [1]:"
      choice=${choice:-1}
    else
      ask choice "Выбор [2]:" "Choice [2]:"
      choice=${choice:-2}
    fi
    case "$choice" in
      1) [ -n "$ip" ] || die "Не удалось узнать IP сервера — выберите 2 или 3." "Could not detect the server IP — choose 2 or 3."
         domain=$(sslip_name "$ip") ;;
      2) ask domain "Домен:" "Domain:"
         [ -n "$domain" ] || die "Домен не введён." "No domain entered." ;;
      3) domain=none ;;
      *) die "Нужно ввести 1, 2 или 3." "Please enter 1, 2 or 3." ;;
    esac
  fi
  # Без вопросов: пусто или sslip — бесплатный адрес, none — без домена
  case "$domain" in
    ''|sslip)
      if [ -n "$ip" ]; then domain=$(sslip_name "$ip"); else domain=none; fi ;;
  esac
  if [ "$domain" = none ]; then
    DOMAIN=''
    return
  fi
  domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##; s/[[:space:]]//g')
  if [ -n "$domain" ] && ! printf '%s' "$domain" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
    die "«$domain» не похож на домен. Пример: guild.example.com" "\"$domain\" does not look like a domain. Example: guild.example.com"
  fi
  if [ -n "$domain" ] && [ -n "$ip" ]; then
    local resolved
    resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
    if ! printf ' %s ' "$resolved" | grep -q " $ip "; then
      warn "Домен $domain сейчас указывает на: ${resolved:-никуда}, а этот сервер — $ip." \
           "Domain $domain currently points to: ${resolved:-nothing}, but this server is $ip."
      warn "HTTPS заработает сам, как только A-запись обновится (обычно 5–30 минут)." \
           "HTTPS will start working by itself once the A record updates (usually 5–30 minutes)."
      if [ -z "${WWM_DOMAIN:-}" ]; then
        confirm "Продолжить с этим доменом?" "Continue with this domain?" || die "Остановлено." "Stopped."
      fi
    fi
  fi
  DOMAIN=$domain
}

ask_password() {
  local pw="${WWM_PASSWORD:-}" pw2
  if [ -z "$pw" ] && [ -z "${WWM_ACTION:-}" ]; then
    echo
    m "Пароль офицеров — им входят в режим редактирования." \
      "Officer password — used to unlock editing."
    ask_secret pw "Пароль (Enter — придумать случайный):" "Password (Enter — generate a random one):"
    if [ -n "$pw" ]; then
      ask_secret pw2 "Повторите пароль:" "Repeat the password:"
      [ "$pw" = "$pw2" ] || die "Пароли не совпали." "Passwords do not match."
    fi
  fi
  if [ -z "$pw" ]; then
    pw=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)
    GENERATED_PW=1
  fi
  [ ${#pw} -ge 6 ] || die "Пароль короче 6 символов." "Password is shorter than 6 characters."
  # Пароль попадает в файл настроек systemd; кавычки, пробелы и $ там ломают разбор.
  printf '%s' "$pw" | grep -Eq '^[A-Za-z0-9._@#%+=:,!?-]+$' \
    || die "В пароле можно латиницу, цифры и знаки . _ @ # % + = : , ! ? -" \
           "The password may contain Latin letters, digits and . _ @ # % + = : , ! ? -"
  PASSWORD=$pw
}

# ---------- установка частей ----------

install_packages() {
  step "Ставлю системные пакеты" "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git debian-keyring debian-archive-keyring apt-transport-https >/dev/null

  local have=0
  if command -v node >/dev/null; then
    have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  if [ "$have" -lt 20 ]; then
    step "Ставлю Node.js $NODE_MAJOR" "Installing Node.js $NODE_MAJOR"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  ok "Node.js $(node -v)" "Node.js $(node -v)"

  if ! command -v caddy >/dev/null; then
    step "Ставлю Caddy (веб-сервер с автоматическим HTTPS)" "Installing Caddy (web server with automatic HTTPS)"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  ok "Caddy $(caddy version | awk '{print $1}')" "Caddy $(caddy version | awk '{print $1}')"
}

# Сборка фронта на машине с 1 ГБ памяти может упасть без подкачки.
ensure_swap() {
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if [ "$mem_mb" -lt 1800 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    step "Мало памяти ($mem_mb МБ) — добавляю файл подкачки 1 ГБ" "Low memory ($mem_mb MB) — adding a 1 GB swap file"
    if fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; then
      chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    fi
  fi
}

fetch_code() {
  step "Скачиваю сайт" "Downloading the site"
  if [ -d "$APP_DIR/.git" ]; then
    # Адрес берём из установщика, а не из прошлой установки: так обновление
    # подхватит переезд репозитория или форк.
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
  else
    if [ -d "$APP_DIR" ]; then
      # Старая ручная установка без git: код в сторону, данные заберёт migrate_data
      mv "$APP_DIR" "$APP_DIR.old-$(date +%Y%m%d%H%M%S)"
    fi
    git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  ok "Версия $(git -C "$APP_DIR" log -1 --format='%h от %cs')" "Version $(git -C "$APP_DIR" log -1 --format='%h from %cs')"
}

# Сборка идёт в соседнюю папку, а потом подменяет старую одним переименованием —
# так при обновлении сайт ни секунды не стоит без файлов.
build_site() {
  step "Собираю сайт (1–3 минуты)" "Building the site (1–3 minutes)"
  cd "$APP_DIR"
  npm ci --no-audit --no-fund --loglevel=error >/dev/null
  rm -rf dist.new
  node node_modules/vite/bin/vite.js build --outDir dist.new --emptyOutDir --logLevel error
  rm -rf dist.old
  if [ -d dist ]; then mv dist dist.old; fi
  mv dist.new dist
  rm -rf dist.old
  ok "Сайт собран" "Site built"
}

ensure_user_and_dirs() {
  id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  mkdir -p "$DATA_DIR" "$CONF_DIR"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
}

# Перенос данных со старой схемы, где они лежали внутри папки с кодом.
migrate_data() {
  if [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then return 0; fi
  local old
  for old in "$APP_DIR/server/data" "$APP_DIR".old-*/server/data; do
    if [ -d "$old" ] && [ -n "$(ls -A "$old" 2>/dev/null)" ]; then
      cp -a "$old/." "$DATA_DIR/"
      chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
      ok "Данные гильдии перенесены из $old" "Guild data moved from $old"
      return 0
    fi
  done
}

write_env() {
  local site_url
  if [ -n "$DOMAIN" ]; then site_url="https://$DOMAIN"; else site_url="http://$SERVER_IP"; fi
  umask 077
  cat >"$ENV_FILE" <<EOF
# Настройки сайта. После правки: systemctl restart $SERVICE
WWM_DOMAIN=$DOMAIN
EDIT_PASSWORD=$PASSWORD
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
STATIC_DIR=$APP_DIR/dist
TELEGRAM_SITE_URL=$site_url
EOF
  umask 022
  chmod 600 "$ENV_FILE"
}

write_service() {
  cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=WWM Guild Manager
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/server/index.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable -q $SERVICE
}

write_caddy() {
  local file=/etc/caddy/Caddyfile site
  if [ -n "$DOMAIN" ]; then site=$DOMAIN; else site=':80'; fi
  if [ -f "$file" ] && ! grep -q '# wwm-guild-manager' "$file"; then
    cp "$file" "$file.bak-$(date +%Y%m%d%H%M%S)"
  fi
  cat >"$file" <<EOF
# wwm-guild-manager — файл пишет установщик, правки руками перезапишутся
$site {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		# Живые обновления (SSE) не должны застревать в буфере
		flush_interval -1
	}
}
EOF
  caddy validate --config "$file" --adapter caddyfile >/dev/null 2>&1 \
    || die "Caddy не принял конфиг ($file)." "Caddy rejected the config ($file)."
  systemctl enable -q caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

open_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ok "Файрвол: открыты порты 80 и 443" "Firewall: ports 80 and 443 opened"
  fi
}

start_and_check() {
  step "Запускаю" "Starting"
  systemctl restart $SERVICE
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/session" >/dev/null 2>&1; then
      ok "Сайт работает" "The site is running"
      return 0
    fi
    sleep 1
  done
  journalctl -u $SERVICE -n 30 --no-pager || true
  die "Сайт не запустился. Журнал выше; полностью: journalctl -u $SERVICE" \
      "The site did not start. Log above; full log: journalctl -u $SERVICE"
}

# Caddy выпускает сертификат в фоне. Ждём немного, чтобы выдать проверенную ссылку,
# но не держим человека: если DNS ещё не обновился, HTTPS включится сам позже.
check_https() {
  [ -n "$DOMAIN" ] || return 0
  local i
  for i in $(seq 1 20); do
    if curl -fsS --max-time 4 "https://$DOMAIN/api/session" >/dev/null 2>&1; then
      ok "HTTPS работает" "HTTPS is working"
      return 0
    fi
    sleep 3
  done
  warn "HTTPS пока не отвечает. Обычно это значит, что A-запись домена ещё не обновилась." \
       "HTTPS is not answering yet. Usually the domain's A record has not updated yet."
  warn "Caddy продолжит попытки сам. Проверить: journalctl -u caddy -n 50" \
       "Caddy keeps retrying by itself. To check: journalctl -u caddy -n 50"
}

load_env() {
  # shellcheck disable=SC1090
  if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi
  DOMAIN="${WWM_DOMAIN:-}"
  PASSWORD="${EDIT_PASSWORD:-}"
}

summary() {
  local url
  if [ -n "$DOMAIN" ]; then url="https://$DOMAIN"; else url="http://$SERVER_IP"; fi
  echo
  printf '\033[1;32m%s\033[0m\n' "$(m "Готово!" "Done!")"
  echo
  m "  Сайт для гильдии:   $url" "  Site for the guild:  $url"
  m "  Вход офицеров:      $url/#admin" "  Officer login:       $url/#admin"
  if [ -n "${SHOW_PW:-}" ]; then
    m "  Пароль офицеров:    $PASSWORD" "  Officer password:    $PASSWORD"
    if [ -n "${GENERATED_PW:-}" ]; then
      m "  (пароль придуман случайно — сохраните его)" "  (randomly generated — save it somewhere)"
    fi
  fi
  echo
  case "$DOMAIN" in
    '')
      warn "Сайт работает без HTTPS:" "The site runs without HTTPS:"
      explain_http_limits
      m "  Чтобы включить HTTPS, запустите команду ещё раз и выберите «Сменить домен»." \
        "  To enable HTTPS, run the command again and choose \"Change the domain\"."
      echo ;;
    *.sslip.io)
      m "  Это бесплатный временный адрес. Когда купите свой домен, запустите команду ещё раз" \
        "  This is a free temporary address. Once you buy your own domain, run the command again"
      m "  и выберите «Сменить домен» — данные сохранятся, но в Discord-приложении нужно будет" \
        "  and choose \"Change the domain\" — your data stays, but the Discord application will need"
      m "  поменять адреса на новые." \
        "  its addresses updated to the new ones."
      echo ;;
  esac
  m "  Обновить сайт, сменить домен или пароль — запустите ту же команду ещё раз." \
    "  To update, change the domain or the password — run the same command again."
  m "  Данные гильдии: $DATA_DIR (резервная копия — просто скопируйте папку)." \
    "  Guild data: $DATA_DIR (to back up, just copy this folder)."
  m "  Журнал сайта: journalctl -u $SERVICE -f" \
    "  Site log: journalctl -u $SERVICE -f"
  echo
}

# ---------- сценарии ----------

do_install() {
  SERVER_IP=$(public_ip)
  check_ports
  ask_domain "$SERVER_IP"
  ask_password
  install_packages
  ensure_swap
  ensure_user_and_dirs
  fetch_code
  migrate_data
  build_site
  write_env
  write_service
  write_caddy
  open_firewall
  start_and_check
  check_https
  SHOW_PW=1
  summary
}

do_update() {
  SERVER_IP=$(public_ip)
  load_env
  install_packages
  ensure_swap
  ensure_user_and_dirs
  fetch_code
  build_site
  write_service
  start_and_check
  summary
}

do_change_domain() {
  local wanted="${WWM_DOMAIN:-}"
  SERVER_IP=$(public_ip)
  load_env
  # load_env подставил старый домен из файла — спрашиваем новый (или берём заданный)
  WWM_DOMAIN=$wanted
  ask_domain "$SERVER_IP"
  write_env
  write_caddy
  start_and_check
  check_https
  summary
}

do_reset_password() {
  SERVER_IP=$(public_ip)
  load_env
  ask_password
  write_env
  # Пароль, сменённый на сайте, хранится в данных и важнее переменной — убираем его.
  rm -f "$DATA_DIR/auth.json"
  start_and_check
  SHOW_PW=1
  summary
}

main() {
  choose_lang
  check_system
  case "$REPO_URL" in
    *OWNER/REPO*) die "В установщике не указан адрес репозитория (REPO_URL или WWM_REPO)." "The installer has no repository address (REPO_URL or WWM_REPO)." ;;
  esac

  local action="${WWM_ACTION:-}"
  if [ -z "$action" ]; then
    if [ -f "$ENV_FILE" ] && [ -d "$APP_DIR/.git" ]; then
      echo
      m "Сайт уже установлен. Что сделать?" "The site is already installed. What would you like to do?"
      m "  1) Обновить до последней версии" "  1) Update to the latest version"
      m "  2) Сменить домен" "  2) Change the domain"
      m "  3) Сбросить пароль офицеров" "  3) Reset the officer password"
      m "  4) Выйти" "  4) Exit"
      local choice
      ask choice "Номер [1]:" "Number [1]:"
      case "${choice:-1}" in
        1) action=update ;;
        2) action=domain ;;
        3) action=password ;;
        *) exit 0 ;;
      esac
    else
      action=install
    fi
  fi

  case "$action" in
    install)  do_install ;;
    update)   do_update ;;
    domain)   do_change_domain ;;
    password) do_reset_password ;;
    *) die "Неизвестное действие: $action" "Unknown action: $action" ;;
  esac
}

# Весь скрипт — внутри main: если `curl | bash` оборвётся на середине загрузки,
# недокачанный хвост не выполнится наполовину.
main "$@"
