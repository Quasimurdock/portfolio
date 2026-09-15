/**
 * Passwords, sessions and cookies.
 *
 * - passwords: scrypt with a per-user random salt
 * - session tokens: 32 random bytes, stored **only** as sha256(token_hash)
 * - cookies: `value.hmac-sha256(value)` so a tampered cookie is simply ignored
 */
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { config } from './config.js'
import { get, run } from './db.js'

export const SID_COOKIE = 'sid'
export const WX_STATE_COOKIE = 'wx_state'
export const WX_REDIRECT_COOKIE = 'wx_redirect'

const SCRYPT_KEYLEN = 64
const DAY_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------- passwords -- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  let expected
  try {
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (expected.length === 0) return false
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(expected, actual)
}

/* -------------------------------------------------------------- cookies -- */

/** Hand-rolled `Cookie:` header parser (no cookie-parser dependency). */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || !header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    let value = part.slice(eq + 1).trim()
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export function serializeCookie(name, value, options = {}) {
  const {
    maxAge,
    path: cookiePath = '/',
    httpOnly = true,
    sameSite = 'Lax',
    secure = config.https,
  } = options
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`]
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`)
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (sameSite) parts.push(`SameSite=${sameSite}`)
  return parts.join('; ')
}

export function clearCookie(name, options = {}) {
  return `${serializeCookie(name, '', { ...options, maxAge: 0 })}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

function hmac(value) {
  return crypto.createHmac('sha256', config.cookieSecret).update(value).digest('base64url')
}

/** `value.signature` */
export function signCookie(value) {
  return `${value}.${hmac(value)}`
}

/** Returns the value, or null when the signature is missing/wrong. */
export function unsignCookie(raw) {
  if (typeof raw !== 'string' || !raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return null
  const value = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)
  const expected = hmac(value)
  if (signature.length !== expected.length) return null
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return value
}

/** Constant-time string compare for OAuth state values. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/* ------------------------------------------------------------- sessions -- */

/**
 * Mint a session for `userId` and return the raw cookie token (never stored).
 * @returns {{ token: string, expiresAt: string }}
 */
export async function createSession(userId, { userAgent = null, ip = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const expires = new Date(now.getTime() + config.sessionTtlDays * DAY_MS)
  await run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sha256(token), userId, now.toISOString(), expires.toISOString(), trim(userAgent, 300), trim(ip, 64)],
  )
  return { token, expiresAt: expires.toISOString() }
}

function trim(value, max) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > max ? text.slice(0, max) : text
}

export async function revokeSession(token) {
  if (!token) return 0
  return (await run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)])).changes
}

export async function revokeAllSessions(userId) {
  return (await run('DELETE FROM sessions WHERE user_id = ?', [userId])).changes
}

export async function pruneExpiredSessions() {
  try {
    return (await run('DELETE FROM sessions WHERE expires_at <= ?', [new Date().toISOString()])).changes
  } catch {
    return 0
  }
}

/** The cookie value behind `sid`, or null when absent/forged. */
export function sessionTokenFrom(req) {
  const cookies = req.cookies ?? parseCookies(req.headers?.cookie)
  return unsignCookie(cookies?.[SID_COOKIE] ?? null)
}

/**
 * Resolve the caller. Returns the user row (with `permissions`) or null.
 * Anonymous, forged, expired and disabled sessions all collapse to null.
 */
export async function currentUser(req) {
  if (req.__userResolved) return req.user
  req.__userResolved = true
  req.user = null

  const token = sessionTokenFrom(req)
  if (!token) return null

  const tokenHash = sha256(token)
  let row
  try {
    row = await get(
      `SELECT s.token_hash, s.expires_at,
              u.id, u.email, u.name, u.avatar_url, u.role_key, u.status,
              u.wechat_nickname, u.wechat_avatar, u.created_at, u.last_login_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [tokenHash],
    )
  } catch {
    return null
  }

  if (!row) return null
  if (row.expires_at <= new Date().toISOString()) {
    await run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash])
    return null
  }
  if (row.status !== 'active') return null

  req.session = { token, tokenHash, expiresAt: row.expires_at }
  req.user = row
  return row
}
