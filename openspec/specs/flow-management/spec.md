## Purpose

Flow（binding）模型：定义与角色、试运行生命周期、扇出申报与 N:1 规划、搜索与时间线都从 binding 出发、HTTP 与 MCP 的操作面对等。

## Requirements

### Requirement: Flow definition

系统 SHALL 把一个 Flow 表示为 `(source_id, 冻结的 config params, label, origin)`,Flow 不含 role。config params(如 pansou 的 `channels`/`cloud_types`/`filter`)冻结在 Flow 上;query params(如 `keyword`)不存入 Flow,在调用时注入。Flow 持久化在 SQLite `flow` 表。

#### Scenario: Create a flow with frozen config params
- **WHEN** 调用 `create_flow(source_id="pansou-search", params={channels:["a","b"], cloud_types:["quark"]}, label="动漫")`
- **THEN** 系统在 `flow` 表写入一行,`params` 为冻结的 config(不含 keyword),`origin="user"`,并返回 flow id

#### Scenario: Query params are injected at call time, not stored
- **WHEN** 用一个已存的 flow 执行搜索 `keyword="某剧"`
- **THEN** adapter 收到的实际 params = `{...flow.params, keyword:"某剧"}`,且 flow 表中的 `params` 不被写入 keyword

### Requirement: Binding and role

系统 SHALL 通过 Binding `{flow_id, role}` 把 Flow 挂到用途,`role ∈ {timeline, search}`,且 `role` MUST ⊆ 该 source manifest 的 `capabilities`。同一个 Flow MAY 同时拥有 timeline 与 search 两条 binding。每个 `(flow_id, role)` 至多一条 binding。Binding 持久化在 SQLite `binding` 表,timeline 专属字段(cadence/vault_subdir/ordering)与 search 专属字段(nsfw/rank)按 role 填充。

#### Scenario: Promote one flow to both roles without duplication
- **WHEN** 对同一 flow 先 `promote(flow_id, "search")` 再 `promote(flow_id, "timeline", {cadence_seconds:3600, vault_subdir:"x"})`
- **THEN** `flow` 表仍只有一行,`binding` 表出现两行(role 分别为 search 与 timeline),均指向同一 flow_id

#### Scenario: Reject a role the source does not support
- **WHEN** 对一个 source `capabilities=[search]` 的 flow 调用 `promote(flow_id, "timeline")`
- **THEN** 系统拒绝并返回错误,不写入 binding

### Requirement: Trial lifecycle

系统 SHALL 支持把 binding 标为 trial(`status="trial"`,`trial_until=now+N`)。检索 binding 的查询 MUST 以 `trial_until IS NULL OR trial_until > now` 为正确性来源过滤过期 trial。一个 sweeper MAY 删除已过期 binding 以回收空间,但正确性不依赖它。`status` 转 `active`(转正)清空 `trial_until`。

#### Scenario: Expired trial binding stops participating
- **WHEN** 一条 search trial binding 的 `trial_until` 已过去,执行一次搜索
- **THEN** 该 binding 不参与本次扇出(被检索 SQL 的时间过滤排除),无论 sweeper 是否已删除它

#### Scenario: Promote a trial to permanent
- **WHEN** 对一条 trial binding 执行转正
- **THEN** `status` 变 `active`,`trial_until` 置空,此后永久参与

### Requirement: Fan-out declaration and N:1 planner

系统 SHALL 允许 manifest 声明可选 `fan_out = {dimension, strategy, batch_key}`,`strategy ∈ {batch, window, scatter}`。executor 级 planner MUST 按 `group_key = source_id + canonical(pick(flow.params, fan_out.batch_key))` 对参与的 flow 分组;对 `strategy=batch` 的组,把同组各 flow 的 `params[dimension]` 求并集后发**一次**物理 fetch。未声明 `fan_out` 的 source 按 1:1 单 flow 处理。扇出逻辑 MUST 在 executor 实现,adapter 保持单次取(哑 transport)。

