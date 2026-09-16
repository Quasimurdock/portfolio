# 适配 Deno 技术栈 — 已完成

> 分支：`feat/nks-version`（基线 `main`）
> 状态：**迁移完成；SQLite 与 Postgres 双引擎各自 38/38 冒烟测试通过**（Deno 2.6.7）
> 目标：让同一套代码既能本地/自托管跑 SQLite，也能部署到 **Deno Deploy**（Postgres）

---

## 1. 结论摘要

核心思路是**一次异步化 + 驱动抽象**：数据层全部改成 async，引擎差异全部收进驱动，
于是同一套路由代码在两个引擎上都能跑。

| | 之前 | 现在 |
|---|---|---|
| 运行时 | Node ≥ 20.11 | **Deno ≥ 2.2**（推荐）或 Node ≥ 22.5 |
| 数据库驱动 | `better-sqlite3`（原生 C++ 插件，仅同步） | `node:sqlite`（内置）/ `pg`，由 `DB_DRIVER` 切换 |
| 数据层 API | 同步 `all/get/run/tx` | **异步** `all/get/run/tx` + `insertReturningId` |
| SQLite 支持 | 文件数据库 | 文件数据库（本地/自托管） |
| Postgres 支持 | ❌ | ✅（Deno Deploy 必需） |
| 原生插件编译 | 需要 | **不再需要** |

**关键收益**：`better-sqlite3` 这个原生插件彻底去掉了。`node:sqlite` 是 Deno 与
Node 都内置的模块，所以 `npm install` 不再需要编译工具链；同时因为两个引擎的
SQLite 驱动都是**同步**的，本地开发路径上 140 处查询的语义完全没变。

---

## 2. 改动清单

### 2.1 新增

| 文件 | 作用 |
|---|---|
| `server/src/db.js` | 数据层门面（重写）。按 `DB_DRIVER` 惰性加载驱动，导出统一的 async API |
| `server/src/drivers/sqlite.js` | `node:sqlite` 驱动：本地开发、测试、自托管 |
| `server/src/drivers/postgres.js` | `pg` 驱动：Deno Deploy；含 `?` → `$n` 转换 |
| `server/src/schema.postgres.sql` | Postgres 版 DDL |
| `server/deno.json` | Deno 任务（`dev` / `start` / `seed` / `reset` / `cli`） |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `server/src/config.js` | 新增 `dbDriver`、`databaseUrl`、`dbAutoSchema`、`pgPoolMax`、`pgSsl` |
| `server/src/auth.js` | 加 `node:buffer` 的 `Buffer` import；`currentUser` / `createSession` / `revoke*` / `pruneExpiredSessions` 改 async |
| `server/src/oss.js` | 加 `node:buffer` 的 `Buffer` import |
| `server/src/audit.js` | `record()` 改 async |
| `server/src/middleware.js` | `attachUser` 改 async |
| `server/src/routes/_shared.js` | `requireSection` / `requireImage` / `uniqueSlug` 改 async |
| `server/src/index.js` | `start()` 改 async；用 `import.meta.main` 判断是否直接运行 |
| `server/src/routes/*.js`（13 个） | 全部 `await` 化 + 方言中立化；局部 helper 一并改 async |
| `server/src/routes/uploads.js` | 补 `await record(...)`（`record` 变 async 后这里漏了） |
| `server/src/seed.js`、`cli.js` | 全部 `await` 化；`tx(seedEverything)` 改 async；`forEach` 改 `for…of` |
| `server/package.json` | 移除 `better-sqlite3`，加 `pg` 与 `@types/pg`；脚本改为 Deno 优先（保留 `*:node` 回退） |
| `server/.env.example`、`deploy/.env.example` | 文档化 `DB_DRIVER` 及 Postgres 相关变量 |

### 2.3 规模

```
DB 调用点      140 处 / 17 个文件（不含 Express 路由注册的 87 处）
tx()           真实调用点 2 处：seed.js、routes/images.js
insertReturningId  取代了原先唯一的 lastId()（routes/auth.js）
```

---

## 3. 数据层架构

```
server/src/db.js                  ← 门面：选驱动 + 统一 async API
server/src/drivers/sqlite.js      ← node:sqlite（本地 / 自托管）
server/src/drivers/postgres.js    ← pg（Deno Deploy）
```

```js
await initDb()
await all(sql, params)              // 全部行
await get(sql, params)              // 第一行或 undefined
await run(sql, params)              // { changes, lastInsertRowid }
await insertReturningId(sql, params)// 新行 id（SQLite 用 last_insert_rowid，PG 用 RETURNING id）
await tx(async () => { … })         // 事务，内部查询自动加入
await resetDatabase()               // 开发/测试：清库重建
isUniqueViolation(error)            // 两引擎通用的唯一键冲突判断
```

