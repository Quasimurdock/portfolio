/**
 * Three-slide paging (the studio feed and the lightbox are the same widget).
 *
 * Rebuilt on vueuse: `useSwipe` reports the live gesture and
 * `usePreferredReducedMotion` turns the glide off for people who asked for that
 * — the frame still changes, it just does not travel.
 *
 * The track holds prev / current / next behind a clipping viewport. A completed
 * step eases one frame across, then commits the index and re-centres silently:
 * because the slides are keyed by content, the nodes move and the arriving
 * photograph is already decoded — no white flash, no second request.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { usePreferredReducedMotion, useSwipe } from '@vueuse/core'

export interface Slide<T> {
  item: T
  key: string
}

export interface SliderOptions<T> {
  /** the underlying list — feed items, series images, … */
  list: () => T[]
  /** current index, owned by the caller so routing and thumbnails stay in sync */
  index: Ref<number>
  /** stable identity per item; drives node reuse across the silent re-centre */
  keyOf: (item: T, index: number) => string
  /** invoked after a committed step (e.g. to restart the feed's autoplay) */
  onChange?: (direction: number) => void
}

export interface Slider<T> {
  viewport: Ref<HTMLElement | null>
  slides: ComputedRef<Slide<T>[]>
  trackStyle: ComputedRef<Record<string, string>>
  next: () => void
  prev: () => void
  go: (direction: number) => void
  busy: Ref<boolean>
}

/** how far the finger must travel before the frame is allowed to turn */
const DISTANCE_RATIO = 0.22
/** …or how fast, in px/ms, for a flick */
const FLICK_VELOCITY = 0.45

export function useSlider<T>(options: SliderOptions<T>): Slider<T> {
  const viewport = ref<HTMLElement | null>(null)
  const dx = ref(0)
  const animating = ref(false)
  const reduced = usePreferredReducedMotion()

  const duration = computed(() => (reduced.value === 'reduce' ? 1 : 330))
  const list = computed(() => options.list())
  const count = computed(() => list.value.length)

  let timer: number | undefined
  let pending = 0
  let startedAt = 0

  const width = () => viewport.value?.clientWidth || 1

  const slides = computed<Slide<T>[]>(() => {
    const items = list.value
    const n = items.length
    const i = options.index.value
    if (!n) return []
    if (n === 1) return [{ item: items[0] as T, key: options.keyOf(items[0] as T, 0) }]
    // n < 3 would repeat a key, so those get a role prefix (and may re-create nodes)
    const slot = (offset: number, role: string): Slide<T> => {
      const idx = (i + offset + n) % n
      const item = items[idx] as T
      const key = options.keyOf(item, idx)
      return { item, key: n >= 3 ? key : `${role}:${key}` }
    }
    return [slot(-1, 'prev'), slot(0, 'cur'), slot(1, 'next')]
  })

  const trackStyle = computed<Record<string, string>>(() => {
    const k = slides.value.length || 1
    const base = k > 1 ? 100 / k : 0
    return {
      '--slide-count': String(k),
      transform: `translate3d(calc(-${base}% + ${dx.value}px), 0, 0)`,
      transition: animating.value ? `transform ${duration.value}ms cubic-bezier(.22,.61,.36,1)` : 'none',
    }
  })

  function commit(direction: number) {
    if (!direction || count.value < 2) return
    options.index.value = (options.index.value + direction + count.value) % count.value
    options.onChange?.(direction)
  }

  function go(direction: number) {
    if (count.value < 2) return
    if (timer) {
      // a second request mid-flight: finish the first frame at once, then start over
      window.clearTimeout(timer)
      commit(pending)
      timer = undefined
      animating.value = false
      dx.value = 0
    }
    pending = direction
    animating.value = true
    dx.value = -direction * width()
    timer = window.setTimeout(() => {
      commit(pending)
      timer = undefined
      animating.value = false
      dx.value = 0
    }, duration.value)
  }

  const next = () => go(1)
  const prev = () => go(-1)

  // vueuse hands the gesture back as (event, direction) and exposes the travelled
  // distance on the returned refs; `passive` stays at its default true, so the
  // page keeps scrolling vertically underneath us.
  const swipe = useSwipe(viewport, {
    threshold: 12,
    onSwipeStart: () => {
      startedAt = Date.now()
    },
    onSwipeEnd: (_event: TouchEvent, direction: string) => {
      if (direction !== 'left' && direction !== 'right') {
        // a vertical drag: the page keeps scrolling, the frame stays put
        dx.value = 0
        return
      }
      const length = swipe.lengthX.value
      const ms = Math.max(1, Date.now() - startedAt)
      const far = length > width() * DISTANCE_RATIO
      const flick = length > 24 && length / ms > FLICK_VELOCITY
      if (!far && !flick) {
        animating.value = true
        dx.value = 0
        window.setTimeout(() => (animating.value = false), duration.value)
        return
      }
      go(direction === 'left' ? 1 : -1)
    },
  })

  // follow the finger while the gesture is live
  watch([swipe.isSwiping, swipe.lengthX, swipe.direction], () => {
    if (!swipe.isSwiping.value) return
    if (swipe.direction.value === 'left') dx.value = -swipe.lengthX.value
    else if (swipe.direction.value === 'right') dx.value = swipe.lengthX.value
  })

  return { viewport, slides, trackStyle, next, prev, go, busy: animating }
}
