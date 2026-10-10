#!/usr/bin/env bash
#
# Read-only health check for a Spin the Wheel install. Changes nothing.
# Run it on the server (use sudo so it can read the nginx config, logs and certificates):
#
#   sudo /opt/spin-the-wheel/app/deploy/check.sh
#
# If something fails, paste the whole output back to get help.
#
# Options: --domain NAME  --port N  --main-site NAME (your other site, to confirm it still answers)

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/spin-the-wheel}"
CONF_FILE="$INSTALL_ROOT/install.conf"
SERVICE=spin-the-wheel

DOMAIN="" PORT="" MAIN_SITE="" TLS="" NODE_BIN=""
if [ -f "$CONF_FILE" ]; then
  DOMAIN="$(sed -n 's/^DOMAIN=//p' "$CONF_FILE" | head -1)"
  PORT="$(sed -n 's/^PORT=//p' "$CONF_FILE" | head -1)"
  TLS="$(sed -n 's/^TLS=//p' "$CONF_FILE" | head -1)"
  NODE_BIN="$(sed -n 's/^NODE_BIN=//p' "$CONF_FILE" | head -1)"
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --main-site) MAIN_SITE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done
PORT="${PORT:-8080}"
[ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$MAIN_SITE" ] || MAIN_SITE="${DOMAIN#*.}"

PASS=0 FAIL=0
pass() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
note() { printf '  [info] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# Runs the WebSocket end-to-end test and reports its result; $1 = description, rest = check.js arguments
ws_test() {
  local label="$1" out rc
  shift
  out="$("$NODE_BIN" "$SELF_DIR/check.js" "$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" | sed 's/^/        /'
  if [ $rc -eq 0 ]; then pass "$label works"; else fail "$label failed"; fi
}
have_node_test() { [ -n "$NODE_BIN" ] && [ -f "$SELF_DIR/check.js" ]; }

printf 'Spin the Wheel check, %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
printf 'domain=%s port=%s node=%s\n' "${DOMAIN:-?}" "$PORT" "${NODE_BIN:-?}"
[ "$(id -u)" -eq 0 ] || note "not running as root: some checks (nginx config, logs, certificates) may be incomplete. Try: sudo $0"

section "The app"
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then pass "service $SERVICE is running"
else fail "service $SERVICE is not running (try: sudo systemctl status $SERVICE)"; fi

listening="$(ss -H -ltn "sport = :$PORT" 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
case "$listening" in
  "127.0.0.1:$PORT ") pass "listening on 127.0.0.1:$PORT only (not exposed directly)" ;;
  "") fail "nothing is listening on port $PORT" ;;
  *) fail "port $PORT is open on: $listening (expected only 127.0.0.1)" ;;
esac

if [ "$(curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null)" = "ok" ]; then pass "/healthz answers"; else fail "/healthz did not answer 'ok'"; fi
if curl -fsS -m 5 "http://127.0.0.1:$PORT/" 2>/dev/null | grep -q '<title>Spin the Wheel'; then pass "the page is served"; else fail "the page was not served"; fi
for f in /server/server.js /.git/config /server/data/rooms.json; do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT$f" 2>/dev/null)"
  if [ "$code" = 404 ]; then pass "private path $f is not served (404)"; else fail "$f returned $code, expected 404"; fi
done

if have_node_test; then
  section "Live rooms, directly against the app"
  ws_test "WebSocket end-to-end test" "ws://127.0.0.1:$PORT/ws"
else
  note "skipping the WebSocket test (no node or check.js found)"
fi

section "DNS and web server"
if [ -n "$DOMAIN" ]; then
  DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
  if [ -z "$DNS_IP" ]; then
    fail "$DOMAIN does not resolve (create a DNS A record pointing at this server)"
  else
    LOCAL_IPS="$(hostname -I 2>/dev/null)"
    case " $LOCAL_IPS " in
      *" $DNS_IP "*) pass "$DOMAIN resolves to this server ($DNS_IP)" ;;
      *) note "$DOMAIN resolves to $DNS_IP; this server's addresses are: ${LOCAL_IPS:-unknown} (fine if you use a floating IP or proxy)" ;;
    esac
  fi
else
  note "no domain known; pass --domain to check the web server part"
fi

