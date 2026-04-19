#!/usr/bin/env bash
# backup-db.sh — backup SQLite database and uploaded files
# Usage: ./scripts/backup-db.sh [output_dir]
# Example: BACKUP_DIR=/mnt/backups ./scripts/backup-db.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

DB_BACKUP="$BACKUP_DIR/telegram_${TIMESTAMP}.db"
UPLOADS_BACKUP="$BACKUP_DIR/uploads_${TIMESTAMP}.tar.gz"

echo "[backup] Backing up database..."
docker compose cp backend:/app/db/telegram.db "$DB_BACKUP"
echo "[backup] DB saved → $DB_BACKUP"

echo "[backup] Backing up uploads..."
if docker compose exec -T backend sh -c "ls /app/uploads 2>/dev/null | head -1" | grep -q .; then
  docker compose exec -T backend tar czf - /app/uploads 2>/dev/null > "$UPLOADS_BACKUP"
  echo "[backup] Uploads saved → $UPLOADS_BACKUP"
else
  echo "[backup] No uploads directory or empty — skipping."
fi

echo "[backup] Done. Files:"
ls -lh "$BACKUP_DIR"/telegram_"${TIMESTAMP}"* "$BACKUP_DIR"/uploads_"${TIMESTAMP}"* 2>/dev/null || true
