/**
 * Authentication (docs/API.md §3.1).
 *
 *   POST /login          email + password → session cookie
 *   POST /logout         revoke the cookie's session
 *   GET  /me             the caller, or 401
 *   GET  /wechat/url     authorize URL + state (parked in a signed cookie)
 *   GET  /wechat/callback verify state, exchange code, session, 302
 *   POST /dev-login      AUTH_DEV=1 only — 404 otherwise
 */
import { Router } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { get, lastId, run } from '../db.js'
import { record } from '../audit.js'
import {
  SID_COOKIE,
  WX_REDIRECT_COOKIE,
  WX_STATE_COOKIE,
  clearCookie,
  createSession,
  revokeSession,
  safeEqual,
  serializeCookie,
  sessionTokenFrom,
  signCookie,
  unsignCookie,
  verifyPassword,
} from '../auth.js'
import { asyncHandler, badRequest, forbidden, notFound, parseBody, unauthorized, ApiError } from '../errors.js'
import { effectivePermissions } from '../permissions.js'
import { nowIso, toUser } from '../serialize.js'
import { authorizeUrl, createState, exchangeCode, safeRedirectPath, WECHAT_STATE_TTL_SECONDS } from '../wechat.js'

const router = Router()

const DAY_SECONDS = 24 * 60 * 60

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
})

const devLoginSchema = z.object({
  email: z.string().trim().min(1).max(200),
})

function sessionPayload(row) {
  return { user: toUser(row), permissions: effectivePermissions(row.role_key) }
}

/** Mint a session and hand the browser its signed cookie. */
function startSession(req, res, user) {
  const { token } = createSession(user.id, { userAgent: req.get('user-agent'), ip: req.ip })
  res.append(
    'Set-Cookie',
    serializeCookie(SID_COOKIE, signCookie(token), { maxAge: config.sessionTtlDays * DAY_SECONDS }),
  )
  const now = nowIso()
  run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, user.id])
  return token
}

function endSession(req, res) {
  const token = sessionTokenFrom(req)
  if (token) revokeSession(token)
  res.append('Set-Cookie', clearCookie(SID_COOKIE))
}

/* ----------------------------------------------------------------- login -- */

router.post(
  '/login',
  asyncHandler((req, res) => {
    const { email, password } = parseBody(loginSchema, req.body)
    const user = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email])

    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect')
    }
    if (user.status !== 'active') {
      throw forbidden('This account is not active')
    }

    startSession(req, res, user)
    record(user.id, 'login', 'session', null, { method: 'password' })
    const fresh = get('SELECT * FROM users WHERE id = ?', [user.id])
    res.json(sessionPayload(fresh))
  }),
)

router.post(
  '/logout',
  asyncHandler((req, res) => {
    endSession(req, res)
    res.json({ ok: true })
  }),
)

router.get(
  '/me',
  asyncHandler((req, res) => {
    if (!req.user) throw unauthorized()
    res.json(sessionPayload(req.user))
  }),
)

/* ---------------------------------------------------------------- wechat -- */

router.get(
  '/wechat/url',
  asyncHandler((req, res) => {
    const state = createState()
    const redirect = safeRedirectPath(req.query.redirect)

    res.append(
      'Set-Cookie',
      serializeCookie(WX_STATE_COOKIE, signCookie(state), { maxAge: WECHAT_STATE_TTL_SECONDS }),
    )
    res.append(
      'Set-Cookie',
      serializeCookie(WX_REDIRECT_COOKIE, signCookie(redirect), { maxAge: WECHAT_STATE_TTL_SECONDS }),
    )
    res.json({ url: authorizeUrl(state), state })
  }),
)

router.get(
  '/wechat/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query
    if (typeof code !== 'string' || !code) throw badRequest('Missing `code`')

    const cookies = req.cookies ?? {}
    const expectedState = unsignCookie(cookies[WX_STATE_COOKIE] ?? null)
    const redirect = safeRedirectPath(unsignCookie(cookies[WX_REDIRECT_COOKIE] ?? null))

    // one-shot state: burn it whatever happens next
    res.append('Set-Cookie', clearCookie(WX_STATE_COOKIE))
    res.append('Set-Cookie', clearCookie(WX_REDIRECT_COOKIE))

    if (!expectedState || !safeEqual(expectedState, String(state ?? ''))) {
      throw new ApiError(400, 'state_mismatch', 'The WeChat `state` did not match this browser session')
    }

    const profile = await exchangeCode(code)
    const now = nowIso()

    let user = null
    if (profile.unionid) user = get('SELECT * FROM users WHERE wechat_unionid = ?', [profile.unionid])
    if (!user && profile.openid) user = get('SELECT * FROM users WHERE wechat_openid = ?', [profile.openid])
    if (!user && profile.email) user = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [profile.email])

    if (!user) {
      const role = config.wechat.defaultRole || 'author'
      run(
        `INSERT INTO users
           (email, name, avatar_url, password_hash, role_key, status,
            wechat_openid, wechat_unionid, wechat_nickname, wechat_avatar, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        [
          profile.email ?? null,
          profile.nickname ?? 'WeChat user',
          profile.avatar ?? null,
          role,
          profile.openid ?? null,
          profile.unionid ?? null,
          profile.nickname ?? null,
          profile.avatar ?? null,
          now,
          now,
        ],
      )
      user = get('SELECT * FROM users WHERE id = ?', [lastId()])
      record(user.id, 'invite', 'user', user.id, { via: 'wechat' })
    } else {
      if (user.status !== 'active') throw forbidden('This account is not active')
      run(
        `UPDATE users
            SET wechat_openid = COALESCE(?, wechat_openid),
                wechat_unionid = COALESCE(?, wechat_unionid),
                wechat_nickname = COALESCE(?, wechat_nickname),
                wechat_avatar = COALESCE(?, wechat_avatar),
                avatar_url = COALESCE(avatar_url, ?),
                updated_at = ?
          WHERE id = ?`,
        [
          profile.openid ?? null,
          profile.unionid ?? null,
          profile.nickname ?? null,
          profile.avatar ?? null,
          profile.avatar ?? null,
          now,
          user.id,
        ],
      )
      user = get('SELECT * FROM users WHERE id = ?', [user.id])
    }

    startSession(req, res, user)
    record(user.id, 'login', 'session', null, { method: 'wechat', mode: config.wechat.mode })
    res.redirect(302, redirect)
  }),
)

/* ------------------------------------------------------------- dev login -- */

router.post(
  '/dev-login',
  asyncHandler((req, res) => {
    // The route does not exist at all unless AUTH_DEV=1 (docs/API.md §3.1).
    if (!config.authDev) throw notFound('Not found')

    const { email } = parseBody(devLoginSchema, req.body)
    const user = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email])
    if (!user) throw notFound('No such account')
    if (user.status !== 'active') throw forbidden('This account is not active')

    startSession(req, res, user)
    record(user.id, 'login', 'session', null, { method: 'dev' })
    const fresh = get('SELECT * FROM users WHERE id = ?', [user.id])
    res.json(sessionPayload(fresh))
  }),
)

export default router
