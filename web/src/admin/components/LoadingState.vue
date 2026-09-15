<script setup lang="ts">
/** Inline "working on it" block for screens that are not a table. */
withDefaults(defineProps<{ label?: string }>(), { label: 'Loading…' })
</script>

<template>
  <div class="admin-loading" role="status" aria-live="polite">
    <span class="admin-loading__bar" aria-hidden="true" />
    <span class="admin-loading__label">{{ label }}</span>
  </div>
</template>
