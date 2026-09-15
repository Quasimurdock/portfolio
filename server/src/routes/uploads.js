/**
 * OSS signing (docs/API.md §3.4).
 *
 *   POST /sign  → the policy the browser posts straight to the bucket
 *   POST /mock  → dev-only black hole standing in for that bucket
 */
import { Router } from 'express'
import { z } from 'zod'
import { record } from '../audit.js'
import { asyncHandler, notFound, parseBody } from '../errors.js'
import { requireAuth, requirePermission } from '../middleware.js'
import { isMockProvider, mockUploadResult, signUpload } from '../oss.js'

const router = Router()

const signSchema = z.object({
  filename: z.string().trim().min(1).max(300),
  contentType: z.string().trim().min(1).max(160),
  size: z.number().int().nonnegative().max(5_000_000_000),
})

/**
 * The receiver the browser posts to when `OSS_PROVIDER=mock`. It deliberately
 * stores nothing — it only has to answer the way OSS would.
 */
router.post(
  '/mock',
  asyncHandler(async (req, res) => {
    if (!isMockProvider()) throw notFound('Not found')

    // Drain whatever the browser sent so the socket closes cleanly.
    let bytes = 0
    await new Promise((resolve) => {
      req.on('data', (chunk) => {
        bytes += chunk.length
      })
      req.on('end', resolve)
      req.on('error', resolve)
      if (req.readableEnded) resolve()
    })

    res.json({ ...mockUploadResult(req), bytes })
  }),
)

router.post(
  '/sign',
  requireAuth,
  requirePermission('media.upload'),
  asyncHandler((req, res) => {
    const input = parseBody(signSchema, req.body)
    const ticket = signUpload(input)
    record(req.user.id, 'sign', 'upload', null, {
      key: ticket.key,
      provider: ticket.provider,
      bytes: input.size,
      contentType: input.contentType,
    })
    res.json(ticket)
  }),
)

export default router
