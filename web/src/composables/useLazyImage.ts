/**
 * Lazy images, built on vueuse's `useIntersectionObserver`.
 *
 * Usage is the same as the original `v-lazy` directive so the ported templates
 * stay readable:
 *
 *   <img v-lazy="{ key, src, srcset, sizes }">        an <img> gets src/srcset
 *   <div class="grid-single__img" v-lazy="{ bg }">    a div gets background-image
 *
 * Behaviour kept from the single-file build (it earned its keep):
 *   - nothing is requested until the element is within 800px of the viewport
 *   - one retry on failure, then a generated SVG "plate" so the layout never
 *     collapses and a slow/broken CDN still looks deliberate
 *   - a 15s ceiling, after which the plate stands in and any late arrival
 *     replaces it
 */
import { useIntersectionObserver } from '@vueuse/core'
import type { Directive } from 'vue'

export interface LazyConfig {
  /** identity of the payload; changing it re-arms the element */
  key?: string
  /** for <img> */
  src?: string
  srcset?: string
  sizes?: string
  /** for background elements */
  bg?: string
  /** height / width, used by the generated fallback plate */
  ratio?: number
}

const ROOT_MARGIN = '800px 0px'
/**
 * A photograph that has not arrived in 25s is treated as unavailable (see
 * `fallback`). The ceiling only ever matters for a *slow* response: a genuinely
 * broken URL fires `error` immediately and falls back at once. It is deliberately
 * generous because replacing a working-but-slow image with a plate is worse than
 * waiting — the placeholder CDN used in development regularly takes 15s+.
 */
const TIMEOUT_MS = 25_000
const RETRY_MS = 900

interface LazyState {
  stop: () => void
  timer?: number
  retried: boolean
  done: boolean
}

const states = new WeakMap<HTMLElement, LazyState>()

/** Deterministic hash so a given image always yields the same plate. */
function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h >>> 0
}

/** A generated "unexposed plate": gradient, registration cross, hairline. */
export function plate(seed: string, ratio = 1.3): string {
  const h = 900
  const w = Math.round(h / (ratio || 1.3))
  const shade = 210 + (hash(seed) % 28)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#f7f7f7"/><stop offset="1" stop-color="rgb(${shade},${shade},${shade})"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<g stroke="rgba(0,0,0,.06)">` +
    `<path d="M0 ${(h * 0.5).toFixed(0)}H${w}M${(w * 0.5).toFixed(0)} 0V${h}"/>` +
    `<path d="M${w / 2 - 16} ${h / 2}h32M${w / 2} ${h / 2 - 16}v32" stroke="rgba(0,0,0,.18)"/>` +
    `</g></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function settle(el: HTMLElement, state: LazyState) {
  if (state.timer) window.clearTimeout(state.timer)
  state.timer = undefined
  state.done = true
}

function markLoaded(el: HTMLElement) {
  el.classList.remove('is-loading')
  el.classList.add('is-loaded')
}

function fallback(el: HTMLElement, cfg: LazyConfig) {
  const src = plate(cfg.key ?? cfg.src ?? cfg.bg ?? 'plate', cfg.ratio)
  el.classList.remove('is-loading')
  el.classList.add('is-fallback', 'is-loaded')
  if (cfg.bg && !cfg.src) {
    el.style.backgroundImage = `url("${src}")`
  } else {
    el.removeAttribute('srcset')
    el.removeAttribute('sizes')
    ;(el as HTMLImageElement).src = src
  }
}

/** Load one <img> that is already in range. */
function hydrateImage(el: HTMLImageElement, cfg: LazyConfig, state: LazyState) {
  const assign = () => {
    if (cfg.sizes) el.sizes = cfg.sizes
    if (cfg.srcset) el.srcset = cfg.srcset
    if (cfg.src) el.src = cfg.src
  }

  el.onload = () => {
    settle(el, state)
    markLoaded(el)
  }
  el.onerror = () => {
    if (!state.retried) {
      state.retried = true
      window.setTimeout(() => {
        el.removeAttribute('srcset')
        el.removeAttribute('src')
        assign()
      }, RETRY_MS)
      return
    }
    settle(el, state)
    fallback(el, cfg)
  }

  assign()
}

/** Load one element whose photograph is painted as a background. */
function hydrateBackground(el: HTMLElement, cfg: LazyConfig, state: LazyState) {
  const attempt = () => {
    const probe = new Image()
    probe.decoding = 'async'
    probe.onload = () => {
      el.style.backgroundImage = `url("${cfg.bg}")`
      settle(el, state)
      markLoaded(el)
    }
    probe.onerror = () => {
      if (!state.retried) {
        state.retried = true
        window.setTimeout(attempt, RETRY_MS)
        return
      }
      settle(el, state)
      fallback(el, cfg)
    }
    probe.src = cfg.bg as string
  }
  attempt()
}

function arm(el: HTMLElement, cfg: LazyConfig) {
  if (!cfg || (!cfg.src && !cfg.bg)) return

  const previous = states.get(el)
  if (previous) {
    if (el.dataset.lazyKey === cfg.key) return
    previous.stop()
    if (previous.timer) window.clearTimeout(previous.timer)
  }

  const state: LazyState = { stop: () => undefined, retried: false, done: false }
  states.set(el, state)
  el.dataset.lazyKey = cfg.key ?? ''
  el.classList.remove('is-loaded', 'is-fallback')
  el.classList.add('is-loading')

  const hydrate = () => {
    if (state.done) return
    if (cfg.bg && !cfg.src) hydrateBackground(el, cfg, state)
    else hydrateImage(el as HTMLImageElement, cfg, state)
  }

  // never leave a plate breathing forever
  state.timer = window.setTimeout(() => {
    if (!state.done) {
      settle(el, state)
      fallback(el, cfg)
    }
  }, TIMEOUT_MS)

  if (typeof IntersectionObserver === 'undefined') {
    hydrate()
    return
  }

  const { stop } = useIntersectionObserver(
    el,
    (entries) => {
      const entry = entries[0]
      if (!entry?.isIntersecting) return
      stop()
      hydrate()
    },
    { rootMargin: ROOT_MARGIN, threshold: 0.01 },
  )
  state.stop = stop
}

export const lazyImage: Directive<HTMLElement, LazyConfig> = {
  mounted(el, binding) {
    arm(el, binding.value)
  },
  updated(el, binding) {
    if (!binding.value) return
    if (binding.value.key !== binding.oldValue?.key) arm(el, binding.value)
  },
  unmounted(el) {
    const state = states.get(el)
    if (!state) return
    state.stop()
    if (state.timer) window.clearTimeout(state.timer)
    states.delete(el)
  },
}
