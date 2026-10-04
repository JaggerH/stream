## Purpose

浏览器扩展的 CDP 中继作为采集 transport：RPC 与事件中继、自有 tab 与连接安全、recipe session 生命周期、steps 与 observers 可组合。

## Requirements

### Requirement: extension CDP RPC 与事件中继

系统 SHALL 让 Stream backend 通过与 extension 的 `/api/ext` WebSocket 在自有 Chrome tab 上
执行 CDP RPC，并 SHALL 支持订阅该 tab 的原始 CDP events。extension SHALL 只作为 transport，
不得解释 Recipe、匹配站点 URL、映射字段或决定动作策略。

#### Scenario: CDP 命令按 id 返回

- **WHEN** backend 发送 `{id,tabId,method,params}`
- **THEN** extension 在自有 tab 上执行命令并返回 `{id,result|error}`，backend 按 id 完成调用

#### Scenario: 原始 CDP event 按 subscription 和 tab 路由

- **WHEN** backend 为自有 tab 订阅 Network domain，目标 tab 产生 `Network.responseReceived`
- **THEN** extension 上报带 subscriptionId、tabId、method、params 的原始事件，且不读取或解释业务字段

#### Scenario: bounded observer 结束后取消订阅

- **WHEN** Recipe observer window 完成、取消或失败
- **THEN** backend 取消对应 subscription，extension 不再上报后续事件，避免无限抓包

### Requirement: 自有 tab 与连接安全

extension SHALL 只 attach、操作和关闭属于 Stream automation 会话标签组的 tab；任何用户手动
tab SHALL 不受影响。连接不可用、命令超时或 transport 被替换时 SHALL fail fast。

归属判据 SHALL 是「这个 tab 在不在会话标签组里」，而不是一份进程内的 id 名单：名单随 MV3
service worker 回收而蒸发，标签组是浏览器自己持有的、醒来后还能对账的事实。

#### Scenario: 拒绝操作组外 tab

- **WHEN** backend 对不在会话标签组里的 tab 请求 CDP、subscribe 或 close
- **THEN** extension 拒绝且不 attach、不读取事件、不关闭该 tab

#### Scenario: service worker 恢复

- **WHEN** MV3 service worker 恢复并发现残留的自有 tab
- **THEN** extension 与浏览器现状对账后重新登记或清理，绝不波及用户 tab

#### Scenario: transport 断线

- **WHEN** `/api/ext` 断开或命令超时
- **THEN** 所有对应 pending RPC/task 被 reject，extension 自动退避重连，不永久挂起

### Requirement: Recipe session 生命周期

系统 SHALL 由 backend SessionManager 管理 Recipe browser session，支持 `one-shot|persistent`
生命周期与 `unattended|interactive` visibility。Runner 和 extension transport SHALL 不自行决定
tab 生命周期。

visibility 只有两档，含义是**这件事要不要人看着**：`unattended` 是采集，跑在后台标签里；
`interactive` 是必须用户自己走完的流程（登录、建 key），开在他面前。历史上的第三档 `silent`、
`debug`、`foreground` SHALL 在装载时被拒绝并在错误里点名替代值 —— 静默改写成另一个值等于把
一份 recipe 的行为悄悄换掉。

**前台与「能不能跑」是两件事。** 后台标签的可信输入不靠抢屏换来，靠给页面开
`Emulation.setFocusEmulationEnabled`（launch 时一次性打开）：开了之后隐藏标签一次可信点击
162–185ms，比它当活动标签时的 204–257ms 还快；不开是 39.8–41.6s。因此 automation SHALL 允许
向页面声明它有焦点，同时 SHALL NOT 把窗口提到用户面前。封号治理靠的是频率而不是伪不伪装
（见 `Humanization serves the task`），所以这个开关与风控无关。

#### Scenario: facility 内共享 persistent session

- **WHEN** `xhs-home` 与 private `xhs-detail` 依次执行
- **THEN** 它们复用同一个 facility-scoped 自有 tab/session，并保持连续浏览上下文

#### Scenario: 一次性任务用完即走

- **WHEN** `xhs-search` 这类由用户一次动作触发、跑完结果就回到 Stream 里看的 Recipe 执行
- **THEN** 它按 `one-shot` 跑，释放 lease 即关标签，不在用户浏览器里留常驻页

#### Scenario: unattended 不抢用户焦点

- **WHEN** production Recipe 请求 `visibility:unattended`
- **THEN** automation 在后台标签里执行，不进入用户常用窗口、不 bringToFront

#### Scenario: 只有用户发起的流程才到前台

- **WHEN** 用户点击「去浏览器里重新登录」
- **THEN** 该 facility 的标签被提到前面，且这条路径不排在采集队列后面

### Requirement: Recipe steps 与 observers 可组合

Browser Recipe SHALL 将 session、steps、observers、output 和 policy 建模为正交部分。Network、state、
DOM observers SHALL 可在同一组 steps 执行期间并行工作，不得被建模为互斥 Source 或互斥 harvest mode。

每个 observer MAY 带自己的 `input` 映射：同一批内容从 SSR state 与 XHR 读出来字段命名常常不同
（小驼峰 vs snake_case），各自归一化之后才谈得上归并。

