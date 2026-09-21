/** JWT 认证；令牌字段与前端现有 API 契约保持一致。 */
import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { CompactEncrypt, SignJWT, compactDecrypt, jwtVerify } from 'jose'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { config, githubContentEnabled } from './config.js'
import { json } from './http.js'
import { query } from './db.js'

const secret = new TextEncoder().encode(config.secretKey)

export interface UserClaims {
  id: number
  is_admin: boolean
  is_active: boolean
  githubToken?: string
  githubLogin?: string
  githubName?: string
  githubEmail?: string
}

/** GitHub OAuth 管理员身份，用于签发会话和归属内容提交。 */
export interface GithubIdentity {
  token: string
  login: string
  name: string
  email: string
}

export interface AppEnv {
  Variables: { user: UserClaims }
}

export async function createAccessToken(userId: number): Promise<string> {
  return new SignJWT({ sub: String(userId), type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret)
}

function githubSessionKey(): Uint8Array {
  return createHash('sha256').update(config.secretKey).digest()
}

/** 将 GitHub OAuth token 加密进短期会话令牌，避免浏览器可读明文 PAT。 */
export async function createGithubAccessToken(identity: GithubIdentity): Promise<string> {
  const payload = JSON.stringify({
    type: 'github-admin',
    token: identity.token,
    login: identity.login,
    name: identity.name,
    email: identity.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  })
  return new CompactEncrypt(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(githubSessionKey())
}

/** 解密并校验 GitHub OAuth 管理员会话。 */
export async function verifyGithubAccessToken(token: string): Promise<GithubIdentity | null> {
  try {
    const { plaintext } = await compactDecrypt(token, githubSessionKey())
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<GithubIdentity> & { type?: string; exp?: number }
    if (
      value.type !== 'github-admin' ||
      !value.token ||
      !value.login ||
      !value.email ||
      !value.exp ||
      value.exp < Math.floor(Date.now() / 1000)
    ) return null
    return { token: value.token, login: value.login, name: value.name || value.login, email: value.email }
  } catch {
    return null
  }
}

/** 创建有时效的 OAuth state，防止回调被跨站伪造。 */
export async function createGithubOAuthState(redirect: string): Promise<string> {
  return new SignJWT({ type: 'github-oauth-state', redirect })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret)
}

/** 校验 OAuth state 并取回安全的站内跳转地址。 */
export async function verifyGithubOAuthState(state: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(state, secret)
    if (payload.type !== 'github-oauth-state' || typeof payload.redirect !== 'string') return null
    return payload.redirect.startsWith('/') && !payload.redirect.startsWith('//') ? payload.redirect : '/'
  } catch {
    return null
  }
}

/** 读取请求中的 GitHub 管理员会话令牌。 */
export async function githubSessionFromRequest(c: Context<AppEnv>): Promise<GithubIdentity | null> {
  const authorization = c.req.header('authorization') || ''
  if (authorization.startsWith('Bearer ')) return verifyGithubAccessToken(authorization.slice(7))
  const cookieToken = getCookie(c, 'github_admin_token')
  return cookieToken ? verifyGithubAccessToken(cookieToken) : null
}

/** 从当前请求中读取 GitHub 身份，用于 GitHub 提交 author/committer。 */
export async function githubIdentityFromRequest(c: Context<AppEnv>): Promise<GithubIdentity | null> {
  const session = await githubSessionFromRequest(c)
  if (session) return session
  const user = c.get('user')
  if (!user?.githubToken || !user.githubLogin || !user.githubEmail) return null
  return { token: user.githubToken, login: user.githubLogin, name: user.githubName || user.githubLogin, email: user.githubEmail }
}

/** 创建只存储摘要的刷新令牌，避免数据库泄露后令牌可直接使用。 */
export function createRefreshToken(): string {
  return randomBytes(48).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 创建登录会话并设置 HttpOnly Cookie。 */
export async function createSession(c: Context<AppEnv>, userId: number): Promise<string> {
  const refreshToken = createRefreshToken()
  await query(
    `insert into auth_sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + interval '30 days')`,
    [userId, hashToken(refreshToken)],
  )
  setCookie(c, 'blog_refresh_token', refreshToken, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/api/v1/auth',
    maxAge: 60 * 60 * 24 * 30,
  })
  return refreshToken
}

export async function refreshSession(c: Context<AppEnv>): Promise<number | null> {
  const token = getCookie(c, 'blog_refresh_token')
  if (!token) return null
  const result = await query<{ user_id: number }>(
    `select user_id from auth_sessions
     where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [hashToken(token)],
  )
  const session = result.rows[0]
  if (!session) return null
  await query('update auth_sessions set revoked_at = now(), updated_at = now() where token_hash = $1', [hashToken(token)])
  await createSession(c, session.user_id)
  return session.user_id
}

export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, 'blog_refresh_token', { path: '/api/v1/auth' })
}

export async function verifyAccessToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    const userId = Number(payload.sub)
    return payload.type === 'access' && Number.isInteger(userId) ? userId : null
  } catch {
    return null
  }
}

/** 判断请求是否带有 CMS 管理凭据。 */
export async function isCmsAdminRequest(c: Context<AppEnv>): Promise<boolean> {
  const authorization = c.req.header('authorization') || ''
  if (!authorization.startsWith('Bearer ')) return false
  const token = authorization.slice(7)
  return Boolean(await verifyGithubAccessToken(token))
}

export function hashIp(value: string): string {
  return createHash('sha256').update(`${config.analyticsHashSalt}:${value}`).digest('hex')
}

async function authenticate(c: Context<AppEnv>): Promise<Response | null> {
  // CMS 模式的管理员令牌不依赖 users 表，适合纯 GitHub + R2 部署。
  const session = await githubSessionFromRequest(c)
  if (session) {
    c.set('user', { id: 0, is_admin: true, is_active: true, githubToken: session.token, githubLogin: session.login, githubName: session.name, githubEmail: session.email })
    return null
  }
  // GitHub 内容模式没有 users 表；无效的 CMS 凭据直接返回 401，不能继续访问数据库。
  if (githubContentEnabled()) return json(c, { detail: '未登录或登录已过期' }, 401)
  const authorization = c.req.header('authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const userId = await verifyAccessToken(token)
  if (!userId) return json(c, { detail: '未登录或登录已过期' }, 401)
  const result = await query<{ id: number; is_admin: boolean; is_active: boolean }>(
    'select id, is_admin, is_active from users where id = $1',
    [userId],
  )
  const user = result.rows[0]
  if (!user || !user.is_active) return json(c, { detail: '账户不可用' }, 401)
  c.set('user', user)
  return null
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const error = await authenticate(c)
  if (error) return error
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const error = await authenticate(c)
  if (error) return error
  const user = c.get('user')
  if (!user.is_admin) return json(c, { detail: '需要管理员权限' }, 403)
  await next()
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash)
}

/** 生成 bcrypt 密码摘要。 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

/** 撤销当前刷新会话，不轮换令牌。 */
export async function revokeSession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, 'blog_refresh_token')
  if (token) {
    await query('update auth_sessions set revoked_at = now(), updated_at = now() where token_hash = $1', [hashToken(token)])
  }
  clearSession(c)
}
