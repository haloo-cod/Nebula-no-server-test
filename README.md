# Starlit Blog

> 当前版本支持图片和 MP4/WebM/MOV 视频背景。视频可由后台上传，也可从文件管理中的视频选择；桌面端使用 WebGL 液态玻璃采样，移动端使用 CSS 毛玻璃。

一个前后端分离的个人博客与内容管理系统，包含公开博客、图书阅读、相册、说说、藏宝阁、自习室、访问统计和管理后台。

## 特性

- Vue 3 + TypeScript + Vite 前端 SPA
- Node.js + Hono + TypeScript Serverless 后端
- Markdown 文章管理、导入、导出和代码高亮
- CMS 管理密钥登录；需要用户账号时可选接入 PostgreSQL
- 文章、相册、图书、背景图、轮播图、友链和文件管理
- WebGL 液态玻璃效果，桌面端默认启用，移动端默认使用 CSS 毛玻璃
- EPUB 阅读器、访问统计和管理员后台
- GitHub Contents API 内容仓库与 Cloudflare R2 对象存储
- 可选 PostgreSQL（评论、账号、互动统计等高频数据）

## 目录结构

```text
My_blog/
├── blog-frontend/       # Vue 3 前端
├── blog-node/           # Node.js + Hono 后端
├── docs/                # 架构、API、数据库和部署文档
├── AGENTS.md            # 项目开发约定
└── README.md
```

## 环境要求

- Node.js `20.19+` 或 `22.12+`
- pnpm

## 本地运行

### Node API（GitHub + R2 模式）

```bash
cd blog-node
pnpm install
cp .env.example .env
pnpm dev
```

Node API 默认地址为 `http://localhost:8787`，健康检查地址为 `http://localhost:8787/health`。纯内容模式只需要配置 `GITHUB_CONTENT_TOKEN`、`GITHUB_REPOSITORY` 和 `CMS_ADMIN_KEY`；GitHub Token 仅存在于 Node 服务端环境变量。

如果启用了账号、评论或自建统计，再填写托管 PostgreSQL 的 `DATABASE_URL`，并执行 `pnpm db:migrate`。这部分数据不会写入内容仓库。

### 前端

```bash
cd blog-frontend
pnpm install
cp .env.example .env
pnpm dev
```

前端默认地址为 `http://localhost:5173`。Vite 已将 `/api` 代理到 `http://localhost:8787`；也可以在 `blog-frontend/.env` 中设置 `VITE_API_BASE_URL=http://localhost:8787`。

常用命令：

```bash
pnpm type-check
pnpm build
pnpm test:unit
```

## 资源与数据

生产环境的小型内容由 Node API 通过 GitHub Contents API 提交到内容仓库；EPUB、图片、视频和其他大文件写入 R2。前端 `src/assets/` 中保留了按用途划分的空目录，方便开发者放入本地 UI 预览资源。

生产数据存储位置：

- `content/`：GitHub 内容仓库中的 Markdown 和 JSON
- `blog-node/`：Node API、GitHub Contents、可选数据库和 R2 适配层
- GitHub：文章、友链、资料、相册、背景、轮播、藏宝阁和图书元数据
- Cloudflare R2：图片、EPUB、视频和其他上传文件
- 可选 PostgreSQL：用户、评论、会话和自建统计明细

这些目录均不应提交到公开仓库。仓库中的 `.env.example` 只提供配置模板，不包含真实密钥。

## 文档

- `docs/architecture.md`：系统架构
- `docs/api-reference.md`：API 参考
- `docs/database.md`：可选互动数据库说明
- `docs/deployment.md`：部署说明
- `docs/frontend-features.md`：液态玻璃与 EPUB 阅读器实现说明
- `AGENTS.md`：开发约定

## 当前状态

项目仍在持续开发中，API 和管理后台可能发生变化。欢迎提交 Issue 或 Pull Request。

文档补充：

- `docs/background-media.md`：图片/视频背景、媒体访问和引用保护
- `docs/production-update.md`：生产环境更新、备份和重启流程
- `docs/static-deployment.md`：Vercel/Cloudflare Pages 无服务器部署、R2 图书和访问统计

## License

本项目使用 [MIT License](LICENSE)。
