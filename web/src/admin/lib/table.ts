/** Column description shared by `DataTable.vue` and the list views. */
export interface AdminColumn {
  /** used as the slot name (`#cell-<key>`) and as the fallback property */
  key: string
  label: string
  width?: string
  align?: 'left' | 'center' | 'right'
  /** tabular numbers + right alignment */
  numeric?: boolean
  /** hidden below 900px (`md`) or 1280px (`lg`) so narrow screens stay readable */
  hideBelow?: 'md' | 'lg'
}
