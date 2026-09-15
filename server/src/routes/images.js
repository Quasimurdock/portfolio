/**
 * Images — the library of photographs (docs/API.md §3.2).
 *
 * Ownership is `images.owner_id`. Images carry no `*.publish` permission, so
 * `status` may be changed by anyone holding `content.image.write` on the row.
 */
import { Router } from 'express'
import { z } from 'zod'
import { all, get, run, tx } from '../db.js'
import { record } from '../audit.js'
import { asyncHandler, badRequest, conflict, notFound, parseBody } from '../errors.js'
import {
  assertCanTouch,
  assertStatusTransition,
  likeTerm,
  ownershipClause,
  paging,
  requireAuth,
  requirePermission,
  scopeParam,
  statusParam,
} from '../middleware.js'
import { STATUSES, nowIso, paged, toImage } from '../serialize.js'
import { collectionIdFilter, parseId } from './_shared.js'

const ENTITY = 'image'
const PREFIX = 'content.image'
const READ_ALL = `${PREFIX}.read_all`
const READ_OPTIONS = { readAll: READ_ALL, column: 'owner_id' }

const router = Router()
router.use(requireAuth)

const base = {
  collectionId: z.number().int().positive().nullable(),
  url: z.string().trim().min(1).max(2000),
  thumbUrl: z.string().trim().max(2000).nullable(),
  width: z.number().int().positive().max(100000).nullable(),
  height: z.number().int().positive().max(100000).nullable(),
  bytes: z.number().int().nonnegative().max(5_000_000_000).nullable(),
  format: z.string().trim().max(20).nullable(),
  caption: z.string().max(2000).nullable(),
  alt: z.string().max(2000).nullable(),
  ossProvider: z.string().trim().max(40).nullable(),
  ossKey: z.string().trim().max(500).nullable(),
  position: z.number().int().min(-1_000_000).max(1_000_000),
  status: z.enum(STATUSES),
}

