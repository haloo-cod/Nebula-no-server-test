/** Node Serverless 版本的环境变量读取。 */

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

export const config = {
  databaseUrl: env('DATABASE_URL'),
  secretKey: env('SECRET_KEY', 'change-me-in-production'),
  /** CMS 管理密钥只在服务端使用；不要把 GitHub PAT 发送到浏览器。 */
  cmsAdminKey: env('CMS_ADMIN_KEY', env('GITHUB_ADMIN_KEY')),
  /** GitHub Contents API 配置；用于保存 Markdown/JSON 内容。 */
  githubToken: env('GITHUB_CONTENT_TOKEN', env('GITHUB_TOKEN')),
  githubRepository: env('GITHUB_REPOSITORY'),
  githubBranch: env('GITHUB_CONTENT_BRANCH', 'main'),
  githubContentRoot: env('GITHUB_CONTENT_ROOT', 'content').replace(/^\/+|\/+$/g, ''),
  githubApiUrl: env('GITHUB_API_URL', 'https://api.github.com').replace(/\/+$/, ''),
  githubCommitterName: env('GITHUB_COMMITTER_NAME', 'Starlit Blog CMS'),
  githubCommitterEmail: env('GITHUB_COMMITTER_EMAIL', 'cms@users.noreply.github.com'),
  frontendUrl: env('FRONTEND_URL', 'http://localhost:5173'),
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  analyticsHashSalt: env('ANALYTICS_HASH_SALT', 'change-analytics-salt'),
  r2AccountId: env('R2_ACCOUNT_ID'),
  r2AccessKeyId: env('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  r2BucketName: env('R2_BUCKET_NAME'),
  r2PublicUrl: env('R2_PUBLIC_URL'),
  nodeEnv: env('NODE_ENV', 'development'),
} as const

/** 返回 GitHub 内容仓库是否已配置。 */
export function githubContentEnabled(): boolean {
  return Boolean(config.githubToken && config.githubRepository)
}

/** 返回 R2 配置是否完整。 */
export function r2Enabled(): boolean {
  return Boolean(
    config.r2AccountId &&
      config.r2AccessKeyId &&
      config.r2SecretAccessKey &&
      config.r2BucketName &&
      config.r2PublicUrl,
  )
}

/** 将数据库中的本地路径或 R2 对象键转换为可访问地址。 */
export function resolveStorageUrl(value: string): string {
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  // API 资源路径仍需经过当前 Node 入口，不能误拼成 R2 对象键。
  if (value.startsWith('/api/')) return value
  if (!r2Enabled()) return value.startsWith('/') ? value : `/${value}`
  const key = value.replace(/^\/uploads\//, '').replace(/^\/+/, '')
  return `${config.r2PublicUrl.replace(/\/+$/, '')}/${key}`
}
