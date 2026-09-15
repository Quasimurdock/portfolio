<script setup lang="ts">
/**
 * One page: title, markdown body, and the `data` blob that carries the
 * structured bits (`PageData` holds the biography's lead / paragraphs /
 * publications / representation, or the contact columns).
 *
 * The JSON is edited in a textarea on purpose — no editor library — but it is
 * parsed on every keystroke so "Save" can never write malformed JSON, and the
 * error names the line and column.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink } from 'vue-router'
import { errorMessage } from '@/api/client'
import { adminApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { useAsyncData } from '@/admin/lib/useAsyncData'
import { formatDateTime, jsonPretty, parseJson } from '@/admin/lib/format'
import type { Page, PageData, Status } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import FormField from '@/admin/components/FormField.vue'
import LoadingState from '@/admin/components/LoadingState.vue'
import StatusPill from '@/admin/components/StatusPill.vue'

const props = defineProps<{ slug: string }>()

const auth = useAuthStore()
const { success, info, error: toastError } = useToast()

const canWrite = computed(() => auth.can('content.page.write'))
const canPublish = computed(() => auth.can('content.page.publish'))

const form = reactive({ title: '', body: '', dataJson: '' })
const status = ref<Status>('draft')
const saving = ref(false)
const publishing = ref(false)
const serverError = ref('')
const errors = reactive({ title: '' })

function snapshot(): string {
  return JSON.stringify({ ...form, status: status.value })
}

const baseline = ref(snapshot())
const dirty = computed(() => snapshot() !== baseline.value)

const parsed = computed(() => parseJson(form.dataJson))
const jsonError = computed(() => (parsed.value.ok ? '' : parsed.value.message))

const { data: page, loading, error, missing, run } = useAsyncData<Page | null>(
  () => adminApi.pages.get(props.slug),
  null,
)

onMounted(() => {
  void run()
})

watch(page, (value) => {
  if (value) applyPage(value)
})

function applyPage(value: Page): void {
  form.title = value.title
  form.body = value.body ?? ''
  form.dataJson = jsonPretty(value.data ?? {})
  status.value = value.status
  baseline.value = snapshot()
}

/** The two shapes `PageData` takes today, offered as a starting point. */
const templates: Record<string, PageData> = {
  article: {
    lead: 'A single sentence that opens the page.',
    paragraphs: ['First paragraph.', 'Second paragraph.'],
    publications: 'Selected publications, one per line.',
    representation: 'Represented by …',
  },
  contact: {
    columns: [
      { title: 'Studio', lines: [{ text: 'hello@studio.test', href: 'mailto:hello@studio.test' }] },
      { title: 'Representation', lines: [{ text: 'A gallery', href: 'https://example.com', external: true }] },
    ],
  },
}

function insertTemplate(): void {
  const kind = page.value?.kind ?? 'article'
  form.dataJson = jsonPretty(templates[kind] ?? templates.article)
}

function formatJson(): void {
  const result = parseJson(form.dataJson)
  if (!result.ok) return
  form.dataJson = jsonPretty(result.value)
}

function validate(): boolean {
  errors.title = form.title.trim() ? '' : 'A title is required.'
  return !errors.title && !jsonError.value
}

async function save(): Promise<boolean> {
  if (saving.value) return false
  serverError.value = ''
  if (!validate()) {
    info(jsonError.value ? 'Fix the JSON before saving.' : 'Check the highlighted fields.')
    return false
  }
  const result = parseJson(form.dataJson)
  saving.value = true
  try {
    const updated = await adminApi.pages.update(props.slug, {
      title: form.title.trim(),
      body: form.body,
      data: result.ok ? result.value : {},
    })
    applyPage(updated)
    success('Page saved.')
    return true
  } catch (err) {
    serverError.value = errorMessage(err)
    toastError(errorMessage(err))
    return false
  } finally {
    saving.value = false
  }
}

async function setStatus(next: Status): Promise<void> {
  if (publishing.value) return
  if (dirty.value) {
    const saved = await save()
    if (!saved) return
  }
  publishing.value = true
  const previous = status.value
  status.value = next
  try {
    const updated = await adminApi.pages.update(props.slug, { status: next })
    applyPage(updated)
    success(next === 'published' ? 'Page published.' : 'Page returned to draft.')
  } catch (err) {
    status.value = previous
    toastError(errorMessage(err))
  } finally {
    publishing.value = false
  }
}

/* ------------------------------------------------- leaving with unsaved work */

const leaveOpen = ref(false)
let resolveLeave: ((value: boolean) => void) | null = null

onBeforeRouteLeave(() => {
  if (!dirty.value || saving.value) return true
  leaveOpen.value = true
  return new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
})

function confirmLeave(): void {
  leaveOpen.value = false
  resolveLeave?.(true)
  resolveLeave = null
}

