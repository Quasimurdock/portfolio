/**
 * Bits shared by the content routes (articles, collections, images, feed).
 * Kept deliberately tiny — everything here is a lookup or a guard, never a
 * business rule of its own.
 */
import { get } from '../db.js'
import { badRequest } from '../errors.js'

/** `":id"` → a positive integer, or a 400. */
export function parseId(value, label = 'id') {
  const id = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(id) || id <= 0 || String(id) !== String(value).trim()) {
    throw badRequest(`\`${label}\` must be a positive integer`, { [label]: value })
  }
  return id
}

/** The section must exist — `articles.section_key` / `collections.section_key` are FKs. */
export function requireSection(sectionKey) {
  const section = get('SELECT key, label, kind FROM sections WHERE key = ?', [sectionKey])
  if (!section) throw badRequest(`Unknown section: ${sectionKey}`, { sectionKey })
  return section
}

/** A referenced image must exist, otherwise SQLite would raise an FK error. */
export function requireImage(imageId, field = 'coverImageId') {
  if (imageId === null || imageId === undefined) return null
  const image = get('SELECT * FROM images WHERE id = ?', [imageId])
  if (!image) throw badRequest(`Unknown ${field}: ${imageId}`, { [field]: imageId })
  return image
}

/** `base`, `base-2`, `base-3`, … — never collides with an existing slug. */
export function uniqueSlug(table, base, ignoreId = null) {
  const stem = base || 'untitled'
  let candidate = stem
  let suffix = 2
  for (;;) {
    const row =
      ignoreId === null
        ? get(`SELECT id FROM ${table} WHERE slug = ?`, [candidate])
        : get(`SELECT id FROM ${table} WHERE slug = ? AND id <> ?`, [candidate, ignoreId])
    if (!row) return candidate
    candidate = `${stem}-${suffix++}`
  }
}

/** `?collectionId=` → null (no filter) | number | 'unassigned' */
export function collectionIdFilter(value) {
  if (value === undefined || value === null || value === '') return null
  const raw = String(value)
  if (raw === 'null' || raw === 'none' || raw === '0') return { unassigned: true }
  const id = Number.parseInt(raw, 10)
  if (!Number.isFinite(id) || id <= 0) {
    throw badRequest('`collectionId` must be a positive integer', { collectionId: value })
  }
  return { id }
}
