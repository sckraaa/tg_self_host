#!/usr/bin/env bash
# setup.sh — one-time setup for pluma self-hosted deployment
# Run this ONCE on your VPS before `docker compose up -d`
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*"; exit 1; }

# ── 1. Check .env ─────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  warn ".env not found — copying from .env.example"
  cp .env.example .env
  error "Please fill in .env (DOMAIN, TELEGRAM_API_ID, TELEGRAM_API_HASH, COTURN_PASS) then re-run setup.sh"
fi

source .env

[ -z "${DOMAIN:-}"           ] && error "DOMAIN is not set in .env"
[ -z "${TELEGRAM_API_ID:-}"  ] && error "TELEGRAM_API_ID is not set in .env"
[ -z "${TELEGRAM_API_HASH:-}" ] && error "TELEGRAM_API_HASH is not set in .env"
[ -z "${COTURN_PASS:-}"      ] && error "COTURN_PASS is not set in .env"

# ── 2. Check dependencies ─────────────────────────────────────────────────
for cmd in node npm docker certbot; do
  command -v "$cmd" >/dev/null 2>&1 || error "'$cmd' is not installed"
done

# ── 3. Generate RSA keys (baked into backend Docker image) ────────────────
info "Generating RSA key pair..."
cd self_hosted_version
npm install --ignore-scripts --silent
node scripts/generate-rsa-keys.cjs
cd ..
info "RSA keys written to self_hosted_version/rsa_private.pem"

# ── 4. Update coturn config with real domain + password ──────────────────
info "Configuring coturn..."
COTURN_USER="${COTURN_USER:-pluma}"
COTURN_PASS="${COTURN_PASS}"

sed -i.bak \
  -e "s|YOUR_DOMAIN|${DOMAIN}|g" \
  -e "s|CHANGE_ME_PASSWORD|${COTURN_PASS}|g" \
  coturn/turnserver.conf

# Try to auto-detect public IP if placeholder is still present
if grep -q "YOUR_SERVER_IP" coturn/turnserver.conf; then
  PUBLIC_IP=$(curl -sf https://api.ipify.org || echo "")
  if [ -n "$PUBLIC_IP" ]; then
    sed -i.bak "s|YOUR_SERVER_IP|${PUBLIC_IP}|g" coturn/turnserver.conf
    info "Set external-ip to ${PUBLIC_IP}"
  else
    warn "Could not auto-detect public IP. Edit coturn/turnserver.conf and set external-ip manually."
  fi
fi

# ── 5. Prepare certbot_www directory (ACME webroot for renewals) ──────────
mkdir -p certbot_www
info "certbot_www/ directory ready for ACME challenges"

# ── 6. Obtain TLS certificate (Let's Encrypt) ────────────────────────────
mkdir -p certs
if [ ! -f "certs/fullchain.pem" ]; then
  info "Obtaining TLS certificate for ${DOMAIN}..."
  certbot certonly --standalone \
    -d "${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    -m "admin@${DOMAIN}" \
    --preferred-challenges http \
    || warn "certbot failed. Copy certs manually to ./certs/fullchain.pem and ./certs/privkey.pem"

  # Symlink certbot output into ./certs/
  CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
  if [ -d "$CERT_DIR" ]; then
    cp -L "${CERT_DIR}/fullchain.pem" certs/fullchain.pem
    cp -L "${CERT_DIR}/privkey.pem"   certs/privkey.pem
    info "Certificates copied to ./certs/"
  fi
else
  info "TLS certs already present, skipping certbot."
fi

# ── 7. Done ───────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Next step:"
echo "    docker compose up -d --build"
echo ""
echo "  Your instance will be available at:"
echo "    https://${DOMAIN}"
echo ""
echo "  To auto-renew TLS certificates, add to crontab (crontab -e):"
echo "    0 3 1 */2 * /bin/bash $(pwd)/scripts/renew-certs.sh >> /var/log/pluma-renew.log 2>&1"
echo ""
