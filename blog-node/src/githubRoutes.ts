/**
 * GitHub 内容模式 API。
 *
 * 当配置 GITHUB_CONTENT_TOKEN + GITHUB_REPOSITORY 时，这些路由接管
 * 文章、展览、友链、个人资料、图书元数据和其他低频 CMS 内容。
 * GitHub 模式不需要 PostgreSQL；评论、账号等高频互动接口由外部服务或
 * 兼容模式提供，避免把并发写入塞进 Git 提交历史。
 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { marked } from 'marked'
import { z } from 'zod'
import { createGithubAccessToken, createGithubOAuthState, githubIdentityFromRequest, githubSessionFromRequest, isCmsAdminRequest, requireAdmin, verifyGithubOAuthState, type AppEnv } from './auth.js'
import { config, githubContentEnabled, githubOAuthEnabled, r2ConfigIssues, r2Enabled, resolveStorageUrl } from './config.js'
import { json, parseLimit, parsePage } from './http.js'
import { createUploadUrl, deleteObject, getObject, objectExists, putObject } from './storage.js'
import { extractEpubCover } from './epub.js'
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
import { contentPath as githubContentPath, deleteGithubFile, getGithubFile, githubRawUrl, putGithubFile } from './github.js'

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

/** 将当前 GitHub OAuth 登录者传给内容写入层，作为 Git 提交 author/committer。 */
async function saveJson(c: Context<AppEnv>, path: string, value: unknown, message: string): Promise<void> {
  return saveContentJson(path, value, message, await githubIdentityFromRequest(c))
}

/** 评论只接受 GitHub OAuth 会话，不接受数据库账号或伪造的管理员令牌。 */
async function requireGithubLogin(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  if (!(await githubIdentityFromRequest(c))) return json(c, { detail: '请先使用 GitHub 登录后再评论' }, 401)
  await next()
}

/** 发起 GitHub OAuth；回调会严格校验仓库 owner。 */
githubApi.get('/api/v1/auth/github', async (c) => {
  if (!githubOAuthEnabled()) return json(c, { detail: 'GitHub OAuth 未配置' }, 503)
  const redirect = c.req.query('redirect') || '/admin/dashboard'
  const state = await createGithubOAuthState(redirect)
  const params = new URLSearchParams({
    client_id: config.githubClientId,
    redirect_uri: config.githubOAuthRedirectUri,
    // repo 权限用于校验 OAuth 账号确实拥有并可管理配置的内容仓库。
    scope: 'read:user user:email repo',
    state,
  })
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`)
})

/** GitHub OAuth 回调；交换令牌、检查管理员名单并写入 HttpOnly 会话 Cookie。 */
githubApi.get('/api/v1/auth/github/callback', async (c) => {
  if (!githubOAuthEnabled()) return json(c, { detail: 'GitHub OAuth 未配置' }, 503)
  const state = c.req.query('state') || ''
  const redirect = await verifyGithubOAuthState(state)
  const code = c.req.query('code') || ''
  if (!redirect || !code) return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_state`)

  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: config.githubOAuthRedirectUri }),
    })
    const tokenBody = (await tokenResponse.json().catch(() => null)) as { access_token?: string } | null
    if (!tokenResponse.ok || !tokenBody?.access_token) return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_token`)

    const githubHeaders = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenBody.access_token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'starlit-blog-cms' }
    const profileResponse = await fetch('https://api.github.com/user', { headers: githubHeaders })
    const profile = (await profileResponse.json().catch(() => null)) as { login?: string; name?: string; email?: string | null } | null
    const login = profile?.login?.trim().toLowerCase() || ''
    const repositoryOwner = config.githubRepository.split('/')[0]?.trim().toLowerCase()
    if (!profileResponse.ok || !login || !repositoryOwner || login !== repositoryOwner) return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_forbidden`)
    const repositoryResponse = await fetch(`https://api.github.com/repos/${config.githubRepository}`, { headers: githubHeaders })
    const repository = (await repositoryResponse.json().catch(() => null)) as { owner?: { login?: string }; permissions?: { admin?: boolean } } | null
    if (!repositoryResponse.ok || repository?.owner?.login?.toLowerCase() !== repositoryOwner || repository.permissions?.admin !== true) {
      return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_forbidden`)
    }

    let email = profile?.email || ''
    if (!email) {
      const emailResponse = await fetch('https://api.github.com/user/emails', { headers: githubHeaders })
      const emails = (await emailResponse.json().catch(() => [])) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
      email = emails.find((item) => item.primary && item.verified)?.email || emails.find((item) => item.verified)?.email || ''
    }
    if (!email) return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_email`)

    const session = await createGithubAccessToken({ token: tokenBody.access_token, login, name: profile?.name?.trim() || profile?.login || login, email })
    // 会话需要覆盖文章、媒体等所有受保护的 API 路径。
    setCookie(c, 'github_admin_token', session, { httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax', path: '/', maxAge: 60 * 60 })
    return c.redirect(`${config.frontendUrl}/auth/callback?redirect=${encodeURIComponent(redirect)}`)
  } catch (error) {
    console.error('[github-oauth] callback failed', error)
    return c.redirect(`${config.frontendUrl}/admin/login?error=github_oauth_network`)
  }
})

/** CMS 令牌轮换与退出不依赖数据库会话表。 */
githubApi.post('/api/v1/auth/refresh', async (c) => {
  const githubSession = await githubSessionFromRequest(c)
  if (githubSession) return json(c, { access_token: await createGithubAccessToken(githubSession), token_type: 'bearer' })
  if (!(await isCmsAdminRequest(c))) return json(c, { detail: '登录会话已失效' }, 401)
  return json(c, { detail: '登录会话已失效' }, 401)
})

githubApi.post('/api/v1/auth/logout', requireAdmin, async (c) => {
  deleteCookie(c, 'github_admin_token', { path: '/' })
  return new Response(null, { status: 204 })
})

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

/** 后台单篇 Markdown 下载；内容来自 GitHub，直接返回文件响应。 */
githubApi.get('/api/v1/posts/:slug/download', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const post = await getContentPost(c.req.param('slug'))
  if (!post) return json(c, { detail: '文章不存在' }, 404)
  return new Response(post.content_md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(post.slug)}.md"` } })
})

/** GitHub 模式下导入接口保留契约，实际写入仍应通过文章编辑器完成。 */
githubApi.post('/api/v1/posts/import-preview', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = await c.req.parseBody()
  const files = Object.values(body).filter((value): value is File => value instanceof File && value.name.toLowerCase().endsWith('.md'))
  return json(c, await Promise.all(files.map(async (file) => ({ filename: file.name, title: file.name.replace(/\.md$/i, ''), slug: contentSlug(file.name.replace(/\.md$/i, ''), crypto.randomUUID()) }))))
})

