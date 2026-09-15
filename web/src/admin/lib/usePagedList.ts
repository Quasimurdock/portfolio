/**
 * Paged list state for the admin tables.
 *
 * Keeps the query, the page envelope and the three states (loading / error /
 * empty) in one place, and guards against out-of-order responses with a
 * monotonically increasing ticket — a slow "page 1" must never overwrite a
 * fast "page 2".
 *
 * List items are held in a `shallowRef` because they are always replaced
 * wholesale; optimistic edits go through `replace()`, which swaps the row (and
 * so still triggers a render) rather than mutating it.
 */
import { reactive, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { errorMessage } from '@/api/client'
import type { ListQuery, Paged } from '@/types/api'

export interface PagedList<T> {
  query: ListQuery
  items: ShallowRef<T[]>
  total: Ref<number>
  loading: Ref<boolean>
  error: Ref<string | null>
  load: () => Promise<void>
  /** back to page 1, then load */
  reset: () => Promise<void>
  /** swap one row in place (optimistic update / rollback) */
  replace: (match: (row: T) => boolean, next: Partial<T>) => void
}

export function usePagedList<T>(
  fetcher: (query: ListQuery) => Promise<Paged<T>>,
  initial: ListQuery = {},
): PagedList<T> {
  const query = reactive<ListQuery>({ page: 1, pageSize: 20, scope: 'mine', ...initial })
  const items = shallowRef<T[]>([])
  const total = ref(0)
  const loading = ref(true)
  const error = ref<string | null>(null)
  let seq = 0

  async function load(): Promise<void> {
    const ticket = ++seq
    loading.value = true
    error.value = null
    try {
      const page = await fetcher({ ...query })
      if (ticket !== seq) return
      items.value = page.items
      total.value = page.total
      if (typeof page.page === 'number' && page.page > 0) query.page = page.page
    } catch (err) {
      if (ticket !== seq) return
      error.value = errorMessage(err)
      items.value = []
      total.value = 0
    } finally {
      if (ticket === seq) loading.value = false
    }
  }

  function reset(): Promise<void> {
    query.page = 1
    return load()
  }

  function replace(match: (row: T) => boolean, next: Partial<T>): void {
    items.value = items.value.map((row) => (match(row) ? { ...row, ...next } : row))
  }

  return { query, items, total, loading, error, load, reset, replace }
}
