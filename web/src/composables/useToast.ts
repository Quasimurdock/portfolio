/**
 * Toasts — a module-level singleton so any surface (public or admin) can push
 * feedback without threading props around.
 */
import { ref } from 'vue'

export type ToastTone = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
  /** ms; 0 means it stays until dismissed */
  ttl: number
}

const toasts = ref<Toast[]>([])
let seq = 0

function push(message: string, tone: ToastTone = 'info', ttl = tone === 'error' ? 7000 : 3800) {
  const id = ++seq
  toasts.value = [...toasts.value, { id, tone, message, ttl }]
  if (ttl > 0) window.setTimeout(() => dismiss(id), ttl)
  return id
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function useToast() {
  return {
    toasts,
    dismiss,
    info: (message: string) => push(message, 'info'),
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error'),
  }
}
