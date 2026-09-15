<script setup lang="ts">
/**
 * One screen for creating and editing an article.
 *
 * The slug is derived from the title until the author touches it; the dirty
 * state is a JSON snapshot comparison, so any field change (including the cover)
 * is caught and `onBeforeRouteLeave` can ask before throwing work away.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { SLUG_PATTERN, formatDateTime, slugify, statusLabel } from '@/admin/lib/format'
import { sectionOptions, useSections } from '@/admin/lib/sections'
import type { Article, ImageAsset, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FormField from '@/admin/components/FormField.vue'
import ImagePickerDialog from '@/admin/components/ImagePickerDialog.vue'
import ImageThumb from '@/admin/components/ImageThumb.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

interface StatusStep {
  key: string
  label: string
  status: Status
}

const props = defineProps<{ id?: string }>()

const router = useRouter()
const auth = useAuthStore()
const { success, info, error: toastError } = useToast()

const articleId = computed(() => {
  const parsed = props.id ? Number(props.id) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
})
const isNew = computed(() => articleId.value === null)

const canWrite = computed(() => auth.can('content.article.write'))
const canPublish = computed(() => auth.can('content.article.publish'))

const { sections, ensureSections } = useSections()

const form = reactive({
  title: '',
  slug: '',
  sectionKey: '',
  excerpt: '',
  body: '',
  coverImageId: null as number | null,
})

const status = ref<Status>('draft')
const cover = ref<ImageAsset | null>(null)
const slugTouched = ref(false)
const saving = ref(false)
const statusPending = ref(false)
const pickerOpen = ref(false)
const serverError = ref('')
const errors = reactive({ title: '', slug: '', sectionKey: '' })

function snapshot(): string {
  return JSON.stringify({ ...form })
}

const baseline = ref(snapshot())
const dirty = computed(() => snapshot() !== baseline.value)
const charCount = computed(() => form.body.length)
const lineCount = computed(() => (form.body ? form.body.split('\n').length : 0))
const sectionChoices = computed(() => sectionOptions(sections.value, [form.sectionKey]))

const { data: loaded, loading, error, missing, run } = useAsyncData<Article | null>(
  () => (articleId.value === null ? Promise.resolve(null) : adminApi.articles.get(articleId.value)),
  null,
)

onMounted(() => {
  void ensureSections()
  if (articleId.value !== null) void run()
})

function applyArticle(article: Article): void {
  form.title = article.title
  form.slug = article.slug
  form.sectionKey = article.sectionKey
  form.excerpt = article.excerpt ?? ''
  form.body = article.body ?? ''
  form.coverImageId = article.coverImageId ?? null
  status.value = article.status
  // an existing row's slug is deliberate — never rewrite it from the title
  slugTouched.value = true
  cover.value = article.cover ?? null
  baseline.value = snapshot()
  if (!cover.value && form.coverImageId) void syncCover()
}

watch(loaded, (article) => {
  if (article) applyArticle(article)
})

async function syncCover(): Promise<void> {
  const id = form.coverImageId
  if (!id) {
    cover.value = null
    return
  }
  if (cover.value?.id === id) return
  try {
    cover.value = await adminApi.images.get(id)
  } catch {
    cover.value = null
  }
}

watch(
  () => form.coverImageId,
  () => {
    void syncCover()
  },
)

watch(
  () => form.title,
  (title) => {
    if (!slugTouched.value) form.slug = slugify(title)
  },
)

function validate(): boolean {
  errors.title = form.title.trim() ? '' : 'A title is required.'
  const slug = form.slug.trim()
  if (!slug) errors.slug = 'A slug is required — it is the public URL.'
  else if (!SLUG_PATTERN.test(slug)) errors.slug = 'Use lowercase letters, digits and single hyphens.'
  else errors.slug = ''
  errors.sectionKey = form.sectionKey ? '' : 'Choose the section this article belongs to.'
  return !errors.title && !errors.slug && !errors.sectionKey
}

async function save(): Promise<boolean> {
  if (saving.value) return false
  serverError.value = ''
  if (!validate()) {
    info('Check the highlighted fields.')
    return false
  }
  saving.value = true
  try {
    const payload = {
      title: form.title.trim(),
      slug: form.slug.trim(),
      sectionKey: form.sectionKey,
      excerpt: form.excerpt,
      body: form.body,
      coverImageId: form.coverImageId,
    }
    if (articleId.value === null) {
      const created = await adminApi.articles.create(payload)
      // clear the dirty flag *before* navigating, or the leave guard blocks us
      baseline.value = snapshot()
      status.value = created.status
      success('Article created.')
      await router.replace({ name: 'admin-article-edit', params: { id: String(created.id) } })
      return true
    }
    const updated = await adminApi.articles.update(articleId.value, payload)
    baseline.value = snapshot()
    status.value = updated.status
    success('Saved.')
    return true
  } catch (err) {
    serverError.value = errorMessage(err)
    toastError(errorMessage(err))
    return false
  } finally {
    saving.value = false
  }
}

/** Publish / archive need the publish permission; draft and review need write. */
const statusSteps = computed<StatusStep[]>(() => {
  const steps: StatusStep[] = []
  if (canPublish.value) {
    if (status.value !== 'published') steps.push({ key: 'publish', label: 'Publish', status: 'published' })
    if (status.value === 'published') steps.push({ key: 'unpublish', label: 'Unpublish', status: 'draft' })
    if (status.value !== 'archived') steps.push({ key: 'archive', label: 'Archive', status: 'archived' })
    if (status.value === 'archived') steps.push({ key: 'restore', label: 'Restore draft', status: 'draft' })
  } else if (canWrite.value) {
    if (status.value === 'draft') steps.push({ key: 'review', label: 'Submit for review', status: 'review' })
    if (status.value === 'review') steps.push({ key: 'draft', label: 'Back to draft', status: 'draft' })
    if (status.value === 'archived') steps.push({ key: 'restore', label: 'Restore draft', status: 'draft' })
  }
  return steps
})

