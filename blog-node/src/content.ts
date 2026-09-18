/**
 * GitHub 内容仓库的数据模型。
 *
 * 文章和展览使用 Markdown 文件，友链、资料等小型结构化内容使用 JSON。
 * 这些内容不需要数据库连接；每次 CMS 保存都会产生一次可审计的 Git 提交。
 */
import {
  contentPath,
  deleteGithubFile,
  getGithubFile,
  getGithubJson,
  listGithubFiles,
  putGithubFile,
  putGithubJson,
} from './github.js'

export interface ContentPost {
  id: number
  slug: string
  title: string
  description: string
  date: string
  cover_url: string
  category: string
  tags: string[]
  is_draft: boolean
  is_pinned: boolean
  content_md: string
  content_html?: string
  created_at: string
  updated_at: string
}

export interface ContentGalleryProject {
  id: number
  slug: string
  title: string
  description: string
  tags: string[]
  status: string
  year: string
  is_featured: boolean
  content_md: string
  content_html?: string
  created_at: string
  updated_at: string
}

export interface ContentFriend {
  id: number
  name: string
  bio: string
  avatar: string
  url: string
  sort_order: number
  created_at: string
}

export interface ContentProfile {
  name: string
  bio: string
  avatar_url: string
  cover_url: string
  social_links: Array<{
    id: number
    label: string
    icon: string
    url: string
    sort_order: number
  }>
}

/** 根据 slug 生成跨部署稳定的数字 ID，兼容现有后台响应类型。 */
function stableId(value: string): number {
  let hash = 0
  for (const character of value) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0
  return Math.abs(hash) || 1
}

/** 规范化 slug，避免 CMS 写入仓库路径之外的位置。 */
export function contentSlug(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
  return slug || fallback
}

/** 解析 frontmatter 中常见的 JSON/YAML 内联值。 */
function parseValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // 兼容常见的 YAML 写法：tags: [Vue, Node.js] 或 tags: ['Vue', 'Node.js']。
      const inner = trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed.slice(1)
      return splitInlineList(inner)
    }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.replace(/^['"]|['"]$/g, '')
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, '')
}

/** 按逗号分割内联数组，同时忽略引号中的逗号。 */
function splitInlineList(value: string): string[] {
  const items: string[] = []
  let current = ''
  let quote = ''
  for (const character of value) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character
      current += character
    } else if (character === ',' && !quote) {
      const item = current.trim().replace(/^['"]|['"]$/g, '')
      if (item) items.push(item)
      current = ''
    } else {
      current += character
    }
  }
  const item = current.trim().replace(/^['"]|['"]$/g, '')
  if (item) items.push(item)
  return items
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'true') return true
    if (value.trim().toLowerCase() === 'false') return false
  }
  return fallback
}

function parseMarkdown(raw: string, filename: string): Record<string, unknown> & { content_md: string } {
  const match = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const metadata: Record<string, unknown> = {}
  const body = match?.[2] ?? raw
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const separator = line.indexOf(':')
      if (separator < 1) continue
      metadata[line.slice(0, separator).trim()] = parseValue(line.slice(separator + 1))
    }
  }
  const stem = filename.split('/').pop()?.replace(/\.md$/i, '') || 'content'
  return { ...metadata, content_md: body, slug: metadata.slug || stem }
}

function scalar(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value : String(value ?? ''))
}

function markdownFrontmatter(metadata: Record<string, unknown>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue
    lines.push(`${key}: ${typeof value === 'string' ? scalar(value) : JSON.stringify(value)}`)
  }
  lines.push('---', '', body.replace(/^\s+/, ''))
  return `${lines.join('\n').trimEnd()}\n`
}

function tags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

function postFromMarkdown(raw: string, path: string): ContentPost {
  const parsed = parseMarkdown(raw, path)
  const slug = contentSlug(String(parsed.slug || ''), 'post')
  return {
    id: stableId(slug),
    slug,
    title: String(parsed.title || slug),
    description: String(parsed.description || ''),
    date: String(parsed.date || parsed.published || ''),
    cover_url: String(parsed.cover_url || parsed.cover || parsed.image || ''),
    category: String(parsed.category || ''),
    tags: tags(parsed.tags),
    is_draft: booleanValue(parsed.is_draft ?? parsed.draft),
    is_pinned: booleanValue(parsed.is_pinned ?? parsed.pinned),
    content_md: parsed.content_md,
    created_at: '',
    updated_at: '',
  }
}

function postMarkdown(post: Partial<ContentPost>, contentMd: string): string {
  return markdownFrontmatter(
    {
      title: String(post.title || post.slug || '未命名文章'),
      slug: String(post.slug || ''),
      date: String(post.date || ''),
      description: String(post.description || ''),
      cover_url: String(post.cover_url || ''),
      category: String(post.category || ''),
      tags: post.tags || [],
      draft: Boolean(post.is_draft),
      pinned: Boolean(post.is_pinned),
    },
    contentMd,
  )
}

/** 从 GitHub 读取全部文章 Markdown。 */
export async function listContentPosts(): Promise<ContentPost[]> {
  const entries = await listGithubFiles(contentPath('posts'))
  const posts = await Promise.all(
    entries
      .filter((entry) => entry.path.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const file = await getGithubFile(entry.path)
        return file ? postFromMarkdown(file.content, entry.path) : null
      }),
  )
  return posts
    .filter((post): post is ContentPost => post !== null)
    .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.date.localeCompare(a.date))
}

