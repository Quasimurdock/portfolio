<script setup lang="ts">
/**
 * The home page: the curated slideshow. Three slides at a time (prev / current
 * / next) via `useSlider`, a count + caption line pinned to the bottom of the
 * stage, arrow zones, 7s autoplay and ← / → keys.
 *
 * Autoplay stops while the tab is hidden and is not started at all for people
 * who asked for reduced motion — the frame still turns by hand.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePreferredReducedMotion } from '@vueuse/core'
import { publicApi } from '@/api/endpoints'
import { useQuery } from '@/composables/useQuery'
import { useSlider } from '@/composables/useSlider'
import FeedSlide from '@/site/components/FeedSlide.vue'
import StateMessage from '@/site/components/StateMessage.vue'
import { pad } from '@/site/lib/image'
import { setPageTitle } from '@/site/lib/page-title'
import type { FeedItem } from '@/types/api'

const AUTOPLAY_MS = 7000

/* the feed has no title bar, and clears anything a previous view left behind */
setPageTitle(null)

const { data: items, loading, error, reload } = useQuery<FeedItem[]>(
  () => 'feed',
  () => publicApi.feed(),
  [],
)

const index = ref(0)
const reduced = usePreferredReducedMotion()

const current = computed<FeedItem | null>(() => items.value[index.value] ?? items.value[0] ?? null)

let timer: number | undefined

function stopAutoplay() {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function startAutoplay() {
  stopAutoplay()
  if (reduced.value === 'reduce') return
  if (document.hidden) return
  if (items.value.length < 2) return
  timer = window.setInterval(() => {
    if (!document.hidden) next()
  }, AUTOPLAY_MS)
}

const { viewport, slides, trackStyle, next, prev } = useSlider<FeedItem>({
  list: () => items.value,
  index,
  keyOf: (item) => String(item.id),
  /* a manual step buys another full interval before the next one */
  onChange: () => startAutoplay(),
})

const BLOCKED_KEYS = ['INPUT', 'TEXTAREA', 'SELECT']

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target && (target.isContentEditable || BLOCKED_KEYS.includes(target.tagName))) return
  if (event.key === 'ArrowLeft') prev()
  else if (event.key === 'ArrowRight') next()
}

function onVisibilityChange() {
  if (document.hidden) stopAutoplay()
  else startAutoplay()
}

watch(
  () => items.value.length,
  (count) => {
    if (index.value >= count) index.value = 0
    startAutoplay()
  },
)

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('keydown', onKeydown)
  startAutoplay()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('keydown', onKeydown)
  stopAutoplay()
})
</script>

<template>
  <StateMessage
    v-if="!items.length && error"
    lead="The studio feed is unavailable."
    :detail="error"
    retryable
    @retry="reload"
  />
  <StateMessage v-else-if="!items.length && loading" lead="Loading…" />

  <template v-else>
    <div v-if="items.length" class="swiper-curated__info">
      <span class="swiper-curated__count">{{ pad(index + 1) }} / {{ pad(items.length) }}</span>
      <span class="swiper-curated__caption">{{ current?.caption ?? '' }}</span>
    </div>

    <div class="swiper-curated" :class="{ 'is-ready': items.length > 0 }">
      <div class="curated-wrap">
        <div class="curated-col">
          <div ref="viewport" class="slider-viewport">
            <div class="slider-track" :style="trackStyle">
              <div v-for="slide in slides" :key="slide.key" class="slider-slide">
                <FeedSlide :item="slide.item" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        class="curated-nav curated-nav--prev"
        type="button"
        aria-label="Previous"
        :disabled="items.length < 2"
        @click="prev"
      ></button>
      <button
        class="curated-nav curated-nav--next"
        type="button"
        aria-label="Next"
        :disabled="items.length < 2"
        @click="next"
      ></button>
    </div>
  </template>
</template>
