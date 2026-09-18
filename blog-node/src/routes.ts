/** Node API 路由。按模块组织，保持稳定的 /api/v1 契约。 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { marked } from 'marked'
import { createAccessToken, createCmsAccessToken, createSession, hashIp, hashPassword, requireAdmin, refreshSession, revokeSession, requireAuth as authMiddleware, verifyPassword, type AppEnv } from './auth.js'
import { githubContentEnabled, config, r2Enabled, resolveStorageUrl } from './config.js'
import { query } from './db.js'
import { clientIp, json, parseLimit, parsePage } from './http.js'
import { deleteObject, normalizeKey, putObject } from './storage.js'
import { contentPath, deleteGithubFile, getGithubFile, getGithubJson, listGithubFiles, putGithubFile, putGithubJson } from './github.js'

export const api = new Hono<AppEnv>()

/** 数据库图书记录转换为前端契约，并隐藏本地磁盘路径。 */
function bookResponse(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, cover_url: resolveStorageUrl(String(row.cover_url || '')), file_path: resolveStorageUrl(String(row.file_path || '')) }
}

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) })
const registerSchema = z.object({ username: z.string().min(3).max(30), email: z.string().email().max(320), password: z.string().min(8).max(128) })
const eventSchema = z.object({
  event_type: z.string().max(40).default('page_view'),
  path: z.string().max(500),
  title: z.string().max(300).default(''),
  referrer: z.string().max(1000).default(''),
  visitor_id: z.string().max(100).default(''),
})

api.get('/health', async (c) => {
  try {
    await query('select 1')
    return json(c, { status: 'ok', database: 'ok', runtime: 'node' })
  } catch (error) {
    console.error('[node-api] health check failed', error)
    return json(c, { status: 'error', database: 'unavailable', runtime: 'node' }, 503)
  }
})

api.get('/api/v1/books', async (c) => {
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 20, 100)
  const search = (c.req.query('keyword') || c.req.query('search') || '').trim()
  const sortValue = c.req.query('sort') || 'newest'
  const sort = sortValue === 'oldest' ? 'asc' : 'desc'
  const order = sortValue === 'custom' ? 'sort_order asc, created_at desc' : `created_at ${sort}`
  const values: unknown[] = []
  const where = search ? `where title ilike $1 or author ilike $1` : ''
  if (search) values.push(`%${search}%`)
  const count = await query<{ count: string }>(`select count(*)::text as count from books ${where}`, values)
  values.push(pageSize, (page - 1) * pageSize)
  const result = await query(
    `select id, slug, title, author, description, cover_url, file_path, sort_order, created_at
     from books ${where} order by ${order}
     limit $${values.length - 1} offset $${values.length}`,
    values,
  )
  return json(c, { items: result.rows.map((row) => bookResponse(row)), total: Number(count.rows[0]?.count || 0) })
})

api.get('/api/v1/books/:slug/read', async (c) => {
  const result = await query<{ file_path: string }>('select file_path from books where slug = $1', [c.req.param('slug')])
  if (!result.rows[0]) return json(c, { detail: '图书不存在' }, 404)
  return c.redirect(resolveStorageUrl(result.rows[0].file_path))
})

api.get('/api/v1/books/:slug/read-resource/:resource{.+}', async (c) => {
  const result = await query<{ file_path: string }>('select file_path from books where slug = $1', [c.req.param('slug')])
  if (!result.rows[0]) return json(c, { detail: '图书不存在' }, 404)
  return c.redirect(resolveStorageUrl(result.rows[0].file_path))
})

api.get('/api/v1/books/:slug', async (c) => {
  const result = await query(
    `select id, slug, title, author, description, cover_url, file_path, sort_order, created_at, updated_at
     from books where slug = $1`,
    [c.req.param('slug')],
  )
  if (!result.rows[0]) return json(c, { detail: '图书不存在' }, 404)
  return json(c, bookResponse(result.rows[0]))
})

api.get('/api/v1/books/admin/all', requireAdmin, async (c) => {
  const result = await query(
    `select id, slug, title, author, description, cover_url, file_path, sort_order, created_at from books order by sort_order, created_at desc`,
  )
  return json(c, result.rows.map((row) => bookResponse(row)))
})

