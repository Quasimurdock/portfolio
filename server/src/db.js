/**
 * SQLite handle + the only place raw statements are prepared.
 *
 * `schema.sql` is authoritative and is applied idempotently on boot
 * (every statement in it is `CREATE ... IF NOT EXISTS` / `PRAGMA`).
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config, DATA_DIR } from './config.js'

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(config.databaseFile)

/* --------------------------------------------------------------- pragmas -- */
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

/* ----------------------------------------------------------------- schema -- */
const SCHEMA_FILE = path.join(config.serverRoot, 'src', 'schema.sql')

export function applySchema() {
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'))
}

let initialised = false
/** Open + migrate. Safe to call from both index.js and seed.js. */
export function initDb() {
  if (!initialised) {
    applySchema()
    initialised = true
  }
  return db
}

/* ----------------------------------------------------------------- helpers -- */

function bind(stmt, params) {
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params)
}

/** Run a SELECT and return every row. `params` may be an array or a named bag. */
export function all(sql, params = []) {
  return bind(db.prepare(sql), params)
}

/** Run a SELECT and return the first row (or undefined). */
export function get(sql, params = []) {
  if (Array.isArray(params)) return db.prepare(sql).get(...params)
  return db.prepare(sql).get(params)
}

/** Run a write. Returns `{ changes, lastInsertRowid }`. */
export function run(sql, params = []) {
  const stmt = db.prepare(sql)
  return Array.isArray(params) ? stmt.run(...params) : stmt.run(params)
}

/** Id of the row most recently inserted on this connection. */
export function lastId() {
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
}

/** Run `fn` inside a transaction (better-sqlite3 transactions are synchronous). */
export function tx(fn, ...args) {
  return db.transaction(fn)(...args)
}

/**
 * Drop every table this project owns and re-apply the schema — used by
 * `node src/seed.js --reset`. Foreign keys are suspended for the duration.
 */
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

export function resetDatabase() {
  db.pragma('foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`)
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','images','collections','articles','feed_items','pages','audit_logs')")
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
  applySchema()
}
