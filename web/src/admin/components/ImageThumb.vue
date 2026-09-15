<script setup lang="ts">
/**
 * A photograph, a thumbnail or a deliberate "unexposed plate".
 *
 * Reuses the public site's generated plate (see `useLazyImage`) so a missing
 * image looks the same in the back office as it does on the site.
 */
import { computed, ref, watch } from 'vue'
import { plate } from '@/composables/useLazyImage'
import type { ImageAsset } from '@/types/api'

const props = withDefaults(
  defineProps<{
    image?: ImageAsset | null
    /** explicit overrides, for rows that only carry ids */
    url?: string | null
    thumbUrl?: string | null
    alt?: string | null
    size?: 'xs' | 'sm' | 'md' | 'fill'
    ratio?: number
    selected?: boolean
  }>(),
  { image: null, url: null, thumbUrl: null, alt: null, size: 'sm', ratio: 1.5, selected: false },
)

const failed = ref(false)
watch(
  () => props.thumbUrl ?? props.url,
  () => {
    failed.value = false
  },
)

const src = computed(() => props.thumbUrl ?? props.image?.thumbUrl ?? props.url ?? props.image?.url ?? null)

const ratio = computed(() => {
  const width = props.image?.width ?? null
  const height = props.image?.height ?? null
  return width && height ? width / height : props.ratio
})

const placeholder = computed(() => plate(src.value ?? `image-${props.image?.id ?? '0'}`, ratio.value))
const label = computed(() => props.alt ?? props.image?.alt ?? props.image?.caption ?? '')
</script>

<template>
  <span
    class="admin-thumb"
    :class="[`admin-thumb--${size}`, { 'is-selected': selected, 'is-missing': !src || failed }]"
    :style="size === 'fill' ? { aspectRatio: String(ratio) } : undefined"
  >
    <img
      v-if="src && !failed"
      :src="src"
      :alt="label"
      loading="lazy"
      decoding="async"
      @error="failed = true"
    />
    <img v-else :src="placeholder" alt="" aria-hidden="true" />
  </span>
</template>
