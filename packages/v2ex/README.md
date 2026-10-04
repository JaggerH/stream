# @streamapp/v2ex

V2EX 这一家在 Stream 里的全部知识。源本身是 RSSHub 的 `v2ex/*` 路由，这个包只管两件事：主题怎么渲染、打开时去哪取回复。宿主不认识 V2EX。

## 管什么

| 东西 | 在哪 | 做什么 |
|---|---|---|
| normalizer `v2ex` | `normalizer.ts` | 认领 RSSHub 命名空间 `v2ex`：主题正文带图归 `gallery`、否则 `text`，并写下 `content.enrich = { source: 'v2ex-comments', params: { id }, prefetch: true }` |
| enricher `v2ex-comments` | `enrich.ts` | `/api/enrich?source=v2ex-comments&id=<topic id>` → `{ comments, total, cursor: null }`（v1 公开 API，一发给全，不要 token） |

## 合同

- `id` 不是正整数 → 抛 `ValidationError`，宿主回 400。上游失败 → 空回复列表，不报错。
- 主题正文已经在 feed 里，enricher 不再取 article。
- 回复的 html（`content_rendered`）原样交出，消毒归宿主（收 enricher 时统一过一遍）。
- `prefetch: true` 的理由：一发站外裸 HTTP，不骑浏览器标签页，前端可以随列表滚动预取。

## 存量条目

`content.enrich` 在采集期写下。这个包装上之前入库的条目没有它，打开时不会有回复——对那些流跑一次 `POST /api/items/renormalize` 补上。
