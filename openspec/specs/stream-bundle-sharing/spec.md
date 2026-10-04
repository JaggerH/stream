## Purpose

分享包 stream-bundle/v1：从任一根导出依赖闭包、凭证与私有配置永不进包、导入零执行，冲突按 id remap 与 semver 合并解决，解不开的进本地台账。

## Requirements

### Requirement: 分享包格式 stream-bundle/v1

系统 SHALL 定义一个自描述的分享包格式 `stream-bundle/v1`，序列化为单个 JSON，承载配置行（Channel/Stream/Provider）、依赖闭包（`requires`）、内嵌数据型包（`embedded.recipes`）与元数据（`meta`）。包 MUST 携带三种彼此独立的版本：`format`（包 schema）、`meta.revision`（作者内容版本）、`requires.*[].version`（依赖约束）。

#### Scenario: 顶层结构完整
- **WHEN** 导出任一分享包
- **THEN** 产物是合法 JSON，含 `format: "stream-bundle/v1"`、`meta`、`channels`/`streams`/`providers` 三数组中至少一个非空、`requires`、`embedded`

#### Scenario: 导入器按 format 版本解析
- **WHEN** 导入一个 `format` 不被当前导入器支持的包
- **THEN** 导入被拒绝并给出「格式版本不受支持」的可读错误，不做部分写入

#### Scenario: v1 序列化为单 JSON 并在超阈值时警告
- **WHEN** 导出产包
- **THEN** 产物是单个 JSON（v1 不产 zip）；当序列化体积超过阈值时，导出附带体积警告但仍产出该单 JSON

### Requirement: 从任一根导出并计算依赖闭包

系统 SHALL 支持以 Channel、Stream 或 Provider 任一为根导出，沿 `stream_ids → members → {plugin, source}` 计算依赖闭包。每个 `member.plugin` MUST 经 plugin-source-catalog 判定归属，代码型 Plugin 进 `requires.plugins`（带版本约束），数据型 Recipe 整份进 `embedded.recipes`。配置行 MUST 原样保留其 id（供包内引用互指）。

#### Scenario: 以 Channel 为根导出
- **WHEN** 用户导出一个引用两个 Stream 的 Channel
- **THEN** 包内含该 Channel 行、两个被引用的 Stream 行，以及闭包内所有 Source 的依赖分栏

#### Scenario: 代码插件进声明、recipe 进内嵌
- **WHEN** 闭包同时含一个代码型 Plugin 源和一个 recipe 源
- **THEN** 代码型 Plugin 出现在 `requires.plugins` 且带版本约束，recipe 整份出现在 `embedded.recipes`，代码型 Plugin 不被内嵌

#### Scenario: 无法归类的 plugin 显式落缺失
- **WHEN** 闭包含一个 catalog 无法归属的 plugin
- **THEN** 导出把它记为缺失依赖并提示，而不是静默丢弃

### Requirement: 凭证与私有配置永不进包

系统 SHALL 在导出时把 Source 的 `auth: cookie` 域与 `runtime_config` 翻译成 `requires.credentials` / `requires.runtimeConfig` 的**需求声明**（仅 schema：域、ref、fields），且分享包内 MUST NOT 出现任何凭证值、cookie、token 或密钥。导出 MUST 对 `members.params` 做敏感字段体检，防止用户误把密钥塞进 params。

#### Scenario: 包内无密钥值
- **WHEN** 导出一个依赖登录态与 apiKey 的编排
- **THEN** 包内 `requires.credentials` 含所需域、`requires.runtimeConfig` 含 ref+fields，且全包文本快照断言不含任何凭证/密钥的实际值

#### Scenario: params 里的敏感值被拦截
- **WHEN** 某 member.params 含疑似 token/secret 的值
- **THEN** 导出报出该敏感字段并阻止其明文进包

### Requirement: 导入重建编排（导入零执行）

