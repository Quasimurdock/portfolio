/**
 * Session + capability store.
 *
 * The server is the authority: it returns the caller's *effective* permission
 * keys, and `can()` merely asks that list. The UI uses it to hide what would be
 * refused anyway — never as the only line of defence.
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError } from '@/api/client'
import { authApi } from '@/api/endpoints'
import type { User } from '@/types/api'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const permissions = ref<string[]>([])
  const loading = ref(false)
  /** true once we have asked the server at least once (successfully or not) */
  const resolved = ref(false)
  let inflight: Promise<void> | null = null

  const isAuthenticated = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value !== null && user.value.role !== 'viewer')

  function can(permission: string | string[]): boolean {
    const needed = Array.isArray(permission) ? permission : [permission]
    return needed.every((key) => permissions.value.includes(key))
  }

  /** any-of variant, handy for "show this button if either action is possible" */
  function canAny(...needed: string[]): boolean {
    return needed.some((key) => permissions.value.includes(key))
  }

  function apply(session: { user: User; permissions: string[] } | null) {
    user.value = session?.user ?? null
    permissions.value = session?.permissions ?? []
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      apply(await authApi.me())
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) apply(null)
      else throw error
    } finally {
      loading.value = false
      resolved.value = true
    }
  }

  /** Idempotent, shared by the router guard and the layout. */
  function ensureLoaded(): Promise<void> {
    if (resolved.value) return Promise.resolve()
    inflight ??= load().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function login(email: string, password: string) {
    apply(await authApi.login(email, password))
    resolved.value = true
  }

  /** dev convenience: sign in as a seeded account without a password */
  async function devLogin(email: string) {
    apply(await authApi.devLogin(email))
    resolved.value = true
  }

  async function logout() {
    await authApi.logout().catch(() => undefined)
    apply(null)
  }

  async function wechatAuthorizeUrl(redirect?: string) {
    return (await authApi.wechatUrl(redirect)).url
  }

  return {
    user,
    permissions,
    loading,
    resolved,
    isAuthenticated,
    isAdmin,
    can,
    canAny,
    ensureLoaded,
    load,
    login,
    devLogin,
    logout,
    wechatAuthorizeUrl,
  }
})
