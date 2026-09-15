<script setup lang="ts">
/** One status vocabulary everywhere: draft → review → published → archived. */
import { computed } from 'vue'
import { statusLabel } from '@/admin/lib/format'

const props = withDefaults(defineProps<{ status: string; compact?: boolean }>(), { compact: false })

const label = computed(() => statusLabel(props.status))
</script>

<template>
  <span class="admin-pill" :class="[`admin-pill--${status}`, { 'admin-pill--compact': compact }]">
    <span class="admin-pill__dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>
