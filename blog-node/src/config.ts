/** Node Serverless 版本的环境变量读取。 */

// 本地开发自动读取 blog-node/.env；Vercel 等平台继续使用平台注入的环境变量。
import 'dotenv/config'

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

export const config = {
  databaseUrl: env('DATABASE_URL'),
  secretKey: env('SECRET_KEY', 'change-me-in-production'),
  /** GitHub Contents API 配置；用于保存 Markdown/JSON 内容。 */
  githubToken: env('GITHUB_CONTENT_TOKEN', env('GITHUB_TOKEN')),
  githubRepository: env('GITHUB_REPOSITORY'),
  githubBranch: env('GITHUB_CONTENT_BRANCH', 'main'),
  githubContentRoot: env('GITHUB_CONTENT_ROOT', 'content').replace(/^\/+|\/+$/g, ''),
  githubApiUrl: env('GITHUB_API_URL', 'https://api.github.com').replace(/\/+$/, ''),
  githubClientId: env('GITHUB_CLIENT_ID'),
  githubClientSecret: env('GITHUB_CLIENT_SECRET'),
  githubOAuthRedirectUri: env('GITHUB_OAUTH_REDIRECT_URI'),
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

/** 返回 GitHub OAuth 是否已配置；后台权限由仓库 owner 校验决定。 */
export function githubOAuthEnabled(): boolean {
  return Boolean(
    config.githubClientId &&
      config.githubClientSecret &&
      config.githubOAuthRedirectUri,
  )
}

/** 返回 R2 配置中缺失或格式错误的字段名，不返回任何密钥内容。 */
export function r2ConfigIssues(): string[] {
  const issues: string[] = []
  if (!config.r2AccountId) issues.push('R2_ACCOUNT_ID 未填写')
  else if (config.r2AccountId.length !== 32) issues.push('R2_ACCOUNT_ID 应为 32 个字符')
  if (!config.r2AccessKeyId) issues.push('R2_ACCESS_KEY_ID 未填写')
  else if (config.r2AccessKeyId.length !== 32) issues.push('R2_ACCESS_KEY_ID 应为 32 个字符')
  if (!config.r2SecretAccessKey) issues.push('R2_SECRET_ACCESS_KEY 未填写')
  else if (config.r2SecretAccessKey.length !== 64) issues.push('R2_SECRET_ACCESS_KEY 应为 64 个字符')
  if (!config.r2BucketName) issues.push('R2_BUCKET_NAME 未填写')
  if (!config.r2PublicUrl) issues.push('R2_PUBLIC_URL 未填写')
  else if (!/^https?:\/\//i.test(config.r2PublicUrl)) issues.push('R2_PUBLIC_URL 必须是 http(s) 地址')
  return issues
}

/** 返回 R2 配置是否完整且符合 Cloudflare R2 凭据格式。 */
export function r2Enabled(): boolean {
  return r2ConfigIssues().length === 0
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
