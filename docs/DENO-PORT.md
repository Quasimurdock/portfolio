# 适配 Deno 技术栈 — 已完成

> 分支：`feat/nks-version`（基线 `main`）
> 状态：**迁移完成；SQLite 与 Postgres 双引擎各自 36/36 冒烟测试通过**（Deno 2.6.7）
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

**② 这是 monorepo，而 Deno Deploy 官方声明 "Mono-repos … are not yet supported"。** ⚠️
API 在 `server/` 子目录里，自动识别会失败。但构建配置里可以手工指定
**Dynamic Entrypoint**（"path relative to the working directory"）、
Install / Build 命令与 Static Directory，所以走手工配置应该可行。
如果 Deploy 坚持要求入口在仓库根，退路是在根目录放一个只有几行的入口文件
转发到 `server/src/index.js`，或者把 API 拆成独立仓库。

**③ 没有 shell。** `server/src/cli.js` 在 Deploy 上跑不了；`seed` 也一样。

### 6.2 建议的构建配置

| 配置项 | 值 |
|---|---|
| Runtime | `Dynamic`（不是 Static） |
| Install command | `npm install` |
| Build command | `npm run build`（把 `web/dist` 建出来） |
| Dynamic Entrypoint | `server/src/index.js` |
| Static Directory | 留空 —— Express 自己托管 `web/dist`，这样站点与 API 同源，`SameSite=Lax` 的会话 cookie 才成立 |
| Pre-Deploy Command | 可选，例如 `deno task migrate`（结构变更交给迁移，而不是每次冷启动跑 DDL） |

环境变量：

```
DB_DRIVER=postgres
# DATABASE_URL 由 Deno Deploy 挂库时自动注入（连同 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）
COOKIE_SECRET=<openssl rand -base64 48>
AUTH_DEV=0
HTTPS=1

# 微信：留空 WECHAT_APP_ID 时 mock 自动开启，所以新部署开箱即用。
# 千万不要设 WECHAT_MOCK=0 —— 见 README 的说明。
WECHAT_APP_ID=
WECHAT_APP_SECRET=

OSS_PROVIDER=mock
# 正式环境改成 aliyun 并填 key，同时把 admin 源站加进 bucket 的 CORS 规则
```

> 端口：`config.js` 读 `PORT`，Deno Deploy 注入的值会直接生效。
> 但官方文档**没有明确写**端口是通过 `PORT` 传递的 —— 首次部署请确认这一点。

### 6.3 首次建账号 / 灌数据

Deploy 上没有 shell，但可以在**本地**对着远端库跑：

```bash
cd server
export DB_DRIVER=postgres
export DATABASE_URL='postgresql://…'      # 从 Deploy 控制台复制

deno task seed                            # 灌演示数据（可选）
deno run --allow-all src/cli.js create --email you@example.com --name "You" --role owner
deno run --allow-all src/cli.js status --email owner@portfolio.test --set disabled
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
  OK  36 passed, 0 failed                            # server stderr empty

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
  OK  36 passed, 0 failed

# 关键一步：确认写入真的落在 Postgres（而不是"碰巧通过"）
$ psql -p 5433 -d portfolio …
  users 5 | audit_logs 13 | sessions 5 | wechat users 1 | smoke images 1
  smoke image: https://cdn.example.com/uploads/smoke-1789436052723.jpg
                                          ↑ 与冒烟测试打印的 URL 完全一致
```

**为什么非要去查库确认**：两个引擎的种子数据本来就一模一样，
所以单看 `36 passed` 是分辨不出 API 到底连了哪个库的。
查库看到冒烟测试新建的用户、会话、审计日志和图片 URL 才算真的证明了。

两个引擎的 seed 计数完全相同（5 / 21 / 65 / 12 / 4 / 55 / 894 / 22 / 12 / 2）。

36 项覆盖：各角色权限差异（21/16/5/3 个权限）、作者间归属隔离（403）、
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

> 第 7 条值得单独强调：冒烟测试全绿，但只要看一眼启动日志就会以为自己在用 SQLite。
> 这种"能跑但在说谎"的问题，只有真的把进程启起来盯着日志看才会发现。

### 7.3 仍未验证 ⚠️

| 项 | 原因 |
|---|---|
| **Deno Deploy 实际部署** | 需要账号、挂库，并确认 monorepo 入口与 `PORT` 约定（官方文档没写明端口怎么传） |
| `? → $n` 转换器的边角分支 | 字符串字面量 / 注释 / `$tag$` 跳过逻辑都已实现，但本项目 SQL 没走到这些分支；JSONB 的 `?` / `?\|` 同理 |
| 增量迁移 | boot 时的幂等 DDL 已验证；**迁移脚本**（Deno Deploy 的 Pre-Deploy Command）还没搭 |
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
node scripts/smoke.mjs          # 期望 36 passed, 0 failed

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
* **冷启动时跑 DDL**：`initSchema` 在 boot 时应用幂等 DDL。12 条
  `CREATE TABLE IF NOT EXISTS` 开销很小，但正式环境更适合改成 Pre-Deploy Command。
* **`isUniqueViolation()` 是文案 + SQLSTATE 双重判断**：如果将来换驱动，需要复核。