githubApi.post('/api/v1/posts/import-batch', requireAdmin, (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { detail: '请在文章编辑器中粘贴 Markdown 后保存，避免批量导入覆盖现有内容' }, 422)
})

githubApi.post('/api/v1/posts/download-jobs', requireAdmin, (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { detail: 'GitHub 无数据库模式不支持服务端 ZIP 打包，请逐篇下载 Markdown' }, 422)
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
  }, await githubIdentityFromRequest(c))
  return json(c, { ...post, content_html: await marked.parse(post.content_md) }, 201)
})

githubApi.put('/api/v1/posts/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentPost(c.req.param('slug'))
  if (!current) return json(c, { detail: '文章不存在' }, 404)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const post = await saveContentPost({ ...current, ...(body || {}), slug: current.slug }, await githubIdentityFromRequest(c))
  return json(c, { ...post, content_html: await marked.parse(post.content_md) })
})

githubApi.delete('/api/v1/posts/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return (await deleteContentPost(c.req.param('slug'), await githubIdentityFromRequest(c)))
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
  const item = await saveContentGallery(parsed.data, await githubIdentityFromRequest(c))
  return json(c, { ...item, content_html: await marked.parse(item.content_md) }, 201)
})

githubApi.put('/api/v1/gallery/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentGallery(c.req.param('slug'))
  if (!current) return json(c, { detail: '项目不存在' }, 404)
  const parsed = gallerySchema.partial().safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '项目参数不正确' }, 422)
  const item = await saveContentGallery({ ...current, ...parsed.data, slug: current.slug }, await githubIdentityFromRequest(c))
  return json(c, { ...item, content_html: await marked.parse(item.content_md) })
})

githubApi.delete('/api/v1/gallery/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return (await deleteContentGallery(c.req.param('slug'), await githubIdentityFromRequest(c)))
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
  await saveJson(c, 'friends-exchange.json', value, '更新友链交换信息')
  return json(c, value)
})

githubApi.post('/api/v1/friends', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => null)) as Partial<FriendRecord> | null
  if (!body || typeof body.name !== 'string' || typeof body.url !== 'string') return json(c, { detail: '友链参数不正确' }, 422)
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  const item: FriendRecord = { id: Date.now(), name: body.name.trim(), bio: String(body.bio || ''), avatar: String(body.avatar || ''), url: body.url.trim(), sort_order: Number(body.sort_order || 0), created_at: new Date().toISOString() }
  items.push(item)
  await saveJson(c, 'friends.json', items, `添加友链：${item.name}`)
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
  await saveJson(c, 'friends.json', items, `更新友链：${items[index].name}`)
  return json(c, items[index])
})

githubApi.delete('/api/v1/friends/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = normalizeFriends(await getContentJson('friends.json', defaultFriends))
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return json(c, { detail: '友链不存在' }, 404)
  await saveJson(c, 'friends.json', next, `删除友链：${id}`)
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
  await saveJson(c, 'profile.json', next, '更新个人资料')
  return json(c, next)
})

githubApi.post('/api/v1/profile/social-links', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const current = await getContentJson('profile.json', defaultProfile)
  const body = (await c.req.json().catch(() => ({}))) as Partial<ProfileRecord['social_links'][number]>
  const link = { id: Date.now(), label: String(body.label || ''), icon: String(body.icon || ''), url: String(body.url || ''), sort_order: Number(body.sort_order || 0) }
  if (!link.label || !link.url) return json(c, { detail: '社交链接参数不正确' }, 422)
  const next = { ...current, social_links: [...(current.social_links || []), link] }
  await saveJson(c, 'profile.json', next, `添加社交链接：${link.label}`)
  return json(c, link, 201)
})

githubApi.delete('/api/v1/profile/social-links/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const current = await getContentJson('profile.json', defaultProfile)
  const links = (current.social_links || []).filter((link) => link.id !== id)
  if (links.length === (current.social_links || []).length) return json(c, { detail: '社交链接不存在' }, 404)
  await saveJson(c, 'profile.json', { ...current, social_links: links }, `删除社交链接：${id}`)
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
  await saveJson(c, 'about.json', value, '更新关于页内容')
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
  storage?: 'github' | 'r2'
}

interface GithubBackgroundRecord {
  id: number
  image_id: number | null
  media_type: 'image' | 'video'
  media_url: string
  poster_url: string
  mime_type: string
  file_size: number
  theme: string
  device: string
  sort_order: number
  created_at: string
  updated_at: string
}

/** GitHub 内容模式下的相册记录；照片关联与相册一起保存在 albums.json。 */
interface GithubAlbumPhoto {
  id: number
  image_id: number
  caption: string | null
  sort_order: number
  created_at: string
}

interface GithubAlbumRecord {
  id: number
  title: string
  description: string
  orientation: 'landscape' | 'portrait'
  cover_image_id: number | null
  date: string
  photos: GithubAlbumPhoto[]
  created_at: string
  updated_at: string
}

interface GithubAlbumPhotoOutput {
  id: number
  url: string
  caption: string | null
  sort_order: number
  created_at: string
}

interface GithubAlbumOutput {
  id: number
  title: string
  description: string
  orientation: 'landscape' | 'portrait'
  cover_image_id: number | null
  cover_url: string
  photo_count: number
  date: string
  created_at: string
  updated_at: string
  preview_photos: GithubAlbumPhotoOutput[]
  photos: GithubAlbumPhotoOutput[]
}

const GITHUB_MEDIA_LIMIT = 8 * 1024 * 1024

const defaultBooks: BookRecord[] = []

function books(value: unknown): BookRecord[] {
  return Array.isArray(value) ? value.filter((item): item is BookRecord => Boolean(item && typeof item === 'object' && typeof (item as BookRecord).slug === 'string')) : defaultBooks
}

function bookOutput(book: BookRecord): BookRecord {
  return { ...book, cover_url: resolveStorageUrl(book.cover_url), file_path: resolveStorageUrl(book.file_path) }
}

function storageKey(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''))
    } catch {
      return ''
    }
  }
  return value.replace(/^\/+/, '')
}

async function extractBookCover(filePath: string): Promise<string> {
  const key = storageKey(filePath)
  if (!key) return ''
  const cover = extractEpubCover(await getObject(key))
  if (!cover) return ''
  const coverKey = `book-covers/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}${cover.extension}`
  return putObject(coverKey, cover.bytes, cover.contentType)
}

