<script setup lang="ts">
/**
 * A collection and its photographs on one screen.
 *
 * The metadata is an ordinary form; the image manager beside it is the
 * interesting part:
 *   - order is persisted through `adminApi.images.reorder` (optimistic, rolled
 *     back on failure)
 *   - the cover is chosen by clicking a thumbnail
 *   - new photographs are added by OSS URL, or uploaded directly to the bucket
 *     through a signed ticket (see `lib/upload.ts`)
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRouter } from 'vue-router'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { SLUG_PATTERN, formatBytes, formatDimensions, slugify, statusLabel } from '@/admin/lib/format'
import { sectionOptions, useSections } from '@/admin/lib/sections'
import { uploadImage } from '@/admin/lib/upload'
import type { Collection, ImageAsset, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FormField from '@/admin/components/FormField.vue'
import ImageThumb from '@/admin/components/ImageThumb.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import ModalDialog from '@/admin/components/ModalDialog.vue'
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

const collectionId = computed(() => {
  const parsed = props.id ? Number(props.id) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
})
const isNew = computed(() => collectionId.value === null)

const canWrite = computed(() => auth.can('content.collection.write'))
const canPublish = computed(() => auth.can('content.collection.publish'))
const canDeleteCollection = computed(() => auth.can('content.collection.delete'))
const canWriteImages = computed(() => auth.can('content.image.write'))
const canDeleteImages = computed(() => auth.can('content.image.delete'))

const { sections, ensureSections } = useSections()

const form = reactive({
  title: '',
  slug: '',
  sectionKey: '',
  kind: 'series' as 'series' | 'album',
  summary: '',
  place: '',
  year: null as number | null,
  coverImageId: null as number | null,
})

const status = ref<Status>('draft')
const slugTouched = ref(false)
const saving = ref(false)
const deletingCollection = ref(false)
const statusPending = ref(false)
const serverError = ref('')
const errors = reactive({ title: '', slug: '', sectionKey: '' })

function snapshot(): string {
  return JSON.stringify({ ...form })
}

const baseline = ref(snapshot())
const dirty = computed(() => snapshot() !== baseline.value)
const sectionChoices = computed(() => sectionOptions(sections.value, [form.sectionKey]))

const { data: loaded, loading, error, missing, run } = useAsyncData<Collection | null>(
  () => (collectionId.value === null ? Promise.resolve(null) : adminApi.collections.get(collectionId.value)),
  null,
)

onMounted(() => {
  void ensureSections()
  if (collectionId.value !== null) void run()
})

watch(loaded, (collection) => {
  if (collection) applyCollection(collection)
})

function applyCollection(collection: Collection): void {
  form.title = collection.title
  form.slug = collection.slug
  form.sectionKey = collection.sectionKey
  form.kind = collection.kind
  form.summary = collection.summary ?? ''
  form.place = collection.place ?? ''
  form.year = collection.year ?? null
  form.coverImageId = collection.coverImageId ?? null
  status.value = collection.status
  slugTouched.value = true
  baseline.value = snapshot()
}

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
  errors.sectionKey = form.sectionKey ? '' : 'Choose the section this collection belongs to.'
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
      kind: form.kind,
      summary: form.summary,
      place: form.place,
      year: form.year,
      coverImageId: form.coverImageId,
    }
    if (collectionId.value === null) {
      const created = await adminApi.collections.create(payload)
      baseline.value = snapshot()
      status.value = created.status
      success('Collection created — now add its photographs.')
      await router.replace({ name: 'admin-collection-edit', params: { id: String(created.id) } })
      return true
    }
    const updated = await adminApi.collections.update(collectionId.value, payload)
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
  if (collectionId.value === null) {
    info('Save the collection once before changing its status.')
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
    const updated = await adminApi.collections.setStatus(collectionId.value, next)
    status.value = updated.status
    success(`Status is now ${statusLabel(updated.status)}.`)
  } catch (err) {
    status.value = previous
    toastError(errorMessage(err))
  } finally {
    statusPending.value = false
  }
}

async function removeCollection(): Promise<void> {
  const id = collectionId.value
  if (id === null || deletingCollection.value) return
  deletingCollection.value = true
  try {
    await adminApi.collections.remove(id)
    success('Collection deleted.')
    confirmDeleteOpen.value = false
    await router.push({ name: 'admin-collections' })
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    deletingCollection.value = false
  }
}

/* ------------------------------------------------------- the image manager */

