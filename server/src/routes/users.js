/**
 * People (docs/API.md §3.2): list, invite, update.
 *
 * `role.assign` is a separate permission from `user.update`, so an `editor`
 * who may read people cannot silently promote themselves.
 */
import { Router } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { all, get, insertReturningId, run } from '../db.js'
import { record } from '../audit.js'
import { asyncHandler, badRequest, conflict, forbidden, notFound, parseBody } from '../errors.js'
import {
  assertPermission,
  likeTerm,
  paging,
  requireAuth,
  requirePermission,
  statusParam,
} from '../middleware.js'
import { ROLE_KEYS, roleExists } from '../permissions.js'
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

/* ---------------------------------------------------------------- invite -- */

router.post(
  '/',
  requirePermission('user.invite'),
  asyncHandler(async (req, res) => {
    const data = parseBody(createSchema, req.body)
    const existing = await get('SELECT id FROM users WHERE lower(email) = lower(?)', [data.email])
    if (existing) throw conflict('That email is already in use', { email: data.email })
    if (!roleExists(data.role)) throw badRequest(`Unknown role: ${data.role}`, { role: data.role })

    const now = nowIso()
    const inviteToken = crypto.randomBytes(24).toString('base64url')
    const id = await insertReturningId(
      `INSERT INTO users
         (email, name, avatar_url, password_hash, role_key, status, invited_by, invite_token, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, 'invited', ?, ?, ?, ?)`,
      [data.email, data.name, data.role, req.user.id, inviteToken, now, now],
    )

    await record(req.user.id, 'invite', ENTITY, id, { email: data.email, role: data.role })
    const row = await get('SELECT * FROM users WHERE id = ?', [id])
    res.status(201).json({ ...toUser(row), inviteToken })
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