/** 管理员上传 EPUB 到 R2 并创建图书记录。 */
api.post('/api/v1/books', requireAdmin, async (c) => {
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法上传 EPUB' }, 503)
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.epub')) {
    return json(c, { detail: '仅支持 EPUB 文件' }, 400)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const slug = file.name
    .replace(/\.epub$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '') || crypto.randomUUID()
  const duplicate = await query('select id from books where slug = $1', [slug])
  if (duplicate.rows[0]) return json(c, { detail: 'slug 已存在' }, 409)
  const key = `books/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}_${file.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')}`
  const fileUrl = await putObject(key, bytes, 'application/epub+zip')
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : file.name.replace(/\.epub$/i, '')
  const author = typeof body.author === 'string' ? body.author.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const result = await query(
    `insert into books (slug, title, author, description, file_path, sort_order)
     values ($1,$2,$3,$4,$5,coalesce((select max(sort_order) + 1 from books), 0))
     returning id, slug, title, author, description, cover_url, file_path, sort_order, created_at, updated_at`,
    [slug, title, author, description, fileUrl],
  )
  return json(c, bookResponse(result.rows[0]), 201)
})

api.get('/api/v1/posts', async (c) => {
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 20, 100)
  const search = (c.req.query('keyword') || c.req.query('search') || '').trim()
  const values: unknown[] = []
  const conditions = ['is_draft = false']
  const category = c.req.query('category')?.trim()
  if (category) {
    values.push(category)
    conditions.push(`category = $${values.length}`)
  }
  if (search) {
    values.push(`%${search}%`)
    conditions.push(`(title ilike $${values.length} or description ilike $${values.length})`)
  }
  const where = `where ${conditions.join(' and ')}`
  const count = await query<{ count: string }>(`select count(*)::text as count from posts ${where}`, values)
  values.push(pageSize, (page - 1) * pageSize)
  const result = await query(
    `select id, slug, title, description, date, cover_url, category, tags, is_draft, is_pinned, created_at
     from posts ${where} order by is_pinned desc, date desc, created_at desc
     limit $${values.length - 1} offset $${values.length}`,
    values,
  )
  return json(c, { items: result.rows, total: Number(count.rows[0]?.count || 0) })
})

api.get('/api/v1/posts/stats', async (c) => {
  const result = await query<{ label: string; count: string }>(
    `select date_part('year', nullif(date, '')::date)::text as label, count(*)::text as count
     from posts where is_draft = false and date <> '' group by 1 order by 1`,
  )
  return json(c, result.rows.map((row) => ({ label: row.label, count: Number(row.count) })))
})

api.get('/api/v1/posts/:slug', async (c) => {
  const result = await query(
    `select id, slug, title, description, date, cover_url, category, tags, is_draft,
            is_pinned, content_html, ''::text as content_md, created_at, updated_at
     from posts where slug = $1 and is_draft = false`,
    [c.req.param('slug')],
  )
  if (!result.rows[0]) return json(c, { detail: '文章不存在' }, 404)
  return json(c, { ...result.rows[0], cover_url: resolveStorageUrl(String(result.rows[0].cover_url || '')) })
})

const postSchema = z.object({
  slug: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).default(''),
  date: z.string().max(20).default(''),
  cover_url: z.string().max(500).default(''),
  category: z.string().max(50).default(''),
  tags: z.array(z.string()).default([]),
  is_draft: z.boolean().default(false),
  is_pinned: z.boolean().default(false),
  content_md: z.string().default(''),
})

/** 创建文章；Markdown 正文存数据库，避免 Serverless 依赖本地 content 目录。 */
api.post('/api/v1/posts', requireAdmin, async (c) => {
  const parsed = postSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '文章参数不正确' }, 422)
  const input = parsed.data
  const slug = (input.slug || input.title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || crypto.randomUUID()
  const html = await marked.parse(input.content_md)
  try {
    const result = await query(
      `insert into posts (slug, title, description, date, cover_url, category, tags, is_draft, is_pinned, content_md, content_html, md_filename)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'')
       returning id, slug, title, description, date, cover_url, category, tags, is_draft, is_pinned, content_md, content_html, created_at, updated_at`,
      [slug, input.title, input.description, input.date, input.cover_url, input.category, JSON.stringify(input.tags), input.is_draft, input.is_pinned, input.content_md, html],
    )
    return json(c, result.rows[0], 201)
  } catch (error: unknown) {
    if (error instanceof Error && /unique/i.test(error.message)) return json(c, { detail: 'slug 已存在' }, 409)
    throw error
  }
})