系统 SHALL 提供导入：解析包 → 装/合并内嵌 recipe → 检查代码插件在场 → 引导用户补 `requires` 声明的凭证/私有配置 → 写配置行。导入本身 MUST NOT 执行任何 recipe；recipe 仅在引用它的 Stream 于 T1 tick 时执行。缺失的代码插件 MUST 明确提示且不静默跳过。

#### Scenario: 干净库上 round-trip 等价
- **WHEN** 把一个导出的包导入到一个干净库
- **THEN** 重建出与源等价的编排（Channel/Stream/Provider 及其引用关系一致）

#### Scenario: 缺代码插件时提示
- **WHEN** 导入的包 `requires.plugins` 含本机未安装的代码插件
- **THEN** 导入提示该插件缺失及其来源，未解决项落 import-problems 台账，不静默成功

#### Scenario: 导入不触发采集
- **WHEN** 完成一次导入
- **THEN** 没有任何 recipe 或 adapter 被执行，无出站采集请求发生

### Requirement: 配置行 id 冲突解决（remap）

当导入的配置行 id 与本机已有行撞车，系统 SHALL 默认对导入行**改名重映射**：生成新 id，并同步改写包内引用（`channel.stream_ids`、`provider` 组合成员）；MUST NOT 修改本机已有行。system id（`default-*`）例外，SHALL **复用**已有系统行（append 引用）。

#### Scenario: 普通 id 撞车走 remap
- **WHEN** 导入的 Stream id 与本机已有 Stream id 相同
- **THEN** 导入行获得新 id，引用它的 Channel.stream_ids 被同步改写，本机原有 Stream 不变

#### Scenario: system 频道复用
- **WHEN** 导入的 Stream 挂在 `default-audio` 下
- **THEN** 该 Stream 被 append 进本机现有 `default-audio`，不新建系统频道

### Requirement: recipe 版本冲突解决（semver 合并）

当导入的内嵌 recipe 与本机已装的同 scoped id 撞车，系统 SHALL 走 semver：每 scoped 包同时只保留一个 active 版本；Stream 的 member binding `{plugin, source}` MUST NOT 钉版本。导入包版本 **>** 已装则提示升级；**≤** 已装且同 major 则复用已装；**跨 major** 则停下等用户显式选择，未决时落台账。

#### Scenario: 更高版本提示升级
- **WHEN** 导入包内嵌 `@a/xhs@2.1.3`，本机已装 `@a/xhs@2.0.0`
- **THEN** 系统提示升级到 2.1.3（同 major，向后兼容）

#### Scenario: 更低或同版本复用已装
- **WHEN** 导入包内嵌 `@a/xhs@2.0.0`，本机已装 `@a/xhs@2.1.3`
- **THEN** 复用本机 2.1.3，不降级

#### Scenario: 跨 major 停下问用户
- **WHEN** 导入包内嵌 `@a/xhs@3.0.0`，本机已装 `@a/xhs@2.x`
- **THEN** 导入在该 recipe 处暂停并要求用户显式选择，未决项落 import-problems 台账

### Requirement: host 无关的传输入口

系统 SHALL 支持从「返回包字节的 URL」或「本地文件」两条入口导入，且 MUST NOT 对 host 做特判——raw.githubusercontent、gist raw、任意 git、自建 URL 一视同仁。作者侧本期 SHALL 提供把编排导出成文件/JSON 的能力。

#### Scenario: URL 与文件结果一致
- **WHEN** 同一个包分别经一个 URL 与一个本地文件导入
- **THEN** 两条路径产出相同的重建结果

#### Scenario: 不特判 host
- **WHEN** 传入任意可返回包字节的 URL
- **THEN** 导入按内容处理，不因 host 名不同而拒绝或改变行为

### Requirement: import-problems 本地台账

系统 SHALL 维护一张 import-problems 本地台账，记录每次导入中无法自动解决的项（跨 major 搁置、代码插件缺失、包损坏、校验失败），含包标识、`meta.revision`、撞车依赖、本机现状与状态。台账 MUST 存于本机私有存储，MUST NOT 外发。

