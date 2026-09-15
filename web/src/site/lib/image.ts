/**
 * Small helpers shared by the public components.
 *
 * Every photograph on the site goes through the global `v-lazy` directive, so
 * each of these returns exactly the fragments a `v-lazy` config needs
 * (`key` / `src` / `srcset` / `sizes` / `bg` / `ratio`) rather than markup.
 */
import type { ImageAsset, LinkKind } from '@/types/api'

/**
 * The legacy page's `imageSizes`. Full-bleed photographs are capped by the
 * measured reference width (1380px) and otherwise run to 92vw of the window.
 */
export const PHOTO_SIZES = '(min-width:1250px) 1380px, 92vw'

/** Two candidates, as the payload provides them: the large file and the thumb. */
export function imageSrcset(image?: ImageAsset | null): string | undefined {
  if (!image?.url) return undefined
  return image.thumbUrl ? `${image.url} 1600w, ${image.thumbUrl} 800w` : undefined
}

/** The `src` fallback — the large file, or the thumb when that is all there is. */
export function imageSrc(image?: ImageAsset | null): string | undefined {
  return image?.url || image?.thumbUrl || undefined
}

/** The photograph painted into a `.grid-single__img` box (background mode). */
export function imageThumb(image?: ImageAsset | null): string | undefined {
  return image?.thumbUrl || image?.url || undefined
}

/**
 * height / width, used by the generated fallback plate so a failed request
 * still occupies the box the layout reserved for it.
 */
export function imageRatio(image?: ImageAsset | null, fallback = 1.3): number {
  const width = image?.width
  const height = image?.height
  return width && height ? height / width : fallback
}

/** alt text is never empty by accident — alt, else the caption, else decorative. */
export function imageAlt(image?: ImageAsset | null): string {
  return image?.alt || image?.caption || ''
}

/** The feed/lightbox caption line. */
export function imageCaption(image?: ImageAsset | null): string {
  return image?.caption || image?.alt || ''
}

/** `01`, `02`, … — the count register the reference uses. */
export function pad(value: number): string {
  return (value < 10 ? '0' : '') + value
}

/**
 * A markdown-ish body flattened into paragraphs. The API stores prose as a
 * single string (blank line between paragraphs); the old page held an array,
 * so this is the one place that bridges the two.
 */
export function splitParagraphs(body?: string | null): string[] {
  if (!body) return []
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

/** A resolved feed link: internal hrefs go through the router, external ones do not. */
export function isExternalLink(link?: { kind: LinkKind; href: string | null } | null): boolean {
  const href = link?.href
  if (!href) return false
  if (link?.kind === 'external') return true
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
}

/**
 * The router path a payload href points at, or null when it is not an internal
 * link. Legacy `#/contact`-style hrefs are normalised to `/contact`.
 */
export function internalPath(href?: string | null): string | null {
  if (!href) return null
  const path = href.startsWith('#/') ? href.slice(1) : href
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return null
  return path.startsWith('/') ? path : null
}

/** `internalPath` with an empty-string miss, so templates can test it directly. */
export function routePath(href?: string | null): string {
  return internalPath(href) ?? ''
}
