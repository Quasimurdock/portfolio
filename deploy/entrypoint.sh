#!/bin/sh
# Seed on first boot, then hand over to the server.
#
# The two drivers answer "is this a fresh install?" differently:
#
#   sqlite   → the database is a single file on a volume, so the question is
#              simply "does the file exist?". `seed.js` is idempotent anyway, but
#              skipping it on every restart keeps boot fast and never touches
#              live content.
#   postgres → there is no file to test, and seeding on every boot would keep
#              resurrecting the demo content, so seeding is left to an explicit
#              run of `deno task seed` (or `--reset`) against the same
#              DATABASE_URL.
set -e

if [ "${DB_DRIVER:-sqlite}" = "postgres" ]; then
  echo "[entrypoint] DB_DRIVER=postgres — not seeding automatically; run 'deno task seed' if you want the demo content"
else
  DB="${DATABASE_FILE:-/data/app.db}"

  if [ ! -f "$DB" ]; then
    echo "[entrypoint] no database at $DB — seeding a fresh one"
    deno run --allow-all server/src/seed.js
  else
    echo "[entrypoint] using the existing database at $DB"
  fi
fi

exec deno run --allow-all server/src/index.js
