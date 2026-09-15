<script setup lang="ts">
/**
 * Pick an image out of the library — used for article covers, collection
 * covers and feed slides.
 */
import { ref, watch } from 'vue'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { usePagedList } from '@/admin/lib/usePagedList'
import type { Collection, ImageAsset, Status } from '@/types/api'
import ModalDialog from './ModalDialog.vue'
import ImageThumb from './ImageThumb.vue'
import PaginationBar from './PaginationBar.vue'
import EmptyState from './EmptyState.vue'
import ErrorState from './ErrorState.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    selectedId?: number | null
    defaultCollectionId?: number | null
  }>(),
  { title: 'Choose an image', selectedId: null, defaultCollectionId: null },
)

const emit = defineEmits<{ (e: 'close'): void; (e: 'select', image: ImageAsset): void }>()

const auth = useAuthStore()
const { query, items, total, loading, error, load, reset } = usePagedList<ImageAsset>(
  (listQuery) => adminApi.images.list(listQuery),
  { pageSize: 36, scope: 'all' },
)

const search = ref('')
const collections = ref<Collection[]>([])
let searchTimer: number | undefined

async function loadCollections(): Promise<void> {
  if (collections.value.length) return
  try {
    const page = await adminApi.collections.list({ pageSize: 100, scope: 'all' })
    collections.value = page.items
  } catch {
    collections.value = []
  }
}

function start(): void {
  search.value = query.q ?? ''
  query.collectionId = props.defaultCollectionId ?? null
  void loadCollections()
  void reset()
}

watch(
  () => props.open,
  (open) => {
    if (open) start()
  },
)

function onSearch(value: string): void {
  search.value = value
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    query.q = value
    void reset()
  }, 300)
}
function onStatus(value: string): void {
  query.status = value as Status | ''
  void reset()
}
function onCollection(value: string): void {
  query.collectionId = value ? Number(value) : null
  void reset()
}
function onScope(value: string): void {
  query.scope = value === 'mine' ? 'mine' : 'all'
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
function pick(image: ImageAsset): void {
  emit('select', image)
}
</script>

<template>
  <ModalDialog :open="open" :title="title" size="lg" @close="emit('close')">
    <div class="admin-filters admin-filters--tight">
      <input
        class="admin-input admin-input--search"
        type="search"
        placeholder="Search captions…"
        :value="search"
        @input="onSearch(($event.target as HTMLInputElement).value)"
      />
      <select class="admin-select" :value="query.status ?? ''" @change="onStatus(($event.target as HTMLSelectElement).value)">
        <option value="">Any status</option>
        <option value="draft">Draft</option>
        <option value="review">In review</option>
        <option value="published">Published</option>
        <option value="archived">Archived</option>
      </select>
      <select class="admin-select" :value="String(query.collectionId ?? '')" @change="onCollection(($event.target as HTMLSelectElement).value)">
        <option value="">Any collection</option>
        <option v-for="collection in collections" :key="collection.id" :value="collection.id">
          {{ collection.title }}
        </option>
      </select>
      <select
        v-if="auth.can('content.image.read_all')"
        class="admin-select"
        :value="query.scope ?? 'all'"
        @change="onScope(($event.target as HTMLSelectElement).value)"
      >
        <option value="all">All images</option>
        <option value="mine">Mine only</option>
      </select>
    </div>

    <ErrorState v-if="error" :message="error" @retry="load()" />

    <div v-else-if="loading && items.length === 0" class="admin-pickergrid">
      <span v-for="n in 12" :key="n" class="admin-skeleton admin-skeleton--tile" />
    </div>

    <EmptyState
      v-else-if="items.length === 0"
      title="No images match"
      message="Try another search, or upload one from the image library."
    />

    <div v-else class="admin-pickergrid">
      <button
        v-for="image in items"
        :key="image.id"
        type="button"
        class="admin-pick"
        :class="{ 'is-selected': image.id === selectedId }"
        @click="pick(image)"
      >
        <ImageThumb :image="image" size="fill" :ratio="1.4" :selected="image.id === selectedId" />
        <span class="admin-pick__caption">{{ image.caption || image.alt || `#${image.id}` }}</span>
      </button>
    </div>

    <PaginationBar
      :page="query.page ?? 1"
      :page-size="query.pageSize ?? 36"
      :total="total"
      :page-sizes="[24, 36, 72]"
      label="images"
      :disabled="loading"
      @update:page="goToPage"
      @update:page-size="changePageSize"
    />

    <template #footer>
      <button type="button" class="admin-btn" @click="emit('close')">Cancel</button>
    </template>
  </ModalDialog>
</template>
