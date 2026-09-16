/**
 * People (docs/API.md §3.2): list, create, update.
 *
 * Accounts are created outright — with a password, active from the first
 * request — rather than by invitation. `role.assign` is still a separate
 * permission from `user.update`, so an `admin` who may add people cannot
 * promote themselves or mint an owner.
 */
import { Router } from 'express'
import { z } from 'zod'
import { all, get, insertReturningId, run } from '../db.js'
import { record } from '../audit.js'
import { generatePassword, hashPassword } from '../auth.js'
import { asyncHandler, badRequest, conflict, forbidden, notFound, parseBody } from '../errors.js'
import {
  assertPermission,
  likeTerm,
  paging,
  requireAuth,
  requirePermission,
  statusParam,
} from '../middleware.js'
import { ROLE_KEYS, roleExists, roleRank } from '../permissions.js'
import { nowIso, paged, toUser } from '../serialize.js'
import { parseId } from './_shared.js'

const ENTITY = 'user'
const USER_STATUSES = ['active', 'invited', 'disabled']

const router = Router()
router.use(requireAuth)

const createSchema = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(40).refine(roleExists, { message: `role must be one of ${ROLE_KEYS.join(', ')}` }),
  /** Omit it and the server generates one; either way it is never stored in the clear. */
  password: z.string().min(8).max(200).optional(),
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(40).optional(),
  status: z.enum(USER_STATUSES).optional(),
})

/* ------------------------------------------------------------------ list -- */

router.get(
  '/',
  requirePermission('user.read'),
  asyncHandler(async (req, res) => {
    const where = ['1 = 1']
    const args = []

    if (req.query.q) {
      const term = likeTerm(req.query.q)
      where.push(`(lower(u.name) LIKE lower(?) ESCAPE '\\' OR lower(u.email) LIKE lower(?) ESCAPE '\\')`)
      args.push(term, term)
    }
    if (req.query.role) {
      where.push('u.role_key = ?')
      args.push(String(req.query.role))
    }
    const status = statusParam(req.query.status)
    if (status && USER_STATUSES.includes(status)) {
      where.push('u.status = ?')
      args.push(status)
    }

    const clause = where.join(' AND ')
    const total = (await get(`SELECT COUNT(*) AS n FROM users u WHERE ${clause}`, args)).n
    const { page, pageSize, offset } = paging(req.query)
    const rows = await all(
      `SELECT u.* FROM users u WHERE ${clause} ORDER BY u.name ASC, u.id ASC LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )
    res.json(paged(rows.map((row) => toUser(row)), total, page, pageSize))
  }),
)

/* ---------------------------------------------------------------- create -- */

router.post(
  '/',
  requirePermission('user.invite'),
  asyncHandler(async (req, res) => {
    const data = parseBody(createSchema, req.body)
    const existing = await get('SELECT id FROM users WHERE lower(email) = lower(?)', [data.email])
    if (existing) throw conflict('That email is already in use', { email: data.email })
    if (!roleExists(data.role)) throw badRequest(`Unknown role: ${data.role}`, { role: data.role })

    // Handing out a role above your own is privilege escalation: an admin may
    // create editors and authors, but only an owner may create another owner.
    // `role.assign` is the permission that draws that line.
    if (roleRank(data.role) > roleRank(req.user.role_key ?? req.user.role)) {
      assertPermission(req.user, 'role.assign')
    }

    const generated = data.password ? null : generatePassword()
    const now = nowIso()
    const id = await insertReturningId(
      `INSERT INTO users
         (email, name, avatar_url, password_hash, role_key, status, invited_by, invite_token, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'active', ?, NULL, ?, ?)`,
      [data.email, data.name, hashPassword(data.password ?? generated), data.role, req.user.id, now, now],
    )

    await record(req.user.id, 'create', ENTITY, id, { email: data.email, role: data.role })
    const row = await get('SELECT * FROM users WHERE id = ?', [id])
    // A generated password comes back exactly once, here, and is never stored.
    res.status(201).json({ ...toUser(row), ...(generated ? { password: generated } : {}) })
  }),
)

/* ---------------------------------------------------------------- update -- */

router.patch(
  '/:id',
  requirePermission('user.update'),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await get('SELECT * FROM users WHERE id = ?', [id])
    if (!row) throw notFound('No such user')

    const data = parseBody(patchSchema, req.body)
    if (data.role !== undefined && data.role !== row.role_key) {
      // Changing somebody's role is a separate capability from updating them.
      assertPermission(req.user, 'role.assign')
      if (!roleExists(data.role)) throw badRequest(`Unknown role: ${data.role}`, { role: data.role })
    }
    if (data.status !== undefined && data.status !== 'active' && id === req.user.id) {
      throw forbidden('You cannot disable your own account')
    }

    const sets = []
    const args = []
    if (data.name !== undefined) {
      sets.push('name = ?')
      args.push(data.name)
    }
    if (data.role !== undefined) {
      sets.push('role_key = ?')
      args.push(data.role)
    }
    if (data.status !== undefined) {
      sets.push('status = ?')
      args.push(data.status)
      if (data.status === 'active') sets.push('invite_token = NULL')
      // a disabled account loses its sessions immediately
      if (data.status === 'disabled') await run('DELETE FROM sessions WHERE user_id = ?', [id])
    }

    if (sets.length) {
      sets.push('updated_at = ?')
      args.push(nowIso(), id)
      await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args)
    }

    await record(req.user.id, 'update', ENTITY, id, { fields: Object.keys(data), ...(data.role ? { role: data.role } : {}) })
    res.json(toUser(await get('SELECT * FROM users WHERE id = ?', [id])))
  }),
)

export default router
