/**
 * Entity + payload types, mirroring docs/API.md and server/src/schema.sql.
 * These are the shapes the API actually returns (camelCase, public payloads
 * trimmed of anything an anonymous visitor must not see).
 */

export type Status = 'draft' | 'review' | 'published' | 'archived'
export type SectionKind = 'feed' | 'grid' | 'list' | 'article' | 'contact'
export type UserStatus = 'active' | 'invited' | 'disabled'
export type LinkKind = 'collection' | 'article' | 'external' | 'none'

export const STATUS_ORDER: Status[] = ['draft', 'review', 'published', 'archived']

/* ------------------------------------------------------------------ people */

export interface User {
  id: number
  email: string | null
  name: string
  avatarUrl: string | null
  role: string
  status: UserStatus
  createdAt: string
  lastLoginAt: string | null
  wechatNickname?: string | null
}

export interface Role {
  key: string
  name: string
  description: string
  rank: number
  isSystem: boolean
  permissions: string[]
}

export interface Permission {
  key: string
  groupKey: string
  description: string
}

/* ------------------------------------------------------------------ content */

export interface Section {
  key: string
  label: string
  kind: SectionKind
  position: number
}

export interface ImageAsset {
  id: number
  collectionId: number | null
  ownerId?: number
  url: string
  thumbUrl: string | null
  width: number | null
  height: number | null
  bytes: number | null
  format: string | null
  caption: string | null
  alt: string | null
  ossProvider: string | null
  ossKey: string | null
  status: Status
  position: number
  createdAt: string
  updatedAt: string
}

export interface Collection {
  id: number
  slug: string
  title: string
  sectionKey: string
  kind: 'series' | 'album'
  summary: string
  coverImageId: number | null
  place: string | null
  year: number | null
  status: Status
  position: number
  authorId: number
  authorName?: string
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  /** present on list endpoints */
  imageCount?: number
  /** present on the public detail payload */
  images?: ImageAsset[]
  cover?: ImageAsset | null
}

export interface Article {
  id: number
  slug: string
  title: string
  sectionKey: string
  excerpt: string
  body: string
  coverImageId: number | null
  status: Status
  position: number
  authorId: number
  authorName?: string
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  cover?: ImageAsset | null
}

export interface FeedItem {
  id: number
  imageId: number
  caption: string
  linkKind: LinkKind
  linkUrl: string | null
  targetCollectionId: number | null
  targetArticleId: number | null
  status: Status
  position: number
  image?: ImageAsset
  /** resolved by the public endpoint */
  link?: { kind: LinkKind; href: string | null }
}

export interface Page {
  id: number
  slug: string
  title: string
  kind: 'article' | 'contact'
  body: string
  data: PageData
  status: Status
  publishedAt: string | null
  updatedAt: string
}

export interface PageData {
  lead?: string
  paragraphs?: string[]
  publications?: string
  representation?: string
  columns?: { title: string; lines: { text: string; href?: string; external?: boolean }[] }[]
}

export interface AuditEntry {
  id: number
  userId: number | null
  userName?: string | null
  action: string
  entity: string
  entityId: number | null
  meta: Record<string, unknown>
  createdAt: string
}

/* --------------------------------------------------------------- envelopes */

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface Overview {
  counts: { entity: 'article' | 'collection' | 'image' | 'feed_item' | 'page'; status: Status | 'total'; n: number }[]
  myDrafts: { entity: string; id: number; title: string; status: Status; updatedAt: string }[]
  recent: AuditEntry[]
  users: { total: number; byRole: { role: string; n: number }[] }
}

export interface UploadTicket {
  provider: string
  key: string
  publicUrl: string
  upload: { url: string; method: 'POST' | 'PUT'; fields?: Record<string, string>; headers?: Record<string, string> }
  maxBytes: number
}

/* ------------------------------------------------------------------ queries */

export interface ListQuery {
  status?: Status | ''
  section?: string
  q?: string
  scope?: 'mine' | 'all'
  page?: number
  pageSize?: number
  collectionId?: number | null
}

export interface SectionPayload {
  section: Section
  collections?: Collection[]
  articles?: Article[]
}
