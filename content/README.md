# 内容仓库

此目录是 GitHub + R2 模式的内容模板。Node API 通过 GitHub Contents API 读写这些文件；浏览器不会接触 GitHub Token。

```text
content/
├── posts/*.md             # 文章，使用 YAML frontmatter
├── gallery/*.md           # 展览项目
├── friends.json           # 友链数组
├── friends-exchange.json  # 友链交换信息
├── profile.json           # 个人资料和社交链接
├── about.json             # 关于页 Markdown 与封面
├── books.json             # 图书元数据，file_path/cover_url 指向 R2
├── backgrounds.json       # 背景媒体索引
├── carousel.json          # 首页轮播索引
├── albums.json            # 相册和照片索引
├── moments.json           # 说说（可选）
├── treasures.json         # 藏宝阁
├── media-images.json      # R2 图片索引
└── media-files.json       # R2 普通文件索引
```

文章示例：

```markdown
---
title: "第一篇文章"
slug: first-post
date: "2026-09-17"
tags: [Vue, Node.js]
category: 技术
draft: false
---

正文写在这里。
```

EPUB、图片、视频等大文件不要提交到 Git；把它们上传到 R2 后，在 JSON 中保存对象键或公共 URL。
