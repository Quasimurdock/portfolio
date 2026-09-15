/**
 * SQLite driver — local development, tests, and self-hosted deployments.
 *
 * Uses `node:sqlite`, which is built into Deno (>= 2.2) and Node (>= 22.5), so
 * there is no native addon to compile any more. Its API is synchronous; the
 * async shape this module exposes is what the rest of the app sees.
 *
 * Concurrency: the engine has exactly one connection, so a transaction that
 * awaits can be "entered" by another request's statement. Two guards prevent
 * that — a mutex so only one transaction runs at a time, and a gate that parks
 * unrelated statements until the open transaction commits. Without them a
 * request could silently become part of somebody else's transaction.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import { config, DATA_DIR, SERVER_ROOT } from '../config.js'

const SCHEMA_FILE = path.join(SERVER_ROOT, 'src', 'schema.sql')

/** Every table this project owns, in drop order (children first). */
const TABLES = [
  'audit_logs',
  'feed_items',
  'pages',
  'articles',
  'images',
  'collections',
  'sections',
  'sessions',
  'users',
  'role_permissions',
  'permissions',
  'roles',
]

/** The transaction running on *this* async context, if any. */
const txStore = new AsyncLocalStorage()

let handle_ = null
/** Whether `schema.sql` has been applied on this connection. */
let schemaReady = false
/** Non-null while a transaction holds the connection. */
let openTx = null
/** Serialises transactions against each other. */
let mutex = Promise.resolve()

/**
 * Open the connection if it is not open yet. Idempotent, and deliberately does
 * **not** apply the schema: `resetDatabase()` needs a connection before it can
 * drop anything, and the previous implementation had one from module load, so
 * requiring `initDb()` first would silently break `seed.js --reset`.
 */
function open() {
  if (handle_) return handle_
  fs.mkdirSync(DATA_DIR, { recursive: true })
  handle_ = new DatabaseSync(config.databaseFile)
  // `PRAGMA` is not a method on node:sqlite's DatabaseSync, unlike better-sqlite3.
  handle_.exec('PRAGMA journal_mode = WAL')
  handle_.exec('PRAGMA foreign_keys = ON')
  handle_.exec('PRAGMA busy_timeout = 5000')
  return handle_
}

export const name = 'sqlite'

/* ------------------------------------------------------------- lifecycle -- */

export async function init() {
  open()
  if (schemaReady) return
  applySchema()
  schemaReady = true
}

export async function close() {
  if (!handle_) return
  handle_.close()
  handle_ = null
  schemaReady = false
}

/** `schema.sql` is authoritative and idempotent (`CREATE … IF NOT EXISTS`). */
export function applySchema() {
  open().exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
}

/* ------------------------------------------------------------- statements -- */

/** `params` is always an array here (see the note in `db.js`). */
function bind(stmt, params) {
  if (!Array.isArray(params)) {
    throw new Error('named parameters are not supported; use positional `?`')
  }
  return params
}

/**
 * Run one statement, making sure it cannot land inside an unrelated open
 * transaction. Inside our own transaction we go straight through.
 */
async function statement(kind, sql, params) {
  while (openTx && txStore.getStore() !== openTx) await openTx.done
  const stmt = open().prepare(sql)
  const args = bind(stmt, params)
  if (kind === 'all') return stmt.all(...args)
  if (kind === 'get') return stmt.get(...args)
  return stmt.run(...args)
}

export async function all(sql, params = []) {
  return statement('all', sql, params)
}

export async function get(sql, params = []) {
  return statement('get', sql, params)
}

export async function run(sql, params = []) {
  return statement('run', sql, params)
}

/**
 * `INSERT` → the new row's id. `run()` already reports `lastInsertRowid` from
 * the same synchronous call, so this is atomic without a second query.
 */
export async function insertReturningId(sql, params = []) {
  const result = await statement('run', sql, params)
  return Number(result.lastInsertRowid)
}

/** Raw multi-statement execution (schema application, migrations). */
export async function exec(sql) {
  while (openTx && txStore.getStore() !== openTx) await openTx.done
  open().exec(sql)
}

/* ----------------------------------------------------------- transactions -- */

/**
 * Run `fn` inside a transaction. `fn` is awaited; every `all` / `get` / `run`
 * it performs joins the transaction automatically, so callers never thread a
 * client through their own arguments.
 */
export async function tx(fn) {
  // Chain onto the mutex so two transactions can never interleave.
  const previous = mutex
  let releaseMutex
  mutex = new Promise((resolve) => {
    releaseMutex = resolve
  })
  await previous

  // Statements from other requests park on `done` until we commit or roll back.
  let releaseGate
  const done = new Promise((resolve) => {
    releaseGate = resolve
  })
  const ctx = { done }
  openTx = ctx

  open().exec('BEGIN')
  try {
    const result = await txStore.run(ctx, fn)
    open().exec('COMMIT')
    return result
  } catch (error) {
    open().exec('ROLLBACK')
    throw error
  } finally {
    openTx = null
    releaseGate()
    releaseMutex()
  }
}

/* ---------------------------------------------------------------- reset --- */

/**
 * Drop every table and re-apply the schema — `deno task reset` / tests only.
 * Foreign keys are suspended for the duration, mirroring the old behaviour.
 */
export async function reset() {
  const h = open()
  h.exec('PRAGMA foreign_keys = OFF')
  try {
    h.exec('BEGIN')
    for (const table of TABLES) h.exec(`DROP TABLE IF EXISTS ${table}`)
    try {
      h.exec(
        "DELETE FROM sqlite_sequence WHERE name IN ('users','images','collections','articles','feed_items','pages','audit_logs')",
      )
    } catch {
      // sqlite_sequence does not exist until an AUTOINCREMENT table has been created.
    }
    h.exec('COMMIT')
  } catch (error) {
    h.exec('ROLLBACK')
    throw error
  } finally {
    h.exec('PRAGMA foreign_keys = ON')
  }
  applySchema()
  schemaReady = true
}
