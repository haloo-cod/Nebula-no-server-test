/** Vercel Serverless 入口；业务应用使用 Web 标准 fetch，可迁移到其他平台。 */
import { handle } from 'hono/vercel'
import app from '../blog-node/src/app.js'

export default handle(app)
