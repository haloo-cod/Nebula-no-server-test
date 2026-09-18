# Node.js Serverless API

这是项目的 Node.js 后端，使用 Hono + TypeScript，目标运行时为 Vercel Functions，同时支持 Cloudflare Workers 和普通 Node 服务器。它遵循前端使用的 `/api/v1` 响应格式。

## 本地运行

```bash
cd blog-node
pnpm install
cp .env.example .env
pnpm dev
```

GitHub + R2 内容模式不需要数据库，也不能依赖函数实例磁盘。配置 `GITHUB_CONTENT_TOKEN`、`GITHUB_REPOSITORY` 和 `CMS_ADMIN_KEY` 后，Markdown/JSON 会通过 GitHub Contents API 保存，EPUB/图片/视频写入 R2。只有启用账号、评论或自建统计时才需要 Neon、Supabase 等托管 PostgreSQL 的 `DATABASE_URL`。

## 当前已迁移

- `GET /health`
- `GET /api/v1/books`、`GET /api/v1/books/:slug`
- `GET /api/v1/posts`、`GET /api/v1/posts/:slug`
- `POST /api/v1/auth/cms-login`、`GET /api/v1/auth/me`（GitHub 内容模式）
- `POST /api/v1/auth/login`、`GET /api/v1/auth/me`（可选 PostgreSQL 模式）
- `POST /api/v1/analytics/events`、`GET /api/v1/analytics/public-summary`
- `GET /api/v1/analytics/overview`
- `POST /api/v1/images/upload`、`POST /api/v1/files/upload`（R2）

GitHub 模式已覆盖文章、展览、友链、资料、关于页、图书元数据、背景、轮播、相册和藏宝阁的基础读写，以及 CMS 密钥认证和 R2 EPUB 上传。账号、评论、酒馆互动和访问明细属于高频数据，按需接入 PostgreSQL、Supabase、Giscus 或托管分析服务。

已有 PostgreSQL 数据迁移时，可使用 `pnpm content:export-books [output]` 导出静态图书清单；新的 GitHub 模式直接维护 `content/books.json`。EPUB 文件和封面由 R2 公共 URL 提供。

## 部署到 Vercel

项目根目录的 `vercel.json` 已将 `/api/*` 指向 `api/[...path].ts`，静态前端与 Node Function 在同一个项目中部署。GitHub 模式设置 `GITHUB_CONTENT_TOKEN`、`GITHUB_REPOSITORY`、`CMS_ADMIN_KEY`、`SECRET_KEY` 和 R2 变量即可；启用 PostgreSQL 互动功能时再设置 `DATABASE_URL` 并执行一次 `pnpm db:migrate`。
