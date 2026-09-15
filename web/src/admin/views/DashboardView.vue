<script setup lang="ts">
/**
 * The publishing overview — the landing screen after sign-in.
 *
 * One request (`adminApi.overview()`) answers the four questions the client
 * actually asked: what exists (type × status), what is mine and unfinished,
 * what just happened, and who is here.
 */
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { STATUS_VALUES, entityLabel, formatDateTime, relativeTime, statusLabel } from '@/admin/lib/format'
import type { Overview } from '@/types/api'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

type OverviewEntity = Overview['counts'][number]['entity']

const ENTITIES: OverviewEntity[] = ['article', 'collection', 'image', 'feed_item', 'page']

const EMPTY: Overview = { counts: [], myDrafts: [], recent: [], users: { total: 0, byRole: [] } }

const auth = useAuthStore()
const { data: overview, loading, error, run } = useAsyncData<Overview>(() => adminApi.overview(), EMPTY)

onMounted(() => {
  void run()
})

const countMap = computed(() => {
  const map = new Map<string, number>()
  for (const row of overview.value.counts) map.set(`${row.entity}:${row.status}`, row.n)
  return map
})

function count(entity: string, status: string): number {
  return countMap.value.get(`${entity}:${status}`) ?? 0
}

/** type × status matrix, with a total per type (server total, else derived). */
const matrix = computed(() =>
  ENTITIES.map((entity) => {
    const cells = STATUS_VALUES.map((status) => ({ status, n: count(entity, status) }))
    const derived = cells.reduce((sum, cell) => sum + cell.n, 0)
    return { entity, label: entityLabel(entity), cells, total: count(entity, 'total') || derived }
  }),
)

const grandTotal = computed(() => matrix.value.reduce((sum, row) => sum + row.total, 0))
const hasContent = computed(() => grandTotal.value > 0)

/**
 * "my drafts" rows carry an entity + id, but pages are edited by slug, so they
 * go to the list rather than a guessed URL.
 */
function draftTarget(entity: string, id: number): { name: string; params?: Record<string, string> } {
  switch (entity) {
    case 'article':
      return { name: 'admin-article-edit', params: { id: String(id) } }
    case 'collection':
      return { name: 'admin-collection-edit', params: { id: String(id) } }
    case 'image':
      return { name: 'admin-images' }
    case 'feed_item':
    case 'feedItem':
      return { name: 'admin-feed' }
    case 'page':
      return { name: 'admin-pages' }
    default:
      return { name: 'admin-dashboard' }
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Publishing overview</h2>
        <p class="admin-page__sub">
          What exists, what is unfinished, what just changed — and who is behind it.
        </p>
      </div>
      <div class="admin-page__actions">
        <RouterLink v-if="auth.can('content.article.write')" class="admin-btn admin-btn--sm admin-btn--primary" :to="{ name: 'admin-article-new' }">
          New article
        </RouterLink>
        <RouterLink v-if="auth.can('content.collection.write')" class="admin-btn admin-btn--sm" :to="{ name: 'admin-collection-new' }">
          New collection
        </RouterLink>
        <RouterLink v-if="auth.can('content.feed.manage')" class="admin-btn admin-btn--sm" :to="{ name: 'admin-feed' }">
          Home feed
        </RouterLink>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="run()" />
    <LoadingState v-else-if="loading && !overview.counts.length" label="Loading the overview…" />

    <template v-else>
      <section class="admin-card">
        <header class="admin-card__head">
          <h3 class="admin-card__title">Content by type and status</h3>
          <p class="admin-card__note">{{ grandTotal }} rows in total</p>
        </header>

        <div class="admin-table__wrap">
          <table class="admin-table admin-matrix">
            <thead>
              <tr>
                <th scope="col" class="admin-table__cell is-left">Type</th>
                <th v-for="status in STATUS_VALUES" :key="status" scope="col" class="admin-table__cell is-right">
                  {{ statusLabel(status) }}
                </th>
                <th scope="col" class="admin-table__cell is-right is-numeric">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in matrix" :key="row.entity" class="admin-table__row">
                <th scope="row" class="admin-table__cell is-left admin-matrix__label">{{ row.label }}</th>
                <td
                  v-for="cell in row.cells"
                  :key="cell.status"
                  class="admin-table__cell is-right is-numeric"
                  :class="{ 'is-zero': cell.n === 0 }"
                >
                  {{ cell.n }}
                </td>
                <td class="admin-table__cell is-right is-numeric admin-matrix__total">{{ row.total }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="!hasContent" class="admin-card__note">
          The database is empty — create a collection or an article to get started.
        </p>
      </section>

      <div class="admin-grid admin-grid--3">
        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">My drafts</h3>
            <p class="admin-card__note">{{ overview.myDrafts.length }}</p>
          </header>

          <EmptyState v-if="!overview.myDrafts.length" title="Nothing unfinished" message="Your drafts and rows in review will collect here." />

          <ul v-else class="admin-list">
            <li v-for="draft in overview.myDrafts" :key="`${draft.entity}-${draft.id}`" class="admin-list__row">
              <RouterLink class="admin-list__main" :to="draftTarget(draft.entity, draft.id)">
                <span class="admin-list__title">{{ draft.title || `#${draft.id}` }}</span>
                <span class="admin-list__meta">
                  {{ entityLabel(draft.entity) }} · updated {{ relativeTime(draft.updatedAt) }}
                </span>
              </RouterLink>
              <StatusPill :status="draft.status" compact />
            </li>
          </ul>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">Latest activity</h3>
            <RouterLink v-if="auth.can('user.read')" class="admin-link" :to="{ name: 'admin-audit' }">Full log →</RouterLink>
          </header>

          <EmptyState v-if="!overview.recent.length" title="No activity yet" message="Every mutation writes an audit row; they will appear here." />

          <ul v-else class="admin-list admin-list--dense">
            <li v-for="entry in overview.recent" :key="entry.id" class="admin-list__row">
              <span class="admin-list__main">
                <span class="admin-list__title">
                  <strong>{{ entry.action }}</strong>
                  {{ entityLabel(entry.entity).toLowerCase() }}<template v-if="entry.entityId"> #{{ entry.entityId }}</template>
                </span>
                <span class="admin-list__meta">
                  {{ entry.userName ?? 'system' }} · {{ formatDateTime(entry.createdAt) }}
                </span>
              </span>
            </li>
          </ul>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">People</h3>
            <RouterLink v-if="auth.can('user.read')" class="admin-link" :to="{ name: 'admin-users' }">Manage →</RouterLink>
          </header>

          <p class="admin-stat">
            <span class="admin-stat__value">{{ overview.users.total }}</span>
            <span class="admin-stat__label">accounts</span>
          </p>

          <EmptyState v-if="!overview.users.byRole.length" title="No accounts" />
          <ul v-else class="admin-chiplist">
            <li v-for="row in overview.users.byRole" :key="row.role" class="admin-chip admin-chip--count">
              <span>{{ row.role }}</span>
              <strong>{{ row.n }}</strong>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
