/**
 * GitHub Contents API 适配层。
 *
 * 小体积内容（Markdown、JSON、站点配置）直接保存在 Git 仓库，
 * Node Function 只持有服务端 Token，浏览器不会接触 GitHub 凭据。
 */
import { githubContentEnabled, config } from './config.js'

export interface GithubFile {
  path: string
  sha: string
  content: string
}

interface GithubApiFile {
  type: string
  path: string
  sha: string
  content?: string
  encoding?: string
  download_url?: string | null
}

interface GithubDirectoryEntry {
  type: string
  path: string
  sha: string
  download_url?: string | null
}

interface GithubCommitResponse {
  content?: { path: string; sha: string }
  commit?: { sha: string }
}

/** 将仓库相对路径规范化，阻止路径穿越。 */
export function normalizeContentPath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some((part) => part === '..')) throw new Error('GitHub 内容路径不正确')
  const normalized = parts.filter((part) => part && part !== '.').join('/')
  if (!normalized || normalized.includes('..')) throw new Error('GitHub 内容路径不正确')
  return normalized
}

function repositoryPath(path: string): string {
  const repository = config.githubRepository.trim().replace(/^\/+|\/+$/g, '')
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY 必须是 owner/repository 格式')
  }
  return `/repos/${repository}/contents/${normalizeContentPath(path)}`
}

function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.githubToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'starlit-blog-cms',
  }
}

/** 在 Node 与 Edge 运行时都可用的 UTF-8 Base64 解码。 */
function decodeBase64(value: string): string {
  const binary = globalThis.atob(value.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 在 Node 与 Edge 运行时都可用的 UTF-8 Base64 编码。 */
function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

async function githubRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!githubContentEnabled()) {
    throw new Error('GitHub 内容仓库未配置')
  }
  const response = await fetch(`${config.githubApiUrl}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const error = new Error(`GitHub API 请求失败 (${response.status})`)
    ;(error as Error & { status?: number; detail?: string }).status = response.status
    ;(error as Error & { status?: number; detail?: string }).detail = detail.slice(0, 500)
    throw error
  }
  return (await response.json()) as T
}

/** 读取仓库中的单个文本文件；文件不存在时返回 null。 */
export async function getGithubFile(path: string): Promise<GithubFile | null> {
  if (!githubContentEnabled()) throw new Error('GitHub 内容仓库未配置')
  try {
    const result = await githubRequest<GithubApiFile>(
      `${repositoryPath(path)}?ref=${encodeURIComponent(config.githubBranch)}`,
    )
    if (result.type !== 'file' || !result.content) return null
    const raw = result.content.replace(/\s/g, '')
    const content = decodeBase64(raw)
    return { path: result.path, sha: result.sha, content }
  } catch (error: unknown) {
    const status = (error as { status?: number }).status
    if (status === 404) return null
    throw error
  }
}

/** 列出仓库目录中的文件；目录不存在时返回空数组。 */
export async function listGithubFiles(path: string): Promise<GithubDirectoryEntry[]> {
  try {
    const result = await githubRequest<GithubDirectoryEntry[] | GithubApiFile>(
      `${repositoryPath(path)}?ref=${encodeURIComponent(config.githubBranch)}`,
    )
    return Array.isArray(result) ? result.filter((item) => item.type === 'file') : []
  } catch (error: unknown) {
    const status = (error as { status?: number }).status
    if (status === 404) return []
    throw error
  }
}

/** 写入或更新仓库文件，并返回新的提交信息。 */
export async function putGithubFile(
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<GithubCommitResponse> {
  const payload = {
    message,
    content: encodeBase64(content),
    branch: config.githubBranch,
    committer: { name: config.githubCommitterName, email: config.githubCommitterEmail },
    ...(sha ? { sha } : {}),
  }
  return githubRequest<GithubCommitResponse>(repositoryPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 删除仓库文件。 */
export async function deleteGithubFile(path: string, message: string, sha: string): Promise<void> {
  await githubRequest(repositoryPath(path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      sha,
      branch: config.githubBranch,
      committer: { name: config.githubCommitterName, email: config.githubCommitterEmail },
    }),
  })
}

/** 读取 JSON 内容文件；不存在时返回调用方给出的默认值。 */
export async function getGithubJson<T>(path: string, fallback: T): Promise<T> {
  const file = await getGithubFile(path)
  if (!file) return fallback
  try {
    return JSON.parse(file.content) as T
  } catch {
    throw new Error(`GitHub 内容文件不是有效 JSON：${path}`)
  }
}

/** 序列化并写入 JSON 内容文件。 */
export async function putGithubJson(path: string, value: unknown, message: string): Promise<void> {
  const current = await getGithubFile(path)
  await putGithubFile(path, `${JSON.stringify(value, null, 2)}\n`, message, current?.sha)
}

/** 返回内容文件在仓库中的完整路径。 */
export function contentPath(path: string): string {
  return `${config.githubContentRoot}/${normalizeContentPath(path)}`
}
