<script setup lang="ts">
/**
 * People.
 *
 * Roles come from the database (`adminApi.roles()`), so a role the client adds
 * later appears here without a code change. Inviting returns a one-time
 * `inviteToken` — in production that goes out by email; here it is shown so it
 * can be copied into a message by hand.
 *
 * `GET /api/admin/users` is documented with `q`/`role`/`status` only (no page
 * parameters), so this screen filters but does not page.
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { formatDateTime, statusLabel } from '@/admin/lib/format'
import type { AdminColumn } from '@/admin/lib/table'
import type { Role, User, UserStatus } from '@/types/api'
import DataTable from '@/admin/components/DataTable.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FilterBar from '@/admin/components/FilterBar.vue'
import FormField from '@/admin/components/FormField.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import ModalDialog from '@/admin/components/ModalDialog.vue'

/** If the role catalogue cannot be read (no `user.read`), offer the seeded keys. */
const FALLBACK_ROLES = ['owner', 'admin', 'editor', 'author', 'viewer']
const USER_STATUSES: UserStatus[] = ['active', 'invited', 'disabled']

const auth = useAuthStore()
const { success, info, error: toastError } = useToast()

const canRead = computed(() => auth.can('user.read'))
const canInvite = computed(() => auth.can('user.invite'))
const canUpdate = computed(() => auth.can('user.update'))
const canAssignRole = computed(() => auth.can('role.assign'))
const canDisable = computed(() => auth.can('user.disable'))

const columns: AdminColumn[] = [
  { key: 'name', label: 'Person' },
  { key: 'role', label: 'Role', width: '160px' },
  { key: 'status', label: 'Status', width: '150px' },
  { key: 'created', label: 'Joined', width: '150px', hideBelow: 'lg', numeric: true },
  { key: 'login', label: 'Last seen', width: '160px', hideBelow: 'lg', numeric: true },
]

const users = shallowRef<User[]>([])
const total = ref(0)
const loading = ref(true)
const error = ref<string | null>(null)
const busyId = ref<number | null>(null)
const roles = shallowRef<Role[]>([])

const filters = reactive<{ q: string; role: string; status: string }>({ q: '', role: '', status: '' })
const search = ref('')
let searchTimer: number | undefined

onMounted(() => {
  void loadUsers()
  void loadRoles()
})

async function loadUsers(): Promise<void> {
  if (!canRead.value) {
    loading.value = false
    users.value = []
    return
  }
  loading.value = true
  error.value = null
  try {
    const page = await adminApi.users.list({
      q: filters.q || undefined,
      role: filters.role || undefined,
      status: filters.status || undefined,
    })
    users.value = page.items
    total.value = page.total
  } catch (err) {
    error.value = errorMessage(err)
    users.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadRoles(): Promise<void> {
  if (!auth.can('user.read')) return
  try {
    roles.value = (await adminApi.roles()).roles
  } catch {
    roles.value = []
  }
}

watch([() => filters.role, () => filters.status], () => {
  void loadUsers()
})

watch(search, (value) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    filters.q = value
    void loadUsers()
  }, 300)
})

const roleKeys = computed(() => (roles.value.length ? roles.value.map((role) => role.key) : FALLBACK_ROLES))
const filtersActive = computed(() => !!(filters.q || filters.role || filters.status))

function clearFilters(): void {
  filters.q = ''
  filters.role = ''
  filters.status = ''
  search.value = ''
  void loadUsers()
}

function displayName(user: User): string {
  return user.name || user.email || `#${user.id}`
}

function initialsOf(user: User): string {
  const source = user.name || user.email || '?'
  return source.trim().slice(0, 2).toUpperCase()
}

/* ------------------------------------------------------------- role / status */

async function changeRole(user: User, role: string): Promise<void> {
  if (!canAssignRole.value || busyId.value !== null || role === user.role) return
  busyId.value = user.id
  const previous = user.role
  users.value = users.value.map((row) => (row.id === user.id ? { ...row, role } : row))
  try {
    const updated = await adminApi.users.update(user.id, { role })
    users.value = users.value.map((row) => (row.id === user.id ? updated : row))
    success(`${displayName(user)} is now ${role}.`)
  } catch (err) {
    users.value = users.value.map((row) => (row.id === user.id ? { ...row, role: previous } : row))
    toastError(errorMessage(err))
  } finally {
    busyId.value = null
  }
}