const images = shallowRef<ImageAsset[]>([])
const imagesLoading = ref(false)
const imagesError = ref<string | null>(null)
const reordering = ref(false)
const uploading = ref(false)
const uploadNote = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

async function loadImages(): Promise<void> {
  const id = collectionId.value
  if (id === null) {
    images.value = []
    return
  }
  imagesLoading.value = true
  imagesError.value = null
  try {
    const page = await adminApi.images.list({ collectionId: id, pageSize: 200, scope: 'all' })
    images.value = [...page.items].sort((a, b) => a.position - b.position || a.id - b.id)
  } catch (err) {
    imagesError.value = errorMessage(err)
    images.value = []
  } finally {
    imagesLoading.value = false
  }
}

watch(collectionId, () => {
  void loadImages()
})

onMounted(() => {
  if (collectionId.value !== null) void loadImages()
})

async function move(index: number, delta: number): Promise<void> {
  const next = index + delta
  if (next < 0 || next >= images.value.length || reordering.value) return
  const id = collectionId.value
  if (id === null) return

  const previous = images.value
  const copy = [...images.value]
  const moved = copy.splice(index, 1)[0]
  if (!moved) return
  copy.splice(next, 0, moved)
  images.value = copy
  reordering.value = true
  try {
    await adminApi.images.reorder(id, copy.map((image) => image.id))
    // positions are the server's business — re-read so the numbers stay true
    await loadImages()
  } catch (err) {
    images.value = previous
    toastError(errorMessage(err))
  } finally {
    reordering.value = false
  }
}

async function saveCaption(image: ImageAsset, value: string): Promise<void> {
  const caption = value.trim()
  if (caption === (image.caption ?? '')) return
  const previous = images.value
  images.value = images.value.map((row) => (row.id === image.id ? { ...row, caption } : row))
  try {
    const updated = await adminApi.images.update(image.id, { caption })
    images.value = images.value.map((row) => (row.id === image.id ? updated : row))
    success('Caption saved.')
  } catch (err) {
    images.value = previous
    toastError(errorMessage(err))
  }
}

function setCover(image: ImageAsset): void {
  if (!canWrite.value) return
  form.coverImageId = form.coverImageId === image.id ? null : image.id
}

/* edit one photograph */
const editOpen = ref(false)
const editing = ref<ImageAsset | null>(null)
const editForm = reactive({ caption: '', alt: '', width: null as number | null, height: null as number | null, status: 'draft' as Status })
const editSaving = ref(false)
const editError = ref('')

function openEdit(image: ImageAsset): void {
  editing.value = image
  editForm.caption = image.caption ?? ''
  editForm.alt = image.alt ?? ''
  editForm.width = image.width
  editForm.height = image.height
  editForm.status = image.status
  editError.value = ''
  editOpen.value = true
}

async function saveEdit(): Promise<void> {
  const image = editing.value
  if (!image || editSaving.value) return
  editSaving.value = true
  editError.value = ''
  try {
    const updated = await adminApi.images.update(image.id, {
      caption: editForm.caption,
      alt: editForm.alt,
      width: editForm.width,
      height: editForm.height,
      status: editForm.status,
    })
    images.value = images.value.map((row) => (row.id === image.id ? updated : row))
    success('Photograph updated.')
    editOpen.value = false
  } catch (err) {
    editError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    editSaving.value = false
  }
}

