/** Hono 应用入口；可直接由 Vercel Function 或本地 Node 服务器加载。 */
import { cors } from 'hono/cors'
import { Hono } from 'hono'
import { api } from './routes.js'
import { githubApi } from './githubRoutes.js'
import { config, githubContentEnabled } from './config.js'
import { corsOrigin } from './http.js'
import type { AppEnv } from './auth.js'

const app = new Hono<AppEnv>()

app.use(
  '*',
  cors({
    origin: (origin) => corsOrigin(origin),
    allowHeaders: ['Content-Type', 'Authorization', 'Range'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'],
    credentials: true,
  }),
)

// GitHub 内容模式下只挂载无数据库路由，避免未配置数据库时请求意外落到
// PostgreSQL 兼容实现。未配置 GitHub 时仍保留完整的 PostgreSQL 兼容模式。
if (githubContentEnabled()) app.route('/', githubApi)
else app.route('/', api)

app.get('/', (c) => c.json({ message: 'Starlit Blog Node API is running', runtime: 'node' }))

app.onError((error, c) => {
  console.error('[node-api] unhandled error', error)
  return c.json({ detail: config.frontendUrl ? '服务器内部错误' : error.message }, 500)
})

export default app
