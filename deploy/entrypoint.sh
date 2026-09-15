#!/bin/sh
# Seed on first boot, then hand over to the server.
#
# The database is a single SQLite file on a volume, so "is this a fresh install?"
# is simply "does the file exist?". `seed.js` is idempotent anyway, but skipping
# it on every restart keeps boot fast and never touches live content.
set -e

DB="${DATABASE_FILE:-/data/app.db}"

if [ ! -f "$DB" ]; then
  echo "[entrypoint] no database at $DB — seeding a fresh one"
  node server/src/seed.js
else
  echo "[entrypoint] using the existing database at $DB"
fi

exec node server/src/index.js
