/**
 * Shared SQL fragments and guards.
 *
 * The three ownership helpers here are the *only* way content routes decide who
 * may see or touch a row — the checks live in SQL (lists) and in one predicate
 * (detail/update/delete), never in the UI.
 */
import { effectivePermissions } from './permissions.js'
import { currentUser } from './auth.js'
import { ApiError, forbidden, unauthorized } from './errors.js'
import { STATUSES, nowIso } from './serialize.js'

/* -------------------------------------------------------------- identity -- */

/** Populates `req.user` (or null). Never throws. */
export async function attachUser(req, _res, next) {
  try {
    await currentUser(req)
  } catch {
    req.user = null
  }
  next()
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized())
  next()
}

/** Permission keys the user holds (owner ⇒ the whole catalogue). */
export function permissionsOf(user) {
  if (!user) return []
  if (Array.isArray(user.permissions)) return user.permissions
  return effectivePermissions(user.role_key ?? user.role)
}

export function hasPermission(user, key) {
  if (!user) return false
  return permissionsOf(user).includes(key)
}

export function assertPermission(user, key) {
  if (!hasPermission(user, key)) {
    throw forbidden(`Missing permission: ${key}`)
  }
}

/** Route guard: the caller must hold *all* of `keys`. */
export function requirePermission(...keys) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    const missing = keys.filter((key) => !hasPermission(req.user, key))
    if (missing.length) return next(forbidden(`Missing permission: ${missing.join(', ')}`))
    next()
  }
}

/* ------------------------------------------------------------- ownership -- */

/**
 * SQL fragment + params restricting a query to the caller's own rows.
 *
 *   const { scope, sql, params } = ownershipClause(user, {
 *     readAll: 'content.article.read_all', table: 'a.',
 *   })
 *   … WHERE 1=1 ${sql} …
 *
 * Without `readAll` the caller always gets `scope: 'mine'`, so `?scope=all` is
 * silently downgraded (docs/API.md §2).
 *
 * @returns {{ scope: 'mine'|'all', sql: string, params: unknown[] }}
 */
export function ownershipClause(user, { readAll = null, column = 'author_id', table = '', scope } = {}) {
  const canReadAll = readAll ? hasPermission(user, readAll) : true
  // `scope=all` is silently downgraded to `mine` without the matching *.read_all
  if (scope === 'all' && canReadAll) return { scope: 'all', sql: '', params: [] }
  return { scope: 'mine', sql: ` AND ${table}${column} = ?`, params: [user.id] }
}

/** True when `user` owns `row`, or holds the matching "read everything" key. */
export function canTouch(row, user, { readAll = null, column = 'author_id', alsoAny = [] } = {}) {
  if (!row || !user) return false
  const ownerId = row[column]
  if (ownerId !== null && ownerId !== undefined && Number(ownerId) === Number(user.id)) return true
  if (readAll && hasPermission(user, readAll)) return true
  return alsoAny.some((key) => hasPermission(user, key))
}

/** Same, but throws 403 instead of returning false. Used by get/update/delete. */
export function assertCanTouch(row, user, options) {
  if (!canTouch(row, user, options)) {
    throw forbidden('This row belongs to another author')
  }
  return row
}

/* ------------------------------------------------------------- paging ---- */

/** Normalise `?page=&pageSize=` into `{ page, pageSize, offset }`. */
export function paging(query, { defaultPageSize = 50, maxPageSize = 200 } = {}) {
  const page = Math.max(1, Number.parseInt(query?.page ?? '', 10) || 1)
  const requested = Number.parseInt(query?.pageSize ?? '', 10) || defaultPageSize
  const pageSize = Math.min(maxPageSize, Math.max(1, requested))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** `%term%` with LIKE wildcards escaped, for use with `ESCAPE '\'`. */
export function likeTerm(term) {
  return `%${String(term).replace(/[\\%_]/g, '\\$&')}%`
}

/* --------------------------------------------------------- transitions ---- */

/**
 * Publishing and archiving need `<prefix>.publish`; moving back to draft or
 * into review only needs the `<prefix>.write` the route already required.
 * Pass `prefix = null` for tables with no publish permission (images, feed).
 */
export function assertStatusTransition(user, prefix, to) {
  if (!prefix) return
  const suffix = to === 'published' || to === 'archived' ? 'publish' : 'write'
  assertPermission(user, `${prefix}.${suffix}`)
}

/**
 * `published_at` is stamped the first time a row enters `published`, kept on
 * archive, and cleared only when the row goes back to `draft`.
 */
export function applyPublishedAt(current, to) {
  if (to === 'published') return current ?? nowIso()
  if (to === 'draft') return null
  return current ?? null
}

/* ------------------------------------------------------------ query bits -- */

/** `?status=` → a validated status, or null when absent. */
export function statusParam(value) {
  if (value === undefined || value === null || value === '') return null
  const status = String(value)
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'validation_error', 'Request payload is invalid', {
      issues: [{ path: 'status', code: 'invalid_enum_value', message: `status must be one of ${STATUSES.join(', ')}` }],
    })
  }
  return status
}

/** `?scope=mine|all` → the raw value (ownershipClause decides what is honoured). */
export function scopeParam(value) {
  return value === 'all' ? 'all' : 'mine'
}
