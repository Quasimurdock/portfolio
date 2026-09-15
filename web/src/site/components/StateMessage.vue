<script setup lang="ts">
/**
 * The quiet voice for loading / unreachable / not-found. Same geometry as the
 * 404 the old page drew: a short rule, then a lead line and one sentence of
 * explanation, in the content area — never a blank page.
 */
withDefaults(
  defineProps<{
    lead: string
    /** one plain sentence; the default slot wins when the copy needs markup */
    detail?: string
    /** offers a retry when the failure is transient (the API was unreachable) */
    retryable?: boolean
  }>(),
  { detail: '', retryable: false },
)

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="grid-wrap">
    <div class="container container--half-pad">
      <div class="article__rule article__rule--short"></div>
      <div class="article__body state-message">
        <p class="article__lead">{{ lead }}</p>
        <p v-if="$slots.default"><slot /></p>
        <p v-else-if="detail">{{ detail }}</p>
        <p v-if="retryable" class="post__back">
          <button type="button" class="input--button-blank" @click="emit('retry')">Try again</button>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* the 404 the old page inlined as style="padding-top:9px" */
.state-message {
  padding-top: 9px;
}
</style>
