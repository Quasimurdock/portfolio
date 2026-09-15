/**
 * Who changed what.
 *
 * Auditing must never take a request down: a failed insert is logged to stderr
 * and swallowed. Nothing secret is ever written into `meta`.
 */
import { run } from './db.js'

/**
 * @param {number|null} userId
 * @param {string} action    create | update | delete | publish | archive | status | login | logout | invite | reorder
 * @param {string} entity    article | collection | image | feed_item | page | user | session
 * @param {number|null} entityId
 * @param {Record<string, unknown>} [meta]
 */
export async function record(userId, action, entity, entityId = null, meta = {}) {
  try {
    await run(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId ?? null,
        String(action),
        String(entity),
        entityId === null || entityId === undefined ? null : Number(entityId),
        safeJson(meta),
        new Date().toISOString(),
      ],
    )
  } catch (error) {
    console.error(`[audit] could not record ${action} ${entity}: ${error.message}`)
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}
