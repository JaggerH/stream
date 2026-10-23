## ADDED Requirements

### Requirement: 库入口

系统 SHALL 提供一个库入口 `createStream()`，接收显式的数据目录、配置、日志与可选的进程级共享资源，回一个带内核、工具接口、
路由挂载与 `close()` 的句柄。库入口 SHALL NOT 读取环境变量（白名单除外）、SHALL NOT 监听端口、SHALL NOT 注册进程信号处理。
`stream serve` SHALL 通过这个入口装配自己，对外行为保持不变。

#### Scenario: 调用方自己决定怎么暴露
- **WHEN** 调用方 `createStream({ dataDir })` 后不调用 `routes()`
- **THEN** 没有任何端口被监听，工具接口照常可用

#### Scenario: serve 行为不变
- **WHEN** 用户照旧运行 `stream serve`
- **THEN** 端口、HTTP API、MCP 端点、数据目录布局与改动前一致

### Requirement: 一个实例一个数据目录

一个实例的全部持久状态 SHALL 落在它的数据目录下。两个实例 SHALL NOT 共用同一个数据目录：第二个以同一目录启动的实例 SHALL
启动失败并说明原因。

#### Scenario: 同一目录起两次
- **WHEN** 同一进程里对同一个数据目录调用两次 `createStream`
- **THEN** 第二次抛错，第一个实例不受影响

### Requirement: 工具的进程内接口

系统 SHALL 提供 `tools.list()` 与 `tools.call(name, args, ctx)`，其工具集合、名字、参数与结果 SHALL 与 MCP 端点暴露的一致。
MCP 端点 SHALL 建立在这个接口之上。`ctx.caller` SHALL 记入该次调用产生的运行记录。

#### Scenario: 同进程调用工具
- **WHEN** 调用方 `tools.call('inbox_search', { query: 'x' }, { caller: 'test' })`
- **THEN** 得到与经 MCP 调用同名工具相同的结果，不经过任何网络传输

#### Scenario: 能力包的动态工具
- **WHEN** 一个能力包在运行期上线并声明了工具
- **THEN** `tools.list()` 随之包含这些工具，与 MCP 端点一致

### Requirement: 同进程多实例互不干扰

同一进程里的多个实例 SHALL 互不可见对方的订阅、条目、设置、任务、cookie 快照与缓存。关闭一个实例 SHALL NOT 影响其他实例的
运行，包括它们的定时任务。

#### Scenario: 状态隔离
- **WHEN** 实例 A 订阅一个流并采到条目，实例 B 查询条目与订阅
- **THEN** B 看不到 A 的订阅与条目

#### Scenario: 关一个不影响另一个
- **WHEN** 两个实例各挂一条定时任务，关闭实例 A
- **THEN** 实例 B 的定时任务照常按点触发

### Requirement: 进程级共享资源

一个进程只该有一份的资源（RSSHub worker、compute 沙箱、Chrome 发现、进程信号处理）SHALL 集中在一个可显式创建、可在多个实例间
传递的 runtime 对象里。不传 runtime 的实例 SHALL 自建一个并在关闭时一并释放。

#### Scenario: 两个实例共用一个 RSSHub worker
- **WHEN** 调用方创建一个 runtime 并传给两个实例，两个实例都发起 RSSHub 采集
- **THEN** 进程里只有一个 RSSHub worker 子进程

### Requirement: 公共入口有边界

`@streamapp/engine` 的 `exports` SHALL 只包含公共入口。公共入口的导出清单 SHALL 由测试钉住，变更需要显式更新。

#### Scenario: 内部模块不可直接导入
- **WHEN** 外部包尝试 `import '@streamapp/engine/src/kernel/context.ts'`
- **THEN** 解析失败
