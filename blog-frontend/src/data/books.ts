import type { Book, ExtractedBookMeta } from '@/types'

const rawBookFiles = import.meta.glob<string>('../assets/testepub/*.epub', {
  query: '?url',
  import: 'default',
  eager: true,
})

const rawCoverFiles = import.meta.glob<string>('../assets/book-covers/*', {
  query: '?url',
  import: 'default',
  eager: true,
})

const extractedMetaCache = new Map<string, Promise<ExtractedBookMeta>>()

/** R2 图书清单的单条记录。清单由部署脚本或管理员手动生成。 */
export interface StaticBookManifestItem {
  slug: string
  title: string
  author?: string
  description?: string
  cover?: string
  key?: string
  file?: string
}

let staticBooksPromise: Promise<Book[]> | null = null

const coverByName = Object.fromEntries(
  Object.entries(rawCoverFiles).map(([path, file]) => [
    path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '')
      .toLowerCase(),
    file,
  ]),
)

// 手动封面映射:当前先用本地静态图验证展示效果,后续可直接换成后端返回的 coverUrl。
const coverAssignments: Record<string, string> = {
  '07义生活 (1)': coverByName.yimei01 || '',
  '08义生活 (1)': coverByName.yimei02 || '',
}

/** 由 EPUB 路径生成稳定 slug */
function slugify(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.epub$/i, '')
    .trim()
}

/** 由 EPUB 路径生成默认书名 */
function titleFromPath(path: string): string {
  return decodeURIComponent(slugify(path))
}

const books: Book[] = Object.entries(rawBookFiles).map(([path, file]) => ({
  slug: slugify(path),
  title: titleFromPath(path),
  author: '',
  description: '',
  cover: coverAssignments[slugify(path)] || '',
  file,
}))

/** 将 R2 对象键或完整 URL 转成浏览器可访问的地址。 */
function resolveStaticBookUrl(value: string | undefined): string {
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  const base = String(import.meta.env.VITE_R2_PUBLIC_URL || '').replace(/\/+$/, '')
  const key = value.replace(/^\/+/, '')
  return base ? `${base}/${key}` : `/${key}`
}

/**
 * 读取 public/books/manifest.json 中的 R2 图书清单。
 * 清单不存在或格式不正确时返回本地预览数据，不影响开发环境启动。
 */
export function loadStaticBooks(): Promise<Book[]> {
  if (staticBooksPromise) return staticBooksPromise
  staticBooksPromise = (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}books/manifest.json`, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json: unknown = await response.json()
      if (!Array.isArray(json)) throw new Error('图书清单必须是数组')
      const manifestBooks = json.flatMap((item: unknown): Book[] => {
        if (!item || typeof item !== 'object') return []
        // manifest 来自公开静态 JSON，先校验对象再按已声明字段读取。
        const entry = item as Partial<StaticBookManifestItem>
        if (typeof entry.slug !== 'string' || !entry.slug.trim()) return []
        const file = resolveStaticBookUrl(
          typeof entry.file === 'string' ? entry.file : entry.key,
        )
        if (!file) return []
        return [
          {
            slug: entry.slug,
            title: typeof entry.title === 'string' ? entry.title : entry.slug,
            author: typeof entry.author === 'string' ? entry.author : '',
            description: typeof entry.description === 'string' ? entry.description : '',
            cover: resolveStaticBookUrl(entry.cover),
            file,
          },
        ]
      })
      return manifestBooks
    } catch (error) {
      console.warn('[books] R2 图书清单加载失败,使用本地预览数据:', error)
      return books
    }
  })()
  return staticBooksPromise
}

/** 静态模式下按 slug 查找图书。 */
export async function loadStaticBook(slug: string): Promise<Book | null> {
  const items = await loadStaticBooks()
  return items.find((book) => book.slug === slug) || null
}

/** 获取全部图书列表 */
export function getBooks(): Book[] {
  return books
}

/** 按 slug 查找单本图书,找不到返回 null */
export function getBook(slug: string): Book | null {
  return books.find((book) => book.slug === slug) || null
}

/**
 * 从 EPUB 文件中按需提取元数据。
 * @param book 图书配置
 * @returns EPUB 内部解析出的标题、作者、简介与封面
 */
export function extractBookMeta(book: Book): Promise<ExtractedBookMeta> {
  const cached = extractedMetaCache.get(book.slug)
  if (cached) return cached

  const task = (async (): Promise<ExtractedBookMeta> => {
    try {
      const { default: ePub } = await import('epubjs')
      const epubBook = ePub(book.file)
      const metadata = await epubBook.loaded.metadata
      const cover = (await epubBook.coverUrl()) || undefined
      epubBook.destroy()
      return {
        title: metadata.title || undefined,
        author: metadata.creator || undefined,
        description: metadata.description || undefined,
        cover,
      }
    } catch (error) {
      console.warn('[books] EPUB 元数据解析失败,使用文件名作为默认信息:', error)
      return {}
    }
  })()

  extractedMetaCache.set(book.slug, task)
  return task
}

/** 合并手动配置与 EPUB 自动解析结果,文件名标题优先保持可读 */
export async function getHydratedBook(slug: string): Promise<Book | null> {
  const book = getBook(slug)
  if (!book) return null
  const extracted = await extractBookMeta(book)
  return {
    ...book,
    title: book.title || extracted.title || book.slug,
    author: book.author || extracted.author || '',
    description: book.description || extracted.description || '',
    cover: book.cover || extracted.cover || '',
  }
}