**`?` 是项目统一的占位符写法**，Postgres 驱动负责改写成 `$1..$n`。
所有方言差异都住在驱动里，路由层永远不需要知道底下是哪个引擎。

### 3.1 两个必须知道的实现细节

**① 事务内不要用 `forEach`。**
`tx()` 的回调是 `async` 的，`Array.prototype.forEach` **不会等待** 异步回调 ——
写在里面的 `await run(...)` 会跑到事务外面去（SQLite 上静默丢数据，PG 上直接不生效）。
正确写法：

```js
// 错：await 不会被执行顺序等待
await tx(async () => { ids.forEach(async (id) => { await run(...) }) })

// 对
await tx(async () => {
  for (const [index, id] of ids.entries()) { await run(...) }
})
```

`routes/images.js` 的重排序事务已按后者改写。

**② SQLite 驱动的并发保护。**
`node:sqlite` 只有一个连接。一个会 `await` 的事务，中途可能被别的请求插入语句，
那些语句会**静默变成该事务的一部分**。`drivers/sqlite.js` 用两道闸门防这件事：
一个互斥锁保证事务串行，一个 gate 让无关语句在事务提交前排队。
Postgres 用连接池，天然没有这个问题。

**③ `COUNT(*)` 在 Postgres 上返回字符串。**
`node-postgres` 把 `int8` 当字符串返回（防止超出安全整数）。本 schema 里唯一会
变成 `int8` 的就是 `COUNT(*)`，而列表接口一直把 `total` 当数字输出，所以在
`drivers/postgres.js` 里统一注册了 `pg.types.setTypeParser(20, Number)` ——
而不是在 5 个路由里各补一个 `Number(total)`（那种做法漏一个就会让
Postgres 上的 JSON 形状和 SQLite 不一致）。

**④ `resetDatabase()` 必须能自己打开连接，不能要求先 `initDb()`。**
`seed.js` 的流程是"`--reset` 时先 reset，再 seed"，**不会先调 `initDb()`**。
旧的 `db.js` 在模块加载时就建好了连接（`export const db = new Database(...)`），
所以那样一直能跑。两个驱动因此都提供一个幂等的 `open()`：`reset()` 和所有查询
都不要求先初始化。**改驱动时别把这个便利收掉** —— 否则 `deno task reset` 会在
第一步就崩，而且只有真跑到 reset 才会暴露（本次迁移就踩了一次）。

---

## 4. SQL 方言中立化

同一份 SQL 要能在两个引擎上都跑，以下改写已全量应用：

| SQLite 写法 | 改写为 | 原因 |
|---|---|---|
| `col LIKE ?` | `lower(col) LIKE lower(?)` | SQLite 的 `LIKE` 对 ASCII **不区分**大小写，Postgres **区分** |
| `WHERE x = ? COLLATE NOCASE` | `WHERE lower(x) = lower(?)` | Postgres 没有 `COLLATE NOCASE` |
| `INSERT OR IGNORE INTO …` | `INSERT INTO … ON CONFLICT DO NOTHING` | SQLite 专有语法 |
| `SELECT last_insert_rowid()` | `insertReturningId()` → `RETURNING id` | Postgres 无此函数 |
| `error.message.includes('UNIQUE')` | `isUniqueViolation(error)` | 两边报错文案不同（见下） |
| `LIMIT ? OFFSET ?` | 不变 | 两边都支持 ✅ |
| `ON CONFLICT(key) DO UPDATE SET …` | 不变 | 两边语法一致、`EXCLUDED` 通用 ✅ |
| `TEXT` + ISO 时间戳字符串 | **保持不变** | 改成 `timestamptz` 会让全项目的比较/排序/`published_at` 断言都要重验，收益远小于风险 |

**唯一键冲突的坑**：SQLite 报 `UNIQUE constraint failed`，Postgres 报
`duplicate key value violates unique constraint`（SQLSTATE `23505`）。
原先 `images.js` 靠匹配错误文案判断，在 Postgres 上会**永远不命中** ——
重复 URL 本应返回 409，实际会变成 500。现在统一走 `isUniqueViolation()`。

---

## 5. 运行要求

| 运行时 | 版本 | 说明 |
|---|---|---|
| **Deno** | **≥ 2.2** | 推荐。`node:sqlite` 自 2.2 起内置，无需 flag |
| Node | ≥ 22.5 | 回退路径（`npm run dev:server:node`）。20.x **没有** `node:sqlite` |

> 本机是 Node 20.18.1 + Deno 2.6.7：Node 会报 `ERR_UNKNOWN_BUILTIN_MODULE`，
> 所以 `server/package.json` 的脚本已改为 **Deno 优先**，并保留 `*:node` 变体。

```bash
# 本地开发（SQLite，无需任何数据库服务）
npm run seed          # = deno run --allow-all server/src/seed.js
npm run dev           # API :8787 + web :5173

# 或者用 Deno 任务（在 server/ 目录下）
cd server && deno task seed && deno task dev
```

