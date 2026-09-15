/**
 * Direct browser → OSS uploads (docs/API.md §3.4).
 *
 * The server never touches image bytes: it only mints a short-lived policy the
 * browser posts straight to the bucket. Two providers:
 *
 *  - `mock`   → `upload.url = /api/uploads/mock`, no credentials needed, so the
 *               admin UI can be exercised end to end offline.
 *  - `aliyun` → OSS V1 POST policy: base64 policy + base64(HMAC-SHA1(policy)).
 */
import crypto from 'node:crypto'
import { config } from './config.js'
import { ApiError } from './errors.js'

const POLICY_TTL_SECONDS = 3600
const EXTENSION = /[^a-z0-9]/g

/** `uploads/2026/03/9f0c…-4a1b.jpg` */
export function buildObjectKey(filename, now = new Date()) {
  const year = String(now.getUTCFullYear())
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const rawExt = String(filename ?? '').split('.').pop() ?? ''
  const ext = rawExt.toLowerCase().replace(EXTENSION, '').slice(0, 8)
  const id = crypto.randomUUID()
  const dir = String(config.oss.dir ?? 'uploads').replace(/^\/+|\/+$/g, '') || 'uploads'
  return ext ? `${dir}/${year}/${month}/${id}.${ext}` : `${dir}/${year}/${month}/${id}`
}

export function publicUrlFor(key) {
  const base = String(config.oss.publicBase ?? '').replace(/\/+$/, '')
  if (base) return `${base}/${key}`
  return `${bucketHost()}/${key}`
}

function bucketHost() {
  return `https://${config.oss.bucket}.${config.oss.region}.aliyuncs.com`
}

/**
 * @param {{ filename: string, contentType: string, size: number }} input
 * @returns {{ provider: string, key: string, publicUrl: string, upload: object, maxBytes: number }}
 */
export function signUpload({ filename, contentType, size }) {
  const maxBytes = config.oss.maxBytes
  if (typeof size === 'number' && Number.isFinite(size) && size > maxBytes) {
    throw new ApiError(413, 'payload_too_large', `Files may be at most ${maxBytes} bytes`, { maxBytes, size })
  }

  const key = buildObjectKey(filename)
  const publicUrl = publicUrlFor(key)

  if (config.oss.provider === 'aliyun') {
    return signAliyun({ key, publicUrl, contentType, maxBytes })
  }
  return {
    provider: 'mock',
    key,
    publicUrl,
    upload: {
      url: '/api/uploads/mock',
      method: 'POST',
      fields: { key, success_action_status: '200' },
    },
    maxBytes,
  }
}

function signAliyun({ key, publicUrl, contentType, maxBytes }) {
  const { accessKeyId, accessKeySecret } = config.oss
  if (!accessKeyId || !accessKeySecret) {
    throw new ApiError(
      500,
      'oss_not_configured',
      'OSS_PROVIDER=aliyun requires OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET',
    )
  }

  const expiration = new Date(Date.now() + POLICY_TTL_SECONDS * 1000).toISOString()
  const conditions = [['content-length-range', 0, maxBytes], ['eq', '$key', key]]
  if (contentType) conditions.push(['eq', '$Content-Type', contentType])
  const policy = { expiration, conditions }
  const encodedPolicy = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64')
  const signature = crypto.createHmac('sha1', accessKeySecret).update(encodedPolicy).digest('base64')

  const fields = {
    key,
    OSSAccessKeyId: accessKeyId,
    policy: encodedPolicy,
    signature,
    success_action_status: '200',
  }
  if (contentType) fields['Content-Type'] = contentType

  return {
    provider: 'aliyun',
    key,
    publicUrl,
    upload: { url: bucketHost(), method: 'POST', fields },
    maxBytes,
  }
}

/**
 * Dev-only stand-in for the bucket. It stores nothing — it drains the request
 * and echoes back what OSS would have replied, so the admin UI's upload flow
 * can be driven without credentials.
 */
export function mockUploadResult(req) {
  const key =
    req.query?.key ??
    req.headers['x-oss-key'] ??
    buildObjectKey('upload.bin')
  return {
    ok: true,
    provider: 'mock',
    key: String(key),
    publicUrl: publicUrlFor(String(key)),
    note: 'mock receiver — no bytes were stored',
  }
}

/** Resolve where a mock upload was "stored". */
export function isMockProvider() {
  return config.oss.provider !== 'aliyun'
}
