<script setup lang="ts">
/**
 * The one 404 treatment, shared by the catch-all route and by a section view
 * that was handed an unknown section key or slug.
 */
import { useRoute } from 'vue-router'
import StateMessage from '@/site/components/StateMessage.vue'

const route = useRoute()
</script>

<template>
  <StateMessage lead="Not found.">
    The page <code>{{ route.path }}</code> does not exist in this portfolio.
    Use the navigation above to browse the work.
  </StateMessage>
</template>
