/**
 * Uploading an old SQLite install into this database.
 *
 * `request()` in `api/client.ts` always JSON-encodes its body, so this single
 * call goes straight to `fetch` with the file as the body — the same reason
 * `upload.ts` bypasses the client for the bucket leg. Everything else about the
 * exchange (error envelope, credentials) matches the rest of the API.
 */
import { ApiError } from '@/api/client'
import type { ImportSummary } from '@/types/api'

const ENDPOINT = '/api/admin/import'

export interface ImportOptions {
  /** `replace` empties the selected tables first; `merge` keeps what is here */
  mode: 'merge' | 'replace'
  /** table names, as returned by `importApi.tables()` */
  tables: string[]
  /** read and count only — writes nothing */
  dryRun?: boolean
}

export async function importDatabase(file: File, options: ImportOptions): Promise<ImportSummary> {
  const query = new URLSearchParams()
  query.set('mode', options.mode)
  query.set('tables', options.tables.join(','))
  if (options.dryRun) query.set('dryRun', '1')
  // The server refuses a real replace without this, so a stray click cannot
  // delete a live site.
  if (options.mode === 'replace' && !options.dryRun) query.set('confirm', 'replace')

  let response: Response
  try {
    response = await fetch(`${ENDPOINT}?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      credentials: 'include',
      body: file,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not send the file: ${reason}`)
  }

  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'import_failed',
      error?.message ?? `${response.status} ${response.statusText}`,
      error?.details,
    )
  }

  return payload as ImportSummary
}