const createSchema = z.object({
  collectionId: base.collectionId.optional(),
  url: base.url,
  thumbUrl: base.thumbUrl.optional(),
  width: base.width.optional(),
  height: base.height.optional(),
  bytes: base.bytes.optional(),
  format: base.format.optional(),
  caption: base.caption.optional(),
  alt: base.alt.optional(),
  ossProvider: base.ossProvider.optional(),
  ossKey: base.ossKey.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const patchSchema = z.object({
  collectionId: base.collectionId.optional(),
  url: base.url.optional(),
  thumbUrl: base.thumbUrl.optional(),
  width: base.width.optional(),
  height: base.height.optional(),
  bytes: base.bytes.optional(),
  format: base.format.optional(),
  caption: base.caption.optional(),
  alt: base.alt.optional(),
  ossProvider: base.ossProvider.optional(),
  ossKey: base.ossKey.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const reorderSchema = z.object({
  collectionId: z.number().int().positive(),
  ids: z.array(z.number().int().positive()).max(1000),
})

function loadImage(id) {
  return get('SELECT * FROM images WHERE id = ?', [id])
}

function requireCollection(collectionId) {
  if (collectionId === null || collectionId === undefined) return null
  const collection = get('SELECT * FROM collections WHERE id = ?', [collectionId])
  if (!collection) throw badRequest(`Unknown collectionId: ${collectionId}`, { collectionId })
  return collection
}

/* ------------------------------------------------------------------ list -- */

router.get(
  '/',
  asyncHandler((req, res) => {
    const where = ['1 = 1']
    const args = []

    const scope = ownershipClause(req.user, {
      readAll: READ_ALL,
      column: 'owner_id',
      table: 'i.',
      scope: scopeParam(req.query.scope),
    })
    if (scope.sql) where.push(scope.sql.replace(/^\s*AND\s*/, ''))
    args.push(...scope.params)

    const status = statusParam(req.query.status)
    if (status) {
      where.push('i.status = ?')
      args.push(status)
    }

    const collection = collectionIdFilter(req.query.collectionId)
    if (collection?.unassigned) where.push('i.collection_id IS NULL')
    else if (collection?.id) {
      where.push('i.collection_id = ?')
      args.push(collection.id)
    }

    if (req.query.q) {
      const term = likeTerm(req.query.q)
      where.push(`(i.caption LIKE ? ESCAPE '\\' OR i.alt LIKE ? ESCAPE '\\' OR i.url LIKE ? ESCAPE '\\')`)
      args.push(term, term, term)
    }

    const clause = where.join(' AND ')
    const total = get(`SELECT COUNT(*) AS n FROM images i WHERE ${clause}`, args).n
    const { page, pageSize, offset } = paging(req.query)
    const rows = all(
      `SELECT i.* FROM images i WHERE ${clause} ORDER BY i.position ASC, i.id ASC LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )

    res.json(paged(rows.map((row) => toImage(row)), total, page, pageSize))
  }),
)

/* --------------------------------------------------------------- reorder -- */

router.post(
  '/reorder',
  requirePermission(`${PREFIX}.write`),
  asyncHandler((req, res) => {
    const { collectionId, ids } = parseBody(reorderSchema, req.body)
    const collection = requireCollection(collectionId)
    if (collection) {
      assertCanTouch(collection, req.user, { readAll: 'content.collection.read_all', alsoAny: ['content.collection.publish'] })
    }

    const touched = []
    tx(() => {
      ids.forEach((id, index) => {
        const row = loadImage(id)
        if (!row) throw badRequest(`Unknown image id: ${id}`, { id })
        assertCanTouch(row, req.user, READ_OPTIONS)
        run('UPDATE images SET position = ?, updated_at = ? WHERE id = ?', [index, nowIso(), id])
        touched.push(id)
      })
    })

    record(req.user.id, 'reorder', ENTITY, collectionId, { collectionId, ids })
    res.json({ ok: true, ids: touched })
  }),
)

/* ---------------------------------------------------------------- create -- */

router.post(
  '/',
  requirePermission(`${PREFIX}.write`),
  asyncHandler((req, res) => {
    const data = parseBody(createSchema, req.body)
    requireCollection(data.collectionId ?? null)

    const now = nowIso()
    const status = data.status ?? 'published'
    assertStatusTransition(req.user, null, status) // images have no *.publish key

    let result
    try {
      result = run(
        `INSERT INTO images
           (collection_id, owner_id, url, thumb_url, width, height, bytes, format, caption, alt,
            oss_provider, oss_key, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.collectionId ?? null,
          req.user.id,
          data.url,
          data.thumbUrl ?? null,
          data.width ?? null,
          data.height ?? null,
          data.bytes ?? null,
          data.format ?? null,
          data.caption ?? null,
          data.alt ?? null,
          data.ossProvider ?? null,
          data.ossKey ?? null,
          status,
          data.position ?? 0,
          now,
          now,
        ],
      )
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw conflict('You already have an image with that URL', { url: data.url })
      }
      throw error
    }

    const id = Number(result.lastInsertRowid)
    record(req.user.id, 'create', ENTITY, id, { url: data.url, collectionId: data.collectionId ?? null })
    res.status(201).json(toImage(loadImage(id)))
  }),
)

/* ------------------------------------------------------------------ read -- */

router.get(
  '/:id',
  asyncHandler((req, res) => {
    const id = parseId(req.params.id)
    const row = loadImage(id)
    if (!row) throw notFound('No such image')
    assertCanTouch(row, req.user, READ_OPTIONS)
    res.json(toImage(row))
  }),
)

/* ---------------------------------------------------------------- update -- */

router.patch(
  '/:id',
  requirePermission(`${PREFIX}.write`),
  asyncHandler((req, res) => {
    const id = parseId(req.params.id)
    const row = loadImage(id)
    if (!row) throw notFound('No such image')
    assertCanTouch(row, req.user, READ_OPTIONS)

    const data = parseBody(patchSchema, req.body)
    if (data.collectionId !== undefined) requireCollection(data.collectionId)

    const sets = []
    const args = []
    const columns = {
      collectionId: 'collection_id',
      url: 'url',
      thumbUrl: 'thumb_url',
      width: 'width',
      height: 'height',
      bytes: 'bytes',
      format: 'format',
      caption: 'caption',
      alt: 'alt',
      ossProvider: 'oss_provider',
      ossKey: 'oss_key',
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
      try {
        run(`UPDATE images SET ${sets.join(', ')} WHERE id = ?`, args)
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
          throw conflict('You already have an image with that URL', { url: data.url })
        }
        throw error
      }
    }

    record(req.user.id, 'update', ENTITY, id, {
      fields: Object.keys(data),
      ...(data.status !== undefined && data.status !== row.status
        ? { status: { from: row.status, to: data.status } }
        : {}),
    })
    res.json(toImage(loadImage(id)))
  }),
)

/* ---------------------------------------------------------------- delete -- */

router.delete(
  '/:id',
  requirePermission(`${PREFIX}.delete`),
  asyncHandler((req, res) => {
    const id = parseId(req.params.id)
    const row = loadImage(id)
    if (!row) throw notFound('No such image')
    assertCanTouch(row, req.user, READ_OPTIONS)

    run('DELETE FROM images WHERE id = ?', [id])
    record(req.user.id, 'delete', ENTITY, id, { url: row.url, collectionId: row.collection_id })
    res.status(204).end()
  }),
)

export default router
