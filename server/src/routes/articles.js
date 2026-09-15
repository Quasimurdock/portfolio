/**
 * Articles (docs/API.md section 3.2).
 *
 * Ownership is enforced in SQL for lists (`ownershipClause`) and by one
 * predicate for detail/update/delete (`assertCanTouch`), so an `author` can
 * never see, read, edit, publish or delete an editor's row.
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
import { STATUSES, nowIso, paged, slugify, toArticle } from '../serialize.js'
import { parseId, requireImage, requireSection, uniqueSlug } from './_shared.js'

const ENTITY = 'article'
const PREFIX = 'content.article'
const READ_ALL = `${PREFIX}.read_all`

const router = Router()
router.use(requireAuth)

const base = {
  slug: z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug'),
  title: z.string().trim().min(1).max(300),
  sectionKey: z.string().trim().min(1).max(120),
  excerpt: z.string().max(4000),
  body: z.string().max(500000),
  coverImageId: z.number().int().positive().nullable(),
  position: z.number().int().min(-1_000_000).max(1_000_000),
  status: z.enum(STATUSES),
}

// `title` + `sectionKey` are required on create; everything else is optional.
const createSchema = z.object({
  slug: base.slug.optional(),
  title: base.title,
  sectionKey: base.sectionKey,
  excerpt: base.excerpt.optional(),
  body: base.body.optional(),
  coverImageId: base.coverImageId.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const patchSchema = z.object({
  slug: base.slug.optional(),
  title: base.title.optional(),
  sectionKey: base.sectionKey.optional(),
  excerpt: base.excerpt.optional(),
  body: base.body.optional(),
  coverImageId: base.coverImageId.optional(),
  position: base.position.optional(),
  status: base.status.optional(),
})

const statusSchema = z.object({ status: z.enum(STATUSES) })

const SELECT_ONE = `SELECT a.*, u.name AS author_name
                      FROM articles a
                      JOIN users u ON u.id = a.author_id
                     WHERE a.id = ?`

async function loadArticle(id) {
  return await get(SELECT_ONE, [id])
}

/** Every article response carries its resolved cover image. */
async function respond(row) {
  const cover = row?.cover_image_id ? await get('SELECT * FROM images WHERE id = ?', [row.cover_image_id]) : null
  return toArticle(row, { cover })
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
      table: 'a.',
      scope: scopeParam(req.query.scope),
    })
    if (scope.sql) where.push(scope.sql.replace(/^\s*AND\s*/, ''))
    args.push(...scope.params)

    const status = statusParam(req.query.status)
    if (status) {
      where.push('a.status = ?')
      args.push(status)
    }
    if (req.query.section) {
      where.push('a.section_key = ?')
      args.push(String(req.query.section))
    }
    if (req.query.q) {
      const term = likeTerm(req.query.q)
      where.push(`(lower(a.title) LIKE lower(?) ESCAPE '\\' OR lower(a.excerpt) LIKE lower(?) ESCAPE '\\' OR lower(a.slug) LIKE lower(?) ESCAPE '\\')`)
      args.push(term, term, term)
    }

    const clause = where.join(' AND ')
    const total = (await get(`SELECT COUNT(*) AS n FROM articles a WHERE ${clause}`, args)).n
    const { page, pageSize, offset } = paging(req.query)
    const rows = await all(
      `SELECT a.*, u.name AS author_name
         FROM articles a
         JOIN users u ON u.id = a.author_id
        WHERE ${clause}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    )

    res.json(paged(rows.map((row) => toArticle(row)), total, page, pageSize))
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
    // Creating straight into a published state needs the publish permission.
    if (status !== 'draft') assertStatusTransition(req.user, PREFIX, status)

    const slug = data.slug ?? (await uniqueSlug('articles', slugify(data.title)))
    const now = nowIso()
    const id = await insertReturningId(
      `INSERT INTO articles
         (slug, title, section_key, excerpt, body, cover_image_id, status, position,
          author_id, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        data.title,
        data.sectionKey,
        data.excerpt ?? '',
        data.body ?? '',
        data.coverImageId ?? null,
        status,
        data.position ?? 0,
        req.user.id,
        applyPublishedAt(null, status),
        now,
        now,
      ],
    )

    await record(req.user.id, 'create', ENTITY, id, { slug, status, sectionKey: data.sectionKey })
    res.status(201).json(await respond(await loadArticle(id)))
  }),
)

/* ------------------------------------------------------------------ read -- */

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await loadArticle(id)
    if (!row) throw notFound('No such article')
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
    const row = await loadArticle(id)
    if (!row) throw notFound('No such article')
    assertCanTouch(row, req.user, READ_OPTIONS)

    const data = parseBody(patchSchema, req.body)
    if (data.sectionKey !== undefined) await requireSection(data.sectionKey)
    if (data.coverImageId !== undefined) await requireImage(data.coverImageId)
    if (data.slug !== undefined && data.slug !== row.slug) {
      data.slug = await uniqueSlug('articles', data.slug, id)
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
      excerpt: 'excerpt',
      body: 'body',
      coverImageId: 'cover_image_id',
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
      await run(`UPDATE articles SET ${sets.join(', ')} WHERE id = ?`, args)
    }

    const changed = Object.keys(data).filter((key) => data[key] !== undefined)
    await record(req.user.id, 'update', ENTITY, id, {
      fields: changed,
      ...(data.status !== undefined && data.status !== row.status
        ? { status: { from: row.status, to: data.status } }
        : {}),
    })
    res.json(await respond(await loadArticle(id)))
  }),
)

/* ---------------------------------------------------------------- status -- */

router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const { status } = parseBody(statusSchema, req.body)

    const row = await loadArticle(id)
    if (!row) throw notFound('No such article')

    // publish/archive -> *.publish; draft/review -> *.write
    assertStatusTransition(req.user, PREFIX, status)
    assertCanTouch(row, req.user, READ_OPTIONS)

    if (status !== row.status) {
      await run('UPDATE articles SET status = ?, published_at = ?, updated_at = ? WHERE id = ?', [
        status,
        applyPublishedAt(row.published_at, status),
        nowIso(),
        id,
      ])
    }

    const action = status === 'published' ? 'publish' : status === 'archived' ? 'archive' : 'status'
    await record(req.user.id, action, ENTITY, id, { from: row.status, to: status })
    res.json(await respond(await loadArticle(id)))
  }),
)

/* ---------------------------------------------------------------- delete -- */

router.delete(
  '/:id',
  requirePermission(`${PREFIX}.delete`),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await loadArticle(id)
    if (!row) throw notFound('No such article')
    assertCanTouch(row, req.user, READ_OPTIONS)

    await run('DELETE FROM articles WHERE id = ?', [id])
    await record(req.user.id, 'delete', ENTITY, id, { slug: row.slug, title: row.title, status: row.status })
    res.status(204).end()
  }),
)

export default router
