<script setup lang="ts">
/**
 * Server-side permission gate. The server is the authority; this only decides
 * whether the user is shown a control at all.
 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = withDefaults(
  defineProps<{
    perm: string | string[]
    /** `all` (default) requires every key, `any` requires one of them */
    mode?: 'all' | 'any'
    deniedText?: string
  }>(),
  { mode: 'all', deniedText: 'You do not have permission to do that.' },
)

const auth = useAuthStore()
const allowed = computed(() => {
  const keys = Array.isArray(props.perm) ? props.perm : [props.perm]
  return props.mode === 'any' ? auth.canAny(...keys) : auth.can(keys)
})
</script>

<template>
  <slot v-if="allowed" />
  <slot v-else name="denied">
    <span class="admin-denied">{{ deniedText }}</span>
  </slot>
</template>
