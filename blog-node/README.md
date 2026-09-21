# Node.js Serverless API

这是项目的 Node.js 后端，使用 Hono + TypeScript，目标运行时为 Vercel Functions，同时支持 Cloudflare Workers 和普通 Node 服务器。它遵循前端使用的 `/api/v1` 响应格式。

## 本地运行

```bash
cd blog-node
pnpm install
cp .env.example .env
pnpm dev
```

GitHub 内容模式不需要数据库，也不能依赖函数实例磁盘。配置 `GITHUB_CONTENT_TOKEN`、`GITHUB_REPOSITORY` 后，Markdown/JSON 会通过 GitHub Contents API 保存。后台仅允许 GitHub 仓库拥有者通过 OAuth 登录。图片上传可在后台选择 GitHub 或 R2；选择 GitHub 时文件写入 `content/media/` 并通过 GitHub Raw 地址访问，单文件限制 8MB；选择 R2 时文件写入 R2。未配置 R2 时只能选择 GitHub，EPUB 等大文件仍需要 R2。只有启用普通账号、评论或自建统计时才需要 Neon、Supabase 等托管 PostgreSQL 的 `DATABASE_URL`。

## 当前已迁移

- `GET /health`
- `GET /api/v1/books`、`GET /api/v1/books/:slug`
- `GET /api/v1/posts`、`GET /api/v1/posts/:slug`
- `GET /api/v1/auth/github`、`GET /api/v1/auth/github/callback`（GitHub OAuth 管理员登录）
- `GET /api/v1/auth/me`（GitHub OAuth 管理员会话）
- `POST /api/v1/analytics/events`、`GET /api/v1/analytics/public-summary`
- `GET /api/v1/analytics/overview`
- `POST /api/v1/images/upload`、`POST /api/v1/files/upload`（可选择 GitHub 或 R2）

GitHub 模式已覆盖文章、展览、友链、资料、关于页、图书元数据、背景、轮播、相册、藏宝阁和评论的基础读写，以及 GitHub OAuth 和 R2 EPUB 上传。页面评论写入 `comments.json`，说说评论写入 `moment-comments.json`，每次新增或删除都会产生 Git 提交。账号、酒馆互动和访问明细仍按需接入 PostgreSQL、Supabase 或托管分析服务。

已有 PostgreSQL 数据迁移时，可使用 `pnpm content:export-books [output]` 导出静态图书清单；新的 GitHub 模式直接维护 `content/books.json`。EPUB 文件和封面由 R2 公共 URL 提供。

## 部署到 Vercel

项目根目录的 `vercel.json` 已将 `/api/*` 指向 `api/[...path].ts`，静态前端与 Node Function 在同一个项目中部署。GitHub 模式设置 `GITHUB_CONTENT_TOKEN`、`GITHUB_REPOSITORY`、GitHub OAuth 三项变量、`SECRET_KEY` 和 R2 变量即可；启用 PostgreSQL 互动功能时再设置 `DATABASE_URL` 并执行一次 `pnpm db:migrate`。
