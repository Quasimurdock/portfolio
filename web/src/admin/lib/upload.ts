/**
 * Direct browser → OSS upload.
 *
 * Three steps, exactly as the contract describes:
 *   1. `POST /api/uploads/sign` mints a ticket (the only server involvement)
 *   2. the browser POSTs the multipart form (signed fields + `file`) straight to
 *      `ticket.upload.url`; **the server never sees the bytes**
 *   3. an `images` row is created pointing at `ticket.publicUrl`
 *
 * The `mock` provider answers step 2 with `{ ok: true, url }` (or 204), so both
 * shapes are accepted.
 */
import { adminApi, uploadsApi } from '@/api/endpoints'
import type { ImageAsset, Status, UploadTicket } from '@/types/api'
import { formatBytes } from './format'

export interface UploadOptions {
  collectionId?: number | null
  caption?: string
  alt?: string
  status?: Status
}

/** Read a helpful message out of an upload response body, whatever it holds. */
function uploadError(payload: string, fallback: string): string {
  if (!payload) return fallback
  try {
    const parsed = JSON.parse(payload) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? fallback
  } catch {
    return payload.length < 200 ? payload : fallback
  }
}

async function sendToBucket(file: File, ticket: UploadTicket): Promise<string> {
  const sameOrigin = ticket.upload.url.startsWith('/')
  const headers: Record<string, string> = { ...(ticket.upload.headers ?? {}) }
  let body: FormData | File

  if (ticket.upload.method === 'PUT') {
    // A PUT ticket signs a single object, not a form.
    body = file
    headers['Content-Type'] = file.type || 'application/octet-stream'
  } else {
    const form = new FormData()
    for (const [key, value] of Object.entries(ticket.upload.fields ?? {})) form.append(key, value)
    form.append('file', file)
    body = form
  }

  let response: Response
  try {
    response = await fetch(ticket.upload.url, {
      method: ticket.upload.method,
      body,
      headers,
      // same-origin means our own mock endpoint (send the session cookie);
      // a real bucket is third-party and gets no credentials.
      credentials: sameOrigin ? 'include' : 'omit',
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach the upload target: ${reason}`)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Upload rejected (${response.status}): ${uploadError(text, response.statusText || 'upload failed')}`)
  }

  let publicUrl = ticket.publicUrl
  if (response.status !== 204) {
    const text = await response.text().catch(() => '')
    if (text) {
      try {
        const parsed = JSON.parse(text) as { url?: unknown }
        if (typeof parsed.url === 'string' && parsed.url) publicUrl = parsed.url
      } catch {
        // A plain-text 200 from a bucket still means the object landed.
      }
    }
  }
  return publicUrl
}

/**
 * Sign, upload, then register the row. Throws an `Error` with a message worth
 * showing; callers toast it.
 */
export async function uploadImage(file: File, options: UploadOptions = {}): Promise<ImageAsset> {
  const contentType = file.type || 'application/octet-stream'
  const ticket = await uploadsApi.sign({ filename: file.name, contentType, size: file.size })

  if (file.size > ticket.maxBytes) {
    throw new Error(`“${file.name}” is ${formatBytes(file.size)} — this bucket accepts up to ${formatBytes(ticket.maxBytes)}.`)
  }

  const publicUrl = await sendToBucket(file, ticket)

  return adminApi.images.create({
    url: publicUrl,
    thumbUrl: null,
    ossKey: ticket.key,
    ossProvider: ticket.provider,
    bytes: file.size,
    format: file.type || null,
    collectionId: options.collectionId ?? null,
    caption: options.caption ?? '',
    alt: options.alt ?? '',
    status: options.status ?? 'draft',
  })
}