---

## 6. 部署到 Deno Deploy

### 6.1 前置：三个必须知道的约束

**① 数据库必须是 Postgres。**
Deno Deploy 官方文档：每个实例"彼此完全隔离，**不共享 CPU、内存或磁盘资源**"，
应用不常驻（空闲 5 秒~10 分钟停止），且**随时可能被驱逐**。
所以文件型 SQLite 在那里**不能承载真实数据**：A 实例写入的文件 B 实例看不见，
实例重启即回到镜像初始状态。

官方指定的数据库只有 **PostgreSQL** 和 **Deno KV** 两种。
选 Postgres 而非 KV，是因为本项目的 12 张表有大量 JOIN，归属隔离直接写在 SQL 里
（`ownershipClause`），RBAC 是三表矩阵 —— KV 没有 JOIN，等于把所有查询改成应用层拼接。

> 注意：**一个 app 只能挂一个数据库实例**，不能同时挂 KV 和 Postgres。
> 另外挂外部 Postgres 时官方**提供不了 Deno Deploy 的出口 IP 列表**，
> 数据库必须允许任意 IP 连接（靠强密码 + TLS 兜）。介意就用它代开的 Prisma Postgres
> （注意 "claim" 是**不可逆**操作）。

> **别忘了把库「挂到 app 上」。** 只在组织里创建/链接实例还不够，还得在
> app settings → Databases → Attach Database 里指派给这个 app，否则平台不会注入
> `DATABASE_URL` / `PGHOST`。这个症状很好认：启动日志里出现
> **`connect ECONNREFUSED 127.0.0.1:5432`** —— 那是 `pg` 在**完全没有连接信息**时的
> 默认值（localhost + 5432），不是你的库不可达。
> 现在 `drivers/postgres.js` 会对这种情况直接报出「没有连接信息、请挂库」，
> 而不是让人对着 localhost 发懵。

**② 这是 monorepo，必须把 App directory 设成「仓库根」。** ⚠️

> 早先的 `getting_started` 页面写着 "Mono-repos … are not yet supported"，
> 但**更新的** Builds 参考文档已经给出正式支持：
> "**App directory**: The directory within the repository to use as the application root.
> **Useful for monorepos.** Defaults to the repository root."
> 而且 `deno deploy create` 的向导里也有这一步：
> "App directory - Pick the directory within your project (**auto-detects workspace members**)",
> 所以它在 UI 里会把 `web` / `server` 两个 workspace 成员列出来让你选。

**不要选 `Web/`，也不要选 `Server/`，用仓库根。** 三个硬理由：

1. **构建命令只存在于根。** `npm run build` 定义在根 `package.json`；
   `server/package.json` **没有 `build` 脚本**。App directory 选 `Server` 的话，
   默认 Build 命令 `npm run build` 会直接失败。
2. **站点产物在 API 的隔壁。** `web/dist` 与 `server/` 平级；
   `server/src/index.js` 用 `path.resolve(SERVER_ROOT, '../web/dist')` 找它
   （`SERVER_ROOT` 由 `import.meta.url` 算出，与 cwd 无关）。
   App directory = `Server` 时 `../web/dist` 落在应用根**之外**，产物里不会包含它 →
   前端整站 404，只剩 API。
3. **前端硬编码同源 `/api`。** `web/src/api/client.ts` 里 `const BASE = '/api'`
   （`env.d.ts` 里的 `VITE_API_TARGET` 只是 Vite dev server 的反代目标，不是运行时
   API base 的覆盖项）。只有「API + 站点同进程同源」这一种部署，
   `SameSite=Lax` 的会话 cookie 才成立。选 `Web` 就是纯静态站 + 没有 API。

UI 里 App directory 的默认值就是仓库根，**留空即可**；若向导强制你从
`web` / `server` 里挑一个，挑任意一个先把 app 建出来，然后到
App Settings → App Config → Edit 把 App directory 改回空/`.`，并把
Entrypoint 设为 `server/src/index.js`。

**③ 没有 shell。** `server/src/cli.js` 在 Deploy 上跑不了；`seed` 也一样。

### 6.2 控制台里怎么填

