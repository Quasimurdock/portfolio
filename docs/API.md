# Portfolio — architecture, data model and API contract

Two deployables in one repo (npm workspaces):

```
server/   Node 20 + Express + better-sqlite3 (SQLite) — JSON API, sessions, RBAC, OSS signing, WeChat login
web/      Vite + Vue 3 + TypeScript — one SPA with two route trees:
            /                 the public portfolio (ported from legacy/index.html)
            /admin            the studio back office (auth-guarded, permission-driven)
legacy/   the original single-file build, kept for reference only
```

Guiding decisions:

* **The server never stores image bytes.** `images.url` holds an OSS (or any CDN) URL; the server can *sign* a
  direct browser→OSS upload but nothing else. `oss_key` / `oss_provider` are kept for de-duplication and future
  lifecycle rules.
* **Content is owned.** Every content row carries `author_id`. Users without a `*.read_all` permission only ever
  see and touch their own rows (enforced in SQL, not in the UI).
* **Permissions are data**, not `if (role === 'admin')`. Roles map to permission keys in the database, and the API
  exposes the caller's effective permission list to the client.
* **Everything publishable shares one status vocabulary**: `draft → review → published → archived`.

---

## 1. Data model (server/src/schema.sql)

| table | purpose | notable columns |
|---|---|---|
| `users` | accounts (password and/or WeChat) | `email` UNIQUE, `password_hash` (scrypt), `role_key`, `status`, `wechat_openid` UNIQUE, `wechat_unionid`, `wechat_nickname`, `wechat_avatar` |
| `sessions` | revocable login sessions | `token_hash` PK (sha256 of the cookie value), `user_id`, `expires_at`, `user_agent`, `ip` |
| `roles` | role definitions | `key` PK, `name`, `rank`, `is_system` |
| `permissions` | permission catalogue | `key` PK, `group_key`, `description` |
| `role_permissions` | role → permission | `(role_key, permission_key)` PK |
| `sections` | the site nav / content buckets | `key` PK, `label`, `kind` (`feed`\|`grid`\|`list`\|`article`\|`contact`), `position`, `visible` |
| `collections` | portfolios, series, albums | `slug` UNIQUE, `title`, `section_key`, `kind` (`series`\|`album`), `summary`, `cover_image_id`, `place`, `year`, `status`, `position`, `author_id`, `published_at` |
| `images` | one row per photograph | `url` NOT NULL (OSS), `thumb_url`, `width`, `height`, `bytes`, `format`, `caption`, `alt`, `oss_provider`, `oss_key`, `collection_id` (nullable), `owner_id`, `status`, `position` |
| `articles` | essays / reviews / news / exhibitions copy | `slug` UNIQUE, `title`, `section_key`, `excerpt`, `body` (markdown), `cover_image_id`, `status`, `author_id`, `published_at` |
| `feed_items` | the curated home slideshow | `image_id`, `caption`, `link_kind` (`collection`\|`article`\|`external`), `link_url`, `target_collection_id`, `target_article_id`, `position`, `status` |
| `pages` | single pages (Biography, Contact, …) | `slug` UNIQUE, `title`, `kind`, `body`, `data` (JSON blob for structured bits), `status` |
| `audit_logs` | who changed what | `user_id`, `action`, `entity`, `entity_id`, `meta` (JSON), `created_at` |

Indexes: `articles(section_key,status,position)`, `collections(section_key,status,position)`,
`images(collection_id,position)`, `images(owner_id)`, `feed_items(status,position)`,
`sessions(user_id)`, `audit_logs(created_at)`.

Status vocabulary everywhere: `draft` \| `review` \| `published` \| `archived`.
`published_at` is set the first time a row enters `published` (and cleared only if it returns to `draft`).

SQLite pragmas: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.

---

## 2. Permissions and roles (server/src/permissions.js)

Permission keys (grouped):

```
content.article.read_all      content.article.write      content.article.publish   content.article.delete
content.collection.read_all   content.collection.write   content.collection.publish content.collection.delete
content.image.read_all        content.image.write        content.image.delete
content.page.write            content.page.publish
content.feed.manage
media.upload                  (sign a direct-to-OSS upload)
user.read   user.invite   user.update   user.disable   role.assign
settings.manage
```

Role defaults (`owner` is `is_system` and always gets every permission at read time):

