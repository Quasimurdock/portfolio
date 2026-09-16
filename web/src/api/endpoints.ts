/**
 * Typed endpoint map. One function per route in docs/API.md, grouped by
 * audience, so views never build URLs themselves.
 */
import { api } from './client'
import type {
  Article,
  AuditEntry,
  Collection,
  FeedItem,
  ImageAsset,
  ImportTable,
  ListQuery,
  Overview,
  Page,
  Paged,
  Permission,
  PublicConfig,
  Role,
  Section,
  SectionPayload,
  Status,
  UploadTicket,
  User,
} from '@/types/api'

export interface Session {
  user: User
  permissions: string[]
}

export const authApi = {
  me: () => api.get<Session>('/auth/me'),
  login: (email: string, password: string) => api.post<Session>('/auth/login', { email, password }),
  logout: () => api.post<{ ok: true }>('/auth/logout'),
  wechatUrl: (redirect?: string) => api.get<{ url: string; state: string }>('/auth/wechat/url', { redirect }),
  /** dev only — enabled when the server runs with AUTH_DEV=1 */
  devLogin: (email: string) => api.post<Session>('/auth/dev-login', { email }),
}

export const publicApi = {
  /** the few deployment facts the SPA needs before it can render */
  config: () => api.get<PublicConfig>('/public/config'),
  nav: () => api.get<Section[]>('/public/nav'),
  feed: () => api.get<FeedItem[]>('/public/feed'),
  section: (key: string) => api.get<SectionPayload>(`/public/sections/${key}`),
  collection: (slug: string) => api.get<Collection>(`/public/collections/${slug}`),
  article: (slug: string) => api.get<Article>(`/public/articles/${slug}`),
  page: (slug: string) => api.get<Page>(`/public/pages/${slug}`),
}

/** Payloads shared by every admin resource — validated loosely on purpose. */
export type ResourceInput = Record<string, unknown>

function crud<T>(base: string) {
  return {
    list: (query?: ListQuery) => api.get<Paged<T>>(base, query as Record<string, string | number | undefined>),
    get: (id: number) => api.get<T>(`${base}/${id}`),
    create: (body: ResourceInput) => api.post<T>(base, body),
    update: (id: number, body: ResourceInput) => api.patch<T>(`${base}/${id}`, body),
    remove: (id: number) => api.del<void>(`${base}/${id}`),
    setStatus: (id: number, status: Status) => api.post<T>(`${base}/${id}/status`, { status }),
  }
}

const articles = crud<Article>('/admin/articles')
const collections = crud<Collection>('/admin/collections')
const images = crud<ImageAsset>('/admin/images')
const feedItems = crud<FeedItem>('/admin/feed-items')

export const adminApi = {
  overview: () => api.get<Overview>('/admin/overview'),
  articles,
  collections,
  images: {
    ...images,
    reorder: (collectionId: number, ids: number[]) =>
      api.post<{ ok: true }>('/admin/images/reorder', { collectionId, ids }),
  },
  feedItems,
  pages: {
    list: () => api.get<Page[]>('/admin/pages'),
    get: (slug: string) => api.get<Page>(`/admin/pages/${slug}`),
    update: (slug: string, body: ResourceInput) => api.patch<Page>(`/admin/pages/${slug}`, body),
  },
  users: {
    list: (query?: { q?: string; role?: string; status?: string }) =>
      api.get<Paged<User>>('/admin/users', query as Record<string, string | undefined>),
    /** returns the generated password once, when none was supplied */
    create: (body: { email: string; name: string; role: string; password?: string }) =>
      api.post<User & { password?: string }>('/admin/users', body),
    update: (id: number, body: { name?: string; role?: string; status?: string }) =>
      api.patch<User>(`/admin/users/${id}`, body),
  },
  roles: () => api.get<{ roles: Role[]; permissions: Permission[] }>('/admin/roles'),
  audit: (limit = 50) => api.get<AuditEntry[]>('/admin/audit', { limit }),
}

/**
 * Moving an old install into this one. Only the catalogue lives here — the
 * upload itself streams a file, so it goes through `admin/lib/import.ts`
 * instead of `request()`, which always encodes its body as JSON.
 */
export const importApi = {
  tables: () => api.get<{ tables: ImportTable[]; maxBytes: number }>('/admin/import/tables'),
}

export const uploadsApi = {
  sign: (body: { filename: string; contentType: string; size: number }) =>
    api.post<UploadTicket>('/uploads/sign', body),
}
