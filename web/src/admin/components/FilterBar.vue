<script setup lang="ts">
/**
 * Filter bar shell: a wrapping row of controls plus a right-aligned action
 * cluster. Views drop their own inputs in and decide what "active" means.
 */
withDefaults(defineProps<{ active?: boolean; busy?: boolean; resetLabel?: string }>(), {
  active: false,
  busy: false,
  resetLabel: 'Clear filters',
})

defineEmits<{ (e: 'reset'): void }>()
</script>

<template>
  <form class="admin-filters" role="search" @submit.prevent>
    <slot />
    <div class="admin-filters__actions">
      <slot name="actions" />
      <button
        v-if="active"
        type="button"
        class="admin-btn admin-btn--ghost admin-btn--sm"
        @click="$emit('reset')"
      >
        {{ resetLabel }}
      </button>
      <span v-if="busy" class="admin-filters__busy" role="status">Loading…</span>
    </div>
  </form>
</template>
