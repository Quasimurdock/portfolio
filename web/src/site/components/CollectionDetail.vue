<script setup lang="ts">
/**
 * One collection: the lightbox hero, then the contact-sheet strip. Selecting a
 * thumbnail moves the hero and marks the frame; the close bar (narrow screens
 * only) and Escape both return to the section index.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import LightboxHero from '@/site/components/LightboxHero.vue'
import { imageRatio, imageThumb } from '@/site/lib/image'
import type { Collection } from '@/types/api'

const props = defineProps<{
  /** the section key, for the link back to the index */
  section: string
  /** the section's label, for the close bar */
  sectionLabel: string
  collection: Collection
}>()

const router = useRouter()
const index = ref(0)

const images = computed(() => props.collection.images ?? [])
const sectionPath = computed(() => `/${props.section}`)

function select(frame: number) {
  index.value = frame
  /* the hero sits above the strip: bring the photograph back into view */
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/** legacy deep-link shape, kept on the strip links so the target is visible */
function frameHref(frame: number) {
  return `${sectionPath.value}/${props.collection.slug}/i/${frame + 1}`
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') void router.push(sectionPath.value)
}

watch(
  () => props.collection.id,
  () => {
    index.value = 0
  },
)
watch(
  () => images.value.length,
  (count) => {
    if (index.value >= count) index.value = 0
  },
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <RouterLink class="close-page" :to="sectionPath" :aria-label="`Back to ${sectionLabel || section}`">
    <span class="close-page__label">{{ sectionLabel || section }}</span>
  </RouterLink>

  <div class="lightbox-gallery">
    <LightboxHero :images="images" v-model:index="index" />
  </div>

  <div class="grid-wrap">
    <div class="image-grid image-grid--thumbs">
      <div class="container container--half-pad">
        <div
          v-for="(image, frame) in images"
          :key="image.id"
          class="grid-single"
          :class="{ 'is-active': frame === index }"
          :style="{ '--i': frame }"
        >
          <a class="grid-single__inner" :href="frameHref(frame)" @click.prevent="select(frame)">
            <div class="grid-single__img-wrap">
              <div
                class="grid-single__img"
                v-lazy="{ key: `strip-${image.id}`, bg: imageThumb(image), ratio: imageRatio(image, 1.3) }"
              ></div>
            </div>
            <div class="grid-single__caption">
              <strong>{{ collection.title }}</strong><br >
              <span class="grid-single__meta">{{ image.caption || image.alt || '' }}</span>
            </div>
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
