#!/usr/bin/env bash
#
# Removes Spin the Wheel again. Only removes what deploy/install.sh created; your other sites are not touched.
#
#   sudo /opt/spin-the-wheel/app/deploy/uninstall.sh            # remove the service and the nginx site, keep saved rooms
#   sudo /opt/spin-the-wheel/app/deploy/uninstall.sh --purge    # also delete the app folder, saved rooms and the service user
#
# The Let's Encrypt certificate is left in place (delete it with: sudo certbot delete --cert-name <domain>).

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-/opt/spin-the-wheel}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
ACME_ROOT="${ACME_ROOT:-/var/www/spin-the-wheel-acme}"
STATE_DIR=/var/lib/spin-the-wheel
SERVICE=spin-the-wheel
SERVICE_USER=spinwheel
MARKER="Managed by Spin the Wheel"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

# Refuse to run with anything that isn't a deep, specific path (a safety net against typos in environment overrides)
for p in "$INSTALL_ROOT" "$NGINX_DIR" "$SYSTEMD_DIR" "$ACME_ROOT"; do
  case "$p" in
    /*/*) ;;
    *) echo "Refusing to continue: '$p' is not a specific absolute path" >&2; exit 1 ;;
  esac
done

DOMAIN=""
if [ -f "$INSTALL_ROOT/install.conf" ]; then
  DOMAIN="$(sed -n 's/^DOMAIN=//p' "$INSTALL_ROOT/install.conf" | head -1)"
fi

echo "==> Stopping the service"
systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "${SYSTEMD_DIR:?}/${SERVICE:?}.service"
systemctl daemon-reload 2>/dev/null || true

if [ -n "$DOMAIN" ] && command -v nginx >/dev/null 2>&1; then
  echo "==> Removing the nginx site for $DOMAIN"
  changed=0
  for f in "$NGINX_DIR/sites-available/$DOMAIN" "$NGINX_DIR/conf.d/$DOMAIN.conf"; do
    if [ -f "$f" ] && grep -q "$MARKER" "$f"; then
      rm -f "${f:?}" "${NGINX_DIR:?}/sites-enabled/${DOMAIN:?}"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      echo "    nginx reloaded"
    else
      echo "    nginx -t fails after the removal; run: sudo nginx -t" >&2
    fi
  else
    echo "    no site created by this installer was found"
  fi
fi

if [ "$PURGE" = 1 ]; then
  echo "==> Deleting the app folder, saved rooms and the service user"
  rm -rf "${INSTALL_ROOT:?}" "${STATE_DIR:?}" "${ACME_ROOT:?}"
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" || true; fi
else
  echo "==> Kept $INSTALL_ROOT and $STATE_DIR (saved rooms). Use --purge to delete them too."
fi
echo "Done."
