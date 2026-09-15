# Portfolio

A photographic portfolio and the studio back office that publishes it: two deployables, one repo.

```
web/      Vite + Vue 3 + TypeScript  — the public site and /admin in one SPA
server/   Deno + Express             — JSON API, sessions, RBAC, OSS signing, WeChat login
          SQLite locally, Postgres on Deno Deploy (docs/DENO-PORT.md)
legacy/   the original single-file build, kept for reference
docs/     API.md — data model and HTTP contract (read this first)
```

## Quick start

The API runs on **Deno >= 2.2** — which is what the npm scripts below use — or on
Node >= 22.5. Node 20 will not work: the `node:sqlite` module it depends on only
exists from Node 22.5, so there is no native addon to compile any more but the
runtime floor moved up.

```bash
npm install          # installs both workspaces
npm run seed         # creates server/data/app.db and fills it with the demo content
npm run dev          # API on :8787, web on :5173 (Vite proxies /api)
```

Run the equivalent through Deno directly with `cd server && deno task seed && deno task dev`.

Switching the database is a `DB_DRIVER` change, not a code change — SQLite for local
development and self-hosting, Postgres for Deno Deploy. See
**[docs/DENO-PORT.md](docs/DENO-PORT.md)** for what that involves and why.

Open <http://localhost:5173> for the site and <http://localhost:5173/admin> for the back office.

### Seeded accounts

Password for all of them: `portfolio`

| email | role | what they can do |
|---|---|---|
| `owner@portfolio.test` | owner | everything, including assigning roles |
| `editor@portfolio.test` | editor | write **and publish** any content, manage people |
| `author@portfolio.test` | author | create/edit **only their own** drafts, submit for review |
| `viewer@portfolio.test` | viewer | read-only across all content |

There are two author accounts (`author@` and `editor@`) with content each, so ownership isolation is visible the
moment you sign in as the author: the editor's rows are gone from every list, and asking for one by id returns
`403`.

`AUTH_DEV=1` (the default in dev) also enables password-less sign-in as any seeded account from the login screen —
handy while there is no WeChat app to point at.

## Design decisions worth knowing

**The server never stores image bytes.** An image row is a URL plus metadata (`width`, `height`, `bytes`,
`format`, `oss_key`). `POST /api/uploads/sign` hands the browser a signed policy so it can POST straight to OSS;
set `OSS_PROVIDER=mock` to exercise the whole admin flow with no credentials. Swapping in aliyun/S3 is one module.

**Content is owned, not shared.** Every content row has `author_id`. Lists default to `scope=mine`, and any attempt
to read or mutate someone else's row is refused unless the caller holds the matching `*.read_all` / `*.delete`
permission. That check lives in one middleware plus one SQL helper, not scattered through the routes.

**Permissions are rows, not conditionals.** `roles`, `permissions` and `role_permissions` are tables; the API
returns the caller's *effective* permission keys, and the UI's `can()` just asks that list. Changing what an editor
may do is a database change, not a deploy.

**One status vocabulary** — `draft → review → published → archived` — across articles, collections, images, feed
slides and pages, so the overview screen can count "what is published" uniformly. `published_at` is stamped on the
first transition into `published`.

**Public payloads are separate.** `/api/public/*` only ever returns published rows and never exposes `author_id`,
`status`, or anything else internal. The admin and the public site share tables, not responses.

## Data model in one glance

`users` · `sessions` · `roles` · `permissions` · `role_permissions` · `sections` · `collections` · `images` ·
`articles` · `feed_items` · `pages` · `audit_logs`

Full column list: `server/src/schema.sql`. Endpoints and payloads: `docs/API.md`.

Sections drive the public navigation, and each section declares how it renders — `feed` (the home slideshow),
`grid` (collection covers), `list` (articles), `article` and `contact` (single pages). Adding a section is a row.

## Front end notes

* **Composables over directives where it pays.** `useLazyImage` wraps vueuse's `useIntersectionObserver` (800px
  margin, one retry, then a generated SVG plate so a slow CDN never collapses the layout); `useSlider` rebuilds the
  three-slide finger-following pager on `useSwipe` + `usePreferredReducedMotion`; `useQuery` keeps the previous
  value while the next loads, so navigation does not flash.
