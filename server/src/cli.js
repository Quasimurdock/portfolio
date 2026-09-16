#!/usr/bin/env node
/**
 * Operational CLI — the few things the HTTP API deliberately does not expose.
 *
 * A fresh deployment has one problem the admin UI cannot solve: the only accounts
 * that can sign in are the seeded demo ones, whose password is in the README. So
 * the first thing you do on a new box is create a real account with this, then
 * disable or delete the demo ones.
 *
 *   npm --workspace server run cli -- users
 *   npm --workspace server run cli -- create --email me@example.com --name "Me" --role owner
 *   npm --workspace server run cli -- passwd --email me@example.com
 *   npm --workspace server run cli -- status --email demo@example.com --set disabled
 *   npm --workspace server run cli -- wipe-content --yes
 *
 * Inside Docker:
 *   docker compose exec app deno run --allow-all server/src/cli.js users
 *
 * Against a deployed Postgres (Deno Deploy has no shell, so this is how accounts
 * are made there):
 *   DB_DRIVER=postgres DATABASE_URL='postgresql://…' deno run --allow-all src/cli.js users
 *
 * A generated password is printed once and never stored in plain text. This runs
 * on the server, against the same database the API uses; when the SQLite driver
 * is configured, pass DATABASE_FILE if it points somewhere non-default.
 */
import { all, describeTarget, get, initDb, run } from './db.js'
import { generatePassword, hashPassword } from './auth.js'
import { record } from './audit.js'
import { ROLE_KEYS } from './permissions.js'

/* --------------------------------------------------------------- arguments -- */

const argv = process.argv.slice(2)
const command = argv[0]

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

function nowIso() {
  return new Date().toISOString()
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function banner(text) {
  console.log(`\n${text}`)
}

/* ------------------------------------------------------------------ actions -- */

async function listUsers() {
  const rows = await all(
    `SELECT id, email, name, role_key, status, password_hash IS NOT NULL AS has_password,
            wechat_openid IS NOT NULL AS has_wechat, last_login_at
       FROM users ORDER BY id`,
  )
  if (!rows.length) {
    console.log('no users yet — create one:  npm --workspace server run cli -- create --email you@example.com --name "You" --role owner')
    return
  }
  console.log(`${String('id').padEnd(4)} ${'email'.padEnd(30)} ${'role'.padEnd(8)} ${'status'.padEnd(9)} ${'pw'.padEnd(3)} ${'wx'.padEnd(3)} last login`)
  for (const u of rows) {
    console.log(
      `${String(u.id).padEnd(4)} ${String(u.email ?? '—').padEnd(30)} ${u.role_key.padEnd(8)} ${u.status.padEnd(9)} ${
        u.has_password ? 'yes' : '—  '
      } ${u.has_wechat ? 'yes' : '—  '} ${u.last_login_at ?? 'never'}`,
    )
  }
  console.log('\nroles: ' + ROLE_KEYS.join(', '))
}

async function createUser() {
  const email = flag('email')
  const name = flag('name') || (typeof email === 'string' ? email.split('@')[0] : null)
  const role = flag('role') || 'owner'
  if (typeof email !== 'string' || !email.includes('@')) fail('--email is required (and must look like an address)')
  if (!ROLE_KEYS.includes(role)) fail(`--role must be one of: ${ROLE_KEYS.join(', ')}`)
  if (await get('SELECT id FROM users WHERE email = ?', [email])) fail(`a user with ${email} already exists`)

  const password = typeof flag('password') === 'string' ? flag('password') : generatePassword()
  const now = nowIso()
  await run(
    `INSERT INTO users (email, name, avatar_url, password_hash, role_key, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'active', ?, ?)`,
    [email, name, hashPassword(password), role, now, now],
  )
  const id = (await get('SELECT id FROM users WHERE email = ?', [email])).id
  await record(null, 'cli-create', 'user', id, { email, role })

  banner(`created ${email} (${role})`)
  console.log(`  password: ${password}`)
  console.log('  printed once — change it with:  npm --workspace server run cli -- passwd --email ' + email)
}

async function setPassword() {
  const email = flag('email')
  if (typeof email !== 'string') fail('--email is required')
  const user = await get('SELECT id, email, status FROM users WHERE email = ?', [email])
  if (!user) fail(`no user with the email ${email}`)

  const password = typeof flag('password') === 'string' ? flag('password') : generatePassword()
  if (password.length < 8) fail('--password must be at least 8 characters')

  const now = nowIso()
  // accepting an invitation is exactly this: a password plus active status
  const activated = user.status === 'invited'
  await run(
    `UPDATE users SET password_hash = ?, status = ?, invite_token = NULL, updated_at = ? WHERE id = ?`,
    [hashPassword(password), activated ? 'active' : user.status, now, user.id],
  )
  await record(null, 'cli-passwd', 'user', user.id, { email, activated })

  banner(`password set for ${email}${activated ? ' (invitation accepted → active)' : ''}`)
  console.log(`  password: ${password}`)
  console.log('  printed once.')
}

async function setStatus() {
  const email = flag('email')
  const value = flag('set')
  if (typeof email !== 'string') fail('--email is required')
  if (value !== 'active' && value !== 'disabled' && value !== 'invited') fail('--set must be active, disabled or invited')
  const user = await get('SELECT id FROM users WHERE email = ?', [email])
  if (!user) fail(`no user with the email ${email}`)
  await run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [value, nowIso(), user.id])
  await record(null, 'cli-status', 'user', user.id, { email, status: value })
  banner(`${email} → ${value}`)
  if (value === 'disabled') console.log('  their existing sessions are dropped on next request.')
}

