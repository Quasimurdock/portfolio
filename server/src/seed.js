#!/usr/bin/env node
/**
 * Seed the database (docs/API.md §5).
 *
 *   node src/seed.js            idempotent: safe to run any number of times
 *   node src/seed.js --reset    drop every table, recreate, then seed
 *
 * Every insert below is an upsert keyed on the row's natural key (email, url,
 * slug, section key …), so re-running it rewrites the demo rows instead of
 * duplicating them. `bootstrap.js` imports `seedEverything` from here to seed a
 * brand-new database from a deploy step.
 *
 * The content is the demo material the legacy single-file site shipped in
 * legacy/index.html — NAV, SECTION_ROWS, FILM_ROWS, MONOGRAPH_ROWS, LIST_ROWS,
 * BIOGRAPHY, CONTACT and FEED_ROWS — ported through the same `photo()` /
 * `seriesImages()` helpers so the public site shows exactly that material.
 */
import { pathToFileURL } from 'node:url'

import { all, describeTarget, get, run, insertReturningId, initDb, resetDatabase, tx } from './db.js'
import { hashPassword } from './auth.js'
import { PERMISSIONS, ROLES } from './permissions.js'

const RESET = process.argv.includes('--reset')

/* ==========================================================================
 * 1. Legacy content (ported verbatim from legacy/index.html)
 * ========================================================================== */

const PHOTO_BASE = 'https://picsum.photos/seed/'

/** Single placeholder photograph. `ratio` = height / width. */
function photo(seed, width, ratio) {
  return `${PHOTO_BASE}${encodeURIComponent(seed)}/${width}/${Math.round(width * ratio)}?grayscale`
}

/** Deterministic FNV-1a hash — same seeds as the legacy site. */
function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const PLACES = [
  'London, England',
  'Oslo, Norway',
  'Tokyo, Japan',
  'Reykjavik, Iceland',
  'Marrakesh, Morocco',
  'Lisbon, Portugal',
  'Kyoto, Japan',
  'Berlin, Germany',
  'Cape Town, South Africa',
  'Vancouver, Canada',
  'Seoul, South Korea',
  'Dublin, Ireland',
  'Athens, Greece',
  'Wellington, New Zealand',
  'Tbilisi, Georgia',
  'Porto, Portugal',
]

const ROMAN = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII',
  'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXVI',
]

/** The site nav — key, label, renderer and position (docs/API.md §1 `sections`). */
const SECTIONS = [
  { key: 'feed', label: 'Studio Feed', kind: 'feed', position: 0 },
  { key: 'works-in-series', label: 'Works in Series', kind: 'grid', position: 1 },
  { key: 'portraits', label: 'Portraits', kind: 'grid', position: 2 },
  { key: 'commissions', label: 'Commissions', kind: 'grid', position: 3 },
  { key: 'film', label: 'Film', kind: 'grid', position: 4 },
  { key: 'archive', label: 'Archive', kind: 'grid', position: 5 },
  { key: 'monographs', label: 'Monographs', kind: 'grid', position: 6 },
  { key: 'exhibitions', label: 'Exhibitions & Talks', kind: 'list', position: 7 },
  { key: 'essays-reviews', label: 'Essays & Reviews', kind: 'list', position: 8 },
  { key: 'news', label: 'News', kind: 'list', position: 9 },
  { key: 'biography', label: 'Biography', kind: 'article', position: 10 },
  { key: 'contact', label: 'Contact', kind: 'contact', position: 11 },
]

/** Grid sections → [title, photograph count] pairs. */
const SECTION_ROWS = {
  'works-in-series': [
    ['Northern Light', 34], ['Salt Flats', 22], ['The Weight of Water', 41], ['Field Notes', 18],
    ['After Dark', 29], ['Slow Country', 25], ['Interiors, 1998-2003', 16], ['Coastal', 31],
    ['Ash', 12], ['High Desert', 27], ['The River', 44], ['Winter Rooms', 19],
    ['Bloom', 23], ['Long Exposure', 15],
  ],
  portraits: [
    ['Studio Portraits', 62], ['Writers', 24], ['Musicians', 31], ['Theatre', 18],
    ['Dancers', 14], ['Solitary', 27], ['Twins', 11], ['Public Figures', 38],
  ],
  commissions: [
    ['Editorial, 2024-2026', 21], ['Cover Stories', 17], ['Stage & Screen', 26], ['Fashion', 19],
    ['The Magazine Work', 33], ['Campaigns', 12], ['Annual Reports', 9], ['Portraits for Press', 28],
    ['Institution', 14],
  ],
  archive: [
    ['Early Work, 1989-1994', 36], ['Contact Sheets', 48], ['Polaroids', 22], ['Test Prints', 31],
    ['Outtakes', 26], ['Colour Studies', 17], ['Travel', 29], ['The Darkroom', 13],
    ['Unpublished', 41], ['Client Files', 24], ['Exhibition Prints', 19], ['Ephemera', 11],
  ],
}

