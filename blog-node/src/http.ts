/** HTTP 响应和请求辅助函数。 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { config } from './config.js'

export function json(c: Context, value: unknown, status = 200): Response {
  return c.json(value, status as ContentfulStatusCode)
}

/** 从代理请求头中提取客户端 IP。 */
export function clientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  )
}

/** 根据允许列表选择 CORS Origin。 */
export function corsOrigin(requestOrigin: string | undefined): string {
  if (requestOrigin && config.corsOrigins.includes(requestOrigin)) return requestOrigin
  return config.corsOrigins[0] || '*'
}

/** 解析页码并限制最大值。 */
export function parsePage(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

/** 解析分页大小并限制最大值。 */
export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}
