<script setup lang="ts">
/**
 * Moving an older installation into this one.
 *
 * The old server kept everything in a single SQLite file (`server/data/app.db`
 * locally), so "migrate" is just that file plus a set of tables to move. Two
 * deliberate steps keep it safe: every run can be previewed first (a dry run
 * reads and counts but writes nothing), and a replace — which empties the
 * chosen tables — has to be confirmed.
 *
 * Image rows move, but the bytes never did: the `images` table only holds URLs,
 * so whatever the old install pointed at keeps working.
 */
import { computed, onMounted, ref } from 'vue'
import { errorMessage } from '@/api/client'
import { importApi } from '@/api/endpoints'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { importDatabase } from '@/admin/lib/import'
import type { ImportSummary, ImportTable } from '@/types/api'
import ConfirmDialog from '@/admin/components/ConfirmDialog.vue'
import EmptyState from '@/admin/components/EmptyState.vue'
import ErrorState from '@/admin/components/ErrorState.vue'
import LoadingState from '@/admin/components/LoadingState.vue'

const auth = useAuthStore()
const { info, success, error: toastError } = useToast()

const canImport = computed(() => auth.can('settings.manage'))

const tables = ref<ImportTable[]>([])
const selected = ref<Set<string>>(new Set())
const maxBytes = ref(0)

const loading = ref(false)
const loadError = ref('')

const file = ref<File | null>(null)
const mode = ref<'merge' | 'replace'>('merge')
const busy = ref(false)
const summary = ref<ImportSummary | null>(null)
const confirmOpen = ref(false)

const fileLabel = computed(() => {
  if (!file.value) return 'No file chosen yet.'
  return `${file.value.name} · ${formatMb(file.value.size)}`
})

const selectedLabels = computed(() =>
  tables.value.filter((table) => selected.value.has(table.name)).map((table) => table.label),
)