const FILM_ROWS = [
  ['A Short Film about Light', '9:12'], ['Salt', '4:38'], ['The Long River', '17:04'],
  ['Winter Rooms', '6:51'], ['Interviews: On Printing', '23:17'], ['Studio Notes', '3:44'],
]

const MONOGRAPH_ROWS = [
  ['Northern Light', 'Steidl', '2024'], ['The Weight of Water', 'Hatje Cantz', '2021'],
  ['After Dark', 'Aperture', '2019'], ['Coastal', 'Mack', '2017'],
  ['Slow Country', 'Kehrer', '2015'], ['Early Work', 'Nazraeli', '2012'],
]

/** List sections → essay/review/news rows. */
const LIST_ROWS = {
  exhibitions: [
    { title: 'After Dark', meta: 'Flowers Gallery, London — 2025',
      body: [
        'Twenty-eight photographs made over four winters, printed large and hung low so that the room darkens as you walk it. The sequence moves from the last of the afternoon light through full darkness and back again.',
        'Shown with a small catalogue and a second room of working prints, contact sheets and test strips, which is where most of the questions were asked.',
      ] },
    { title: 'Northern Light', meta: 'Fotografiska, Stockholm — 2024',
      body: [
        'A twelve-room installation of the northern series, sequenced on the wall across three months. Sound was kept out entirely; the only interruption is the window at the far end of the last room.',
        'The exhibition travelled to two further venues and was accompanied by a programme of walks led by the curator.',
      ] },
    { title: 'The Weight of Water', meta: 'Museum Folkwang, Essen — 2023',
      body: [
        'Forty-one prints from the river series, shown alongside the notebooks kept while the work was made. The notebooks are the argument; the prints are the result.',
        'A reading room held the reference material — hydrological surveys, tide tables, and a century of local photographs.',
      ] },
    { title: 'Coastal', meta: 'Fotohof, Salzburg — 2022',
      body: [
        'The first showing of the coastal work, hung as a single continuous line at eye level so the horizon never breaks between frames.',
        'Accompanied by a lecture on the difficulties of printing a grey that survives a bright room.',
      ] },
    { title: 'Slow Country', meta: 'Le Bal, Paris — 2021',
      body: [
        'An exhibition built around duration: the same three views photographed on fourteen separate visits, arranged in strict chronological order.',
        'Visitors were given a small printed index of the dates, which most took away and few used.',
      ] },
    { title: 'Early Work', meta: 'The Photographers’ Gallery, London — 2019',
      body: [
        'Negatives from 1989 to 1994, printed for the first time at any scale, together with the first serious attempt at a book.',
        'The show was intended as a clearing of the desk before the northern series began.',
      ] },
    { title: 'In conversation: On Printing', meta: 'Photo London — 2024',
      body: [
        'A public conversation about the darkroom: paper choices, the difference between a good print and a useful one, and why the last ten per cent takes half the time.',
        'Recorded and later published in abridged form.',
      ] },
    { title: 'Artist talk: Field Notes', meta: 'Unseen, Amsterdam — 2023',
      body: [
        'An hour on the notebooks — how a series is decided before it is photographed, and what happens when it refuses to behave.',
        'Followed by a portfolio review session with twelve photographers.',
      ] },
  ],
  'essays-reviews': [
    { title: 'The quiet eye', meta: 'Aperture — 2025',
      body: [
        'There is a kind of photograph that does not announce itself. It sits at the edge of the room and waits to be looked at twice, and by the second look it has usually taken the whole wall.',
        'That patience is not passivity. It is the result of a long argument with the subject — months of returning to the same place until the place stops performing and starts to disclose itself. The pictures in this portfolio are the record of that argument, and they are best read slowly.',
      ] },
    { title: 'On grey', meta: 'British Journal of Photography — 2024',
      body: [
        'Grey is the hardest value to print and the easiest to lose. In a bright room it goes flat; under warm light it goes brown. Every darkroom has its own opinion about it.',
        'The photographs here hold their grey because they were made for it — exposed for the midtones, printed on a paper that keeps its blacks honest, and never asked to carry more contrast than the subject could bear.',
      ] },
    { title: 'A portfolio in four parts', meta: 'Foam Magazine — 2024',
      body: [
        'Four bodies of work, made over fifteen years, that turn out to be one piece of work with four openings. Coast, river, room, and the people who agreed to sit.',
        'What holds them together is not a subject but a method: walk, wait, return, print, argue, sequence. The method is the style.',
      ] },
    { title: 'Northern Light, reviewed', meta: 'The Guardian — 2023',
      body: [
        'A severe and beautiful book. The reproductions are restrained to the point of stubbornness, and the sequencing refuses every obvious climax.',
        'What emerges is less a survey of a place than a study of attention — and, quietly, one of the better arguments for the printed page that has appeared in years.',
      ] },
    { title: 'The weight of water', meta: 'The New Yorker — 2023',
      body: [
        'The river series asks a simple question and takes forty photographs to answer it: what does a landscape look like when nobody is in it and nothing is happening?',
        'The answer, it turns out, is not emptiness. It is an enormous amount of weather.',
      ] },
    { title: 'Printing as argument', meta: '1000 Words — 2022',
      body: [
        'A print is not a file made visible. It is a set of decisions — paper, exposure, contrast, edge — and those decisions are where the meaning actually lives.',
        'This essay follows one negative from contact sheet to exhibition print and counts the nine places where it could have gone wrong.',
      ] },
    { title: 'Interview: the long exposure', meta: 'Der Greif — 2021',
      body: [
        'On working slowly in a fast medium: why a series takes years, why the camera is the least interesting part of the process, and why the best pictures are usually the ones taken on the way back to the car.',
        'Conducted over two afternoons in the studio, between printing sessions.',
      ] },
    { title: 'A note on sequencing', meta: 'Self Publish, Be Happy — 2020',
      body: [
        'A book is not a portfolio. The order is the argument, and a sequence that explains itself is already finished.',
        'Notes from the making of two monographs, including the spreads that were cut and the reasons they were cut.',
      ] },
  ],
  news: [
    { title: 'Northern Light wins the 2026 Book Prize', meta: 'March 2026',
      body: [
        'The jury described the book as "a sustained act of looking" and singled out the printing. The award is shared with the publisher and the designer, both of whom argued for fewer pages, correctly.',
      ] },
    { title: 'Studio open day, London', meta: 'February 2026',
      body: [
        'The studio will be open for one afternoon: work prints on the walls, the darkroom running, no appointments necessary. Prints from the archive will be available at studio prices.',
      ] },
    { title: 'New commission for the National Portrait Gallery', meta: 'January 2026',
      body: [
        'A commission for twelve new portraits to enter the collection over the next two years, photographed on large format in natural light at the sitters’ own workplaces.',
      ] },
    { title: 'After Dark extended to April', meta: 'December 2025',
      body: [
        'The London exhibition has been extended by six weeks following demand. The second room of working prints will be rehung for the extension with a new selection of contact sheets.',
      ] },
    { title: 'Print sale in aid of the Rivers Trust', meta: 'November 2025',
      body: [
        'Six prints from the river series are being sold in an edition of twenty-five, with all proceeds going to the Rivers Trust. Available from the studio and from the gallery.',
      ] },
    { title: 'Represented by Flowers Gallery', meta: 'September 2025',
      body: [
        'The studio is now represented worldwide by Flowers Gallery, London and New York. Existing print enquiries continue to be handled directly.',
      ] },
  ],
}

