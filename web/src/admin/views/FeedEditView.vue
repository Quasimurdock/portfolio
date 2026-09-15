<script setup lang="ts">
/**
 * The curated home slideshow.
 *
 * Slides are ordered by `position`; there is no bulk reorder endpoint for feed
 * items (unlike images), so a move swaps the two rows' positions with a PATCH
 * each. Everything here needs `content.feed.manage`.
 */
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import type { Article, Collection, FeedItem, ImageAsset, LinkKind, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FormField from '@/admin/components/FormField.vue'
import ImagePickerDialog from '@/admin/components/ImagePickerDialog.vue'
import ImageThumb from '@/admin/components/ImageThumb.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import ModalDialog from '@/admin/components/ModalDialog.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

const auth = useAuthStore()
const { success, error: toastError } = useToast()

const canManage = computed(() => auth.can('content.feed.manage'))

const slides = shallowRef<FeedItem[]>([])
const collections = shallowRef<Collection[]>([])
const articles = shallowRef<Article[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busyId = ref<number | null>(null)

onMounted(() => {
  void reload()
  if (canManage.value) void loadTargets()
})

async function reload(): Promise<void> {
  if (!canManage.value) {
    loading.value = false
    return
  }
  loading.value = true
  error.value = null
  try {
    const page = await adminApi.feedItems.list({ pageSize: 100, scope: 'all' })
    slides.value = [...page.items].sort((a, b) => a.position - b.position || a.id - b.id)
  } catch (err) {
    error.value = errorMessage(err)
    slides.value = []
  } finally {
    loading.value = false
  }
}

/** Targets for collection/article links — read-only helpers for the selects. */
async function loadTargets(): Promise<void> {
  try {
    const [collectionPage, articlePage] = await Promise.all([
      adminApi.collections.list({ pageSize: 100, scope: 'all' }),
      adminApi.articles.list({ pageSize: 100, scope: 'all' }),
    ])
    collections.value = collectionPage.items
    articles.value = articlePage.items
  } catch {
    collections.value = []
    articles.value = []
  }
}

function linkSummary(slide: FeedItem): string {
  switch (slide.linkKind) {
    case 'collection': {
      const target = collections.value.find((collection) => collection.id === slide.targetCollectionId)
      return target ? `→ ${target.title}` : slide.targetCollectionId ? `→ collection #${slide.targetCollectionId}` : '→ no collection chosen'
    }
    case 'article': {
      const target = articles.value.find((article) => article.id === slide.targetArticleId)
      return target ? `→ ${target.title}` : slide.targetArticleId ? `→ article #${slide.targetArticleId}` : '→ no article chosen'
    }
    case 'external':
      return slide.linkUrl ? `→ ${slide.linkUrl}` : '→ no URL set'
    default:
      return 'No link'
  }
}

/* --------------------------------------------------------------- reordering */

async function move(index: number, delta: number): Promise<void> {
  const next = index + delta
  if (next < 0 || next >= slides.value.length || busyId.value !== null) return
  const current = slides.value[index]
  const swap = slides.value[next]
  if (!current || !swap) return

  const previous = slides.value
  const copy = [...slides.value]
  copy[index] = swap
  copy[next] = current
  slides.value = copy
  busyId.value = current.id

  try {
    // positions are unique per row: swapping the two values is the whole move
    await adminApi.feedItems.update(current.id, { position: swap.position })
    await adminApi.feedItems.update(swap.id, { position: current.position })
    await reload()
  } catch (err) {
    slides.value = previous
    toastError(errorMessage(err))
  } finally {
    busyId.value = null
  }
}

/* ------------------------------------------------------------ status changes */

async function setStatus(slide: FeedItem, status: Status): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = slide.id
  const previous = slide.status
  slides.value = slides.value.map((row) => (row.id === slide.id ? { ...row, status } : row))
  try {
    const updated = await adminApi.feedItems.update(slide.id, { status })
    slides.value = slides.value.map((row) => (row.id === slide.id ? updated : row))
    success(status === 'published' ? 'Slide published.' : 'Slide returned to draft.')
  } catch (err) {
    slides.value = slides.value.map((row) => (row.id === slide.id ? { ...row, status: previous } : row))
    toastError(errorMessage(err))
  } finally {
    busyId.value = null
  }
}

/* -------------------------------------------------------------------- delete */

const confirmRow = ref<FeedItem | null>(null)
const deleting = ref(false)

async function confirmDelete(): Promise<void> {
  const slide = confirmRow.value
  if (!slide || deleting.value) return
  deleting.value = true
  try {
    await adminApi.feedItems.remove(slide.id)
    success('Slide deleted.')
    confirmRow.value = null
    await reload()
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    deleting.value = false
  }
}

/* -------------------------------------------------------------- add / edit */

interface SlideForm {
  image: ImageAsset | null
  caption: string
  linkKind: LinkKind
  linkUrl: string
  targetCollectionId: number | null
  targetArticleId: number | null
  status: Status
}

const dialogOpen = ref(false)
const editing = ref<FeedItem | null>(null)
const pickerOpen = ref(false)
const saving = ref(false)
const formError = ref('')
const fieldErrors = reactive({ image: '', link: '' })

const form = reactive<SlideForm>({
  image: null,
  caption: '',
  linkKind: 'none',
  linkUrl: '',
  targetCollectionId: null,
  targetArticleId: null,
  status: 'draft',
})

function openAdd(): void {
  editing.value = null
  form.image = null
  form.caption = ''
  form.linkKind = 'none'
  form.linkUrl = ''
  form.targetCollectionId = null
  form.targetArticleId = null
  form.status = 'draft'
  formError.value = ''
  fieldErrors.image = ''
  fieldErrors.link = ''
  dialogOpen.value = true
}

function openEdit(slide: FeedItem): void {
  editing.value = slide
  form.image = slide.image ?? null
  form.caption = slide.caption ?? ''
  form.linkKind = slide.linkKind
  form.linkUrl = slide.linkUrl ?? ''
  form.targetCollectionId = slide.targetCollectionId
  form.targetArticleId = slide.targetArticleId
  form.status = slide.status
  formError.value = ''
  fieldErrors.image = ''
  fieldErrors.link = ''
  dialogOpen.value = true
}

function onImagePicked(image: ImageAsset): void {
  form.image = image
  pickerOpen.value = false
}

function validate(): boolean {
  fieldErrors.image = form.image ? '' : 'Choose the photograph this slide shows.'
  if (form.linkKind === 'collection' && !form.targetCollectionId) fieldErrors.link = 'Pick the collection this slide opens.'
  else if (form.linkKind === 'article' && !form.targetArticleId) fieldErrors.link = 'Pick the article this slide opens.'
  else if (form.linkKind === 'external' && !/^https?:\/\//.test(form.linkUrl.trim())) fieldErrors.link = 'Use an absolute https:// URL.'
  else fieldErrors.link = ''
  return !fieldErrors.image && !fieldErrors.link
}

async function submit(): Promise<void> {
  if (saving.value || !validate()) return
  const image = form.image
  if (!image) return

  saving.value = true
  formError.value = ''
  try {
    const payload = {
      imageId: image.id,
      caption: form.caption,
      linkKind: form.linkKind,
      linkUrl: form.linkKind === 'external' ? form.linkUrl.trim() : null,
      targetCollectionId: form.linkKind === 'collection' ? form.targetCollectionId : null,
      targetArticleId: form.linkKind === 'article' ? form.targetArticleId : null,
      status: form.status,
    }
    if (editing.value) {
      await adminApi.feedItems.update(editing.value.id, payload)
      success('Slide updated.')
    } else {
      await adminApi.feedItems.create(payload)
      success('Slide added at the end of the show.')
    }
    dialogOpen.value = false
    await reload()
  } catch (err) {
    formError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Home feed</h2>
        <p class="admin-page__sub">
          The curated slideshow on the front page. Order here is the order visitors see.
        </p>
      </div>
      <div class="admin-page__actions">
        <button v-if="canManage" type="button" class="admin-btn admin-btn--sm admin-btn--primary" @click="openAdd">Add slide</button>
        <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="loading" @click="reload">Reload</button>
      </div>
    </header>

    <EmptyState
      v-if="!canManage"
      title="Not your surface"
      message="The home slideshow needs the content.feed.manage permission — ask an owner or an admin for it."
    />

    <ErrorState v-else-if="error" :message="error" @retry="reload()" />

    <LoadingState v-else-if="loading && slides.length === 0" label="Loading slides…" />

    <EmptyState
      v-else-if="slides.length === 0"
      title="No slides"
      message="The front page falls back to an empty stage until at least one slide is published."
    >
      <button v-if="canManage" type="button" class="admin-btn admin-btn--sm admin-btn--primary" @click="openAdd">Add the first slide</button>
    </EmptyState>

    <ol v-else class="admin-slidelist">
      <li v-for="(slide, index) in slides" :key="slide.id" class="admin-sliderow" :class="{ 'is-unpublished': slide.status !== 'published' }">
        <span class="admin-sliderow__index admin-num">{{ index + 1 }}</span>

        <ImageThumb :image="slide.image ?? null" :url="null" size="sm" />

        <div class="admin-sliderow__body">
          <p class="admin-sliderow__caption">{{ slide.caption || 'No caption' }}</p>
          <p class="admin-sliderow__meta">
            <span class="admin-mono">image #{{ slide.imageId }}</span>
            <span>{{ linkSummary(slide) }}</span>
          </p>
          <p class="admin-sliderow__meta">
            <StatusPill :status="slide.status" compact />
            <span class="admin-mono">position {{ slide.position }}</span>
          </p>
        </div>

        <div class="admin-rowactions admin-sliderow__actions">
          <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="index === 0 || busyId !== null" aria-label="Move up" @click="move(index, -1)">↑</button>
          <button
            type="button"
            class="admin-btn admin-btn--sm admin-btn--ghost"
            :disabled="index === slides.length - 1 || busyId !== null"
            aria-label="Move down"
            @click="move(index, 1)"
          >
            ↓
          </button>
          <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="busyId !== null" @click="openEdit(slide)">Edit</button>
          <button
            v-if="slide.status !== 'published'"
            type="button"
            class="admin-btn admin-btn--sm"
            :disabled="busyId !== null"
            @click="setStatus(slide, 'published')"
          >
            Publish
          </button>
          <button v-else type="button" class="admin-btn admin-btn--sm" :disabled="busyId !== null" @click="setStatus(slide, 'draft')">
            Unpublish
          </button>
          <button type="button" class="admin-btn admin-btn--sm admin-btn--danger-ghost" :disabled="busyId !== null" @click="confirmRow = slide">
            Delete
          </button>
        </div>
      </li>
    </ol>

    <ModalDialog
      :open="dialogOpen"
      :title="editing ? 'Edit slide' : 'Add slide'"
      :busy="saving"
      @close="dialogOpen = false"
    >
      <p v-if="formError" class="admin-formerror" role="alert">{{ formError }}</p>

      <FormField label="Photograph" :error="fieldErrors.image">
        <div class="admin-pickfield">
          <ImageThumb v-if="form.image" :image="form.image" size="md" />
          <span v-else class="admin-cover__empty">No photograph chosen</span>
          <button type="button" class="admin-btn admin-btn--sm" @click="pickerOpen = true">
            {{ form.image ? 'Change' : 'Choose from library' }}
          </button>
        </div>
      </FormField>

      <FormField label="Caption" for-id="slide-caption" hint="Shown beside the slide count on the home page.">
        <input id="slide-caption" v-model="form.caption" class="admin-input" type="text" />
      </FormField>

      <FormField label="Link" for-id="slide-link-kind" :error="fieldErrors.link">
        <select id="slide-link-kind" v-model="form.linkKind" class="admin-select">
          <option value="none">No link</option>
          <option value="collection">Opens a collection</option>
          <option value="article">Opens an article</option>
          <option value="external">External URL</option>
        </select>
      </FormField>

      <FormField v-if="form.linkKind === 'collection'" label="Collection" for-id="slide-collection">
        <select id="slide-collection" v-model="form.targetCollectionId" class="admin-select">
          <option :value="null">Choose a collection…</option>
          <option v-for="collection in collections" :key="collection.id" :value="collection.id">{{ collection.title }}</option>
        </select>
      </FormField>

      <FormField v-if="form.linkKind === 'article'" label="Article" for-id="slide-article">
        <select id="slide-article" v-model="form.targetArticleId" class="admin-select">
          <option :value="null">Choose an article…</option>
          <option v-for="article in articles" :key="article.id" :value="article.id">{{ article.title }}</option>
        </select>
      </FormField>

      <FormField v-if="form.linkKind === 'external'" label="URL" for-id="slide-url">
        <input id="slide-url" v-model="form.linkUrl" class="admin-input" type="url" placeholder="https://…" spellcheck="false" />
      </FormField>

      <FormField label="Status" for-id="slide-status">
        <select id="slide-status" v-model="form.status" class="admin-select">
          <option value="draft">Draft — hidden</option>
          <option value="review">In review</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </FormField>

      <template #footer>
        <button type="button" class="admin-btn" :disabled="saving" @click="dialogOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="saving" @click="submit">
          {{ saving ? 'Saving…' : editing ? 'Save slide' : 'Add slide' }}
        </button>
      </template>
    </ModalDialog>

    <ImagePickerDialog
      :open="pickerOpen"
      :selected-id="form.image?.id ?? null"
      title="Choose the slide photograph"
      @close="pickerOpen = false"
      @select="onImagePicked"
    />

    <ConfirmDialog
      :open="!!confirmRow"
      title="Delete this slide?"
      message="It disappears from the home slideshow. The photograph stays in the library."
      confirm-label="Delete slide"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="confirmRow = null"
    />
  </div>
</template>
