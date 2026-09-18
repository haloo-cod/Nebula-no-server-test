/**
 * GitHub 内容模式 API。
 *
 * 当配置 GITHUB_CONTENT_TOKEN + GITHUB_REPOSITORY 时，这些路由接管
 * 文章、展览、友链、个人资料、图书元数据和其他低频 CMS 内容。
 * GitHub 模式不需要 PostgreSQL；评论、账号等高频互动接口由外部服务或
 * 兼容模式提供，避免把并发写入塞进 Git 提交历史。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { marked } from 'marked'
import { z } from 'zod'
import { createCmsAccessToken, isCmsAdminRequest, matchesCmsAdminKey, requireAdmin, type AppEnv } from './auth.js'
import { config, githubContentEnabled, r2Enabled, resolveStorageUrl } from './config.js'
import { json, parseLimit, parsePage } from './http.js'
import { createUploadUrl, deleteObject, objectExists, putObject } from './storage.js'
import {
  contentSlug,
  deleteContentGallery,
  deleteContentPost,
  getContentGallery,
  getContentJson,
  getContentPost,
  listContentGallery,
  listContentPosts,
  saveContentGallery,
  saveContentJson,
  saveContentPost,
} from './content.js'

export const githubApi = new Hono<AppEnv>()

/** GitHub + R2 模式的健康检查不需要数据库连接。 */
githubApi.get('/health', (c) => c.json({ status: 'ok', runtime: 'node', content: 'github' }))
githubApi.get('/api/health', (c) => c.json({ status: 'ok', runtime: 'node', content: 'github' }))

function unavailable(c: Context): Response {
  return json(c, { detail: 'GitHub 内容仓库未配置' }, 503)
}

function enabled(c: Context): boolean {
  if (githubContentEnabled()) return true
  void c
  return false
}

/** CMS 管理密钥登录；密钥仅与服务端环境变量比较，不会写入仓库。 */
githubApi.post('/api/v1/auth/cms-login', async (c) => {
  if (!config.cmsAdminKey) return unavailable(c)
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
  if (typeof body?.key !== 'string' || !matchesCmsAdminKey(body.key)) {
    return json(c, { detail: 'CMS 管理密钥错误' }, 401)
  }
  return json(c, { access_token: await createCmsAccessToken(), token_type: 'bearer' })
})

/** CMS 令牌轮换与退出不依赖数据库会话表。 */
githubApi.post('/api/v1/auth/refresh', async (c) => {
  if (!config.cmsAdminKey || !(await isCmsAdminRequest(c))) return json(c, { detail: '登录会话已失效' }, 401)
  return json(c, { access_token: await createCmsAccessToken(), token_type: 'bearer' })
})

githubApi.post('/api/v1/auth/logout', requireAdmin, async () => new Response(null, { status: 204 }))

/** 用统一格式返回文章列表。 */
githubApi.get('/api/v1/posts', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const includeDrafts = c.req.query('include_drafts') === 'true'
  const admin = includeDrafts && (await isCmsAdminRequest(c))
  if (includeDrafts && !admin) return json(c, { detail: '需要管理员权限' }, 403)
  const category = c.req.query('category')?.trim()
  const keyword = (c.req.query('keyword') || c.req.query('search') || '').trim().toLowerCase()
  const all = await listContentPosts()
  const filtered = all.filter((post) =>
    (includeDrafts || !post.is_draft) &&
    (!category || post.category === category) &&
    (!keyword || `${post.title} ${post.description}`.toLowerCase().includes(keyword)),
  )
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 20, 500)
  return json(c, { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length })
})

githubApi.get('/api/v1/posts/stats', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const counts = new Map<string, number>()
  for (const post of await listContentPosts()) {
    if (post.is_draft || !/^\d{4}/.test(post.date)) continue
    const year = post.date.slice(0, 4)
    counts.set(year, (counts.get(year) || 0) + 1)
  }
  return json(c, [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count })))
})

/** 首页使用的内容数量统计同样从 GitHub 内容仓库计算。 */
githubApi.get('/api/v1/content-stats', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const [posts, gallery, moments] = await Promise.all([
    listContentPosts(),
    listContentGallery(),
    getContentJson<unknown[]>('moments.json', []),
  ])
  return json(c, {
    posts: posts.filter((post) => !post.is_draft).length,
    gallery_projects: gallery.length,
    moments: Array.isArray(moments) ? moments.length : 0,
    active_days: 0,
  })
})

