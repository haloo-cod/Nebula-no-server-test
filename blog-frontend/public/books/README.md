# R2 图书清单

静态部署时，`manifest.json` 描述 R2 中的 EPUB 和封面。`file`、`key` 和 `cover` 可以写完整 URL，也可以写相对于 `VITE_R2_PUBLIC_URL` 的对象键。

```json
[
  {
    "slug": "the-little-prince",
    "title": "小王子",
    "author": "Antoine de Saint-Exupéry",
    "description": "",
    "key": "books/the-little-prince.epub",
    "cover": "books/the-little-prince.jpg"
  }
]
```

R2 桶需要为站点域名配置 CORS，至少允许 `GET`、`HEAD` 和 `OPTIONS`，并允许 `Range` 请求及暴露 `Content-Length`、`Content-Range`。EPUB 目录内的 XHTML、CSS、图片也必须能从同一个公共域名读取。
