# 无服务器部署方案

这个项目可以作为 Vue 静态站点部署到 Vercel、Cloudflare Pages 或 GitHub Pages；需要登录、评论和 CMS 时使用同仓库的 Node Serverless API。静态模式不启动 API，也不会把管理后台和用户交互伪装成可用功能。

## 推荐架构

```text
Git 仓库                          Vercel / Cloudflare Pages
  ├─ blog-frontend/src            ├─ Vite 构建产物
  ├─ public/books/manifest.json   └─ SPA 路由回退到 index.html
  └─ content/（可选）
                                      │
                                      └── R2 公共域名
                                           ├─ books/*.epub
                                           ├─ books/*.(jpg|webp)
                                           └─ images/*
```

`VITE_CONTENT_MODE=static` 时，前台页面直接使用仓库中的静态内容；图书页从 `public/books/manifest.json` 读取元数据，EPUB 和封面从 `VITE_R2_PUBLIC_URL` 拼接对象键。`VITE_USE_API=false` 会关闭访问统计 API、评论、点赞、登录和后台请求。

## Vercel 配置

在 Vercel 项目中将 Root Directory 保持为仓库根目录，Framework 选择 Other。根目录 `vercel.json` 会执行前端构建，并由 `api/[...path].ts` 提供 `/api/*` Node Function；同一个项目同时提供静态文件和 API，不需要创建第二个 Vercel 项目。`blog-frontend/vercel.json` 只用于把前端目录单独部署时的兼容场景。

生产环境变量：

```env
VITE_CONTENT_MODE=static
VITE_USE_API=false
VITE_R2_PUBLIC_URL=https://cdn.example.com
VITE_ANALYTICS_PROVIDER=vercel

# 保留 CMS 时使用同域 Node Function；GitHub + R2 模式不需要 PostgreSQL。
SECRET_KEY=至少 32 位随机字符串
GITHUB_CONTENT_TOKEN=服务端 fine-grained token
GITHUB_REPOSITORY=owner/repository
CMS_ADMIN_KEY=另一组随机管理密钥
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=https://cdn.example.com
```

## R2 CORS

R2 桶不要暴露管理凭据，只配置一个公开读取域名（推荐通过 Cloudflare Custom Domain）。为该域名配置以下 CORS：

```json
[
  {
    "AllowedOrigins": ["https://your-domain.example"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "Content-Type", "Origin", "Accept"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

EPUB 本身是 ZIP 包。浏览器需要先读取 EPUB，再读取包内章节、CSS 和图片，因此同一个 R2 域名必须允许跨域读取完整 EPUB 文件。对象响应应保留 `Content-Type: application/epub+zip`；封面使用正确的图片 MIME 类型。

## 图书清单迁移

将 PostgreSQL 中的图书记录导出为清单：

```bash
cd blog-node
pnpm content:export-books ../blog-frontend/public/books/manifest.json
```

随后把每本书的 EPUB 和封面上传到 R2，使 `file_path` 和 `cover_url` 对应清单中的对象键。脚本只负责迁移元数据，不会上传文件，也不会把受版权保护的文件提交到 Git。

## 访问记录怎么做

静态页面没有可写的数据库连接，因此不要继续调用 API 的 `/analytics/events`。本项目在 `VITE_ANALYTICS_PROVIDER=vercel` 时加载 Vercel Web Analytics 脚本；Vercel 会在平台控制台提供 PV、访客趋势和页面维度统计。需要自定义事件时使用 Node API + PostgreSQL。

如果需要更强的隐私控制，可把统计脚本换成 Plausible、Umami 或 Cloudflare Web Analytics。需要自定义事件明细时，Node API 可选写入 PostgreSQL；限流等高频短期状态可按部署平台改用 Upstash Redis 或 Cloudflare KV。

## Node 模板后端

`blog-node/` 是正式后端实现，使用 Hono 的 Web 标准 `fetch` 接口，因此可以运行在 Vercel、Cloudflare Workers、Node 服务器或其他支持 Web API 的平台。内容访问通过 GitHub Contents API，对象文件通过 S3 兼容的 R2 适配层；可选互动功能才访问 PostgreSQL，业务代码不依赖本地磁盘。

当前 Node 版已覆盖健康检查、文章/图书公开读取、JWT 登录、当前用户、访问事件、统计概览和 R2 图片/文件上传。剩余 CMS 模块按同一 `/api/v1` 契约迁移；迁移期间可用 `api-node/[...path].ts` 挂载到 `/api-node/*` 联调，再将生产 rewrite 切换到 Node。
