/**
 * Activity log (docs/API.md §3.2) — `GET /api/admin/audit?limit=`.
 * Returns a bare array (the client's `AuditEntry[]`), newest first.
 */
import { Router } from 'express'
import { all } from '../db.js'
import { asyncHandler } from '../errors.js'
import { requireAuth, requirePermission } from '../middleware.js'
import { toAuditEntry } from '../serialize.js'

const router = Router()
router.use(requireAuth, requirePermission('user.read'))

router.get(
  '/',
  asyncHandler((req, res) => {
    const requested = Number.parseInt(req.query.limit ?? '', 10)
    const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, requested)) : 50

    const rows = all(
      `SELECT l.*, u.name AS user_name
         FROM audit_logs l
         LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?`,
      [limit],
    )
    res.json(rows.map((row) => toAuditEntry(row)))
  }),
)

export default router