| 配置项 | 值 |
|---|---|
| **App directory** | **留空 = 仓库根**（不要选 `web` / `server`，理由见 §6.1 ②） |
| Framework preset | `No Preset`（没有 vue-express 这种预设；别让它猜成 Vite 静态站） |
| Install command | `npm install` |
| Build command | `npm run build`（根脚本 → `web/dist`） |
| Runtime configuration | **`Dynamic`**（不是 Static） |
| ├ Entrypoint | `server/src/index.js` |
| ├ Arguments | 留空 |
| └ Runtime working directory | 留空（`config.js` 用 `import.meta.url` 定位 `server/`，不依赖 cwd） |
| Static Directory | 留空 —— 那是 Static 模式才用的。站点由 Express 自己托管 `web/dist`，这样站点与 API 同源，`SameSite=Lax` 的会话 cookie 才成立 |
| Pre-Deploy Command | `deno run --allow-all server/src/bootstrap.js` —— 幂等，每次部署都安全：空库才灌**结构**（roles / permissions / role_permissions / sections，约 100 条语句），然后按环境变量保证有一个能登录的账号。**默认不灌演示内容** —— 那约 2000 次往返，会撞 5 分钟构建超时（§6.3.2） |
| Build timeout | 默认 5 分钟；`npm install`（走镜像）+ `vite build` 有可能不够，超时再调 |

> `.npmrc` 把 registry 钉在 `registry.npmmirror.com`（见文件里的注释：这台机器连不上
> npmjs.org）。镜像是公网 CDN，Deploy 的构建机也能拉，只是比 npmjs 慢。
> 如果 Install 阶段卡住/超时，把 Install command 临时改成
> `npm install --registry=https://registry.npmjs.org/`（构建机在海外，不受本机网络限制）。

环境变量（Production 与 Development 两个 context 都设）：

```
NODE_ENV=production
DB_DRIVER=postgres
# DATABASE_URL 不要手填 —— 在 Databases 里挂库后由平台自动注入
# （连同 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）
COOKIE_SECRET=<openssl rand -base64 48>      # 标记为 secret
AUTH_DEV=0
HTTPS=1

# 微信：留空 WECHAT_APP_ID 时 mock 自动开启，所以新部署开箱即用。
# 千万不要设 WECHAT_MOCK=0 —— 见 README 的说明。
WECHAT_APP_ID=
WECHAT_APP_SECRET=

OSS_PROVIDER=mock
# 正式环境改成 aliyun 并填 key，同时把 admin 源站加进 bucket 的 CORS 规则
```

> **context 一定要选对。** 这些变量要设在 **Production**（预览环境再设 Development）。
> 如果 pre-deploy 命令读不到它们，`bootstrap.js` 就会退回默认的 `sqlite` —— 那会把数据
> 写进构建容器里一个随即被丢弃的文件：构建**成功**、日志看着正常，但线上库仍然是空的，
> 表现就是「站点没内容 + 登录 401」，而且日志里没有任何线索。
> 所以现在 `bootstrap.js` 一旦发现 `DENO_DEPLOY=true` 却没有 `DB_DRIVER=postgres` 就
> **直接让构建失败**；运行时（`index.js`）也会打一条显眼的警告兜底。
> 拿不准就给 Production / Development / Build 三个 context 都设上。

> **监听方式：Deploy 上必须由 `Deno.serve()` 监听（端口是其中的一小半）。** 两条都是
> 实测踩出来的，症状一样：应用日志一切健康，Warm up 探到 **4m4x 秒**超时。
>
> 1. 平台**不会**注入 `PORT`。首次实测打得是 `listening on http://localhost:8787`（本地默认值）。
>    所以 `config.js` 现在是 `int('PORT', onDenoDeploy ? 8000 : 8787)`：`PORT` 有值就听它的
>    （平台哪天开始注入也自动生效），Deploy 上退回 8000，本地与自托管仍是 8787 ——
>    Caddyfile、systemd unit、healthcheck 都不用动。
> 2. 更隐蔽的那一半：**只有 `Deno.serve()` 起的监听会被平台接线**。平台把入站流量与 Warm up
>    探针交给注入的 `DENO_SERVE_ADDRESS`（unix socket / vsock / tunnel），再由 control socket
>    通知平台「Serving」。Express 的 `app.listen()` 走 `node:http`，在新运行时上是一个沙箱内部
>    的原生 TCP 监听 —— 平台探不到，于是端口改对了也照样超时。
>    旧版 Deploy 能用是因为那时 `node:http` 内部就是 `Deno.serve()`；运行时换成原生 socket 后
>    就不成立了（Deno 后续 PR 才陆续给 `node:http` 补上 `DENO_SERVE_ADDRESS` 与 control socket 通知）。
>
> 所以 `index.js` 在 `onDenoDeploy` 时用 `Deno.serve({ port, onListen }, createFetchHandler(app))`，
> 适配层在 `server/src/deno-serve.js`（node 风格 `(req, res)` ⇄ web `Request`/`Response`）；
> 本地与自托管仍走 `app.listen()`。**换运行时时不要删掉这个分支。**

> TLS：挂外库时 Deploy 注入的 `DATABASE_URL` 通常带 `?sslmode=require`，
> `pg-connection-string` 会据此把 `ssl` 打开（`sslmode=require` → `ssl: true`），
> 所以**不用设 `PGSSL`**。我们的驱动只在 `PGSSL` 有值时才显式覆盖 `ssl`，
> 两者不会打架。