async function changeStatus(user: User, status: string): Promise<void> {
  if (!canDisable.value || busyId.value !== null || status === user.status) return
  busyId.value = user.id
  const previous = user.status
  users.value = users.value.map((row) => (row.id === user.id ? { ...row, status: status as UserStatus } : row))
  try {
    const updated = await adminApi.users.update(user.id, { status })
    users.value = users.value.map((row) => (row.id === user.id ? updated : row))
    success(`${displayName(user)} is ${statusLabel(status).toLowerCase()}.`)
  } catch (err) {
    users.value = users.value.map((row) => (row.id === user.id ? { ...row, status: previous } : row))
    toastError(errorMessage(err))
  } finally {
    busyId.value = null
  }
}

/* ------------------------------------------------------------------- invite */

const inviteOpen = ref(false)
const inviteForm = reactive({ email: '', name: '', role: 'author' })
const inviteErrors = reactive({ email: '', name: '' })
const inviting = ref(false)
const inviteError = ref('')

const issuedOpen = ref(false)
const issuedEmail = ref('')
const issuedToken = ref('')

function openInvite(): void {
  inviteForm.email = ''
  inviteForm.name = ''
  inviteForm.role = roleKeys.value.includes('author') ? 'author' : (roleKeys.value[0] ?? 'author')
  inviteErrors.email = ''
  inviteErrors.name = ''
  inviteError.value = ''
  inviteOpen.value = true
}