/* remove one photograph */
const removeOpen = ref(false)
const removing = ref<ImageAsset | null>(null)
const removeBusy = ref(false)

function askRemove(image: ImageAsset): void {
  removing.value = image
  removeOpen.value = true
}

async function confirmRemove(): Promise<void> {
  const image = removing.value
  if (!image || removeBusy.value) return
  removeBusy.value = true
  try {
    await adminApi.images.remove(image.id)
    if (form.coverImageId === image.id) form.coverImageId = null
    success('Photograph removed from the collection.')
    removeOpen.value = false
    removing.value = null
    await loadImages()
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    removeBusy.value = false
  }
}

/* add by URL */
const addOpen = ref(false)
const addForm = reactive({ url: '', thumbUrl: '', caption: '', alt: '', width: null as number | null, height: null as number | null })
const addErrors = reactive({ url: '' })
const addSaving = ref(false)
const addError = ref('')

function openAdd(): void {
  addForm.url = ''
  addForm.thumbUrl = ''
  addForm.caption = ''
  addForm.alt = ''
  addForm.width = null
  addForm.height = null
  addErrors.url = ''
  addError.value = ''
  addOpen.value = true
}

async function submitAdd(): Promise<void> {
  if (addSaving.value) return
  const url = addForm.url.trim()
  addErrors.url = !url
    ? 'A URL is required.'
    : /^(https?:\/\/|\/)/.test(url)
      ? ''
      : 'Use an absolute https:// URL or a site-relative path.'
  if (addErrors.url) return
  const id = collectionId.value
  if (id === null) return

  addSaving.value = true
  addError.value = ''
  try {
    await adminApi.images.create({
      url,
      thumbUrl: addForm.thumbUrl.trim() || null,
      caption: addForm.caption,
      alt: addForm.alt,
      width: addForm.width,
      height: addForm.height,
      collectionId: id,
      status: 'draft',
    })
    success('Photograph added at the end of the set.')
    addOpen.value = false
    await loadImages()
  } catch (err) {
    addError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    addSaving.value = false
  }
}

