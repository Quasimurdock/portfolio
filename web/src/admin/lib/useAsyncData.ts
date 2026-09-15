/**
 * One-shot async state for detail screens (edit forms, matrices, overviews).
 *
 * `useQuery` in `@/composables` is keyed and auto-running; the admin edit
 * screens want to control *when* a load happens (after a save, after a retry,
 * on route-param change) and to know whether the payload was a 404, so this is
 * a deliberately smaller separate helper.
 */
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { ApiError, errorMessage } from '@/api/client'

export interface AsyncData<T> {
  data: ShallowRef<T>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** the last attempt failed with 404 */
  missing: Ref<boolean>
  run: () => Promise<T | null>
  reset: () => void
}

export function useAsyncData<T>(loader: () => Promise<T>, initial: T): AsyncData<T> {
  const data = shallowRef<T>(initial)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const missing = ref(false)
  let seq = 0

  async function run(): Promise<T | null> {
    const ticket = ++seq
    loading.value = true
    error.value = null
    missing.value = false
    try {
      const value = await loader()
      if (ticket !== seq) return null
      data.value = value
      return value
    } catch (err) {
      if (ticket !== seq) return null
      error.value = errorMessage(err)
      missing.value = err instanceof ApiError && err.status === 404
      return null
    } finally {
      if (ticket === seq) loading.value = false
    }
  }

  function reset(): void {
    seq += 1
    data.value = initial
    loading.value = false
    error.value = null
    missing.value = false
  }

  return { data, loading, error, missing, run, reset }
}