async function submitInvite(): Promise<void> {
  if (inviting.value) return
  const email = inviteForm.email.trim()
  inviteErrors.email = !email ? 'An email address is required.' : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? '' : 'That does not look like an email address.'
  inviteErrors.name = inviteForm.name.trim() ? '' : 'A name is required — it is what the audit log shows.'
  if (inviteErrors.email || inviteErrors.name) return

  inviting.value = true
  inviteError.value = ''
  try {
    const created = await adminApi.users.create({ email, name: inviteForm.name.trim(), role: inviteForm.role })
    issuedEmail.value = created.email ?? email
    issuedToken.value = created.inviteToken
    inviteOpen.value = false
    issuedOpen.value = true
    await loadUsers()
  } catch (err) {
    inviteError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    inviting.value = false
  }
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(issuedToken.value)
    success('Invite token copied to the clipboard.')
  } catch {
    info('Copying failed — select the token and copy it by hand.')
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">People</h2>
        <p class="admin-page__sub">
          {{ total }} {{ total === 1 ? 'account' : 'accounts' }}. Roles map onto permission rows; nobody inherits anything implicitly.
        </p>
      </div>
      <div class="admin-page__actions">
        <button v-if="canInvite" type="button" class="admin-btn admin-btn--sm admin-btn--primary" @click="openInvite">Invite</button>
      </div>
    </header>

    <EmptyState
      v-if="!canRead"
      title="Not available to you"
      message="Listing people requires the user.read permission. Ask an owner or an admin."
    />

    <template v-else>
      <FilterBar :active="filtersActive" :busy="loading" @reset="clearFilters">
        <label class="admin-filter admin-filter--grow">
          <span class="admin-filter__label">Search</span>
          <input v-model="search" class="admin-input admin-input--search" type="search" placeholder="Name or email…" />
        </label>

        <label class="admin-filter">
          <span class="admin-filter__label">Role</span>
          <select v-model="filters.role" class="admin-select">
            <option value="">Any role</option>
            <option v-for="key in roleKeys" :key="key" :value="key">{{ key }}</option>
          </select>
        </label>

        <label class="admin-filter">
          <span class="admin-filter__label">Status</span>
          <select v-model="filters.status" class="admin-select">
            <option value="">Any status</option>
            <option v-for="value in USER_STATUSES" :key="value" :value="value">{{ statusLabel(value) }}</option>
          </select>
        </label>
      </FilterBar>

      <ErrorState v-if="error" :message="error" @retry="loadUsers()" />
      <LoadingState v-else-if="loading && users.length === 0" label="Loading people…" />
      <EmptyState v-else-if="users.length === 0" title="Nobody matches" message="Try a different search or filter." />

      <DataTable v-else :columns="columns" :rows="users" :loading="loading" :skeleton-rows="6" empty-text="No accounts.">
        <template #cell-name="{ row }">
          <span class="admin-person">
            <span class="admin-person__avatar" aria-hidden="true">{{ initialsOf(row) }}</span>
            <span class="admin-person__meta">
              <strong>{{ row.name || '—' }}</strong>
              <span class="admin-table__sub">{{ row.email ?? 'no email (WeChat account)' }}</span>
            </span>
          </span>
        </template>

        <template #cell-role="{ row }">
          <select
            v-if="canAssignRole"
            class="admin-select admin-select--sm"
            :value="row.role"
            :disabled="busyId !== null"
            :aria-label="`Role for ${displayName(row)}`"
            @change="changeRole(row, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="key in roleKeys" :key="key" :value="key">{{ key }}</option>
          </select>
          <span v-else class="admin-chip">{{ row.role }}</span>
        </template>

        <template #cell-status="{ row }">
          <select
            v-if="canDisable"
            class="admin-select admin-select--sm"
            :value="row.status"
            :disabled="busyId !== null"
            :aria-label="`Status for ${displayName(row)}`"
            @change="changeStatus(row, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="value in USER_STATUSES" :key="value" :value="value">{{ statusLabel(value) }}</option>
          </select>
          <span v-else class="admin-chip">{{ statusLabel(row.status) }}</span>
        </template>

        <template #cell-created="{ row }">
          <span class="admin-num">{{ formatDateTime(row.createdAt) }}</span>
        </template>

        <template #cell-login="{ row }">
          <span class="admin-num">{{ row.lastLoginAt ? formatDateTime(row.lastLoginAt) : 'never' }}</span>
        </template>
      </DataTable>

      <p v-if="!canUpdate" class="admin-note">
        You can see people but not change them — that needs <code>user.update</code>, and role changes additionally
        need <code>role.assign</code>.
      </p>
    </template>

    <ModalDialog :open="inviteOpen" title="Invite someone" :busy="inviting" @close="inviteOpen = false">
      <p class="admin-modal__desc">
        The account is created straight away with the chosen role; the invite token is what the person would receive by
        email in production.
      </p>
      <p v-if="inviteError" class="admin-formerror" role="alert">{{ inviteError }}</p>

      <FormField label="Email" for-id="invite-email" required :error="inviteErrors.email">
        <input id="invite-email" v-model="inviteForm.email" class="admin-input" type="email" placeholder="name@studio.test" />
      </FormField>
      <FormField label="Name" for-id="invite-name" required :error="inviteErrors.name" hint="Shown in the audit log.">
        <input id="invite-name" v-model="inviteForm.name" class="admin-input" type="text" />
      </FormField>
      <FormField label="Role" for-id="invite-role" hint="Every permission this person gets comes from this role.">
        <select id="invite-role" v-model="inviteForm.role" class="admin-select">
          <option v-for="key in roleKeys" :key="key" :value="key">{{ key }}</option>
        </select>
      </FormField>

      <template #footer>
        <button type="button" class="admin-btn" :disabled="inviting" @click="inviteOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="inviting" @click="submitInvite">
          {{ inviting ? 'Inviting…' : 'Create invitation' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="issuedOpen" title="Invitation created" @close="issuedOpen = false">
      <p class="admin-modal__desc">
        Send this one-time token to <strong>{{ issuedEmail }}</strong>. It is shown once — the server does not keep a
        readable copy.
      </p>
      <p class="admin-token">{{ issuedToken }}</p>
      <p class="admin-field__hint">
        In production this would be emailed by the server; the back office shows it because no mail transport is
        configured in development.
      </p>
      <template #footer>
        <button type="button" class="admin-btn admin-btn--primary" @click="copyToken">Copy token</button>
        <button type="button" class="admin-btn" @click="issuedOpen = false">Done</button>
      </template>
    </ModalDialog>
  </div>
</template>
