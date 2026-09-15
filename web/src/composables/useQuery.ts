/**
 * A tiny query helper: run a loader whenever its key changes, keep the last
 * good value while the next one is in flight (no flicker on navigation).
 */
import { ref, watch, type Ref } from 'vue'
import { ApiError, errorMessage } from '@/api/client'

export interface Query<T> {
  data: Ref<T>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** true when the last attempt failed with 404 */
  missing: Ref<boolean>
  reload: () => Promise<void>
}

export function useQuery<T>(key: () => string | number | null | undefined, loader: (key: string) => Promise<T>, initial: T): Query<T> {
  const data = ref(initial) as Ref<T>
  const loading = ref(false)
  const error = ref<string | null>(null)
  const missing = ref(false)

  async function run(id: string | number) {
    loading.value = true
    error.value = null
    missing.value = false
    try {
      data.value = (await loader(String(id))) as T
    } catch (err) {
      error.value = errorMessage(err)
      missing.value = err instanceof ApiError && err.status === 404
    } finally {
      loading.value = false
    }
  }

  function reload() {
    const id = key()
    return id === null || id === undefined ? Promise.resolve() : run(id)
  }

  watch(key, (id) => {
    if (id === null || id === undefined) return
    void run(id)
  }, { immediate: true })

  return { data, loading, error, missing, reload }
}