### 6.3 首次建账号 —— 交给 Pre-Deploy Command（推荐）

Deploy 的运行时里没有 shell，所以「第一次怎么进去」只能由构建阶段解决。
把它交给 **Pre-Deploy Command**（App Settings → App Config）：

```
deno run --allow-all server/src/bootstrap.js
```

它每次部署都会跑一遍 —— 每个 timeline 各跑一次，而且拿到的是**那个 timeline
自己的库**。三步都幂等：

1. 应用 schema（幂等 DDL）
2. **只有库还是空的时候**才灌 seed。`sections` 表没有写接口，不灌的话
   `/api/public/sections` 是空的（前端导航），新建文章/合集会被
   `requireSection()` 打回 `400 Unknown section`
3. 按环境变量保证一个能登录的账号

```
DEMO_OWNER_EMAIL=demo@portfolio.test    # 想用自己邮箱就改
DEMO_OWNER_PASSWORD=<至少 8 位>          # 必填，标记为 secret
DEMO_OWNER_NAME=                        # 可选，默认取邮箱 @ 前面那段
DEMO_OWNER_ROLE=owner                   # 可选
DEMO_OWNER_RESET_PASSWORD=1             # 可选：把已存在账号的密码改回来
```

然后到 `https://<你的-app>.deno.net/admin` 用这个账号登录。

四个刻意的设计：

* **没有默认密码。** `DEMO_OWNER_PASSWORD` 不填就跳过建号，只打一行警告
  （不让构建失败）—— 和 `WECHAT_MOCK` 一样，不给「能悄悄带到生产的默认值」。
* **不打印密码。** Deploy 的构建日志是留存可查的，把密码写进去等于泄露；
  密码本来就在你手上。
* **已存在的账号不动。** 除非 `DEMO_OWNER_RESET_PASSWORD=1`，
  你在后台改过的名字/密码不会被下次部署覆盖回去。
* **空库才灌，而且默认只灌「结构」。** 结构 = roles / permissions /
  role_permissions / sections —— 这四张表就够应用跑起来（`sections` 没有写接口，
  不灌就永远建不出分区，新建文章会被 `requireSection()` 打回 400）。
  演示内容另算：它约 **2000 次往返**（894 张图，每张是一次 upsert = `SELECT` + `INSERT`），
  对本地库是瞬间，对跨区域的托管 Postgres 就是**几分钟** —— 实测 pre-deploy 跑了
  **5m36s** 被构建超时切断，日志停在
  `bootstrap: empty database — seeding the demo content`。
  * 想要演示内容：在**你笔记本上**跑一次 `deno task seed`（没有构建超时，慢慢跑完即可）。
    之后部署时 `sections` 已非空 → pre-deploy 直接跳过，全程很快。
  * 或者设 `SEED_DEMO_CONTENT=1` 让 pre-deploy 也灌（需要更长的构建超时，Pro 可到 15 分钟）。
  * 只要结构 + 你的账号其实就够用：站点导航、后台、RBAC、新建文章/合集全部正常
    —— 已验证，空库 bootstrap 之后 `POST /api/admin/articles` 返回 **201**。

> 实测：连跑三次，第一次灌 seed + 打警告，第二次建号，第三次两个步骤都跳过；
> 用 bootstrap 建的账号登录 → `200`，`/api/admin/overview`、`/roles`、`/users` 全部
> `200`，错误密码 `401`。

#### 6.3.1 不想用 Pre-Deploy：本机 CLI

等价的手工做法 —— 在**本地**对着生产库跑：

```powershell
cd D:\proj\nks\server
$env:DB_DRIVER    = 'postgres'
$env:DATABASE_URL = 'postgresql://…'    # 控制台 → Databases → 复制 production 那条

deno run --allow-all src/cli.js users   # 先看库里已经有什么
deno run --allow-all src/cli.js create --email you@example.com --name "You" --role owner
deno run --allow-all src/cli.js passwd --email you@example.com   # 改密码
```

⚠️ 一定要 **production** 那条连接串 —— branch / preview 各自是**另外的库**，
在那边建号等于建到一个没人访问的库上。

#### 6.3.2 演示账号，以及 seed 到底幂不幂等

`deno task seed` 会建 4 个账号，密码都是 README 里写的 `portfolio`：
`owner@` / `editor@` / `author@` / `viewer@portfolio.test`。
只想快速体验 RBAC 矩阵，直接拿它们登录最省事；公开部署前记得关掉：

```powershell
foreach ($e in 'owner','editor','author','viewer') {
  deno run --allow-all src/cli.js status --email "$e@portfolio.test" --set disabled
}
```

