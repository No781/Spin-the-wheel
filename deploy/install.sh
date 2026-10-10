#!/usr/bin/env bash
#
# Installs Spin the Wheel on an Ubuntu/Debian server that may already host other sites.
#
# Safe to run next to an existing site:
#   * it never replaces or edits your existing web server config, it only ADDS one new, separate
#     virtual host for the domain you give it (for example wheel.example.com)
#   * it never installs Caddy/Apache over your web server, never changes firewall rules, and never
#     touches system Node, it uses its own private copy of Node under /opt/spin-the-wheel/node
#   * before reloading nginx it runs `nginx -t`; if that fails it removes its change again
#
# Usage:
#   sudo ./deploy/install.sh --domain wheel.example.com [options]
#
# Options:
#   --domain NAME   domain to serve the wheel on (required; point its DNS record at this server first)
#   --email ADDR    contact address for Let's Encrypt (recommended; expiry notices go here)
#   --port N        local port for the app (default: first free port from 8080; it only listens on 127.0.0.1)
#   --no-tls        skip HTTPS (serve plain HTTP only)
#   --no-web        install and start the app only; print the proxy config instead of touching a web server
#   --dry-run       show what would happen and what was detected, change nothing
#   --yes           don't ask for confirmation
#   -h, --help      show this help

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SELF_DIR/.." && pwd)"

INSTALL_ROOT="${INSTALL_ROOT:-/opt/spin-the-wheel}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
ACME_ROOT="${ACME_ROOT:-/var/www/spin-the-wheel-acme}"
SERVICE=spin-the-wheel
SERVICE_USER=spinwheel
APP_DIR="$INSTALL_ROOT/app"
CONF_FILE="$INSTALL_ROOT/install.conf"
MARKER="Managed by Spin the Wheel"

