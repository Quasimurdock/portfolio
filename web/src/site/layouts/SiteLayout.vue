<script setup lang="ts">
/**
 * The chrome around every public page — the old page's fixed header, header
 * placeholder, page-title bar, content region and footer, with the same
 * wrapper classes so site.css applies unchanged (`.site` / `.load-content` /
 * `.is-feed` are what keep the footer on the floor of a short page).
 *
 * The title bar is fed from two places: the route itself (the section's nav
 * label) and, once a view knows its subject, `setPageTitle` — see
 * `site/lib/page-title.ts`.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { publicApi } from '@/api/endpoints'
import { SITE_NAME } from '@/brand'
import { useQuery } from '@/composables/useQuery'
import { setPageTitle, usePageTitle } from '@/site/lib/page-title'
import type { Section } from '@/types/api'

const route = useRoute()

const { data: nav } = useQuery<Section[]>(() => 'nav', () => publicApi.nav(), [])

const navOpen = ref(false)
const scrolled = ref(false)
const year = new Date().getFullYear()

const isFeed = computed(() => route.name === 'feed')

/** the section the URL points at, as a `/key` path — what the nav compares to */
const currentPath = computed(() => {
  const segment = route.path.split('/').filter(Boolean)[0]
  return segment ? `/${segment}` : '/'
})

/** the home feed has no path segment of its own; every other section uses its key */
function navPath(item: Section): string {
  return item.kind === 'feed' ? '/' : `/${item.key}`
}

function isActive(item: Section): boolean {
  return navPath(item) === currentPath.value
}

function closeNav() {
  navOpen.value = false
}

/* ---------- page title ---------- */

const pageTitle = usePageTitle()

/** what the route alone can promise; a view may name something more precise */
const routeTitle = computed(() => {
  if (isFeed.value) return ''
  return nav.value.find((item) => navPath(item) === currentPath.value)?.label ?? ''
})

const displayTitle = computed(() => pageTitle.value ?? routeTitle.value)

watch(
  displayTitle,
  (title) => {
    document.title = title ? `${title} \u2013 ${SITE_NAME}` : SITE_NAME
  },
  { immediate: true },
)

/** a new route starts from the route's own title again */
watch(
  () => route.fullPath,
  () => {
    setPageTitle(null)
    closeNav()
  },
)

/* ---------- chrome ---------- */

function onScroll() {
  scrolled.value = window.pageYOffset > 8
}

/**
 * `.swiper-curated` sizes itself against the real footer height, so keep the
 * `--footer-h` token honest whatever the footer wraps to.
 */
const footerEl = ref<HTMLElement | null>(null)
let footerObserver: ResizeObserver | null = null

function applyFooterHeight() {
  const el = footerEl.value
  if (!el) return
  const height = Math.round(el.getBoundingClientRect().height)
  if (height > 0) document.documentElement.style.setProperty('--footer-h', `${height}px`)
}

onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  applyFooterHeight()

  const el = footerEl.value
  if (el && typeof ResizeObserver === 'function') {
    footerObserver = new ResizeObserver(applyFooterHeight)
    footerObserver.observe(el)
  } else {
    window.addEventListener('resize', applyFooterHeight)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', applyFooterHeight)
  footerObserver?.disconnect()
  footerObserver = null
})
</script>

<template>
  <div class="site" :class="{ 'is-feed': isFeed, 'page-feed': isFeed }">
    <!-- ===================== header ===================== -->
    <header
      class="site-header"
      :class="{ 'is-scrolled': scrolled, 'site-header--fade': isFeed }"
      role="banner"
    >
      <div class="container">
        <div class="site-header__inner">
          <div class="wrapper clear">
            <div class="nav-bar-wrapper clear">
              <div class="site-title">
                <RouterLink to="/" @click="closeNav">{{ SITE_NAME }}</RouterLink>
              </div>
              <button
                class="nav-trigger"
                type="button"
                :class="{ 'is-open': navOpen }"
                :aria-expanded="navOpen ? 'true' : 'false'"
                aria-controls="site-nav"
                aria-label="Toggle navigation"
                @click="navOpen = !navOpen"
              ></button>
            </div>
            <div class="nav-wrapper clear" :class="{ 'is-open': navOpen }">
              <nav id="site-nav" class="site-nav" role="navigation" aria-label="Primary">
                <ul>
                  <li v-for="item in nav" :key="item.key" :class="{ active: isActive(item) }">
                    <RouterLink :to="navPath(item)" @click="closeNav">{{ item.label }}</RouterLink>
                  </li>
                </ul>
              </nav>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="header-placeholder"></div>

    <div class="load-content">
      <!-- ================= page title bar ================= -->
      <div class="page-title">
        <div class="container">
          <div class="page-title__section">{{ displayTitle }}</div>
        </div>
      </div>

      <!-- ===================== main ===================== -->
      <main
        id="content"
        class="site-content"
        :class="[isFeed ? 'site-content--feed' : '', { 'has-page-title': !!displayTitle }]"
        role="main"
      >
        <slot><RouterView /></slot>
      </main>

      <!-- ===================== footer ===================== -->
      <footer ref="footerEl" class="site-footer" role="contentinfo">
        <div class="container">
          <div class="site-footer__wrap">
            <div class="footer-newsletter">
              <!-- The old newsletter form had no backend; the feed is the one
                   subscription a static site can actually honour. -->
              <p class="footer-paragraph">
                <a href="/feed.xml" target="_blank" rel="noopener">RSS</a>
              </p>
              <div class="footer-social">
                <p class="footer-paragraph">
                  <a href="https://www.instagram.com/" target="_blank" rel="noopener">Instagram</a>
                  <a href="https://twitter.com/" target="_blank" rel="noopener">Twitter</a>
                </p>
              </div>
            </div>
            <div class="footer-copyright">
              <p class="footer-paragraph">&copy; {{ year }} {{ SITE_NAME }} &middot; <RouterLink to="/admin">Studio</RouterLink></p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  </div>
</template>