function albums(value: unknown): GithubAlbumRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): GithubAlbumRecord[] => {
    if (!item || typeof item !== 'object') return []
    const source = item as Partial<GithubAlbumRecord>
    if (typeof source.id !== 'number' || typeof source.title !== 'string') return []
    const now = new Date().toISOString()
    return [{
      id: source.id,
      title: source.title,
      description: typeof source.description === 'string' ? source.description : '',
      orientation: source.orientation === 'landscape' ? 'landscape' : 'portrait',
      cover_image_id: typeof source.cover_image_id === 'number' ? source.cover_image_id : null,
      date: typeof source.date === 'string' && source.date ? source.date : now.slice(0, 7).replace('-', '.'),
      photos: Array.isArray(source.photos) ? source.photos.filter((photo): photo is GithubAlbumPhoto => Boolean(
        photo && typeof photo === 'object' && typeof (photo as GithubAlbumPhoto).id === 'number' && typeof (photo as GithubAlbumPhoto).image_id === 'number',
      )) : [],
      created_at: typeof source.created_at === 'string' ? source.created_at : now,
      updated_at: typeof source.updated_at === 'string' ? source.updated_at : now,
    }]
  })
}

function albumOutput(album: GithubAlbumRecord, media: MediaRecord[]): GithubAlbumOutput {
  const byId = new Map(media.map((item) => [item.id, item]))
  const photos = album.photos
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map((photo) => {
      const image = byId.get(photo.image_id)
      return image
        ? { id: photo.id, url: resolveStorageUrl(image.url), caption: photo.caption, sort_order: photo.sort_order, created_at: photo.created_at }
        : null
    })
    .filter((photo): photo is { id: number; url: string; caption: string | null; sort_order: number; created_at: string } => photo !== null)
  const cover = byId.get(album.cover_image_id ?? 0) || (photos[0] ? media.find((item) => resolveStorageUrl(item.url) === photos[0].url) : undefined)
  return {
    id: album.id,
    title: album.title,
    description: album.description,
    orientation: album.orientation,
    cover_image_id: album.cover_image_id,
    cover_url: resolveStorageUrl(cover?.url || ''),
    photo_count: photos.length,
    date: album.date,
    created_at: album.created_at,
    updated_at: album.updated_at,
    preview_photos: photos.slice(0, 3),
    photos,
  }
}

function backgrounds(value: unknown): GithubBackgroundRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): GithubBackgroundRecord[] => {
    if (!item || typeof item !== 'object') return []
    const source = item as Partial<GithubBackgroundRecord>
    if (typeof source.id !== 'number' || typeof source.theme !== 'string' || typeof source.device !== 'string') return []
    return [{
      id: source.id,
      image_id: typeof source.image_id === 'number' ? source.image_id : null,
      media_type: source.media_type === 'video' ? 'video' : 'image',
      media_url: typeof source.media_url === 'string' ? source.media_url : '',
      poster_url: typeof source.poster_url === 'string' ? source.poster_url : '',
      mime_type: typeof source.mime_type === 'string' ? source.mime_type : '',
      file_size: typeof source.file_size === 'number' ? source.file_size : 0,
      theme: source.theme,
      device: source.device,
      sort_order: typeof source.sort_order === 'number' ? source.sort_order : 0,
      created_at: typeof source.created_at === 'string' ? source.created_at : new Date().toISOString(),
      updated_at: typeof source.updated_at === 'string' ? source.updated_at : new Date().toISOString(),
    }]
  })
}

function backgroundOutput(item: GithubBackgroundRecord, images: MediaRecord[]): Record<string, unknown> {
  const image = item.image_id == null ? undefined : images.find((entry) => entry.id === item.image_id)
  const url = item.media_type === 'image' ? image?.url || item.media_url : item.media_url
  return {
    id: item.id,
    url: resolveStorageUrl(url),
    theme: item.theme,
    device: item.device,
    sort_order: item.sort_order,
    created_at: item.created_at,
    media_type: item.media_type,
    poster_url: resolveStorageUrl(item.poster_url),
    mime_type: item.mime_type || image?.mime_type || '',
    file_size: item.file_size || image?.file_size || 0,
  }
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

/**
 * GitHub 内容模式不建立服务端 ZIP 任务队列；保留稳定的空列表契约，
 * 让文件管理页不会回退到数据库路由并触发 404。
 */
githubApi.get('/api/v1/books/download-jobs', requireAdmin, (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { items: [], total: 0 })
})

githubApi.post('/api/v1/books/download-jobs', requireAdmin, (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { detail: 'GitHub 无数据库模式不支持服务端 ZIP 打包，请直接下载 EPUB 文件' }, 422)
})

githubApi.get('/api/v1/books/download-jobs/:id', requireAdmin, (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { detail: 'GitHub 无数据库模式没有 ZIP 任务' }, 404)
})

githubApi.get('/api/v1/books/:slug/read', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const book = books(await getContentJson('books.json', defaultBooks)).find((item) => item.slug === c.req.param('slug'))
  return book ? c.redirect(resolveStorageUrl(book.file_path)) : json(c, { detail: '图书不存在' }, 404)
})

/** 后台单本下载与阅读共用 R2 公共地址。 */
githubApi.get('/api/v1/books/:slug/download', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const book = books(await getContentJson('books.json', defaultBooks)).find((item) => item.slug === c.req.param('slug'))
  return book ? c.redirect(resolveStorageUrl(book.file_path)) : json(c, { detail: '图书不存在' }, 404)
})

/** 读取 EPUB 内可选封面；无数据库模式通过 R2 对象解析。 */
githubApi.get('/api/v1/books/:slug/cover-candidates', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法读取 EPUB' }, 503)
  const book = books(await getContentJson('books.json', defaultBooks)).find((item) => item.slug === c.req.param('slug'))
  if (!book) return json(c, { detail: '图书不存在' }, 404)
  return json(c, [])
})

githubApi.post('/api/v1/books/:slug/select-cover', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  return json(c, { detail: '当前 EPUB 未提供可选封面列表' }, 422)
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
  await saveJson(c, 'books.json', currentItems, `更新图书：${next.title}`)
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
  await saveJson(c, 'books.json', ordered, '调整图书排序')
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
  await putObject(key, new Uint8Array(await file.arrayBuffer()), 'application/epub+zip')
  const fileUrl = resolveStorageUrl(key)
  let coverUrl = ''
  try {
    coverUrl = await extractBookCover(key)
  } catch (error) {
    // 封面解析失败不应回滚已经上传成功的 EPUB；管理员仍可手动上传封面。
    console.warn('[github-books] EPUB 封面提取失败', error)
  }
  const now = new Date().toISOString()
  const book: BookRecord = { id: Date.now(), slug, title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : file.name.replace(/\.epub$/i, ''), author: typeof body.author === 'string' ? body.author.trim() : '', description: typeof body.description === 'string' ? body.description.trim() : '', cover_url: coverUrl, file_path: fileUrl, sort_order: all.length, created_at: now, updated_at: now }
  all.push(book)
  await saveJson(c, 'books.json', all, `添加图书：${book.title}`)
  return json(c, bookOutput(book), 201)
})

