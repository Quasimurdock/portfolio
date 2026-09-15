<script setup lang="ts">
/**
 * A list section's index (News / Exhibitions & Talks / Essays & Reviews): the
 * bordered register, one row per piece. Text only — a list page carries no
 * photographs on the old page either.
 */
import { RouterLink } from 'vue-router'
import type { Article } from '@/types/api'

const props = defineProps<{
  /** the section key, i.e. the first URL segment */
  section: string
  articles: Article[]
}>()

/** The standfirst line: the excerpt is the API's home for the legacy meta line. */
function meta(article: Article): string {
  return article.excerpt?.trim() ?? ''
}

function to(article: Article): string {
  return `/${props.section}/${article.slug}`
}
</script>

<template>
  <div class="grid-wrap">
    <div class="image-grid">
      <div class="container container--half-pad">
        <div
          v-for="(article, index) in articles"
          :key="article.slug"
          class="grid-single grid-single--list"
          :style="{ '--i': index }"
        >
          <RouterLink class="grid-single__inner" :to="to(article)">
            <div class="grid-single__caption">
              <strong>{{ article.title }}</strong><br >
              <span class="grid-single__meta">{{ meta(article) }}</span>
            </div>
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>