api.put('/api/v1/posts/:slug', requireAdmin, async (c) => {
  const parsed = postSchema.partial().safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '文章参数不正确' }, 422)
  const input = parsed.data
  const current = await query('select * from posts where slug = $1', [c.req.param('slug')])
  if (!current.rows[0]) return json(c, { detail: '文章不存在' }, 404)
  const row = current.rows[0] as Record<string, unknown>
  const contentMd = input.content_md ?? String(row.content_md || '')
  const html = input.content_md === undefined ? String(row.content_html || '') : await marked.parse(contentMd)
  const result = await query(
    `update posts set title=$1, description=$2, date=$3, cover_url=$4, category=$5, tags=$6,
      is_draft=$7, is_pinned=$8, content_md=$9, content_html=$10, updated_at=now()
     where slug=$11 returning id, slug, title, description, date, cover_url, category, tags, is_draft, is_pinned, content_md, content_html, created_at, updated_at`,
    [input.title ?? row.title, input.description ?? row.description, input.date ?? row.date, input.cover_url ?? row.cover_url, input.category ?? row.category, JSON.stringify(input.tags ?? row.tags ?? []), input.is_draft ?? row.is_draft, input.is_pinned ?? row.is_pinned, contentMd, html, c.req.param('slug')],
  )
  return json(c, result.rows[0])
})

api.delete('/api/v1/posts/:slug', requireAdmin, async (c) => {
  const result = await query('delete from posts where slug = $1 returning id', [c.req.param('slug')])
  return result.rows[0] ? new Response(null, { status: 204 }) : json(c, { detail: '文章不存在' }, 404)
})

api.get('/api/v1/content-stats', async (c) => {
  const result = await query<{ posts: string; gallery_projects: string; moments: string }>(
    `select
      (select count(*) from posts where is_draft = false)::text as posts,
      (select count(*) from gallery_projects)::text as gallery_projects,
      (select count(*) from moments)::text as moments`,
  )
  const row = result.rows[0]
  return json(c, { posts: Number(row?.posts || 0), moments: Number(row?.moments || 0), gallery_projects: Number(row?.gallery_projects || 0), active_days: 0 })
})

api.get('/api/v1/gallery', async (c) => {
  const result = await query(
    `select id, slug, title, description, tags, status, year, is_featured, created_at
     from gallery_projects order by created_at desc`,
  )
  return json(c, result.rows)
})

api.get('/api/v1/gallery/:slug', async (c) => {
  const result = await query(
    `select id, slug, title, description, tags, status, year, is_featured,
            content_md, content_html, created_at, updated_at
     from gallery_projects where slug = $1`,
    [c.req.param('slug')],
  )
  return result.rows[0] ? json(c, result.rows[0]) : json(c, { detail: '项目不存在' }, 404)
})

api.get('/api/v1/about/content', async (c) => {
  const result = await query<{ key: string; value: string }>(
    `select key, value from site_config where key in ('about_content_md', 'about_cover_url')`,
  )
  const values = Object.fromEntries(result.rows.map((row) => [row.key, row.value]))
  return json(c, { content_md: values.about_content_md || '', cover_url: resolveStorageUrl(values.about_cover_url || '') })
})

api.put('/api/v1/about/content', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null) as { content_md?: unknown; cover_url?: unknown } | null
  const content = typeof body?.content_md === 'string' ? body.content_md : ''
  const cover = typeof body?.cover_url === 'string' ? body.cover_url : ''
  await query(
    `insert into site_config (key, value, description) values
      ('about_content_md', $1, '关于页 Markdown 内容'), ('about_cover_url', $2, '关于页封面')
     on conflict (key) do update set value = excluded.value`,
    [content, cover],
  )
  return json(c, { content_md: content, cover_url: resolveStorageUrl(cover) })
})