/** 为已上传但没有封面的图书重新从 R2 EPUB 中提取封面。 */
githubApi.post('/api/v1/books/:slug/extract-cover', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法提取 EPUB 封面' }, 503)
  const items = books(await getContentJson('books.json', defaultBooks))
  const index = items.findIndex((item) => item.slug === c.req.param('slug'))
  if (index < 0) return json(c, { detail: '图书不存在' }, 404)
  const coverUrl = await extractBookCover(items[index].file_path)
  if (!coverUrl) return json(c, { detail: 'EPUB 内未找到可识别的封面图片' }, 422)
  items[index] = { ...items[index], cover_url: coverUrl, updated_at: new Date().toISOString() }
  await saveJson(c, 'books.json', items, `重新提取图书封面：${items[index].title}`)
  return json(c, bookOutput(items[index]))
})

githubApi.delete('/api/v1/books/:slug', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const all = books(await getContentJson('books.json', defaultBooks))
  const next = all.filter((book) => book.slug !== c.req.param('slug'))
  if (next.length === all.length) return json(c, { detail: '图书不存在' }, 404)
  await saveJson(c, 'books.json', next, `删除图书：${c.req.param('slug')}`)
  return new Response(null, { status: 204 })
})

/** 媒体索引保存在 GitHub JSON；配置 R2 时文件放 R2，否则放 GitHub media 目录。 */
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
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) return json(c, { detail: '缺少上传文件' }, 422)
  const requestedStorage = body.storage === 'github' || body.storage === 'r2'
    ? body.storage
    : c.req.query('storage') === 'github' || c.req.query('storage') === 'r2'
      ? (c.req.query('storage') as 'github' | 'r2')
      : undefined
  const storage: 'github' | 'r2' = requestedStorage || (r2Enabled() ? 'r2' : 'github')
  if (storage === 'r2' && !r2Enabled()) return json(c, { detail: `R2 配置无效：${r2ConfigIssues().join('；')}；请修正配置或选择 GitHub 存储` }, 503)
  if (resource === 'images' && !file.type.startsWith('image/')) return json(c, { detail: '仅支持图片文件' }, 400)
  const safeName = file.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'upload'
  const key = `${resource}/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}_${safeName}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > GITHUB_MEDIA_LIMIT && !r2Enabled()) return json(c, { detail: '未配置 R2 时，GitHub 媒体文件不能超过 8MB' }, 413)
  const url = storage === 'r2'
    ? await putObject(key, bytes, file.type || 'application/octet-stream')
    : githubRawUrl(githubContentPath(`media/${key}`))
  if (storage === 'github') await putGithubFile(githubContentPath(`media/${key}`), bytes, `上传${resource === 'images' ? '图片' : '文件'}：${file.name}`, undefined, await githubIdentityFromRequest(c))
  const now = new Date().toISOString()
  const record: MediaRecord = {
    id: Date.now(),
    filename: storage === 'r2' ? key : githubContentPath(`media/${key}`),
    original_name: file.name,
    url,
    file_size: bytes.byteLength,
    ...(resource === 'images' ? { width: 0, height: 0 } : {}),
    mime_type: file.type || 'application/octet-stream',
    created_at: now,
    storage,
  }
  const items = await readMedia(resource)
  items.unshift(record)
  await saveJson(c, mediaFile(resource), items, `上传${resource === 'images' ? '图片' : '文件'}：${file.name}`)
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
  await saveJson(c, mediaFile('files'), items, `直传文件：${originalName}`)
  return json(c, record, 201)
})

for (const resource of ['images', 'files'] as const) {
  githubApi.get(`/api/v1/${resource}`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await readMedia(resource)
    const page = parsePage(c.req.query('page'), 1, 10_000)
    const pageSize = parseLimit(c.req.query('page_size'), 50, 200)
    return json(c, { items: items.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ ...item, storage: item.storage || (item.filename.startsWith(`${config.githubContentRoot}/`) ? 'github' : 'r2'), url: resolveStorageUrl(item.url) })), total: items.length })
  })
  githubApi.post(`/api/v1/${resource}/upload`, requireAdmin, (c) => uploadMedia(c, resource))
  githubApi.delete(`/api/v1/${resource}/:id`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const id = Number(c.req.param('id'))
    const items = await readMedia(resource)
    const item = items.find((entry) => entry.id === id)
    if (!item) return json(c, { detail: `${resource === 'images' ? '图片' : '文件'}不存在` }, 404)
    const itemStorage = item.storage || (item.filename.startsWith(`${config.githubContentRoot}/`) ? 'github' : 'r2')
    if (itemStorage === 'r2') await deleteObject(item.filename)
    else {
      const current = await getGithubFile(item.filename)
      if (current) await deleteGithubFile(item.filename, `删除${resource === 'images' ? '图片' : '文件'}：${item.original_name}`, current.sha, await githubIdentityFromRequest(c))
    }
    await saveJson(c, mediaFile(resource), items.filter((entry) => entry.id !== id), `删除${resource === 'images' ? '图片' : '文件'}：${item.original_name}`)
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

githubApi.get('/api/v1/backgrounds', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const theme = c.req.query('theme') || ''
  const device = c.req.query('device') || ''
  const items = backgrounds(await getContentJson('backgrounds.json', []))
    .filter((item) => (!theme || item.theme === theme) && (!device || item.device === device))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  const images = await readMedia('images')
  return json(c, { items: items.map((item) => backgroundOutput(item, images)), total: items.length })
})

githubApi.post('/api/v1/backgrounds', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as Partial<GithubBackgroundRecord>
  const items = backgrounds(await getContentJson('backgrounds.json', []))
  const imageId = typeof body.image_id === 'number' ? body.image_id : null
  const images = await readMedia('images')
  if (body.media_type !== 'video' && imageId != null && !images.some((image) => image.id === imageId)) return json(c, { detail: '图片不存在' }, 404)
  const now = new Date().toISOString()
  const item: GithubBackgroundRecord = {
    id: Date.now(),
    image_id: imageId,
    media_type: body.media_type === 'video' ? 'video' : 'image',
    media_url: typeof body.media_url === 'string' ? body.media_url : '',
    poster_url: typeof body.poster_url === 'string' ? body.poster_url : '',
    mime_type: typeof body.mime_type === 'string' ? body.mime_type : '',
    file_size: typeof body.file_size === 'number' ? body.file_size : 0,
    theme: body.theme === 'light' ? 'light' : 'dark',
    device: body.device === 'mobile' ? 'mobile' : 'desktop',
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : items.length,
    created_at: now,
    updated_at: now,
  }
  if (item.media_type === 'image' && item.image_id == null) return json(c, { detail: '请选择图片' }, 422)
  if (item.media_type === 'video' && !item.media_url) return json(c, { detail: '视频地址不能为空' }, 422)
  items.push(item)
  await saveJson(c, 'backgrounds.json', items, `添加背景：${item.theme}/${item.device}`)
  return json(c, backgroundOutput(item, images), 201)
})

githubApi.put('/api/v1/backgrounds/reorder', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; theme?: unknown; device?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : []
  const theme = typeof body.theme === 'string' ? body.theme : ''
  const device = typeof body.device === 'string' ? body.device : ''
  const items = backgrounds(await getContentJson('backgrounds.json', []))
  const order = new Map(ids.map((id, index) => [id, index]))
  items.forEach((item) => {
    if ((!theme || item.theme === theme) && (!device || item.device === device) && order.has(item.id)) item.sort_order = order.get(item.id) || 0
    item.updated_at = new Date().toISOString()
  })
  await saveJson(c, 'backgrounds.json', items, '调整背景顺序')
  const images = await readMedia('images')
  return json(c, { items: items.map((item) => backgroundOutput(item, images)), total: items.length })
})

githubApi.delete('/api/v1/backgrounds/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = backgrounds(await getContentJson('backgrounds.json', []))
  if (!items.some((item) => item.id === id)) return json(c, { detail: '背景不存在' }, 404)
  await saveJson(c, 'backgrounds.json', items.filter((item) => item.id !== id), `删除背景：${id}`)
  return new Response(null, { status: 204 })
})

/** GitHub 内容模式下的相册与照片关联。图片文件和索引来自 media-images.json，相册关系来自 albums.json。 */
githubApi.get('/api/v1/albums', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = albums(await getContentJson('albums.json', []))
  const media = await readMedia('images')
  return json(c, { items: items.map((item) => albumOutput(item, media)), total: items.length })
})

githubApi.get('/api/v1/albums/:id', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const item = albums(await getContentJson('albums.json', [])).find((entry) => entry.id === id)
  if (!item) return json(c, { detail: '相册不存在' }, 404)
  return json(c, albumOutput(item, await readMedia('images')))
})

githubApi.post('/api/v1/albums', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as Partial<GithubAlbumRecord>
  if (typeof body.title !== 'string' || !body.title.trim()) return json(c, { detail: '相册标题不能为空' }, 422)
  const now = new Date().toISOString()
  const item: GithubAlbumRecord = {
    id: Date.now(),
    title: body.title.trim(),
    description: typeof body.description === 'string' ? body.description : '',
    orientation: body.orientation === 'landscape' ? 'landscape' : 'portrait',
    cover_image_id: typeof body.cover_image_id === 'number' ? body.cover_image_id : null,
    date: typeof body.date === 'string' && body.date ? body.date : now.slice(0, 7).replace('-', '.'),
    photos: [],
    created_at: now,
    updated_at: now,
  }
  const items = albums(await getContentJson('albums.json', []))
  items.unshift(item)
  await saveJson(c, 'albums.json', items, `创建相册：${item.title}`)
  return json(c, albumOutput(item, await readMedia('images')), 201)
})

githubApi.put('/api/v1/albums/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = albums(await getContentJson('albums.json', []))
  const index = items.findIndex((entry) => entry.id === id)
  if (index < 0) return json(c, { detail: '相册不存在' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as Partial<GithubAlbumRecord>
  const current = items[index]
  items[index] = {
    ...current,
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : current.title,
    description: typeof body.description === 'string' ? body.description : current.description,
    orientation: body.orientation === 'landscape' ? 'landscape' : body.orientation === 'portrait' ? 'portrait' : current.orientation,
    cover_image_id: body.cover_image_id === null || typeof body.cover_image_id === 'number' ? body.cover_image_id : current.cover_image_id,
    updated_at: new Date().toISOString(),
  }
  await saveJson(c, 'albums.json', items, `更新相册：${items[index].title}`)
  return json(c, albumOutput(items[index], await readMedia('images')))
})

githubApi.delete('/api/v1/albums/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = albums(await getContentJson('albums.json', []))
  const item = items.find((entry) => entry.id === id)
  if (!item) return json(c, { detail: '相册不存在' }, 404)
  await saveJson(c, 'albums.json', items.filter((entry) => entry.id !== id), `删除相册：${item.title}`)
  return new Response(null, { status: 204 })
})

githubApi.post('/api/v1/albums/:id/photos', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = albums(await getContentJson('albums.json', []))
  const album = items.find((entry) => entry.id === id)
  const body = (await c.req.json().catch(() => ({}))) as { image_id?: unknown }
  const imageId = typeof body.image_id === 'number' ? body.image_id : Number(body.image_id)
  const image = (await readMedia('images')).find((entry) => entry.id === imageId)
  if (!album) return json(c, { detail: '相册不存在' }, 404)
  if (!image) return json(c, { detail: '图片不存在' }, 404)
  if (album.photos.some((photo) => photo.image_id === imageId)) return json(c, { detail: '图片已在相册中' }, 409)
  const photo: GithubAlbumPhoto = { id: Date.now(), image_id: imageId, caption: null, sort_order: album.photos.length, created_at: new Date().toISOString() }
  album.photos.push(photo)
  album.updated_at = new Date().toISOString()
  await saveJson(c, 'albums.json', items, `添加照片到相册：${album.title}`)
  const output = albumOutput(album, [image])
  return json(c, output.photos[output.photos.length - 1] || photo, 201)
})

githubApi.put('/api/v1/albums/:id/photos/:photoId', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const photoId = Number(c.req.param('photoId'))
  const items = albums(await getContentJson('albums.json', []))
  const album = items.find((entry) => entry.id === id)
  const photo = album?.photos.find((entry) => entry.id === photoId)
  if (!album || !photo) return json(c, { detail: '照片不存在' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { caption?: unknown }
  photo.caption = typeof body.caption === 'string' ? body.caption : photo.caption
  album.updated_at = new Date().toISOString()
  await saveJson(c, 'albums.json', items, `更新相册照片：${album.title}`)
  const output = albumOutput(album, await readMedia('images'))
  return json(c, output.photos.find((entry) => entry.id === photoId) || photo)
})

githubApi.delete('/api/v1/albums/:id/photos/:photoId', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const photoId = Number(c.req.param('photoId'))
  const items = albums(await getContentJson('albums.json', []))
  const album = items.find((entry) => entry.id === id)
  if (!album || !album.photos.some((entry) => entry.id === photoId)) return json(c, { detail: '照片不存在' }, 404)
  album.photos = album.photos.filter((entry) => entry.id !== photoId).map((entry, index) => ({ ...entry, sort_order: index }))
  album.updated_at = new Date().toISOString()
  await saveJson(c, 'albums.json', items, `删除相册照片：${album.title}`)
  return new Response(null, { status: 204 })
})

/** 其他低频 CMS JSON 资源统一采用相同 CRUD 结构。 */
/** 将 GitHub 中可能来自旧版本的说说记录补齐为前端稳定契约。 */
function normalizeMomentRecord(value: Record<string, unknown>): Record<string, unknown> {
  const createdAt = typeof value.created_at === 'string' ? value.created_at : ''
  return {
    ...value,
    id: Number(value.id) || Date.now(),
    date: typeof value.date === 'string' && value.date ? value.date : createdAt,
    content: typeof value.content === 'string' ? value.content : '',
    mood: typeof value.mood === 'string' ? value.mood : '',
    mood_text: typeof value.mood_text === 'string' ? value.mood_text : '',
    tags: Array.isArray(value.tags) ? value.tags.filter((item): item is string => typeof item === 'string') : [],
    images: Array.isArray(value.images) ? value.images.filter((item): item is string => typeof item === 'string') : [],
    likes: Number.isFinite(Number(value.likes)) ? Number(value.likes) : 0,
  }
}

interface GithubCommentRecord {
  id: number
  page_key: string
  parent_id: number | null
  author: string
  author_login: string
  author_email: string
  avatar_color: string
  avatar_url: string
  content: string
  created_at: string
}

interface GithubMomentCommentRecord {
  id: number
  moment_id: number
  nickname: string
  author_login: string
  content: string
  date: string
  likes: number
}

async function readGithubComments(): Promise<GithubCommentRecord[]> {
  const value = await getContentJson<unknown>('comments.json', [])
  if (!Array.isArray(value)) return []
  return value.filter((item): item is GithubCommentRecord => Boolean(
    item && typeof item === 'object' &&
    typeof (item as GithubCommentRecord).id === 'number' &&
    typeof (item as GithubCommentRecord).page_key === 'string' &&
    typeof (item as GithubCommentRecord).content === 'string',
  )).map((item) => ({
    ...item,
    parent_id: typeof item.parent_id === 'number' ? item.parent_id : null,
    author: item.author || item.author_login || 'GitHub 用户',
    author_login: item.author_login || '',
    author_email: item.author_email || '',
    avatar_color: item.avatar_color || '#6366f1',
    avatar_url: item.avatar_url || (item.author_login ? `https://github.com/${item.author_login}.png` : ''),
    created_at: item.created_at || new Date().toISOString(),
  }))
}

