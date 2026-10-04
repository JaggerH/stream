# Douyin_TikTok_Download_API

抖音 / TikTok 的**全部站点知识**住在这个包里：宿主只有泛化机制（按 `stream.links` 认领链接、按 `<platform>-<名词>` 派发、
range 代理字节、透传 enricher），源码里没有这两家的域名、标识符、字面量或源 id
（`src/no-facility-names.guard.test.ts` 钉着）。一个 adapter（id `Douyin_TikTok_Download_API`）
骑一个 video-service 容器，服务 bilibili / tiktok 的原始 API。

**抖音那半已经不在容器上了。** 站方把作品详情、用户作品、收藏、搜索全部挪到 Argus 签名头
（X-Argus/X-Gorgon/X-Ladon）后面，站外打恒 403，所以这四条都改成在**用户自己的 Chrome** 里跑
recipe、让页面自己算签名（本包的 `douyin-detail` / `douyin-user` / `douyin-follow`，加上
`packages/douyin/` 的 `douyin-search` / `douyin-collection`）。**签名一行都不在我们这儿。**
抖音这一侧今天还打容器的只剩**评论**（`fetch_video_comments`，至今照常 200——这道闸是按端点上的）。

## 四格能力（全在 `package.json#stream`）

| 能力 | 声明位 | 成员 / 处理器 | 调用点 |
|---|---|---|---|
| 播放解析 | `providers[]` 的 `video-douyin` / `video-tiktok`（`category: resolve`，`serveKeys: [<平台>-video]`） | source `douyin-resolve` / `tiktok-resolve`：`{ vid, format }` → `VideoResolved[]` | `video.resolve`：`GET /api/media/play\|dash?platform=&vid=`、转写 / 抽帧取字节 |
| 贴链接抓媒体 | `providers[]` 的 `douyin-url` / `tiktok-url`（`category: transform`，`serveKeys` 是 `douyin-link` / `tiktok-link`；哪些主机归哪个平台由 `stream.links.hosts` 显式写——一包两平台，缺省的 facility 顶不上） | source `douyin-fetch-url` / `tiktok-fetch-url`：`{ url }` → `[FetchUrlResult]`（`output: object`） | `content.enrich`：`stream_fetch_url` / `GET /api/media/from-url` |
| 评论 | `code.enrichers: ["douyin-comments"]` | `enrich.ts`：`{ vid, cursor\|page }` → `{ comments, total, cursor? }` | `GET /api/enrich?source=douyin-comments&vid=` |
| 一键订阅 | `code.connect: ["douyin.com"]` | `connect.ts`：零输入 → 流 `douyin-follow`（source `douyin-follow`，**无参数**） | `POST /api/credentials/douyin.com/connect` |
| 时间线（抖音） | 本包的 `douyin-user.recipe.json` / `douyin-follow.recipe.json` | 源 `douyin-user`（`{ url }`）/ `douyin-follow`（零参数） | 频道订阅 / 定时采集 |

**每条 `providers[]` 行都写了 `callsites`**——不写就没有任何调用点会问它。

此外 `code.normalizers` 交出三个展示 normalizer（`douyin.ts` / `tiktok.ts` / `bilibili-web.ts`），
每家认自己的原始 API 形状；视频 media 只带 `(provider, vid)` 身份，播放地址在播放时由解析成员现解，
normalizer 不烘 embed、不烘路由串。

## `vid` 的形状

- 抖音：`aweme_id`（数字串）。
- TikTok：作品 `id`（数字串）。

解析成员按 id 拼一条主站链接（`https://www.douyin.com/video/<vid>` / `https://www.tiktok.com/video/<vid>`）：
抖音那条交本包的 `douyin-detail` recipe 当入口，TikTok 那条交容器的 `/api/hybrid/video_data`。
**不用分享链接当 vid**：它是派发键与进度键的一半，带签名参数的分享链接每次都不同。

## 抖音的作品详情不经容器

`hybridVideoData` 按 `isDouyinUrl` 分两条路，这不是对称的：

| 链接 | 走哪 | 为什么 |
|---|---|---|
| `douyin.com` / `iesdouyin.com`（含 `v.douyin.com` 短链） | 本包的 **`douyin-detail` recipe**（用户自己的 Chrome，页面自己算签名） | 站方把 `/aweme/v1/web/aweme/detail/` 挪到了 Argus 签名头（X-Argus/X-Gorgon/X-Ladon）后面 |
| `tiktok.com` | 容器 `/api/hybrid/video_data` | 这半没被那道闸挡，而且我们没有 TikTok 的采集会话 |