githubApi.get('/api/v1/posts/:slug', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const post = await getContentPost(c.req.param('slug'))
  if (!post || (post.is_draft && !(await isCmsAdminRequest(c)))) return json(c, { detail: '文章不存在' }, 404)
  return json(c, { ...post, content_html: await marked.parse(post.content_md) })
})

githubApi.post('/api/v1/posts', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.title !== 'string' || !body.title.trim()) return json(c, { detail: '文章参数不正确' }, 422)
  const post = await saveContentPost({
    ...body,
    tags: Array.isArray(body.tags) ? body.tags : [],
    content_md: typeof body.content_md === 'string' ? body.content_md : '',
  })
  return json(c, { ...post, content_html: await marked.parse(post.content_md) }, 201)
})

githubApi.put('/api/v1/posts/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentPost(c.req.param('slug'))
  if (!current) return json(c, { detail: '文章不存在' }, 404)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const post = await saveContentPost({ ...current, ...(body || {}), slug: current.slug })
  return json(c, { ...post, content_html: await marked.parse(post.content_md) })
})

githubApi.delete('/api/v1/posts/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return (await deleteContentPost(c.req.param('slug')))
    ? new Response(null, { status: 204 })
    : json(c, { detail: '文章不存在' }, 404)
})

githubApi.get('/api/v1/gallery', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = await listContentGallery()
  return json(c, items.map(({ content_md: _content, content_html: _html, ...item }) => item))
})

githubApi.get('/api/v1/gallery/:slug', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const item = await getContentGallery(c.req.param('slug'))
  return item ? json(c, { ...item, content_html: await marked.parse(item.content_md) }) : json(c, { detail: '项目不存在' }, 404)
})

const gallerySchema = z.object({
  slug: z.string().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  tags: z.array(z.string()).default([]),
  status: z.string().max(50).default(''),
  year: z.string().max(10).default(''),
  is_featured: z.boolean().default(false),
  content_md: z.string().default(''),
})

githubApi.post('/api/v1/gallery', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const parsed = gallerySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '项目参数不正确' }, 422)
  const item = await saveContentGallery(parsed.data)
  return json(c, { ...item, content_html: await marked.parse(item.content_md) }, 201)
})

githubApi.put('/api/v1/gallery/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentGallery(c.req.param('slug'))
  if (!current) return json(c, { detail: '项目不存在' }, 404)
  const parsed = gallerySchema.partial().safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '项目参数不正确' }, 422)
  const item = await saveContentGallery({ ...current, ...parsed.data, slug: current.slug })
  return json(c, { ...item, content_html: await marked.parse(item.content_md) })
})

githubApi.delete('/api/v1/gallery/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return (await deleteContentGallery(c.req.param('slug')))
    ? new Response(null, { status: 204 })
    : json(c, { detail: '项目不存在' }, 404)
})

interface FriendRecord {
  id: number
  name: string
  bio: string
  avatar: string
  url: string
  sort_order: number
  created_at: string
}

const defaultFriends: FriendRecord[] = []

function normalizeFriends(value: unknown): FriendRecord[] {
  if (!Array.isArray(value)) return defaultFriends
  return value.filter((item): item is FriendRecord => Boolean(item && typeof item === 'object' && typeof (item as FriendRecord).name === 'string' && typeof (item as FriendRecord).url === 'string'))
}

githubApi.get('/api/v1/friends', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  return json(c, { items, total: items.length })
})

githubApi.get('/api/v1/friends/exchange-info', async (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, await getContentJson('friends-exchange.json', {
    name: '你的站点名称', url: 'https://example.com', avatar: '', bio: '这里填写你的站点简介。',
    requirements: ['原创内容优先', '站点稳定可访问'], contact: 'your-email@example.com',
  }))
})

githubApi.put('/api/v1/friends/exchange-info', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const value = await c.req.json().catch(() => ({}))
  await saveContentJson('friends-exchange.json', value, '更新友链交换信息')
  return json(c, value)
})

