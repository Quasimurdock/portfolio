<script setup lang="ts">
/** Label + control + hint/error. The control is the default slot. */
withDefaults(
  defineProps<{
    label: string
    hint?: string
    error?: string | null
    required?: boolean
    forId?: string
  }>(),
  { hint: '', error: null, required: false, forId: '' },
)
</script>

<template>
  <div class="admin-field" :class="{ 'has-error': !!error }">
    <label v-if="forId" class="admin-field__label" :for="forId">
      {{ label }}<span v-if="required" class="admin-field__req" aria-hidden="true"> *</span>
    </label>
    <span v-else class="admin-field__label">
      {{ label }}<span v-if="required" class="admin-field__req" aria-hidden="true"> *</span>
    </span>
    <slot />
    <p v-if="error" class="admin-field__error" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="admin-field__hint">{{ hint }}</p>
  </div>
</template>