站外打抖音那个端点**恒 403**，而容器把它包成一句无信息量的 `HTTP 400: An error occurred.` ——
用户看到的就是那一句。403 的真身要在容器里直接打上游才看得见：先是
`Blocked by ArgusSecurityPlugin Uifid Not Found`，补上 `Uifid` 请求头后变成 `Signature Not Found`。
**和 cookie 新旧无关**（活体 2026-09-22：把用户 Chrome 里完整的 72 个 cookie、含 `UIFID` / `sessionid`
整份递进容器直打，同样的 403 同样的文案）。同期 `/aweme/v1/web/aweme/post/`（用户作品列表，
`douyin-user` 源）一样被挡，而 `fetch_video_comments` 与 bilibili 那半照常 200 —— **这道闸是按端点上的**。

短链不在我们这儿解析：链接原样当 recipe 的 `entryUrl`，浏览器自己跟完跳转就落在作品页上
（容器以前替我们做的正是这件事）。完整证据链与页内调用的标定在 `douyin-detail.recipe.json` 的
`_why_*` 字段里；**签名一行都不在我们这儿**，只是调用页面已经加载好的那个函数。

## 解析语义

- `format: progressive | audio` → 一条整片直链 + CDN 要的 `Referer`（抖音是 `https://www.douyin.com/`，
  否则 403）。抖音没有独立音轨，`audio` 给的也是整片。
- `format: dash` → `[]`（如实 decline，播放器自己回落 progressive）。
- 作品被删 / 私密 → 抛 `ContentUnavailableError`；宿主据此回 `404 { error: 'unavailable', detail }`，
  成员管道不记源的健康账。判据住在 recipe 的页内 `call`（站方回了 `status_code 0` 却没有 `aweme_detail`），
  由 `douyin-detail.ts` 按 `DETAIL_UNAVAILABLE_MARKER` 翻成结构化错误 —— 两处的那句话由
  `douyin-detail.test.ts` 钉着。**recipe 自己跑挂（风控挑战 / webpack 布局变了）不是「内容不可用」**，
  原错误照传：前者要人去看采集，后者告诉用户「这条没了」，说反了就把一次故障藏成一条正常的空结果。
- 播放路径**共用** `adapter/play-addr.ts` 一份取址逻辑（解析成员与贴链接抓媒体都吃它），别各抄一遍。

## 容器地址

```
env DOUYIN_API_URL（显式覆盖，比如用户自己跑的一份 http://10.0.0.21:3007）
  →  ctx.backendUrl()（缺省：本包自己的 backend service；compose 档容器 DNS、host 档醒着的容器的 loopback 口）
```

`ctx.backendUrl` 递 thunk 不递值（host 档下 loopback origin 只在容器醒着时存在），每次打容器套
`ctx.withAwake`。宿主 `config.yaml` 里没有这个容器的地址项。

## 排错

- **抖音作品详情拿不到**：先看它是哪一类。`douyin-detail` 这条 recipe 的失败一律带 `douyin-detail:` 前缀
  （`signed-request module not found` = 站方换了 webpack 布局；`did not settle in 8s` = 撞上验证码遮罩；
  `作品页始终没有发它自己的 aweme/detail 请求` = 落地的不是作品页）。**没有这个前缀的 `HTTP 400 /
  An error occurred.` 说明走的还是容器那条路** —— 那就是分路判据（`isDouyinUrl`）没认出这条链接。
  **评论接口不受影响**（`/api/douyin/web/fetch_video_comments` 是另一条路，至今照常 200）。
- **`member "…/douyin-fetch-url" timed out after 25000ms`（或 douyin-resolve）**：**不是 recipe 的错**，
  是扇出层的闸比 recipe 的上限还窄。这两条成员跑的是浏览器 recipe（比容器那条慢一个量级），所以它们
  在 `manifests.yaml` 里各自申报 `member_timeout_ms: 60000`——见到 25000 这个数就说明那一行被摘掉了
  （`douyin-detail.test.ts` 钉着「成员闸 > recipe 的 maxTaskMs」这个关系）。活体 2026-09-23 07:59 真撞过一次。