**`seed.js` 是幂等的**：每条 insert 都按自然键 upsert（email / url / slug / section key），
实测连跑两次行数完全一致（`5 roles, 21 permissions, 65 role_permissions,
12 sections, 4 users, 55 collections, 894 images, 22 articles, 12 feed items, 2 pages`）。
所以重复跑不会灌成两套。不幂等的是 `deno task reset`（`--reset` 会 **drop 所有表**），
别对着生产库用。

> 权限**不依赖** `roles` / `role_permissions` 表：`permissionsOf()` 在
> `req.user.permissions` 缺失时回退到 `server/src/permissions.js` 里那张静态矩阵，
> `owner` 更是恒等于全集。表里的行只喂管理端的角色矩阵页面
> （`GET /api/admin/roles`），所以哪怕没灌 seed，新建的 owner 也能操作全部功能。

#### 6.3.3 清场（可选）

想留下账号、角色、分区，只清掉演示内容：

```powershell
deno run --allow-all src/cli.js wipe-content --yes
```

### 6.4 自托管（不改变数据库）

只想用 Deno 跑、仍用 SQLite：把 `Dockerfile` 的基础镜像换成 `denoland/deno`、
`entrypoint` 改成 `deno task start` 即可，`deploy/Caddyfile`、systemd unit、`.env`
都不用动。`deploy/.env.example` 里 `DB_DRIVER=sqlite` 是默认值。

---

## 7. 验证情况

### 7.1 实测结果 ✅（两个引擎都跑过）

```
# ---- SQLite（默认驱动） ----
$ deno run --allow-all src/seed.js --reset
  database reset (sqlite → …\server\data\app.db) — every table dropped and recreated from the schema
  seed complete: 5 roles, 21 permissions, 65 role_permissions
    12 sections, 4 users, 55 collections, 894 images, 22 articles (22 published)
    12 feed items, 2 pages
$ deno run --allow-all src/index.js
  portfolio api listening on http://localhost:8787
  db=sqlite → …\server\data\app.db
$ node scripts/smoke.mjs
  OK  38 passed, 0 failed                            # server stderr empty

# ---- 同上，但强制走 Deploy 分支（Deno.serve + 适配层） ----
$ DENO_DEPLOY=1 PORT=8787 deno run --allow-all src/index.js
  portfolio api listening on http://localhost:8787    ← onListen 回调生效
  db=sqlite → …\server\data\app.db
  (stderr) !! DB_DRIVER is not "postgres" but DENO_DEPLOY is set: …   ← 预期的警告
$ node scripts/smoke.mjs
  OK  38 passed, 0 failed                            # 请求日志照常打印（finish 补发成功）

# ---- Postgres 15（独立临时实例，127.0.0.1:5433） ----
$ DB_DRIVER=postgres DATABASE_URL='postgresql://…@127.0.0.1:5433/portfolio' \
    deno run --allow-all src/seed.js --reset
  database reset (postgres → 127.0.0.1:5433/portfolio) — every table dropped and recreated from the schema
  seed complete: 5 roles, 21 permissions, 65 role_permissions        ← 与 SQLite 完全一致
    12 sections, 4 users, 55 collections, 894 images, 22 articles (22 published)
    12 feed items, 2 pages
$ DB_DRIVER=postgres … deno run --allow-all src/index.js
  db=postgres → 127.0.0.1:5433/portfolio
$ node scripts/smoke.mjs
  OK  38 passed, 0 failed

# 关键一步：确认写入真的落在 Postgres（而不是"碰巧通过"）
$ psql -p 5433 -d portfolio …
  users 5 | audit_logs 13 | sessions 5 | wechat users 1 | smoke images 1
  smoke image: https://cdn.example.com/uploads/smoke-1789436052723.jpg
                                          ↑ 与冒烟测试打印的 URL 完全一致
```

**为什么非要去查库确认**：两个引擎的种子数据本来就一模一样，
所以单看 `38 passed` 是分辨不出 API 到底连了哪个库的。
查库看到冒烟测试新建的用户、会话、审计日志和图片 URL 才算真的证明了。

两个引擎的 seed 计数完全相同（5 / 21 / 65 / 12 / 4 / 55 / 894 / 22 / 12 / 2）。

38 项覆盖：各角色权限差异（21/16/5/3 个权限）、作者间归属隔离（403）、
概览面板的作用域（owner 看到全站 22 篇、author 只看到自己的 11 篇，见 §7.2 第 8 条）、
`draft → review → published → archived` 流转与 `published_at` 打点、公开接口隐藏内部字段、
OSS 签名上传、图片按 URL 登记、合集/单页/概览、审计日志写入、微信 mock 登录
（含创建用户 + 开会话，即 `insertReturningId` / `RETURNING id` 路径）、伪造 state 被拒。

另外单独验证：

* 数据层：建表、`insertReturningId` 返回数字、**事务提交与回滚**、并发读不互相干扰、`resetDatabase()`
* **类型不漂移**：Postgres 上 `COUNT(*)` 经 `setTypeParser` 解析后是 `number`（不是字符串），
  identity 主键也是 `number` —— 保证列表接口的 `total` 在两个引擎上形状一致
