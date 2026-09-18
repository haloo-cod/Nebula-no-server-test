# 架构

Starlit Blog 是一个 Vue 3 SPA 与 Node.js API 组成的模板。API 使用 Hono 的 Web 标准 `fetch` 接口，因此业务层不依赖 Vercel：同一套代码可以部署到 Vercel Functions、Cloudflare Workers、普通 Node 服务器或其他兼容运行时。

```text
blog-frontend/              Vue 3 + Vite 静态站点
blog-node/src/app.ts        Hono 应用（平台无关）
api/[...path].ts            Vercel 适配器
blog-node/src/server.ts     Node HTTP 适配器
blog-node/migrations/       可选 PostgreSQL 迁移
content/                    GitHub Markdown/JSON 内容仓库
```

## 数据边界

- GitHub 保存 Markdown 文章/展览，以及友链、资料、图书元数据、相册、背景、轮播和藏宝阁 JSON。
- Cloudflare R2 保存 EPUB、图片、视频和其他大文件。
- PostgreSQL 只作为可选互动数据层，保存账号、评论、会话和自建统计明细。
- 前端静态模式读取仓库中的构建内容与 R2 公共 URL，不需要 API 或数据库。
- Serverless 请求不写本地磁盘，也不在请求期间执行数据库迁移。

## 适配器

`blog-node/src/app.ts` 导出标准 `fetch` 应用。`api/[...path].ts` 只负责 Vercel 适配，`src/server.ts` 只负责本地 Node 监听；迁移到其他平台时只需替换最外层适配器。

## API 契约

前端继续使用 `/api/v1` 路径。GitHub 模式不配置数据库也能运行内容站点；需要账号、评论或自建统计时，再启用 PostgreSQL 或替换为 Supabase、Giscus、Plausible 等外部服务。
