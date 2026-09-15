/**
 * Formatting helpers for the back office.
 *
 * No date library: `Intl` is in the platform, and the admin only ever needs
 * "medium date" and "medium date + short time". Everything else here is a
 * small string utility the views would otherwise repeat.
 */
import type { Status } from '@/types/api'

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : '—'
}

export function formatDate(value: string | null | undefined): string {
  const date = parse(value)
  return date ? DATE_ONLY.format(date) : '—'
}

/** "3 hours ago" / "in 2 days" — for activity feeds where exactness is noise. */
export function relativeTime(value: string | null | undefined): string {
  const date = parse(value)
  if (!date) return '—'
  const seconds = (date.getTime() - Date.now()) / 1000
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, size] of table) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

export function formatDimensions(width: number | null | undefined, height: number | null | undefined): string {
  if (!width || !height) return '—'
  return `${width} × ${height}`
}

/** Url-safe slug: lowercase ASCII, hyphen separated, at most 80 chars. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const STATUS_VALUES: Status[] = ['draft', 'review', 'published', 'archived']

export function isStatus(value: string): value is Status {
  return (STATUS_VALUES as string[]).includes(value)
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  review: 'In review',
  published: 'Published',
  archived: 'Archived',
  total: 'Total',
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

const ENTITY_LABELS: Record<string, string> = {
  article: 'Articles',
  collection: 'Collections',
  image: 'Images',
  feed_item: 'Feed slides',
  feedItem: 'Feed slides',
  page: 'Pages',
  user: 'People',
  role: 'Roles',
  session: 'Sessions',
}

export function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? entity
}

const ENTITY_SINGULAR: Record<string, string> = {
  article: 'article',
  collection: 'collection',
  image: 'image',
  feed_item: 'feed slide',
  feedItem: 'feed slide',
  page: 'page',
  user: 'user',
}

export function entitySingular(entity: string): string {
  return ENTITY_SINGULAR[entity] ?? entity
}

export function countOf(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
}

export function initials(name: string | null | undefined, fallback = '?'): string {
  if (!name) return fallback
  const parts = name.trim().split(/\s+/).slice(0, 2)
  if (!parts.length || !parts[0]) return fallback
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || fallback
}

export function jsonPretty(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2)
    return text ?? ''
  } catch {
    return String(value)
  }
}

export type JsonResult = { ok: true; value: unknown } | { ok: false; message: string }

/**
 * JSON.parse with a line/column hint — `Page.data` is edited by hand, so the
 * error has to point at the offending brace rather than just say "invalid".
 */
export function parseJson(source: string): JsonResult {
  const text = source.trim()
  if (!text) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = /position (\d+)/.exec(message)
    if (!match?.[1]) return { ok: false, message }
    const position = Number(match[1])
    const before = text.slice(0, position)
    const line = before.split('\n').length
    const column = position - before.lastIndexOf('\n')
    return { ok: false, message: `${message} (line ${line}, column ${column})` }
  }
}

export interface Option {
  value: string
  label: string
}

/** The status `<select>` options, shared by every filter bar. */
export function statusOptions(): Option[] {
  return STATUS_VALUES.map((status) => ({ value: status, label: statusLabel(status) }))
}

/** Native `<input type="checkbox">`-free multi-select needs no helper today. */
export function truncate(value: string, max = 90): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