* **The public design system is CSS, lifted verbatim** from the shipped single-file page (`web/src/styles/site.css`),
  so the port is pixel-faithful. The back office has its own stylesheet and is deliberately denser.
* **No UI kit.** The admin is built from a handful of small components (table, status pill, modal, field) so the
  bundle stays small and the look stays consistent with the site.

## Environment

`server/.env.example` documents everything. The ones that matter:

```
PORT=8787                 DB_DRIVER=sqlite                  SESSION_TTL_DAYS=14
COOKIE_SECRET=change-me   AUTH_DEV=1                          # disable in production
OSS_PROVIDER=mock         OSS_PUBLIC_BASE=https://cdn.example.com
WECHAT_MODE=qrconnect     WECHAT_APP_ID=                      # mock follows the app id
```

`DB_DRIVER=postgres` additionally reads `DATABASE_URL`, or the standard
`PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` variables that Deno
Deploy injects when a database is attached.

## WeChat login

`GET /api/auth/wechat/url` returns the authorize URL (网站应用 扫码登录 by default, 公众号 via `WECHAT_MODE=mp`),
the callback exchanges `code` for `openid`/`unionid`, find-or-creates the user with `WECHAT_DEFAULT_ROLE`, and
opens a session.

**Mock mode, precisely:** `WECHAT_MOCK` defaults to *on only while `WECHAT_APP_ID` is empty*. The moment a real app
id is configured the flow goes live, so it can never silently fake logins in a configured deployment. That means
when testing locally **with a placeholder app id you must also set `WECHAT_MOCK=1`** — otherwise the callback
correctly attempts a real call to `api.weixin.qq.com` and fails with `invalid appid` (HTTP 502). Verified both ways.

For local development two more things matter, both verified end to end:

* point `WECHAT_REDIRECT_URI` at the **app** origin — `http://localhost:5173/api/auth/wechat/callback`, which the
  Vite dev proxy forwards — not at the API port directly. Otherwise the `sid` cookie is scoped to `127.0.0.1`
  while the app runs on `localhost`, and the session is invisible to the SPA. In production both are one origin, so
  this only bites during development.
* WeChat itself only redirects to a domain registered in the 开放平台 console, so a real login needs a tunnel;
  mock mode exists so the whole flow is testable offline.

A WeChat account is ordinary content-wise: it is created with the configured default role, so an `author` signed in
this way can create its own drafts but still gets `403` when it tries to publish.

## Running it in production

```bash
npm run build            # web/dist — static, serve behind any web server
NODE_ENV=production COOKIE_SECRET=… AUTH_DEV=0 deno run --allow-all server/src/index.js
```

Terminate TLS in front of both, mount them on one origin (`/` → `dist`, `/api` → the app process) so the
`HttpOnly; SameSite=Lax` session cookie stays same-site. For direct-to-OSS uploads, allow the admin origin in the
bucket's CORS rules.

## Deployment

One process serves both the API and the built site on one port, so the same origin carries the session cookie and
the SPA history fallback. Three commands on a VPS with Docker:

```bash
git clone <your repo> portfolio && cd portfolio
cp deploy/.env.example .env      # set DOMAIN and COOKIE_SECRET
docker compose up -d --build     # app + Caddy (automatic HTTPS)
```

Then create your own account and retire the demo ones (`deploy/.env.example` explains every setting):

```bash
docker compose exec app deno run --allow-all server/src/cli.js create --email you@example.com --name "You" --role owner
docker compose exec app deno run --allow-all server/src/cli.js status --email owner@portfolio.test --set disabled
docker compose exec app deno run --allow-net --allow-env scripts/smoke.mjs
```

Full walkthrough — bare-metal/systemd alternative, updates, backups, WeChat and OSS setup, and the known limits —
is in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Not done yet (deliberately)

* Image *variants*: `thumb_url` is stored, but generating derivatives belongs in the image pipeline, not here.
* Scheduled publishing (`published_at` is honoured, but nothing flips a row automatically).
* Article revision history — the schema has an audit log; a full diff history was out of scope.
* Rate limiting and CSRF hardening beyond `SameSite=Lax` + a signed state cookie.