function cancelLeave(): void {
  leaveOpen.value = false
  resolveLeave?.(false)
  resolveLeave = null
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <p class="admin-page__crumb">
          <RouterLink class="admin-link" :to="{ name: 'admin-pages' }">← Pages</RouterLink>
        </p>
        <h2 class="admin-page__title">{{ form.title || props.slug }}</h2>
        <p class="admin-page__meta">
          <StatusPill :status="status" />
          <span v-if="dirty" class="admin-state admin-state--dirty">Unsaved changes</span>
          <span v-else class="admin-state">All changes saved</span>
          <span class="admin-mono">/{{ props.slug }}</span>
        </p>
      </div>
      <div class="admin-page__actions">
        <template v-if="canPublish">
          <button
            v-if="status !== 'published'"
            type="button"
            class="admin-btn admin-btn--sm"
            :disabled="publishing"
            @click="setStatus('published')"
          >
            Publish
          </button>
          <button v-else type="button" class="admin-btn admin-btn--sm" :disabled="publishing" @click="setStatus('draft')">
            Unpublish
          </button>
        </template>
        <button
          v-if="canWrite"
          type="button"
          class="admin-btn admin-btn--sm admin-btn--primary"
          :disabled="saving || !dirty"
          @click="save()"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </header>

    <ErrorState v-if="error" :message="error" @retry="run()" />

    <EmptyState v-else-if="missing" title="Page not found" message="No page exists with that slug.">
      <RouterLink class="admin-btn admin-btn--sm" :to="{ name: 'admin-pages' }">Back to pages</RouterLink>
    </EmptyState>

    <LoadingState v-else-if="loading" label="Loading the page…" />

    <form v-else class="admin-editor" novalidate @submit.prevent="save()">
      <div class="admin-editor__main">
        <p v-if="serverError" class="admin-formerror" role="alert">{{ serverError }}</p>
        <p v-if="!canWrite" class="admin-denied admin-denied--block">
          You can read this page but not change it — editing requires the <code>content.page.write</code> permission.
        </p>

        <FormField label="Title" for-id="page-title" required :error="errors.title">
          <input id="page-title" v-model="form.title" class="admin-input admin-input--title" type="text" :disabled="!canWrite" />
        </FormField>

        <FormField label="Body" for-id="page-body" :hint="`Markdown · ${form.body.length} characters`">
          <textarea id="page-body" v-model="form.body" class="admin-textarea admin-textarea--body" rows="16" spellcheck="false" :disabled="!canWrite" />
        </FormField>

        <FormField
          label="Structured data (JSON)"
          for-id="page-data"
          :error="jsonError"
          hint="The bits that are not prose: lead, paragraphs, publications, representation — or the contact columns."
        >
          <textarea
            id="page-data"
            v-model="form.dataJson"
            class="admin-textarea admin-textarea--json"
            rows="16"
            spellcheck="false"
            :disabled="!canWrite"
          />
        </FormField>

        <div class="admin-rowactions">
          <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="!canWrite" @click="insertTemplate">
            Insert {{ page?.kind === 'contact' ? 'contact' : 'biography' }} template
          </button>
          <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" :disabled="!canWrite || !!jsonError" @click="formatJson">
            Reformat JSON
          </button>
        </div>
      </div>

      <aside class="admin-editor__side">
        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">Page</h3>
          </header>
          <dl class="admin-deflist">
            <div class="admin-deflist__row"><dt>Slug</dt><dd class="admin-mono">{{ props.slug }}</dd></div>
            <div class="admin-deflist__row"><dt>Kind</dt><dd>{{ page?.kind === 'contact' ? 'Contact' : 'Article' }}</dd></div>
            <div class="admin-deflist__row"><dt>Status</dt><dd><StatusPill :status="status" /></dd></div>
            <div v-if="page" class="admin-deflist__row"><dt>Updated</dt><dd class="admin-num">{{ formatDateTime(page.updatedAt) }}</dd></div>
            <div v-if="page" class="admin-deflist__row"><dt>Published</dt><dd class="admin-num">{{ formatDateTime(page.publishedAt) }}</dd></div>
          </dl>
          <a v-if="status === 'published'" class="admin-link" :href="`/${props.slug}`" target="_blank" rel="noopener">
            View on the public site ↗
          </a>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h3 class="admin-card__title">Shape of the data</h3>
          </header>
          <pre class="admin-pre">{{ jsonPretty(page?.kind === 'contact' ? templates.contact : templates.article) }}</pre>
        </section>
      </aside>
    </form>

    <ConfirmDialog
      :open="leaveOpen"
      title="Discard unsaved changes?"
      message="This page has edits that have not been saved."
      confirm-label="Leave without saving"
      cancel-label="Stay on this page"
      @confirm="confirmLeave"
      @cancel="cancelLeave"
    />
  </div>
</template>
