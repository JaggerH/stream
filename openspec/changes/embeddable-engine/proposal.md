## Why

Stream 今天只能以一个应用的形态跑：`src/serve.ts` 的 `main()` 读环境变量、建内核、装配几十个域、挂 HTTP 与 MCP、监听端口，
一气呵成。想把它的能力放进另一个进程里用——一个托管多个用户的服务、一个桌面应用的主进程、一组同进程跑两份实例的集成测试——
都只能整个起一个 Stream 进程，再隔着 HTTP 调它。

障碍有三类：

- **没有库入口。** 装配分散在 `bootstrap()` 与 `serve.ts` 两处，后者 1300 多行，其中大半不是「HTTP 服务器」而是装配；
  调用方拿不到一个「给我一份 Stream，我自己决定怎么暴露」的入口。
- **工具只能经 MCP 协议拿到。** 工具目录（`src/mcp/tool-catalog.ts` 等）只通过 `createMcpServer` 暴露成一个 MCP 服务器。
  同进程的调用方想列工具、调工具，也得走一遍 MCP 传输。
- **进程级的全局状态。** 约 40 处模块级 `let` / 单例 `Map`：调度中心（`src/tasks/center.ts` 的 sidequest 门面、cron 句柄、
  队列表）、各种「注入一个来源」的钩子（`links/recognize.ts`、`search/seeds.ts`、`media/serving.ts`、`registry/public.ts`、
  `providers/identities.ts`、`credentials/cookie-provider.ts`、`plugins/standby/hook.ts`…）、内容缓存的句柄。
  一个进程里起第二份内核，后起的那份会悄悄覆盖前一份的这些状态。

## What Changes

- **库入口 `createStream()`。** 接收显式的数据目录、配置与日志，回一个句柄：内核、工具目录、HTTP 路由（可选挂到调用方的
  Hono app 上）、`close()`。它不读环境变量、不监听端口、不注册进程信号。`serve.ts` 改为这个入口的一个调用方：读环境变量 →
  `createStream()` → 挂 HTTP → 监听。
- **一个实例 = 一个数据目录。** 两个实例的全部持久状态（sqlite 库、settings.json、cookie 快照、缓存）都落在各自的数据目录里，
  不共享任何文件。
- **工具目录的进程内接口。** `stream.tools.list()` 回工具定义（名字、说明、JSON Schema 参数），`stream.tools.call(name, args, ctx)`
  执行一个工具并回结构化结果。MCP 服务器改为在这个接口上包一层协议。`ctx` 带调用方身份与取消信号，为调用方加审批、计量留口。
- **去掉进程级全局状态。** 模块级可变状态逐个归入内核上的某个域（`ctx.effect()` 登记句柄、随内核销毁）；真正只读、可共享的
  （编译好的正则、已加载的 isolated-vm 模块、RSSHub 包的加载 promise）显式标成进程级共享，并写清为什么可以共享。
- **进程级共享资源显式化。** RSSHub worker、compute 沙箱、Chrome 发现这类一个进程只该有一份的资源，收进一个 `StreamRuntime`
  对象，由调用方创建一次、传给多个实例；不传就各自建一个（与今天一致）。
- **双实例测试。** 一个测试在同一进程里起两个实例（两个临时数据目录），证明订阅、条目、设置、任务、cookie 互不可见，
  关掉一个不影响另一个。
- **发布形态。** 公共入口作为 npm 包 `@streamapp/engine` 的导出（`exports` 只列公共入口）；加一条守卫测试，钉住公共入口
  不 re-export 内部模块以外的路径，内部文件不出现在 `exports` 里。

## Capabilities

### New Capabilities
- `embeddable-engine`：库入口、一个实例一个数据目录、进程内工具接口、同进程多实例互不干扰、进程级共享资源。

### Modified Capabilities
- 无行为变更。`stream serve`、MCP stdio、doctor 的对外行为保持不变。

## Impact

- `src/serve.ts`、`src/bootstrap.ts`：装配移进库入口；`serve.ts` 只剩环境变量、HTTP 挂载、监听与信号。
- `src/mcp/server.ts`、`src/mcp/tool-catalog.ts`：MCP 改为包在工具接口上。
- 带模块级状态的约 25 个文件（见 design 的清单）。
- 新增 `src/engine/`（公共入口）与包 `@streamapp/engine` 的 `package.json` / `exports`。
- 不改数据格式、不迁移数据、不改 HTTP API 与 MCP 工具名。
