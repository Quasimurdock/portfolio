/**
 * Postgres driver — Deno Deploy, and anything else with a real database server.
 *
 * Deno Deploy gives every instance its own isolated, ephemeral disk, so a SQLite
 * file can never be the source of truth there. `DB_DRIVER=postgres` is what
 * makes the deployment stateless.
 *
 * Connection details are read from `DATABASE_URL`, or from the standard `PGHOST`
 * / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` variables that Deno Deploy
 * injects when a database is attached — `pg` picks those up on its own.
 *
 * `?` stays the project-wide placeholder spelling; `toPositional()` rewrites it
 * to `$1..$n` here, so no route ever has to know which engine is underneath.
 */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { config, onDenoDeploy, SERVER_ROOT } from '../config.js'

const SCHEMA_FILE = path.join(SERVER_ROOT, 'src', 'schema.postgres.sql')

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

/** The client owned by the transaction running on this async context. */
const txStore = new AsyncLocalStorage()

/**
 * `node-postgres` hands back `int8` (OID 20) as a **string**, to protect values
 * beyond `Number.MAX_SAFE_INTEGER`. In this schema the only `int8` that ever
 * reaches JavaScript is a `COUNT(*)`, and every list payload has always reported
 * `total` as a number — so parse it here, once, instead of sprinkling
 * `Number(total)` through the routes (where it is easy to miss one and silently
 * change the JSON shape on Postgres but not on SQLite).
 */
pg.types.setTypeParser(20, (value) => Number(value))

let pool = null
/** Whether `schema.postgres.sql` has been applied against this pool. */
let schemaReady = false

export const name = 'postgres'

/**
 * Rewrite `?` placeholders to `$1, $2, …`.
 *
 * The scan skips everything where a `?` is data rather than a placeholder:
 * single-quoted strings (`''` escapes a quote), double-quoted identifiers,
 * `$tag$ … $tag$` dollar-quoted bodies, `--` line comments and block comments.
 * The JSONB existence operators `?`, `?|` and `?&` are left alone too — this
 * schema stores JSON as `TEXT`, but a future `jsonb` column should not break.
 */
