<script setup lang="ts">
/**
 * Focus-trapped dialog: Escape closes, Tab cycles inside, the page behind is
 * frozen, and focus returns to whatever opened it. No library, no portal
 * dependency beyond Vue's own `<Teleport>`.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    size?: 'sm' | 'md' | 'lg'
    /** while busy the dialog cannot be dismissed */
    busy?: boolean
  }>(),
  { description: '', size: 'md', busy: false },
)

const emit = defineEmits<{ (e: 'close'): void }>()

const panel = ref<HTMLElement | null>(null)
let lastActive: HTMLElement | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const PREFERRED = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

function focusables(): HTMLElement[] {
  if (!panel.value) return []
  return Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/** Prefer the first real field, so a form dialog opens ready to type. */
function initialFocus(): HTMLElement | null {
  if (!panel.value) return null
  const field = Array.from(panel.value.querySelectorAll<HTMLElement>(PREFERRED)).find(
    (el) => el.offsetParent !== null,
  )
  return field ?? focusables()[0] ?? panel.value
}

function close(): void {
  if (!props.busy) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const list = focusables()
  if (!list.length) {
    event.preventDefault()
    panel.value?.focus()
    return
  }
  const first = list[0]
  const last = list[list.length - 1]
  if (!first || !last) return
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey && (active === first || !panel.value?.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      lastActive = document.activeElement as HTMLElement | null
      document.body.classList.add('admin-no-scroll')
      await nextTick()
      initialFocus()?.focus()
    } else {
      document.body.classList.remove('admin-no-scroll')
      lastActive?.focus()
      lastActive = null
    }
  },
)

onBeforeUnmount(() => {
  document.body.classList.remove('admin-no-scroll')
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="admin-modal" @click.self="close">
      <div
        ref="panel"
        class="admin-modal__panel"
        :class="`admin-modal__panel--${size}`"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="admin-modal__head">
          <h2 class="admin-modal__title">{{ title }}</h2>
          <button type="button" class="admin-iconbtn" aria-label="Close dialog" :disabled="busy" @click="close">
            ✕
          </button>
        </header>
        <p v-if="description" class="admin-modal__desc">{{ description }}</p>
        <div class="admin-modal__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="admin-modal__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