/** 读取单篇文章；调用方负责决定是否向访客隐藏草稿。 */
export async function getContentPost(slug: string): Promise<ContentPost | null> {
  const safeSlug = contentSlug(slug, '')
  if (!safeSlug) return null
  const file = await getGithubFile(contentPath(`posts/${safeSlug}.md`))
  return file ? postFromMarkdown(file.content, file.path) : null
}

/** 创建或更新文章 Markdown，并返回兼容旧 API 的记录。 */
export async function saveContentPost(input: Partial<ContentPost>): Promise<ContentPost> {
  const slug = contentSlug(String(input.slug || input.title || ''), 'post')
  const path = contentPath(`posts/${slug}.md`)
  const current = await getGithubFile(path)
  const post: ContentPost = {
    id: stableId(slug),
    slug,
    title: String(input.title || slug),
    description: String(input.description || ''),
    date: String(input.date || ''),
    cover_url: String(input.cover_url || ''),
    category: String(input.category || ''),
    tags: tags(input.tags),
    is_draft: Boolean(input.is_draft),
    is_pinned: Boolean(input.is_pinned),
    content_md: String(input.content_md || ''),
    created_at: '',
    updated_at: '',
  }
  await putGithubFile(path, postMarkdown(post, post.content_md), `${current ? '更新' : '创建'}文章：${post.title}`, current?.sha)
  return post
}

/** 删除文章 Markdown。 */
export async function deleteContentPost(slug: string): Promise<boolean> {
  const safeSlug = contentSlug(slug, '')
  const path = contentPath(`posts/${safeSlug}.md`)
  const current = await getGithubFile(path)
  if (!current) return false
  await deleteGithubFile(path, `删除文章：${safeSlug}`, current.sha)
  return true
}

function galleryFromMarkdown(raw: string, path: string): ContentGalleryProject {
  const parsed = parseMarkdown(raw, path)
  const slug = contentSlug(String(parsed.slug || ''), 'project')
  return {
    id: stableId(`gallery:${slug}`),
    slug,
    title: String(parsed.title || slug),
    description: String(parsed.description || ''),
    tags: tags(parsed.tags),
    status: String(parsed.status || ''),
    year: String(parsed.year || ''),
    is_featured: booleanValue(parsed.is_featured ?? parsed.featured),
    content_md: parsed.content_md,
    created_at: '',
    updated_at: '',
  }
}

/** 从 GitHub 读取展览项目 Markdown。 */
export async function listContentGallery(): Promise<ContentGalleryProject[]> {
  const entries = await listGithubFiles(contentPath('gallery'))
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.path.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const file = await getGithubFile(entry.path)
        return file ? galleryFromMarkdown(file.content, entry.path) : null
      }),
  )
  return projects.filter((project): project is ContentGalleryProject => project !== null)
}

/** 读取单个展览项目。 */
export async function getContentGallery(slug: string): Promise<ContentGalleryProject | null> {
  const safeSlug = contentSlug(slug, '')
  if (!safeSlug) return null
  const file = await getGithubFile(contentPath(`gallery/${safeSlug}.md`))
  return file ? galleryFromMarkdown(file.content, file.path) : null
}

/** 创建或更新展览项目 Markdown。 */
export async function saveContentGallery(input: Partial<ContentGalleryProject>): Promise<ContentGalleryProject> {
  const slug = contentSlug(String(input.slug || input.title || ''), 'project')
  const path = contentPath(`gallery/${slug}.md`)
  const current = await getGithubFile(path)
  const project: ContentGalleryProject = {
    id: stableId(`gallery:${slug}`),
    slug,
    title: String(input.title || slug),
    description: String(input.description || ''),
    tags: tags(input.tags),
    status: String(input.status || ''),
    year: String(input.year || ''),
    is_featured: Boolean(input.is_featured),
    content_md: String(input.content_md || ''),
    created_at: '',
    updated_at: '',
  }
  await putGithubFile(
    path,
    markdownFrontmatter(
      {
        title: project.title,
        slug: project.slug,
        description: project.description,
        tags: project.tags,
        status: project.status,
        year: project.year,
        featured: project.is_featured,
      },
      project.content_md,
    ),
    `${current ? '更新' : '创建'}展览项目：${project.title}`,
    current?.sha,
  )
  return project
}

/** 删除展览项目 Markdown。 */
export async function deleteContentGallery(slug: string): Promise<boolean> {
  const safeSlug = contentSlug(slug, '')
  const path = contentPath(`gallery/${safeSlug}.md`)
  const current = await getGithubFile(path)
  if (!current) return false
  await deleteGithubFile(path, `删除展览项目：${safeSlug}`, current.sha)
  return true
}

/** 读取 JSON 内容；GitHub 未配置时由路由决定是否降级到数据库。 */
export function getContentJson<T>(path: string, fallback: T): Promise<T> {
  return getGithubJson(contentPath(path), fallback)
}

/** 写入 JSON 内容并保留格式化结果，方便直接在 GitHub 中审阅。 */
export function saveContentJson(path: string, value: unknown, message: string): Promise<void> {
  return putGithubJson(contentPath(path), value, message)
}