export function toPositional(sql) {
  let out = ''
  let index = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    const next = sql[i + 1]

    // -- line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1) return out + sql.slice(i)
      out += sql.slice(i, end)
      i = end
      continue
    }

    // /* block comment */
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return out + sql.slice(i)
      out += sql.slice(i, end + 2)
      i = end + 2
      continue
    }

    // 'string literal'
    if (ch === "'") {
      let j = i + 1
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }

    // "quoted identifier"
    if (ch === '"') {
      let j = i + 1
      while (j < len) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }

    // $tag$ dollar-quoted body $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length)
        if (end !== -1) {
          const stop = end + tag[0].length
          out += sql.slice(i, stop)
          i = stop
          continue
        }
      }
      out += ch
      i += 1
      continue
    }

    // ? placeholder (but not the JSONB operators ?| ?&)
    if (ch === '?') {
      if (next === '|' || next === '&' || next === '?') {
        out += ch
        i += 1
        continue
      }
      index += 1
      out += `$${index}`
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/* ------------------------------------------------------------- lifecycle -- */

/**
 * Create the pool if it does not exist yet. Idempotent, and deliberately does
 * not touch the schema — `resetDatabase()` needs a pool before it can drop
 * anything, so requiring `initDb()` first would silently break `seed.js --reset`.
 */
function open() {
  if (pool) return pool

  // `pg` silently falls back to localhost:5432 when it is handed no connection
  // details at all. On Deno Deploy that is guaranteed to fail, and the resulting
  // `ECONNREFUSED 127.0.0.1:5432` points at a database that was never supposed
  // to exist instead of at the real problem: nothing is attached to the app.
  const hasEnvConnection =
    Boolean(process.env.PGHOST) || Boolean(process.env.PGDATABASE) || Boolean(process.env.PGUSER)
  if (onDenoDeploy && !config.databaseUrl && !hasEnvConnection) {
    throw new Error(
      'DB_DRIVER=postgres but there are no connection details: DATABASE_URL is empty and ' +
        'PGHOST / PGDATABASE are unset, so `pg` would try localhost:5432 — which does not exist on ' +
        'Deno Deploy. Attach a database to this app (app settings → Databases → Attach Database, ' +
        'then pick or provision a Postgres instance) and redeploy: the platform then injects ' +
        'DATABASE_URL plus PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE on its own.',
    )
  }

  const ssl =
    config.pgSsl === 'no-verify' ? { rejectUnauthorized: false } : config.pgSsl === 'require' ? true : undefined
  pool = new pg.Pool({
    connectionString: config.databaseUrl || undefined,
    max: config.pgPoolMax,
    idleTimeoutMillis: 10_000,
    ...(ssl === undefined ? {} : { ssl }),
  })
  return pool
}

export async function init() {
  open()
  if (schemaReady) return
  // Fail loudly at boot rather than on the first request.
  try {
    await pool.query('SELECT 1')
  } catch (error) {
    if (!onDenoDeploy) throw error
    throw new Error(
      `${error.message}\n` +
        '  This is Deno Deploy: confirm a Postgres database is attached to this app and that its ' +
        'connection variables reach this environment (the Production context, not only Build).',
      { cause: error },
    )
  }
  if (config.dbAutoSchema) await applySchema()
  schemaReady = true
}

export async function close() {
  if (!pool) return
  await pool.end()
  pool = null
  schemaReady = false
}

function handle() {
  return open()
}

/** Inside a transaction every statement must use that transaction's client. */
function query(text, values) {
  const client = txStore.getStore()
  return client ? client.query(text, values) : handle().query(text, values)
}

function prepare(sql, params) {
  if (!Array.isArray(params)) {
    throw new Error('named parameters are not supported; use positional `?`')
  }
  return { text: toPositional(sql), values: params }
}

/** `schema.postgres.sql` is authoritative and idempotent. */
export async function applySchema() {
  await query(fs.readFileSync(SCHEMA_FILE, 'utf8'))
}

/* ------------------------------------------------------------- statements -- */

export async function all(sql, params = []) {
  const { text, values } = prepare(sql, params)
  return (await query(text, values)).rows
}

export async function get(sql, params = []) {
  const { text, values } = prepare(sql, params)
  return (await query(text, values)).rows[0]
}

/** Postgres has no "last insert rowid", so that field is always null here. */
export async function run(sql, params = []) {
  const { text, values } = prepare(sql, params)
  const result = await query(text, values)
  return { changes: result.rowCount ?? 0, lastInsertRowid: null }
}

/** `INSERT` → the new row's id, via `RETURNING id`. */
export async function insertReturningId(sql, params = []) {
  const withReturning = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`
  const { text, values } = prepare(withReturning, params)
  const result = await query(text, values)
  return Number(result.rows[0].id)
}

/** Raw multi-statement execution (schema application, migrations). */
export async function exec(sql) {
  await query(sql, undefined)
}

/* ----------------------------------------------------------- transactions -- */

/**
 * Run `fn` on a dedicated client inside a transaction. Because the client rides
 * an AsyncLocalStorage context, every `all` / `get` / `run` inside `fn` uses it
 * automatically — the single most common way to get transactions wrong in a
 * port like this is to forget to thread the client through by hand.
 */
export async function tx(fn) {
  const client = await handle().connect()
  try {
    await client.query('BEGIN')
    const result = await txStore.run(client, fn)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection may already be gone; the original error is the useful one.
    }
    throw error
  } finally {
    client.release()
  }
}

/* ----------------------------------------------------------------- reset -- */

/** Drop every table and re-apply the schema — tests only. */
export async function reset() {
  open()
  for (const table of TABLES) {
    await query(`DROP TABLE IF EXISTS ${table} CASCADE`)
  }
  await applySchema()
  schemaReady = true
}