/* upload straight to the bucket */
async function onFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  const id = collectionId.value
  if (!files.length || id === null || uploading.value) return

  uploading.value = true
  let done = 0
  const failures: string[] = []
  try {
    for (const file of files) {
      uploadNote.value = `Uploading ${file.name}…`
      try {
        await uploadImage(file, { collectionId: id, status: 'draft' })
        done += 1
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`)
      }
    }
  } finally {
    uploading.value = false
    uploadNote.value = ''
  }

  if (done) success(`${done} ${done === 1 ? 'photograph' : 'photographs'} uploaded.`)
  for (const failure of failures) toastError(failure)
  if (done) await loadImages()
}

/* ------------------------------------------------- leaving with unsaved work */

const leaveOpen = ref(false)
const confirmDeleteOpen = ref(false)
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
          <RouterLink class="admin-link" :to="{ name: 'admin-collections' }">← Collections</RouterLink>
        </p>
        <h2 class="admin-page__title">{{ isNew ? 'New collection' : form.title || 'Untitled collection' }}</h2>
        <p class="admin-page__meta">
          <StatusPill :status="status" />
          <span v-if="dirty" class="admin-state admin-state--dirty">Unsaved changes</span>
          <span v-else-if="!isNew" class="admin-state">All changes saved</span>
          <span v-if="!isNew" class="admin-mono">#{{ collectionId }}</span>
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
          {{ saving ? 'Saving…' : isNew ? 'Create collection' : 'Save' }}
        </button>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="run()" />

    <EmptyState
      v-else-if="missing"
      title="Collection not found"
      message="It may have been deleted, or it belongs to another author."
    >
      <RouterLink class="admin-btn admin-btn--sm" :to="{ name: 'admin-collections' }">Back to collections</RouterLink>
    </EmptyState>

    <LoadingState v-else-if="loading" label="Loading the collection…" />

    <template v-else>
      <div class="admin-editor">
        <div class="admin-editor__main">
          <p v-if="serverError" class="admin-formerror" role="alert">{{ serverError }}</p>
          <p v-if="!canWrite" class="admin-denied admin-denied--block">
            You can read this collection but not change it — saving requires the
            <code>content.collection.write</code> permission.
          </p>

          <FormField label="Title" for-id="collection-title" required :error="errors.title">
            <input id="collection-title" v-model="form.title" class="admin-input admin-input--title" type="text" :disabled="!canWrite" />
          </FormField>

          <div class="admin-editor__row">
            <FormField label="Slug" for-id="collection-slug" required :error="errors.slug" hint="The public URL segment.">
              <input
                id="collection-slug"
                v-model="form.slug"
                class="admin-input"
                type="text"
                spellcheck="false"
                :disabled="!canWrite"
                @input="slugTouched = true"
              />
            </FormField>

            <FormField label="Section" for-id="collection-section" required :error="errors.sectionKey">
              <select id="collection-section" v-model="form.sectionKey" class="admin-select" :disabled="!canWrite">
                <option value="">Choose a section…</option>
                <option v-for="option in sectionChoices" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </FormField>
          </div>

          <div class="admin-editor__row">
            <FormField label="Kind" for-id="collection-kind" hint="A series is a coherent body of work; an album gathers.">
              <select id="collection-kind" v-model="form.kind" class="admin-select" :disabled="!canWrite">
                <option value="series">Series</option>
                <option value="album">Album</option>
              </select>
            </FormField>

            <FormField label="Place" for-id="collection-place">
              <input id="collection-place" v-model="form.place" class="admin-input" type="text" placeholder="e.g. Hokkaido" :disabled="!canWrite" />
            </FormField>

            <FormField label="Year" for-id="collection-year">
              <input id="collection-year" v-model.number="form.year" class="admin-input" type="number" min="1800" max="2200" :disabled="!canWrite" />
            </FormField>
          </div>

          <FormField label="Summary" for-id="collection-summary" :hint="`${form.summary.length} characters — the introduction on the collection page.`">
            <textarea id="collection-summary" v-model="form.summary" class="admin-textarea" rows="5" :disabled="!canWrite" />
          </FormField>
        </div>

        <aside class="admin-editor__side">
          <section class="admin-card">
            <header class="admin-card__head">
              <h3 class="admin-card__title">Cover</h3>
            </header>
            <ImageThumb v-if="form.coverImageId" :image="images.find((image) => image.id === form.coverImageId) ?? null" size="fill" :ratio="1.5" />
            <p v-else class="admin-cover__empty">Click a photograph below to use it as the cover.</p>
            <p class="admin-field__hint">
              {{ form.coverImageId ? `Photograph #${form.coverImageId}` : 'No cover chosen' }}
            </p>
          </section>

          <section class="admin-card">
            <header class="admin-card__head">
              <h3 class="admin-card__title">Details</h3>
            </header>
            <dl class="admin-deflist">
              <div class="admin-deflist__row"><dt>Status</dt><dd><StatusPill :status="status" /></dd></div>
              <div class="admin-deflist__row"><dt>Kind</dt><dd>{{ form.kind === 'album' ? 'Album' : 'Series' }}</dd></div>
              <div class="admin-deflist__row"><dt>Slug</dt><dd class="admin-mono">{{ form.slug || '—' }}</dd></div>
              <div class="admin-deflist__row"><dt>Photographs</dt><dd class="admin-num">{{ images.length }}</dd></div>
              <div v-if="loaded" class="admin-deflist__row"><dt>Author</dt><dd>{{ loaded.authorName ?? `#${loaded.authorId}` }}</dd></div>
            </dl>
          </section>

          <section v-if="canDeleteCollection && !isNew" class="admin-card admin-card--danger">
            <header class="admin-card__head">
              <h3 class="admin-card__title">Delete</h3>
            </header>
            <p class="admin-card__note">
              Removing the collection does not delete its photographs, but they lose their place in it.
            </p>
            <button type="button" class="admin-btn admin-btn--sm admin-btn--danger" @click="confirmDeleteOpen = true">
              Delete collection
            </button>
          </section>
        </aside>
      </div>

      <section class="admin-card">
        <header class="admin-card__head">
          <div>
            <h3 class="admin-card__title">
              Photographs
              <span class="admin-card__count">{{ images.length }}</span>
            </h3>
            <p class="admin-card__note">Order here is the order on the site. Click a thumbnail to set the cover.</p>
          </div>
          <div class="admin-card__actions">
            <input ref="fileInput" class="admin-fileinput" type="file" accept="image/*" multiple @change="onFiles" />
            <button
              v-if="canWriteImages"
              type="button"
              class="admin-btn admin-btn--sm"
              :disabled="uploading || isNew"
              @click="fileInput?.click()"
            >
              {{ uploading ? uploadNote || 'Uploading…' : 'Upload files' }}
            </button>
            <button v-if="canWriteImages" type="button" class="admin-btn admin-btn--sm" :disabled="isNew" @click="openAdd">
              Add by URL
            </button>
            <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="imagesLoading" @click="loadImages">
              Reload
            </button>
          </div>
        </header>

        <EmptyState
          v-if="isNew"
          title="Save the collection first"
          message="Photographs need a collection to belong to — create it, then come back to this panel."
        />

        <ErrorState v-else-if="imagesError" :message="imagesError" @retry="loadImages()" />

        <LoadingState v-else-if="imagesLoading && images.length === 0" label="Loading photographs…" />

        <EmptyState
          v-else-if="images.length === 0"
          title="No photographs yet"
          message="Add them by OSS URL, or upload straight to the bucket with a signed ticket."
        />

        <ul v-else class="admin-imagelist">
          <li v-for="(image, index) in images" :key="image.id" class="admin-imagerow" :class="{ 'is-cover': form.coverImageId === image.id }">
            <span class="admin-imagerow__index admin-num">{{ index + 1 }}</span>

            <button type="button" class="admin-imagerow__thumb" :disabled="!canWrite" @click="setCover(image)">
              <ImageThumb :image="image" size="sm" :selected="form.coverImageId === image.id" />
            </button>

            <div class="admin-imagerow__body">
              <input
                class="admin-input admin-input--inline"
                type="text"
                :value="image.caption ?? ''"
                placeholder="Caption"
                :disabled="!canWriteImages"
                @change="saveCaption(image, ($event.target as HTMLInputElement).value)"
              />
              <p class="admin-imagerow__meta">
                <span v-if="form.coverImageId === image.id" class="admin-chip">Cover</span>
                <span class="admin-num">{{ formatDimensions(image.width, image.height) }}</span>
                <span class="admin-num">{{ formatBytes(image.bytes) }}</span>
                <StatusPill :status="image.status" compact />
              </p>
            </div>

            <div class="admin-rowactions admin-imagerow__actions">
              <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="index === 0 || reordering" aria-label="Move up" @click="move(index, -1)">
                ↑
              </button>
              <button
                type="button"
                class="admin-btn admin-btn--sm admin-btn--ghost"
                :disabled="index === images.length - 1 || reordering"
                aria-label="Move down"
                @click="move(index, 1)"
              >
                ↓
              </button>
              <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="!canWriteImages" @click="openEdit(image)">
                Edit
              </button>
              <button
                v-if="canDeleteImages"
                type="button"
                class="admin-btn admin-btn--sm admin-btn--danger-ghost"
                @click="askRemove(image)"
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <!-- edit one photograph -->
    <ModalDialog :open="editOpen" title="Photograph" :busy="editSaving" @close="editOpen = false">
      <p v-if="editError" class="admin-formerror" role="alert">{{ editError }}</p>
      <FormField label="Caption" for-id="image-caption">
        <input id="image-caption" v-model="editForm.caption" class="admin-input" type="text" />
      </FormField>
      <FormField label="Alt text" for-id="image-alt" hint="Read by screen readers and search engines.">
        <input id="image-alt" v-model="editForm.alt" class="admin-input" type="text" />
      </FormField>
      <div class="admin-editor__row">
        <FormField label="Width" for-id="image-width"><input id="image-width" v-model.number="editForm.width" class="admin-input" type="number" min="0" /></FormField>
        <FormField label="Height" for-id="image-height"><input id="image-height" v-model.number="editForm.height" class="admin-input" type="number" min="0" /></FormField>
        <FormField label="Status" for-id="image-status">
          <select id="image-status" v-model="editForm.status" class="admin-select">
            <option value="draft">Draft</option>
            <option value="review">In review</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </FormField>
      </div>
      <template #footer>
        <button type="button" class="admin-btn" :disabled="editSaving" @click="editOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="editSaving" @click="saveEdit">
          {{ editSaving ? 'Saving…' : 'Save' }}
        </button>
      </template>
    </ModalDialog>

    <!-- add by OSS URL -->
    <ModalDialog :open="addOpen" title="Add a photograph by URL" :busy="addSaving" @close="addOpen = false">
      <p class="admin-modal__desc">
        The server stores URLs, never bytes. Paste the address of an object already on OSS (or any CDN).
      </p>
      <p v-if="addError" class="admin-formerror" role="alert">{{ addError }}</p>
      <FormField label="URL" for-id="add-url" required :error="addErrors.url">
        <input id="add-url" v-model="addForm.url" class="admin-input" type="url" placeholder="https://cdn.example.com/uploads/…" spellcheck="false" />
      </FormField>
      <FormField label="Thumbnail URL" for-id="add-thumb" hint="Optional — falls back to the full image.">
        <input id="add-thumb" v-model="addForm.thumbUrl" class="admin-input" type="url" spellcheck="false" />
      </FormField>
      <FormField label="Caption" for-id="add-caption"><input id="add-caption" v-model="addForm.caption" class="admin-input" type="text" /></FormField>
      <FormField label="Alt text" for-id="add-alt"><input id="add-alt" v-model="addForm.alt" class="admin-input" type="text" /></FormField>
      <div class="admin-editor__row">
        <FormField label="Width" for-id="add-width"><input id="add-width" v-model.number="addForm.width" class="admin-input" type="number" min="0" /></FormField>
        <FormField label="Height" for-id="add-height"><input id="add-height" v-model.number="addForm.height" class="admin-input" type="number" min="0" /></FormField>
      </div>
      <template #footer>
        <button type="button" class="admin-btn" :disabled="addSaving" @click="addOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="addSaving" @click="submitAdd">
          {{ addSaving ? 'Adding…' : 'Add photograph' }}
        </button>
      </template>
    </ModalDialog>

    <ConfirmDialog
      :open="removeOpen"
      title="Remove this photograph?"
      message="The image row is deleted. The file stays on OSS — the server never owned it."
      confirm-label="Remove"
      :busy="removeBusy"
      @confirm="confirmRemove"
      @cancel="removeOpen = false; removing = null"
    />

    <ConfirmDialog
      :open="confirmDeleteOpen"
      title="Delete this collection?"
      :message="`“${form.title}” and its place in the navigation will be removed.`"
      confirm-label="Delete collection"
      :busy="deletingCollection"
      @confirm="removeCollection"
      @cancel="confirmDeleteOpen = false"
    />

    <ConfirmDialog
      :open="leaveOpen"
      title="Discard unsaved changes?"
      message="This collection has edits that have not been saved."
      confirm-label="Leave without saving"
      cancel-label="Stay on this page"
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </div>
</template>