* `cli.js`：`users` 正常列出账号，`usage` 正确显示驱动与目标库

### 7.2 过程中发现并修掉的问题

以下都是**真跑起来才暴露**的 —— 静态审查、`deno check`、`node --check` 都发现不了：

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| 1 | `resetDatabase()` 破坏原有契约 | 旧 `db.js` 在模块加载时就建好连接，所以 `seed --reset`（**不先调 `initDb()`**）一直能用；新驱动要求先初始化 → `deno task reset` 第一步就崩 | 两个驱动都提供幂等 `open()`，`reset()` 与查询都不要求先 init |
| 2 | 自己引入的命名冲突 | `tx()` 里的局部变量 `open`（Promise resolver）与新的连接函数 `open()` 重名 → `open().exec('BEGIN')` 调的是 resolver，返回 `undefined` | 局部改名 `releaseGate` / `releaseMutex` |
| 3 | `COUNT(*)` 在 Postgres 上返回字符串 | `node-postgres` 把 `int8` 当字符串返回 → 列表接口输出 `"total": "12"`，与 SQLite 形状不一致 | 驱动里统一 `pg.types.setTypeParser(20, Number)` |
| 4 | 唯一键冲突判断跨方言失效 | `images.js` 匹配错误文案 `'UNIQUE'`；Postgres 报 `duplicate key value…` → **409 永不命中**，重复 URL 变成 500 | 新增 `isUniqueViolation()`：判 SQLSTATE `23505` + 两侧文案 |
| 5 | `routes/uploads.js` 漏改 | 最初扫描正则只覆盖 `all\|get\|run\|tx\|lastId`，漏了 `record(` → 浮动 promise，其拒绝绕过错误中间件 | 补 `await record(...)` |
| 6 | `Buffer` 没有 import | Node 里是全局，**Deno 里不是** → 7 处直接 `ReferenceError` | `auth.js` / `oss.js` 各加 `import { Buffer } from 'node:buffer'` |
| 7 | 启动日志报错数据库 | 连的是 Postgres，却打印 SQLite 文件路径（无条件输出 `config.databaseFile`） | 新增 `describeTarget()`，boot 日志与 CLI 共用；顺带修掉 CLI 里同样的硬编码 |
| 8 | **概览面板不认 `*.read_all`**（`main` 上就有，**不是本次迁移引入的**） | `overview.js` 调 `ownershipClause()` 时没传 `scope`，而该函数「没传就是 `mine`」→ 全新 owner 打开后台看到**全 0**，可列表页却是 `canReadAll ? 'all' : 'mine'`，两边对不上 | 改成 `scope: req.query.scope ?? 'all'`（无权限者会被 `ownershipClause` 降级回 `mine`），并在 smoke 里补 2 条断言锁住行为 |
| 9 | **Deploy 上端口回退成 8787**（只有真实部署才暴露） | 以为平台会注入 `PORT`，实际没有：应用打印 `listening on …:8787`，Warm up **4m44s** 超时，而应用自己的日志一切正常 | `config.js` 改成 `int('PORT', onDenoDeploy ? 8000 : 8787)` —— 但**端口只是表象**，同样的超时在端口改对后依旧复现，见第 11 条 |
| 10 | **pre-deploy 命令撞构建超时**（同上，只有真实部署才暴露） | 空库时 bootstrap 灌完整演示内容 ≈ **2000 次往返**（894 张图 × upsert 的 `SELECT`+`INSERT`）：本地瞬间，跨区域托管 Postgres 上是几分钟 → pre-deploy 跑了 **5m36s** 被切断，日志停在 `seeding the demo content` | 拆出 `seedStructure()`（约 100 条语句）；`bootstrap.js` 默认只灌结构，演示内容交给 `deno task seed`（本机、无超时）或 `SEED_DEMO_CONTENT=1` |
| 11 | **`app.listen()` 在新 Deno Deploy 上不被平台接线**（同上，只有真实部署才暴露） | 端口已改 8000，应用日志照样是健康的 `listening on http://localhost:8000`，Warm up 仍在 **4m43s** 超时、build 被 5 分钟上限切断。新 Deploy 只把入站流量与探针接到 `Deno.serve()`（经注入的 `DENO_SERVE_ADDRESS` + control socket），`node:http` 的原生监听平台看不见 —— Deploy Classic 已于 2026-07-20 关停、运行时换成原生 socket，`node:http` 因此不再被接线 | 新增 `server/src/deno-serve.js`：`createFetchHandler(nodeHandler)` 把 web `Request` 适配成 node 风格 `(req, res)`，再把 Express 写出的 status / headers / chunk 收成 `Response`；`index.js` 在 `onDenoDeploy` 时改用 `Deno.serve({ port, onListen }, createFetchHandler(app))`，本地与自托管保持 `app.listen()`。**不能用 socket 序列化**：Deno 的 `ServerResponse` 不往 socket 写头（实测 `res._header` 恒为空、请求挂死），必须从 Express 自身的 `writeHead`/`setHeader`/`write`/`end` 采集；适配层还要补发一次 `finish` 事件，否则访问日志不打印 |

