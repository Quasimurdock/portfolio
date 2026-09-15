<script setup lang="ts">
/**
 * The single pages: Biography and Contact today, any other slug the site adds.
 * Reading is open to any session; writing needs `content.page.write`.
 */
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { formatDateTime } from '@/admin/lib/format'
import type { Page } from '@/types/api'
import DataTable from '@/admin/components/DataTable.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import StatusPill from '@/admin/components/StatusPill.vue'
import type { AdminColumn } from '@/admin/lib/table'

const auth = useAuthStore()
const canWrite = computed(() => auth.can('content.page.write'))

const columns: AdminColumn[] = [
  { key: 'title', label: 'Page' },
  { key: 'kind', label: 'Kind', width: '110px' },
  { key: 'status', label: 'Status', width: '120px' },
  { key: 'fields', label: 'Structured data', width: '220px', hideBelow: 'lg' },
  { key: 'updated', label: 'Updated', width: '170px', align: 'right', numeric: true },
  { key: 'actions', label: '', width: '110px', align: 'right' },
]

const { data: pages, loading, error, run } = useAsyncData<Page[]>(() => adminApi.pages.list(), [])

onMounted(() => {
  void run()
})

function kindLabel(kind: Page['kind']): string {
  return kind === 'contact' ? 'Contact' : 'Article'
}

/** A one-line summary of what the `data` blob holds for this page. */
function dataSummary(page: Page): string {
  const data = page.data ?? {}
  const parts: string[] = []
  if (data.lead) parts.push('lead')
  if (data.paragraphs?.length) parts.push(`${data.paragraphs.length} paragraphs`)
  if (data.publications) parts.push('publications')
  if (data.representation) parts.push('representation')
  if (data.columns?.length) parts.push(`${data.columns.length} columns`)
  return parts.length ? parts.join(' · ') : 'body only'
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Pages</h2>
        <p class="admin-page__sub">
          Standing pages with a markdown body and a small structured-data blob.
        </p>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="run()" />
    <LoadingState v-else-if="loading && pages.length === 0" label="Loading pages…" />
    <EmptyState v-else-if="pages.length === 0" title="No pages" message="The server has no page rows yet." />

    <DataTable v-else :columns="columns" :rows="pages" :loading="loading" :skeleton-rows="3" empty-text="No pages.">
      <template #cell-title="{ row }">
        <RouterLink class="admin-link admin-link--strong" :to="{ name: 'admin-page-edit', params: { slug: row.slug } }">
          {{ row.title }}
        </RouterLink>
        <span class="admin-table__sub admin-mono">/{{ row.slug }}</span>
      </template>

      <template #cell-kind="{ row }">
        <span class="admin-chip">{{ kindLabel(row.kind) }}</span>
      </template>

      <template #cell-status="{ row }">
        <StatusPill :status="row.status" />
      </template>

      <template #cell-fields="{ row }">
        <span class="admin-table__sub">{{ dataSummary(row) }}</span>
      </template>

      <template #cell-updated="{ row }">
        <span class="admin-num">{{ formatDateTime(row.updatedAt) }}</span>
      </template>

      <template #cell-actions="{ row }">
        <RouterLink class="admin-btn admin-btn--sm admin-btn--ghost" :to="{ name: 'admin-page-edit', params: { slug: row.slug } }">
          {{ canWrite ? 'Edit' : 'View' }}
        </RouterLink>
      </template>
    </DataTable>
  </div>
</template>
