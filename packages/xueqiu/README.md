# @streamapp/xueqiu — 雪球

雪球的全部站点知识住在这个包里：两份 recipe（`xueqiu-user` / `xueqiu-detail`，都骑用户自己 Chrome 里的
登录态跑）+ 一格代码槽位。宿主源码里没有这家站的域名、标识符或源 id。

## 能力

| 能力 | 谁提供 | 前端 / 调用方怎么到 |
|---|---|---|
| **采集**某个用户的动态 | recipe `xueqiu-user`（`user_timeline.json`，kind:fetch） | 订阅这个源；`meta.uses` 申报了 `xueqiu-detail` |
| **渲染**动态 | normalizer `xueqiu`（`normalizer.ts`） | 采集期写 `Content`：转发 / 回复帖是 `archetype:'forward'`，本帖评论进 `text`，原帖进 `quoted`；表情 `<img>` 还原成 `[牛]` 这类文字 |
| **补全**被截断的原帖 | enricher `xueqiu-detail`（`detail.ts`）→ recipe `xueqiu-detail` | 原帖正文以 `...` / `…` 收尾且有 permalink 时，normalizer 写 `enrich: { source:'xueqiu-detail', params:{ permalink } }`；前端打开时发 WS `enrich.open`，MCP / 脚本走 `GET /api/enrich?source=xueqiu-detail&permalink=…`。回 `{ article: { sourceUrl, text } }`，前端填回引用块；没有评论串 |

`permalink` 只放行 `https://xueqiu.com/` 开头的地址，其余抛 `ValidationError`（400）：recipe 会把本 facility
的真标签页导航过去，任意客户端 URL 不能放行。详情页正文前站方注入的隐藏出处节点
（`来源：雪球App，作者：…，（…）`）由 enricher 剥掉。

## 说明

雪球 用户动态 (user_timeline) — replay source（跑在用户自己的 Chrome 上）。

xueqiu-detail（单条状态详情，enrich）——雪球 user_timeline 把被转发/被回复原帖的 description
服务端截断（"..."：实测 statuses/show.json 与详情页裸 HTML 都被 WAF 拦成挑战页，哪怕带着有效
登录 cookie 裸 fetch 也过不去——只有真实浏览器跑一遍它的混淆 JS 才能过，故 kind:browser，不是
kind:http）。on-open 懒加载，不进推荐/时间线，故 discoverable:false。

## 存量条目

`Content` 在采集期落库。没有 `enrich` 字段的旧条目打开时不会补全原帖；要补上就对这个源跑一次
`POST /api/items/renormalize`（原始字段 `quoteText` / `quotePermalink` 都在库里，重跑 normalizer 即可）。

## 发布

代码槽位由 tsdown 打成单文件 `dist/index.js`（`package.json#stream.code.entry`）；构建在仓库根
`pnpm packages:bundle`（或包内 `pnpm bundle`），`prepack` 闸核产物。内置层不读 dist——它直接 import
`./activate.ts`（`packages/index.ts`）。bump `version` 合 `main` 后由 CI 发 npm。
