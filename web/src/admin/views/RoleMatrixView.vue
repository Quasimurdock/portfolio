<script setup lang="ts">
/**
 * The roles × permissions matrix, read-only.
 *
 * This screen is the argument for the whole design: a permission is a row in
 * `permissions`, a role is a row in `roles`, and a grant is a row in
 * `role_permissions` — changing who may publish is a data change, not a deploy.
 */
import { computed, onMounted } from 'vue'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import type { Permission, Role } from '@/types/api'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import LoadingState from '@/admin/components/LoadingState.vue'

interface PermissionGroup {
  key: string
  label: string
  permissions: Permission[]
}

const auth = useAuthStore()
const canRead = computed(() => auth.can('user.read'))

const { data, loading, error, run } = useAsyncData<{ roles: Role[]; permissions: Permission[] }>(
  () => adminApi.roles(),
  { roles: [], permissions: [] },
)

onMounted(() => {
  if (canRead.value) void run()
})

const roles = computed(() => [...data.value.roles].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)))

/** "content.article" → "Content · Article"; "user" → "User". */
function groupLabel(key: string): string {
  return key
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' · ')
}

const groups = computed<PermissionGroup[]>(() => {
  const map = new Map<string, Permission[]>()
  for (const permission of data.value.permissions) {
    const bucket = map.get(permission.groupKey)
    if (bucket) bucket.push(permission)
    else map.set(permission.groupKey, [permission])
  }
  return [...map.entries()]
    .map(([key, permissions]) => ({
      key,
      label: groupLabel(key),
      permissions: [...permissions].sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
})

function granted(role: Role, permissionKey: string): boolean {
  return role.permissions.includes(permissionKey)
}

function grantCount(role: Role): number {
  return data.value.permissions.filter((permission) => granted(role, permission.key)).length
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Roles and permissions</h2>
        <p class="admin-page__sub">
          Read-only. A permission is a database row, a role is a set of them, and every account carries exactly one
          role — so widening access is a data change anyone can audit, not a deployment.
        </p>
      </div>
      <div class="admin-page__actions">
        <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="loading" @click="run()">Refresh</button>
      </div>
    </header>

    <EmptyState
      v-if="!canRead"
      title="Not available to you"
      message="The matrix requires the user.read permission. Ask an owner or an admin for it."
    />

    <ErrorState v-else-if="error" :message="error" @retry="run()" />

    <LoadingState v-else-if="loading && data.roles.length === 0" label="Loading the matrix…" />

    <EmptyState v-else-if="data.roles.length === 0" title="No roles" message="The permission catalogue has not been seeded." />

    <template v-else>
      <div class="admin-table__wrap">
        <table class="admin-table admin-matrix admin-matrix--roles">
          <thead>
            <tr>
              <th scope="col" class="admin-table__cell is-left admin-matrix__permhead">Permission</th>
              <th v-for="role in roles" :key="role.key" scope="col" class="admin-table__cell is-center">
                <span class="admin-matrix__role">{{ role.name || role.key }}</span>
                <span class="admin-matrix__rolemeta">
                  <span class="admin-chip">{{ role.key }}</span>
                  <span v-if="auth.user?.role === role.key" class="admin-chip admin-chip--you">you</span>
                  <span v-if="role.isSystem" class="admin-chip">system</span>
                </span>
                <span class="admin-matrix__rolemeta admin-num">{{ grantCount(role) }} grants</span>
              </th>
            </tr>
          </thead>

          <tbody v-for="group in groups" :key="group.key">
            <tr class="admin-matrix__band">
              <th scope="colgroup" :colspan="roles.length + 1" class="admin-table__cell is-left">{{ group.label }}</th>
            </tr>
            <tr v-for="permission in group.permissions" :key="permission.key" class="admin-table__row">
              <th scope="row" class="admin-table__cell is-left admin-matrix__perm">
                <span class="admin-mono">{{ permission.key }}</span>
                <span class="admin-table__sub">{{ permission.description }}</span>
              </th>
              <td v-for="role in roles" :key="role.key" class="admin-table__cell is-center">
                <span v-if="granted(role, permission.key)" class="admin-check" :title="`${role.key} has ${permission.key}`">✓</span>
                <span v-else class="admin-check admin-check--off" :title="`${role.key} does not have ${permission.key}`">·</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="admin-note">
        <strong>✓</strong> granted · <strong>·</strong> not granted. The <code>owner</code> role is a system role and
        receives every permission at read time, so its column fills in without extra rows.
      </p>
    </template>
  </div>
</template>