api.get('/api/v1/friends', async (c) => {
  const result = await query(
    `select id, name, bio, avatar, url, sort_order, created_at from friends order by sort_order, created_at desc`,
  )
  return json(c, { items: result.rows, total: result.rowCount })
})

api.get('/api/v1/carousel', async (c) => {
  const result = await query<{ id: number; url: string; sort_order: number }>(
    `select c.id, i.url, c.sort_order from carousel_slides c join uploaded_images i on i.id = c.image_id order by c.sort_order, c.created_at`,
  )
  return json(c, { items: result.rows.map((row) => ({ ...row, url: resolveStorageUrl(row.url) })), total: result.rowCount })
})

api.get('/api/v1/profile', async (c) => {
  const profile = await query(`select name, bio_html as bio, avatar_url, cover_url from profile where id = 1`)
  const links = await query(`select id, label, icon, url, sort_order from social_links order by sort_order, id`)
  const row = profile.rows[0] || { name: '', bio: '', avatar_url: '', cover_url: '' }
  return json(c, { ...row, avatar_url: resolveStorageUrl(String(row.avatar_url || '')), cover_url: resolveStorageUrl(String(row.cover_url || '')), social_links: links.rows })
})

api.get('/api/v1/tavern', async (c) => {
  const result = await query(`select id, author, topic, body, created_at from tavern_posts where is_visible = true order by created_at desc`)
  return json(c, { items: result.rows, total: result.rowCount })
})

api.get('/api/v1/tavern/config', async (c) => {
  const result = await query<{ value: string }>(`select value from site_config where key = 'tavern_bg_url'`)
  return json(c, { bg_url: resolveStorageUrl(result.rows[0]?.value || '') })
})