async function readGithubMomentComments(): Promise<GithubMomentCommentRecord[]> {
  const value = await getContentJson<unknown>('moment-comments.json', [])
  if (!Array.isArray(value)) return []
  return value.filter((item): item is GithubMomentCommentRecord => Boolean(
    item && typeof item === 'object' &&
    typeof (item as GithubMomentCommentRecord).id === 'number' &&
    typeof (item as GithubMomentCommentRecord).moment_id === 'number' &&
    typeof (item as GithubMomentCommentRecord).content === 'string',
  )).map((item) => ({ ...item, likes: Number(item.likes) || 0, date: item.date || new Date().toISOString() }))
}

function commentTree(items: GithubCommentRecord[], identityLogin = ''): Array<Record<string, unknown>> {
  const children = new Map<number | null, GithubCommentRecord[]>()
  for (const item of items) {
    const list = children.get(item.parent_id) || []
    list.push(item)
    children.set(item.parent_id, list)
  }
  const build = (parentId: number | null): Array<Record<string, unknown>> => (children.get(parentId) || []).map((item) => ({
    id: item.id,
    user_id: null,
    author: item.author,
    date: item.created_at,
    content: item.content,
    avatar_color: item.avatar_color,
    avatar_url: item.avatar_url,
    can_delete: Boolean(identityLogin && item.author_login === identityLogin),
    children: build(item.id),
  }))
  return build(null)
}

