/** EPUB 压缩包解析：读取容器、OPF 清单并提取封面图片。 */
import { inflateRawSync } from 'node:zlib'

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
  data: Uint8Array
}

export interface EpubCover {
  bytes: Uint8Array
  contentType: string
  extension: string
  sourceName: string
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) return offset
  }
  return -1
}

function readZip(bytes: Uint8Array): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw new Error('EPUB 不是有效的 ZIP 文件')
  const count = u16(bytes, eocd + 10)
  const directorySize = u32(bytes, eocd + 12)
  const directoryOffset = u32(bytes, eocd + 16)
  if (directoryOffset + directorySize > bytes.length) throw new Error('EPUB ZIP 目录损坏')
  const entries = new Map<string, ZipEntry>()
  let offset = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error('EPUB ZIP 中央目录损坏')
    const flags = u16(bytes, offset + 8)
    const method = u16(bytes, offset + 10)
    const compressedSize = u32(bytes, offset + 20)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const localOffset = u32(bytes, offset + 42)
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength)
    const name = text(nameBytes).replaceAll('\\', '/')
    offset += 46 + nameLength + extraLength + commentLength
    if (flags & 0x1) continue // 加密条目无法在服务端解析。
    if (u32(bytes, localOffset) !== 0x04034b50) continue
    const localNameLength = u16(bytes, localOffset + 26)
    const localExtraLength = u16(bytes, localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.slice(start, start + compressedSize)
    let data: Uint8Array
    if (method === 0) data = compressed
    else if (method === 8) data = new Uint8Array(inflateRawSync(compressed))
    else continue
    entries.set(name, { name, method, compressedSize, localOffset, data })
  }
  return entries
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return match?.[1] || ''
}

function resolvePath(base: string, target: string): string {
  const clean = decodeURIComponent(target.replaceAll('\\', '/').split('#')[0])
  return new URL(clean, `https://epub.invalid/${base.replace(/^\/+/, '')}`).pathname.slice(1)
}

function mimeExtension(mediaType: string, filename: string): { contentType: string; extension: string } {
  const known: Record<string, [string, string]> = {
    'image/jpeg': ['image/jpeg', '.jpg'],
    'image/jpg': ['image/jpeg', '.jpg'],
    'image/png': ['image/png', '.png'],
    'image/gif': ['image/gif', '.gif'],
    'image/webp': ['image/webp', '.webp'],
    'image/svg+xml': ['image/svg+xml', '.svg'],
  }
  const normalized = mediaType.toLowerCase()
  if (known[normalized]) return { contentType: known[normalized][0], extension: known[normalized][1] }
  const extension = filename.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() || '.bin'
  return { contentType: mediaType || 'application/octet-stream', extension }
}

/** 从 EPUB 字节中提取封面，找不到封面时返回 null。 */
export function extractEpubCover(bytes: Uint8Array): EpubCover | null {
  const entries = readZip(bytes)
  const container = entries.get('META-INF/container.xml')
  if (!container) return null
  const rootfile = text(container.data).match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/i)?.[1]
  if (!rootfile) return null
  const opfPath = decodeURIComponent(rootfile.replaceAll('\\', '/'))
  const opf = entries.get(opfPath)
  if (!opf) return null
  const opfText = text(opf.data)
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>()
  for (const match of opfText.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0]
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (id && href) manifest.set(id, { href, mediaType: attr(tag, 'media-type'), properties: attr(tag, 'properties') })
  }
  let coverId = ''
  for (const match of opfText.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    if (attr(tag, 'name').toLowerCase() === 'cover') {
      coverId = attr(tag, 'content')
      break
    }
  }
  const candidate = (coverId ? manifest.get(coverId) : undefined)
    || [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('cover-image'))
    || [...manifest.values()].find((item) => /cover/i.test(item.href) && item.mediaType.startsWith('image/'))
  if (!candidate || !candidate.mediaType.startsWith('image/')) return null
  const sourceName = resolvePath(base, candidate.href)
  const image = entries.get(sourceName)
  if (!image || image.data.length === 0) return null
  const type = mimeExtension(candidate.mediaType, sourceName)
  return { bytes: image.data, contentType: type.contentType, extension: type.extension, sourceName }
}
