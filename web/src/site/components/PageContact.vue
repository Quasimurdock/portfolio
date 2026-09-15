<script setup lang="ts">
/**
 * A page of kind `contact`: four columns of plain lines. A line is a link when
 * the payload gives it an href — internal hrefs go through the router (so a
 * legacy `#/contact` still lands), everything else is a plain anchor.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { routePath } from '@/site/lib/image'
import type { Page } from '@/types/api'

const props = defineProps<{ page: Page }>()

const columns = computed(() => props.page.data?.columns ?? [])
</script>

<template>
  <div class="grid-wrap">
    <div class="container container--half-pad">
      <div class="article__rule article__rule--short"></div>
      <div class="contact-columns">
        <div v-for="column in columns" :key="column.title" class="contact-col">
          <h2>{{ column.title }}</h2>
          <p v-for="(line, i) in column.lines" :key="i">
            <RouterLink v-if="routePath(line.href)" :to="routePath(line.href)">{{ line.text }}</RouterLink>
            <a
              v-else-if="line.href"
              :href="line.href"
              :target="line.external ? '_blank' : undefined"
              rel="noopener"
            >{{ line.text }}</a>
            <template v-else>{{ line.text }}</template>
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
