# API 参考

默认 Base URL：`http://localhost:8787`。生产环境使用当前域名下的 `/api`，或设置前端 `VITE_API_BASE_URL` 指向独立 Node 服务。

Node API 使用 JSON 请求/响应，登录令牌通过响应体中的 `access_token` 返回，刷新令牌存放在 HttpOnly Cookie `blog_refresh_token`。需要管理员权限的请求带上 `Authorization: Bearer <access_token>`。

## 当前路由

| 模块 | 路由 |
| --- | --- |
| 健康检查 | `GET /health`、`GET /api/health` |
| 认证 | `POST /api/v1/auth/register`、`POST /api/v1/auth/login`、`POST /api/v1/auth/refresh`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me` |
| 文章 | `GET/POST /api/v1/posts`、`GET/PUT/DELETE /api/v1/posts/:slug`、`GET /api/v1/posts/stats` |
| 图书 | `GET /api/v1/books`、`GET /api/v1/books/:slug`、`GET /api/v1/books/:slug/read`、`POST /api/v1/books` |
| 相册 | `GET /api/v1/albums`、`GET /api/v1/albums/:id` |
| 展览 | `GET /api/v1/gallery`、`GET /api/v1/gallery/:slug` |
| 友链 | `GET /api/v1/friends` |
| 背景与轮播 | `GET /api/v1/backgrounds`、`GET /api/v1/carousel` |
| 酒馆与藏宝阁 | `GET /api/v1/tavern`、`GET /api/v1/tavern/config`、`GET /api/v1/treasures`、`GET /api/v1/treasures/categories` |
| 说说 | `GET /api/v1/moments`、`GET /api/v1/moments/:id`、`POST /api/v1/moments/:id/like`、`GET /api/v1/moments/:id/comments` |
| 评论 | `GET /api/v1/comments`、`GET /api/v1/comments/count`、`POST /api/v1/comments/batch-count` |
| 文件 | `GET/DELETE /api/v1/images`、`POST /api/v1/images/upload`、`GET/DELETE /api/v1/files`、`POST /api/v1/files/upload` |
| 统计 | `POST /api/v1/analytics/events`、`GET /api/v1/analytics/public-summary`、`GET /api/v1/analytics/overview` |

未列出的管理 CRUD 会按同一契约继续添加。R2 上传接口必须配置 R2 五项环境变量；没有 R2 时返回 `503`，不会写入函数实例磁盘。