#### Scenario: 一次运行里多个 observer 并行读

- **WHEN** 一个 feed Recipe 同时声明 state observer（读首屏 SSR 那批）与 network observer（拦后续 XHR）
- **THEN** 两者在同一次运行里都产出条目，按身份归并成一份有序结果

#### Scenario: 点击同时读取详情数据

- **WHEN** Recipe 通过 trusted CDP input 点击一张 feed 卡片
- **THEN** bounded observer 在动作之后读取页面自然产生的详情数据，DOM 可作定位/校验 fallback

#### Scenario: 技术路径不复制 Source

- **WHEN** 同一个 Home Feed 可通过 Network、state 和 DOM 获得内容
- **THEN** catalog 仍只暴露一个 `xhs-home` Source，不产生 xhr/dom/click 后缀 Source

#### Scenario: 旧 Recipe 兼容

- **WHEN** loader 读取旧 `actions+harvest` 形状的 Recipe
- **THEN** 它按旧兼容 runner 执行，行为不静默改变；canonical 形状的 Recipe 走 session executor 与正式 runner

### Requirement: correlated frontend interaction

系统 SHALL 让 frontend 发起的详情动作携带 correlationId，并由 backend 把 frontend `/ws` task 与
extension `/api/ext` CDP RPC/events 关联。详情结果 SHALL 分段回传：backend 完成一次详情任务后，
按同一 correlationId 依次发出 started、article、comments、completed，frontend 逐段填充已经打开的
详情视图。

分段不等于流式：一次详情任务是一个整体，段是它完成后的切分。真正边读边推（observer 一拿到
article 就先发）不在本 change 范围内。

命令 payload SHALL 为 `{type:'xhs.open', correlationId, noteId, xsecToken}`。frontend SHALL NOT
传 sessionId —— 该用哪条 session 由 backend 依 Recipe 的 `session.facility` 决定，让前端指定
session 等于把一个它无从判断的东西交给它。

#### Scenario: Stream 点击驱动 shadow detail

- **WHEN** 用户点击一个 xhs ephemeral item
- **THEN** frontend 立即打开已有详情，并发送 correlationId、noteId、xsecToken；backend 在 shadow session 中定位并 trusted click 对应卡片

#### Scenario: 详情结果分段到达

- **WHEN** backend 完成一次详情任务
- **THEN** frontend 按同一 correlationId 收到 started、article、comments、completed，并逐段填充；correlationId 对不上的消息一律丢弃

#### Scenario: 被拦下时前端收到的是可分类的结果

- **WHEN** 详情任务撞上登录墙或风控
- **THEN** frontend 收到 `xhs.session.blocked`（带原因）而不是一条泛化的 failed

#### Scenario: 目标卡片不可恢复

- **WHEN** 虚拟列表已回收目标卡片，恢复预算内仍找不到
- **THEN** Recipe 降级为详情 URL 导航，并在 trace 中标记 `fallback-nav`

#### Scenario: 未点击的卡片不触发详情

- **WHEN** xhs 卡片只是接近 frontend viewport、用户未点击也未显式调用 enrich
- **THEN** 系统不启动 xhs detail Recipe

#### Scenario: 兼容入口等同一个任务

- **WHEN** 调用方走 `/api/enrich?source=xhs`
- **THEN** 它在内部等待同一个 correlated 详情任务完成并返回最终结果，不另跑一条采集路径

### Requirement: xhs 语义 Source 与临时数据

系统 SHALL 保留 `xhs-home` 和 `xhs-search` 两个语义 Source，并 SHALL 允许一个 private detail
Recipe 被二者复用。Home/Search/detail 的默认结果 SHALL 为 ephemeral，不写入 feed ItemStore。

#### Scenario: Source catalog 不暴露实现副本

- **WHEN** xhs recipe package 被装载
- **THEN** catalog 可发现 Home 与 Search；不得出现按技术路径命名的 Source；private detail 不在 discovery 中展示

#### Scenario: Home recommendation 无参数但仍是 Provider

- **WHEN** frontend 按需调用无 call-time params 的 `xhs-home`
- **THEN** 它按 T2 Provider 执行并直接返回临时结果，不因无参数被调度或持久化为 Stream

### Requirement: 任务驱动 Humanization 与风控停止

系统 SHALL 让 pacing、鼠标轨迹、滚动、停留和速率服务于当前 Recipe task，不得随机打开与用户
意图无关的卡片作为 camouflage。登录墙、风控或连续无进展 SHALL 停止任务并产生可分类通知。

speed 与 back-off SHALL 落在 facility 层而不是单份 Recipe 里：站点数的是这个 facility 的总频率，
而一份 Recipe 只知道自己。判据与落点见 `browser-recipe-replay` 的 `Humanization serves the task`。

#### Scenario: 用户点击决定详情动作

- **WHEN** frontend 请求打开 note A
- **THEN** shadow session 只定位并打开 A，不以随机概率打开其他 note

#### Scenario: 发现风控响应

- **WHEN** observer 检测到已知风控 body、登录墙或 session 异常
- **THEN** Recipe 停止，不通过更快重试对抗站点，并向 frontend 报告 blocked/needsLogin
