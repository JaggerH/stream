# feed-url-source

## Why

订阅「某个站点 / 项目的更新」时，能走的最短正路是站点自己发布的 RSS / Atom feed：服务端直接拉取解析即可，
不需要浏览器、不需要设备、也没有登录态。此前通用兜底只有 `browser-page`（无头浏览器渲染一个页面），而它
的结构决定了它只能做**单页快照**：条目身份是页面地址本身，页面内容再怎么变，dedup 之后也永远只有第一条
（`stream-pipeline` 的 id 判据是 `stream|guid`，`browser` adapter 的 guid 是 `page.url`）。拿它追更新，
用户会得到「订好了」的答复，却永远收不到新条目。

## What Changes

- **新通用源 `feed-url`（`packages/feed/`，adapter `feed`）。** 参数是 RSS 2.0 / Atom 的 **feed 地址本身**
  （不是页面）。服务端直接拉取并解析，产出每条目一项；条目身份用 **feed 自己的 per-entry guid/id**
  （缺省回落到条目链接）——feed 新增一条，下次采集恰好多出这一条。
- **取数走既有的服务端守卫通道**（`safeFetchResponse`）：私网 / 回环 / link-local（含云元数据地址）一律拒绝；
  caller-fetch-guard 激活的作用域里按同一套语义逐跳判，拒绝原样冒泡。
- **feed 地址必须是 feed 文档**：解析不到任何 item/entry 时报错（多半是把页面地址当 feed 传了），不产出
  静默的空时间线。
- **`discoverable: true`**：`stream_search` 能搜到它；描述与例子保持中性（不点名任何具体站点）。
- **`browser-page` 的描述如实收窄**：单页快照、不跟踪页面后续变化、需要在线的浏览器设备——不再被当成
  「追更新」的出路。
- `browser-page` 的**变更检测本 change 不做**（让单页快照源跟踪内容变化需要按内容指纹判身份，另行立项）。

## Capabilities

### New Capabilities
- `feed-url-source`：RSS / Atom 直订源——服务端拉取解析、per-entry 身份、内网拒绝、非 feed 文档报错。

### Modified Capabilities
- 无（`browser-page` 只改描述文案，不改行为）。

## Impact

- 新包 `packages/feed/`（manifests.yaml + adapter + parser + 测试），宿主 `adapters` 域多一格 `feed`。
- `stream_search` 空结果的 note 指路更新：先探常见 feed 地址（`/feed`、`/index.xml`、`/releases.atom`…），
  单页快照需求才落 `browser-page`，都订不了就如实说。