githubApi.post('/api/v1/friends', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => null)) as Partial<FriendRecord> | null
  if (!body || typeof body.name !== 'string' || typeof body.url !== 'string') return json(c, { detail: '友链参数不正确' }, 422)
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  const item: FriendRecord = { id: Date.now(), name: body.name.trim(), bio: String(body.bio || ''), avatar: String(body.avatar || ''), url: body.url.trim(), sort_order: Number(body.sort_order || 0), created_at: new Date().toISOString() }
  items.push(item)
  await saveContentJson('friends.json', items, `添加友链：${item.name}`)
  return json(c, item, 201)
})

githubApi.put('/api/v1/friends/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => null)) as Partial<FriendRecord> | null
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return json(c, { detail: '友链不存在' }, 404)
  items[index] = { ...items[index], ...(body || {}), id }
  await saveContentJson('friends.json', items, `更新友链：${items[index].name}`)
  return json(c, items[index])
})

githubApi.delete('/api/v1/friends/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return json(c, { detail: '友链不存在' }, 404)
  await saveContentJson('friends.json', next, `删除友链：${id}`)
  return new Response(null, { status: 204 })
})

interface ProfileRecord {
  name: string
  bio: string
  avatar_url: string
  cover_url: string
  social_links: Array<{ id: number; label: string; icon: string; url: string; sort_order: number }>
}

const defaultProfile: ProfileRecord = { name: '', bio: '', avatar_url: '', cover_url: '', social_links: [] }

githubApi.get('/api/v1/profile', async (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, await getContentJson('profile.json', defaultProfile))
})

githubApi.put('/api/v1/profile', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentJson('profile.json', defaultProfile)
  const body = (await c.req.json().catch(() => ({}))) as Partial<ProfileRecord>
  const next = { ...current, ...body, social_links: current.social_links || [] }
  await saveContentJson('profile.json', next, '更新个人资料')
  return json(c, next)
})

githubApi.post('/api/v1/profile/social-links', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentJson('profile.json', defaultProfile)
  const body = (await c.req.json().catch(() => ({}))) as Partial<ProfileRecord['social_links'][number]>
  const link = { id: Date.now(), label: String(body.label || ''), icon: String(body.icon || ''), url: String(body.url || ''), sort_order: Number(body.sort_order || 0) }
  if (!link.label || !link.url) return json(c, { detail: '社交链接参数不正确' }, 422)
  const next = { ...current, social_links: [...(current.social_links || []), link] }
  await saveContentJson('profile.json', next, `添加社交链接：${link.label}`)
  return json(c, link, 201)
})

githubApi.delete('/api/v1/profile/social-links/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const current = await getContentJson('profile.json', defaultProfile)
  const links = (current.social_links || []).filter((link) => link.id !== id)
  if (links.length === (current.social_links || []).length) return json(c, { detail: '社交链接不存在' }, 404)
  await saveContentJson('profile.json', { ...current, social_links: links }, `删除社交链接：${id}`)
  return new Response(null, { status: 204 })
})

githubApi.get('/api/v1/about/content', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const file = await getContentJson<{ content_md?: string; cover_url?: string }>('about.json', {})
  return json(c, { content_md: file.content_md || '', cover_url: resolveStorageUrl(file.cover_url || '') })
})

githubApi.put('/api/v1/about/content', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as { content_md?: unknown; cover_url?: unknown }
  const value = { content_md: typeof body.content_md === 'string' ? body.content_md : '', cover_url: typeof body.cover_url === 'string' ? body.cover_url : '' }
  await saveContentJson('about.json', value, '更新关于页内容')
  return json(c, { ...value, cover_url: resolveStorageUrl(value.cover_url) })
})

interface BookRecord {
  id: number
  slug: string
  title: string
  author: string
  description: string
  cover_url: string
  file_path: string
  sort_order: number
  created_at: string
  updated_at: string
}

interface MediaRecord {
  id: number
  filename: string
  original_name: string
  url: string
  file_size: number
  width?: number
  height?: number
  mime_type: string
  created_at: string
}

const defaultBooks: BookRecord[] = []

function books(value: unknown): BookRecord[] {
  return Array.isArray(value) ? value.filter((item): item is BookRecord => Boolean(item && typeof item === 'object' && typeof (item as BookRecord).slug === 'string')) : defaultBooks
}

