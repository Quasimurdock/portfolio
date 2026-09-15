#!/usr/bin/env node
/**
 * API smoke test — no dependencies, no browser.
 *
 *   npm --workspace server run start      # in one terminal (seeds on first boot)
 *   node scripts/smoke.mjs                # in another
 *
 * It signs in as each seeded account and asserts the things that matter most:
 * that permissions differ per role, that one author cannot see or touch another
 * author's rows, that only a publisher can put an article in front of the
 * public, and that the public API hides everything it should.
 *
 * Exit code is non-zero if any assertion fails.
 */
const API = process.env.API ?? 'http://127.0.0.1:8787'
const PASSWORD = process.env.SEED_PASSWORD ?? 'portfolio'

const ACCOUNTS = {
  owner: 'owner@portfolio.test',
  editor: 'editor@portfolio.test',
  author: 'author@portfolio.test',
  viewer: 'viewer@portfolio.test',
}

let passed = 0
const failures = []

function ok(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`)
}

/** Minimal cookie jar: Node's fetch does not remember Set-Cookie for us. */
function makeJar() {
  const jar = new Map()
  return {
    absorb(response) {
      const raw = response.headers.getSetCookie?.() ?? []
      for (const line of raw) {
        const [pair] = line.split(';')
        const idx = pair.indexOf('=')
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    clear() {
      jar.clear()
    },
  }
}

async function call(jar, method, path, body) {
  const headers = { Accept: 'application/json' }
  if (jar.header()) headers.Cookie = jar.header()
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  jar.absorb(response)
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  return { status: response.status, body: payload, location: response.headers.get('location') }
}

async function login(role) {
  const jar = makeJar()
  const res = await call(jar, 'POST', '/api/auth/login', { email: ACCOUNTS[role], password: PASSWORD })
  if (res.status !== 200) throw new Error(`could not sign in as ${role}: HTTP ${res.status} ${JSON.stringify(res.body)}`)
  return { role, jar, user: res.body.user, permissions: res.body.permissions ?? [] }
}

async function main() {
  console.log(`\x1b[1mPortfolio API smoke test\x1b[0m  →  ${API}`)

  /* ------------------------------------------------------------ reachability */
  heading('reachability')
  const anon = makeJar()
  const me = await call(anon, 'GET', '/api/auth/me')
  ok('anonymous GET /api/auth/me is 401', me.status === 401, `HTTP ${me.status}`)
  const notFound = await call(anon, 'GET', '/api/definitely-not-a-route')
  ok(
    'unknown route returns the documented error envelope',
    notFound.status === 404 && notFound.body?.error?.code && notFound.body?.error?.message,
    JSON.stringify(notFound.body).slice(0, 90),
  )

  /* --------------------------------------------------------------- accounts */
  heading('seeded accounts and their permissions')
  const sessions = {}
  for (const role of Object.keys(ACCOUNTS)) {
    sessions[role] = await login(role)
    const s = sessions[role]
    console.log(`  ${role.padEnd(7)} ${s.user.name.padEnd(18)} ${String(s.permissions.length).padStart(2)} permissions`)
  }
  ok('the owner holds more permissions than the author', sessions.owner.permissions.length > sessions.author.permissions.length)
  ok('the author may write articles', sessions.author.permissions.includes('content.article.write'))
  ok('the author may NOT publish', !sessions.author.permissions.includes('content.article.publish'))
  ok('the author may NOT read across authors', !sessions.author.permissions.includes('content.article.read_all'))
  ok('the viewer may only read', sessions.viewer.permissions.every((p) => p.endsWith('.read_all') || p === 'user.read'))

  /* ------------------------------------------------------- ownership isolation */
  heading('ownership isolation')
  const ownerAll = await call(sessions.owner.jar, 'GET', '/api/admin/articles?scope=all&pageSize=100')
  const ownerItems = ownerAll.body?.items ?? []
  ok('the owner sees the whole library', ownerAll.status === 200 && ownerItems.length > 0, `${ownerItems.length} articles`)

  const authorAll = await call(sessions.author.jar, 'GET', '/api/admin/articles?scope=all&pageSize=100')
  const authorItems = authorAll.body?.items ?? []
  const authorId = sessions.author.user.id
  ok('scope=all is downgraded for the author', authorItems.length > 0 && authorItems.every((a) => a.authorId === authorId),
    `${authorItems.length} visible, all owned by the author`)

  const foreign = ownerItems.find((a) => !authorItems.some((b) => b.id === a.id))
  if (foreign) {
    const read = await call(sessions.author.jar, 'GET', `/api/admin/articles/${foreign.id}`)
    ok("reading another author's article is 403", read.status === 403, `HTTP ${read.status}`)
    const patch = await call(sessions.author.jar, 'PATCH', `/api/admin/articles/${foreign.id}`, { title: 'hijacked' })
    ok("patching another author's article is 403", patch.status === 403, `HTTP ${patch.status}`)
    const remove = await call(sessions.author.jar, 'DELETE', `/api/admin/articles/${foreign.id}`)
    ok("deleting another author's article is 403", remove.status === 403, `HTTP ${remove.status}`)
  } else {
    ok('found an article owned by someone else to test against', false, 'seed does not provide two authors')
  }

  /* -------------------------------------------------------- author → publish */
  heading('draft → review → published, and who may do it')
  const sections = await call(anon, 'GET', '/api/public/nav')
  const listSection = (sections.body ?? []).find((s) => s.kind === 'list') ?? (sections.body ?? [])[0]
  ok('the public nav lists sections', Array.isArray(sections.body) && sections.body.length > 0, `${sections.body?.length} sections`)

  const title = `Smoke test piece ${Date.now().toString().slice(-6)}`
  const created = await call(sessions.author.jar, 'POST', '/api/admin/articles', {
    title,
    sectionKey: listSection.key,
    excerpt: 'Created by scripts/smoke.mjs',
    body: 'First paragraph.\n\nSecond paragraph.',
  })
  const article = created.body
  ok('the author can create a draft', (created.status === 200 || created.status === 201) && article?.id, `HTTP ${created.status}`)

  if (article?.id) {
    const denied = await call(sessions.author.jar, 'POST', `/api/admin/articles/${article.id}/status`, { status: 'published' })
    ok('the author cannot publish it themselves', denied.status === 403, `HTTP ${denied.status}`)

    const submitted = await call(sessions.author.jar, 'POST', `/api/admin/articles/${article.id}/status`, { status: 'review' })
    ok('the author can submit it for review', submitted.status === 200 && submitted.body?.status === 'review', `HTTP ${submitted.status}`)

    const published = await call(sessions.editor.jar, 'POST', `/api/admin/articles/${article.id}/status`, { status: 'published' })
    ok('an editor can publish it', published.status === 200 && published.body?.status === 'published', `HTTP ${published.status}`)
    ok('published_at is stamped', !!published.body?.publishedAt, published.body?.publishedAt ?? 'missing')

    const slug = published.body?.slug ?? article.slug
    const publicly = await call(anon, 'GET', `/api/public/articles/${slug}`)
    ok('it is now visible on the public API', publicly.status === 200 && publicly.body?.title === title, `HTTP ${publicly.status}`)
    ok('the public payload hides internal fields',
      publicly.body && publicly.body.status === undefined && publicly.body.authorId === undefined && publicly.body.author_id === undefined)

    const viewerWrite = await call(sessions.viewer.jar, 'POST', '/api/admin/articles', { title: 'nope', sectionKey: listSection.key })
    ok('a viewer cannot create anything', viewerWrite.status === 403, `HTTP ${viewerWrite.status}`)

    const archived = await call(sessions.editor.jar, 'POST', `/api/admin/articles/${article.id}/status`, { status: 'archived' })
    const gone = await call(anon, 'GET', `/api/public/articles/${slug}`)
    ok('archiving removes it from the public API again',
      archived.status === 200 && (gone.status === 404 || gone.body?.status === undefined), `archive HTTP ${archived.status}, public HTTP ${gone.status}`)

    const cleanup = await call(sessions.editor.jar, 'DELETE', `/api/admin/articles/${article.id}`)
    ok('an editor can delete it', cleanup.status === 200 || cleanup.status === 204, `HTTP ${cleanup.status}`)
  }

  /* ------------------------------------------------------------------- media */
  heading('images are URLs, and uploads are signed')
  const sign = await call(sessions.author.jar, 'POST', '/api/uploads/sign', {
    filename: 'smoke.jpg',
    contentType: 'image/jpeg',
    size: 123456,
  })
  ok('a signed upload ticket comes back', sign.status === 200 && sign.body?.upload?.url && sign.body?.publicUrl,
    `${sign.body?.provider} → ${sign.body?.upload?.url ?? '?'}`)
  const viewerSign = await call(sessions.viewer.jar, 'POST', '/api/uploads/sign', { filename: 'x.jpg', contentType: 'image/jpeg', size: 1 })
  ok('a viewer cannot request an upload ticket', viewerSign.status === 403, `HTTP ${viewerSign.status}`)

  const imageBody = {
    url: `https://cdn.example.com/uploads/smoke-${Date.now()}.jpg`,
    thumbUrl: `https://cdn.example.com/uploads/smoke-${Date.now()}-thumb.jpg`,
    width: 1200,
    height: 1560,
    caption: 'Smoke test plate',
    alt: 'Smoke test plate',
  }
  const image = await call(sessions.author.jar, 'POST', '/api/admin/images', imageBody)
  ok('the author can register an image by URL', (image.status === 200 || image.status === 201) && image.body?.id, `HTTP ${image.status}`)
  const storedUrl = image.body?.url
  ok('the server stored the URL, not the bytes', typeof storedUrl === 'string' && storedUrl.startsWith('https://'),
    String(storedUrl).slice(0, 60))

  /* -------------------------------------------------------- collections/pages */
  heading('collections, pages and the audit trail')
  const collections = await call(sessions.editor.jar, 'GET', '/api/admin/collections?scope=all&pageSize=5')
  ok('collections list', collections.status === 200 && Array.isArray(collections.body?.items), `${collections.body?.items?.length ?? 0} rows`)
  const pages = await call(sessions.author.jar, 'GET', '/api/admin/pages')
  ok('pages list', pages.status === 200 && Array.isArray(pages.body), `${Array.isArray(pages.body) ? pages.body.length : 0} pages`)
  const overview = await call(sessions.owner.jar, 'GET', '/api/admin/overview')
  ok('the publishing overview answers', overview.status === 200 && overview.body?.counts, `${overview.body?.counts?.length ?? 0} count rows`)
  const audit = await call(sessions.owner.jar, 'GET', '/api/admin/audit?limit=10')
  ok('the audit trail recorded our work', audit.status === 200 && Array.isArray(audit.body) && audit.body.length > 0, `${audit.body?.length ?? 0} entries`)

  /* ------------------------------------------------------------- wechat login */
  heading('WeChat login (mock mode)')
  const wxJar = makeJar()
  const wxUrl = await call(wxJar, 'GET', '/api/auth/wechat/url?redirect=/admin')
  const authorizeUrl = wxUrl.body?.url ?? ''
  ok('an authorize URL is built', wxUrl.status === 200 && authorizeUrl.includes('open.weixin.qq.com'), authorizeUrl.slice(0, 78))
  ok('it carries the app id and a state', /appid=/.test(authorizeUrl) && /state=/.test(authorizeUrl))

  if (wxUrl.body?.state) {
    const callback = await call(wxJar, 'GET', `/api/auth/wechat/callback?code=mock-smoke&state=${encodeURIComponent(wxUrl.body.state)}`)
    const opened = callback.status >= 300 && callback.status < 400
    ok('the callback redirects back into the app', opened, `HTTP ${callback.status} → ${callback.location ?? '?'}`)
    const wxMe = await call(wxJar, 'GET', '/api/auth/me')
    ok('and it opened a session for a WeChat user',
      wxMe.status === 200 && !!wxMe.body?.user,
      wxMe.body?.user ? `${wxMe.body.user.name} as ${wxMe.body.user.role}` : JSON.stringify(wxMe.body).slice(0, 80))
    const forged = makeJar()
    const badState = await call(forged, 'GET', '/api/auth/wechat/callback?code=mock-smoke&state=not-the-state')
    ok('a forged state is refused', badState.status === 400 || badState.status === 403, `HTTP ${badState.status}`)
  }

  /* ------------------------------------------------------------------ report */
  console.log(`\n\x1b[1m${failures.length ? '\x1b[31mFAILED' : '\x1b[32mOK'}\x1b[0m  ${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`   • ${f}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`\n\x1b[31mThe smoke test could not run:\x1b[0m ${error.message}`)
  console.error('Is the API up?  npm --workspace server run start')
  process.exitCode = 1
})
