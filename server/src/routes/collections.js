/**
 * Collections — series and albums (docs/API.md §3.2).
 * Same ownership rules as articles, keyed on `collections.author_id`.
 */
import { Router } from 'express'
import { z } from 'zod'
import { all, get, insertReturningId, run } from '../db.js'
import { record } from '../audit.js'
import { asyncHandler, notFound, parseBody } from '../errors.js'
import {
  assertCanTouch,
  assertStatusTransition,
  applyPublishedAt,
  likeTerm,
  ownershipClause,
  paging,
  requireAuth,
  requirePermission,
  scopeParam,
  statusParam,
} from '../middleware.js'
import { STATUSES, nowIso, paged, slugify, toCollection } from '../serialize.js'
import { parseId, requireImage, requireSection, uniqueSlug } from './_shared.js'

const ENTITY = 'collection'
const PREFIX = 'content.collection'
const READ_ALL = `${PREFIX}.read_all`

const router = Router()
router.use(requireAuth)

const base = {
  slug: z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug'),
  title: z.string().trim().min(1).max(300),
  sectionKey: z.string().trim().min(1).max(120),
  kind: z.enum(['series', 'album']),
  summary: z.string().max(4000),
  coverImageId: z.number().int().positive().nullable(),
  place: z.string().trim().max(200).nullable(),
  year: z.number().int().min(1500).max(2200).nullable(),
  position: z.number().int().min(-1_000_000).max(1_000_000),
  status: z.enum(STATUSES),
}

const createSchema = z.object({
  slug: base.slug.optional(),
  title: base.title,
  sectionKey: base.sectionKey,
  kind: base.kind.optional(),
  summary: base.summary.optional(),
  coverImageId: base.coverImageId.optional(),
  place: base.place.optional(),
  year: base.year.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const patchSchema = z.object({
  slug: base.slug.optional(),
  title: base.title.optional(),
  sectionKey: base.sectionKey.optional(),
  kind: base.kind.optional(),
  summary: base.summary.optional(),
  coverImageId: base.coverImageId.optional(),
  place: base.place.optional(),
  year: base.year.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const statusSchema = z.object({ status: z.enum(STATUSES) })

const SELECT_ONE = `SELECT c.*,
                           u.name AS author_name,
                           (SELECT COUNT(*) FROM images i WHERE i.collection_id = c.id) AS image_count
                      FROM collections c
                      JOIN users u ON u.id = c.author_id
                     WHERE c.id = ?`

const SELECT_MANY = `SELECT c.*,
                            u.name AS author_name,
                            (SELECT COUNT(*) FROM images i WHERE i.collection_id = c.id) AS image_count
                       FROM collections c
                       JOIN users u ON u.id = c.author_id`

async function loadCollection(id) {
  return await get(SELECT_ONE, [id])
}

/** Resolve `cover` — the explicit cover, else the first image of the collection. */
async function coverFor(row) {
  if (!row) return null
  if (row.cover_image_id) {
    const explicit = await get('SELECT * FROM images WHERE id = ?', [row.cover_image_id])
    if (explicit) return explicit
  }
  return (await get('SELECT * FROM images WHERE collection_id = ? ORDER BY position ASC, id ASC LIMIT 1', [row.id])) ?? null
}

async function respond(row) {
  return toCollection(row, { cover: await coverFor(row), imageCount: row.image_count ?? undefined })
}

const READ_OPTIONS = { readAll: READ_ALL, alsoAny: [`${PREFIX}.publish`] }

/* ------------------------------------------------------------------ list -- */

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = ['1 = 1']
    const args = []

    const scope = ownershipClause(req.user, {
      readAll: READ_ALL,
      table: 'c.',
      scope: scopeParam(req.query.scope),
    })
    if (scope.sql) where.push(scope.sql.replace(/^\s*AND\s*/, ''))
    args.push(...scope.params)

    const status = statusParam(req.query.status)
    if (status) {
      where.push('c.status = ?')
      args.push(status)
    }
    if (req.query.section) {
      where.push('c.section_key = ?')
      args.push(String(req.query.section))
    }
    if (req.query.q) {
      const term = likeTerm(req.query.q)
      where.push(`(lower(c.title) LIKE lower(?) ESCAPE '\\' OR lower(c.summary) LIKE lower(?) ESCAPE '\\' OR lower(c.slug) LIKE lower(?) ESCAPE '\\')`)
      args.push(term, term, term)
    }

    const clause = where.join(' AND ')
    const total = (await get(`SELECT COUNT(*) AS n FROM collections c WHERE ${clause}`, args)).n
    const { page, pageSize, offset } = paging(req.query)
    const rows = await all(
      `${SELECT_MANY} WHERE ${clause} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )

    res.json(paged(rows.map((row) => toCollection(row, { imageCount: row.image_count })), total, page, pageSize))
  }),
)

/* ---------------------------------------------------------------- create -- */

router.post(
  '/',
  requirePermission(`${PREFIX}.write`),
  asyncHandler(async (req, res) => {
    const data = parseBody(createSchema, req.body)
    await requireSection(data.sectionKey)
    await requireImage(data.coverImageId ?? null)

    const status = data.status ?? 'draft'
    if (status !== 'draft') assertStatusTransition(req.user, PREFIX, status)

    const slug = data.slug ?? (await uniqueSlug('collections', slugify(data.title)))
    const now = nowIso()
    const id = await insertReturningId(
      `INSERT INTO collections
         (slug, title, section_key, kind, summary, cover_image_id, place, year, status,
          position, author_id, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        data.title,
        data.sectionKey,
        data.kind ?? 'series',
        data.summary ?? '',
        data.coverImageId ?? null,
        data.place ?? null,
        data.year ?? null,
        status,
        data.position ?? 0,
        req.user.id,
        applyPublishedAt(null, status),
        now,
        now,
      ],
    )

    await record(req.user.id, 'create', ENTITY, id, { slug, status, sectionKey: data.sectionKey })
    res.status(201).json(await respond(await loadCollection(id)))
  }),
)

/* ------------------------------------------------------------------ read -- */

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await loadCollection(id)
    if (!row) throw notFound('No such collection')
    assertCanTouch(row, req.user, { readAll: READ_ALL })
    res.json(await respond(row))
  }),
)