#### Scenario: 未解决冲突入账
- **WHEN** 一次导入遇到跨 major recipe 冲突且用户搁置
- **THEN** 台账新增一条记录该冲突的项，包含包标识与冲突详情

#### Scenario: 台账不外发
- **WHEN** 台账被写入
- **THEN** 数据仅落本机私有存储，无任何网络提交发生

### Requirement: 能力搭车顶层块（providers / providerBindings）

分享包 SHALL 支持两个**可选顶层块** `providers` 与 `providerBindings`，与 `channels`/`streams` 平级，**不属于任何频道闭包**。缺省时导入器 MUST 按无此块处理（向后兼容 v1 包）。导出 MUST NOT 从频道自动闭包推导这些块——它们只由作者**显式勾选**加入。

#### Scenario: v1 包无搭车块照常导入
- **WHEN** 导入一个不含 `providers`/`providerBindings` 块的包
- **THEN** 导入正常完成，不因缺块报错

#### Scenario: 顶层块与频道平级、不进闭包
- **WHEN** 导出一个频道但未勾选任何能力
- **THEN** 包内 `providers`/`providerBindings` 为空（或缺省），即便该频道运行时会用到某些 Provider

### Requirement: 显式勾选导出非系统 Provider 与 binding 覆盖

导出 SHALL 仅在作者**显式勾选**时收集 Provider/binding，且 MUST 只收 `system!==true` 的行。收集的 Provider 成员 params 随行序列化；成员 Source 的 `runtime_config` MUST NOT 进包（仅其需求声明进 `requires.runtimeConfig`）。全包 MUST NOT 含任何密钥值（沿用深度 `scanSecrets`，覆盖 `providers`/`providerBindings` 块）。

#### Scenario: 勾选后带上非系统 Provider
- **WHEN** 作者勾选「带上我改过的能力」并有一个自定义（非系统）Provider
- **THEN** 该 Provider 行进 `providers` 块，其成员非密钥 params 保留

#### Scenario: 系统 Provider 不进包
- **WHEN** 勾选导出，但相关 Provider 是系统默认行（`system===true`）
- **THEN** 该系统 Provider 不进包

#### Scenario: Provider 成员密钥不进包
- **WHEN** 某 Provider 成员 params 含疑似密钥值
- **THEN** 导出报出并拒绝（与配置行密钥红线一致）

### Requirement: 导入 Provider 趴着进（park-on-import，零全局副作用）

导入 SHALL 把包内 Provider 写入 store（id 撞车走 remap，改写包内 `{provider}` 组合成员引用），但 MUST NOT 自动接进任何 `provider_binding`、MUST NOT 自动加入 serves dispatch——导入后对方的全局路由 MUST 逐字不变。导入的 `providerBindings` 覆盖同样 MUST 落为**候选**，MUST NOT 直接写入生效的 `provider_bindings`。

#### Scenario: 导入后对方路由不变
- **WHEN** 导入含一个自定义 Provider 的包
- **THEN** 该 Provider 以 parked 状态入库，对方所有 callsite 的现有 dispatch 结果不变（未被新 Provider 抢占）

#### Scenario: Provider id 撞车 remap 且改写组合引用
- **WHEN** 导入的 Provider id 与本机已有 Provider 相同，且包内另有 `{provider}` 组合成员引用它
- **THEN** 导入行获得新 id，组合成员引用被同步改写，本机原有 Provider 不变

### Requirement: 激活 parked Provider 时解 serves/binding 冲突

系统 SHALL 提供显式激活 parked Provider 的操作。激活时 MUST 检测同 variant 下 serves 重叠与目标 callsite binding 抢占；有冲突 MUST 摆给用户选择（用导入的 / 用本机的 / 按序并存），未解决的 MUST 落 `import-problems` 台账，且在解决前 MUST NOT 改变对方现有 dispatch。

#### Scenario: 无冲突激活直接生效
- **WHEN** 激活一个 serves 不与任何已有行重叠的 parked Provider
- **THEN** 它加入 dispatch，无需用户解冲突