api.get('/api/v1/backgrounds', async (c) => {
  const values: unknown[] = []
  const conditions: string[] = []
  for (const field of ['theme', 'device'] as const) {
    const value = c.req.query(field)
    if (value) {
      values.push(value)
      conditions.push(`${field} = $${values.length}`)
    }
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const result = await query(`select b.id, b.media_type, b.media_url, i.url as image_url, b.poster_url, b.mime_type, b.file_size, b.theme, b.device, b.sort_order, b.created_at from backgrounds b left join uploaded_images i on i.id = b.image_id ${where.replaceAll('theme', 'b.theme').replaceAll('device', 'b.device')} order by b.sort_order, b.created_at`, values)
  return json(c, { items: result.rows.map((row) => ({ ...row, url: resolveStorageUrl(String(row.media_url || row.image_url || '')), poster_url: resolveStorageUrl(String(row.poster_url || '')) })), total: result.rowCount })
})

api.get('/api/v1/albums', async (c) => {
  const result = await query(
    `select a.id, a.title, a.description, a.orientation, a.cover_image_id,
            coalesce(cover.url, first_photo.url, '') as cover_url,
            count(ap.id)::int as photo_count, to_char(a.created_at, 'YYYY.MM') as date,
            a.created_at
     from albums a
     left join uploaded_images cover on cover.id = a.cover_image_id
     left join album_photos ap on ap.album_id = a.id
     left join lateral (
       select i.url from album_photos p join uploaded_images i on i.id = p.image_id
       where p.album_id = a.id order by p.sort_order, p.id limit 1
     ) first_photo on true
     group by a.id, cover.url, first_photo.url order by a.created_at desc`,
  )
  const items = await Promise.all(
    result.rows.map(async (row) => ({
      ...row,
      cover_url: resolveStorageUrl(String(row.cover_url || '')),
      preview_photos: (await query(
        `select p.id, i.url, p.caption, p.sort_order, p.created_at from album_photos p join uploaded_images i on i.id = p.image_id where p.album_id = $1 order by p.sort_order, p.id limit 3`,
        [row.id],
      )).rows.map((photo) => ({ ...photo, url: resolveStorageUrl(String(photo.url || '')) })),
    })),
  )
  return json(c, { items, total: items.length })
})

api.get('/api/v1/albums/:id', async (c) => {
  const result = await query(
    `select a.id, a.title, a.description, a.orientation, a.cover_image_id,
            coalesce(cover.url, '') as cover_url, to_char(a.created_at, 'YYYY.MM') as date, a.created_at
     from albums a left join uploaded_images cover on cover.id = a.cover_image_id where a.id = $1`,
    [Number(c.req.param('id'))],
  )
  if (!result.rows[0]) return json(c, { detail: '相册不存在' }, 404)
  const photos = await query(
    `select p.id, i.url, p.caption, p.sort_order, p.created_at from album_photos p join uploaded_images i on i.id = p.image_id where p.album_id = $1 order by p.sort_order, p.id`,
    [Number(c.req.param('id'))],
  )
  const row = result.rows[0]
  return json(c, { ...row, cover_url: resolveStorageUrl(String(row.cover_url || '')), photo_count: photos.rowCount, photos: photos.rows.map((photo) => ({ ...photo, url: resolveStorageUrl(String(photo.url || '')) })) })
})

api.get('/api/v1/treasures/categories', async (c) => {
  const result = await query<{ category: string }>('select distinct category from treasures where category <> \'\' order by category')
  return json(c, result.rows.map((row) => row.category))
})

api.get('/api/v1/treasures', async (c) => {
  const category = c.req.query('category')?.trim()
  const values: unknown[] = []
  const where = category ? 'where category = $1' : ''
  if (category) values.push(category)
  const result = await query(`select id, slug, title, description, category, icon, url, download_file, tags, sort_order, created_at from treasures ${where} order by sort_order, created_at desc`, values)
  return json(c, { items: result.rows, total: result.rowCount })
})

api.get('/api/v1/comments', async (c) => {
  const pageKey = c.req.query('page_key')?.trim()
  if (!pageKey) return json(c, { detail: '页面标识不正确' }, 422)
  const result = await query(`select c.id, c.user_id, coalesce(nullif(c.legacy_author, ''), u.display_name, u.username, '访客') as author, to_char(c.created_at, 'YYYY-MM-DD HH24:MI') as date, c.content, c.legacy_avatar_color as avatar_color, coalesce(u.avatar_url, '') as avatar_url from comments c left join users u on u.id = c.user_id where c.page_key = $1 order by c.created_at`, [pageKey])
  return json(c, { items: result.rows.map((row) => ({ ...row, can_delete: false, children: [] })), total: result.rowCount })
})

api.get('/api/v1/comments/count', async (c) => {
  const result = await query<{ count: string }>('select count(*)::text as count from comments where page_key = $1', [c.req.query('page_key') || ''])
  return json(c, { page_key: c.req.query('page_key') || '', count: Number(result.rows[0]?.count || 0) })
})

api.post('/api/v1/comments/batch-count', async (c) => {
  const body = await c.req.json().catch(() => null) as { page_keys?: unknown } | null
  const keys = Array.isArray(body?.page_keys) ? body.page_keys.filter((key): key is string => typeof key === 'string').slice(0, 100) : []
  if (!keys.length) return json(c, {})
  const result = await query<{ page_key: string; count: string }>('select page_key, count(*)::text as count from comments where page_key = any($1::text[]) group by page_key', [keys])
  return json(c, Object.fromEntries(result.rows.map((row) => [row.page_key, Number(row.count)])))
})

api.post('/api/v1/comments', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null) as { page_key?: unknown; content?: unknown; parent_id?: unknown } | null
  const pageKey = typeof body?.page_key === 'string' ? body.page_key.trim() : ''
  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!pageKey || pageKey.length > 300 || !content || content.length > 2000) return json(c, { detail: '评论参数不正确' }, 422)
  const user = c.get('user')
  const parentId = Number.isInteger(body?.parent_id) ? Number(body?.parent_id) : null
  const result = await query(
    `insert into comments (page_key, user_id, parent_id, content)
     values ($1, $2, $3, $4)
     returning id, user_id, content, created_at`,
    [pageKey, user.id, parentId, content],
  )
  const row = result.rows[0]
  return json(c, { id: row.id, user_id: row.user_id, author: '', date: row.created_at, content: row.content, avatar_color: '', avatar_url: '', can_delete: true, children: [] }, 201)
})

