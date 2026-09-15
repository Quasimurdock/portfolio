<script setup lang="ts">
/** Neutral placeholder for "nothing here" — with a slot for the way out. */
withDefaults(defineProps<{ title?: string; message?: string }>(), {
  title: 'Nothing here yet',
  message: '',
})
</script>

<template>
  <div class="admin-empty">
    <p class="admin-empty__title">{{ title }}</p>
    <p v-if="message" class="admin-empty__message">{{ message }}</p>
    <div v-if="$slots.default" class="admin-empty__actions">
      <slot />
    </div>
  </div>
</template>
