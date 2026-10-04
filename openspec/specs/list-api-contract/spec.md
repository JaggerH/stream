## Purpose

列表接口的契约：不回 raw 存档字段、enrich 需要的源站 ID 以正式字段提供、频道条目接口支持 keyset 游标分页。

## Requirements

### Requirement: 列表接口不返回 raw 存档字段
返回 item 列表的接口（`GET /api/channels/:id/items`、`GET /api/items`、`GET /api/search`）SHALL 在序列化出口剥除每条 item 的 `raw` 字段。`raw` 是留给后端 replay/重新归一化的原始 payload 存档，MUST 继续原样落库，仅不出现在上述接口的响应中。

#### Scenario: 频道 items 响应不含 raw
- **WHEN** 客户端请求 `GET /api/channels/default-timeline/items`
- **THEN** 响应中每条 item 均不含 `raw` 字段，其余字段（id/title/content/attachments 等）与改动前一致

#### Scenario: raw 落库不受影响
- **WHEN** 一次 harvest 写入携带大 `raw` 的 item 后，通过列表接口读取该 item
- **THEN** 数据库中该 item 的 `raw` 完整保留（`ItemStore.get` 等后端内部读取可见），仅列表响应中不含 `raw`

### Requirement: enrich 所需源站 ID 以正式字段提供
列表接口 SHALL 在序列化出口从 `raw` 中提取 enrich 依赖的源站 ID 并以正式字段返回：xhs item 的 `raw.noteId` 提升为 `note_id`，hackernews item 的 `raw.guid` 提升为 `source_guid`。提取发生在响应序列化时（非归一化入口），因此对存量与新采集 item MUST 一视同仁生效。字段缺失时（`raw` 中无对应值）该正式字段省略，客户端回退到既有的 URL 正则兜底。

#### Scenario: 存量 xhs item 也带 note_id
- **WHEN** 客户端请求包含改动前已入库的 xhs 笔记的列表
- **THEN** 该 item 带 `note_id` 正式字段（值等于其 `raw.noteId`），且不含 `raw`

#### Scenario: raw 中无 ID 时省略字段
- **WHEN** 某 item 的 `raw` 中不存在 `noteId`/`guid`
- **THEN** 响应省略对应正式字段，客户端使用 URL 正则兜底解析

### Requirement: 频道 items 接口支持 keyset 游标分页
`GET /api/channels/:id/items` SHALL 支持 keyset 游标分页：接受 `cursor` 查询参数（上一页最后一条的排序键），按现有排序（`timestamp`/`fetched_at` 降序）返回游标之后的下一批；响应 SHALL 携带下一页游标（无更多数据时为空/省略）。不带 `cursor` 的请求行为与现状兼容（返回第一批）。`/api/items` 与 `/api/search` 本次不分页。

#### Scenario: 首屏请求向后兼容
- **WHEN** 客户端不带 `cursor` 请求 `GET /api/channels/:id/items?limit=50`
- **THEN** 返回按时间降序的前 50 条与下一页游标

#### Scenario: 游标翻页不重不漏
- **WHEN** 客户端带上一页返回的 `cursor` 再次请求
- **THEN** 返回紧接上一页最后一条之后的下一批，与上一页无重复条目；即使两次请求之间有新 item 入库，翻页序列也不跳条、不重复（keyset 语义）

#### Scenario: 尾页游标终止
- **WHEN** 游标之后不足 `limit` 条
- **THEN** 返回剩余条目且响应不含下一页游标，客户端停止加载

#### Scenario: 超大 collection stream 翻页到底
- **WHEN** 自定义频道包含一个超过 500 条的 collection stream（`replaceStream` 豁免驱逐的歌单类），客户端持续携带游标翻页
- **THEN** 翻页序列 SHALL 覆盖该 stream 的全部存量条目（第 501 条之后照常可达），不因每 stream 取数窗口截断而提前终止
