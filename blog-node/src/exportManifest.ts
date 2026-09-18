/** 将 PostgreSQL 图书元数据导出为静态模式使用的 manifest.json。 */
import { writeFile } from 'node:fs/promises'
import { getPool } from './db.js'
import { resolveStorageUrl } from './config.js'

const output = process.argv[2] || '../blog-frontend/public/books/manifest.json'
const pool = getPool()
try {
  const result = await pool.query<{
    slug: string
    title: string
    author: string
    description: string
    cover_url: string
    file_path: string
  }>('select slug, title, author, description, cover_url, file_path from books order by sort_order, created_at desc')
  const manifest = result.rows.map((book) => ({
    slug: book.slug,
    title: book.title,
    author: book.author,
    description: book.description,
    cover: resolveStorageUrl(book.cover_url),
    file: resolveStorageUrl(book.file_path),
  }))
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Exported ${manifest.length} books to ${output}`)
} finally {
  await pool.end()
}
