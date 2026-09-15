/**
 * The `.page-title` bar and `document.title` are owned by the layout, but only a
 * view knows what it is showing (a series is named by the collection, a piece by
 * the article). Module-level so `NotFoundView` — which is a sibling route and
 * renders the layout itself — can name its subject too.
 *
 * `null` means "not mine": the layout then falls back to the section's nav
 * label, so the title bar is never empty on a real page.
 */
import { ref, type Ref } from 'vue'

const pageTitle = ref<string | null>(null)

export function setPageTitle(value: string | null): void {
  pageTitle.value = value
}

export function usePageTitle(): Ref<string | null> {
  return pageTitle
}
