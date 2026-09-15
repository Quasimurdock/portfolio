/**
 * Row → JSON mapping.
 *
 * One function per table, each with a `forPublic` switch: public payloads never
 * carry `author_id`, `status`, `password_hash` or draft-only fields
 * (docs/API.md §3.3). Everything is camelCase, ids are numbers, timestamps are
 * ISO-8601 UTC strings.
 */

export const STATUSES = ['draft', 'review', 'published', 'archived']

/** Statuses that require the matching `*.publish` permission. */
export const PUBLISHED_STATUSES = ['published', 'archived']

export function nowIso() {
  return new Date().toISOString()
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
}

/** JSON columns come back as TEXT; never let a bad blob 500 the endpoint. */
export function parseJson(text, fallback = {}) {
  if (text === null || text === undefined || text === '') return fallback
  if (typeof text === 'object') return text
  try {
    const parsed = JSON.parse(text)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** Envelope for every list endpoint. */
export function paged(items, total, page, pageSize) {
  return { items, total, page, pageSize }
}

/* ------------------------------------------------------------------ rows -- */

export function toSection(row) {
  return { key: row.key, label: row.label, kind: row.kind, position: row.position }
}

export function toUser(row) {
  return {
    id: Number(row.id),
    email: row.email ?? null,
    name: row.name,
    avatarUrl: row.avatar_url ?? row.wechat_avatar ?? null,
    role: row.role_key ?? row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
    wechatNickname: row.wechat_nickname ?? null,
  }
}

export function toImage(row, { forPublic = false } = {}) {
  const base = {
    id: Number(row.id),
    collectionId: row.collection_id ?? null,
    url: row.url,
    thumbUrl: row.thumb_url ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    bytes: row.bytes ?? null,
    format: row.format ?? null,
    caption: row.caption ?? null,
    alt: row.alt ?? null,
    position: row.position ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (forPublic) return base // no ownerId / ossKey / status on the public site
  return {
    ...base,
    ownerId: row.owner_id,
    ossProvider: row.oss_provider ?? null,
    ossKey: row.oss_key ?? null,
    status: row.status,
  }
}

export function toArticle(row, { forPublic = false, cover } = {}) {
  const base = {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    sectionKey: row.section_key,
    excerpt: row.excerpt ?? '',
    body: row.body ?? '',
    coverImageId: row.cover_image_id ?? null,
    position: row.position ?? 0,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (forPublic) {
    return cover === undefined ? base : { ...base, cover: cover ? toImage(cover, { forPublic: true }) : null }
  }
  return {
    ...base,
    status: row.status,
    authorId: Number(row.author_id),
    authorName: row.author_name ?? null,
    ...(cover === undefined ? {} : { cover: cover ? toImage(cover) : null }),
  }
}

export function toCollection(row, { forPublic = false, images, cover, imageCount } = {}) {
  const base = {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    sectionKey: row.section_key,
    kind: row.kind,
    summary: row.summary ?? '',
    coverImageId: row.cover_image_id ?? null,
    place: row.place ?? null,
    year: row.year ?? null,
    position: row.position ?? 0,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (forPublic) {
    return {
      ...base,
      ...(imageCount === undefined ? {} : { imageCount }),
      cover: cover ? toImage(cover, { forPublic: true }) : null,
      ...(images === undefined ? {} : { images: images.map((image) => toImage(image, { forPublic: true })) }),
    }
  }
  return {
    ...base,
    status: row.status,
    authorId: Number(row.author_id),
    authorName: row.author_name ?? null,
    ...(imageCount === undefined ? {} : { imageCount }),
    ...(cover === undefined ? {} : { cover: cover ? toImage(cover) : null }),
    ...(images === undefined ? {} : { images: images.map((image) => toImage(image)) }),
  }
}

export function toFeedItem(row, { forPublic = false, image } = {}) {
  if (forPublic) {
    return {
      id: Number(row.id),
      caption: row.caption ?? '',
      image: image
        ? {
            url: image.url,
            thumbUrl: image.thumb_url ?? null,
            width: image.width ?? null,
            height: image.height ?? null,
          }
        : null,
      link: row.link ?? { kind: row.link_kind, href: null },
    }
  }
  return {
    id: Number(row.id),
    imageId: Number(row.image_id),
    caption: row.caption ?? '',
    linkKind: row.link_kind,
    linkUrl: row.link_url ?? null,
    targetCollectionId: row.target_collection_id ?? null,
    targetArticleId: row.target_article_id ?? null,
    status: row.status,
    position: row.position ?? 0,
    ...(image === undefined ? {} : { image: image ? toImage(image) : null }),
  }
}

export function toPage(row, { forPublic = false } = {}) {
  const base = {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    body: row.body ?? '',
    data: parseJson(row.data, {}),
    publishedAt: row.published_at ?? null,
    updatedAt: row.updated_at,
  }
  if (forPublic) return base
  return { ...base, status: row.status, authorId: Number(row.author_id), createdAt: row.created_at }
}

export function toAuditEntry(row) {
  return {
    id: Number(row.id),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    meta: parseJson(row.meta, {}),
    createdAt: row.created_at,
  }
}

export function toPermission(row) {
  return { key: row.key, groupKey: row.group_key, description: row.description ?? '' }
}

export function toRole(row, permissionKeys) {
  return {
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    rank: row.rank ?? 0,
    isSystem: Boolean(row.is_system),
    permissions: permissionKeys,
  }
}