api.delete('/api/v1/comments/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const result = await query<{ id: number }>(
    `delete from comments where id = $1 and (user_id = $2 or $3 = true) returning id`,
    [Number(c.req.param('id')), user.id, user.is_admin],
  )
  return result.rows[0] ? new Response(null, { status: 204 }) : json(c, { detail: '评论不存在或无权删除' }, 404)
})

api.get('/api/v1/moments', async (c) => {
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 10, 100)
  const count = await query<{ count: string }>('select count(*)::text as count from moments')
  const result = await query(`select id, date, content, mood, mood_text, tags, images, likes from moments order by date desc limit $1 offset $2`, [pageSize, (page - 1) * pageSize])
  return json(c, { items: result.rows.map((row) => ({ ...row, images: Array.isArray(row.images) ? row.images.map((image) => resolveStorageUrl(String(image))) : [], comments: [] })), total: Number(count.rows[0]?.count || 0) })
})

api.get('/api/v1/moments/:id', async (c) => {
  const result = await query('select id, date, content, mood, mood_text, tags, images, likes from moments where id = $1', [Number(c.req.param('id'))])
  if (!result.rows[0]) return json(c, { detail: '说说不存在' }, 404)
  const comments = await query('select id, nickname, content, to_char(created_at, \'YYYY-MM-DD HH24:MI\') as date, likes from moment_comments where moment_id = $1 order by created_at', [Number(c.req.param('id'))])
  const row = result.rows[0]
  return json(c, { ...row, images: Array.isArray(row.images) ? row.images.map((image) => resolveStorageUrl(String(image))) : [], comments: comments.rows })
})

api.post('/api/v1/moments/:id/like', async (c) => {
  const result = await query<{ likes: number }>('update moments set likes = likes + 1, updated_at = now() where id = $1 returning likes', [Number(c.req.param('id'))])
  return result.rows[0] ? json(c, result.rows[0]) : json(c, { detail: '说说不存在' }, 404)
})

api.get('/api/v1/moments/:id/comments', async (c) => {
  const result = await query('select id, nickname, content, to_char(created_at, \'YYYY-MM-DD HH24:MI\') as date, likes from moment_comments where moment_id = $1 order by created_at', [Number(c.req.param('id'))])
  return json(c, result.rows)
})

api.post('/api/v1/moments/:id/comments', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => null) as { content?: unknown } | null
  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!content || content.length > 2000) return json(c, { detail: '评论内容不正确' }, 422)
  const user = c.get('user')
  const result = await query(
    `insert into moment_comments (moment_id, nickname, content)
     values ($1, (select coalesce(nullif(display_name, ''), username) from users where id = $2), $3)
     returning id, nickname, content, to_char(created_at, 'YYYY-MM-DD HH24:MI') as date, likes`,
    [Number(c.req.param('id')), user.id, content],
  )
  return result.rows[0] ? json(c, result.rows[0], 201) : json(c, { detail: '说说不存在' }, 404)
})

api.post('/api/v1/tavern', async (c) => {
  const body = await c.req.json().catch(() => null) as { author?: unknown; topic?: unknown; body?: unknown } | null
  const author = typeof body?.author === 'string' ? body.author.trim() : ''
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : ''
  const message = typeof body?.body === 'string' ? body.body.trim() : ''
  if (!author || !topic || !message || author.length > 100 || topic.length > 200) return json(c, { detail: '留言内容不正确' }, 422)
  const result = await query(`insert into tavern_posts (author, topic, body, ip_hash) values ($1, $2, $3, $4) returning id, author, topic, body, created_at`, [author, topic, message, hashIp(clientIp(c))])
  return json(c, result.rows[0], 201)
})

