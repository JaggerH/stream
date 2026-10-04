# @streamapp/xhs — 小红书

小红书的全部站点知识住在这个包里：四份 recipe（`xhs-search` / `xhs-home` / `xhs-detail` / `xhs-like`，
全部骑用户自己 Chrome 里的登录态跑）+ 一格代码槽位。宿主源码里没有这家站的域名、标识符或源 id
（`src/no-facility-names.guard.test.ts` 钉着）。

## 四格能力

| 能力 | 谁提供 | 前端 / 调用方怎么到 |
|---|---|---|
| **渲染**笔记 | normalizer `xhs`（`normalizer.ts`） | 采集期写 `Content`；每条带 `enrich: { source:'xhs-detail', params:{ noteId, xsec_token } }` |
| **打开**笔记（正文 / 图组 / 视频 / 评论） | enricher `xhs-detail`（`detail.ts`） | 前端按 `content.enrich` 发 WS `enrich.open`；MCP / 脚本走 `GET /api/enrich?source=xhs-detail&noteId=…&xsec_token=…`——两面同一个函数 |
| **播放**视频笔记 | Provider 行 `video-xhs`（`package.json#stream.providers`）→ 源 `xhs-resolve`（`manifests.yaml`）→ adapter `xhs`（`adapter.ts`） | 通用 `GET /api/media/play?platform=xhs&vid=<noteId>`；地址只来自 `streams.ts`（打开笔记时 detail 记下的签名 mp4），没记过 → 抛原话「先打开这条笔记」→ 502 `unresolved`（detail 里就是这句） |
| **点赞 / 收藏** | 动作 recipe `xhs-like`（`meta.action:true`） | 前端 `POST /api/recipes/action { sourceId:'@streamapp/xhs/xhs-like', params:{ noteId, action }, confirmed:true }`，`running` 就轮询 `GET /api/recipes/action/:runId`；没有专属端点 |

## 描述符里的站点事实（`package.json#stream`）

- `facility: xhs` / `cookieDomain: xiaohongshu.com` / `rateLimit`（见下文「说明」）。
- `rsshubNoBrowserNamespaces: ["xiaohongshu"]`——RSSHub 目录里 `xiaohongshu` 命名空间的路由标了
  `requirePuppeteer`，但带 cookie 走纯 HTTP 就能跑；由这个包出面反证，宿主不点名任何站。
- `providers[]` 一行 `video-xhs`（`category: resolve`，serve 键 `xhs-video`，`callsites: ['video.resolve']`），
  重启后端后才出现在 `/api/providers`。

## 发布

npm 上的这个包带一份预编译的代码槽位：`activate.ts` 及其四个模块由 tsdown 打成单文件
`dist/index.js`（`package.json#stream.code.entry` 指的就是它；tarball 里只有 `dist/index.js`、四份
recipe、`manifests.yaml`、`README.md` 与 `package.json`）。构建在仓库根 `pnpm packages:bundle`（或包内 `pnpm bundle`），
`prepack` 闸核产物在不在、有没有多出的文件。内置层不读 dist——它直接 import `./activate.ts`。

发布归 CI（`release-recipes.yml`）：这个名字已经在 npm 上，bump `version` 合 `main` 后 CI 自动 bundle → 闸 → publish。
用户 `stream add @streamapp/xhs` 装到比内置更高的版本时，用户层的声明与代码顶掉内置那份（内置代码跳过）；
相等或更低则内置为准。

## 代码槽位（`activate.ts`）

这个包除了四份 recipe，还交出三样代码（`package.json#stream.code`），三样都不碰 cookie——
每一段能力都是「经 `ctx.readSource` 跑本包自己的 recipe」：

| 文件 | 交出什么 | 干什么 |
|---|---|---|
| `normalizer.ts` | normalizer `xhs` | 笔记的渲染规则。视频笔记 media 是 `{ provider:'xhs', vid: noteId, poster }`，没有 url / embed；每条 Content 带 `enrich: { source:'xhs-detail', params:{ noteId, xsec_token } }`（token 没有独立字段就从 `link` 的 query 里抠；两者任一缺就不写） |
| `detail.ts` | enricher `xhs-detail` | 打开笔记：跑 `xhs-detail` → `{ article, comments, total }`。视频流地址**不**烘进 media，记进 `streams.ts` 那张表 |
| `adapter.ts` + `manifests.yaml` | adapter `xhs`，源 `xhs-resolve`（`video-xhs` Provider 行的成员，serve 键 `xhs-video`） | 播放：`{ vid }` → `streams` 里的地址；没记过就抛「先打开这条笔记」（宿主答 502 unresolved，detail 带这句原话），**不**去跑 detail 现取——没 token 的 detail 运行只能靠 feed 账本里恰好还有那张卡片，没有就落 fallback-nav 注定失败、白烧限速名额，而 `<video>` 的 Range 请求会把 resolve 反复打上来。enricher 本身（前端打开笔记）一律要求 token，缺了直接 400 |

`streams.ts`：noteId → 签名 mp4 地址，进程内、有界 LRU（200 条）、**不按时钟过期**——签名地址的真实寿命
未知，地址真死了的信号是 CDN 播放时回的 4xx（通用播放路由原样透给前端）；按 TTL 清会让每次 Range 都变成一次
miss。detail 写、resolve 读，两者共用 `activate()` 里同一个实例。

## 说明

落到小红书上的频率闸门（一次 recipe 运行 = 一次访问：搜索 / detail / 互动各算一次）。

为什么是 6/分钟 + burst 5：2026-07-29 撞过一次登录墙，形态是几分钟内连续打了十来次
detail（拟人光标和 900ms 动作间隔全程开着，照样撞）。站点数的是频率，所以这里压的是
持续速率；burst 留 5 是因为真人本来就一阵一阵——连点五条笔记再去读十分钟，是正常节奏，
不该每条都罚站。

maxWaitMs 15s：前台点开一条笔记，等 3 秒是加载、等 90 秒是坏了。超过就明确告诉用户
"太快了，X 秒后再试"，而不是转一个不会停的圈。

## 说明（迁自 manifests.yaml 注释）

小红书 — replay Tier-C DOM harvest sources（跑在用户自己的 Chrome 上）。登录态浏览器采集：
人性化滚动，运行期零 token。

login detect 的便宜那一半（xhs-home/xhs-search/xhs-detail/xhs-like 的 auth 块共用）：这些
cookie（sessionCookies）一个都不在 ⇒ 一定没登录，不必开 tab；反过来不成立（cookie 在不代表
服务端还认），肯定判据仍是 recipe 的 loginCheck 选择器。

xhs-search 的 `provides:[search-content]` —— 加入 content-search provider 的
{mode:auto, provides:search-content} 扇出。

xhs-detail：单条笔记详情（图组/视频流/正文/评论）——登录态 tab 内调站点 feed 详情签名客户端。
on-open 懒加载 enrich 用（本包 `detail.ts` 的 enricher 调它），不进推荐/时间线，故 discoverable:false。

xhs-like：互动写入（点赞/收藏）——登录态 tab 内调站点签名接口写用户账户。knowingly 放宽 recipe
只读边界（Gap C，见 spec 2026-07-18 §2）。context-free——无需打开笔记，只要 noteId + action。
on-demand 互动，从不被调度；cadence_hint_seconds 的取值同 xhs-detail（实际不生效，schema 只是
要求正数）。
