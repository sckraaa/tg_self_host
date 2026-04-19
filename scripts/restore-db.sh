#!/usr/bin/env bash
# restore-db.sh — restore SQLite database and optionally uploads
# Usage: ./scripts/restore-db.sh <db_backup.db> [uploads_backup.tar.gz]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

DB_FILE="${1:-}"
UPLOADS_FILE="${2:-}"

if [ -z "$DB_FILE" ]; then
  echo "Usage: $0 <db_backup.db> [uploads_backup.tar.gz]"
  echo ""
  echo "Example:"
  echo "  $0 backups/telegram_20250101_120000.db backups/uploads_20250101_120000.tar.gz"
  exit 1
fi

if [ ! -f "$DB_FILE" ]; then
  echo "Error: DB file not found: $DB_FILE"
  exit 1
fi

echo "[restore] Stopping backend..."
docker compose stop backend

echo "[restore] Restoring database from $DB_FILE..."
docker compose cp "$DB_FILE" backend:/app/db/telegram.db
echo "[restore] Database restored."

if [ -n "$UPLOADS_FILE" ]; then
  if [ ! -f "$UPLOADS_FILE" ]; then
    echo "Error: uploads file not found: $UPLOADS_FILE"
    exit 1
  fi
  echo "[restore] Restoring uploads from $UPLOADS_FILE..."
  docker compose run --rm -T \
    --entrypoint "tar xzf - -C /" \
    backend < "$UPLOADS_FILE"
  echo "[restore] Uploads restored."
fi

echo "[restore] Starting backend..."
docker compose start backend
echo "[restore] Done."