#### Scenario: serves 重叠激活时摆出冲突
- **WHEN** 激活的 Provider 与本机某 Provider 同 variant 且 serves 有重叠
- **THEN** 系统暂停并要求用户选择处置（用导入/用本机/按序），未决落台账，其间对方现有 dispatch 不变

### Requirement: 网盘 binding 顶层可选块（netdiskBindings）

分享包 SHALL 支持一个**可选顶层块** `netdiskBindings`，与 `channels`/`providers` 平级、**不属于任何频道闭包**。缺省时导入器 MUST 按无此块处理（向后兼容 v1 / change A 的包）。每项 MUST 只携带 `MappingSet` 的**可移植子集** `{ left, matchSpec, entries?, corrected?, shareUrl? }`，MUST NOT 携带 `right.path`（作者本机 AList 路径）或任何 fileId。

#### Scenario: 无 netdiskBindings 块照常导入
- **WHEN** 导入一个不含 `netdiskBindings` 块的包
- **THEN** 导入正常完成，不因缺块报错

#### Scenario: 导出不带 right.path 与 fileId
- **WHEN** 勾选导出一个 netdisk binding
- **THEN** 该项含 `left` 与 `matchSpec`，且全项文本不含 `right.path` 的本机路径，也不含任何 quark fileId

### Requirement: 显式勾选导出 netdisk binding（零凭证）

导出 SHALL 仅在作者**显式勾选**时收集 netdisk binding。收集项 MUST NOT 含任何凭证/对方登录态；`shareUrl`（若带）是 quark 公开分享链接。全包 MUST NOT 含密钥值（沿用深度 `scanSecrets`，覆盖 `netdiskBindings` 块）。`left.kind:'tmdb'` 原样携带；`left.kind:'stream'` 的 streamId MUST 在同包内（否则导出告缺）。

#### Scenario: tmdb-left binding 勾选导出
- **WHEN** 勾选导出一个 `left.kind:'tmdb'` 的 binding
- **THEN** 包内 `netdiskBindings` 含 `{left:{kind:'tmdb',...}, matchSpec}`，可复用无需依赖任何 stream

#### Scenario: stream-left 缺 stream 时告缺
- **WHEN** 勾选导出一个 `left.kind:'stream'` 的 binding，但其 stream 未被同包收入
- **THEN** 导出把该缺失以告警/缺失依赖形式报出，不静默产出一个不可重建的项

### Requirement: 导入暂存为 pending-转存 的 MappingSet（导入零执行）

导入 SHALL 为每个 `netdiskBindings` 项创建一个 `MappingSet`（`left` + `matchSpec`，`right` 置未解析/pending），id 撞车走 remap。导入 MUST NOT 触发转存、sync 或任何网盘采集；对方登录态 MUST 由对方在导入后自行提供。`ImportResult` MUST 列出这些待转存的 binding（含 `shareUrl` 若有）供引导。

#### Scenario: 导入创建 pending binding、不采集
- **WHEN** 导入含一个 tmdb-left netdisk binding 的包
- **THEN** 本机新增一个 `right` 未解析的 MappingSet（保留 matchSpec），导入期间无任何网盘/转存请求发生

#### Scenario: 待转存清单回给调用方
- **WHEN** 导入完成且包含 netdisk binding
- **THEN** `ImportResult` 含这些 binding 的待办（id、left 标题、shareUrl 若有）

### Requirement: 复用既有 rebind 完成重映射（matchSpec 不重算 AI）

系统 SHALL 让对方通过既有 `rebind` 入口把 pending binding 的 `right` 指到自己转存出来的 AList 路径；随后既有 sync 用携带的 `matchSpec` 对新目录**确定性重算**（或 rightHistory inherit）得到集↔文件映射，MUST NOT 重新运行 matchSpec 的 AI 生成。

#### Scenario: 转存后 rebind → matchSpec 命中
- **WHEN** 对方转存分享内容到自己网盘、挂进 AList，并对该 pending binding rebind 到新路径
- **THEN** sync 用包内 matchSpec 对新目录确定性重算出集↔文件映射，无需重跑 AI 生成
