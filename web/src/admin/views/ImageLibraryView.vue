<script setup lang="ts">
/**
 * Every image the caller may see.
 *
 * The upload affordance is the demonstration of the architecture: the server
 * signs a ticket, the browser posts the bytes straight to the bucket, and only
 * the resulting URL is registered here. Both failure modes — no ticket, and a
 * rejected upload — surface as plain messages.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { usePagedList } from '@/admin/lib/usePagedList'
import { formatBytes, formatDimensions, formatDateTime, statusOptions } from '@/admin/lib/format'
import { uploadImage } from '@/admin/lib/upload'
import type { Collection, ImageAsset, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FilterBar from '@/admin/components/FilterBar.vue'
import FormField from '@/admin/components/FormField.vue'
import ImageThumb from '@/admin/components/ImageThumb.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import ModalDialog from '@/admin/components/ModalDialog.vue'
import PaginationBar from '@/admin/components/PaginationBar.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

interface UploadResult {
  name: string
  ok: boolean
  message: string
}

const auth = useAuthStore()
const { success, error: toastError } = useToast()

const canWrite = computed(() => auth.can('content.image.write'))
const canDelete = computed(() => auth.can('content.image.delete'))
const canReadAll = computed(() => auth.can('content.image.read_all'))
const defaultScope: 'mine' | 'all' = canReadAll.value ? 'all' : 'mine'

const statuses = statusOptions()

const { query, items, total, loading, error, load, reset, replace } = usePagedList<ImageAsset>(
  (listQuery) => adminApi.images.list(listQuery),
  { pageSize: 24, scope: defaultScope },
)

const search = ref('')
const collections = ref<Collection[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadNote = ref('')
const uploadResults = ref<UploadResult[]>([])
let searchTimer: number | undefined

onMounted(() => {
  void load()
  void loadCollections()
})

async function loadCollections(): Promise<void> {
  try {
    const page = await adminApi.collections.list({ pageSize: 100, scope: 'all' })
    collections.value = page.items
  } catch {
    collections.value = []
  }
}

function collectionName(id: number | null): string {
  if (id === null) return 'Unassigned'
  return collections.value.find((collection) => collection.id === id)?.title ?? `#${id}`
}

watch([() => query.status, () => query.collectionId, () => query.scope], () => {
  void reset()
})

watch(search, (value) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    query.q = value
    void reset()
  }, 300)
})

const filtersActive = computed(
  () =>
    !!(query.status || query.q) ||
    query.collectionId !== null && query.collectionId !== undefined ||
    (query.scope ?? defaultScope) !== defaultScope,
)

function clearFilters(): void {
  query.status = ''
  query.q = ''
  query.collectionId = null
  query.scope = defaultScope
  search.value = ''
  void reset()
}

function goToPage(page: number): void {
  query.page = page
  void load()
}

function changePageSize(size: number): void {
  query.pageSize = size
  void reset()
}

/* ------------------------------------------------------------------- upload */

async function onFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (!files.length || uploading.value || !canWrite.value) return

  uploading.value = true
  uploadResults.value = []
  try {
    for (const file of files) {
      uploadNote.value = `Signing ${file.name}…`
      try {
        const created = await uploadImage(file, {
          collectionId: query.collectionId ?? null,
          status: 'draft',
        })
        uploadResults.value = [...uploadResults.value, { name: file.name, ok: true, message: `Registered as #${created.id}` }]
      } catch (err) {
        const message = errorMessage(err)
        uploadResults.value = [...uploadResults.value, { name: file.name, ok: false, message }]
        toastError(`${file.name}: ${message}`)
      }
    }
  } finally {
    uploading.value = false
    uploadNote.value = ''
  }

  const ok = uploadResults.value.filter((result) => result.ok).length
  if (ok) {
    success(`${ok} ${ok === 1 ? 'image' : 'images'} uploaded.`)
    await load()
  }
}

/* ---------------------------------------------------------------- add by URL */

