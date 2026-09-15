<script setup lang="ts">
/** Every destructive action goes through here. */
import ModalDialog from './ModalDialog.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'danger' | 'default'
    busy?: boolean
  }>(),
  { confirmLabel: 'Confirm', cancelLabel: 'Cancel', tone: 'danger', busy: false },
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <ModalDialog :open="open" :title="title" size="sm" :busy="busy" @close="emit('cancel')">
    <p class="admin-confirm__message">{{ message }}</p>
    <template #footer>
      <button type="button" class="admin-btn" :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</button>
      <button
        type="button"
        class="admin-btn"
        :class="tone === 'danger' ? 'admin-btn--danger' : 'admin-btn--primary'"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? 'Working…' : confirmLabel }}
      </button>
    </template>
  </ModalDialog>
</template>
