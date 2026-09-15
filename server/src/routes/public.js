/**
 * The public site (docs/API.md §3.3). No auth, published rows only.
 *
 * Nothing here ever emits `author_id`, `status`, `oss_key` or draft content —
 * every payload goes through the `{ forPublic: true }` branch of serialize.js.
 */
import { Router } from 'express'
import { all, get } from '../db.js'
import { asyncHandler, notFound } from '../errors.js'
import { toArticle, toCollection, toPage, toSection } from '../serialize.js'

const router = Router()

const PUBLISHED = "status = 'published'"

/* ------------------------------------------------------------------- nav -- */

router.get(
  '/nav',
  asyncHandler(async (_req, res) => {
    const rows = await all('SELECT * FROM sections WHERE visible = 1 ORDER BY position ASC, key ASC')
    res.json(rows.map((row) => toSection(row)))
  }),
)

/* ------------------------------------------------------------------ feed -- */

/** Resolve `link_kind` + target into `{kind, href}` for the slideshow. */
async function resolveLink(row) {
  if (row.link_kind === 'external') {
    return { kind: 'external', href: row.link_url ?? null }
  }
  if (row.link_kind === 'collection' && row.target_collection_id) {
    const target = await get('SELECT slug, section_key FROM collections WHERE id = ? AND status = ?', [
      row.target_collection_id,
      'published',
    ])
    return { kind: 'collection', href: target ? `/${target.section_key}/${target.slug}` : null }
  }
  if (row.link_kind === 'article' && row.target_article_id) {
    const target = await get('SELECT slug, section_key FROM articles WHERE id = ? AND status = ?', [
      row.target_article_id,
      'published',
    ])
    return { kind: 'article', href: target ? `/${target.section_key}/${target.slug}` : null }
  }
  return { kind: row.link_kind ?? 'none', href: null }
}

router.get(
  '/feed',
  asyncHandler(async (_req, res) => {
    const rows = await all(
      `SELECT f.*, i.url, i.thumb_url, i.width, i.height
         FROM feed_items f
         JOIN images i ON i.id = f.image_id
        WHERE f.status = 'published' AND i.status = 'published'
        ORDER BY f.position ASC, f.id ASC`,
    )
    res.json(
      await Promise.all(
        rows.map(async (row) => ({
          id: Number(row.id),
          caption: row.caption ?? '',
          image: {
            url: row.url,
            thumbUrl: row.thumb_url ?? null,
            width: row.width ?? null,
            height: row.height ?? null,
          },
          link: await resolveLink(row),
        })),
      ),
    )
  }),
)

/* --------------------------------------------------------------- sections -- */

/** Explicit cover, else the first published image — mirrors the admin payload. */
async function publicCover(row) {
  if (row.cover_image_id) {
    const explicit = await get(`SELECT * FROM images WHERE id = ? AND ${PUBLISHED}`, [row.cover_image_id])
    if (explicit) return explicit
  }
  return (
    (await get(`SELECT * FROM images WHERE collection_id = ? AND ${PUBLISHED} ORDER BY position ASC, id ASC LIMIT 1`, [
      row.id,
    ])) ?? null
  )
}

router.get(
  '/sections/:key',
  asyncHandler(async (req, res) => {
    const section = await get('SELECT * FROM sections WHERE key = ? AND visible = 1', [req.params.key])
    if (!section) throw notFound('No such section')

    const payload = { section: toSection(section) }

    if (section.kind === 'grid') {
      const rows = await all(
        `SELECT c.*,
                (SELECT COUNT(*) FROM images i WHERE i.collection_id = c.id AND i.status = 'published') AS image_count
           FROM collections c
          WHERE c.section_key = ? AND c.status = 'published'
          ORDER BY c.position ASC, c.id ASC`,
        [section.key],
      )
      payload.collections = await Promise.all(
        rows.map(async (row) =>
          toCollection(row, { forPublic: true, imageCount: row.image_count, cover: await publicCover(row) }),
        ),
      )
    } else if (section.kind === 'list') {
      const rows = await all(
        `SELECT * FROM articles WHERE section_key = ? AND ${PUBLISHED} ORDER BY position ASC, id ASC`,
        [section.key],
      )
      payload.articles = rows.map((row) => toArticle(row, { forPublic: true }))
    }

    res.json(payload)
  }),
)

/* ------------------------------------------------------------ collections -- */

router.get(
  '/collections/:slug',
  asyncHandler(async (req, res) => {
    const row = await get(`SELECT * FROM collections WHERE slug = ? AND ${PUBLISHED}`, [req.params.slug])
    if (!row) throw notFound('No such collection')

    const images = await all(
      `SELECT * FROM images WHERE collection_id = ? AND ${PUBLISHED} ORDER BY position ASC, id ASC`,
      [row.id],
    )
    const cover = (await publicCover(row)) ?? images[0] ?? null

    res.json(toCollection(row, { forPublic: true, images, cover, imageCount: images.length }))
  }),
)

/* --------------------------------------------------------------- articles -- */

router.get(
  '/articles/:slug',
  asyncHandler(async (req, res) => {
    const row = await get(`SELECT * FROM articles WHERE slug = ? AND ${PUBLISHED}`, [req.params.slug])
    if (!row) throw notFound('No such article')

    const cover = row.cover_image_id
      ? await get(`SELECT * FROM images WHERE id = ? AND ${PUBLISHED}`, [row.cover_image_id])
      : null
    res.json(toArticle(row, { forPublic: true, cover: cover ?? null }))
  }),
)

/* ------------------------------------------------------------------ pages -- */

router.get(
  '/pages/:slug',
  asyncHandler(async (req, res) => {
    const row = await get(`SELECT * FROM pages WHERE slug = ? AND ${PUBLISHED}`, [req.params.slug])
    if (!row) throw notFound('No such page')
    res.json(toPage(row, { forPublic: true }))
  }),
)

export default router