#### Scenario: Two flows sharing batch_key merge into one fetch
- **WHEN** 两个 pansou flow 的 `cloud_types/filter/src` 相同、`channels` 不同,同时参与一次搜索
- **THEN** planner 把它们并成一组,以 `channels=两者并集` 发起**一次** `adapter.fetch`

#### Scenario: Differing batch_key params are not merged
- **WHEN** 两个 pansou flow 的 `filter` 不同
- **THEN** planner 把它们分到不同组,各自发起独立的物理 fetch

### Requirement: Search fan-out from bindings

系统 SHALL 让搜索扇出从 search-role binding 集合(经 nsfw 与 trial 过滤)派生,取代 `src/bootstrap.ts` 中硬编码的 `VIDEO_SOURCES` 数组。每个 planner 组独立计时与容错:一组物理 fetch 超时/失败 MUST NOT 连累其它组。

#### Scenario: Search uses enabled search bindings instead of a hardcoded list
- **WHEN** 用户禁用某个 search binding 后执行搜索
- **THEN** 该源不出现在本次扇出中,其余源照常返回

#### Scenario: One slow group does not block others
- **WHEN** 一个 planner 组的物理 fetch 超时
- **THEN** 该组记为失败计时,其它组的结果正常返回并合并

### Requirement: Timeline tick from bindings

系统 SHALL 让 `scheduler.tick()` 从 timeline-role binding 驱动,读取 binding 的 cadence/vault_subdir/ordering,cursor 与 dedup 复用现有 dedup-store。现有 `streams.d`(`NamedStream`)MUST 经一次性幂等迁移转成 flow + timeline binding。

#### Scenario: Migrated NamedStream ticks as a timeline binding
- **WHEN** 迁移脚本处理一个 `streams.d/*.yaml`(单 source)
- **THEN** 生成一条 flow 与一条 timeline binding(携带原 cadence_seconds 与 vault_subdir),且该 binding 能被 tick 拉取并写入 vault

### Requirement: Cold-start seeds and meta-source legibility

系统 SHALL 在首次启动幂等写入一批 `origin="seed"` 的 Flow(含现有常用搜索源迁成 search seed binding),保证开箱即用。对 pansou,系统 SHALL 暴露两个频道来源:**默认池**(读容器 `CHANNELS` env 配置的频道)与 **发现池**(从搜索结果每条携带的 `channel` 累积),用户 MAY 据此一键 `create_flow` 将某频道存为 `origin="discovered"` 的 flow。

#### Scenario: Seed flows present on first boot
- **WHEN** 全新实例首次启动
- **THEN** `flow` 表含一批 `origin="seed"` 的流,且搜索开箱可用(无需用户先配置)

#### Scenario: Observed pansou channels accumulate into the discovered pool
- **WHEN** 一次 pansou 搜索返回的结果携带此前未见过的 `channel`
- **THEN** 该 channel 进入 discovered 池,可被列出并一键存成 flow

### Requirement: Operations surface (HTTP + MCP parity)

系统 SHALL 提供一组流程管理动词:`list_flows`、`create_flow`、`promote`(支持 `trial_days`)、`demote`、`list_bindings`。这组动词 MUST 在 HTTP API 与 MCP tools 两侧等价暴露(同语义)。`delete_flow` MUST 级联清理其 binding。

#### Scenario: MCP and HTTP expose equivalent verbs
- **WHEN** 通过 MCP `promote(flow_id, "search", {trial_days:7})` 与通过 HTTP `POST /api/flows/{id}/promote` 同参数调用
- **THEN** 两者产生等价的 binding(role=search、trial、7 天 TTL)

#### Scenario: Deleting a flow cascades to its bindings
- **WHEN** 对一个已挂 timeline+search 两条 binding 的 flow 调用 `delete_flow`
- **THEN** 该 flow 与其两条 binding 一并被删除
