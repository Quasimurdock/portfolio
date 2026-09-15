<script setup lang="ts">
/**
 * The catch-all route. It is a sibling of the public layout rather than a child
 * (the router declares it at the top level), so it renders the layout itself —
 * the header, title bar, footer and the same 404 body as a SectionView that was
 * handed an unknown key.
 */
import NotFoundMessage from '@/site/components/NotFoundMessage.vue'
import SiteLayout from '@/site/layouts/SiteLayout.vue'
import { setPageTitle } from '@/site/lib/page-title'

setPageTitle('Not found')
</script>

<template>
  <SiteLayout>
    <NotFoundMessage />
  </SiteLayout>
</template>
