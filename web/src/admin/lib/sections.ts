/**
 * Section vocabulary.
 *
 * There is no admin endpoint for sections — they are part of the site
 * configuration — so the admin reads the public nav (visible buckets) and
 * augments it with any `sectionKey` it meets on a row, which keeps a hidden
 * section selectable instead of silently rewriting it on save.
 */
import { ref, type ShallowRef } from 'vue'
import { publicApi } from '@/api/endpoints'
import type { Section } from '@/types/api'
import type { Option } from './format'

let cached: Section[] | null = null
let inflight: Promise<Section[]> | null = null

export async function loadSections(): Promise<Section[]> {
  if (cached) return cached
  inflight ??= publicApi.nav()
  try {
    const sections = await inflight
    cached = Array.isArray(sections) ? sections : []
    return cached
  } finally {
    inflight = null
  }
}

export interface SectionsState {
  sections: ShallowRef<Section[]>
  ensureSections: () => Promise<void>
}

export function useSections(): SectionsState {
  const sections = ref<Section[]>(cached ?? [])
  async function ensureSections(): Promise<void> {
    try {
      sections.value = await loadSections()
    } catch {
      // A section list is a convenience, never a blocker: filters and selects
      // simply fall back to the keys already present on the loaded rows.
      sections.value = cached ?? []
    }
  }
  return { sections, ensureSections }
}

/** Build the `<select>` options, folding in keys that only appear on rows. */
export function sectionOptions(sections: Section[], extraKeys: (string | null | undefined)[] = []): Option[] {
  const map = new Map<string, string>()
  for (const section of sections) map.set(section.key, section.label)
  for (const key of extraKeys) {
    if (key && !map.has(key)) map.set(key, key)
  }
  return [...map.entries()].map(([value, label]) => ({ value, label }))
}
