/**
 * WeChat login (docs/API.md §3.5).
 *
 * `GET /api/auth/wechat/url` builds the authorize URL and parks a random
 * `state` (plus the post-login redirect) in short-lived signed cookies. The
 * callback verifies the state with a constant-time compare, swaps `code` for
 * `openid`, fetches the profile and hands the route an upsertable identity.
 *
 * `WECHAT_MOCK=1` short-circuits the two network calls with a deterministic
 * fake profile, so the whole flow is testable offline.
 */
import crypto from 'node:crypto'
import { config } from './config.js'
import { ApiError } from './errors.js'

const QRCONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
const OAUTH2 = 'https://open.weixin.qq.com/connect/oauth2/authorize'
const ACCESS_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token'
const USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo'

export const WECHAT_STATE_TTL_SECONDS = 600

/** A fresh, unguessable OAuth state value. */
export function createState() {
  return crypto.randomBytes(16).toString('hex')
}

export function isMock() {
  return Boolean(config.wechat.mock)
}

/**
 * The authorize URL to open in the browser.
 *
 * - `qrconnect` (网站应用, default) → snsapi_login
 * - `mp` (公众号)                   → snsapi_userinfo
 */
export function authorizeUrl(state) {
  const mode = config.wechat.mode === 'mp' ? 'mp' : 'qrconnect'
  const params = new URLSearchParams({
    appid: config.wechat.appId,
    redirect_uri: config.wechat.redirectUri,
    response_type: 'code',
    scope: mode === 'mp' ? 'snsapi_userinfo' : 'snsapi_login',
    state,
  })
  const base = mode === 'mp' ? OAUTH2 : QRCONNECT
  return `${base}?${params.toString()}#wechat_redirect`
}

/** Deterministic fake identity: the same code always maps to the same account. */
export function mockProfile(code) {
  const openid = `mock-openid-${code}`
  return {
    openid,
    unionid: `mock-unionid-${code}`,
    nickname: `Mock ${code}`,
    avatar: `https://picsum.photos/seed/${encodeURIComponent(openid)}/200/200?grayscale`,
    email: null,
    accessToken: 'mock-access-token',
  }
}

async function getJson(url, what) {
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new ApiError(502, 'wechat_unreachable', `Could not reach WeChat (${what}): ${error.message}`)
  }
  if (!response.ok) {
    throw new ApiError(502, 'wechat_error', `WeChat ${what} responded ${response.status}`)
  }
  const payload = await response.json()
  if (payload && payload.errcode) {
    throw new ApiError(502, 'wechat_error', `WeChat ${what} failed: ${payload.errmsg ?? payload.errcode}`)
  }
  return payload
}

/**
 * `code` → access_token/openid → userinfo.
 * @returns {Promise<{openid: string, unionid: string|null, nickname: string|null, avatar: string|null, email: string|null}>}
 */
export async function exchangeCode(code) {
  if (isMock()) return mockProfile(code)

  if (!config.wechat.appId || !config.wechat.appSecret) {
    throw new ApiError(500, 'wechat_not_configured', 'WECHAT_APP_ID and WECHAT_APP_SECRET are required')
  }

  const tokenQuery = new URLSearchParams({
    appid: config.wechat.appId,
    secret: config.wechat.appSecret,
    code,
    grant_type: 'authorization_code',
  })
  const token = await getJson(`${ACCESS_TOKEN_URL}?${tokenQuery.toString()}`, 'access_token')
  if (!token.openid) throw new ApiError(502, 'wechat_error', 'WeChat did not return an openid')

  const userQuery = new URLSearchParams({
    access_token: token.access_token,
    openid: token.openid,
    lang: 'zh_CN',
  })
  const profile = await getJson(`${USERINFO_URL}?${userQuery.toString()}`, 'userinfo')

  return {
    openid: token.openid,
    unionid: profile.unionid ?? token.unionid ?? null,
    nickname: profile.nickname ?? null,
    avatar: profile.headimgurl ?? null,
    email: profile.email ?? null,
  }
}

/**
 * Post-login destination: only same-origin paths are honoured, so `?redirect=`
 * can never be turned into an open redirect.
 */
export function safeRedirectPath(value, fallback = config.wechat.successRedirect) {
  if (typeof value !== 'string' || !value) return fallback
  if (value.length > 500) return fallback
  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback
  return value
}
