<script setup lang="ts">
/**
 * One written piece (News / Exhibitions & Talks / Essays & Reviews). The old
 * page's `meta / lead / body / back` rhythm, kept as a single measured column.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { splitParagraphs } from '@/site/lib/image'
import type { Article } from '@/types/api'

const props = defineProps<{
  /** the section key, for the link back to the index */
  section: string
  /** the section's label, for the back link */
  sectionLabel: string
  article: Article
}>()

/** the API stores prose as one string (blank line between paragraphs) */
const paragraphs = computed(() => splitParagraphs(props.article.body))
const lead = computed(() => paragraphs.value[0] ?? '')
const rest = computed(() => paragraphs.value.slice(1))
const meta = computed(() => props.article.excerpt?.trim() ?? '')
const backLabel = computed(() => props.sectionLabel || props.section)
</script>

<template>
  <article class="article post">
    <div class="article__rule article__rule--short"></div>
    <p v-if="meta" class="post__meta">{{ meta }}</p>
    <div class="article__body">
      <p v-if="lead" class="article__lead">{{ lead }}</p>
      <p v-for="(paragraph, i) in rest" :key="i">{{ paragraph }}</p>
    </div>
    <p class="post__back">
      <RouterLink :to="`/${section}`">&larr;&nbsp;{{ backLabel }}</RouterLink>
    </p>
  </article>
</template>
