<script setup lang="ts">
/**
 * The back-office shell: sidebar + top bar + routed content.
 *
 * Sections the caller cannot use are shown disabled rather than removed, so the
 * shape of the back office stays legible while the permission model stays
 * honest (the server refuses them anyway).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { errorMessage } from '@/api/client'
import { SITE_NAME } from '@/brand'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { initials } from '@/admin/lib/format'

interface NavEntry {
  to: string
  label: string
  /** two-letter register tag — utilitarian, and no icon font needed */
  tag: string
  /** permission required to use the section; absent means "any session" */
  perm?: string
}

const NAV: NavEntry[] = [
  { to: '/admin', label: 'Overview', tag: 'OV' },
  { to: '/admin/articles', label: 'Articles', tag: 'AR' },
  { to: '/admin/collections', label: 'Collections', tag: 'CO' },
  { to: '/admin/images', label: 'Images', tag: 'IM' },
  { to: '/admin/feed', label: 'Home feed', tag: 'FD', perm: 'content.feed.manage' },
  { to: '/admin/pages', label: 'Pages', tag: 'PG' },
  { to: '/admin/users', label: 'People', tag: 'PE', perm: 'user.read' },
  { to: '/admin/roles', label: 'Roles', tag: 'RO', perm: 'user.read' },
  { to: '/admin/audit', label: 'Activity', tag: 'AC', perm: 'user.read' },
  { to: '/admin/data', label: 'Data', tag: 'DA', perm: 'settings.manage' },
]

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { info, error: toastError } = useToast()

const navOpen = ref(false)
const signingOut = ref(false)

onMounted(() => {
  void auth.ensureLoaded()
})

watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  },
)

const nav = computed(() => NAV.map((entry) => ({ ...entry, allowed: !entry.perm || auth.can(entry.perm) })))
const title = computed(() => (route.meta.title as string | undefined) ?? 'Overview')
const userName = computed(() => auth.user?.name ?? 'Signed in')
const userEmail = computed(() => auth.user?.email ?? auth.user?.wechatNickname ?? '')
const roleLabel = computed(() => auth.user?.role ?? '—')

function isActive(entry: NavEntry): boolean {
  const path = route.path
  return entry.to === '/admin' ? path === '/admin' || path === '/admin/' : path === entry.to || path.startsWith(`${entry.to}/`)
}

async function signOut(): Promise<void> {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await auth.logout()
    info('Signed out.')
    await router.push({ name: 'admin-login' })
  } catch (error) {
    toastError(errorMessage(error))
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <div class="admin-shell" :class="{ 'is-nav-open': navOpen }">
    <div class="admin-nav__backdrop" @click="navOpen = false" />

    <aside class="admin-nav">
      <RouterLink class="admin-brand" to="/admin">
        <span class="admin-brand__mark" aria-hidden="true">O</span>
        <span class="admin-brand__text">{{ SITE_NAME }}<em>Studio</em></span>
      </RouterLink>

      <nav class="admin-nav__body" aria-label="Back office sections">
        <ul class="admin-nav__list">
          <li v-for="entry in nav" :key="entry.to">
            <RouterLink v-if="entry.allowed" class="admin-nav__link" :class="{ 'is-active': isActive(entry) }" :to="entry.to">
              <span class="admin-nav__tag" aria-hidden="true">{{ entry.tag }}</span>
              <span class="admin-nav__label">{{ entry.label }}</span>
            </RouterLink>
            <span v-else class="admin-nav__link is-disabled" aria-disabled="true" :title="`Requires the ${entry.perm} permission`">
              <span class="admin-nav__tag" aria-hidden="true">{{ entry.tag }}</span>
              <span class="admin-nav__label">{{ entry.label }}</span>
              <span class="admin-nav__lock" aria-hidden="true">—</span>
            </span>
          </li>
        </ul>
      </nav>

      <p class="admin-nav__foot">
        Permissions are data: every change here is an audited row, not a deploy.
      </p>
    </aside>

    <div class="admin-main">
      <header class="admin-topbar">
        <button
          type="button"
          class="admin-navtoggle"
          :aria-expanded="navOpen"
          aria-label="Toggle sections"
          @click="navOpen = !navOpen"
        >
          <span class="admin-navtoggle__bar" aria-hidden="true" />
          <span class="admin-navtoggle__bar" aria-hidden="true" />
          <span class="admin-navtoggle__bar" aria-hidden="true" />
        </button>

        <h1 class="admin-topbar__title">{{ title }}</h1>

        <div class="admin-user">
          <span class="admin-user__avatar" aria-hidden="true">{{ initials(auth.user?.name) }}</span>
          <span class="admin-user__meta">
            <strong class="admin-user__name">{{ userName }}</strong>
            <span class="admin-user__sub">
              <span class="admin-chip">{{ roleLabel }}</span>
              <span v-if="userEmail" class="admin-user__email">{{ userEmail }}</span>
            </span>
          </span>
        </div>

        <div class="admin-topbar__actions">
          <a class="admin-btn admin-btn--sm admin-btn--ghost" href="/" target="_blank" rel="noopener">View site ↗</a>
          <button type="button" class="admin-btn admin-btn--sm" :disabled="signingOut" @click="signOut">
            {{ signingOut ? 'Signing out…' : 'Sign out' }}
          </button>
        </div>
      </header>

      <main class="admin-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>