async function changeStatus(next: Status): Promise<void> {
  if (articleId.value === null) {
    info('Save the article once before changing its status.')
    return
  }
  if (statusPending.value) return
  if (dirty.value) {
    const saved = await save()
    if (!saved) return
  }
  statusPending.value = true
  const previous = status.value
  status.value = next
  try {
    const updated = await adminApi.articles.setStatus(articleId.value, next)
    status.value = updated.status
    success(`Status is now ${statusLabel(updated.status)}.`)
  } catch (err) {
    status.value = previous
    toastError(errorMessage(err))
  } finally {
    statusPending.value = false
  }
}

function onCoverSelected(image: ImageAsset): void {
  form.coverImageId = image.id
  cover.value = image
  pickerOpen.value = false
}

/* ------------------------------------------------- leaving with unsaved work */

const leaveOpen = ref(false)
let resolveLeave: ((value: boolean) => void) | null = null

onBeforeRouteLeave(() => {
  if (!dirty.value || saving.value) return true
  leaveOpen.value = true
  return new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
})

function confirmLeave(): void {
  leaveOpen.value = false
  resolveLeave?.(true)
  resolveLeave = null
}

function cancelLeave(): void {
  leaveOpen.value = false
  resolveLeave?.(false)
  resolveLeave = null
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <p class="admin-page__crumb">
          <RouterLink class="admin-link" :to="{ name: 'admin-articles' }">← Articles</RouterLink>
        </p>
        <h2 class="admin-page__title">{{ isNew ? 'New article' : form.title || 'Untitled article' }}</h2>
        <p class="admin-page__meta">
          <StatusPill :status="status" />
          <span v-if="dirty" class="admin-state admin-state--dirty">Unsaved changes</span>
          <span v-else-if="!isNew" class="admin-state">All changes saved</span>
          <span v-if="!isNew" class="admin-mono">#{{ articleId }}</span>
        </p>
      </div>
      <div class="admin-page__actions">
        <button
          v-for="step in statusSteps"
          :key="step.key"
          type="button"
          class="admin-btn admin-btn--sm"
          :disabled="statusPending"
          @click="changeStatus(step.status)"
        >
          {{ step.label }}
        </button>
        <button
          v-if="canWrite"
          type="button"
          class="admin-btn admin-btn--sm admin-btn--primary"
          :disabled="saving || (!dirty && !isNew)"
          @click="save()"
        >
          {{ saving ? 'Saving…' : isNew ? 'Create article' : 'Save' }}
        </button>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="run()" />

    <EmptyState
      v-else-if="missing"
      title="Article not found"
      message="It may have been deleted, or it belongs to another author."
    >
      <RouterLink class="admin-btn admin-btn--sm" :to="{ name: 'admin-articles' }">Back to articles</RouterLink>
    </EmptyState>

    <LoadingState v-else-if="loading" label="Loading the article…" />

    <form v-else class="admin-editor" novalidate @submit.prevent="save()">
      <div class="admin-editor__main">
        <p v-if="serverError" class="admin-formerror" role="alert">{{ serverError }}</p>
        <p v-if="!canWrite" class="admin-denied admin-denied--block">
          You can read this article but not change it — saving requires the
          <code>content.article.write</code> permission.
        </p>

        <FormField label="Title" for-id="article-title" required :error="errors.title">
          <input
            id="article-title"
            v-model="form.title"
            class="admin-input admin-input--title"
            type="text"
            placeholder="A working title"
            :disabled="!canWrite"
          />
        </FormField>

        <div class="admin-editor__row">
          <FormField label="Slug" for-id="article-slug" required :error="errors.slug" hint="The public URL segment.">
            <input
              id="article-slug"
              v-model="form.slug"
              class="admin-input"
              type="text"
              spellcheck="false"
              :disabled="!canWrite"
              @input="slugTouched = true"
            />
          </FormField>

          <FormField label="Section" for-id="article-section" required :error="errors.sectionKey">
            <select id="article-section" v-model="form.sectionKey" class="admin-select" :disabled="!canWrite">
              <option value="">Choose a section…</option>
              <option v-for="option in sectionChoices" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </FormField>
        </div>

        <FormField label="Excerpt" for-id="article-excerpt" :hint="`${form.excerpt.length} characters — the teaser used in lists.`">
          <textarea id="article-excerpt" v-model="form.excerpt" class="admin-textarea" rows="3" :disabled="!canWrite" />
        </FormField>

        <FormField
          label="Body"
          for-id="article-body"
          :hint="`Markdown · ${charCount} characters · ${lineCount} lines`"
        >
          <textarea
            id="article-body"
            v-model="form.body"
            class="admin-textarea admin-textarea--body"
            rows="24"
            spellcheck="false"
            placeholder="# Heading&#10;&#10;Markdown paragraphs, *emphasis*, [links](https://example.com)…"
            :disabled="!canWrite"
          />
        </FormField>
      </div>

      <aside class="admin-editor__side">
        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">Cover</h3>
          </header>

          <button
            type="button"
            class="admin-cover"
            :disabled="!canWrite"
            :aria-label="form.coverImageId ? 'Change the cover image' : 'Choose a cover image'"
            @click="pickerOpen = true"
          >
            <ImageThumb v-if="form.coverImageId" :image="cover" :url="cover?.url ?? null" size="fill" :ratio="1.6" />
            <span v-else class="admin-cover__empty">No cover — pick one from the image library</span>
          </button>

          <div class="admin-cover__actions">
            <button type="button" class="admin-btn admin-btn--sm" :disabled="!canWrite" @click="pickerOpen = true">
              {{ form.coverImageId ? 'Change' : 'Choose image' }}
            </button>
            <button
              v-if="form.coverImageId"
              type="button"
              class="admin-btn admin-btn--sm admin-btn--ghost"
              :disabled="!canWrite"
              @click="form.coverImageId = null"
            >
              Remove
            </button>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">Details</h3>
          </header>
          <dl class="admin-deflist">
            <div class="admin-deflist__row">
              <dt>Status</dt>
              <dd><StatusPill :status="status" /></dd>
            </div>
            <div class="admin-deflist__row">
              <dt>Section</dt>
              <dd class="admin-mono">{{ form.sectionKey || '—' }}</dd>
            </div>
            <div class="admin-deflist__row">
              <dt>Slug</dt>
              <dd class="admin-mono">{{ form.slug || '—' }}</dd>
            </div>
            <div v-if="loaded" class="admin-deflist__row">
              <dt>Author</dt>
              <dd>{{ loaded.authorName ?? `#${loaded.authorId}` }}</dd>
            </div>
            <div v-if="loaded" class="admin-deflist__row">
              <dt>Updated</dt>
              <dd class="admin-num">{{ formatDateTime(loaded.updatedAt) }}</dd>
            </div>
          </dl>

          <a
            v-if="loaded && loaded.status === 'published'"
            class="admin-link"
            :href="`/${form.sectionKey}/${form.slug}`"
            target="_blank"
            rel="noopener"
          >
            View on the public site ↗
          </a>
        </section>
      </aside>
    </form>

    <ImagePickerDialog
      :open="pickerOpen"
      :selected-id="form.coverImageId"
      title="Choose a cover image"
      @close="pickerOpen = false"
      @select="onCoverSelected"
    />

    <ConfirmDialog
      :open="leaveOpen"
      title="Discard unsaved changes?"
      message="This article has edits that have not been saved. Leaving now loses them."
      confirm-label="Leave without saving"
      cancel-label="Stay on this page"
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </div>
</template>