> 第 7 条值得单独强调：冒烟测试全绿，但只要看一眼启动日志就会以为自己在用 SQLite。
> 这种"能跑但在说谎"的问题，只有真的把进程启起来盯着日志看才会发现。

### 7.3 仍未验证 ⚠️

| 项 | 原因 |
|---|---|
| **新 Deno Deploy 上的实际部署** | 早先那次「已在真实环境跑通」（App directory = 仓库根、Entrypoint = `server/src/index.js`、Pre-Deploy = `bootstrap.js`）是 **Deploy Classic**，该平台已于 **2026-07-20 关停**。新平台需要的 `Deno.serve()` 改动（§7.2 第 11 条）已在本地用 `DENO_DEPLOY=1` + 完整 38 项冒烟验证，但**真实部署尚未复验**：需要重新构建一次，确认 Warm up 能在几秒内通过。另外仍需你确认的是**从本机连远端 Postgres 的 TLS 路径** —— 我没有连接串，只验证到 `pg-connection-string` 会认 `sslmode=require` |
| `? → $n` 转换器的边角分支 | 字符串字面量 / 注释 / `$tag$` 跳过逻辑都已实现，但本项目 SQL 没走到这些分支；JSONB 的 `?` / `?\|` 同理 |
| 增量迁移 | 仍然没有迁移脚本。Pre-Deploy Command 现在跑的是 `bootstrap.js`（空库才灌 seed + 保证账号）；**schema 变更还是靠 boot 时的幂等 DDL** |
| 外挂 Postgres 的 TLS | 本地实例走 trust 认证，`PGSSL=require` 与自签证书上传路径未验证 |

> Postgres 验证用的是**独立临时实例**：拿已安装的 PG15 二进制 `initdb` 到临时目录、
> 跑在 5433、trust 认证。**没有碰你原有的 5432 集群**，验证后已停掉并删除临时数据目录。

#### 复现这套验证

用机器上已有的 PG15 二进制起一个一次性实例 —— **不要动 5432 上的现有集群**：

```bash
initdb -D /tmp/nks-pg -U postgres -A trust -E UTF8
pg_ctl -D /tmp/nks-pg -o "-p 5433 -c listen_addresses=127.0.0.1" -l /tmp/nks-pg.log start
createdb -h 127.0.0.1 -p 5433 -U postgres portfolio

cd server
export DB_DRIVER=postgres
export DATABASE_URL='postgresql://postgres@127.0.0.1:5433/portfolio'
deno task reset                 # seed.js --reset：清空重建 + 灌数据
deno task start                 # 应打印 db=postgres → 127.0.0.1:5433/portfolio

# 另一个终端
node scripts/smoke.mjs          # 期望 38 passed, 0 failed

# 收尾
pg_ctl -D /tmp/nks-pg stop && rm -rf /tmp/nks-pg /tmp/nks-pg.log
```

Windows 上把三个命令换成 `D:\pgsql\bin\{initdb,pg_ctl,createdb}.exe` 的全路径即可。
注意 `pg_ctl start` 在把这个进程当子进程捕获输出的 shell 里会挂住，用后台方式启动更稳。

---

## 8. 已知遗留

* **并发事务串行化**：SQLite 驱动用互斥锁保证事务不交错，这是单连接引擎的正确做法，
  但意味着 SQLite 下事务是串行的。自托管场景无妨，压力大时应该用 Postgres。
* **`tx()` 回调必须是 async 且不能用 `forEach`**：这个约束只能靠注释和 review 守住，
  运行时不会报错。已在 `db.js` 的 JSDoc 与本节反复写明。
* **时间戳仍是 `TEXT`**：有意为之，见 §4。
* **冷启动时跑 DDL**：`initSchema` 在 boot 时应用幂等 DDL（12 张表 + 索引 + 补外键的
  `DO $$` 块）。对本地库开销很小，但在 Deploy 上每次冷启动都要为它走一遍跨区域往返。
  想让 Pre-Deploy Command 独占 schema 的话，**现在还不能直接设 `DB_AUTO_SCHEMA=0`** ——
  `bootstrap.js` 也是靠 `initDb()` 建表的，关掉它连表都建不出来（pre-deploy 会失败）。
  要关就得先给 `db.js` 加一个无条件建表的 `ensureSchema()`，让 bootstrap 改用它。
* **`isUniqueViolation()` 是文案 + SQLSTATE 双重判断**：如果将来换驱动，需要复核。
