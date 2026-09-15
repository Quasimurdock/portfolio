/**
 * The curated home slideshow (docs/API.md §3.2).
 *
 * `content.feed.manage` is a single, global permission — there is no
 * `content.feed.read_all` — so the list is intentionally *not* scoped to the
 * caller: whoever may manage the feed sees all of it.
 */
import { Router } from 'express'
import { z } from 'zod'
import { all, get, run } from '../db.js'
import { record } from '../audit.js'
import { asyncHandler, badRequest, notFound, parseBody } from '../errors.js'
import { paging, requireAuth, requirePermission, statusParam, assertStatusTransition } from '../middleware.js'
import { STATUSES, nowIso, paged, toFeedItem } from '../serialize.js'
import { parseId } from './_shared.js'

const ENTITY = 'feed_item'
const MANAGE = 'content.feed.manage'
const LINK_KINDS = ['collection', 'article', 'external', 'none']

const router = Router()
router.use(requireAuth, requirePermission(MANAGE))

const base = {
  imageId: z.number().int().positive(),
  caption: z.string().max(2000),
  linkKind: z.enum(LINK_KINDS),
  linkUrl: z.string().trim().max(2000).nullable(),
  targetCollectionId: z.number().int().positive().nullable(),
  targetArticleId: z.number().int().positive().nullable(),
  position: z.number().int().min(-1_000_000).max(1_000_000),
  status: z.enum(STATUSES),
}

const createSchema = z.object({
  imageId: base.imageId,
  caption: base.caption.optional(),
  linkKind: base.linkKind.optional(),
  linkUrl: base.linkUrl.optional(),
  targetCollectionId: base.targetCollectionId.optional(),
  targetArticleId: base.targetArticleId.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const patchSchema = z.object({
  imageId: base.imageId.optional(),
  caption: base.caption.optional(),
  linkKind: base.linkKind.optional(),
  linkUrl: base.linkUrl.optional(),
  targetCollectionId: base.targetCollectionId.optional(),
  targetArticleId: base.targetArticleId.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const SELECT_ONE = `SELECT f.*, u.name AS author_name FROM feed_items f JOIN users u ON u.id = f.author_id WHERE f.id = ?`
const SELECT_MANY = `SELECT f.*, u.name AS author_name FROM feed_items f JOIN users u ON u.id = f.author_id`

function loadItem(id) {
  return get(SELECT_ONE, [id])
}

function imageFor(imageId) {
  return imageId ? get('SELECT * FROM images WHERE id = ?', [imageId]) : null
}

/** References must exist before we write them — SQLite would only say "FK". */
function checkReferences(data) {
  if (data.imageId !== undefined) {
    if (!imageFor(data.imageId)) throw badRequest(`Unknown imageId: ${data.imageId}`, { imageId: data.imageId })
  }
  if (data.targetCollectionId) {
    const row = get('SELECT id FROM collections WHERE id = ?', [data.targetCollectionId])
    if (!row) throw badRequest(`Unknown targetCollectionId: ${data.targetCollectionId}`)
  }
  if (data.targetArticleId) {
    const row = get('SELECT id FROM articles WHERE id = ?', [data.targetArticleId])
    if (!row) throw badRequest(`Unknown targetArticleId: ${data.targetArticleId}`)
  }
}

/* ------------------------------------------------------------------ list -- */

router.get(
  '/',
  asyncHandler((req, res) => {
    const where = ['1 = 1']
    const args = []
    const status = statusParam(req.query.status)
    if (status) {
      where.push('f.status = ?')
      args.push(status)
    }
    const clause = where.join(' AND ')
    const total = get(`SELECT COUNT(*) AS n FROM feed_items f WHERE ${clause}`, args).n
    const { page, pageSize, offset } = paging(req.query)
    const rows = all(
      `${SELECT_MANY} WHERE ${clause} ORDER BY f.position ASC, f.id ASC LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )
    res.json(paged(rows.map((row) => toFeedItem(row, { image: imageFor(row.image_id) })), total, page, pageSize))
  }),
)

/* ---------------------------------------------------------------- create -- */

router.post(
  '/',
  asyncHandler((req, res) => {
    const data = parseBody(createSchema, req.body)
    checkReferences(data)
    const status = data.status ?? 'published'
    assertStatusTransition(req.user, null, status)

    const now = nowIso()
    const result = run(
      `INSERT INTO feed_items
         (image_id, caption, link_kind, link_url, target_collection_id, target_article_id,
          status, position, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.imageId,
        data.caption ?? '',
        data.linkKind ?? 'collection',
        data.linkUrl ?? null,
        data.targetCollectionId ?? null,
        data.targetArticleId ?? null,
        status,
        data.position ?? 0,
        req.user.id,
        now,
        now,
      ],
    )

    const id = Number(result.lastInsertRowid)
    record(req.user.id, 'create', ENTITY, id, { imageId: data.imageId })
    const row = loadItem(id)
    res.status(201).json(toFeedItem(row, { image: imageFor(row.image_id) }))
  }),
)

/* ---------------------------------------------------------------- update -- */

router.patch(
  '/:id',
  asyncHandler((req, res) => {
    const id = parseId(req.params.id)
    const row = loadItem(id)
    if (!row) throw notFound('No such feed item')

    const data = parseBody(patchSchema, req.body)
    checkReferences(data)

    const sets = []
    const args = []
    const columns = {
      imageId: 'image_id',
      caption: 'caption',
      linkKind: 'link_kind',
      linkUrl: 'link_url',
      targetCollectionId: 'target_collection_id',
      targetArticleId: 'target_article_id',
      position: 'position',
      status: 'status',
    }
    for (const [field, column] of Object.entries(columns)) {
      if (data[field] === undefined) continue
      sets.push(`${column} = ?`)
      args.push(data[field])
    }
    if (sets.length) {
      sets.push('updated_at = ?')
      args.push(nowIso(), id)
      run(`UPDATE feed_items SET ${sets.join(', ')} WHERE id = ?`, args)
    }

    record(req.user.id, 'update', ENTITY, id, {
      fields: Object.keys(data),
      ...(data.status !== undefined && data.status !== row.status
        ? { status: { from: row.status, to: data.status } }
        : {}),
    })
    const fresh = loadItem(id)
    res.json(toFeedItem(fresh, { image: imageFor(fresh.image_id) }))
  }),
)

/* ---------------------------------------------------------------- delete -- */

router.delete(
  '/:id',
  asyncHandler((req, res) => {
    const id = parseId(req.params.id)
    const row = loadItem(id)
    if (!row) throw notFound('No such feed item')

    run('DELETE FROM feed_items WHERE id = ?', [id])
    record(req.user.id, 'delete', ENTITY, id, { imageId: row.image_id })
    res.status(204).end()
  }),
)

export default router
