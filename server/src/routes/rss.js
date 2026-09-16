/**
 * The RSS feed (docs/API.md §3.3). `GET /feed.xml`, no auth.
 *
 * Published articles only, newest first. Items link to the same absolute URL
 * the site serves them at (`/{{section}}/{{slug}}`) so a reader's "open in
 * browser" lands on the real page.
 *
 * Absolute URLs need the request's own origin: the same build is served from
 * localhost, from a preview URL and from the production domain, so nothing here
 * may be hardcoded. `app.set('trust proxy', true)` in index.js makes
 * `req.protocol` honour `X-Forwarded-Proto`, which is what Deno Deploy and any
 * reverse proxy send.
 */
import { Router } from 'express'
import { config } from '../config.js'
import { all } from '../db.js'
import { asyncHandler } from '../errors.js'

const router = Router()

/** How many articles the feed carries. Plenty for a reader, cheap to build. */
const LIMIT = 50

/** Escape the five XML entities. Everything interpolated below goes through it. */
function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC 1123 — the format `pubDate` has used since RSS 2.0 was written. */
function pubDate(value) {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString()
}

/** The origin this request arrived on, without a trailing slash. */
function originOf(req) {
  return `${req.protocol}://${req.get('host') ?? ''}`.replace(/\/+$/, '')
}

function itemXml(origin, row) {
  const url = `${origin}/${row.section_key}/${row.slug}`
  return [
    '    <item>',
    `      <title>${xml(row.title)}</title>`,
    `      <link>${xml(url)}</link>`,
    `      <guid isPermaLink="true">${xml(url)}</guid>`,
    `      <pubDate>${pubDate(row.published_at ?? row.created_at)}</pubDate>`,
    `      <description>${xml(row.excerpt)}</description>`,
    '    </item>',
  ].join('\n')
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT slug, title, excerpt, section_key, published_at, created_at
         FROM articles
        WHERE status = 'published'
        ORDER BY COALESCE(published_at, created_at) DESC, id DESC
        LIMIT ?`,
      [LIMIT],
    )

    const origin = originOf(req)
    const self = `${origin}/feed.xml`
    const now = new Date().toUTCString()

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
      '  <channel>',
      `    <title>${xml(config.siteName)}</title>`,
      `    <link>${xml(`${origin}/`)}</link>`,
      `    <description>${xml(`${config.siteName} — latest writing.`)}</description>`,
      '    <language>en</language>',
      `    <lastBuildDate>${now}</lastBuildDate>`,
      `    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>`,
      ...rows.map((row) => itemXml(origin, row)),
      '  </channel>',
      '</rss>',
      '',
    ].join('\n')

    res.set('Content-Type', 'application/rss+xml; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=600')
    res.send(body)
  }),
)

export default router