/* ---------------------------------------------------------------- update -- */

router.patch(
  '/:id',
  requirePermission(`${PREFIX}.write`),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await loadCollection(id)
    if (!row) throw notFound('No such collection')
    assertCanTouch(row, req.user, READ_OPTIONS)

    const data = parseBody(patchSchema, req.body)
    if (data.sectionKey !== undefined) await requireSection(data.sectionKey)
    if (data.coverImageId !== undefined) await requireImage(data.coverImageId)
    if (data.slug !== undefined && data.slug !== row.slug) {
      data.slug = await uniqueSlug('collections', data.slug, id)
    }
    if (data.status !== undefined && data.status !== row.status) {
      assertStatusTransition(req.user, PREFIX, data.status)
    }

    const sets = []
    const args = []
    const columns = {
      slug: 'slug',
      title: 'title',
      sectionKey: 'section_key',
      kind: 'kind',
      summary: 'summary',
      coverImageId: 'cover_image_id',
      place: 'place',
      year: 'year',
      position: 'position',
      status: 'status',
    }
    for (const [field, column] of Object.entries(columns)) {
      if (data[field] === undefined) continue
      sets.push(`${column} = ?`)
      args.push(data[field])
    }
    if (data.status !== undefined) {
      sets.push('published_at = ?')
      args.push(applyPublishedAt(row.published_at, data.status))
    }

    if (sets.length) {
      sets.push('updated_at = ?')
      args.push(nowIso(), id)
      await run(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, args)
    }

    await record(req.user.id, 'update', ENTITY, id, {
      fields: Object.keys(data),
      ...(data.status !== undefined && data.status !== row.status
        ? { status: { from: row.status, to: data.status } }
        : {}),
    })
    res.json(await respond(await loadCollection(id)))
  }),
)

/* ---------------------------------------------------------------- status -- */

router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const { status } = parseBody(statusSchema, req.body)

    const row = await loadCollection(id)
    if (!row) throw notFound('No such collection')

    assertStatusTransition(req.user, PREFIX, status)
    assertCanTouch(row, req.user, READ_OPTIONS)

    if (status !== row.status) {
      await run('UPDATE collections SET status = ?, published_at = ?, updated_at = ? WHERE id = ?', [
        status,
        applyPublishedAt(row.published_at, status),
        nowIso(),
        id,
      ])
    }

    const action = status === 'published' ? 'publish' : status === 'archived' ? 'archive' : 'status'
    await record(req.user.id, action, ENTITY, id, { from: row.status, to: status })
    res.json(await respond(await loadCollection(id)))
  }),
)

/* ---------------------------------------------------------------- delete -- */

router.delete(
  '/:id',
  requirePermission(`${PREFIX}.delete`),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await loadCollection(id)
    if (!row) throw notFound('No such collection')
    assertCanTouch(row, req.user, READ_OPTIONS)

    await run('DELETE FROM collections WHERE id = ?', [id])
    await record(req.user.id, 'delete', ENTITY, id, { slug: row.slug, title: row.title, status: row.status })
    res.status(204).end()
  }),
)

export default router