- **`5 轮都没取到（最后一次：… status_code=-999 …）`**：`-999` 是站方风控客户端给的负数码
  （和 `listcollection` 走 GET 时的 `-404` 同族）。**先别当成「被拒了」** —— 活体 2026-09-22：同一条作品、
  同一个浏览器、同一段页内代码，在探针标签里（页面稳下来几秒后）稳定回 `status_code: 0`，而在采集 lane
  刚落地时回 `-999`。**「站方拒了」和「我们问早了」长得一模一样**，所以那一步是个带次数的重试循环
  （5 轮 × 2s）；跑满 5 轮还是 `-999`，才轮到怀疑风控真的上来了（那就等冷却，别加请求）。
  活体基线：整趟 4.9s，其中进场 4.3s、evaluate 385ms（第一轮就成）。
- **`Failed to parse URL`**：容器没醒 / 地址解析为空，看 DebugBox `plugin-target` 频道（PACKAGE.md §10.1 的 descriptor 注）。
- **`bad enrich request` 400**：enricher 名字没对上 `<facility>-comments` 合同，或包没装载。

## TikTok — PROVISIONAL

`adapter/play-addr.ts` 里 TikTok 的取址路径（`video.playAddr` → `video.bitrateInfo[].PlayAddr.UrlList` →
aweme 风格 `video.play_addr.url_list`）与 `Referer https://www.tiktok.com/` **没有活体核过**：本机容器打
tiktokv.com 回空。拿到真数据后回来重校顺序与 Referer。`manifests.yaml` 里 tiktok 的 `unwrap` 同属 PROVISIONAL。

## backend

`ghcr.io/jaggerh/douyin_tiktok_download_api:latest`（ghcr 上公开），源码是 fork
`github.com/JaggerH/Douyin_TikTok_Download_API` 的 **`stream-backend`** 分支（上游 + `/health` 端点 + Bilibili /
下载 / YouTube 爬虫；容器**不**自己取 cookie——登录态由宿主随每次请求当 query 参数递进来）。改源码 = 在那个分支
提交 → `docker build -t ghcr.io/jaggerh/douyin_tiktok_download_api:latest . && docker push` → 后端重启
（宿主接管比镜像字符串，`:latest` 没变就要先 `docker rm -f stream-douyin-tiktok-download-api` 再重启才会拉新层）。
高频迭代期可临时加 `backend.dev` 块 bind-mount 热跑（`pnpm plugins compose --dev`）。

`standby.idleMinutes: 30` —— 采集型冷调用：harvest tick / 用户点开视频才来一发，单次几秒内完事，
没有播放挂载那种「随时要来」的时效压力——200MiB 常驻不值得。30 分钟覆盖同一会话内的连续操作。

## 源路由

按 source 声明式路由（见 `onboard-source` skill 的 `references/via-external-backend.md`）：

```
api: { endpoint, query:{<upstream>:{from,default,required}}, unwrap }   ← 通用执行器
api: { handler: <name> }                                               ← 逃生口（resolve / fetch-url / 多步调用）
```

`params_schema` 里没有 `mode`——路由由 `api` 绑定承担，不暴露给用户。

**抖音的时间线类源不走这张表**：`douyin-user` / `douyin-follow` 是 recipe（`*.recipe.json`），
自带 `meta`，不在 `manifests.yaml` 里。**源 id 和迁移前一模一样**，所以已有订阅无感；
`manifests.yaml` 里留着它们各自的去向注释，别再往回加同名条目——同一个包里 id 撞车会让
`Registry.swapGroup` 抛 `Duplicate manifest id`，后端直接起不来。

## 发布

`@streamapp/douyin-tiktok-download-api`（目录名 `Douyin_TikTok_Download_API` 是包 id，不是 npm 名）是
`"private": true`，不发 npm：第三方容器钳制（`backend.service` 由宿主指派、必须写 `mem`、id 文法——
`Douyin_TikTok_Download_API` 本身就过不了）与「用户层同名容器包该顶掉内置容器还是并存」都还没有设计，见
`project planning record`「带容器的内置包怎么走 npm 安装」。

构建链照样出 dist 备着：`activate.ts` 及其可达的模块（`adapter/`、normalizer、enricher、connect，加
`shared/package-sdk/` 里用到的纯函数）由 tsdown 打成单文件 `dist/index.js`，`package.json#stream.code.entry`
指的就是它。容器地址与 standby 唤醒经 `ctx.backendUrl` / `ctx.withAwake` 拿，宿主单例不进 bundle；宿主类型只
`import type`，编译期抹掉。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）——`private` 不影响构建链，只挡发布。
- 内置层自己不读 dist，直接 import `./activate.ts`。
