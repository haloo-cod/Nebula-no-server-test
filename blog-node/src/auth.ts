/** JWT 认证；令牌字段与前端现有 API 契约保持一致。 */
import bcrypt from 'bcryptjs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
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

/** 为无数据库 CMS 发行短期管理员令牌。 */
export async function createCmsAccessToken(): Promise<string> {
  return new SignJWT({ type: 'cms-admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(secret)
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

/** 校验无数据库 CMS 管理员令牌。 */
export async function verifyCmsAccessToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload.type === 'cms-admin'
  } catch {
    return false
  }
}

/** 比较 CMS 管理密钥；密钥只从服务端环境变量读取。 */
export function matchesCmsAdminKey(value: string): boolean {
  const configured = config.cmsAdminKey
  if (!configured || !value || configured.length !== value.length) return false
  return timingSafeEqual(new TextEncoder().encode(configured), new TextEncoder().encode(value))
}

/** 判断请求是否带有 CMS 管理凭据。 */
export async function isCmsAdminRequest(c: Context<AppEnv>): Promise<boolean> {
  const directKey = c.req.header('x-cms-admin-key') || ''
  if (matchesCmsAdminKey(directKey)) return true
  const authorization = c.req.header('authorization') || ''
  if (!authorization.startsWith('Bearer ')) return false
  const token = authorization.slice(7)
  if (matchesCmsAdminKey(token)) return true
  return verifyCmsAccessToken(token)
}

export function hashIp(value: string): string {
  return createHash('sha256').update(`${config.analyticsHashSalt}:${value}`).digest('hex')
}

async function authenticate(c: Context<AppEnv>): Promise<Response | null> {
  // CMS 模式的管理员令牌不依赖 users 表，适合纯 GitHub + R2 部署。
  if (await isCmsAdminRequest(c)) {
    c.set('user', { id: 0, is_admin: true, is_active: true })
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