api.post('/api/v1/auth/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '登录参数不正确' }, 422)
  const result = await query<{
    id: number
    username: string
    password_hash: string
    is_admin: boolean
    is_active: boolean
  }>(
    `select id, username, password_hash, is_admin, is_active from users
     where username = $1 or lower(email) = lower($1) limit 1`,
    [parsed.data.username.trim()],
  )
  const user = result.rows[0]
  if (!user || !user.is_active || !(await verifyPassword(parsed.data.password, user.password_hash))) {
    return json(c, { detail: '用户名、邮箱或密码错误' }, 401)
  }
  const token = await createAccessToken(user.id)
  await createSession(c, user.id)
  return json(c, { access_token: token, token_type: 'bearer' })
})

api.post('/api/v1/auth/register', async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '注册参数不正确' }, 422)
  const input = parsed.data
  const exists = await query('select id from users where username = $1 or lower(email) = lower($2) limit 1', [input.username, input.email])
  if (exists.rows[0]) return json(c, { detail: '用户名或邮箱已被使用' }, 409)
  const passwordHash = await hashPassword(input.password)
  const result = await query<{ id: number }>(
    `insert into users (username, email, display_name, password_hash, email_verified)
     values ($1, lower($2), $1, $3, true) returning id`,
    [input.username, input.email, passwordHash],
  )
  const userId = result.rows[0]?.id
  if (!userId) return json(c, { detail: '创建账户失败' }, 500)
  await createSession(c, userId)
  return json(c, { access_token: await createAccessToken(userId), token_type: 'bearer', requires_email_verification: false }, 201)
})

api.post('/api/v1/auth/refresh', async (c) => {
  const userId = await refreshSession(c)
  if (!userId) return json(c, { detail: '登录会话已失效' }, 401)
  return json(c, { access_token: await createAccessToken(userId), token_type: 'bearer' })
})

api.post('/api/v1/auth/logout', async (c) => {
  await revokeSession(c)
  return new Response(null, { status: 204 })
})

api.get('/api/v1/auth/me', authMiddleware, async (c) => {
  const user = c.get('user')
  const result = await query(
    `select id, username, is_admin, email, display_name, avatar_url, email_verified
     from users where id = $1`,
    [user.id],
  )
  return result.rows[0] ? json(c, result.rows[0]) : json(c, { detail: '用户不存在' }, 404)
})

/** Vercel Function 的健康检查路径；本地服务器同时保留 /health 别名。 */
api.get('/api/health', async (c) => {
  try {
    await query('select 1')
    return json(c, { status: 'ok', database: 'ok', runtime: 'node' })
  } catch {
    return json(c, { status: 'error', database: 'unavailable', runtime: 'node' }, 503)
  }
})

