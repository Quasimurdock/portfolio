<script setup lang="ts">
/**
 * The series hero: the same three-slide window as the feed, clipped into the
 * `.lightbox-gallery` stage, with the counter/caption line and the arrow zones.
 *
 * The index is owned by the parent (the thumbnail strip below shares it), so it
 * arrives as a prop and steps are emitted back up.
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useSlider } from '@/composables/useSlider'
import { PHOTO_SIZES, imageAlt, imageCaption, imageRatio, imageSrc, imageSrcset, pad } from '@/site/lib/image'
import type { ImageAsset } from '@/types/api'

const props = defineProps<{
  images: ImageAsset[]
  index: number
}>()

const emit = defineEmits<{ 'update:index': [value: number] }>()

/** the parent's index, writable — `useSlider` commits steps through it */
const index = computed<number>({
  get: () => props.index,
  set: (value) => emit('update:index', value),
})

const { viewport, slides, trackStyle, next, prev } = useSlider<ImageAsset>({
  list: () => props.images,
  index,
  keyOf: (image) => String(image.id),
})

const current = computed<ImageAsset | null>(() => props.images[props.index] ?? null)

/** ← / → , the same keys the old page bound while a series was open */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') prev()
  else if (event.key === 'ArrowRight') next()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="single-lightbox">
    <div class="single-lightbox__img-wrap">
      <div ref="viewport" class="slider-viewport">
        <div class="slider-track" :style="trackStyle">
          <div v-for="slide in slides" :key="slide.key" class="slider-slide">
            <img
              v-lazy="{
                key: `lb-${slide.item.id}`,
                src: imageSrc(slide.item),
                srcset: imageSrcset(slide.item),
                sizes: PHOTO_SIZES,
                ratio: imageRatio(slide.item),
              }"
              :alt="imageAlt(slide.item)"
              loading="lazy"
              decoding="async"
            >
          </div>
        </div>
      </div>
    </div>

    <button
      class="lightbox-nav lightbox-nav--prev"
      type="button"
      aria-label="Previous image"
      :disabled="images.length < 2"
      @click="prev"
    ></button>
    <button
      class="lightbox-nav lightbox-nav--next"
      type="button"
      aria-label="Next image"
      :disabled="images.length < 2"
      @click="next"
    ></button>

    <div class="lightbox-info">
      <span class="lightbox-info__count">{{ pad(index + 1) }} / {{ pad(images.length) }}</span>
      <span class="lightbox-info__caption">{{ current ? imageCaption(current) : '' }}</span>
    </div>
  </div>
</template>
