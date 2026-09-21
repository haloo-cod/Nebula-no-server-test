/** Vercel Serverless 入口；业务应用使用 Web 标准 fetch，可迁移到其他平台。 */
import { handle } from 'hono/vercel'
import app from '../blog-node/src/app.js'

const honoHandler = handle(app)

/** Vercel 的动态 Function 在部分路由配置下会剥掉 /api 前缀；Hono 路由保留该前缀。 */
export default function handler(req, res) {
  const requestUrl = req.url || '/'
  if (!requestUrl.startsWith('/api/')) {
    req.url = `/api${requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`}`
  }
  return honoHandler(req, res)
}