if command -v nginx >/dev/null 2>&1; then
  if out="$(nginx -t 2>&1)"; then pass "nginx -t: configuration is valid"
  else fail "nginx -t reports a problem: $(printf '%s' "$out" | tr '\n' ' ')"; fi
  if [ -n "$DOMAIN" ]; then
    if nginx -T 2>/dev/null | grep -Eq "server_name[[:space:]]+[^;]*[[:space:]]?${DOMAIN//./\\.}[[:space:];]"; then pass "nginx has a site for $DOMAIN"
    else fail "nginx has no site for $DOMAIN"; fi
  fi
else
  note "nginx is not installed here (other web server in use?)"
fi

if [ -n "$DOMAIN" ]; then
  # --resolve points the name at this machine, so this tests THIS server even if DNS isn't ready or points elsewhere
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/healthz" 2>/dev/null)"
  case "$code" in
    200) pass "http://$DOMAIN/healthz through the web server: 200" ;;
    301|302|308) pass "http://$DOMAIN redirects to HTTPS ($code)" ;;
    *) fail "http://$DOMAIN/healthz through the web server returned '$code'" ;;
  esac

  if [ "$TLS" != 0 ]; then
    if [ "$(curl -fsS -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" 2>/dev/null)" = "ok" ]; then
      pass "https://$DOMAIN/healthz works with a valid certificate"
    else
      fail "https://$DOMAIN/healthz failed (certificate or proxy problem)"
    fi

    end="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -n "$end" ]; then
      days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
      if [ "$days" -ge 14 ]; then pass "certificate valid for another $days days"
      else fail "certificate expires in $days days (check: sudo certbot renew --dry-run)"; fi
    else
      fail "could not read the certificate served for $DOMAIN"
    fi

    if systemctl list-timers --all 2>/dev/null | grep -q certbot || [ -e /etc/cron.d/certbot ]; then
      note "automatic certificate renewal is scheduled (certbot timer or cron). To test it: sudo certbot renew --dry-run"
    else
      note "no certbot renewal timer found. Certificates last 90 days, so check: systemctl list-timers | grep certbot, and: sudo certbot renew --dry-run"
    fi

    if have_node_test; then
      section "Live rooms through nginx and HTTPS"
      ws_test "secure WebSocket through the proxy" "wss://$DOMAIN/ws" --ip 127.0.0.1
    fi
  elif have_node_test; then
    section "Live rooms through nginx (plain HTTP)"
    ws_test "WebSocket through the proxy" "ws://$DOMAIN/ws" --ip 127.0.0.1
  fi
fi

if [ -n "$MAIN_SITE" ] && [ "$MAIN_SITE" != "$DOMAIN" ]; then
  section "Your other site"
  scheme=https
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$MAIN_SITE:443:127.0.0.1" "https://$MAIN_SITE/" 2>/dev/null)"
  if [ "$code" = 000 ] || [ -z "$code" ]; then
    scheme=http
    code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$MAIN_SITE:80:127.0.0.1" "http://$MAIN_SITE/" 2>/dev/null)"
  fi
  case "$code" in
    2*|3*) pass "$scheme://$MAIN_SITE/ still answers ($code)" ;;
    *) fail "$scheme://$MAIN_SITE/ answered '$code' (if you didn't expect this, tell me; it may or may not be related)" ;;
  esac
fi

section "Storage and logs"
if [ -d /var/lib/spin-the-wheel ]; then
  note "rooms folder: $(stat -c '%A owner=%U' /var/lib/spin-the-wheel); rooms.json is $(stat -c %s /var/lib/spin-the-wheel/rooms.json 2>/dev/null || echo 0) bytes"
else
  note "/var/lib/spin-the-wheel doesn't exist yet (created when the service first starts)"
fi
if command -v journalctl >/dev/null 2>&1; then
  printf '  last log lines of the service:\n'
  journalctl -u "$SERVICE" -n 12 --no-pager 2>&1 | sed 's/^/        /'
fi

section "Summary"
if [ "$FAIL" -eq 0 ]; then
  printf '  All %d checks passed.\n' "$PASS"
  exit 0
fi
printf '  %d passed, %d FAILED. Paste this whole output to get help.\n' "$PASS" "$FAIL"
exit 1
