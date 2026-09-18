# 部署

## Vercel

项目根目录已经包含 `vercel.json`：前端构建输出为 `blog-frontend/dist`，`api/[...path].ts` 提供 `/api/*`。Root Directory 请选择仓库根目录，Framework 选择 Other。

GitHub + R2 模式的环境变量：

```env
SECRET_KEY=至少 32 位随机字符串
GITHUB_CONTENT_TOKEN=服务端 fine-grained token
GITHUB_REPOSITORY=owner/repository
GITHUB_CONTENT_BRANCH=main
CMS_ADMIN_KEY=另一组随机管理密钥
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=https://cdn.example.com
```

Vercel Function 不依赖本地文件，GitHub 内容通过 Contents API 提交，上传文件直接写入 R2。启用账号、评论或自建统计时，再增加托管 PostgreSQL 的 `DATABASE_URL`，并在部署前执行 `cd blog-node && pnpm db:migrate`。

## 普通 Node 服务器

```bash
cd blog-node
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm start
```

应用监听 `PORT` 环境变量，默认 `8787`。Nginx、Caddy 或 Cloudflare Tunnel 只需将 `/api/` 转发到该端口；静态前端可以由同一代理提供。GitHub + R2 模式不需要数据库。

## 纯静态模式

设置 `VITE_CONTENT_MODE=static` 和 `VITE_USE_API=false`，将 EPUB 与图片放入 R2，并生成 `public/books/manifest.json`。访问统计使用 Vercel Analytics、Plausible 或 Cloudflare Web Analytics；不需要 Node API。
