# 可选互动数据库

GitHub + R2 内容模式不需要数据库。Markdown、友链、个人资料和图书清单保存在 GitHub 仓库，EPUB、图片和视频保存在 R2。只有账号、评论、会话或自建统计等需要并发写入的功能才启用托管 PostgreSQL。

## 初始化

```bash
cd blog-node
cp .env.example .env
# 只有启用互动功能时才填写 DATABASE_URL
```

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

```bash
cd blog-node
pnpm db:migrate
```

迁移文件位于 [`blog-node/migrations/001_initial.sql`](../blog-node/migrations/001_initial.sql)。迁移命令是幂等的，应该在部署流水线或数据库控制台执行一次，不要在 API 请求中自动建表。

## 生产建议

- 使用 Neon、Supabase 或其他托管 PostgreSQL，并开启 TLS。
- `DATABASE_URL`、`SECRET_KEY`、GitHub Token、CMS 管理密钥和 R2 密钥只配置在平台环境变量中。
- GitHub Token 仅由 Node 服务端调用 Contents API，不能放入 `VITE_*` 变量或浏览器代码。
- 定期使用数据库服务的备份功能；R2 文件启用版本控制或生命周期策略。
- 访问统计优先使用 Vercel Analytics、Plausible、Umami 或 Cloudflare Web Analytics；只有需要自定义明细时才写入 PostgreSQL。
