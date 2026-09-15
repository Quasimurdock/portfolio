/**
 * The back-office dashboard (docs/API.md §3.2) — `GET /api/admin/overview`.
 *
 * Counts are scoped exactly like the lists themselves: an `author` sees its own
 * numbers, anyone with the matching `*.read_all` sees the studio's.
 * `users` is blanked out without `user.read`.
 */
import { Router } from 'express'
import { all, get } from '../db.js'
import { asyncHandler } from '../errors.js'
import { hasPermission, ownershipClause, requireAuth } from '../middleware.js'
import { STATUSES, toAuditEntry } from '../serialize.js'

const router = Router()
router.use(requireAuth)

/** entity → table, ownership column, and the *.read_all that widens the scope. */
const ENTITIES = [
  { entity: 'article', table: 'articles', column: 'author_id', readAll: 'content.article.read_all', title: 'title' },
  {
    entity: 'collection',
    table: 'collections',
    column: 'author_id',
    readAll: 'content.collection.read_all',
    title: 'title',
  },
  { entity: 'image', table: 'images', column: 'owner_id', readAll: 'content.image.read_all', title: 'caption' },
  // feed_items and pages are studio-wide: no *.read_all exists for them
  { entity: 'feed_item', table: 'feed_items', column: 'author_id', readAll: null, title: 'caption' },
  { entity: 'page', table: 'pages', column: 'author_id', readAll: null, title: 'title' },
]

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const counts = []

    for (const spec of ENTITIES) {
      const scope = ownershipClause(req.user, { readAll: spec.readAll, column: spec.column })
      const clause = scope.sql ? scope.sql.replace(/^\s*AND\s*/, '') : '1 = 1'
      const args = scope.params

      const totals = new Map(
        (await all(`SELECT status, COUNT(*) AS n FROM ${spec.table} WHERE ${clause} GROUP BY status`, args)).map(
          (row) => [row.status, row.n],
        ),
      )
      let total = 0
      for (const status of STATUSES) {
        const n = totals.get(status) ?? 0
        total += n
        counts.push({ entity: spec.entity, status, n })
      }
      counts.push({ entity: spec.entity, status: 'total', n: total })
    }

    // My drafts / in-review rows, across every content table I own.
    const myDrafts = []
    for (const spec of ENTITIES) {
      const rows = await all(
        `SELECT ${spec.title} AS title, id, status, updated_at
           FROM ${spec.table}
          WHERE ${spec.column} = ? AND status IN ('draft','review')
          ORDER BY updated_at DESC
          LIMIT 5`,
        [req.user.id],
      )
      for (const row of rows) {
        myDrafts.push({
          entity: spec.entity,
          id: Number(row.id),
          title: row.title ?? `#${row.id}`,
          status: row.status,
          updatedAt: row.updated_at,
        })
      }
    }
    myDrafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))

    const recent = (await all(
      `SELECT l.*, u.name AS user_name
         FROM audit_logs l
         LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 10`,
    )).map((row) => toAuditEntry(row))

    let users = { total: 0, byRole: [] }
    if (hasPermission(req.user, 'user.read')) {
      const byRole = (await all(
        'SELECT role_key AS role, COUNT(*) AS n FROM users GROUP BY role_key ORDER BY n DESC',
      )).map((row) => ({ role: row.role, n: row.n }))
      const total = (await get('SELECT COUNT(*) AS n FROM users')).n
      users = { total, byRole }
    }

    res.json({ counts, myDrafts: myDrafts.slice(0, 10), recent, users })
  }),
)

export default router