async function wipeContent() {
  if (flag('yes') !== true) {
    console.log('This deletes every collection, image, article, feed slide and page.')
    console.log('Users, roles, permissions and sections are kept.')
    console.log('\nRe-run with --yes if that is what you want:')
    console.log('  npm --workspace server run cli -- wipe-content --yes')
    return
  }
  const before = {
    feed: (await get('SELECT COUNT(*) n FROM feed_items')).n,
    images: (await get('SELECT COUNT(*) n FROM images')).n,
    collections: (await get('SELECT COUNT(*) n FROM collections')).n,
    articles: (await get('SELECT COUNT(*) n FROM articles')).n,
    pages: (await get('SELECT COUNT(*) n FROM pages')).n,
  }
  // order matters: children before parents (foreign keys are ON)
  for (const table of ['feed_items', 'images', 'collections', 'articles', 'pages']) {
    await run(`DELETE FROM ${table}`)
  }
  await record(null, 'cli-wipe', 'content', null, before)
  banner('demo content removed')
  for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(12)} ${v} row(s) deleted`)
  console.log('\nThe admin (/admin) is now empty and ready for your own work.')
}

function usage() {
  console.log(`Portfolio CLI — ${describeTarget()}

  users                                  list accounts
  create  --email --name --role          create an account (role: ${ROLE_KEYS.join('|')})
          [--password]                   omitted → a random one is printed once
  passwd  --email [--password]           set/reset a password (accepts an invitation if invited)
  status  --email --set <active|disabled|invited>
  wipe-content [--yes]                    delete the demo content, keep users and sections

Flags: --email, --name, --role, --password, --set, --yes
Inside Docker:  docker compose exec app deno run --allow-all server/src/cli.js <command>`)
}

/* -------------------------------------------------------------------- main -- */

await initDb()

switch (command) {
  case 'users':
  case 'list':
    await listUsers()
    break
  case 'create':
  case 'create-user':
    await createUser()
    break
  case 'passwd':
  case 'password':
    await setPassword()
    break
  case 'status':
    await setStatus()
    break
  case 'wipe-content':
    await wipeContent()
    break
  default:
    usage()
    if (command) process.exitCode = 1
}
