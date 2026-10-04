# @streamapp/bilibili — 哔哩哔哩

B 站的站点知识住在这个包里，宿主（`src/`）只认「一个平台键 + 一个 vid」。

## 填了哪几格槽位

| 槽位 | 内容 |
|---|---|
| Source 清单 `manifests.yaml` | `bilibili-resolve`（视频播放解析，adapter `bilibili`）、`bilibili-search`（RSSHub vsearch 路由，`provides: [search-content]`，auth 是 optional 的 transform cookie——没登录也能游客态搜）、`bilibili-fetch-url`（一条链接 → 媒体，`output: object`） |
| 代码 `activate.ts` | adapter `bilibili`（`adapter.ts` + `client.ts` + `fetch-url.ts`）、normalizer `bilibili`（`normalizer.ts`，RSSHub 动态流的渲染规则）、三个 enricher（`enrich.ts`）、一个 connect（`connect.ts`） |
| `code.enrichers` | `bilibili-comments`：`{ vid, page? }` → `{ comments, total, cursor }`（详情面板评论区，见下）；`bilibili-owner`：`{ bvid | aid }` → UP 主 `{ mid, name, face }`；`bilibili-user`：`{ uid | name }` → `{ uid, name, face }`，查不到抛 400 |
| `code.connect` | `bilibili.com`：`POST /api/credentials/bilibili.com/connect` 一键订阅「我的关注」合并流（uid 从 cookie 的 `DedeUserID` 读，零输入） |
| 凭证域 `credentials` | `bilibili.com` |
| Provider 行 `providers[]` | `video-bilibili`（`resolve`）：serve 键 `bilibili-video`，成员 `bilibili-resolve`，填 `video.resolve` 调用点；`bilibili-url`（`transform`）：serve 键 `bilibili-link`，成员 `bilibili-fetch-url`，填 `content.enrich` 调用点 |
| 链接认领 `links` | `hosts` `bilibili.com` / `b23.tv`（`b23.tv` 也是 `shortHosts`）：认领函数据此把链接认成平台 `bilibili`，`content.enrich` 再按 `bilibili-link` 派发 |
| `rsshubNamespaces` / `rsshubCookieEnv` | RSSHub 目录里 `bilibili/*` 路由用本包的 normalizer；cookie 以 `BILIBILI_COOKIE_<DedeUserID>` 递给 RSSHub（搜索源的 `inject.ref: bilibili` 也经这个模板展开） |
| `retires` | 目录路由 `rsshub:bilibili/vsearch/:kw/:order?/:embed?/:tid?` 由本包的 `bilibili-search` 承接 |

## 评论 enricher 与前端的合同

前端对带 `(provider, vid)` 的视频一律请求 `GET /api/enrich?source=<provider>-comments&vid=…`（`app/src/lib/enrich.ts`），
翻页时把上一页回的 `cursor` 当 `page` 再发一次（`app/src/lib/preload.ts`）。所以：

- 名字**必须**是 `bilibili-comments`——换个名字前端就找不到，请求落到宿主自己的分支回 `400 bad enrich request`。
- 返回 `Enrichment` 形状：`{ comments: Comment[], total, cursor: string | null }`，`cursor` 是下一页页码字符串，没有下一页给 `null`。
- 置顶评论只在第一页领头，带 `置顶` 徽标；UP 主自己的评论带 `UP`。

## cookie 从哪来

**只从宿主拿**：`activate(ctx)` 把 `() => ctx.cookieFor('bilibili.com')` 交给 `BilibiliClient`，每次请求现取。
不读任何环境变量——`BILIBILI_COOKIE_*` 那条路是 RSSHub 容器的，由宿主按 `rsshubCookieEnv` 声明写进去。
现取而不是装配期快照，是为了用户重新登录之后下一次调用就用上新的那份。

## `vid` 的两种形状

- `BV…`（bvid）——进 `VideoRef.bvid`。
- `av<数字>`（也接受裸数字）——进 `VideoRef.aid`。

**av 号不能塞进 `bvid` 字段**：`refKey` 对 bvid 只认 `/^BV[0-9A-Za-z]+$/`，`{ bvid: 'av116830928705054' }` 会当场
`bad video ref` 抛。所有调用方都经 `videoRefOf(vid)` 拆，别自己拼 `{ bvid: vid }`——抽帧那处曾经这么写，
于是每条 av 号视频抽帧必然失败，而播放照常好使。

## `bilibili-resolve` 的合同

输入 `{ vid, format }`（`format`：`progressive` | `dash` | `audio`，缺省 `dash`）→ `[VideoResolved]`：

- `dash` → `{ kind: 'dash', manifest }`，并把 manifest 里每条主备 CDN 主机连同请求头登进宿主的分片信任表（`rememberSegHosts`）。
- `progressive` → `{ kind: 'progressive', url, headers }`（≤720p 单文件）。
- `audio` → `{ kind: 'progressive', url, headers, mime: 'audio/mp4' }`（最小码率纯音轨，转写用）。

包只解析不搬字节；Range 代理归宿主播放路由。

## `bilibili-fetch-url` 的合同

输入 `{ url }` → 单个 `FetchUrlResult`：`{ platform: 'bilibili', title, author, author_avatar, media: [{ kind: 'video', url, download_url }] }`。
媒体地址用宿主的 `mediaPlayUrl` 拼（`/api/media/play?platform=bilibili&vid=…`），不自己拼路由字符串。

- id 从链接里抠：`BV…`（任何位置）或 `/video/av<数字>`。
- `b23.tv/<短码>` 抠不到 id 时**只跟一跳** 302（HEAD，被拒换 GET），只认落到 `bilibili.com` 的 `Location`，再在它上面抠 id。
- 仍抠不到 → `{ media: [], error }`，不是空成功。
- `view` 接口打嗝只丢标题 / 作者，可播地址照给——它是从 id 直接拼的。

## 发布

npm 上的 `@streamapp/bilibili` 带一份预编译的代码槽位：`activate.ts` 及其可达的模块（含 `shared/package-sdk/`
那几个纯函数与错误类）由 tsdown 打成单文件 `dist/index.js`，`package.json#stream.code.entry` 指的就是它；
tarball 里只有 `dist/index.js`、`manifests.yaml`、`README.md` 与 `package.json`。`import type` 的宿主类型编译期抹掉，
宿主单例（分片信任表、容器地址）不进 bundle——分片请求头经 `DashResult.headers` 交给路由登记，不由包登记。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）。
- 发布：`npm publish --access public`，`prepack` 闸自动核产物在且非空、独占 `dist/`、tarball 过安装门白名单。
- 首发由人做一次；之后 bump `version` 合 `main`，CI（`release-recipes.yml`）跟版本自动发。
- 用户 `stream add @streamapp/bilibili` 装到比内置更高的版本 → 用户层的声明与代码顶掉内置那份（内置代码跳过）；
  相等或更低 → 内置为准。内置层自己不读 dist，直接 import `./activate.ts`。
