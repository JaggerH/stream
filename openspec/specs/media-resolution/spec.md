# media-resolution Specification

## Purpose
TBD - created by archiving change resolve-api-unification. Update Purpose after archive.
## Requirements
### Requirement: 下载解析端点
后端 SHALL 暴露 `GET /api/download-options/options?url=<ref>`：接收一个引用（来源站的中转页 URL），经
download-resolve Provider 行解析为下载项，返回 `{ options: [{ url, type, password?, name? }] }`
（`type`: magnet/ed2k/quark/baidu/aliyun/http；通常一条，首条为优选）。端点 SHALL 幂等、无副作用。
错误 SHALL 走 `errorBody` 信封：`url` 缺失或无成员认领（unsupported url）→ 400 validation_error，
成员认领但上游失败 → 502 upstream_error（misses reasons 拼接），providers 未配置 → 503 unavailable。

本端点只收「问答类」解析（JSON 进出、消费者是代码）。播放类（bilibili/douyin/tracks）是**送字节**
的活——消费者是 `<video>`/`<audio>` 标签，物理上进不了 JSON 信封——归 `/api/media/*` 各自的代理路
与 `src/media/serving.ts` 的服务策略表，MUST NOT 并入本端点。

#### Scenario: 解析出下载项
- **WHEN** 客户端 GET `/api/download-options?url=<btbtla /tdown/ 页 URL>` 且 download-resolve 某成员认领并成功
- **THEN** 返回 200，`options` 至少一条且每条含 `url` 与 `type`

#### Scenario: 无成员认领
- **WHEN** 传入的 URL 没有任何成员认领（全部 decline / unsupported url）
- **THEN** 返回 400，body 为 `errorBody('validation_error', ...)`——前端据此显示「无可用解析」，与网络层失败区分

#### Scenario: 上游失败
- **WHEN** 有成员认领但上游抓取/解析失败
- **THEN** 返回 502，body 为 `errorBody('upstream_error', ...)`

### Requirement: 一个脑子，两个门面
「引用 → 下载项」的解析 SHALL 只有一个实现（`ProviderService.resolveDownloads`，经
download-resolve 行 decline-chain 分发），HTTP `GET /api/download-options` 与 MCP 工具 `video_resolve`
都 SHALL 骑它。任一门面 MUST NOT 直调站点实现——直调会漏掉用户从 Provider 管理页追加的成员。

#### Scenario: 两个门面同吃新成员
- **WHEN** 用户在 Provider 管理页向 `download-resolve` 追加一个新下载源成员
- **THEN** 该站 URL 经 HTTP 端点与 MCP `video_resolve` 都可解析，无代码、无端点改动

### Requirement: download-resolve Provider 行
系统 SHALL 以单条 system Provider 行 `download-resolve`（`category: 'resolve'`,
`serveKeys: ['download']`, `strategy: 'sequential'`）承载全部下载解析：成员为各下载源，按
decline-chain 分发（成员对不认识的 URL 抛 'unsupported url' 或返回空数组 = decline），成员返回
契约为 `[{ url, type, password?, name? }]`。分发结构 SHALL 只存在于 Provider（DB）层，manifest
不承载任何组织信息。系统行的身份住在代码里（`src/providers/system/download-resolve.ts`），
不做 DB 迁移。

#### Scenario: decline-chain 分发
- **WHEN** `download-resolve` 有多个成员且 URL 只属于其中一个站
- **THEN** 不认识该 URL 的成员 decline，认领的成员产出结果，行返回首个成功成员的值

### Requirement: needsResolve 与解析实现同源
「这个 URL 是不是下载站的中转页」的判据（解析器打 `needsResolve` 标）与「真的去解开它」的实现 SHALL 同住一个模块（`src/video/resolve.ts` 的 `downloadPageKind` ↔ `resolveDownloads`），
认领范围一致并由测试钉住。解析器与工具描述 MUST NOT 各自写站点正则或按来源身份（source id/
站点名）写死判断——分家漂移的症状是前端给出解析按钮而后端 400 拒，两边单看都正常。

#### Scenario: 自带网盘链接的行
- **WHEN** pansou 类源的行内已含网盘直链
- **THEN** `needsResolve` 为 false，前端不出解析按钮

#### Scenario: 只有中转页链接的行
- **WHEN** 行仅含在册下载站的中转页 URL（如 btbtla /tdown/ 页）
- **THEN** `needsResolve` 为 true，前端出解析按钮，点击调 `/api/download-options`