| permission | owner | admin | editor | author | viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `content.article.read_all` | ✅ | ✅ | ✅ | – | ✅ |
| `content.article.write` | ✅ | ✅ | ✅ | ✅ | – |
| `content.article.publish` | ✅ | ✅ | ✅ | – | – |
| `content.article.delete` | ✅ | ✅ | ✅ | – | – |
| `content.collection.read_all` | ✅ | ✅ | ✅ | – | ✅ |
| `content.collection.write` | ✅ | ✅ | ✅ | ✅ | – |
| `content.collection.publish` | ✅ | ✅ | ✅ | – | – |
| `content.collection.delete` | ✅ | ✅ | ✅ | – | – |
| `content.image.read_all` | ✅ | ✅ | ✅ | – | ✅ |
| `content.image.write` | ✅ | ✅ | ✅ | ✅ | – |
| `content.image.delete` | ✅ | ✅ | ✅ | ✅ | – |
| `content.page.write` / `.publish` | ✅ | ✅ | ✅ | – | – |
| `content.feed.manage` | ✅ | ✅ | ✅ | – | – |
| `media.upload` | ✅ | ✅ | ✅ | ✅ | – |
| `user.read` | ✅ | ✅ | ✅ | – | – |
| `user.invite` / `user.update` / `user.disable` | ✅ | ✅ | – | – | – |
| `role.assign` | ✅ | – | – | – | – |
| `settings.manage` | ✅ | ✅ | – | – | – |

Ownership rule (enforced by one middleware + one SQL helper):

* `author_id = me` → always allowed to read/update/delete own rows.
* otherwise the matching `*.read_all` (for reads) or `*.delete`/`*.publish` (for mutations) must be present.
* list endpoints default to `scope=mine`; `scope=all` is silently downgraded to `mine` without `*.read_all`.

`author` is therefore the natural "multi-tenant" role: it can create and edit its own drafts and submits them to
`review`; an `editor`/`admin` publishes them.

---

## 3. HTTP contract

* Base URL `/api`. JSON in, JSON out. Cookies: `sid` — `HttpOnly; SameSite=Lax; Path=/` (`Secure` when `HTTPS=1`).
* Error shape: `{ "error": { "code": "forbidden", "message": "…", "details"?: … } }` with 400/401/403/404/409/500.
* Lists return `{ items: [...], total: n, page: p, pageSize: s }`.
* `PATCH` accepts partial bodies. Unknown fields are ignored (validated with zod, `.strict()` off).
* Timestamps are ISO-8601 UTC strings. Ids are integers.

### 3.1 Auth

| method | path | body / query | returns |
|---|---|---|---|
| `POST` | `/api/auth/login` | `{email, password}` | `{user, permissions}` + `Set-Cookie: sid` |
| `POST` | `/api/auth/logout` | – | `{ok:true}` + clears cookie |
| `GET` | `/api/auth/me` | – | `{user, permissions}` (401 when anonymous) |
| `GET` | `/api/auth/wechat/url` | `?redirect=/admin` | `{url, state}` — the authorize URL to open |
| `GET` | `/api/auth/wechat/callback` | `?code&state` | 302 to the app (`/admin`) + `Set-Cookie: sid` |
| `POST` | `/api/auth/dev-login` | `{email}` | dev only (`AUTH_DEV=1`): session without a password |

`user` = `{id, email, name, avatarUrl, role, status, createdAt, lastLoginAt}`.
`permissions` = `string[]` of effective permission keys.

### 3.2 Admin (all require a session; permission shown per row)

| method | path | permission | notes |
|---|---|---|---|
| `GET` | `/api/admin/overview` | any authenticated | counts by type × status, my drafts, recent audit entries |
| `GET` | `/api/admin/articles` | – (scoped) | `?status=&section=&q=&scope=mine\|all&page=&pageSize=` |
| `POST` | `/api/admin/articles` | `content.article.write` | |
| `GET` | `/api/admin/articles/:id` | – (scoped) | |
| `PATCH` | `/api/admin/articles/:id` | `content.article.write` | |
| `POST` | `/api/admin/articles/:id/status` | `content.article.publish` for publish/archive, else write | `{status}` |
| `DELETE` | `/api/admin/articles/:id` | `content.article.delete` | |
| `GET/POST` | `/api/admin/collections` | `content.collection.write` for POST | `?status=&section=&scope=` |
| `GET/PATCH/DELETE` | `/api/admin/collections/:id` | scoped / `content.collection.write` / `.delete` | |
| `POST` | `/api/admin/collections/:id/status` | as articles | `{status}` |
| `GET/POST` | `/api/admin/images` | `content.image.write` for POST | `?collectionId=&status=&q=&scope=` |
| `GET/PATCH/DELETE` | `/api/admin/images/:id` | scoped / write / `content.image.delete` | |
| `POST` | `/api/admin/images/reorder` | `content.image.write` | `{collectionId, ids:[…]}` |
| `GET/POST` | `/api/admin/feed-items` | `content.feed.manage` | |
| `PATCH/DELETE` | `/api/admin/feed-items/:id` | `content.feed.manage` | |
| `GET` | `/api/admin/pages` | any authenticated | |
| `GET/PATCH` | `/api/admin/pages/:slug` | `content.page.write` for PATCH | |
| `GET` | `/api/admin/users` | `user.read` | `?q=&role=&status=` |
| `POST` | `/api/admin/users` | `user.invite` | `{email, name, role}` → returns a one-time `inviteToken` |
| `PATCH` | `/api/admin/users/:id` | `user.update` (role change also needs `role.assign`) | `{name?, role?, status?}` |
| `GET` | `/api/admin/roles` | `user.read` | `{roles:[{key,name,rank,permissions:[…]}], permissions:[…]}` |
| `GET` | `/api/admin/audit` | `user.read` | `?limit=` |
| `POST` | `/api/uploads/sign` | `media.upload` | see §3.4 |

