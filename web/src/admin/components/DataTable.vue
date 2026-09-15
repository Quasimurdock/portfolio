<script setup lang="ts" generic="T">
/**
 * Small generic table. Cell content comes from the `#cell-<key>` slot, so a
 * view keeps full control of formatting while the table owns the chrome,
 * the loading skeleton and the empty row.
 */
import type { AdminColumn } from '@/admin/lib/table'

const props = withDefaults(
  defineProps<{
    columns: AdminColumn[]
    rows: T[]
    /** property used as the `v-for` key, default `id` */
    rowKey?: string
    loading?: boolean
    skeletonRows?: number
    emptyText?: string
    rowClass?: (row: T) => string | undefined
    caption?: string
  }>(),
  {
    rowKey: 'id',
    loading: false,
    skeletonRows: 6,
    emptyText: 'Nothing here yet.',
    rowClass: undefined,
    caption: '',
  },
)

/**
 * Cell content arrives through `#cell-<key>`. The slot props are `any` on
 * purpose: the table is generic over the row type for `rows`/`rowClass`, but a
 * template-literal slot index signature cannot express "and `empty` takes no
 * props", so the loose signature keeps both the `<slot :row>` outlet and the
 * parent's destructuring valid.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
defineSlots<{ [name: string]: (props: any) => unknown }>()

function cellClass(column: AdminColumn): (string | false)[] {
  return [
    'admin-table__cell',
    `is-${column.align ?? (column.numeric ? 'right' : 'left')}`,
    !!column.numeric && 'is-numeric',
    !!column.hideBelow && `is-hidden-${column.hideBelow}`,
  ]
}

function rowId(row: T): string {
  return String((row as unknown as Record<string, unknown>)[props.rowKey] ?? '')
}

function cellValue(row: T, key: string): string {
  const value = (row as unknown as Record<string, unknown>)[key]
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return ''
  return String(value)
}
</script>

<template>
  <div class="admin-table__wrap" :aria-busy="loading">
    <table class="admin-table">
      <caption v-if="caption" class="admin-table__caption">{{ caption }}</caption>
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            :class="cellClass(column)"
            :style="column.width ? { width: column.width } : undefined"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-if="loading && rows.length === 0">
          <tr v-for="n in skeletonRows" :key="`skeleton-${n}`" class="admin-table__row is-skeleton">
            <td v-for="column in columns" :key="column.key" :class="cellClass(column)">
              <span class="admin-skeleton" />
            </td>
          </tr>
        </template>

        <tr v-else-if="rows.length === 0">
          <td :colspan="columns.length" class="admin-table__empty">
            <slot name="empty"><span class="admin-table__emptytext">{{ emptyText }}</span></slot>
          </td>
        </tr>

        <template v-else>
          <tr v-for="row in rows" :key="rowId(row)" class="admin-table__row" :class="rowClass?.(row)">
            <td v-for="column in columns" :key="column.key" :class="cellClass(column)">
              <slot :name="`cell-${column.key}`" :row="row">{{ cellValue(row, column.key) }}</slot>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
