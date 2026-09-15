/**
 * The permission catalogue and the role → permission matrix.
 *
 * Permissions are data: the API only ever asks "does this user hold key K?"
 * (docs/API.md §2). `owner` is a system role and always resolves to *every*
 * permission, whatever `role_permissions` happens to contain.
 */

/** Every permission key, grouped the way the admin UI shows them. */
export const PERMISSIONS = [
  { key: 'content.article.read_all', groupKey: 'content.article', description: 'Read articles written by anyone' },
  { key: 'content.article.write', groupKey: 'content.article', description: 'Create and edit articles' },
  { key: 'content.article.publish', groupKey: 'content.article', description: 'Publish or archive articles' },
  { key: 'content.article.delete', groupKey: 'content.article', description: 'Delete articles' },

  { key: 'content.collection.read_all', groupKey: 'content.collection', description: 'Read collections owned by anyone' },
  { key: 'content.collection.write', groupKey: 'content.collection', description: 'Create and edit collections' },
  { key: 'content.collection.publish', groupKey: 'content.collection', description: 'Publish or archive collections' },
  { key: 'content.collection.delete', groupKey: 'content.collection', description: 'Delete collections' },

  { key: 'content.image.read_all', groupKey: 'content.image', description: 'Read images uploaded by anyone' },
  { key: 'content.image.write', groupKey: 'content.image', description: 'Register and edit images' },
  { key: 'content.image.delete', groupKey: 'content.image', description: 'Delete images' },

  { key: 'content.page.write', groupKey: 'content.page', description: 'Edit single pages' },
  { key: 'content.page.publish', groupKey: 'content.page', description: 'Publish or archive single pages' },

  { key: 'content.feed.manage', groupKey: 'content.feed', description: 'Curate the home slideshow' },

  { key: 'media.upload', groupKey: 'media', description: 'Sign a direct-to-OSS upload' },

  { key: 'user.read', groupKey: 'user', description: 'List people, roles and activity' },
  { key: 'user.invite', groupKey: 'user', description: 'Invite new people' },
  { key: 'user.update', groupKey: 'user', description: 'Update people' },
  { key: 'user.disable', groupKey: 'user', description: 'Disable or re-enable people' },

  { key: 'role.assign', groupKey: 'role', description: 'Change somebody’s role' },

  { key: 'settings.manage', groupKey: 'settings', description: 'Change studio settings' },
]

export const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key)

const EVERYTHING = PERMISSION_KEYS

/** Role definitions. `permissions` = the seeded role_permissions rows. */
export const ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'The studio owner. Holds every permission, always.',
    rank: 100,
    isSystem: 1,
    permissions: EVERYTHING,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Runs the studio day to day. Everything except assigning roles.',
    rank: 80,
    isSystem: 1,
    permissions: EVERYTHING.filter((key) => key !== 'role.assign'),
  },
  {
    key: 'editor',
    name: 'Editor',
    description: 'Publishes and edits anybody’s work; cannot manage people beyond reading them.',
    rank: 60,
    isSystem: 1,
    permissions: [
      'content.article.read_all',
      'content.article.write',
      'content.article.publish',
      'content.article.delete',
      'content.collection.read_all',
      'content.collection.write',
      'content.collection.publish',
      'content.collection.delete',
      'content.image.read_all',
      'content.image.write',
      'content.image.delete',
      'content.page.write',
      'content.page.publish',
      'content.feed.manage',
      'media.upload',
      'user.read',
    ],
  },
  {
    key: 'author',
    name: 'Author',
    description: 'Writes and uploads; sees and touches only its own rows.',
    rank: 40,
    isSystem: 1,
    permissions: [
      'content.article.write',
      'content.collection.write',
      'content.image.write',
      'content.image.delete',
      'media.upload',
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to everything, for proofing and reviews.',
    rank: 20,
    isSystem: 1,
    permissions: ['content.article.read_all', 'content.collection.read_all', 'content.image.read_all'],
  },
]

const ROLE_BY_KEY = new Map(ROLES.map((role) => [role.key, role]))

export const ROLE_KEYS = ROLES.map((role) => role.key)

export function roleExists(key) {
  return ROLE_BY_KEY.has(key)
}

export function roleRank(key) {
  return ROLE_BY_KEY.get(key)?.rank ?? 0
}

/**
 * Effective permission keys for a role. `owner` short-circuits to the whole
 * catalogue; every other role is resolved from the seeded matrix.
 */
export function effectivePermissions(roleKey) {
  if (roleKey === 'owner') return [...PERMISSION_KEYS]
  const role = ROLE_BY_KEY.get(roleKey)
  if (!role) return []
  return [...role.permissions]
}

/** Permission keys held by a role, read from the database (falls back to the matrix). */
export function rolePermissionsFromDb(roleKey, rows) {
  if (roleKey === 'owner') return [...PERMISSION_KEYS]
  return rows.filter((row) => row.role_key === roleKey).map((row) => row.permission_key)
}
