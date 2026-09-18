# 生产更新

Node 服务器部署时使用进程管理器（systemd、Docker 或平台内置服务）运行 `pnpm start`。Serverless 平台直接由 Git 提交触发构建，不需要常驻进程。

更新顺序（GitHub + R2 内容模式）：

1. 检查 GitHub 内容仓库提交和 R2 对象是否可访问。
2. 构建并运行 `pnpm build`。
3. 发布前端静态产物与 Node Function。
4. 访问 `/health` 检查运行时；若启用了 PostgreSQL 互动功能，再执行 `pnpm db:migrate` 并检查数据库连接。

GitHub 内容通过提交历史回滚和审阅；R2 文件删除前先检查内容引用。PostgreSQL 迁移采用向前兼容策略，大表变更应拆成多次发布。
