# @streamapp/hackernews

Hacker News 这一家在 Stream 里的全部知识。源本身是 RSSHub 的 `hackernews/*` 路由，这个包只管两件事：条目怎么渲染、打开时去哪取讨论。宿主不认识 Hacker News。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| normalizer `hackernews` | `normalizer.ts` | 认领 RSSHub 命名空间 `hackernews`：条目归成 `link`，并写下 `content.enrich = { source: 'hackernews-comments', params: { id }, prefetch: true }` |
| enricher `hackernews-comments` | `enrich.ts` | `/api/enrich?source=hackernews-comments&id=<story id>` → `{ article, comments, total, cursor: null }` |
| API 客户端 | `client.ts` | Firebase 取帖子元数据（一发），Algolia 取整棵评论树（一发） |

## 合同

- `id` 不是正整数 → 抛 `ValidationError`，宿主回 400。帖子已删 / 取不到 → 空对象，不报错。
- 链接帖的原文经 `ctx.readArticle(url)` 取——那是宿主 `source=link` 同一份正文抽取，包里不带第二份。Ask/Show HN 没有外链，帖子正文就是 article。
- 评论与帖子正文的 html 原样交出，消毒归宿主（收 enricher 时统一过一遍）。
- `prefetch: true` 的理由：两发站外裸 HTTP，不骑浏览器标签页，前端可以随列表滚动预取，卡片的摘要 / 首图 / 评论数靠这一步暖出来。

## 存量条目

`content.enrich` 在采集期写下。这个包装上之前入库的条目没有它，打开时不会有评论——对那些流跑一次 `POST /api/items/renormalize` 补上。