DOMAIN="" EMAIL="" PORT="" PORT_GIVEN=0 TLS=1 WEB=1 DRY=0 YES=0

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '  ok  %s\n' "$*"; }
warn() { printf '  !!  %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Runs a command that changes the system, or just shows it in --dry-run mode.
act() {
  if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

# Writes stdin to a file, or shows what would be written in --dry-run mode.
write_file() {
  if [ "$DRY" = 1 ]; then
    printf '    [dry-run] would write %s:\n' "$1"
    sed 's/^/        | /'
  else
    cat >"$1"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; PORT_GIVEN=1; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --no-web) WEB=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[ -n "$DOMAIN" ] || { usage; die "--domain is required"; }
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$DOMAIN" == *.* ]] || die "'$DOMAIN' doesn't look like a lowercase domain name"
[[ -z "$EMAIL" || "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "'$EMAIL' doesn't look like an email address"
if [ -n "$PORT" ]; then
  [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ]] || die "--port must be a number between 1024 and 65535"
fi
# even --dry-run needs root: only root can see which programs own ports 80/443 and validate the nginx config
if [ "$(id -u)" -ne 0 ]; then die "Run as root: sudo $0 $*"; fi

################################################################ preflight (read-only)

listener_procs() { # names of the programs listening on TCP port $1
  ss -H -ltnp "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | sed 's/users:(("//; s/"$//' | sort -u | tr '\n' ' ' || true
}
port_busy() { [ -n "$(ss -H -ltn "sport = :$1" 2>/dev/null)" ]; }

preflight() {
  log "Checking this server (nothing is changed in this step)"

  # shellcheck disable=SC1091
  OS_NAME="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
  info "OS: $OS_NAME"
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  P80="$(listener_procs 80)"; P443="$(listener_procs 443)"
  info "Port 80 is used by:  ${P80:-nothing}"
  info "Port 443 is used by: ${P443:-nothing}"
  WEBSERVER=none
  case " $P80 $P443 " in
    *" nginx "*) WEBSERVER=nginx ;;
    *" apache2 "*|*" httpd "*) WEBSERVER=apache ;;
    *" caddy "*) WEBSERVER=caddy ;;
    *) [ -z "$P80$P443" ] || WEBSERVER=other ;;
  esac
  [ "$WEBSERVER" = none ] && { command -v apache2 >/dev/null || command -v caddy >/dev/null || command -v nginx >/dev/null; } \
    && WEBSERVER=installed-not-running
  info "Web server detected: $WEBSERVER"

  # an earlier install keeps its port
  if [ "$PORT_GIVEN" = 0 ] && [ -f "$CONF_FILE" ]; then
    PORT="$(sed -n 's/^PORT=//p' "$CONF_FILE" | head -1)"
    [ -z "$PORT" ] || info "Re-using port $PORT from the previous install"
  fi
  if [ -z "$PORT" ]; then
    local p
    for p in $(seq 8080 8099); do
      if ! port_busy "$p"; then PORT="$p"; break; fi
    done
    [ -n "$PORT" ] || die "No free port found between 8080 and 8099; pass --port"
  elif ! systemctl is-active --quiet "$SERVICE" 2>/dev/null && port_busy "$PORT"; then
    die "Port $PORT is already in use by: $(listener_procs "$PORT")"
  fi
  info "App will listen on 127.0.0.1:$PORT (not reachable from the internet directly)"

  # DNS
  DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
  if [ -z "$DNS_IP" ]; then
    warn "$DOMAIN doesn't resolve yet. Create a DNS A record for it pointing at this server."
    DNS_OK=0
  else
    DNS_OK=1
    case " $LOCAL_IPS " in
      *" $DNS_IP "*) ok "$DOMAIN resolves to this server ($DNS_IP)" ;;
      *) warn "$DOMAIN resolves to $DNS_IP, which isn't one of this server's addresses ($LOCAL_IPS). Fine if you use a floating IP or a proxy, otherwise fix the DNS record." ;;
    esac
  fi

  if [ "$WEBSERVER" = nginx ]; then
    nginx -t >/dev/null 2>&1 || die "Your existing nginx configuration fails 'nginx -t' even before this installer touched it. Fix that first (run: sudo nginx -t)."
    ok "Existing nginx configuration is valid"
    NGINX_DUMP="$(nginx -T 2>/dev/null || true)"
    local clash
    # Finds every `server_name ...;` in the loaded config (also when a whole server block is on one line) and
    # reports files other than our own that already claim this domain. Commented-out lines are ignored.
    clash="$(printf '%s\n' "$NGINX_DUMP" | awk -v d="$DOMAIN" -v o1="$NGINX_DIR/sites-enabled/$DOMAIN" -v o2="$NGINX_DIR/conf.d/$DOMAIN.conf" '
      /^# configuration file /{f=$4; sub(/:$/,"",f); next}
      /^[ \t]*#/{next}
      {
        line=$0
        while (match(line, /server_name[ \t]+[^;]+;/)) {
          n=split(substr(line, RSTART+11, RLENGTH-12), names, /[ \t]+/)
          for (i=1; i<=n; i++) if (names[i]==d && f!=o1 && f!=o2) print f
          line=substr(line, RSTART+RLENGTH)
        }
      }' | sort -u)"
    [ -z "$clash" ] || die "nginx already has a server_name $DOMAIN in: $clash. Pick another domain or remove that entry."
    ok "$DOMAIN isn't used by any existing nginx site"
  fi
}

confirm() {
  [ "$YES" = 1 ] || [ "$DRY" = 1 ] && return 0
  printf '\nContinue? [y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) die "Cancelled, nothing was changed." ;; esac
}

################################################################ steps

create_user_and_dirs() {
  log "Service user and folders"
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    ok "User $SERVICE_USER already exists"
  else
    act useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  act install -d -m 755 "$INSTALL_ROOT" "$APP_DIR"
}

copy_app() {
  log "Copying the site and server to $APP_DIR"
  if [ "$DRY" = 1 ]; then info "[dry-run] would copy index.html style.css script.js config.js server/ deploy/"; return; fi
  local keep=()
  [ -e "$APP_DIR/config.js" ] && keep=(--exclude=config.js) && info "Keeping your existing config.js"
  (cd "$SRC_DIR" && tar --exclude=node_modules --exclude=server/data "${keep[@]}" -cf - index.html style.css script.js config.js server deploy) \
    | tar -C "$APP_DIR" -xf -
  chown -R root:root "$APP_DIR"
  chmod -R go-w,a+rX "$APP_DIR"
  ok "Copied (owned by root, read-only for the service)"
}