function bookOutput(book: BookRecord): BookRecord {
  return { ...book, cover_url: resolveStorageUrl(book.cover_url), file_path: resolveStorageUrl(book.file_path) }
}

githubApi.get('/api/v1/books', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const keyword = (c.req.query('keyword') || '').trim().toLowerCase()
  const all = books(await getContentJson('books.json', defaultBooks)).filter((book) => !keyword || `${book.title} ${book.author}`.toLowerCase().includes(keyword))
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 20, 100)
  return json(c, { items: all.slice((page - 1) * pageSize, page * pageSize).map(bookOutput), total: all.length })
})

githubApi.get('/api/v1/books/admin/all', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, books(await getContentJson('books.json', defaultBooks)).map(bookOutput))
})

githubApi.get('/api/v1/books/:slug/read', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const book = books(await getContentJson('books.json', defaultBooks)).find((item) => item.slug === c.req.param('slug'))
  return book ? c.redirect(resolveStorageUrl(book.file_path)) : json(c, { detail: '图书不存在' }, 404)
})

githubApi.get('/api/v1/books/:slug', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const book = books(await getContentJson('books.json', defaultBooks)).find((item) => item.slug === c.req.param('slug'))
  return book ? json(c, bookOutput(book)) : json(c, { detail: '图书不存在' }, 404)
})

githubApi.put('/api/v1/books/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const currentItems = books(await getContentJson('books.json', defaultBooks))
  const index = currentItems.findIndex((item) => item.slug === c.req.param('slug'))
  if (index < 0) return json(c, { detail: '图书不存在' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as Partial<BookRecord>
  const current = currentItems[index]
  const next: BookRecord = {
    ...current,
    ...body,
    id: current.id,
    slug: current.slug,
    updated_at: new Date().toISOString(),
  }
  currentItems[index] = next
  await saveContentJson('books.json', currentItems, `更新图书：${next.title}`)
  return json(c, bookOutput(next))
})

githubApi.put('/api/v1/books/reorder', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as { slugs?: unknown }
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter((slug): slug is string => typeof slug === 'string') : []
  const currentItems = books(await getContentJson('books.json', defaultBooks))
  const bySlug = new Map(currentItems.map((item) => [item.slug, item]))
  const ordered: BookRecord[] = []
  for (const slug of slugs) {
    const item = bySlug.get(slug)
    if (!item) continue
    bySlug.delete(slug)
    ordered.push({ ...item, sort_order: ordered.length })
  }
  ordered.push(...[...bySlug.values()].map((item, index) => ({ ...item, sort_order: ordered.length + index })))
  await saveContentJson('books.json', ordered, '调整图书排序')
  return json(c, ordered.map(bookOutput))
})

/** EPUB 上传到 R2 后只把元数据写入 GitHub。 */
githubApi.post('/api/v1/books', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法上传 EPUB' }, 503)
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.epub')) return json(c, { detail: '仅支持 EPUB 文件' }, 400)
  const slug = contentSlug(file.name.replace(/\.epub$/i, ''), crypto.randomUUID())
  const all = books(await getContentJson('books.json', defaultBooks))
  if (all.some((book) => book.slug === slug)) return json(c, { detail: 'slug 已存在' }, 409)
  const key = `books/${crypto.randomUUID()}_${file.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')}`
  const fileUrl = await putObject(key, new Uint8Array(await file.arrayBuffer()), 'application/epub+zip')
  const now = new Date().toISOString()
  const book: BookRecord = { id: Date.now(), slug, title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : file.name.replace(/\.epub$/i, ''), author: typeof body.author === 'string' ? body.author.trim() : '', description: typeof body.description === 'string' ? body.description.trim() : '', cover_url: '', file_path: fileUrl, sort_order: all.length, created_at: now, updated_at: now }
  all.push(book)
  await saveContentJson('books.json', all, `添加图书：${book.title}`)
  return json(c, bookOutput(book), 201)
})

githubApi.delete('/api/v1/books/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const all = books(await getContentJson('books.json', defaultBooks))
  const next = all.filter((book) => book.slug !== c.req.param('slug'))
  if (next.length === all.length) return json(c, { detail: '图书不存在' }, 404)
  await saveContentJson('books.json', next, `删除图书：${c.req.param('slug')}`)
  return new Response(null, { status: 204 })
})