function findCommentOutput(items: GithubCommentRecord[], id: number, identityLogin: string): Record<string, unknown> | null {
  const walk = (nodes: Array<Record<string, unknown>>): Record<string, unknown> | null => {
    for (const node of nodes) {
      if (node.id === id) return node
      const found = walk(Array.isArray(node.children) ? node.children as Array<Record<string, unknown>> : [])
      if (found) return found
    }
    return null
  }
  return walk(commentTree(items, identityLogin))
}

/** GitHub 模式的页面评论，数据和嵌套回复保存在 comments.json。 */
githubApi.get('/api/v1/comments', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const pageKey = c.req.query('page_key')?.trim()
  if (!pageKey) return json(c, { detail: '页面标识不正确' }, 422)
  const items = (await readGithubComments()).filter((item) => item.page_key === pageKey)
  const identity = await githubIdentityFromRequest(c)
  return json(c, { items: commentTree(items, identity?.login || ''), total: items.length })
})

githubApi.get('/api/v1/comments/count', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const pageKey = c.req.query('page_key') || ''
  const count = (await readGithubComments()).filter((item) => item.page_key === pageKey).length
  return json(c, { page_key: pageKey, count })
})

githubApi.post('/api/v1/comments/batch-count', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = await c.req.json().catch(() => null) as { page_keys?: unknown } | null
  const keys = Array.isArray(body?.page_keys) ? body.page_keys.filter((key): key is string => typeof key === 'string').slice(0, 100) : []
  const all = await readGithubComments()
  return json(c, Object.fromEntries(keys.map((key) => [key, all.filter((item) => item.page_key === key).length])))
})

githubApi.post('/api/v1/comments', requireGithubLogin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = await c.req.json().catch(() => null) as { page_key?: unknown; content?: unknown; parent_id?: unknown } | null
  const pageKey = typeof body?.page_key === 'string' ? body.page_key.trim() : ''
  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!pageKey || pageKey.length > 300 || !content || content.length > 2000) return json(c, { detail: '评论参数不正确' }, 422)
  const parentId = Number.isInteger(body?.parent_id) ? Number(body?.parent_id) : null
  const items = await readGithubComments()
  if (parentId !== null && !items.some((item) => item.id === parentId && item.page_key === pageKey)) return json(c, { detail: '回复目标不存在' }, 404)
  const identity = await githubIdentityFromRequest(c)
  if (!identity) return json(c, { detail: '未登录或登录已过期' }, 401)
  const item: GithubCommentRecord = {
    id: Date.now(), page_key: pageKey, parent_id: parentId,
    author: identity.name || identity.login, author_login: identity.login, author_email: identity.email,
    avatar_color: '#6366f1', avatar_url: `https://github.com/${identity.login}.png`, content, created_at: new Date().toISOString(),
  }
  items.push(item)
  await saveJson(c, 'comments.json', items, `发表评论：${pageKey}`)
  return json(c, findCommentOutput(items, item.id, identity.login), 201)
})

githubApi.delete('/api/v1/comments/:id', requireGithubLogin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = await readGithubComments()
  const item = items.find((entry) => entry.id === id)
  if (!item) return json(c, { detail: '评论不存在' }, 404)
  const identity = await githubIdentityFromRequest(c)
  if (!identity || (item.author_login !== identity.login && identity.login !== config.githubRepository.split('/')[0]?.toLowerCase())) return json(c, { detail: '评论不存在或无权删除' }, 404)
  await saveJson(c, 'comments.json', items.filter((entry) => entry.id !== id), `删除评论：${id}`)
  return new Response(null, { status: 204 })
})

