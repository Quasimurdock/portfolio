<script setup lang="ts">
/**
 * Collections — the portfolios, series and albums. Same treatment as articles:
 * filter bar, paginated table, status actions gated by the collection
 * permissions (which are separate from the article ones).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { usePagedList } from '@/admin/lib/usePagedList'
import { sectionOptions, useSections } from '@/admin/lib/sections'
import { formatDateTime, statusLabel, statusOptions } from '@/admin/lib/format'
import type { AdminColumn } from '@/admin/lib/table'
import type { Collection, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import DataTable from '@/admin/components/DataTable.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FilterBar from '@/admin/components/FilterBar.vue'
import PaginationBar from '@/admin/components/PaginationBar.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

interface RowAction {
  key: string
  label: string
  status: Status
}

const auth = useAuthStore()
const { success, error: toastError } = useToast()

const canWrite = computed(() => auth.can('content.collection.write'))
const canPublish = computed(() => auth.can('content.collection.publish'))
const canDelete = computed(() => auth.can('content.collection.delete'))
const canReadAll = computed(() => auth.can('content.collection.read_all'))
const defaultScope: 'mine' | 'all' = canReadAll.value ? 'all' : 'mine'

const { sections, ensureSections } = useSections()
const statuses = statusOptions()

const columns: AdminColumn[] = [
  { key: 'title', label: 'Collection' },
  { key: 'section', label: 'Section', width: '120px', hideBelow: 'lg' },
  { key: 'kind', label: 'Kind', width: '96px' },
  { key: 'place', label: 'Place', width: '140px', hideBelow: 'lg' },
  { key: 'year', label: 'Year', width: '72px', numeric: true, hideBelow: 'md' },
  { key: 'images', label: 'Images', width: '80px', numeric: true },
  { key: 'status', label: 'Status', width: '116px' },
  { key: 'author', label: 'Author', width: '130px', hideBelow: 'lg' },
  { key: 'actions', label: 'Actions', width: '280px', align: 'right' },
]

const { query, items, total, loading, error, load, reset, replace } = usePagedList<Collection>(
  (listQuery) => adminApi.collections.list(listQuery),
  { pageSize: 20, scope: defaultScope },
)

const search = ref('')
const pendingId = ref<number | null>(null)
const confirmRow = ref<Collection | null>(null)
const deleting = ref(false)
let searchTimer: number | undefined
let reloadTimer: number | undefined

onMounted(() => {
  void load()
  void ensureSections()
})

watch([() => query.status, () => query.section, () => query.scope], () => {
  window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => void reset(), 120)
})

watch(search, (value) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    query.q = value
    void reset()
  }, 300)
})

const filtersActive = computed(
  () => !!(query.status || query.section || query.q) || (query.scope ?? defaultScope) !== defaultScope,
)
const sectionChoices = computed(() => sectionOptions(sections.value, items.value.map((row) => row.sectionKey)))

function kindLabel(kind: Collection['kind']): string {
  return kind === 'album' ? 'Album' : 'Series'
}

function statusActions(row: Collection): RowAction[] {
  const actions: RowAction[] = []
  if (canPublish.value) {
    if (row.status !== 'published') actions.push({ key: 'publish', label: 'Publish', status: 'published' })
    if (row.status === 'published') actions.push({ key: 'unpublish', label: 'Unpublish', status: 'draft' })
    if (row.status !== 'archived') actions.push({ key: 'archive', label: 'Archive', status: 'archived' })
    if (row.status === 'archived') actions.push({ key: 'restore', label: 'Restore draft', status: 'draft' })
  } else if (canWrite.value) {
    if (row.status === 'draft') actions.push({ key: 'review', label: 'Submit for review', status: 'review' })
    if (row.status === 'review') actions.push({ key: 'draft', label: 'Back to draft', status: 'draft' })
    if (row.status === 'archived') actions.push({ key: 'restore', label: 'Restore draft', status: 'draft' })
  }
  return actions
}

async function changeStatus(row: Collection, status: Status): Promise<void> {
  if (pendingId.value !== null) return
  pendingId.value = row.id
  const previous = row.status
  replace((item) => item.id === row.id, { status })
  try {
    const updated = await adminApi.collections.setStatus(row.id, status)
    replace((item) => item.id === row.id, updated)
    success(`“${row.title}” is now ${statusLabel(status)}.`)
  } catch (err) {
    replace((item) => item.id === row.id, { status: previous })
    toastError(errorMessage(err))
  } finally {
    pendingId.value = null
  }
}

async function confirmDelete(): Promise<void> {
  const row = confirmRow.value
  if (!row || deleting.value) return
  deleting.value = true
  try {
    await adminApi.collections.remove(row.id)
    success(`Deleted “${row.title}”.`)
    confirmRow.value = null
    if (items.value.length === 1 && (query.page ?? 1) > 1) query.page = (query.page ?? 1) - 1
    await load()
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    deleting.value = false
  }
}

function clearFilters(): void {
  query.status = ''
  query.section = ''
  query.q = ''
  query.scope = defaultScope
  search.value = ''
  void reset()
}

function goToPage(page: number): void {
  query.page = page
  void load()
}

function changePageSize(size: number): void {
  query.pageSize = size
  void reset()
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Collections</h2>
        <p class="admin-page__sub">
          Portfolios, series and albums — each one an ordered set of photographs.
          <template v-if="!canReadAll">You see your own rows only.</template>
        </p>
      </div>
      <div class="admin-page__actions">
        <RouterLink v-if="canWrite" class="admin-btn admin-btn--sm admin-btn--primary" :to="{ name: 'admin-collection-new' }">
          New collection
        </RouterLink>
      </div>
    </header>

    <FilterBar :active="filtersActive" :busy="loading" @reset="clearFilters">
      <label class="admin-filter">
        <span class="admin-filter__label">Status</span>
        <select v-model="query.status" class="admin-select">
          <option value="">Any status</option>
          <option v-for="option in statuses" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>

      <label class="admin-filter">
        <span class="admin-filter__label">Section</span>
        <select v-model="query.section" class="admin-select">
          <option value="">Any section</option>
          <option v-for="option in sectionChoices" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>

      <label class="admin-filter admin-filter--grow">
        <span class="admin-filter__label">Search</span>
        <input v-model="search" class="admin-input admin-input--search" type="search" placeholder="Title, slug or place…" />
      </label>

      <label v-if="canReadAll" class="admin-filter">
        <span class="admin-filter__label">Scope</span>
        <select v-model="query.scope" class="admin-select">
          <option value="all">Everyone</option>
          <option value="mine">Mine only</option>
        </select>
      </label>
    </FilterBar>

    <ErrorState v-if="error" :message="error" @retry="load()" />

    <template v-else>
      <DataTable :columns="columns" :rows="items" :loading="loading" :skeleton-rows="6" empty-text="No collections match these filters.">
        <template #cell-title="{ row }">
          <RouterLink class="admin-link admin-link--strong" :to="{ name: 'admin-collection-edit', params: { id: String(row.id) } }">
            {{ row.title || 'Untitled' }}
          </RouterLink>
          <span class="admin-table__sub">{{ row.slug }}</span>
        </template>

        <template #cell-section="{ row }">
          <span class="admin-mono">{{ row.sectionKey }}</span>
        </template>

        <template #cell-kind="{ row }">
          <span class="admin-chip">{{ kindLabel(row.kind) }}</span>
        </template>

        <template #cell-place="{ row }">{{ row.place || '—' }}</template>

        <template #cell-year="{ row }">
          <span class="admin-num">{{ row.year ?? '—' }}</span>
        </template>

        <template #cell-images="{ row }">
          <span class="admin-num">{{ row.imageCount ?? 0 }}</span>
        </template>

        <template #cell-status="{ row }">
          <StatusPill :status="row.status" />
        </template>

        <template #cell-author="{ row }">
          {{ row.authorName ?? `#${row.authorId}` }}
        </template>

        <template #cell-actions="{ row }">
          <div class="admin-rowactions">
            <RouterLink class="admin-btn admin-btn--sm admin-btn--ghost" :to="{ name: 'admin-collection-edit', params: { id: String(row.id) } }">
              Edit
            </RouterLink>
            <button
              v-for="action in statusActions(row)"
              :key="action.key"
              type="button"
              class="admin-btn admin-btn--sm admin-btn--ghost"
              :disabled="pendingId === row.id"
              @click="changeStatus(row, action.status)"
            >
              {{ action.label }}
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="admin-btn admin-btn--sm admin-btn--danger-ghost"
              :disabled="pendingId === row.id"
              @click="confirmRow = row"
            >
              Delete
            </button>
          </div>
        </template>

        <template #empty>
          <EmptyState title="No collections" message="Nothing matches these filters.">
            <RouterLink v-if="canWrite" class="admin-btn admin-btn--sm admin-btn--primary" :to="{ name: 'admin-collection-new' }">
              Start the first one
            </RouterLink>
          </EmptyState>
        </template>
      </DataTable>

      <PaginationBar
        :page="query.page ?? 1"
        :page-size="query.pageSize ?? 20"
        :total="total"
        :disabled="loading"
        label="collections"
        @update:page="goToPage"
        @update:page-size="changePageSize"
      />
    </template>

    <ConfirmDialog
      :open="!!confirmRow"
      title="Delete this collection?"
      :message="confirmRow ? `“${confirmRow.title}” will be removed. Photographs inside it are not deleted, but they lose their collection.` : ''"
      confirm-label="Delete collection"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="confirmRow = null"
    />
  </div>
</template>
