<script setup lang="ts">
/** Page envelope → "1–20 of 143" plus a windowed page list. */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    page: number
    pageSize: number
    total: number
    pageSizes?: number[]
    disabled?: boolean
    label?: string
  }>(),
  { pageSizes: () => [10, 20, 50, 100], disabled: false, label: 'items' },
)

const emit = defineEmits<{
  (e: 'update:page', value: number): void
  (e: 'update:pageSize', value: number): void
}>()

const lastPage = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))))
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const to = computed(() => Math.min(props.total, props.page * props.pageSize))

const pages = computed<number[]>(() => {
  const last = lastPage.value
  if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1)
  const start = Math.max(1, Math.min(props.page - 2, last - 4))
  return Array.from({ length: 5 }, (_, index) => start + index)
})

function go(next: number): void {
  const target = Math.min(Math.max(1, next), lastPage.value)
  if (target !== props.page && !props.disabled) emit('update:page', target)
}
</script>

<template>
  <div class="admin-pagination">
    <p class="admin-pagination__summary">
      <template v-if="total === 0">No {{ label }}</template>
      <template v-else>{{ from }}–{{ to }} of {{ total }} {{ label }}</template>
    </p>

    <nav v-if="lastPage > 1" class="admin-pagination__pages" aria-label="Pagination">
      <button type="button" class="admin-pagebtn" :disabled="disabled || page <= 1" @click="go(page - 1)">
        ‹ Prev
      </button>
      <button
        v-for="n in pages"
        :key="n"
        type="button"
        class="admin-pagebtn"
        :class="{ 'is-current': n === page }"
        :aria-current="n === page ? 'page' : undefined"
        :disabled="disabled"
        @click="go(n)"
      >
        {{ n }}
      </button>
      <button
        type="button"
        class="admin-pagebtn"
        :disabled="disabled || page >= lastPage"
        @click="go(page + 1)"
      >
        Next ›
      </button>
    </nav>

    <label v-if="pageSizes.length" class="admin-pagination__size">
      <span>Rows</span>
      <select
        class="admin-select admin-select--sm"
        :value="pageSize"
        :disabled="disabled"
        @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
      </select>
    </label>
  </div>
</template>