`POST /api/admin/*/status` accepts `{status}` ∈ the vocabulary and records an audit row.

### 3.3 Public (no auth, published rows only)

| method | path | returns |
|---|---|---|
| `GET` | `/api/public/nav` | `[{key,label,kind,position}]` visible sections |
| `GET` | `/api/public/feed` | `[{id,caption,image:{url,thumbUrl,width,height},link:{kind,href}}]` |
| `GET` | `/api/public/sections/:key` | section + `collections` (grid) or `articles` (list) |
| `GET` | `/api/public/collections/:slug` | collection + `images` (ordered) |
| `GET` | `/api/public/articles/:slug` | article |
| `GET` | `/api/public/pages/:slug` | page |

Public payloads never expose `author_id`, `status`, `password_hash`, or draft rows.

### 3.4 OSS signing — `POST /api/uploads/sign`

Request `{filename, contentType, size}` → response

```json
{ "provider": "aliyun", "key": "uploads/2026/03/uuid.jpg", "publicUrl": "https://cdn.example.com/uploads/…",
  "upload": { "url": "https://bucket.oss-cn-hangzhou.aliyuncs.com", "method": "POST",
              "fields": { "key": "…", "OSSAccessKeyId": "…", "policy": "…", "signature": "…" } },
  "maxBytes": 26214400 }
```

`OSS_PROVIDER=mock` (the default in dev) returns `upload.url = "/api/uploads/mock"` and
`publicUrl = "https://cdn.example.com/uploads/<key>"` so the admin UI can be exercised without credentials.
The browser posts the form fields and the file straight to OSS — **no bytes touch this server**.

### 3.5 WeChat login

`GET /api/auth/wechat/url` builds, from `WECHAT_APP_ID` / `WECHAT_REDIRECT_URI`:

* `WECHAT_MODE=qrconnect` (网站应用, default) → `https://open.weixin.qq.com/connect/qrconnect?appid=…&redirect_uri=…&response_type=code&scope=snsapi_login&state=…#wechat_redirect`
* `WECHAT_MODE=mp` (公众号) → `https://open.weixin.qq.com/connect/oauth2/authorize?…&scope=snsapi_userinfo…#wechat_redirect`

`state` is a random value stored in a short-lived `wx_state` cookie; `GET /api/auth/wechat/callback` verifies it
(constant-time), then:

1. `GET https://api.weixin.qq.com/sns/oauth2/access_token?appid&secret&code&grant_type=authorization_code` → `{access_token, openid, unionid?}`
2. `GET https://api.weixin.qq.com/sns/userinfo?access_token&openid&lang=zh_CN` → `{nickname, headimgurl, unionid?}`
3. find a user by `wechat_unionid` (fallback `wechat_openid`) → else by verified email → else create one with
   `role_key = WECHAT_DEFAULT_ROLE` (`author`), status `active`, `password_hash = NULL`.
4. create a session, clear `wx_state`, `302` to `WECHAT_SUCCESS_REDIRECT` (default `/admin`).

`WECHAT_MOCK=1` short-circuits steps 1–2 with a deterministic fake profile (`mock-openid-<code>`) so the whole
flow is testable offline. WeChat only redirects to a domain registered in the 开放平台 console, so local testing
needs a tunnel (or mock mode).

---

## 4. Environment (server/.env.example)

```
PORT=8787
DATABASE_FILE=./data/app.db
SESSION_TTL_DAYS=14
COOKIE_SECRET=change-me            # signs the sid + wx_state cookies
AUTH_DEV=1                         # enables POST /api/auth/dev-login (never in production)
OSS_PROVIDER=mock                  # mock | aliyun
OSS_BUCKET=portfolio
OSS_REGION=oss-cn-hangzhou
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_PUBLIC_BASE=https://cdn.example.com
WECHAT_MODE=qrconnect              # qrconnect | mp
WECHAT_MOCK=1
WECHAT_APP_ID=
WECHAT_APP_SECRET=
WECHAT_REDIRECT_URI=http://localhost:8787/api/auth/wechat/callback
WECHAT_SUCCESS_REDIRECT=/admin
WECHAT_DEFAULT_ROLE=author
```

## 5. Seeded accounts

`npm run seed` creates roles + permissions, the sections, and the content that the legacy page shipped with
(12 collections, 24 images, 8 essays, 8 exhibitions, 6 news items, 12 feed slides, Biography/Contact pages):

| email | password | role |
|---|---|---|
| `owner@portfolio.test` | `portfolio` | owner |
| `editor@portfolio.test` | `portfolio` | editor |
| `author@portfolio.test` | `portfolio` | author |
| `viewer@portfolio.test` | `portfolio` | viewer |

Two authors own content, so ownership isolation is visible immediately: sign in as `author@…` and the editor's
rows disappear from the list (and are refused by id).
