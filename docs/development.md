# 开发

## 本地预览

本地开发不要求先配置 R2。最小配置可以使用静态内容和前端 fallback：

```bash
cd blog-frontend
cp .env.example .env
# VITE_CONTENT_MODE=static
# VITE_USE_API=false
pnpm install
pnpm dev
```

如果需要测试 CMS 登录、GitHub 内容写入或 R2 上传，需要同时启动 Node API：

```bash
cd blog-node
cp .env.example .env
pnpm install
pnpm dev
```

本地 `.env` 至少填写 `SECRET_KEY`、`CMS_ADMIN_KEY`、`GITHUB_CONTENT_TOKEN`、
`GITHUB_REPOSITORY`。测试直传 R2 时再填写五个 `R2_*` 变量，并把 R2 bucket 的
CORS 允许来源设置为 `http://localhost:5173`，允许 `PUT`、`HEAD` 和 `GET`。

前端默认访问 `http://localhost:8787`；也可以把 `VITE_API_BASE_URL` 留空，使用
Vite 配置的 `/api` 代理。

## 安装

```bash
cd blog-node && pnpm install
cd ../blog-frontend && pnpm install
```

## 启动

终端一启动 Node API（GitHub + R2 模式无需数据库迁移）：

```bash
cd blog-node
cp .env.example .env
pnpm dev
```

终端二启动前端：

```bash
cd blog-frontend
pnpm dev
```

Vite 已将 `/api` 代理到 `http://localhost:8787`。需要直连其他 API 时设置 `VITE_API_BASE_URL`。

## 检查

```bash
cd blog-node && pnpm build
cd ../blog-frontend && pnpm type-check && pnpm test:unit -- --run && pnpm build
```

GitHub 内容路由放在 `blog-node/src/githubRoutes.ts`，PostgreSQL 兼容路由放在 `src/routes.ts`，内容适配器在 `src/content.ts`，对象存储在 `src/storage.ts`。新增平台时只修改入口适配器，不在路由中判断 Vercel 环境。
