<script setup lang="ts">
/**
 * One frame of the studio feed. The whole frame is the link when the payload
 * resolved one: an internal href goes through the router, an external one opens
 * in a new tab, and a frame with no link is simply not a link.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { PHOTO_SIZES, imageAlt, imageRatio, imageSrc, imageSrcset, routePath } from '@/site/lib/image'
import type { FeedItem } from '@/types/api'

const props = defineProps<{ item: FeedItem }>()

const path = computed(() => routePath(props.item.link?.href))
const externalHref = computed(() => (path.value ? '' : props.item.link?.href ?? ''))
const label = computed(() => props.item.caption?.trim() || imageAlt(props.item.image))

const lazyConfig = computed(() => ({
  key: `feed-${props.item.id}`,
  src: imageSrc(props.item.image),
  srcset: imageSrcset(props.item.image),
  sizes: PHOTO_SIZES,
  ratio: imageRatio(props.item.image, 1.28),
}))
</script>

<template>
  <RouterLink v-if="path" class="curated-single" :to="path" :aria-label="label || undefined">
    <img v-lazy="lazyConfig" :alt="imageAlt(props.item.image)" loading="lazy" decoding="async">
  </RouterLink>
  <a
    v-else-if="externalHref"
    class="curated-single"
    :href="externalHref"
    target="_blank"
    rel="noopener"
    :aria-label="label || undefined"
  >
    <img v-lazy="lazyConfig" :alt="imageAlt(props.item.image)" loading="lazy" decoding="async">
  </a>
  <div v-else class="curated-single">
    <img v-lazy="lazyConfig" :alt="imageAlt(props.item.image)" loading="lazy" decoding="async">
  </div>
</template>