/** GitHub 模式的说说评论。 */
githubApi.get('/api/v1/moments/:id/comments', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  return json(c, (await readGithubMomentComments()).filter((item) => item.moment_id === id))
})

githubApi.post('/api/v1/moments/:id/like', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const momentId = Number(c.req.param('id'))
  const items = await getContentJson<Array<Record<string, unknown>>>('moments.json', [])
  const index = items.findIndex((item) => Number(item.id) === momentId)
  if (index < 0) return json(c, { detail: '说说不存在' }, 404)
  const current = normalizeMomentRecord(items[index])
  const likes = Number(current.likes) + 1
  items[index] = { ...items[index], likes, updated_at: new Date().toISOString() }
  await saveJson(c, 'moments.json', items, `点赞说说：${momentId}`)
  return json(c, { likes })
})

githubApi.post('/api/v1/moments/:id/comments', requireGithubLogin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const momentId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => null) as { content?: unknown } | null
  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!content || content.length > 2000) return json(c, { detail: '评论内容不正确' }, 422)
  const identity = await githubIdentityFromRequest(c)
  if (!identity) return json(c, { detail: '未登录或登录已过期' }, 401)
  const allMoments = await getContentJson<Array<Record<string, unknown>>>('moments.json', [])
  if (!allMoments.some((item) => Number(item.id) === momentId)) return json(c, { detail: '说说不存在' }, 404)
  const items = await readGithubMomentComments()
  const item: GithubMomentCommentRecord = { id: Date.now(), moment_id: momentId, nickname: identity.name || identity.login, author_login: identity.login, content, date: new Date().toISOString(), likes: 0 }
  items.push(item)
  await saveJson(c, 'moment-comments.json', items, `发表说说评论：${momentId}`)
  return json(c, item, 201)
})

githubApi.delete('/api/v1/moments/:id/comments/:commentId', requireGithubLogin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const momentId = Number(c.req.param('id'))
  const commentId = Number(c.req.param('commentId'))
  const items = await readGithubMomentComments()
  const item = items.find((entry) => entry.id === commentId && entry.moment_id === momentId)
  if (!item) return json(c, { detail: '评论不存在' }, 404)
  const identity = await githubIdentityFromRequest(c)
  if (!identity || (item.author_login !== identity.login && identity.login !== config.githubRepository.split('/')[0]?.toLowerCase())) return json(c, { detail: '评论不存在或无权删除' }, 404)
  await saveJson(c, 'moment-comments.json', items.filter((entry) => entry.id !== commentId), `删除说说评论：${commentId}`)
  return new Response(null, { status: 204 })
})

interface GithubTavernRecord {
  id: number
  author: string
  topic: string
  body: string
  is_visible: boolean
  created_at: string
}

function tavernRecords(value: unknown): GithubTavernRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): GithubTavernRecord[] => {
    if (!item || typeof item !== 'object') return []
    const source = item as Partial<GithubTavernRecord>
    if (typeof source.id !== 'number' || typeof source.author !== 'string' || typeof source.body !== 'string') return []
    return [{
      id: source.id,
      author: source.author,
      topic: typeof source.topic === 'string' ? source.topic : '',
      body: source.body,
      is_visible: source.is_visible !== false,
      created_at: typeof source.created_at === 'string' ? source.created_at : new Date().toISOString(),
    }]
  })
}

/** 深夜酒馆在无数据库模式下保存到 tavern.json。 */
githubApi.get('/api/v1/tavern', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = tavernRecords(await getContentJson<unknown>('tavern.json', []))
    .filter((item) => item.is_visible)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  return json(c, { items: items.map(({ id, author, topic, body, created_at }) => ({ id, author, topic, body, created_at })), total: items.length })
})

githubApi.get('/api/v1/tavern/config', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const value = await getContentJson<unknown>('tavern-config.json', { bg_url: '' })
  return json(c, { bg_url: value && typeof value === 'object' && typeof (value as { bg_url?: unknown }).bg_url === 'string' ? (value as { bg_url: string }).bg_url : '' })
})

githubApi.post('/api/v1/tavern', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = await c.req.json().catch(() => null) as { author?: unknown; topic?: unknown; body?: unknown } | null
  const author = typeof body?.author === 'string' ? body.author.trim() : ''
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : ''
  const message = typeof body?.body === 'string' ? body.body.trim() : ''
  if (!author || !topic || !message || author.length > 100 || topic.length > 200 || message.length > 5000) return json(c, { detail: '留言内容不正确' }, 422)
  const items = tavernRecords(await getContentJson<unknown>('tavern.json', []))
  const item: GithubTavernRecord = { id: Date.now(), author, topic, body: message, is_visible: true, created_at: new Date().toISOString() }
  items.unshift(item)
  await saveJson(c, 'tavern.json', items, `发布酒馆留言：${topic}`)
  return json(c, { id: item.id, author: item.author, topic: item.topic, body: item.body, created_at: item.created_at }, 201)
})

githubApi.get('/api/v1/tavern/all', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = tavernRecords(await getContentJson<unknown>('tavern.json', [])).sort((a, b) => b.created_at.localeCompare(a.created_at))
  return json(c, { items, total: items.length })
})

githubApi.put('/api/v1/tavern/config', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = await c.req.json().catch(() => null) as { bg_url?: unknown } | null
  const bgUrl = typeof body?.bg_url === 'string' ? body.bg_url.trim() : ''
  await saveJson(c, 'tavern-config.json', { bg_url: bgUrl }, '更新酒馆背景图')
  return json(c, { bg_url: bgUrl })
})

githubApi.put('/api/v1/tavern/:id/visibility', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = tavernRecords(await getContentJson<unknown>('tavern.json', []))
  const item = items.find((entry) => entry.id === id)
  if (!item) return json(c, { detail: '留言不存在' }, 404)
  const body = await c.req.json().catch(() => null) as { is_visible?: unknown } | null
  item.is_visible = body?.is_visible !== false
  await saveJson(c, 'tavern.json', items, `${item.is_visible ? '显示' : '隐藏'}酒馆留言：${id}`)
  return json(c, item)
})

githubApi.delete('/api/v1/tavern/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = tavernRecords(await getContentJson<unknown>('tavern.json', []))
  if (!items.some((entry) => entry.id === id)) return json(c, { detail: '留言不存在' }, 404)
  await saveJson(c, 'tavern.json', items.filter((entry) => entry.id !== id), `删除酒馆留言：${id}`)
  return new Response(null, { status: 204 })
})

