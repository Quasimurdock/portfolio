<script setup lang="ts">
/** Failure state with a retry affordance — never a raw stack trace. */
withDefaults(defineProps<{ message: string; retryLabel?: string; retrying?: boolean }>(), {
  retryLabel: 'Try again',
  retrying: false,
})

defineEmits<{ (e: 'retry'): void }>()
</script>

<template>
  <div class="admin-error" role="alert">
    <p class="admin-error__title">Something went wrong</p>
    <p class="admin-error__message">{{ message }}</p>
    <button type="button" class="admin-btn admin-btn--sm" :disabled="retrying" @click="$emit('retry')">
      {{ retrying ? 'Retrying…' : retryLabel }}
    </button>
  </div>
</template>