const BIOGRAPHY = {
  lead:
    'Portfolio is the studio archive of a photographer working between landscape, ' +
    'portrait and the printed page for more than three decades.',
  paragraphs: [
    'The work begins with walking. Long series are built slowly, usually over several years, ' +
      'returning to the same stretch of coast, river or room until the place stops performing for ' +
      'the camera and starts to disclose itself. Negatives are printed in the darkroom; sequencing ' +
      'is decided on the wall rather than on a screen.',
    'Alongside the personal series there is a commissioned practice — editorial portraits, ' +
      'theatre and music, campaign and institutional work — which is approached with the same ' +
      'working method: natural light where possible, a large format camera when the subject allows, ' +
      'and as much time as the sitter will give.',
    'Prints are held in public and private collections, and the monographs are distributed ' +
      'internationally. Talks, teaching and print-making workshops run from the studio throughout ' +
      'the year.',
  ],
  publications:
    'Six monographs, most recently Northern Light (Steidl, 2024) and The Weight of Water (Hatje Cantz, 2021).',
  representation: 'Flowers Gallery, London and New York. Commissions worldwide.',
}

const CONTACT = {
  columns: [
    { title: 'Studio', lines: [
      { text: 'Unit 12, Bell Yard Mews' }, { text: 'London SE1 3TY' }, { text: 'United Kingdom' },
    ] },
    { title: 'Enquiries', lines: [
      { text: 'studio@portfolio.example', href: 'mailto:studio@portfolio.example' },
      { text: '+44 20 7946 0000', href: 'tel:+442079460000' },
    ] },
    { title: 'Commissions', lines: [
      { text: 'commissions@portfolio.example', href: 'mailto:commissions@portfolio.example' },
      { text: 'Available worldwide' },
    ] },
    { title: 'Elsewhere', lines: [
      { text: 'Instagram', href: 'https://www.instagram.com/', external: true },
      { text: 'Twitter', href: 'https://twitter.com/', external: true },
      { text: 'Newsletter', href: '#/contact' },
    ] },
  ],
}

