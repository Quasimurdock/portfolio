/**
 * Configuration.
 *
 * `server/.env` is parsed by hand (no dotenv dependency). Real environment
 * variables always win over the file, so `PORT=9000 node src/index.js` behaves
 * as expected. Every key and default is documented in docs/API.md §4 and in
 * server/.env.example.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `server/` — the directory that holds package.json, .env, data/, src/. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal KEY=VALUE reader: comments, blank lines, optional quotes, `export `. */
function parseEnvFile(file) {
  const out = {}
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice('export '.length).trim()
    if (!key) continue
    let value = line.slice(eq + 1).trim()
    const quoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

const fileEnv = parseEnvFile(path.join(SERVER_ROOT, '.env'))

/** process.env → server/.env → undefined (empty strings count as unset). */
function raw(key) {
  const fromProcess = process.env[key]
  if (typeof fromProcess === 'string' && fromProcess !== '') return fromProcess
  const fromFile = fileEnv[key]
  if (typeof fromFile === 'string' && fromFile !== '') return fromFile
  return undefined
}

function str(key, fallback) {
  const value = raw(key)
  return value === undefined ? fallback : value
}

function int(key, fallback) {
  const parsed = Number.parseInt(raw(key) ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(key, fallback) {
  const value = raw(key)
  if (value === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

const port = int('PORT', 8787)
const databaseFile = str('DATABASE_FILE', './data/app.db')
const staticDir = str('STATIC_DIR', '../web/dist')
const wechatAppId = str('WECHAT_APP_ID', '')
const dbDriver = str('DB_DRIVER', 'sqlite').toLowerCase() === 'postgres' ? 'postgres' : 'sqlite'
const databaseUrl = str('DATABASE_URL', '')

export const config = {
  env: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV', 'development') === 'production',
  port,
  serverRoot: SERVER_ROOT,
  /**
   * `sqlite` (default) or `postgres`.
   *
   * Deno Deploy gives each instance its own isolated, ephemeral disk, so a
   * SQLite file cannot be the source of truth there — a deployment on Deno
   * Deploy runs `DB_DRIVER=postgres` against an attached database. Locally and
   * self-hosted, the default keeps working with no server at all.
   */
  dbDriver,
  databaseFile: path.isAbsolute(databaseFile) ? databaseFile : path.resolve(SERVER_ROOT, databaseFile),
  /**
   * Postgres connection string. Leave it empty to let `pg` read the standard
   * `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` variables that
   * Deno Deploy injects when a database is attached to the app.
   */
  databaseUrl,
  /** Apply the schema on boot. Turn off once a migration step owns the schema. */
  dbAutoSchema: bool('DB_AUTO_SCHEMA', true),
  pgPoolMax: int('PG_POOL_MAX', 5),
  /** `''` | `require` (verify the cert) | `no-verify` (accept a self-signed one). */
  pgSsl: str('PGSSL', ''),
  /**
   * The built SPA (`web/dist`). Served from this same process — and therefore the
   * same origin as the API — whenever it exists, which is what makes a single
   * container a complete deployment and keeps the session cookie same-site.
   * Set `STATIC_DIR=` (empty) to switch it off and serve the front end elsewhere.
   */
  staticDir: staticDir ? (path.isAbsolute(staticDir) ? staticDir : path.resolve(SERVER_ROOT, staticDir)) : '',
  sessionTtlDays: int('SESSION_TTL_DAYS', 14),
  /** signs the sid + wx_state cookies (HMAC-SHA256) */
  cookieSecret: str('COOKIE_SECRET', 'change-me'),
  /** adds `Secure` to every cookie we set */
  https: bool('HTTPS', false),
  /** enables POST /api/auth/dev-login — never on in production */
  authDev: bool('AUTH_DEV', false),

  oss: {
    provider: str('OSS_PROVIDER', 'mock'),
    bucket: str('OSS_BUCKET', 'portfolio'),
    region: str('OSS_REGION', 'oss-cn-hangzhou'),
    accessKeyId: str('OSS_ACCESS_KEY_ID', ''),
    accessKeySecret: str('OSS_ACCESS_KEY_SECRET', ''),
    publicBase: str('OSS_PUBLIC_BASE', 'https://cdn.example.com'),
    maxBytes: int('OSS_MAX_BYTES', 26214400),
    dir: str('OSS_UPLOAD_DIR', 'uploads'),
  },

  wechat: {
    mode: str('WECHAT_MODE', 'qrconnect'),
    /** default: mock until a real app id is configured, so the flow is testable offline */
    mock: bool('WECHAT_MOCK', wechatAppId === ''),
    appId: wechatAppId,
    appSecret: str('WECHAT_APP_SECRET', ''),
    redirectUri: str('WECHAT_REDIRECT_URI', `http://localhost:${port}/api/auth/wechat/callback`),
    successRedirect: str('WECHAT_SUCCESS_REDIRECT', '/admin'),
    defaultRole: str('WECHAT_DEFAULT_ROLE', 'author'),
  },
}

/** Absolute path of the `data/` directory (created on demand by db.js). */
export const DATA_DIR = path.dirname(config.databaseFile)

/** True when the secret is still the shipped development placeholder. */
export const usingDefaultCookieSecret = config.cookieSecret === 'change-me'

/**
 * True on Deno Deploy, which sets `DENO_DEPLOY=true` for builds, for the
 * pre-deploy command and for the runtime alike.
 *
 * The sanity checks key off this because both of this project's default
 * fallbacks are actively wrong on that platform: every instance has its own
 * isolated ephemeral disk, so a SQLite file cannot hold the data — and `pg`
 * falling back to `localhost:5432` can never resolve, because there is no local
 * database in the sandbox.
 */
export const onDenoDeploy = /^(1|true|yes|on)$/i.test(process.env.DENO_DEPLOY ?? '')
