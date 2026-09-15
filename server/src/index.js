/**
 * The express app (docs/API.md §3).
 *
 *   JSON in / JSON out under /api
 *   hand-rolled cookie parsing (no cookie-parser)
 *   request logging that never touches bodies, cookies or headers
 *   one 404 handler and one error handler, both emitting { error: {...} }
 */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { config } from './config.js'
import { initDb } from './db.js'
import { parseCookies, pruneExpiredSessions } from './auth.js'
import { attachUser } from './middleware.js'
import { ApiError } from './errors.js'

import authRoutes from './routes/auth.js'
import articlesRoutes from './routes/articles.js'
import collectionsRoutes from './routes/collections.js'
import imagesRoutes from './routes/images.js'
import feedRoutes from './routes/feed.js'
import pagesRoutes from './routes/pages.js'
import usersRoutes from './routes/users.js'
import rolesRoutes from './routes/roles.js'
import overviewRoutes from './routes/overview.js'
import auditRoutes from './routes/audit.js'
import uploadsRoutes from './routes/uploads.js'
import publicRoutes from './routes/public.js'

export const app = express()

app.disable('x-powered-by')
app.set('trust proxy', true)

/* --------------------------------------------------------------- plumbing -- */

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))

app.use((req, _res, next) => {
  req.cookies = parseCookies(req.headers.cookie)
  next()
})

app.use((req, res, next) => {
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    // Method, path, status, duration — never the body, cookies or headers.
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} ${ms.toFixed(1)}ms`)
  })
  next()
})

app.use(attachUser)

/* ----------------------------------------------------------------- routes -- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: '@portfolio/server', env: config.env })
})

app.use('/api/auth', authRoutes)
app.use('/api/public', publicRoutes)
app.use('/api/uploads', uploadsRoutes)
app.use('/api/admin/overview', overviewRoutes)
app.use('/api/admin/articles', articlesRoutes)
app.use('/api/admin/collections', collectionsRoutes)
app.use('/api/admin/images', imagesRoutes)
app.use('/api/admin/feed-items', feedRoutes)
app.use('/api/admin/pages', pagesRoutes)
app.use('/api/admin/users', usersRoutes)
app.use('/api/admin/roles', rolesRoutes)
app.use('/api/admin/audit', auditRoutes)

/* ------------------------------------------------------------- the site --- */

/**
 * One process, one origin, one port.
 *
 * When a built SPA is present it is served from here, next to the API. That is
 * what makes a single container a whole deployment — and, more importantly, it
 * is what keeps the `sid` cookie same-site: the browser sees the app and the API
 * on the same host, so `SameSite=Lax` sessions work without any CORS or cookie
 * domain juggling. With no build present (a plain dev checkout) the API runs
 * alone and Vite serves the site on :5173.
 */
const staticDir = config.staticDir
const servingSite = Boolean(staticDir) && fs.existsSync(path.join(staticDir, 'index.html'))

if (servingSite) {
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          // the shell must never be cached, or a deploy would not be picked up
          res.setHeader('Cache-Control', 'no-cache')
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // vite hashes these filenames, so they are safe to cache forever
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )

  // History fallback: the router uses createWebHistory(), so a deep link or a
  // refresh on /portraits/studio-portraits or /admin/articles must return the
  // shell rather than a 404. API paths are excluded — they get their own 404.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path === '/api' || req.path.startsWith('/api/')) return next()
    if (!req.accepts('html')) return next()
    res.sendFile(path.join(staticDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } })
  })
}

/* ------------------------------------------------------------- fallbacks -- */

app.use('/api', (req, _res, next) => {
  next(new ApiError(404, 'not_found', `No route for ${req.method} ${req.originalUrl}`))
})

// eslint-disable-next-line no-unused-vars -- express needs the 4-argument shape
app.use((err, req, res, _next) => {
  let status = 500
  let code = 'internal_error'
  let message = 'Something went wrong'
  let details

  if (err instanceof ApiError) {
    status = err.status
    code = err.code
    message = err.message
    details = err.details
  } else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    status = 400
    code = 'bad_request'
    message = 'Request body is not valid JSON'
  } else if (err?.type === 'entity.too.large') {
    status = 413
    code = 'payload_too_large'
    message = 'Request body is too large'
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}: ${err?.message ?? err}`)
  }

  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } })
})

/* ------------------------------------------------------------------ start -- */

export function start() {
  initDb()
  const pruned = pruneExpiredSessions()
  const server = app.listen(config.port, () => {
    console.log(`portfolio api listening on http://localhost:${config.port}`)
    console.log(
      `  db=${config.databaseFile} oss=${config.oss.provider} wechat=${config.wechat.mode}${config.wechat.mock ? ' (mock)' : ''} authDev=${config.authDev ? 1 : 0}`,
    )
    console.log(
      servingSite
        ? `  serving the site from ${staticDir} (same origin as /api)`
        : '  no built site found — the API only; run `npm run dev:web` for the front end',
    )
    if (pruned) console.log(`  pruned ${pruned} expired session(s)`)
  })
  return server
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) start()