const addOpen = ref(false)
const addForm = reactive({
  url: '',
  thumbUrl: '',
  width: null as number | null,
  height: null as number | null,
  caption: '',
  alt: '',
  collectionId: null as number | null,
  status: 'draft' as Status,
})
const addErrors = reactive({ url: '' })
const addSaving = ref(false)
const addError = ref('')

function openAdd(): void {
  addForm.url = ''
  addForm.thumbUrl = ''
  addForm.width = null
  addForm.height = null
  addForm.caption = ''
  addForm.alt = ''
  addForm.collectionId = query.collectionId ?? null
  addForm.status = 'draft'
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

  addSaving.value = true
  addError.value = ''
  try {
    await adminApi.images.create({
      url,
      thumbUrl: addForm.thumbUrl.trim() || null,
      width: addForm.width,
      height: addForm.height,
      caption: addForm.caption,
      alt: addForm.alt,
      collectionId: addForm.collectionId,
      status: addForm.status,
    })
    success('Image added.')
    addOpen.value = false
    await load()
  } catch (err) {
    addError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    addSaving.value = false
  }
}

/* -------------------------------------------------------------------- edit */

const editOpen = ref(false)
const editing = ref<ImageAsset | null>(null)
const editForm = reactive({
  url: '',
  thumbUrl: '',
  width: null as number | null,
  height: null as number | null,
  caption: '',
  alt: '',
  collectionId: null as number | null,
  status: 'draft' as Status,
})
const editSaving = ref(false)
const editError = ref('')

function openEdit(image: ImageAsset): void {
  editing.value = image
  editForm.url = image.url
  editForm.thumbUrl = image.thumbUrl ?? ''
  editForm.width = image.width
  editForm.height = image.height
  editForm.caption = image.caption ?? ''
  editForm.alt = image.alt ?? ''
  editForm.collectionId = image.collectionId
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
      url: editForm.url.trim() || image.url,
      thumbUrl: editForm.thumbUrl.trim() || null,
      width: editForm.width,
      height: editForm.height,
      caption: editForm.caption,
      alt: editForm.alt,
      collectionId: editForm.collectionId,
      status: editForm.status,
    })
    replace((row) => row.id === image.id, updated)
    success('Image updated.')
    editOpen.value = false
  } catch (err) {
    editError.value = errorMessage(err)
    toastError(errorMessage(err))
  } finally {
    editSaving.value = false
  }
}

/* ------------------------------------------------------------------ delete */

const confirmRow = ref<ImageAsset | null>(null)
const deleting = ref(false)

