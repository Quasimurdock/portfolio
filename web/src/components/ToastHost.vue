<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <button
        v-for="toast in toasts"
        :key="toast.id"
        type="button"
        class="toast"
        :class="`toast--${toast.tone}`"
        @click="dismiss(toast.id)"
      >
        {{ toast.message }}
      </button>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  z-index: 90;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  max-width: 42ch;
  padding: 10px 14px;
  border: 1px solid var(--rule, #e6e6e6);
  border-left-width: 3px;
  background: var(--paper, #fff);
  color: var(--ink, #000);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.toast--success { border-left-color: #1a7f37; }
.toast--error { border-left-color: #b42318; }
.toast--info { border-left-color: #000; }

.toast-enter-active,
.toast-leave-active { transition: opacity 180ms ease, transform 180ms ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(6px); }
</style>
