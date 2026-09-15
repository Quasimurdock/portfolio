<script setup lang="ts">
/**
 * Articles: filter, read, act.
 *
 * Every row action is gated twice — the button is only shown when `can()` says
 * so, and the server is still free to refuse (403 → a toast, never a stack
 * trace). Status changes are optimistic and roll back on failure.
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
import type { Article, Status } from '@/types/api'
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

const canWrite = computed(() => auth.can('content.article.write'))
const canPublish = computed(() => auth.can('content.article.publish'))
const canDelete = computed(() => auth.can('content.article.delete'))
const canReadAll = computed(() => auth.can('content.article.read_all'))
const defaultScope: 'mine' | 'all' = canReadAll.value ? 'all' : 'mine'

const { sections, ensureSections } = useSections()
const statuses = statusOptions()

const columns: AdminColumn[] = [
  { key: 'title', label: 'Title' },
  { key: 'section', label: 'Section', width: '130px', hideBelow: 'lg' },
  { key: 'status', label: 'Status', width: '116px' },
  { key: 'author', label: 'Author', width: '140px', hideBelow: 'lg' },
  { key: 'updated', label: 'Updated', width: '160px', hideBelow: 'md', numeric: true },
  { key: 'actions', label: 'Actions', width: '320px', align: 'right' },
]

const { query, items, total, loading, error, load, reset, replace } = usePagedList<Article>(
  (listQuery) => adminApi.articles.list(listQuery),
  { pageSize: 20, scope: defaultScope },
)

const search = ref('')
const pendingId = ref<number | null>(null)
const confirmRow = ref<Article | null>(null)
const deleting = ref(false)
let searchTimer: number | undefined

onMounted(() => {
  void load()
  void ensureSections()
})

watch([() => query.status, () => query.section, () => query.scope], () => {
  void reset()
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

/**
 * Who may do what follows the role matrix: a publisher gets publish / unpublish
 * / archive, an author (write without publish) may only move a row between
 * draft and review.
 */
function statusActions(row: Article): RowAction[] {
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

async function changeStatus(row: Article, status: Status): Promise<void> {
  if (pendingId.value !== null) return
  pendingId.value = row.id
  const previous = row.status
  replace((item) => item.id === row.id, { status })
  try {
    const updated = await adminApi.articles.setStatus(row.id, status)
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
    await adminApi.articles.remove(row.id)
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
        <h2 class="admin-page__title">Articles</h2>
        <p class="admin-page__sub">
          Essays, reviews, news and exhibition copy.
          <template v-if="!canReadAll">You see your own rows only.</template>
        </p>
      </div>
      <div class="admin-page__actions">
        <RouterLink v-if="canWrite" class="admin-btn admin-btn--sm admin-btn--primary" :to="{ name: 'admin-article-new' }">
          New article
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
        <input v-model="search" class="admin-input admin-input--search" type="search" placeholder="Title, slug or excerpt…" />
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
      <DataTable
        :columns="columns"
        :rows="items"
        :loading="loading"
        :skeleton-rows="query.pageSize && query.pageSize > 10 ? 8 : 5"
        empty-text="No articles match these filters."
      >
        <template #cell-title="{ row }">
          <RouterLink class="admin-link admin-link--strong" :to="{ name: 'admin-article-edit', params: { id: String(row.id) } }">
            {{ row.title || 'Untitled' }}
          </RouterLink>
          <span class="admin-table__sub">{{ row.slug }}</span>
        </template>

        <template #cell-section="{ row }">
          <span class="admin-mono">{{ row.sectionKey }}</span>
        </template>

        <template #cell-status="{ row }">
          <StatusPill :status="row.status" />
        </template>

        <template #cell-author="{ row }">
          {{ row.authorName ?? `#${row.authorId}` }}
        </template>

        <template #cell-updated="{ row }">
          <span class="admin-num">{{ formatDateTime(row.updatedAt) }}</span>
        </template>

        <template #cell-actions="{ row }">
          <div class="admin-rowactions">
            <RouterLink class="admin-btn admin-btn--sm admin-btn--ghost" :to="{ name: 'admin-article-edit', params: { id: String(row.id) } }">
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
          <EmptyState title="No articles" message="Nothing matches these filters.">
            <RouterLink v-if="canWrite" class="admin-btn admin-btn--sm admin-btn--primary" :to="{ name: 'admin-article-new' }">
              Write the first one
            </RouterLink>
          </EmptyState>
        </template>
      </DataTable>

      <PaginationBar
        :page="query.page ?? 1"
        :page-size="query.pageSize ?? 20"
        :total="total"
        :disabled="loading"
        label="articles"
        @update:page="goToPage"
        @update:page-size="changePageSize"
      />
    </template>

    <ConfirmDialog
      :open="!!confirmRow"
      title="Delete this article?"
      :message="confirmRow ? `“${confirmRow.title}” will be removed. The back office cannot undo this.` : ''"
      confirm-label="Delete article"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="confirmRow = null"
    />
  </div>
</template>
