/**
 * Single pages — Biography, Contact, … (docs/API.md §3.2).
 *
 * Pages are studio-wide (there is no `content.page.read_all`): every signed-in
 * user may read them, `content.page.write` may edit them, and moving one to
 * `published`/`archived` additionally needs `content.page.publish`.
 */
import { Router } from 'express'
import { z } from 'zod'
import { all, get, run } from '../db.js'
import { record } from '../audit.js'
import { asyncHandler, notFound, parseBody } from '../errors.js'
import { applyPublishedAt, assertStatusTransition, requireAuth, requirePermission } from '../middleware.js'
import { STATUSES, nowIso, toPage } from '../serialize.js'

const ENTITY = 'page'
const PREFIX = 'content.page'

const router = Router()
router.use(requireAuth)

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: z.enum(['article', 'contact']).optional(),
  body: z.string().max(500000).optional(),
  data: z.record(z.unknown()).optional(),
  status: z.enum(STATUSES).optional(),
})

async function loadPage(slug) {
  return await get('SELECT * FROM pages WHERE slug = ?', [slug])
}

/* ------------------------------------------------------------------ list -- */

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await all('SELECT * FROM pages ORDER BY slug ASC')
    res.json(rows.map((row) => toPage(row)))
  }),
)

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const row = await loadPage(req.params.slug)
    if (!row) throw notFound('No such page')
    res.json(toPage(row))
  }),
)

router.patch(
  '/:slug',
  requirePermission(`${PREFIX}.write`),
  asyncHandler(async (req, res) => {
    const row = await loadPage(req.params.slug)
    if (!row) throw notFound('No such page')

    const data = parseBody(patchSchema, req.body)
    if (data.status !== undefined && data.status !== row.status) {
      // published/archived ⇒ content.page.publish; draft/review ⇒ content.page.write
      assertStatusTransition(req.user, PREFIX, data.status)
    }

    const sets = []
    const args = []
    if (data.title !== undefined) {
      sets.push('title = ?')
      args.push(data.title)
    }
    if (data.kind !== undefined) {
      sets.push('kind = ?')
      args.push(data.kind)
    }
    if (data.body !== undefined) {
      sets.push('body = ?')
      args.push(data.body)
    }
    if (data.data !== undefined) {
      sets.push('data = ?')
      args.push(JSON.stringify(data.data))
    }
    if (data.status !== undefined) {
      sets.push('status = ?', 'published_at = ?')
      args.push(data.status, applyPublishedAt(row.published_at, data.status))
    }

    if (sets.length) {
      sets.push('updated_at = ?')
      args.push(nowIso(), row.slug)
      await run(`UPDATE pages SET ${sets.join(', ')} WHERE slug = ?`, args)
    }

    await record(req.user.id, data.status ? 'status' : 'update', ENTITY, row.id, {
      fields: Object.keys(data),
      ...(data.status !== undefined && data.status !== row.status
        ? { status: { from: row.status, to: data.status } }
        : {}),
    })
    res.json(toPage(await loadPage(row.slug)))
  }),
)

export default router
