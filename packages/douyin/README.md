## 说明（迁自 manifests.yaml 注释）

抖音 — replay 采集源（跑在用户自己的 Chrome 上）。两个：`douyin-search`（关键词搜索）与
`douyin-collection`（我的收藏）。搜索用默认 lane，收藏自己声明 `laneKey: "collection"` —— 因为
**一个 facility 一个 tab 且独占**，同一条 lane 上的话，定时跑的收藏会把用户刚发起的那次搜索的
feed 冲掉，反过来也一样。

### 我的收藏（`douyin-collection`）

入口直接落收藏页，它自己会发一发 `/aweme/v1/web/aweme/listcollection/`（network observer 拦它当
第一批），其余批次由 evaluate step 在页内调站点自己的签名客户端翻页。两处参数是活体标定出来的，
**动了就回到 403/-404，而且失败长得像「没抓到」不像「被拒了」**：必须走 **POST**（GET → `-404`
risk-verify），抄来的参数模板必须**删掉 `timestamp` 和 `x-secsdk-web-signature`**（每请求一次性
的值，留着 GET 连 `status_code` 都不回，只回一个 bdturing 挑战信封）。细节写在 recipe 的
`_why_calibrated_params` 里。

**条目按收藏顺序排，不按视频发布时间**（`output.timestampFrom: "harvest-order"`）：listcollection
只给 `create_time`，没有收藏时间；照发布时间排，昨天收藏的一条老视频会沉到底，表现成「采集漏了」。
时间戳 = 采集时刻 − 序号秒，由 adapter 统一盖，发布时间仍在 `douyin.create_time`。

（站外 HTTP 那条路已死：`Douyin_TikTok_Download_API` 容器打这个端点恒 403
`Blocked by ArgusSecurityPlugin`——端点挪到 Argus 签名头后面了，**和 bogus 无关**，
上游那个库至今没有任何 Argus 实现。）

**搜索走拟人输入，不拼 URL 直达**：从首页（自己会跳 `/jingxuan`）点搜索框 → 打字 → 点「搜索」
按钮 → 点「视频」筛选 tab，然后拦页面自己发的 `/aweme/v1/web/search/item/`。**别改回把关键词
拼进 `/search/{keyword}?type=video`**——那条路在高频使用下反复触发风控挑战（冷却十几分钟），
而人肉路径活体全链零验证码。
（站外 HTTP 搜索端点被风控门挡着——无 cookie 返回 status_code 2483「请先登录」，
而登录 cookie 有 7KB+、塞进 query 会被上游拒；所以这条只能在浏览器里走。）

**搜完即关**（`lifecycle:'one-shot'`）：搜索没有常驻的必要——没有定时流骑这个 tab、也没有
detail recipe 骑它的账本，留着只是风控的活靶子。

**它比默认的并发成员闸慢**：拟人路径全程 30–40s，而扇出层默认 25s 就把成员判超时。所以
manifest 自己申报 `member_timeout_ms: 60000`——只放宽自己这一格，别去抬全局闸让所有搜索陪等。

`provides:[search-content]` —— content-search Provider 的 {mode:auto, provides:search-content}
扇出成员（沿用旧 plugin 源的成员资格）。

免扫码：登录态由后端去用户自己的 Chrome 里取（`src/credentials/cookie-puller.ts` 的 `cookiePull`），
签名（a_bogus 等）由页面自己算，我们一行都不实现。cookie 失效时用户在自己 Chrome 重登即可，
stream 侧零操作（不进扫码面板）。