async function confirmDelete(): Promise<void> {
  const image = confirmRow.value
  if (!image || deleting.value) return
  deleting.value = true
  try {
    await adminApi.images.remove(image.id)
    success('Image deleted.')
    confirmRow.value = null
    if (items.value.length === 1 && (query.page ?? 1) > 1) query.page = (query.page ?? 1) - 1
    await load()
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Image library</h2>
        <p class="admin-page__sub">
          {{ total }} {{ total === 1 ? 'photograph' : 'photographs' }} —
          the server stores URLs; the bytes live on OSS.
          <template v-if="!canReadAll">You see your own images only.</template>
        </p>
      </div>
      <div class="admin-page__actions">
        <input ref="fileInput" class="admin-fileinput" type="file" accept="image/*" multiple @change="onFiles" />
        <button v-if="canWrite" type="button" class="admin-btn admin-btn--sm admin-btn--primary" :disabled="uploading" @click="fileInput?.click()">
          {{ uploading ? uploadNote || 'Uploading…' : 'Upload to OSS' }}
        </button>
        <button v-if="canWrite" type="button" class="admin-btn admin-btn--sm" @click="openAdd">Add by URL</button>
      </div>
    </header>

    <p v-if="uploading" class="admin-note admin-note--busy" role="status">
      {{ uploadNote }} The browser is posting the file straight to the bucket — no bytes pass through the API.
    </p>

    <div v-if="uploadResults.length" class="admin-note">
      <div class="admin-note__head">
        <strong>Last upload</strong>
        <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" @click="uploadResults = []">Dismiss</button>
      </div>
      <ul class="admin-list admin-list--dense">
        <li v-for="result in uploadResults" :key="result.name" class="admin-list__row">
          <span class="admin-list__main">
            <span class="admin-list__title">{{ result.name }}</span>
            <span class="admin-list__meta" :class="result.ok ? 'is-ok' : 'is-bad'">{{ result.message }}</span>
          </span>
        </li>
      </ul>
    </div>

    <FilterBar :active="filtersActive" :busy="loading" @reset="clearFilters">
      <label class="admin-filter">
        <span class="admin-filter__label">Status</span>
        <select v-model="query.status" class="admin-select">
          <option value="">Any status</option>
          <option v-for="option in statuses" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>

      <label class="admin-filter">
        <span class="admin-filter__label">Collection</span>
        <select v-model="query.collectionId" class="admin-select">
          <option :value="null">Any collection</option>
          <option v-for="collection in collections" :key="collection.id" :value="collection.id">{{ collection.title }}</option>
        </select>
      </label>

      <label class="admin-filter admin-filter--grow">
        <span class="admin-filter__label">Search</span>
        <input v-model="search" class="admin-input admin-input--search" type="search" placeholder="Caption or alt text…" />
      </label>

      <label v-if="canReadAll" class="admin-filter">
        <span class="admin-filter__label">Scope</span>
        <select v-model="query.scope" class="admin-select">
          <option value="all">Everyone</option>
          <option value="mine">Mine only</option>
        </select>
      </label>
    </FilterBar>

    <ErrorState v-if="error" :message="error" @retry="load()" />

    <LoadingState v-else-if="loading && items.length === 0" label="Loading images…" />

    <EmptyState v-else-if="items.length === 0" title="No images" message="Nothing matches these filters.">
      <button v-if="canWrite" type="button" class="admin-btn admin-btn--sm admin-btn--primary" @click="fileInput?.click()">
        Upload the first one
      </button>
    </EmptyState>

    <template v-else>
      <ul class="admin-imagegrid">
        <li v-for="image in items" :key="image.id" class="admin-imagecard">
          <ImageThumb :image="image" size="fill" :ratio="1.4" />

          <div class="admin-imagecard__body">
            <p class="admin-imagecard__caption">{{ image.caption || image.alt || `#${image.id}` }}</p>
            <p class="admin-imagecard__meta">
              <span class="admin-num">{{ formatDimensions(image.width, image.height) }}</span>
              <span class="admin-num">{{ formatBytes(image.bytes) }}</span>
              <span v-if="image.format" class="admin-mono">{{ image.format }}</span>
            </p>
            <p class="admin-imagecard__meta">
              <StatusPill :status="image.status" compact />
              <span class="admin-chip">{{ collectionName(image.collectionId) }}</span>
            </p>
            <p class="admin-imagecard__meta admin-mono">{{ formatDateTime(image.updatedAt) }}</p>
          </div>

          <div class="admin-imagecard__actions">
            <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="!canWrite" @click="openEdit(image)">
              Edit
            </button>
            <button v-if="canDelete" type="button" class="admin-btn admin-btn--sm admin-btn--danger-ghost" @click="confirmRow = image">
              Delete
            </button>
          </div>
        </li>
      </ul>

      <PaginationBar
        :page="query.page ?? 1"
        :page-size="query.pageSize ?? 24"
        :total="total"
        :page-sizes="[12, 24, 48, 96]"
        :disabled="loading"
        label="images"
        @update:page="goToPage"
        @update:page-size="changePageSize"
      />
    </template>

    <ModalDialog :open="addOpen" title="Add an image by URL" :busy="addSaving" @close="addOpen = false">
      <p class="admin-modal__desc">Point at an object already on OSS or any CDN. The server keeps the URL, not the file.</p>
      <p v-if="addError" class="admin-formerror" role="alert">{{ addError }}</p>

      <FormField label="URL" for-id="lib-add-url" required :error="addErrors.url">
        <input id="lib-add-url" v-model="addForm.url" class="admin-input" type="url" spellcheck="false" placeholder="https://cdn.example.com/uploads/…" />
      </FormField>
      <FormField label="Thumbnail URL" for-id="lib-add-thumb" hint="Optional.">
        <input id="lib-add-thumb" v-model="addForm.thumbUrl" class="admin-input" type="url" spellcheck="false" />
      </FormField>
      <div class="admin-editor__row">
        <FormField label="Width" for-id="lib-add-width"><input id="lib-add-width" v-model.number="addForm.width" class="admin-input" type="number" min="0" /></FormField>
        <FormField label="Height" for-id="lib-add-height"><input id="lib-add-height" v-model.number="addForm.height" class="admin-input" type="number" min="0" /></FormField>
      </div>
      <FormField label="Caption" for-id="lib-add-caption"><input id="lib-add-caption" v-model="addForm.caption" class="admin-input" type="text" /></FormField>
      <FormField label="Alt text" for-id="lib-add-alt"><input id="lib-add-alt" v-model="addForm.alt" class="admin-input" type="text" /></FormField>
      <div class="admin-editor__row">
        <FormField label="Collection" for-id="lib-add-collection">
          <select id="lib-add-collection" v-model="addForm.collectionId" class="admin-select">
            <option :value="null">Unassigned</option>
            <option v-for="collection in collections" :key="collection.id" :value="collection.id">{{ collection.title }}</option>
          </select>
        </FormField>
        <FormField label="Status" for-id="lib-add-status">
          <select id="lib-add-status" v-model="addForm.status" class="admin-select">
            <option value="draft">Draft</option>
            <option value="review">In review</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </FormField>
      </div>

      <template #footer>
        <button type="button" class="admin-btn" :disabled="addSaving" @click="addOpen = false">Cancel</button>
        <button type="button" class="admin-btn admin-btn--primary" :disabled="addSaving" @click="submitAdd">
          {{ addSaving ? 'Adding…' : 'Add image' }}
        </button>
      </template>
    </ModalDialog>

    <ModalDialog :open="editOpen" title="Image" :busy="editSaving" @close="editOpen = false">
      <p v-if="editError" class="admin-formerror" role="alert">{{ editError }}</p>
      <ImageThumb v-if="editing" :image="editing" size="fill" :ratio="1.4" />
      <FormField label="URL" for-id="lib-edit-url" hint="The full-resolution object.">
        <input id="lib-edit-url" v-model="editForm.url" class="admin-input" type="url" spellcheck="false" />
      </FormField>
      <FormField label="Thumbnail URL" for-id="lib-edit-thumb">
        <input id="lib-edit-thumb" v-model="editForm.thumbUrl" class="admin-input" type="url" spellcheck="false" />
      </FormField>
      <div class="admin-editor__row">
        <FormField label="Width" for-id="lib-edit-width"><input id="lib-edit-width" v-model.number="editForm.width" class="admin-input" type="number" min="0" /></FormField>
        <FormField label="Height" for-id="lib-edit-height"><input id="lib-edit-height" v-model.number="editForm.height" class="admin-input" type="number" min="0" /></FormField>
      </div>
      <FormField label="Caption" for-id="lib-edit-caption"><input id="lib-edit-caption" v-model="editForm.caption" class="admin-input" type="text" /></FormField>
      <FormField label="Alt text" for-id="lib-edit-alt"><input id="lib-edit-alt" v-model="editForm.alt" class="admin-input" type="text" /></FormField>
      <div class="admin-editor__row">
        <FormField label="Collection" for-id="lib-edit-collection">
          <select id="lib-edit-collection" v-model="editForm.collectionId" class="admin-select">
            <option :value="null">Unassigned</option>
            <option v-for="collection in collections" :key="collection.id" :value="collection.id">{{ collection.title }}</option>
          </select>
        </FormField>
        <FormField label="Status" for-id="lib-edit-status">
          <select id="lib-edit-status" v-model="editForm.status" class="admin-select">
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

    <ConfirmDialog
      :open="!!confirmRow"
      title="Delete this image?"
      message="The row is removed from the library. The file itself stays on OSS."
      confirm-label="Delete image"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="confirmRow = null"
    />
  </div>
</template>
