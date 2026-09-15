/**
 * The data layer — the only place an engine is chosen.
 *
 * Everything exported here is async. That is the price of Postgres, and it is
 * paid exactly once, here, so that `all` / `get` / `run` / `tx` stay the only
 * vocabulary the routes know: the same routes run on `node:sqlite` (local dev,
 * tests, self-hosted) and on Postgres (Deno Deploy) without knowing which.
 *
 * The driver module is imported lazily, so a SQLite deployment never loads the
 * Postgres client — and `npm run dev` keeps working with no database server.
 *
 * `?` is the project-wide placeholder spelling. Every dialect difference lives
 * in a driver, never in a route.
 */
import { config } from './config.js'

/** `sqlite` | `postgres`, from `DB_DRIVER`. */
export const driverName = config.dbDriver === 'postgres' ? 'postgres' : 'sqlite'

/**
 * A one-line description of where the data actually lives: the driver plus the
 * thing that identifies it.
 *
 * Boot logging and the CLI both print this, so neither can end up reporting the
 * SQLite file path while the process is really talking to Postgres — an easy and
 * thoroughly confusing thing to get wrong.
 *
 * Credentials are never included, only host/port/database.
 */
export function describeTarget() {
  if (driverName === 'sqlite') return `sqlite → ${config.databaseFile}`
  if (!config.databaseUrl) return 'postgres → PGHOST/PGDATABASE'
  try {
    const url = new URL(config.databaseUrl)
    return `postgres → ${url.hostname}:${url.port || 5432}${url.pathname}`
  } catch {
    return 'postgres → DATABASE_URL'
  }
}

let active = null

async function driver() {
  if (!active) {
    active = driverName === 'postgres' ? await import('./drivers/postgres.js') : await import('./drivers/sqlite.js')
  }
  return active
}

/** Open the database (and apply the schema) exactly once. */
export async function initDb() {
  return (await driver()).init()
}

/** SELECT → every row. */
export async function all(sql, params = []) {
  return (await driver()).all(sql, params)
}

/** SELECT → the first row, or `undefined`. */
export async function get(sql, params = []) {
  return (await driver()).get(sql, params)
}

/** Write → `{ changes, lastInsertRowid }` (`lastInsertRowid` is null on Postgres). */
export async function run(sql, params = []) {
  return (await driver()).run(sql, params)
}

/**
 * `INSERT` → the id of the row just created, whichever engine is underneath:
 * SQLite reports `last_insert_rowid()`, Postgres appends `RETURNING id`.
 */
export async function insertReturningId(sql, params = []) {
  return (await driver()).insertReturningId(sql, params)
}

/** Raw multi-statement SQL (schema application, migrations). */
export async function exec(sql) {
  return (await driver()).exec(sql)
}

/**
 * Run `fn` inside a transaction and return its result.
 *
 * `fn` is `async`, and every `all` / `get` / `run` it calls joins the
 * transaction automatically — no client is threaded through by hand. Turning
 * `fn` back into a synchronous callback (or leaving a `forEach` in it) silently
 * drops the writes out of the transaction, so keep it `async` and use `for…of`.
 */
export async function tx(fn) {
  return (await driver()).tx(fn)
}

/** Drop every table and re-apply the schema — `deno task reset`, tests. */
export async function resetDatabase() {
  return (await driver()).reset()
}

/** Close the pool or the handle. */
export async function closeDb() {
  return (await driver()).close()
}

/**
 * True when `error` is a unique-constraint violation, on either engine.
 *
 * SQLite reports "UNIQUE constraint failed: …", Postgres reports "duplicate key
 * value violates unique constraint …" with SQLSTATE `23505`. Matching the error
 * *text* in a route therefore works on one engine and silently stops working on
 * the other — the 409 would turn into a 500 and only in production. Ask here
 * instead.
 */
export function isUniqueViolation(error) {
  if (!error) return false
  if (error.code === '23505') return true
  const message = String(error.message ?? '')
  return message.includes('UNIQUE constraint failed') || message.includes('duplicate key value')
}