install_node() {
  log "Node.js (private copy, system Node is left alone)"
  NODE_DIR="$INSTALL_ROOT/node"
  NODE_BIN="$NODE_DIR/bin/node"
  if [ -x "$NODE_BIN" ] && "$NODE_BIN" -v >/dev/null 2>&1; then
    ok "Already installed ($("$NODE_BIN" -v))"
    return
  fi
  if [ "$DRY" = 1 ]; then info "[dry-run] would download the latest Node 22 LTS ($NODE_ARCH) from nodejs.org, verify its checksum, unpack to $NODE_DIR"; return; fi
  command -v xz >/dev/null || apt-get install -y xz-utils
  local base=https://nodejs.org/dist/latest-v22.x line sum file tmp
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E "linux-${NODE_ARCH}\.tar\.xz\$" | head -1)" || die "Couldn't read the Node release list from nodejs.org"
  sum="${line%% *}"; file="${line##* }"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file" || die "Couldn't download $file"
  echo "$sum  $tmp/$file" | sha256sum -c - >/dev/null || die "Checksum of the downloaded Node did not match, aborting"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  ok "Installed $("$NODE_BIN" -v), checksum verified"
}

install_deps() {
  log "Installing the server's dependencies"
  if [ "$DRY" = 1 ]; then info "[dry-run] would run npm ci --omit=dev in $APP_DIR/server"; return; fi
  (cd "$APP_DIR/server" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund) \
    || die "npm ci failed"
  chown -R root:root "$APP_DIR"
  chmod -R go-w,a+rX "$APP_DIR"
  ok "Dependencies installed"
}

wait_healthy() {
  local _
  for _ in $(seq 1 20); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

install_service() {
  log "systemd service"
  sed -e "s|@USER@|$SERVICE_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@PORT@|$PORT|g" \
    "$SELF_DIR/spin-the-wheel.service" | write_file "$SYSTEMD_DIR/$SERVICE.service"
  act systemctl daemon-reload
  act systemctl enable "$SERVICE"
  act systemctl restart "$SERVICE"
  if [ "$DRY" = 0 ]; then
    if wait_healthy; then ok "Service is up: http://127.0.0.1:$PORT/healthz answers"
    else
      journalctl -u "$SERVICE" -n 20 --no-pager 2>/dev/null || true
      die "The service didn't become healthy. See the log above (journalctl -u $SERVICE)."
    fi
  fi
}

write_conf() {
  [ "$DRY" = 1 ] && return 0
  cat >"$CONF_FILE" <<EOF
DOMAIN=$DOMAIN
PORT=$PORT
NODE_BIN=$NODE_BIN
APP_DIR=$APP_DIR
TLS=$TLS
EOF
}

################################################################ nginx

# Debian/Ubuntu keep sites in sites-available + sites-enabled; others use conf.d. Use whichever nginx actually loads.
pick_nginx_layout() {
  if [ -d "$NGINX_DIR/sites-available" ] && printf '%s\n' "$NGINX_DUMP" | grep -Eq 'include[[:space:]]+[^;]*sites-enabled'; then
    VHOST_FILE="$NGINX_DIR/sites-available/$DOMAIN"
    VHOST_ACTIVE="$NGINX_DIR/sites-enabled/$DOMAIN"
  elif [ -d "$NGINX_DIR/conf.d" ] && printf '%s\n' "$NGINX_DUMP" | grep -Eq 'include[[:space:]]+[^;]*conf\.d'; then
    VHOST_FILE="$NGINX_DIR/conf.d/$DOMAIN.conf"
    VHOST_ACTIVE="$VHOST_FILE"
  else
    return 1
  fi
}

render_vhost() { # $1 = http | https
  local l80="listen 80;" l443="listen 443 ssl;"
  if [ "$IPV6" = 1 ]; then
    l80="$l80
    listen [::]:80;"
    l443="$l443
    listen [::]:443 ssl;"
  fi
  cat <<EOF
# $MARKER (deploy/install.sh). Remove it with deploy/uninstall.sh.
map \$http_upgrade \$spin_wheel_connection {
    default upgrade;
    ''      close;
}

EOF
  if [ "$1" = http ]; then
    cat <<EOF
server {
    $l80
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type text/plain;
    }

    location / {
$(render_proxy)
    }
}
EOF
  else
    cat <<EOF
server {
    $l80
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type text/plain;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    $l443
    server_name $DOMAIN;

    ssl_certificate     $LE_DIR/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key $LE_DIR/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
$(render_proxy)
    }
}
EOF
  fi
}

# The app trusts X-Forwarded-For for its per-IP limits, so it is overwritten here, never appended to.
render_proxy() {
  cat <<EOF
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$spin_wheel_connection;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
EOF
}