/** 无数据库部署不记录访问明细，返回稳定的空统计，避免前端加载产生 404/500。 */
githubApi.post('/api/v1/analytics/events', (c) => c.body(null, 204))
githubApi.get('/api/v1/analytics/public-summary', (c) => json(c, { today_pv: 0, today_uv: 0, total_pv: 0, total_uv: 0, trend: [] }))
githubApi.get('/api/v1/analytics/overview', requireAdmin, (c) => json(c, { today_pv: 0, today_uv: 0, yesterday_pv: 0, yesterday_uv: 0, total_pv: 0, total_uv: 0, page_views: 0, book_downloads: 0, zip_downloads: 0 }))
githubApi.get('/api/v1/analytics/trend', requireAdmin, (c) => json(c, []))
githubApi.get('/api/v1/analytics/pages', requireAdmin, (c) => json(c, []))
githubApi.get('/api/v1/analytics/visitors', requireAdmin, (c) => json(c, { items: [], total: 0 }))

interface GithubCarouselRecord {
  id: number
  image_id: number
  sort_order: number
  created_at: string
}

function carouselRecords(value: unknown): GithubCarouselRecord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): GithubCarouselRecord[] => {
    if (!item || typeof item !== 'object') return []
    const source = item as Partial<GithubCarouselRecord>
    if (typeof source.id !== 'number' || typeof source.image_id !== 'number') return []
    return [{
      id: source.id,
      image_id: source.image_id,
      sort_order: typeof source.sort_order === 'number' ? source.sort_order : 0,
      created_at: typeof source.created_at === 'string' ? source.created_at : new Date().toISOString(),
    }]
  })
}

async function carouselOutput(value: unknown): Promise<Array<Record<string, unknown>>> {
  const images = await readMedia('images')
  const imageById = new Map(images.map((image) => [image.id, image]))
  return carouselRecords(value)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .flatMap((item) => {
      const image = imageById.get(item.image_id)
      if (!image) return []
      return [{ id: item.id, url: resolveStorageUrl(image.url), sort_order: item.sort_order, created_at: item.created_at }]
    })
}

/** GitHub 内容模式下的首页轮播图关联。 */
githubApi.get('/api/v1/carousel', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = await carouselOutput(await getContentJson('carousel.json', []))
  return json(c, { items, total: items.length })
})

githubApi.post('/api/v1/carousel', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as { image_id?: unknown; sort_order?: unknown }
  const imageId = typeof body.image_id === 'number' ? body.image_id : Number(body.image_id)
  const images = await readMedia('images')
  if (!Number.isInteger(imageId) || !images.some((image) => image.id === imageId)) return json(c, { detail: '图片不存在' }, 404)
  const items = carouselRecords(await getContentJson('carousel.json', []))
  if (items.some((item) => item.image_id === imageId)) return json(c, { detail: '图片已在轮播中' }, 409)
  const item: GithubCarouselRecord = { id: Date.now(), image_id: imageId, sort_order: typeof body.sort_order === 'number' ? body.sort_order : items.length, created_at: new Date().toISOString() }
  items.push(item)
  await saveJson(c, 'carousel.json', items, '添加轮播图')
  const output = await carouselOutput([item])
  return json(c, output[0] || { detail: '图片不存在' }, 201)
})

githubApi.put('/api/v1/carousel/reorder', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : []
  const items = carouselRecords(await getContentJson('carousel.json', []))
  const order = new Map(ids.map((id, index) => [id, index]))
  items.forEach((item) => { const nextOrder = order.get(item.id); if (nextOrder !== undefined) item.sort_order = nextOrder })
  await saveJson(c, 'carousel.json', items, '调整轮播图顺序')
  const output = await carouselOutput(items)
  return json(c, { items: output, total: output.length })
})

githubApi.delete('/api/v1/carousel/:id', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = carouselRecords(await getContentJson('carousel.json', []))
  if (!items.some((item) => item.id === id)) return json(c, { detail: '轮播图不存在' }, 404)
  await saveJson(c, 'carousel.json', items.filter((item) => item.id !== id), `删除轮播图：${id}`)
  return new Response(null, { status: 204 })
})

function jsonCollection<T extends { id: number }>(resource: string, fallback: T[], label: string) {
  githubApi.get(`/api/v1/${resource}`, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    const source = Array.isArray(items) ? items : fallback
    let output: unknown[] = source
    if (resource === 'moments') {
      const momentComments = await readGithubMomentComments()
      output = source.map((item) => {
        const moment = normalizeMomentRecord(item as unknown as Record<string, unknown>)
        return {
          ...moment,
          comments: momentComments.filter((comment) => comment.moment_id === Number(moment.id)),
        }
      })
    }
    return json(c, { items: output, total: output.length })
  })
  githubApi.post(`/api/v1/${resource}`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    const body = (await c.req.json().catch(() => ({}))) as Partial<T>
    const item = {
      ...body,
      id: Date.now(),
      created_at: new Date().toISOString(),
      ...(resource === 'moments' ? { date: new Date().toISOString() } : {}),
    } as unknown as T
    const next = [...(Array.isArray(items) ? items : fallback), item]
    await saveJson(c, `${resource}.json`, next, `添加${label}`)
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
    await saveJson(c, `${resource}.json`, next, `更新${label}`)
    return json(c, item)
  })
  githubApi.delete(`/api/v1/${resource}/:id`, requireAdmin, async (c) => {
    if (!enabled(c)) return unavailable(c)
    const id = Number(c.req.param('id'))
    const items = await getContentJson<T[]>(`${resource}.json`, fallback)
    const next = (Array.isArray(items) ? items : fallback).filter((item) => item.id !== id)
    if (next.length === (Array.isArray(items) ? items : fallback).length) return json(c, { detail: `${label}不存在` }, 404)
    await saveJson(c, `${resource}.json`, next, `删除${label}`)
    return new Response(null, { status: 204 })
  })
}

jsonCollection('moments', [], '说说')
jsonCollection('treasures', [], '藏宝条目')

githubApi.get('/api/v1/moments/:id', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const id = Number(c.req.param('id'))
  const items = await getContentJson<Array<Record<string, unknown>>>('moments.json', [])
  const item = items.find((entry) => Number(entry.id) === id)
  const comments = (await readGithubMomentComments()).filter((comment) => comment.moment_id === id)
  return item ? json(c, { ...normalizeMomentRecord(item), comments }) : json(c, { detail: '说说不存在' }, 404)
})

githubApi.get('/api/v1/treasures/categories', async (c) => {
  if (!enabled(c)) return unavailable(c)
  const items = await getContentJson<Array<{ category?: string }>>('treasures.json', [])
  return json(c, [...new Set(items.map((item) => item.category).filter((item): item is string => Boolean(item)))])
})

/** 无数据库模式下管理员资料接口返回 synthetic user。 */
githubApi.get('/api/v1/auth/me', requireAdmin, async (c) => {
  if (!enabled(c)) return unavailable(c)
  const identity = await githubIdentityFromRequest(c)
  return json(c, { id: 0, username: identity?.login || 'github-admin', is_admin: true, email: identity?.email || null, display_name: identity?.name || 'GitHub 管理员', avatar_url: identity ? `https://github.com/${identity.login}.png` : '', email_verified: true })
})
