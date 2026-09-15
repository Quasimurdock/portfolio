<script setup lang="ts">
/**
 * A standalone page of kind `article` (Biography): the lead, the prose, then the
 * two named registers the reference prints underneath.
 */
import { computed } from 'vue'
import { splitParagraphs } from '@/site/lib/image'
import type { Page, PageData } from '@/types/api'

const props = defineProps<{ page: Page }>()

const data = computed<PageData>(() => props.page.data ?? {})

/** the JSON blob is the home for the structured fields; the body is the fallback */
const paragraphs = computed(() => {
  const structured = data.value.paragraphs ?? []
  return structured.length ? structured : splitParagraphs(props.page.body)
})

const lead = computed(() => data.value.lead?.trim() || '')
const publications = computed(() => data.value.publications?.trim() || '')
const representation = computed(() => data.value.representation?.trim() || '')
</script>

<template>
  <article class="article">
    <div class="article__rule article__rule--short"></div>
    <div class="article__body">
      <p v-if="lead" class="article__lead">{{ lead }}</p>
      <p v-for="(paragraph, i) in paragraphs" :key="i">{{ paragraph }}</p>

      <template v-if="publications">
        <h2>Selected publications</h2>
        <p>{{ publications }}</p>
      </template>
      <template v-if="representation">
        <h2>Representation</h2>
        <p>{{ representation }}</p>
      </template>
    </div>
  </article>
</template>