const FEED_ROWS = [
  ['Northern Light — installation view, Fotografiska, Stockholm', '/works-in-series/northern-light'],
  ['Salt Flats — new work, sheets 14 to 22', '/works-in-series/salt-flats'],
  ['Writers — portrait of a novelist, London', '/portraits/writers'],
  ['After Dark — extended to April', '/works-in-series/after-dark'],
  ['A commission for the National Portrait Gallery', '/commissions/institution'],
  ['Coastal — printing in progress', '/works-in-series/coastal'],
  ['The magazine work, 2024-2026', '/commissions/the-magazine-work'],
  ['Solitary — a series of twenty-seven portraits', '/portraits/solitary'],
  ['Contact sheets, 1991', '/archive/contact-sheets'],
  ['A short film about light', '/film'],
  ['Studio portraits — new sitting', '/portraits/studio-portraits'],
  ['Ephemera — posters and invitations', '/archive/ephemera'],
]

/* ==========================================================================
 * 2. Accounts
 * ========================================================================== */

const PASSWORD = 'portfolio'

const USERS = [
  { email: 'owner@portfolio.test', name: 'Alex Whitfield', role: 'owner' },
  { email: 'editor@portfolio.test', name: 'Bea Lindqvist', role: 'editor' },
  { email: 'author@portfolio.test', name: 'Caleb Moreau', role: 'author' },
  { email: 'viewer@portfolio.test', name: 'Dana Okafor', role: 'viewer' },
]

/** A stable, deterministic publication date for seeded rows. */
const PUBLISH_BASE = Date.UTC(2026, 0, 5, 9, 0, 0)
function publishedAt(index) {
  return new Date(PUBLISH_BASE - index * 86400000).toISOString()
}

/* ==========================================================================
 * 3. Seeding
 * ========================================================================== */

async function upsertRoles() {
  for (const role of ROLES) {
    await run(
      `INSERT INTO roles (key, name, description, rank, is_system)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         rank = excluded.rank, is_system = excluded.is_system`,
      [role.key, role.name, role.description, role.rank, role.isSystem],
    )
    // roles are authoritative: re-link from scratch so the matrix can't drift
    await run('DELETE FROM role_permissions WHERE role_key = ?', [role.key])
    for (const key of role.permissions) {
      await run(
        'INSERT INTO role_permissions (role_key, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [role.key, key],
      )
    }
  }
}

async function upsertPermissions() {
  for (const permission of PERMISSIONS) {
    await run(
      `INSERT INTO permissions (key, group_key, description)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         group_key = excluded.group_key, description = excluded.description`,
      [permission.key, permission.groupKey, permission.description],
    )
  }
}