api.post('/api/v1/analytics/events', async (c) => {
  const parsed = eventSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return json(c, { detail: '统计事件参数不正确' }, 422)
  const data = parsed.data
  if (!new Set(['page_view', 'book_open', 'book_download', 'file_download', 'zip_download']).has(data.event_type)) {
    return new Response(null, { status: 204 })
  }
  const ip = clientIp(c)
  await query(
    `insert into analytics_events
      (event_type, path, title, referrer, user_agent, ip_address, ip_hash, visitor_id, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [
      data.event_type,
      data.path,
      data.title,
      data.referrer,
      c.req.header('user-agent')?.slice(0, 1000) || '',
      ip,
      hashIp(ip),
      data.visitor_id,
    ],
  )
  return new Response(null, { status: 204 })
})

api.get('/api/v1/analytics/public-summary', async (c) => {
  const result = await query<{ total_pv: string; total_uv: string; today_pv: string; today_uv: string }>(
    `select
      count(*) filter (where event_type = 'page_view')::text as total_pv,
      count(distinct ip_hash) filter (where event_type = 'page_view')::text as total_uv,
      count(*) filter (where event_type = 'page_view' and occurred_at >= current_date)::text as today_pv,
      count(distinct ip_hash) filter (where event_type = 'page_view' and occurred_at >= current_date)::text as today_uv
     from analytics_events`,
  )
  const row = result.rows[0]
  return json(c, {
    today_pv: Number(row?.today_pv || 0),
    today_uv: Number(row?.today_uv || 0),
    total_pv: Number(row?.total_pv || 0),
    total_uv: Number(row?.total_uv || 0),
    trend: [],
  })
})

api.get('/api/v1/analytics/overview', requireAdmin, async (c) => {
  const result = await query<{ event_type: string; count: string }>(
    `select event_type, count(*)::text as count from analytics_events group by event_type`,
  )
  const counts = Object.fromEntries(result.rows.map((row) => [row.event_type, Number(row.count)]))
  return json(c, {
    today_pv: 0,
    today_uv: 0,
    yesterday_pv: 0,
    yesterday_uv: 0,
    total_pv: counts.page_view || 0,
    total_uv: 0,
    page_views: counts.page_view || 0,
    book_downloads: counts.book_download || 0,
    zip_downloads: counts.zip_download || 0,
  })
})

api.get('/api/v1/images', requireAdmin, async (c) => {
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 20, 100)
  const count = await query<{ count: string }>('select count(*)::text as count from uploaded_images')
  const result = await query('select id, filename, original_name, url, file_size, width, height, mime_type, created_at from uploaded_images order by created_at desc limit $1 offset $2', [pageSize, (page - 1) * pageSize])
  return json(c, { items: result.rows.map((row) => ({ ...row, url: resolveStorageUrl(String(row.url || '')) })), total: Number(count.rows[0]?.count || 0) })
})

api.get('/api/v1/files', requireAdmin, async (c) => {
  const page = parsePage(c.req.query('page'), 1, 10_000)
  const pageSize = parseLimit(c.req.query('page_size'), 50, 200)
  const count = await query<{ count: string }>('select count(*)::text as count from uploaded_files')
  const result = await query('select id, filename, original_name, url, file_size, mime_type, created_at from uploaded_files order by created_at desc limit $1 offset $2', [pageSize, (page - 1) * pageSize])
  return json(c, { items: result.rows.map((row) => ({ ...row, url: resolveStorageUrl(String(row.url || '')) })), total: Number(count.rows[0]?.count || 0) })
})

api.delete('/api/v1/images/:id', requireAdmin, async (c) => {
  const result = await query<{ filename: string }>('delete from uploaded_images where id = $1 returning filename', [Number(c.req.param('id'))])
  if (!result.rows[0]) return json(c, { detail: '图片不存在' }, 404)
  await deleteObject(result.rows[0].filename)
  return new Response(null, { status: 204 })
})

api.delete('/api/v1/files/:id', requireAdmin, async (c) => {
  const result = await query<{ filename: string }>('delete from uploaded_files where id = $1 returning filename', [Number(c.req.param('id'))])
  if (!result.rows[0]) return json(c, { detail: '文件不存在' }, 404)
  await deleteObject(result.rows[0].filename)
  return new Response(null, { status: 204 })
})

async function uploadObject(c: Context, prefix: string): Promise<Response> {
  if (!r2Enabled()) return json(c, { detail: 'R2 未配置，无法在 Node Serverless 版本上传文件' }, 503)
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) return json(c, { detail: '缺少上传文件' }, 422)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const safeName = file.name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'upload'
  const key = `${prefix}/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${crypto.randomUUID()}_${safeName}`
  const normalized = normalizeKey(key)
  const url = await putObject(normalized, bytes, file.type)
  const table = prefix === 'images' ? 'uploaded_images' : 'uploaded_files'
  const result = prefix === 'images'
    ? await query(
        `insert into uploaded_images (filename, original_name, url, file_size, width, height, mime_type)
         values ($1,$2,$3,$4,0,0,$5) returning id, filename, original_name, url, file_size, width, height, mime_type, created_at`,
        [normalized, file.name, url, bytes.byteLength, file.type || 'application/octet-stream'],
      )
    : await query(
        `insert into uploaded_files (filename, original_name, url, file_size, mime_type)
         values ($1,$2,$3,$4,$5) returning id, filename, original_name, url, file_size, mime_type, created_at`,
        [normalized, file.name, url, bytes.byteLength, file.type || 'application/octet-stream'],
      )
  return json(c, { ...result.rows[0], ...(table === 'uploaded_images' ? { width: 0, height: 0 } : {}) }, 201)
}

api.post('/api/v1/images/upload', requireAdmin, (c) => uploadObject(c, 'images'))
api.post('/api/v1/files/upload', requireAdmin, (c) => uploadObject(c, 'files'))
