#!/usr/bin/env bash
# renew-certs.sh — renew Let's Encrypt TLS certificates without downtime
# Uses certbot webroot method: nginx must be running and port 80 accessible.
# Add to crontab (crontab -e):
#   0 3 1 */2 * /bin/bash /opt/pluma/scripts/renew-certs.sh >> /var/log/pluma-renew.log 2>&1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

source .env

if [ -z "${DOMAIN:-}" ]; then
  echo "Error: DOMAIN is not set in .env"
  exit 1
fi

echo "[renew] $(date): Attempting certificate renewal for ${DOMAIN}..."

# certbot writes ACME challenge tokens to ./certbot_www/
# nginx serves them via /.well-known/acme-challenge/ (see nginx.conf)
certbot renew \
  --webroot \
  --webroot-path="$(pwd)/certbot_www" \
  --quiet

# Copy freshly-renewed symlinked certs to ./certs/ for nginx
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
if [ -d "$CERT_DIR" ]; then
  cp -L "${CERT_DIR}/fullchain.pem" certs/fullchain.pem
  cp -L "${CERT_DIR}/privkey.pem"   certs/privkey.pem
  echo "[renew] Certs copied to ./certs/"

  # Signal nginx to reload without downtime
  docker compose exec -T frontend nginx -s reload
  echo "[renew] nginx reloaded."
else
  echo "[renew] Warning: cert directory ${CERT_DIR} not found — was certbot run via setup.sh?"
  exit 1
fi

echo "[renew] $(date): Done."
