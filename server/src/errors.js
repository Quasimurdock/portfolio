/**
 * One error type, one JSON shape.
 *
 * Every failure leaves the server as
 *   { "error": { "code": "forbidden", "message": "…", "details?": … } }
 * (docs/API.md §3) with the status carried on the error itself.
 */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   machine-readable code, e.g. `forbidden`
   * @param {string} message human-readable message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details)
export const validationFailed = (details) =>
  new ApiError(400, 'validation_error', 'Request payload is invalid', details)
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'forbidden', message)
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details)
export const serverError = (message = 'Something went wrong', details) =>
  new ApiError(500, 'internal_error', message, details)

/** zod issues → the `details` payload of a 400. */
export function issuesOf(error) {
  return {
    issues: (error.issues ?? []).map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    })),
  }
}

/**
 * Validate a value against a zod schema, throwing a 400 with `details`.
 * Unknown keys are stripped (zod's default), i.e. ignored as the contract says.
 */
export function parseBody(schema, value) {
  const result = schema.safeParse(value ?? {})
  if (!result.success) throw validationFailed(issuesOf(result.error))
  return result.data
}

/** Wrap an async express handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next)
}