function formatMb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function loadTables(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const data = await importApi.tables()
    tables.value = data.tables
    maxBytes.value = data.maxBytes
    selected.value = new Set(data.tables.filter((table) => table.default).map((table) => table.name))
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

function toggle(name: string): void {
  const next = new Set(selected.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  selected.value = next
}

function selectAll(on: boolean): void {
  selected.value = on ? new Set(tables.value.map((table) => table.name)) : new Set()
}

function pickFile(event: Event): void {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
  summary.value = null
}

function start(): void {
  if (busy.value) return
  if (!file.value) {
    toastError('Choose the .db file to upload first.')
    return
  }
  if (selected.value.size === 0) {
    toastError('Choose at least one table to move.')
    return
  }
  if (file.value.size > maxBytes.value) {
    toastError(`That file is ${formatMb(file.value.size)} — the limit is ${formatMb(maxBytes.value)}.`)
    return
  }
  if (mode.value === 'replace') {
    confirmOpen.value = true
    return
  }
  void run(false)
}

async function run(dryRun: boolean): Promise<void> {
  if (busy.value || !file.value) return
  busy.value = true
  try {
    const result = await importDatabase(file.value, {
      mode: mode.value,
      tables: [...selected.value],
      dryRun,
    })
    summary.value = result
    if (result.dryRun) info('Preview only — nothing was written.')
    else success(`Imported ${result.tables.reduce((n, table) => n + (table.inserted ?? 0), 0)} row(s).`)
  } catch (err) {
    toastError(errorMessage(err))
  } finally {
    busy.value = false
    confirmOpen.value = false
  }
}

onMounted(loadTables)
</script>

<template>
  <div class="admin-page">
    <header class="admin-page__head">
      <div class="admin-page__heading">
        <h2 class="admin-page__title">Data</h2>
        <p class="admin-page__sub">
          Bring an older installation into this one. Upload its SQLite database file, choose the tables to move and
          preview before anything is written.
        </p>
      </div>
    </header>

    <EmptyState
      v-if="!canImport"
      title="Not available to you"
      message="Moving data needs the settings.manage permission. Ask an owner."
    />

    <template v-else>
      <ErrorState v-if="loadError" :message="loadError" @retry="loadTables()" />
      <LoadingState v-else-if="loading" label="Reading the table list…" />

      <template v-else>
        <section class="admin-card">
          <div class="admin-card__head">
            <h3 class="admin-card__title">1 · The file</h3>
            <p class="admin-card__note">SQLite, up to {{ formatMb(maxBytes) }}.</p>
          </div>

          <div class="admin-import__pick">
            <input type="file" accept=".db,.sqlite,.sqlite3,application/octet-stream" @change="pickFile" />
            <span class="admin-import__file">{{ fileLabel }}</span>
          </div>

          <div class="admin-import__choices">
            <label class="admin-import__choice">
              <input v-model="mode" type="radio" value="merge" />
              <span>
                <span class="admin-import__choice-title">Merge</span>
                <span class="admin-import__choice-meta"> — keep what is here; rows that collide are skipped</span>
              </span>
            </label>
            <label class="admin-import__choice">
              <input v-model="mode" type="radio" value="replace" />
              <span>
                <span class="admin-import__choice-title">Replace</span>
                <span class="admin-import__choice-meta"> — empty the chosen tables first, then insert the file verbatim</span>
              </span>
            </label>
          </div>
        </section>

        <section class="admin-card">
          <div class="admin-card__head">
            <h3 class="admin-card__title">
              2 · Tables
              <span class="admin-card__count">{{ selected.size }} of {{ tables.length }}</span>
            </h3>
            <div class="admin-card__actions">
              <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" @click="selectAll(true)">All</button>
              <button type="button" class="admin-btn admin-btn--sm admin-btn--ghost" @click="selectAll(false)">None</button>
            </div>
          </div>

          <div class="admin-import__tables">
            <label v-for="table in tables" :key="table.name" class="admin-import__table">
              <input type="checkbox" :checked="selected.has(table.name)" @change="toggle(table.name)" />
              <span>{{ table.label }} <code>{{ table.name }}</code></span>
            </label>
          </div>

          <div class="admin-import__actions">
            <button type="button" class="admin-btn" :disabled="busy || !file" @click="run(true)">
              {{ busy ? 'Working…' : 'Preview' }}
            </button>
            <button type="button" class="admin-btn admin-btn--primary" :disabled="busy || !file" @click="start">
              {{ busy ? 'Working…' : 'Import' }}
            </button>
          </div>
        </section>

        <section v-if="summary" class="admin-card">
          <div class="admin-card__head">
            <h3 class="admin-card__title">
              {{ summary.dryRun ? 'Preview' : 'Result' }}
              <span class="admin-card__count">{{ summary.mode }} · {{ summary.target }}</span>
            </h3>
            <p class="admin-card__note">{{ summary.durationMs }} ms · driver {{ summary.driver }}</p>
          </div>

          <div class="admin-table__wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th class="admin-table__cell">Table</th>
                  <th class="admin-table__cell is-right">In file</th>
                  <th class="admin-table__cell is-right">Here</th>
                  <th class="admin-table__cell is-right">{{ summary.dryRun ? 'Would add' : 'Added' }}</th>
                  <th class="admin-table__cell is-right">Skipped</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in summary.tables" :key="row.name" class="admin-table__row">
                  <td class="admin-table__cell">
                    {{ row.label }}
                    <span class="admin-table__sub">{{ row.name }}</span>
                  </td>
                  <td class="admin-table__cell is-right is-numeric">{{ row.present ? row.read : '—' }}</td>
                  <td class="admin-table__cell is-right is-numeric">{{ row.existing }}</td>
                  <td class="admin-table__cell is-right is-numeric">{{ row.inserted ?? row.attempted ?? '—' }}</td>
                  <td class="admin-table__cell is-right is-numeric">{{ row.skipped ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul v-if="summary.warnings.length" class="admin-import__warnlist">
            <li v-for="(warning, index) in summary.warnings" :key="index">{{ warning }}</li>
          </ul>
        </section>
      </template>
    </template>

    <ConfirmDialog
      :open="confirmOpen"
      title="Replace the chosen tables?"
      tone="danger"
      confirm-label="Empty and import"
      :busy="busy"
      :message="`This empties ${selectedLabels.join(', ')} before inserting the file. Anything in those tables that is not in the file is gone.`"
      @confirm="run(false)"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
