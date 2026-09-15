<script setup lang="ts">
/**
 * Serves both `/:section` and `/:section/:slug`.
 *
 * The section payload says what the URL means (`kind`); a second path segment
 * opens one item of it — a collection on a grid section, a piece on a list
 * section. Anything the API cannot resolve (404) gets the same not-found
 * treatment as the catch-all route, and an unreachable API gets a short,
 * quiet message rather than a blank page.
 */
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { publicApi } from '@/api/endpoints'
import { useQuery } from '@/composables/useQuery'
import ArticleDetail from '@/site/components/ArticleDetail.vue'
import ArticleList from '@/site/components/ArticleList.vue'
import CollectionDetail from '@/site/components/CollectionDetail.vue'
import CollectionGrid from '@/site/components/CollectionGrid.vue'
import NotFoundMessage from '@/site/components/NotFoundMessage.vue'
import PageArticle from '@/site/components/PageArticle.vue'
import PageContact from '@/site/components/PageContact.vue'
import StateMessage from '@/site/components/StateMessage.vue'
import { setPageTitle } from '@/site/lib/page-title'
import type { Article, Collection, Page, SectionPayload } from '@/types/api'

const props = defineProps<{
  /** the section key, the first URL segment */
  section: string
  /** the second URL segment, when there is one */
  slug?: string
}>()

const router = useRouter()

/* the layout falls back to the section's nav label until we know the subject */
setPageTitle(null)

const {
  data: sectionData,
  error: sectionError,
  missing: sectionMissing,
  reload: reloadSection,
} = useQuery<SectionPayload | null>(() => props.section, (key) => publicApi.section(key), null)

/** a payload only counts once it names the section this URL asks for */
const section = computed<SectionPayload | null>(() => {
  const payload = sectionData.value
  return payload && payload.section.key === props.section ? payload : null
})

const kind = computed(() => section.value?.section.kind ?? null)
const label = computed(() => section.value?.section.label ?? '')
const hasSlug = computed(() => Boolean(props.slug))

const isGridIndex = computed(() => !hasSlug.value && kind.value === 'grid')
const isListIndex = computed(() => !hasSlug.value && kind.value === 'list')
const isPage = computed(() => kind.value === 'article' || kind.value === 'contact')
const isCollectionDetail = computed(() => hasSlug.value && kind.value === 'grid')
const isArticleDetail = computed(() => hasSlug.value && kind.value === 'list')

const collections = computed(() => section.value?.collections ?? [])
const articles = computed(() => section.value?.articles ?? [])

/* ---------- one item of the section ---------- */

const {
  data: collectionData,
  error: collectionError,
  missing: collectionMissing,
  reload: reloadCollection,
} = useQuery<Collection | null>(
  () => (isCollectionDetail.value && props.slug ? props.slug : null),
  (key) => publicApi.collection(key),
  null,
)

/** the record only counts once it is the slug in the URL (not the previous one) */
const collection = computed<Collection | null>(() => {
  const value = collectionData.value
  return value && value.slug === props.slug ? value : null
})

const {
  data: articleData,
  error: articleError,
  missing: articleMissing,
  reload: reloadArticle,
} = useQuery<Article | null>(
  () => (isArticleDetail.value && props.slug ? props.slug : null),
  (key) => publicApi.article(key),
  null,
)

const article = computed<Article | null>(() => {
  const value = articleData.value
  return value && value.slug === props.slug ? value : null
})

/* ---------- standalone pages (article / contact kinds) ---------- */

const {
  data: pageData,
  error: pageError,
  missing: pageMissing,
  reload: reloadPage,
} = useQuery<Page | null>(
  () => (isPage.value ? section.value?.section.key ?? null : null),
  (key) => publicApi.page(key),
  null,
)

const page = computed<Page | null>(() => {
  const value = pageData.value
  const key = section.value?.section.key ?? null
  return value && key && value.slug === key ? value : null
})

/* ---------- the title bar / document.title ---------- */

watch(
  section,
  (value) => {
    if (value && !hasSlug.value) setPageTitle(value.section.label || null)
  },
  { immediate: true },
)

watch(
  collection,
  (value) => {
    if (value) setPageTitle(value.title || null)
  },
  { immediate: true },
)

watch(
  article,
  (value) => {
    if (value) setPageTitle(value.title || null)
  },
  { immediate: true },
)

watch(
  page,
  (value) => {
    if (value) setPageTitle(value.title || null)
  },
  { immediate: true },
)

const notFound = computed(
  () =>
    sectionMissing.value ||
    collectionMissing.value ||
    articleMissing.value ||
    pageMissing.value,
)

/* also re-runs when the route moves, so a second unknown URL is still named */
watch([notFound, () => props.section, () => props.slug], () => {
  if (notFound.value) setPageTitle('Not found')
})

/** the feed lives at `/`; its own key (if the nav exposes one) redirects there */
watch([kind, () => props.slug], () => {
  if (kind.value === 'feed' && !props.slug) void router.replace('/')
})
</script>

<template>
  <NotFoundMessage v-if="sectionMissing" />
  <StateMessage
    v-else-if="sectionError"
    lead="This section could not be loaded."
    :detail="sectionError"
    retryable
    @retry="reloadSection"
  />
  <StateMessage v-else-if="!section" lead="Loading…" />

  <!-- series: lightbox hero + contact-sheet strip -->
  <template v-else-if="isCollectionDetail">
    <NotFoundMessage v-if="collectionMissing" />
    <StateMessage
      v-else-if="collectionError"
      lead="This series could not be loaded."
      :detail="collectionError"
      retryable
      @retry="reloadCollection"
    />
    <StateMessage v-else-if="!collection" lead="Loading…" />
    <StateMessage
      v-else-if="!collection.images?.length"
      lead="No photographs yet."
      detail="This series has no published images."
    />
    <CollectionDetail
      v-else
      :section="props.section"
      :section-label="label"
      :collection="collection"
    />
  </template>

  <!-- one written piece -->
  <template v-else-if="isArticleDetail">
    <NotFoundMessage v-if="articleMissing" />
    <StateMessage
      v-else-if="articleError"
      lead="This piece could not be loaded."
      :detail="articleError"
      retryable
      @retry="reloadArticle"
    />
    <StateMessage v-else-if="!article" lead="Loading…" />
    <ArticleDetail
      v-else
      :section="props.section"
      :section-label="label"
      :article="article"
    />
  </template>

  <!-- a standalone page: biography or contact -->
  <template v-else-if="isPage">
    <NotFoundMessage v-if="pageMissing" />
    <StateMessage
      v-else-if="pageError"
      lead="This page could not be loaded."
      :detail="pageError"
      retryable
      @retry="reloadPage"
    />
    <StateMessage v-else-if="!page" lead="Loading…" />
    <PageContact v-else-if="page.kind === 'contact'" :page="page" />
    <PageArticle v-else :page="page" />
  </template>

  <!-- grid index: one card per collection -->
  <template v-else-if="isGridIndex">
    <CollectionGrid
      v-if="collections.length"
      :section="props.section"
      :collections="collections"
      :film="props.section === 'film'"
    />
    <StateMessage v-else lead="Nothing published here yet." />
  </template>

  <!-- list index: one bordered row per piece -->
  <template v-else-if="isListIndex">
    <ArticleList v-if="articles.length" :section="props.section" :articles="articles" />
    <StateMessage v-else lead="Nothing published here yet." />
  </template>

  <NotFoundMessage v-else />
</template>
