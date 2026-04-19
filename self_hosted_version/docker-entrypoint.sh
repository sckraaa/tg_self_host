#!/bin/sh
set -e

# Ensure the SQLite DB directory exists (mounted volume may be empty on first run)
mkdir -p /app/db

exec "$@"
