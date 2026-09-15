<script setup lang="ts">
/**
 * Sign in.
 *
 * Three doors, in the order a real studio would use them: WeChat (the client's
 * audience is in China), email + password, and — because the seeded database
 * has four accounts and no mail server — a dev shortcut. The dev endpoint is
 * only mounted when the server runs with `AUTH_DEV=1`, so its failure is
 * surfaced as a toast instead of being treated as a bug.
 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { errorMessage } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import FormField from '@/admin/components/FormField.vue'

interface DevAccount {
  email: string
  role: string
  note: string
}

const DEV_ACCOUNTS: DevAccount[] = [
  { email: 'owner@portfolio.test', role: 'owner', note: 'every permission' },
  { email: 'editor@portfolio.test', role: 'editor', note: 'publishes everything' },
  { email: 'author@portfolio.test', role: 'author', note: 'own drafts only' },
  { email: 'viewer@portfolio.test', role: 'viewer', note: 'read-only' },
]

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { info, error: toastError } = useToast()

const form = reactive({ email: '', password: '' })
const errors = reactive({ email: '', password: '' })
const submitting = ref(false)
const wechatLoading = ref(false)
const devPending = ref('')

/** Only ever bounce back into the back office — never off-site. */
const redirect = computed(() => {
  const value = route.query.redirect
  const target = typeof value === 'string' ? value : ''
  return target.startsWith('/admin') ? target : '/admin'
})

function validate(): boolean {
  errors.email = form.email.trim() ? '' : 'An email address is required.'
  errors.password = form.password ? '' : 'A password is required.'
  return !errors.email && !errors.password
}

async function submit(): Promise<void> {
  if (submitting.value || !validate()) return
  submitting.value = true
  try {
    await auth.login(form.email.trim(), form.password)
    info('Signed in.')
    await router.replace(redirect.value)
  } catch (error) {
    errors.password = ''
    toastError(errorMessage(error))
  } finally {
    submitting.value = false
  }
}

async function wechat(): Promise<void> {
  if (wechatLoading.value) return
  wechatLoading.value = true
  try {
    const url = await auth.wechatAuthorizeUrl('/admin')
    if (!url) throw new Error('The server did not return an authorize URL.')
    window.location.assign(url)
  } catch (error) {
    toastError(`WeChat sign-in is unavailable: ${errorMessage(error)}`)
    wechatLoading.value = false
  }
}

async function devLogin(email: string): Promise<void> {
  if (devPending.value) return
  devPending.value = email
  try {
    await auth.devLogin(email)
    info(`Signed in as ${email}.`)
    await router.replace(redirect.value)
  } catch (error) {
    toastError(`Quick sign-in is disabled on this server (${errorMessage(error)}). Sign in with a password instead.`)
  } finally {
    devPending.value = ''
  }
}
</script>

<template>
  <div class="admin-login">
    <section class="admin-login__intro">
      <p class="admin-login__eyebrow">Portfolio</p>
      <h1 class="admin-login__title">Studio</h1>
      <p class="admin-login__lead">
        The back office: collections, essays, the home slideshow and the pages behind the work.
        Everything publishable moves draft → review → published → archived, and every change is
        recorded against the account that made it.
      </p>
      <ul class="admin-login__facts">
        <li>Content is owned — without a read-all permission you only ever see your own rows.</li>
        <li>Images live on OSS; the server signs uploads and never stores a byte.</li>
        <li>Roles map to permission rows in the database, not to branches in code.</li>
      </ul>
      <a class="admin-login__back" href="/">← Back to the site</a>
    </section>

    <section class="admin-login__panel">
      <form class="admin-login__form" novalidate @submit.prevent="submit">
        <h2 class="admin-login__panel-title">Sign in</h2>

        <FormField label="Email" for-id="login-email" required :error="errors.email">
          <input
            id="login-email"
            v-model="form.email"
            class="admin-input"
            type="email"
            name="email"
            autocomplete="username"
            placeholder="you@studio.test"
          />
        </FormField>

        <FormField label="Password" for-id="login-password" required :error="errors.password">
          <input
            id="login-password"
            v-model="form.password"
            class="admin-input"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
        </FormField>

        <button type="submit" class="admin-btn admin-btn--primary admin-btn--block" :disabled="submitting">
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>

        <p class="admin-login__or"><span>or</span></p>

        <button type="button" class="admin-btn admin-btn--block" :disabled="wechatLoading" @click="wechat">
          {{ wechatLoading ? 'Opening WeChat…' : 'Continue with WeChat' }}
        </button>
      </form>

      <div class="admin-login__dev">
        <h3 class="admin-login__dev-title">Local development</h3>
        <p class="admin-login__dev-note">
          The seeded accounts, signed in without a password. This shortcut only works while the
          server runs with <code>AUTH_DEV=1</code>; the password for all four is
          <code>portfolio</code>.
        </p>
        <ul class="admin-login__accounts">
          <li v-for="account in DEV_ACCOUNTS" :key="account.email">
            <button
              type="button"
              class="admin-btn admin-btn--sm admin-btn--ghost admin-btn--block"
              :disabled="!!devPending"
              @click="devLogin(account.email)"
            >
              <span class="admin-login__account-role">{{ devPending === account.email ? '…' : account.role }}</span>
              <span class="admin-login__account-email">{{ account.email }}</span>
              <span class="admin-login__account-note">{{ account.note }}</span>
            </button>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
