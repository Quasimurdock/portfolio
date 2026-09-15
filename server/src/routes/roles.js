/**
 * The role matrix (docs/API.md §3.2) — `GET /api/admin/roles`.
 * Requires `user.read`; returns every role with its resolved permission keys
 * plus the full permission catalogue so the UI can render the grid.
 */
import { Router } from 'express'
import { all } from '../db.js'
import { asyncHandler } from '../errors.js'
import { requireAuth, requirePermission } from '../middleware.js'
import { PERMISSION_KEYS } from '../permissions.js'
import { toPermission, toRole } from '../serialize.js'

const router = Router()
router.use(requireAuth, requirePermission('user.read'))

router.get(
  '/',
  asyncHandler((_req, res) => {
    const roles = all('SELECT * FROM roles ORDER BY rank DESC, key ASC')
    const links = all('SELECT role_key, permission_key FROM role_permissions')
    const permissions = all('SELECT * FROM permissions ORDER BY group_key ASC, key ASC')

    res.json({
      roles: roles.map((role) =>
        toRole(
          role,
          role.key === 'owner'
            ? [...PERMISSION_KEYS]
            : links.filter((link) => link.role_key === role.key).map((link) => link.permission_key),
        ),
      ),
      permissions: permissions.map((permission) => toPermission(permission)),
    })
  }),
)

export default router