/** @returns {Record<string, number>} email → user id */
async function upsertUsers() {
  const ids = {}
  for (const user of USERS) {
    const now = new Date().toISOString()
    const avatar = photo(`avatar-${slugify(user.email.split('@')[0])}`, 200, 1)
    const existing = await get('SELECT id FROM users WHERE email = ?', [user.email])
    if (existing) {
      await run(
        `UPDATE users
            SET name = ?, role_key = ?, status = 'active', password_hash = ?, avatar_url = ?, updated_at = ?
          WHERE id = ?`,
        [user.name, user.role, hashPassword(PASSWORD), avatar, now, existing.id],
      )
      ids[user.email] = existing.id
    } else {
      ids[user.email] = await insertReturningId(
        `INSERT INTO users (email, name, avatar_url, password_hash, role_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        [user.email, user.name, avatar, hashPassword(PASSWORD), user.role, now, now],
      )
    }
  }
  return ids
}

async function upsertSections() {
  for (const section of SECTIONS) {
    await run(
      `INSERT INTO sections (key, label, kind, position, visible)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         label = excluded.label, kind = excluded.kind, position = excluded.position, visible = 1`,
      [section.key, section.label, section.kind, section.position],
    )
  }
}

/** Upsert one image keyed on the schema's UNIQUE (owner_id, url). */
async function upsertImage(row) {
  const existing = await get('SELECT id FROM images WHERE owner_id = ? AND url = ?', [row.ownerId, row.url])
  if (existing) {
    await run(
      `UPDATE images
          SET collection_id = ?, thumb_url = ?, width = ?, height = ?, bytes = ?, format = ?,
              caption = ?, alt = ?, oss_provider = ?, oss_key = ?, status = ?, position = ?, updated_at = ?
        WHERE id = ?`,
      [
        row.collectionId, row.thumbUrl, row.width, row.height, row.bytes, row.format,
        row.caption, row.alt, row.ossProvider, row.ossKey, row.status, row.position, row.updatedAt, existing.id,
      ],
    )
    return existing.id
  }
  return await insertReturningId(
    `INSERT INTO images
       (collection_id, owner_id, url, thumb_url, width, height, bytes, format, caption, alt,
        oss_provider, oss_key, status, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.collectionId, row.ownerId, row.url, row.thumbUrl, row.width, row.height, row.bytes, row.format,
      row.caption, row.alt, row.ossProvider, row.ossKey, row.status, row.position, row.createdAt, row.updatedAt,
    ],
  )
}

async function upsertCollection(row) {
  const existing = await get('SELECT id FROM collections WHERE slug = ?', [row.slug])
  if (existing) {
    await run(
      `UPDATE collections
          SET title = ?, section_key = ?, kind = ?, summary = ?, cover_image_id = ?, place = ?, year = ?,
              status = ?, position = ?, author_id = ?, published_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        row.title, row.sectionKey, row.kind, row.summary, row.coverImageId, row.place, row.year,
        row.status, row.position, row.authorId, row.publishedAt, row.updatedAt, existing.id,
      ],
    )
    return existing.id
  }
  return await insertReturningId(
    `INSERT INTO collections
       (slug, title, section_key, kind, summary, cover_image_id, place, year, status, position,
        author_id, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.slug, row.title, row.sectionKey, row.kind, row.summary, row.coverImageId, row.place, row.year,
      row.status, row.position, row.authorId, row.publishedAt, row.createdAt, row.updatedAt,
    ],
  )
}

async function upsertArticle(row) {
  const existing = await get('SELECT id FROM articles WHERE slug = ?', [row.slug])
  if (existing) {
    await run(
      `UPDATE articles
          SET title = ?, section_key = ?, excerpt = ?, body = ?, status = ?, position = ?,
              author_id = ?, published_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        row.title, row.sectionKey, row.excerpt, row.body, row.status, row.position,
        row.authorId, row.publishedAt, row.updatedAt, existing.id,
      ],
    )
    return existing.id
  }
  return await insertReturningId(
    `INSERT INTO articles
       (slug, title, section_key, excerpt, body, cover_image_id, status, position, author_id,
        published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      row.slug, row.title, row.sectionKey, row.excerpt, row.body, row.status, row.position,
      row.authorId, row.publishedAt, row.createdAt, row.updatedAt,
    ],
  )
}

async function upsertPage(row) {
  const existing = await get('SELECT id FROM pages WHERE slug = ?', [row.slug])
  if (existing) {
    await run(
      `UPDATE pages
          SET title = ?, kind = ?, body = ?, data = ?, status = ?, author_id = ?, published_at = ?, updated_at = ?
        WHERE id = ?`,
      [row.title, row.kind, row.body, row.data, row.status, row.authorId, row.publishedAt, row.updatedAt, existing.id],
    )
    return existing.id
  }
  return await insertReturningId(
    `INSERT INTO pages (slug, title, kind, body, data, status, author_id, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.slug, row.title, row.kind, row.body, row.data, row.status, row.authorId,
      row.publishedAt, row.createdAt, row.updatedAt,
    ],
  )
}

/** Feed items have no natural key: match on the seeded image. */
async function upsertFeedItem(row) {
  const existing = await get('SELECT id FROM feed_items WHERE image_id = ?', [row.imageId])
  if (existing) {
    await run(
      `UPDATE feed_items
          SET caption = ?, link_kind = ?, link_url = ?, target_collection_id = ?, target_article_id = ?,
              status = ?, position = ?, author_id = ?, updated_at = ?
        WHERE id = ?`,
      [
        row.caption, row.linkKind, row.linkUrl, row.targetCollectionId, row.targetArticleId,
        row.status, row.position, row.authorId, row.updatedAt, existing.id,
      ],
    )
    return existing.id
  }
  return await insertReturningId(
    `INSERT INTO feed_items
       (image_id, caption, link_kind, link_url, target_collection_id, target_article_id,
        status, position, author_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.imageId, row.caption, row.linkKind, row.linkUrl, row.targetCollectionId, row.targetArticleId,
      row.status, row.position, row.authorId, row.createdAt, row.updatedAt,
    ],
  )
}

/** Resolve a legacy feed path (`/section/slug`, or `/film`) to a real target. */
async function resolveFeedTarget(path, caption) {
  const parts = String(path).split('/').filter(Boolean)
  const sectionKey = parts[0]
  const slug = parts[1]

  if (slug) {
    const collection = await get('SELECT id FROM collections WHERE section_key = ? AND slug = ?', [sectionKey, slug])
    if (collection) return { linkKind: 'collection', targetCollectionId: collection.id, targetArticleId: null }
    const article = await get('SELECT id FROM articles WHERE section_key = ? AND slug = ?', [sectionKey, slug])
    if (article) return { linkKind: 'article', targetCollectionId: null, targetArticleId: article.id }
  }

  // `/film` has no slug — match the caption against the section's titles.
  const candidates = await all(
    'SELECT id, title FROM collections WHERE section_key = ? ORDER BY position ASC, id ASC',
    [sectionKey],
  )
  const needle = String(caption).toLowerCase().trim()
  const match =
    candidates.find((row) => String(row.title).toLowerCase().trim() === needle) ?? candidates[0] ?? null
  if (match) return { linkKind: 'collection', targetCollectionId: match.id, targetArticleId: null }
  return { linkKind: 'none', targetCollectionId: null, targetArticleId: null }
}

/**
 * The part the application needs in order to work at all: the permission
 * catalogue, the roles that reference it, and the sections.
 *
 * `sections` has no write endpoint anywhere in the API, so if this does not run
 * there is no other way to create them — and without a section you cannot create
 * a collection or an article (`requireSection()` answers 400).
 */
export async function seedStructure() {
  await upsertPermissions() // roles link to these, so they must exist first
  await upsertRoles()
  await upsertSections()
}

/**
 * Everything, demo content included (docs/API.md §5).
 *
 * The demo content is roughly 2000 individually round-tripped statements — 894
 * images alone, each an upsert (`SELECT` + `INSERT`) — which is nothing against
 * a local database but is minutes of pure latency against a managed Postgres in
 * another region. `bootstrap.js` therefore seeds only `seedStructure()` unless
 * `SEED_DEMO_CONTENT=1` is set.
 */
export async function seedEverything() {
  await seedStructure()
  const userIds = await upsertUsers()

  const ownerId = userIds['owner@portfolio.test']
  const editorId = userIds['editor@portfolio.test']
  const authorId = userIds['author@portfolio.test']

  // Two content owners, so ownership isolation is visible immediately.
  const contentOwners = [editorId, authorId]
  let ownerCursor = 0
  const nextOwner = () => contentOwners[ownerCursor++ % contentOwners.length]

  /* ---------------------------------------------------------- collections */
  let collectionCursor = 0
  let collectionsDone = 0
  let imagesDone = 0

  const addCollection = async (descriptor) => {
    const authorId = nextOwner()
    const now = new Date().toISOString()
    const id = await upsertCollection({
      slug: descriptor.slug,
      title: descriptor.title,
      sectionKey: descriptor.sectionKey,
      kind: descriptor.kind,
      summary: descriptor.summary,
      coverImageId: null,
      place: descriptor.place ?? null,
      year: descriptor.year ?? null,
      status: 'published',
      position: descriptor.position,
      authorId,
      publishedAt: publishedAt(collectionCursor),
      createdAt: now,
      updatedAt: now,
    })
    collectionCursor += 1

    /* -------------------------------------------------------------- images */
    const imageIds = []
    for (const [index, image] of descriptor.images.entries()) {
      imageIds.push(
        await upsertImage({
          collectionId: id,
          ownerId: authorId,
          url: image.url,
          thumbUrl: image.thumbUrl,
          width: image.width,
          height: image.height,
          bytes: null,
          format: 'jpg',
          caption: image.caption,
          alt: image.caption,
          ossProvider: 'picsum',
          ossKey: null,
          status: 'published',
          position: index,
          createdAt: now,
          updatedAt: now,
        }),
      )
    }

    if (imageIds.length) {
      await run('UPDATE collections SET cover_image_id = ? WHERE id = ?', [imageIds[0], id])
    }

    // This phase is ~2000 individually round-tripped statements, so against a
    // remote database it is minutes long. Without a heartbeat the log simply
    // stops after "seeding the demo content" and the run looks hung — which is
    // exactly how it read the first time it was run for real.
    collectionsDone += 1
    imagesDone += imageIds.length
    if (collectionsDone % 10 === 0) {
      console.log(`  … ${collectionsDone} collections, ${imagesDone} images`)
    }
    return id
  }

  /* grid sections built out of [title, count] pairs — legacy `makeSeries` */
  for (const [sectionKey, pairs] of Object.entries(SECTION_ROWS)) {
    for (const [index, [title, count]] of pairs.entries()) {
      const slug = slugify(title)
      const seed = `${slug}-${index}`
      const total = Math.min(count, 24) // legacy caps a series at 24 frames

      const images = Array.from({ length: total }, (_, i) => {
        const key = `${seed}-i${i}`
        const ratio = i % 3 === 1 ? 0.72 : 1.35 // every third frame reads as a landscape
        const place = PLACES[hash(key) % PLACES.length]
        const year = 1998 + (hash(`${key}y`) % 28)
        return {
          url: photo(key, 1440, ratio),
          thumbUrl: photo(key, 480, 1.3),
          width: 1440,
          height: Math.round(1440 * ratio),
          caption: `${title} ${ROMAN[i % ROMAN.length]}, ${place}, ${year}`,
          place,
          year,
        }
      })

      await addCollection({
        slug,
        title,
        sectionKey,
        kind: 'series',
        summary: `Series of ${count}`,
        position: index,
        place: images[0]?.place ?? null,
        year: images[0]?.year ?? null,
        images,
      })
    }
  }

  /* film — one frame each, slugs namespaced so they can't collide with a series */
  for (const [index, [title, duration]] of FILM_ROWS.entries()) {
    const seed = `film-${slugify(title)}`
    await addCollection({
      slug: `film-${slugify(title)}`,
      title,
      sectionKey: 'film',
      kind: 'album',
      summary: `Film · ${duration}`,
      position: index,
      images: [
        {
          url: photo(seed, 1440, 0.5625),
          thumbUrl: photo(seed, 720, 0.5625),
          width: 1440,
          height: Math.round(1440 * 0.5625),
          caption: `${title}, film, ${duration}`,
        },
      ],
    })
  }

  /* monographs — likewise namespaced with the legacy `book-` seed prefix */
  for (const [index, [title, publisher, year]] of MONOGRAPH_ROWS.entries()) {
    const seed = `book-${slugify(title)}`
    await addCollection({
      slug: `book-${slugify(title)}`,
      title,
      sectionKey: 'monographs',
      kind: 'album',
      summary: `${publisher} · ${year}`,
      position: index,
      place: publisher,
      year: Number(year),
      images: [
        {
          url: photo(seed, 1440, 1.3),
          thumbUrl: photo(seed, 720, 1.3),
          width: 1440,
          height: Math.round(1440 * 1.3),
          caption: `${title} — ${publisher}, ${year}`,
        },
      ],
    })
  }

  /* ------------------------------------------------------------- articles */
  let articleCursor = 0
  for (const [sectionKey, rows] of Object.entries(LIST_ROWS)) {
    for (const [index, row] of rows.entries()) {
      const authorId = nextOwner()
      await upsertArticle({
        slug: `${slugify(row.title)}-${index}`,
        title: row.title,
        sectionKey,
        excerpt: row.meta,
        body: (row.body ?? []).join('\n\n'),
        status: 'published',
        position: index,
        authorId,
        publishedAt: publishedAt(articleCursor),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      articleCursor += 1
    }
  }

  /* ---------------------------------------------------------- single pages */
  await upsertPage({
    slug: 'biography',
    title: 'Biography',
    kind: 'article',
    body: BIOGRAPHY.paragraphs.join('\n\n'),
    data: JSON.stringify(BIOGRAPHY),
    status: 'published',
    authorId: ownerId,
    publishedAt: publishedAt(0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  await upsertPage({
    slug: 'contact',
    title: 'Contact',
    kind: 'contact',
    body: '',
    data: JSON.stringify(CONTACT),
    status: 'published',
    authorId: ownerId,
    publishedAt: publishedAt(0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  /* ----------------------------------------------------------- home feed */
  for (const [index, row] of FEED_ROWS.entries()) {
    const [caption, path] = row
    const seed = `feed-${index}`
    const ratio = index % 3 === 1 ? 0.7 : 1.28
    const now = new Date().toISOString()

    const imageId = await upsertImage({
      collectionId: null,
      ownerId,
      url: photo(seed, 1440, ratio),
      thumbUrl: photo(seed, 480, ratio),
      width: 1440,
      height: Math.round(1440 * ratio),
      bytes: null,
      format: 'jpg',
      caption,
      alt: caption,
      ossProvider: 'picsum',
      ossKey: null,
      status: 'published',
      position: index,
      createdAt: now,
      updatedAt: now,
    })

    const target = await resolveFeedTarget(path, caption)
    await upsertFeedItem({
      imageId,
      caption,
      linkKind: target.linkKind,
      linkUrl: target.linkKind === 'external' ? path : null,
      targetCollectionId: target.targetCollectionId,
      targetArticleId: target.targetArticleId,
      status: 'published',
      position: index,
      authorId: ownerId,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/* ==========================================================================
 * 4. Entry point
 * ========================================================================== */

async function summary() {
  const count = async (sql, params = []) => Number((await get(sql, params)).n)
  return {
    roles: await count('SELECT COUNT(*) AS n FROM roles'),
    permissions: await count('SELECT COUNT(*) AS n FROM permissions'),
    rolePermissions: await count('SELECT COUNT(*) AS n FROM role_permissions'),
    sections: await count('SELECT COUNT(*) AS n FROM sections'),
    users: await count('SELECT COUNT(*) AS n FROM users'),
    collections: await count('SELECT COUNT(*) AS n FROM collections'),
    images: await count('SELECT COUNT(*) AS n FROM images'),
    articles: await count('SELECT COUNT(*) AS n FROM articles'),
    feedItems: await count('SELECT COUNT(*) AS n FROM feed_items'),
    pages: await count('SELECT COUNT(*) AS n FROM pages'),
    published: await count("SELECT COUNT(*) AS n FROM articles WHERE status = 'published'"),
  }
}

async function main() {
  if (RESET) {
    await resetDatabase()
    console.log(`database reset (${describeTarget()}) — every table dropped and recreated from the schema`)
  } else {
    await initDb()
  }

  await tx(seedEverything)
  const counts = await summary()

  console.log(
    [
      'seed complete:',
      `  ${counts.roles} roles, ${counts.permissions} permissions, ${counts.rolePermissions} role_permissions`,
      `  ${counts.sections} sections, ${counts.users} users`,
      `  ${counts.collections} collections, ${counts.images} images, ${counts.articles} articles (${counts.published} published)`,
      `  ${counts.feedItems} feed items, ${counts.pages} pages`,
      '  accounts (password "portfolio"): owner@portfolio.test, editor@portfolio.test, author@portfolio.test, viewer@portfolio.test',
    ].join('\n'),
  )
}

// `import.meta.main` is Deno's "was this file run directly?"; the `process.argv`
// comparison is the Node fallback. Same shape as `index.js`, so `npm run
// seed:node` keeps working and `bootstrap.js` can import `seedEverything`
// without this file seeding the database on import.
const isMain =
  import.meta.main ?? (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href)

if (isMain) await main()
