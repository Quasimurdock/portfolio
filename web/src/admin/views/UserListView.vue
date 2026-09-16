<script setup lang="ts">
/**
 * People.
 *
 * Roles come from the database (`adminApi.roles()`), so a role the client adds
 * later appears here without a code change. An owner or an admin creates an
 * account outright and hands over the password: either one they type, or one
 * the server generates and shows exactly once. (The permission behind this is
 * still keyed `user.invite` in the database.)
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
const canCreate = computed(() => auth.can('user.invite'))
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

/* ------------------------------------------------------------------- create */

const createOpen = ref(false)
const createForm = reactive({ email: '', name: '', role: 'author', password: '' })
const createErrors = reactive({ email: '', name: '', password: '' })
const creating = ref(false)
const createError = ref('')

const resultOpen = ref(false)
const resultEmail = ref('')
const resultPassword = ref('')

function openCreate(): void {
  createForm.email = ''
  createForm.name = ''
  createForm.password = ''
  createForm.role = roleKeys.value.includes('author') ? 'author' : (roleKeys.value[0] ?? 'author')
  createErrors.email = ''
  createErrors.name = ''
  createErrors.password = ''
  createError.value = ''
  createOpen.value = true
}

async function submitCreate(): Promise<void> {
  if (creating.value) return
  const email = createForm.email.trim()
  const password = createForm.password
  createErrors.email = !email ? 'An email address is required.' : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? '' : 'That does not look like an email address.'
  createErrors.name = createForm.name.trim() ? '' : 'A name is required — it is what the audit log shows.'
  createErrors.password =
    !password || password.length >= 8 ? '' : 'Use at least 8 characters — or leave it empty and the server generates one.'
  if (createErrors.email || createErrors.name || createErrors.password) return

  creating.value = true
  createError.value = ''
  try {
    const created = await adminApi.users.create({
      email,
      name: createForm.name.trim(),
      role: createForm.role,
      ...(password ? { password } : {}),
    })
    resultEmail.value = created.email ?? email
    resultPassword.value = created.password ?? ''
    createOpen.value = false
    resultOpen.value = true
    await loadUsers()
  } catch (err) {
    createError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    creating.value = false
  }
}

async function copyPassword(): Promise<void> {
  try {
    await navigator.clipboard.writeText(resultPassword.value)
    success('Password copied to the clipboard.')
  } catch {
    info('Copying failed — select the password and copy it by hand.')
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
        <button v-if="canCreate" type="button" class="admin-btn admin-btn--sm admin-btn--primary" @click="openCreate">New account</button>
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

    <ModalDialog :open="createOpen" title="New account" :busy="creating" @close="createOpen = false">
      <p class="admin-modal__desc">
        The account works straight away. Set a password here, or leave the field empty and the server generates one for
        you to pass on.
      </p>
      <p v-if="createError" class="admin-formerror" role="alert">{{ createError }}</p>

      <FormField label="Email" for-id="create-email" required :error="createErrors.email">
        <input id="create-email" v-model="createForm.email" class="admin-input" type="email" placeholder="name@studio.test" />
      </FormField>
      <FormField label="Name" for-id="create-name" required :error="createErrors.name" hint="Shown in the audit log.">
        <input id="create-name" v-model="createForm.name" class="admin-input" type="text" />
      </FormField>
      <FormField label="Role" for-id="create-role" hint="Every permission this person gets comes from this role.">
        <select id="create-role" v-model="createForm.role" class="admin-select">
          <option v-for="key in roleKeys" :key="key" :value="key">{{ key }}</option>
        </select>
      </FormField>
      <FormField
        label="Password"
        for-id="create-password"
        :error="createErrors.password"
        hint="Leave empty to generate one. At least 8 characters."
      >
        <input id="create-password" v-model="createForm.password" class="admin-input" type="text" autocomplete="new-password" placeholder="leave empty to generate" />
      </FormField>

      <template #footer>
        <button type="button" class="admin-btn" :disabled="creating" @click="createOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="creating" @click="submitCreate">
          {{ creating ? 'Creating…' : 'Create account' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="resultOpen" title="Account created" @close="resultOpen = false">
      <p v-if="resultPassword" class="admin-modal__desc">
        Hand this password to <strong>{{ resultEmail }}</strong>. It is shown once — the database only keeps the hash.
      </p>
      <p v-else class="admin-modal__desc">
        <strong>{{ resultEmail }}</strong> can sign in with the password you set.
      </p>
      <p v-if="resultPassword" class="admin-token">{{ resultPassword }}</p>
      <p v-if="resultPassword" class="admin-field__hint">
        Pass it on over a channel you trust; it cannot be read back out of the database.
      </p>
      <template #footer>
        <button v-if="resultPassword" type="button" class="admin-btn admin-btn--primary" @click="copyPassword">Copy password</button>
        <button type="button" class="admin-btn" @click="resultOpen = false">Done</button>
      </template>
    </ModalDialog>
  </div>
</template>