# Installs a vhost, validates the whole nginx config, reloads, and rolls back if the check fails.
apply_vhost() { # $1 = http | https
  if [ "$DRY" = 1 ]; then
    render_vhost "$1" | write_file "$VHOST_FILE"
    info "[dry-run] would run nginx -t and reload nginx (no restart, no downtime)"
    return 0
  fi
  local backup="" had_link=0
  [ -e "$VHOST_FILE" ] && { backup="$(mktemp)"; cp -a "$VHOST_FILE" "$backup"; }
  [ -L "$VHOST_ACTIVE" ] && had_link=1
  render_vhost "$1" >"$VHOST_FILE"
  [ "$VHOST_ACTIVE" = "$VHOST_FILE" ] || ln -sfn "$VHOST_FILE" "$VHOST_ACTIVE"

  if out="$(nginx -t 2>&1)"; then
    systemctl reload nginx || die "The new config is valid (nginx -t passed) but 'systemctl reload nginx' failed. Is nginx managed by systemd here? Check: systemctl status nginx"
    [ -z "$backup" ] || rm -f "$backup"
    ok "nginx reloaded with the new site (your other sites were not touched)"
  else
    warn "nginx rejected the new configuration, undoing it:"
    printf '%s\n' "$out" >&2
    if [ -n "$backup" ]; then cp -a "$backup" "$VHOST_FILE"; rm -f "$backup"; else rm -f "$VHOST_FILE"; fi
    if [ "$had_link" = 0 ] && [ "$VHOST_ACTIVE" != "$VHOST_FILE" ]; then rm -f "$VHOST_ACTIVE"; fi
    if nginx -t >/dev/null 2>&1; then ok "Rolled back, nginx configuration is as it was"
    else warn "nginx -t still fails after the rollback; run: sudo nginx -t"; fi
    die "Not applied. Nothing was reloaded."
  fi
}

