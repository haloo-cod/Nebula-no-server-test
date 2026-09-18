/** 本地开发入口；生产环境由 Vercel Function 直接加载 app。 */
import { serve } from '@hono/node-server'
import app from './app.js'

serve({ fetch: app.fetch, port: Number(process.env.PORT || 8787) })
