-- ============================================================================
-- Portfolio — SQLite schema
-- Applied on boot (idempotently) by server/src/db.js, then seeded by seed.js.
-- Status vocabulary used by every publishable table:
--   draft | review | published | archived
-- Timestamps are ISO-8601 UTC strings ('2026-03-01T09:12:44.000Z').
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ---------------------------------------------------------------- identity --
CREATE TABLE IF NOT EXISTS roles (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rank        INTEGER NOT NULL DEFAULT 0,      -- higher = more authority
  is_system   INTEGER NOT NULL DEFAULT 0       -- system roles can't be deleted
);

CREATE TABLE IF NOT EXISTS permissions (
  key         TEXT PRIMARY KEY,
  group_key   TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_key       TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE,
  name            TEXT NOT NULL,
  avatar_url      TEXT,
  password_hash   TEXT,                          -- NULL for WeChat-only accounts
  role_key        TEXT NOT NULL DEFAULT 'author' REFERENCES roles(key),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  wechat_openid   TEXT UNIQUE,
  wechat_unionid  TEXT,
  wechat_nickname TEXT,
  wechat_avatar   TEXT,
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_token    TEXT,                          -- one-time token handed out by user.invite
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_login_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role_key, status);
CREATE INDEX IF NOT EXISTS idx_users_union  ON users(wechat_unionid);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                   -- sha256 of the cookie value
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

-- ---------------------------------------------------------------- taxonomy --
-- Drives the public navigation and tells the client how to render a section.
CREATE TABLE IF NOT EXISTS sections (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('feed','grid','list','article','contact')),
  position INTEGER NOT NULL DEFAULT 0,
  visible  INTEGER NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ media --
-- The only place an image lives: a URL. The server never stores bytes.
CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  url           TEXT NOT NULL,
  thumb_url     TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  format        TEXT,
  caption       TEXT,
  alt           TEXT,
  oss_provider  TEXT,                            -- mock | aliyun | s3 | …
  oss_key       TEXT,                            -- object key, for dedupe / lifecycle rules
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','review','published','archived')),
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (owner_id, url)
);
CREATE INDEX IF NOT EXISTS idx_images_collection ON images(collection_id, position);
CREATE INDEX IF NOT EXISTS idx_images_owner      ON images(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_images_key        ON images(oss_key);

-- ------------------------------------------------------------ collections --
CREATE TABLE IF NOT EXISTS collections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  section_key    TEXT NOT NULL REFERENCES sections(key),
  kind           TEXT NOT NULL DEFAULT 'series' CHECK (kind IN ('series','album')),
  summary        TEXT NOT NULL DEFAULT '',
  cover_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  place          TEXT,
  year           INTEGER,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','archived')),
  position       INTEGER NOT NULL DEFAULT 0,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_section ON collections(section_key, status, position);
CREATE INDEX IF NOT EXISTS idx_collections_author  ON collections(author_id, status);

-- --------------------------------------------------------------- articles --
CREATE TABLE IF NOT EXISTS articles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  section_key    TEXT NOT NULL REFERENCES sections(key),
  excerpt        TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',       -- markdown
  cover_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','archived')),
  position       INTEGER NOT NULL DEFAULT 0,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_section ON articles(section_key, status, position);
CREATE INDEX IF NOT EXISTS idx_articles_author  ON articles(author_id, status);

-- ------------------------------------------------------------ home  feed --
CREATE TABLE IF NOT EXISTS feed_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id             INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  caption              TEXT NOT NULL DEFAULT '',
  link_kind            TEXT NOT NULL DEFAULT 'collection' CHECK (link_kind IN ('collection','article','external','none')),
  link_url             TEXT,
  target_collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  target_article_id    INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','review','published','archived')),
  position             INTEGER NOT NULL DEFAULT 0,
  author_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_status ON feed_items(status, position);

-- ------------------------------------------------------------ single pages --
CREATE TABLE IF NOT EXISTS pages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'article',  -- article | contact
  body         TEXT NOT NULL DEFAULT '',         -- markdown
  data         TEXT NOT NULL DEFAULT '{}',       -- JSON: columns, lead, publications …
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','archived')),
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ------------------------------------------------------------------ audit --
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,                      -- create | update | delete | publish | login | invite …
  entity     TEXT NOT NULL,                      -- article | collection | image | feed_item | page | user | session
  entity_id  INTEGER,
  meta       TEXT NOT NULL DEFAULT '{}',         -- JSON: changed fields, previous status …
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity, entity_id);
