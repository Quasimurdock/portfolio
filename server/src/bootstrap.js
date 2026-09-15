#!/usr/bin/env node
/**
 * Deploy bootstrap — idempotent, so it is safe to run on *every* deployment.
 *
 * Deno Deploy has no shell, so the first deploy of a fresh database cannot be
 * finished by hand. Wire this in as the app's **Pre-Deploy Command**
 * (App Settings → App Config → Pre-Deploy Command):
 *
 *   deno run --allow-all server/src/bootstrap.js
 *
 * It runs once per timeline with that timeline's own database injected, and does
 * three things:
 *
 *   1. applies the schema (idempotent DDL)
 *   2. seeds the demo content, `sections` and the RBAC matrix **if the database
 *      is still empty** — `sections` has no write API, so without this a fresh
 *      database can never create an article or a collection
 *   3. ensures a sign-in account exists, from the environment:
 *
 *        DEMO_OWNER_EMAIL             default demo@portfolio.test
 *        DEMO_OWNER_PASSWORD          required, no default — deliberately
 *        DEMO_OWNER_NAME              default: the email's local part
 *        DEMO_OWNER_ROLE              default owner
 *        DEMO_OWNER_RESET_PASSWORD=1  also overwrite an existing password
 *
 * An account that already exists is left exactly as it is unless
 * DEMO_OWNER_RESET_PASSWORD=1, so editing a name or password in the admin UI
 * survives the next deploy. With no DEMO_OWNER_PASSWORD set this step is skipped
 * with a warning rather than failing the build.
 *
 * The password is never logged: Deno Deploy keeps build logs. Use one of the
 * seeded demo accounts (password "portfolio") if you would rather not set it.
 */
import { describeTarget, get, initDb, insertReturningId, run, tx } from './db.js'
import { hashPassword } from './auth.js'
import { record } from './audit.js'
import { ROLE_KEYS } from './permissions.js'
import { seedEverything } from './seed.js'

const DEFAULT_EMAIL = 'demo@portfolio.test'

function env(name) {
  const value = process.env[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function truthy(value) {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value)
}

/** Seed only an untouched database, so a redeploy never rewrites edited rows. */
async function seedIfEmpty() {
  // `sections` is the one seeded table with no write endpoint, which makes it
  // the honest answer to "has this database ever been seeded?".
  const { n } = await get('SELECT COUNT(*) AS n FROM sections')
  if (n > 0) {
    console.log(`bootstrap: ${n} sections already present — leaving the demo seed alone`)
    return
  }
  console.log('bootstrap: empty database — seeding the demo content')
  await tx(seedEverything)
}

async function ensureAccount() {
  const email = env('DEMO_OWNER_EMAIL') ?? DEFAULT_EMAIL
  const password = env('DEMO_OWNER_PASSWORD')

  if (!password) {
    console.log(
      'bootstrap: DEMO_OWNER_PASSWORD is not set — no account was created or changed.\n' +
        '  Either set DEMO_OWNER_PASSWORD (mark it secret) plus optionally DEMO_OWNER_EMAIL,\n' +
        '  or sign in with a seeded demo account: owner@portfolio.test / "portfolio".',
    )
    return
  }
  if (password.length < 8) throw new Error('DEMO_OWNER_PASSWORD must be at least 8 characters')

  const role = env('DEMO_OWNER_ROLE') ?? 'owner'
  if (!ROLE_KEYS.includes(role)) throw new Error(`DEMO_OWNER_ROLE must be one of: ${ROLE_KEYS.join(', ')}`)

  const name = env('DEMO_OWNER_NAME') ?? email.split('@')[0]
  const existing = await get('SELECT id, status FROM users WHERE email = ?', [email])
  const now = new Date().toISOString()

  if (existing) {
    if (!truthy(env('DEMO_OWNER_RESET_PASSWORD'))) {
      console.log(
        `bootstrap: ${email} already exists (id ${existing.id}, ${existing.status}) — left as it is.\n` +
          '  Set DEMO_OWNER_RESET_PASSWORD=1 to force this password back on.',
      )
      return
    }
    await run(
      `UPDATE users SET name = ?, password_hash = ?, role_key = ?, status = 'active', updated_at = ?
        WHERE id = ?`,
      [name, hashPassword(password), role, now, existing.id],
    )
    await record(null, 'bootstrap-reset', 'user', existing.id, { email, role })
    console.log(`bootstrap: password reset for ${email} (${role}, active)`)
    return
  }

  const id = await insertReturningId(
    `INSERT INTO users (email, name, avatar_url, password_hash, role_key, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'active', ?, ?)`,
    [email, name, hashPassword(password), role, now, now],
  )
  await record(null, 'bootstrap-create', 'user', id, { email, role })
  console.log(`bootstrap: created ${email} (${role}) — sign in at /admin`)
}

await initDb()
console.log(`bootstrap: ${describeTarget()}`)
await seedIfEmpty()
await ensureAccount()
console.log('bootstrap: done')