# nginx applies a reload a moment after the command returns, so wait until it really serves the new site
# (the request below only succeeds if nginx routes the domain to the app and the app answers).
probe_site() { # $1 = http | https
  [ "$DRY" = 1 ] && return 0
  local _ port=80 base="http://$DOMAIN"
  if [ "$1" = https ]; then port=443; base="https://$DOMAIN"; fi
  for _ in $(seq 1 20); do
    if [ "$(curl -fsS --noproxy '*' -m 3 --resolve "$DOMAIN:$port:127.0.0.1" "$base/healthz" 2>/dev/null)" = ok ]; then
      ok "$base/healthz answers through nginx"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

setup_nginx() {
  log "nginx: adding a separate site for $DOMAIN"
  [ "$DRY" = 1 ] || NGINX_DUMP="$(nginx -T 2>/dev/null || true)"
  pick_nginx_layout || die "Couldn't find where nginx loads sites from (no sites-enabled or conf.d include). Use --no-web and add the printed snippet yourself."
  if [ -e "$VHOST_FILE" ] && ! grep -q "$MARKER" "$VHOST_FILE"; then
    die "$VHOST_FILE exists and wasn't created by this installer; not overwriting it."
  fi
  IPV6=0
  if [ -e /proc/net/if_inet6 ] && printf '%s\n' "$NGINX_DUMP" | grep -Eq 'listen[[:space:]]+\[::\]'; then IPV6=1; fi

  act install -d -m 755 "$ACME_ROOT"
  apply_vhost http
  if ! probe_site http; then
    warn "nginx did not route $DOMAIN to the app within 10 seconds. Another site may be answering for it (check: sudo nginx -T | grep -n server_name)."
    TLS=0
  fi

  if [ "$TLS" = 1 ]; then setup_tls; else info "HTTPS not set up: serving plain HTTP only"; fi
}

setup_tls() {
  log "HTTPS certificate (Let's Encrypt)"
  if [ "$DNS_OK" = 0 ]; then
    warn "Skipping HTTPS because $DOMAIN doesn't resolve yet. Create the DNS record, then re-run this script."
    TLS=0
    return 0
  fi
  if [ ! -s "$LE_DIR/live/$DOMAIN/fullchain.pem" ]; then
    if ! command -v certbot >/dev/null 2>&1; then
      info "certbot isn't installed; installing it (adds the certbot package, changes nothing else)"
      act apt-get install -y certbot
    fi
    local mail=(--register-unsafely-without-email)
    [ -z "$EMAIL" ] || mail=(-m "$EMAIL")
    if [ "$DRY" = 1 ]; then
      info "[dry-run] would run: certbot certonly --webroot -w $ACME_ROOT -d $DOMAIN ${mail[*]} --deploy-hook 'systemctl reload nginx'"
    elif ! certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos "${mail[@]}" \
        --deploy-hook "systemctl reload nginx"; then
      warn "Couldn't get a certificate (is $DOMAIN's DNS pointing here and port 80 reachable from the internet?)."
      warn "The site works over plain HTTP for now. Fix the cause and re-run this script to add HTTPS."
      TLS=0
      return 0
    fi
  else
    ok "A certificate for $DOMAIN already exists"
  fi
  apply_vhost https
  probe_site https || warn "https://$DOMAIN/healthz did not answer after switching to HTTPS. Run deploy/check.sh and send me its output."
}

print_manual_proxy() {
  cat <<EOF

The app is running on 127.0.0.1:$PORT. Point your web server at it for $DOMAIN, forwarding WebSockets too.

nginx:
$(render_vhost http | sed 's/^/    /')

Caddy:
    $DOMAIN {
        reverse_proxy 127.0.0.1:$PORT
    }

Apache (enable first: a2enmod proxy proxy_http proxy_wstunnel rewrite headers):
    <VirtualHost *:80>
        ServerName $DOMAIN
        RewriteEngine On
        RewriteCond %{HTTP:Upgrade} =websocket [NC]
        RewriteRule ^/ws\$ ws://127.0.0.1:$PORT/ws [P,L]
        ProxyPreserveHost On
        ProxyPass / http://127.0.0.1:$PORT/
        ProxyPassReverse / http://127.0.0.1:$PORT/
        RequestHeader set X-Forwarded-For %{REMOTE_ADDR}s
    </VirtualHost>
EOF
}

################################################################ main

IPV6=0
VHOST_FILE="" VHOST_ACTIVE=""
NGINX_DUMP=""
NODE_DIR="$INSTALL_ROOT/node"
NODE_BIN="$NODE_DIR/bin/node"

preflight

log "Plan"
info "Domain:            $DOMAIN"
info "App folder:        $APP_DIR (service runs as the unprivileged user '$SERVICE_USER')"
info "Rooms saved in:    /var/lib/spin-the-wheel"
case "$WEBSERVER" in
  nginx)
    if [ "$WEB" = 1 ]; then info "Web server:        add ONE new nginx site for $DOMAIN (existing sites untouched), reload without downtime"
    else info "Web server:        nothing changed (--no-web)"; fi ;;
  none)
    if [ "$WEB" = 1 ]; then info "Web server:        none found, nginx will be installed to serve $DOMAIN"
    else info "Web server:        nothing changed (--no-web)"; fi ;;
  *) info "Web server:        $WEBSERVER found, it will NOT be changed; the proxy config is printed for you to add"; WEB=0 ;;
esac
if [ "$TLS" = 1 ]; then info "HTTPS:             certificate via Let's Encrypt (certbot, webroot method)"
else info "HTTPS:             off"; fi
[ "$DRY" = 1 ] && info "(dry run: nothing below is executed)"
confirm

if [ "$WEBSERVER" = none ] && [ "$WEB" = 1 ]; then
  log "Installing nginx (no web server was found on this machine)"
  act apt-get install -y nginx
  [ "$DRY" = 1 ] || { NGINX_DUMP="$(nginx -T 2>/dev/null || true)"; WEBSERVER=nginx; }
fi

create_user_and_dirs
copy_app
install_node
install_deps
install_service
write_conf

if [ "$WEB" = 1 ] && [ "$WEBSERVER" = nginx ]; then
  setup_nginx
  write_conf
elif [ "$WEB" = 1 ] && [ "$DRY" = 1 ]; then
  info "[dry-run] would install nginx, then add a site for $DOMAIN (and HTTPS if DNS is ready)"
else
  print_manual_proxy
fi

log "Done"
if [ "$DRY" = 1 ]; then
  info "Dry run finished. Nothing was changed. Run again without --dry-run to install."
else
  scheme=http; [ "$TLS" = 1 ] && scheme=https
  info "Open $scheme://$DOMAIN/ and press 'Go live together'."
  info "Check everything with:  sudo $APP_DIR/deploy/check.sh"
  info "Remove everything with: sudo $APP_DIR/deploy/uninstall.sh"
fi
