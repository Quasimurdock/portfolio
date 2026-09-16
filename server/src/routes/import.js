/**
 * Database import (docs/API.md §3.4). `settings.manage` only.
 *
 *   GET  /api/admin/import/tables  → the tables the importer knows
 *   POST /api/admin/import         → upload a SQLite file and apply it
 *
 * The body is a raw `application/octet-stream` upload, not JSON — see the
 * `express.raw` mount in index.js. Everything the importer decides on comes from
 * the query string, so the file itself is touched exactly once.
 *
 * Replace mode is deliberately awkward: it deletes the selected tables first,
 * so it needs `?confirm=replace` as well as `?mode=replace`. A mistyped merge
 * costs a duplicate-row warning; a mistyped replace costs a site.
 */
import { Router } from 'express'

import { record } from '../audit.js'
import { asyncHandler, badRequest, forbidden } from '../errors.js'
import { requireAuth, requirePermission } from '../middleware.js'
import {
  MAX_BYTES,
  defaultTableNames,
  importDatabase,
  isKnownTable,
  isSqliteFile,
  tableCatalogue,
} from '../transfer.js'

const ENTITY = 'database'

const router = Router()
router.use(requireAuth)

/** `?tables=a,b,c` → a validated list, or the defaults when absent. */
function tablesFrom(query) {
  const raw = query?.tables
  if (typeof raw !== 'string' || !raw.trim()) return defaultTableNames()

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const unknown = names.filter((name) => !isKnownTable(name))
  if (unknown.length) throw badRequest(`Unknown table(s): ${unknown.join(', ')}`)
  if (!names.length) throw badRequest('No tables selected')
  return names
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

router.get(
  '/tables',
  requirePermission('settings.manage'),
  (_req, res) => {
    res.json({ tables: tableCatalogue(), maxBytes: MAX_BYTES })
  },
)

router.post(
  '/',
  requirePermission('settings.manage'),
  asyncHandler(async (req, res) => {
    const mode = req.query.mode === 'replace' ? 'replace' : 'merge'
    const dryRun = truthy(req.query.dryRun ?? req.query.dry_run)

    if (mode === 'replace' && !dryRun && req.query.confirm !== 'replace') {
      throw forbidden('Replacing needs ?confirm=replace')
    }

    const buffer = req.body
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw badRequest('Send the .db file as the request body (Content-Type: application/octet-stream)')
    }
    if (buffer.length > MAX_BYTES) {
      throw badRequest(`That file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
    }
    if (!isSqliteFile(buffer)) {
      throw badRequest('That is not a SQLite database file')
    }

    const tables = tablesFrom(req.query)

    let summary
    try {
      summary = await importDatabase({ buffer, tables, mode, dryRun })
    } catch (error) {
      // A failed foreign key almost always means the selection left out a table
      // that points at the one being emptied.
      const message = String(error?.message ?? error)
      if (/foreign key|FOREIGN KEY/i.test(message)) {
        throw badRequest(
          'The database refused that import because of a foreign key. In replace mode, include every table that references the ones you are replacing.',
          { reason: message },
        )
      }
      throw error
    }

    if (!dryRun) {
      await record(req.user.id, 'import', ENTITY, null, {
        mode,
        tables,
        bytes: buffer.length,
        inserted: summary.tables.reduce((total, table) => total + (table.inserted ?? 0), 0),
      })
    }

    res.json(summary)
  }),
)

export default router
