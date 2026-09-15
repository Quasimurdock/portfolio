<script setup lang="ts">
/**
 * The activity log: who changed what, newest first, with the audit `meta`
 * folded away until asked for.
 */
import { computed, onMounted, ref } from 'vue'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { entityLabel, formatDateTime, jsonPretty, relativeTime } from '@/admin/lib/format'
import type { AdminColumn } from '@/admin/lib/table'
import type { AuditEntry } from '@/types/api'
import DataTable from '@/admin/components/DataTable.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import LoadingState from '@/admin/components/LoadingState.vue'

const LIMITS = [25, 50, 100, 200]

const auth = useAuthStore()
const canRead = computed(() => auth.can('user.read'))
const limit = ref(50)

const columns: AdminColumn[] = [
  { key: 'time', label: 'When', width: '190px' },
  { key: 'user', label: 'Who', width: '160px' },
  { key: 'action', label: 'Action', width: '140px' },
  { key: 'entity', label: 'Entity', width: '180px' },
  { key: 'meta', label: 'Details' },
]

const { data: entries, loading, error, run } = useAsyncData<AuditEntry[]>(
  () => adminApi.audit(limit.value),
  [],
)

onMounted(() => {
  if (canRead.value) void run()
})

function changeLimit(value: string): void {
  limit.value = Number(value)
  void run()
}

function refresh(): void {
  void run()
}

/** Newest first, with ids as the tie-breaker inside the same second. */
const ordered = computed(() =>
  [...entries.value].sort((a, b) => {
    if (a.createdAt === b.createdAt) return b.id - a.id
    return a.createdAt < b.createdAt ? 1 : -1
  }),
)

function hasMeta(entry: AuditEntry): boolean {
  return !!entry.meta && Object.keys(entry.meta).length > 0
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Activity</h2>
        <p class="admin-page__sub">
          Every mutation records who did it, what it touched and what changed.
        </p>
      </div>
      <div class="admin-page__actions">
        <label class="admin-filter admin-filter--inline">
          <span class="admin-filter__label">Rows</span>
          <select class="admin-select admin-select--sm" :value="limit" @change="changeLimit(($event.target as HTMLSelectElement).value)">
            <option v-for="value in LIMITS" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="loading" @click="refresh">Refresh</button>
      </div>
    </header>

    <EmptyState
      v-if="!canRead"
      title="Not available to you"
      message="The activity log requires the user.read permission."
    />

    <ErrorState v-else-if="error" :message="error" @retry="refresh()" />

    <LoadingState v-else-if="loading && ordered.length === 0" label="Loading activity…" />

    <EmptyState v-else-if="ordered.length === 0" title="Nothing logged yet" message="Changes in the back office will show up here." />

    <DataTable v-else :columns="columns" :rows="ordered" :loading="loading" :skeleton-rows="8" empty-text="No activity.">
      <template #cell-time="{ row }">
        <span class="admin-num">{{ formatDateTime(row.createdAt) }}</span>
        <span class="admin-table__sub">{{ relativeTime(row.createdAt) }}</span>
      </template>

      <template #cell-user="{ row }">
        <template v-if="row.userName">{{ row.userName }}</template>
        <span v-else-if="row.userId" class="admin-mono">user #{{ row.userId }}</span>
        <span v-else class="admin-table__sub">system</span>
      </template>

      <template #cell-action="{ row }">
        <span class="admin-chip">{{ row.action }}</span>
      </template>

      <template #cell-entity="{ row }">
        <span>{{ entityLabel(row.entity) }}</span>
        <span v-if="row.entityId" class="admin-table__sub admin-mono">#{{ row.entityId }}</span>
      </template>

      <template #cell-meta="{ row }">
        <details v-if="hasMeta(row)" class="admin-meta">
          <summary>meta</summary>
          <pre class="admin-pre">{{ jsonPretty(row.meta) }}</pre>
        </details>
        <span v-else class="admin-table__sub">—</span>
      </template>
    </DataTable>
  </div>
</template>
