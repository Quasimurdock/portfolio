<script setup lang="ts">
/**
 * A grid section's index: one card per collection, cover + title + register
 * line. The markup and class names are the old page's, so site.css drives the
 * 4-column (>=1250px) / 3 / 2 / 1 column behaviour and the staggered entrance.
 */
import { RouterLink } from 'vue-router'
import { imageRatio, imageThumb } from '@/site/lib/image'
import type { Collection } from '@/types/api'

const props = withDefaults(
  defineProps<{
    /** the section key, i.e. the first URL segment */
    section: string
    collections: Collection[]
    /** the old page's `.film-card` register (16:9 box + play plate) */
    film?: boolean
  }>(),
  { film: false },
)

/**
 * The line under the title. The legacy page printed the series' declared size
 * ("Series of 34"), which is what a curated summary holds; the live image count
 * is the fallback when there is no summary.
 */
function meta(collection: Collection): string {
  const summary = collection.summary?.trim()
  if (summary) return summary
  return typeof collection.imageCount === 'number' ? `Series of ${collection.imageCount}` : ''
}

function to(collection: Collection): string {
  return `/${props.section}/${collection.slug}`
}
</script>

<template>
  <div class="grid-wrap">
    <div class="image-grid image-grid--4x-portrait">
      <div class="container container--half-pad">
        <div
          v-for="(collection, index) in collections"
          :key="collection.slug"
          class="grid-single grid-single--bordered grid-single--portrait"
          :class="{ 'film-card': film }"
          :style="{ '--i': index }"
        >
          <RouterLink class="grid-single__inner" :to="to(collection)">
            <div class="grid-single__img-wrap">
              <div
                class="grid-single__img"
                v-lazy="{ key: `cover-${collection.slug}`, bg: imageThumb(collection.cover), ratio: imageRatio(collection.cover) }"
              ></div>
              <span v-if="film" class="play" aria-hidden="true"></span>
            </div>
            <div class="grid-single__caption caption-project">
              <strong>{{ collection.title }}</strong><br >
              <span class="grid-single__meta">{{ meta(collection) }}</span>
            </div>
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>