/** R2 媒体索引保存在 GitHub JSON，文件本体始终保存在 R2。 */
function mediaFile(resource: 'images' | 'files'): string {
  return resource === 'images' ? 'media-images.json' : 'media-files.json'
}

async function readMedia(resource: 'images' | 'files'): Promise<MediaRecord[]> {
  const value = await getContentJson<unknown>(mediaFile(resource), [])
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MediaRecord => Boolean(
    item && typeof item === 'object' &&
    typeof (item as MediaRecord).id === 'number' &&
    typeof (item as MediaRecord).filename === 'string' &&
    typeof (item as MediaRecord).url === 'string',
  ))
}

async function uploadMedia(c: Context, resource: 'images' | 'files'): Promise<Response> {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法上传文件' }, 503)
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) return json(c, { detail: '缺少上传文件' }, 422)
  if (resource === 'images' && !file.type.startsWith('image/')) return json(c, { detail: '仅支持图片文件' }, 400)
  const safeName = file.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'upload'
  const key = `${resource}/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}_${safeName}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  const url = await putObject(key, bytes, file.type || 'application/octet-stream')
  const now = new Date().toISOString()
  const record: MediaRecord = {
    id: Date.now(),
    filename: key,
    original_name: file.name,
    url,
    file_size: bytes.byteLength,
    ...(resource === 'images' ? { width: 0, height: 0 } : {}),
    mime_type: file.type || 'application/octet-stream',
    created_at: now,
  }
  const items = await readMedia(resource)
  items.unshift(record)
  await saveContentJson(mediaFile(resource), items, `上传${resource === 'images' ? '图片' : '文件'}：${file.name}`)
  return json(c, record, 201)
}

interface DirectUploadRecord {
  id: number
  filename: string
  original_name: string
  url: string
  file_size: number
  mime_type: string
  created_at: string
}

/** 浏览器直传 R2 前的授权步骤；服务端只签名，不接收文件内容。 */
githubApi.post('/api/v1/uploads/presign', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法上传文件' }, 503)
  const body = (await c.req.json().catch(() => null)) as { filename?: unknown; content_type?: unknown; size?: unknown } | null
  if (typeof body?.filename !== 'string' || !body.filename.trim()) return json(c, { detail: '缺少文件名' }, 422)
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? body.size : 0
  if (size <= 0 || size > 500 * 1024 * 1024) return json(c, { detail: '文件大小必须在 1B 到 500MB 之间' }, 413)
  const contentType = typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream'
  const safeName = body.filename.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'upload'
  const key = `files/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}_${safeName}`
  return json(c, {
    key,
    upload_url: await createUploadUrl(key, contentType),
    upload_headers: { 'Content-Type': contentType },
    public_url: resolveStorageUrl(key),
    expires_in: 600,
  })
})

/** 直传完成后登记媒体索引；只接受当前管理员刚刚上传的 R2 key。 */
githubApi.post('/api/v1/uploads/complete', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法上传文件' }, 503)
  const body = (await c.req.json().catch(() => null)) as {
    key?: unknown
    filename?: unknown
    content_type?: unknown
    size?: unknown
  } | null
  if (typeof body?.key !== 'string' || !body.key.startsWith('files/')) return json(c, { detail: '上传对象无效' }, 422)
  if (!(await objectExists(body.key))) return json(c, { detail: 'R2 中未找到上传对象' }, 404)
  const originalName = typeof body.filename === 'string' ? body.filename : body.key.split('/').pop() || 'upload'
  const mimeType = typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream'
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? body.size : 0
  const record: DirectUploadRecord = {
    id: Date.now(),
    filename: body.key,
    original_name: originalName,
    url: resolveStorageUrl(body.key),
    file_size: size,
    mime_type: mimeType,
    created_at: new Date().toISOString(),
  }
  const items = await readMedia('files')
  items.unshift(record)
  await saveContentJson(mediaFile('files'), items, `直传文件：${originalName}`)
  return json(c, record, 201)
})

for (const resource of ['images', 'files'] as const) {
  githubApi.get(`/api/v1/${resource}`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await readMedia(resource)
    const page = parsePage(c.req.query('page'), 1, 10_000)
    const pageSize = parseLimit(c.req.query('page_size'), 50, 200)
    return json(c, { items: items.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ ...item, url: resolveStorageUrl(item.url) })), total: items.length })
  })
  githubApi.post(`/api/v1/${resource}/upload`, requireAdmin, (c) => uploadMedia(c, resource))
  githubApi.delete(`/api/v1/${resource}/:id`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const id = Number(c.req.param('id'))
    const items = await readMedia(resource)
    const item = items.find((entry) => entry.id === id)
    if (!item) return json(c, { detail: `${resource === 'images' ? '图片' : '文件'}不存在` }, 404)
    await deleteObject(item.filename)
    await saveContentJson(mediaFile(resource), items.filter((entry) => entry.id !== id), `删除${resource === 'images' ? '图片' : '文件'}：${item.original_name}`)
    return new Response(null, { status: 204 })
  })
}

// 背景视频等公开页面会直接请求此地址，因此这里只返回 R2 公共地址，
// 不要求 CMS 管理员令牌；媒体索引本身仍只允许管理员读取。
githubApi.get('/api/v1/files/:id/media', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const item = (await readMedia('files')).find((entry) => entry.id === Number(c.req.param('id')))
  return item ? c.redirect(resolveStorageUrl(item.url)) : json(c, { detail: '文件不存在' }, 404)
})

githubApi.post('/api/v1/backgrounds/video-upload', requireAdmin, (c) => uploadMedia(c, 'files'))

/** 其他低频 CMS JSON 资源统一采用相同 CRUD 结构。 */
function jsonCollection<T extends { id: number }>(resource: string, fallback: T[], label: string) {
  githubApi.get(`/api/v1/${resource}`, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    return json(c, { items: Array.isArray(items) ? items : fallback, total: Array.isArray(items) ? items.length : fallback.length })
  })
  githubApi.post(`/api/v1/${resource}`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    const body = (await c.req.json().catch(() => ({}))) as Partial<T>
    const item = { ...body, id: Date.now(), created_at: new Date().toISOString() } as unknown as T
    const next = [...(Array.isArray(items) ? items : fallback), item]
    await saveContentJson(`${resource}.json`, next, `添加${label}`)
    return json(c, item, 201)
  })
  githubApi.put(`/api/v1/${resource}/:id`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const id = Number(c.req.param('id'))
    const value = await getContentJson<T[]>(`${resource}.json`, fallback)
    const currentItems = Array.isArray(value) ? value : fallback
    const index = currentItems.findIndex((item) => item.id === id)
    if (index < 0) return json(c, { detail: `${label}不存在` }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Partial<T>
    const item = { ...currentItems[index], ...body, id } as T
    const next = [...currentItems]
    next[index] = item
    await saveContentJson(`${resource}.json`, next, `更新${label}`)
    return json(c, item)
  })
  githubApi.delete(`/api/v1/${resource}/:id`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const id = Number(c.req.param('id'))
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    const next = (Array.isArray(items) ? items : fallback).filter((item) => item.id !== id)
    if (next.length === (Array.isArray(items) ? items : fallback).length) return json(c, { detail: `${label}不存在` }, 404)
    await saveContentJson(`${resource}.json`, next, `删除${label}`)
    return new Response(null, { status: 204 })
  })
}

jsonCollection('backgrounds', [], '背景图')
jsonCollection('carousel', [], '轮播图')
jsonCollection('albums', [], '相册')
jsonCollection('moments', [], '说说')
jsonCollection('treasures', [], '藏宝条目')

githubApi.get('/api/v1/moments/:id', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = await getContentJson<Array<Record<string, unknown>>>('moments.json', [])
  const item = items.find((entry) => Number(entry.id) === id)
  return item ? json(c, { ...item, comments: Array.isArray(item.comments) ? item.comments : [] }) : json(c, { detail: '说说不存在' }, 404)
})

githubApi.get('/api/v1/treasures/categories', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = await getContentJson<Array<{ category?: string }>>('treasures.json', [])
  return json(c, [...new Set(items.map((item) => item.category).filter((item): item is string => Boolean(item)))])
})

/** 无数据库模式下管理员资料接口返回 synthetic user。 */
githubApi.get('/api/v1/auth/me', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { id: 0, username: 'cms-admin', is_admin: true, email: null, display_name: 'CMS 管理员', avatar_url: '', email_verified: true })
})
