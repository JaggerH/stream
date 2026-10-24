## Context

1. **内核已经是插件化的。** `bootstrap()` 建一棵 cordis 内核（`src/kernel/context.ts`），一域一插件（`src/kernel/plugins/*.ts`），
   域内用 `ctx.effect()` 登记句柄，关停时 `quiesceKernel` 一次撤掉。`Boot` 只剩 `{config, kernel}` 两格。这是本 change 的地基：
   「一个实例」天然就是「一棵内核」。
2. **但装配有一半在 `serve.ts`。** `main()` 在 `bootstrap()` 之外还装配了设备与节点表、能力主机、调度中心依赖、MCP、插件网关、
   面板资源、ws 推送等，并且读了 9 处环境变量。
3. **持久状态已经按数据目录走。** 约 25 个 store 各自 `new Database(dbPath)`，路径都从 `resolveDataDir(config)` 推出；
   settings、cookie 快照、缓存也在数据目录下。换一个数据目录就是换一套状态——不需要给每张表加租户列。
4. **模块级状态清单**（补遗见附录 B；`grep -E '^(export )?(let|var) '` 与模块级 `new Map/Set`，排除常量表）：

   | 类别 | 文件 | 处置 |
   |---|---|---|
   | 调度中心 | `tasks/center.ts`（`active`、`activeJobClass`、`queueAlive`、`centerLog`、`ledgerPath`、`generation`、`knownQueues`、`cronHandles`、`idQueues`）、`tasks/deps.ts`、`tasks/registry.ts` | 归实例；sidequest 见 D5 |
   | 注入的来源钩子 | `search/seeds.ts`、`links/recognize.ts`（`tableSource`、`debugSink`）、`media/serving.ts`、`registry/public.ts`、`http/client-item.ts`、`providers/identities.ts`、`credentials/cookie-provider.ts`、`plugins/plugin-target.ts`、`plugins/standby/hook.ts` | 归实例：改成从内核取，或由调用点显式传入 |
   | 内容缓存 | `content/extract.ts`、`adapters/favicon.ts`（`content` 句柄 + 内存 `cache`） | 归实例 |
   | 注册表 | `content/normalize.ts` 的 normalizer 表 | 归实例（包随实例装卸） |
   | 出站 fetch | `devices/fetch.ts` 的 `impl` | 归实例 |
   | RSSHub 客户端 | `rsshub-adapter.ts`（`client`、`initialized`） | 进程共享，进 `StreamRuntime`（D4） |
   | 只读可共享 | `rsshub-install.ts` `inflight`、`rsshub-worker.ts` `pkgPromise`、`replay/compute-sandbox.ts` `ivmPromise`、`http/build-identity.ts` 两个缓存、`links/recognize.ts` `compiled`、`conversions/store.ts` 的单调 id | 保留，加注释说明为什么可共享 |
   | 进程信号 | `replay/author/facility-lock.ts`（`handlersInstalled`、`activeLocks`） | 进 `StreamRuntime` |
   | 独立进程 | `event-source/worker/main.ts` | 不动（它本来就是子进程） |

5. 进程级只该有一份的东西：RSSHub worker 子进程、isolated-vm、Chrome 可执行文件的发现结果、进程信号处理。

## Goals / Non-Goals

**Goals**
- 一个不读环境变量、不监听端口的库入口；`serve.ts` 是它的一个调用方。
- 工具目录有进程内接口，MCP 只是它外面的一层协议。
- 同一进程里起两个实例，状态互不可见，关掉一个不影响另一个。
- 进程级共享资源显式化，可在多个实例间共享。
- 对现有用户零行为变化：`stream serve`、MCP、doctor、数据格式、HTTP API 都不变。

**Non-Goals**
- 不做多租户的设备中继：扩展与 desktop agent 连到哪个实例，仍由调用方决定（各实例各挂自己的中继路由）。
- 不换存储引擎、不给表加租户列。
- 不做进程内上百个实例的资源调优（内存、文件句柄上限）——先做到「正确」，再看「能装多少」。
- 不拆仓库、不改 pnpm workspace 结构之外的东西。

## Decisions

### D1. 库入口

```ts
const runtime = createRuntime({ log })            // 可选；不传则 createStream 自建
const stream = await createStream({
  dataDir,                                        // 必填，绝对路径
  config,                                         // AppConfig；缺省 = 读 dataDir 下的 config.yaml
  log, runtime,
  devices?: { … },                                // 设备 / 节点 / 绑定表，缺省 = 从 dataDir 下的 stream.db 建
})
stream.kernel        // cordis Context
stream.tools         // D3
stream.routes(app)   // 把 HTTP API、中继、MCP 端点挂到调用方的 Hono app 上（可选）
await stream.close() // quiesceKernel + 关库 + 摘定时器
```

- 入口在 `src/engine/index.ts`。`createStream` = 今天 `bootstrap()` + `serve.ts` 里非 HTTP 的装配。
- **不读 `process.env`**：今天 `bootstrap.ts`、`kernel/plugins/agent.ts`、`kernel/plugins/conversions.ts`、`replay/*` 等处读的环境变量
  全部收进 `config` 的字段；`serve.ts` 与 CLI 入口负责把环境变量翻译成 config。加一条守卫测试：`src/engine/` 可达的模块里不出现
  `process.env`（白名单列出确有理由的，如 `NODE_ENV`）。
- `routes(app)` 只挂路由，不 `listen`；端口、TLS、进程信号是调用方的事。

### D2. 一个实例 = 一个数据目录

全部持久状态在 `dataDir` 下。两个实例传同一个 `dataDir` 是调用方的错误：入口在数据目录里拿一把文件锁（沿用
`event-source/worker` 的做法），第二个拿不到就抛，免得两份内核写同一组 sqlite。

### D3. 工具目录的进程内接口

```ts
stream.tools.list(): ToolDef[]                    // {name, description, inputSchema, annotations}
stream.tools.call(name, args, ctx): Promise<ToolResult>
// ctx: { caller?: string; signal?: AbortSignal; onProgress?(p) }
```

- 内容与今天 MCP 暴露的完全一致（同一份 `tool-catalog`），包括能力包的动态工具。
- `createMcpServer` 改为遍历 `tools.list()` 注册、把调用转给 `tools.call()`；MCP 不再直接持有 service 与 extras。
- `annotations` 带上已有的风险信息（`cdp_act` 的 intent、动作 recipe 的副作用声明），调用方可以据此加审批；本 change 不加新的
  风险分类，只把已有的信息透出来。
- `caller` 记进运行记录，便于调用方追溯是谁调的。

**落地（任务 4）：**
- 工具面的唯一一份是 `src/mcp/tool-registry.ts` 的 `toolSpecs(service, extras)`：目录（`tool-catalog.ts`）+ 原先就地写在
  `server.ts` 的三个（`intent_dossier` / `stream_subscribe` / `subscribe_source`）+ 能力包工具，顺序即 `tools/list` 的顺序。
  `createMcpServer` 只遍历它注册（zod shape 交 SDK 校验）并转调 `invoke`；两个资源（`stream://streams` / `topics`）仍是 MCP 独有。
- `list()` 每项 `{name, description, inputSchema, annotations}`，`inputSchema` 用 SDK 自己的 zod → JSON-Schema 转换器生成，
  与 `tools/list` 逐项相等（`src/mcp/tool-registry.test.ts`、`src/engine/tools.test.ts` 两条一致性用例）。
- `call()` 回 `{content, isError?, value?}`：前两格与经 MCP 调用一字不差（校验失败 / 工具不存在 / 工具抛错都是 `isError`，
  文本照抄 SDK），`value` 是工具返回的原值。每次 `list()` / `call()` 现建目录，能力包运行期上下线随之可见。
- `ctx.caller` 经 AsyncLocalStorage（`src/tool-caller.ts`，值按调用走，同 `devices/run-context.ts`）带到
  `SearchRunStore.create`，落 `agent-runs.db` 的新列 `caller`——覆盖 `search_agent` / `enumerate_candidates` /
  `purchase_decide` / `run_action_recipe` 建的 run。经 MCP 端点的调用不记（不带 caller，输出不变）。
- `ctx.signal` 透传到能力包的 `execute`；`ctx.onProgress` 经 MCP 接到 `notifications/progress`，今天还没有工具报进度。
- `annotations`：每个工具显式给 `readOnlyHint`（类型必填 + 守卫测试），分类见附录 C。`cdp_act` 的逐次 `intent` /
  `confirmed`、动作 recipe 的二次确认仍是调用期的闸；`annotations` 是工具级的静态提示，不替代它们。

### D4. `StreamRuntime`：进程级共享资源

```ts
createRuntime({ log }) → { rsshub, sandbox, chrome, signals, close() }
```

- RSSHub worker、isolated-vm、Chrome 发现、进程信号处理只在这里建一次。
- 实例经 `createStream({ runtime })` 拿到它；不传则自建一个并在 `close()` 时一起关（单实例场景与今天等价）。
- `rsshub-adapter.ts` 的模块级 `client` 改为从 runtime 取。

### D5. 调度中心：sidequest 是进程单例

`tasks/center.ts` 用 `Sidequest.start / stop` 静态方法，一个进程只能有一个 sidequest 引擎。两个选项：

- **A. 共享一个引擎，队列按实例加前缀。** runtime 持有唯一的 sidequest 引擎与账本；每个实例的队列名加实例前缀，cron 句柄、
  注册表按实例分开。代价：账本在 runtime 的目录里，不再在实例的数据目录里——违背 D2。
- **B. 每实例一个账本，引擎换成实例化的调度器。** 检查 sidequest 是否支持实例化（非静态）用法；不支持就在 `SidequestFacade`
  背后换成进程内实现（已有的 `SidequestFacade` 接口正是为替换留的口）。

倾向 **B**，前提是 spike 确认可行（任务 0.2）：实例的状态应该完整地待在实例的数据目录里，否则备份、迁移、删除一个实例都要
多处收拾。spike 不通再退到 A，并把账本路径写进 D2 的例外。

**结论（0.2，sidequest 1.16.2）：走 B，但不必自己重写引擎——绕开静态门面，按实例组装 sidequest 已导出的下层零件。**

- 静态门面确实不能实例化。`Sidequest.engine` 是一个静态 `Engine`，而 `Engine` 本身也不是实例隔离的：配置与 backend 存在
  `@sidequest/engine` 的**模块级** `dependencyRegistry` 里；`Engine.configure()` 见到已有配置就直接返回（"already configured"）；
  `Engine.close()` 调 `ScheduledJobRegistry.stopAll()`（静态表，摘掉进程里**所有** cron）、`dependencyRegistry.clear()`、
  `clearGracefulShutdown()`（`process.removeAllListeners('SIGINT' / 'SIGTERM')`，连宿主自己的信号处理也一起摘）。
  实测：两个 `new Engine()` 各配一个账本，第二个**静默沿用第一个的账本**（两条 job 都落进 a.sqlite，b.sqlite 根本没建）；
  关掉第一个之后第二个 `build()` 抛 `Engine not configured`。
- 下层零件是实例化的：`LazyBackend(config.backend)`、`WorkerRuntime(backend, config)`（派发器 + 执行器 + 两个维护 cron，全挂在
  实例上）、`new JobBuilder(backend, JobClass, defaults, manualJobResolution)`，都从 `sidequest` 包导出，构造时显式收 backend，
  不碰 `dependencyRegistry`。inline runner 在宿主进程里跑 job 时不重注配置（`runner.js` 的 `inline` 分支）。
  实测：A、B 各自一套零件 + 各自账本，同名任务 `unique({withArgs:true})` 互不去重（各落各的账本）；关 A 之后 B 的 cron 照常触发。
- job → 实例的路由：job 类由 jobs 文件按类名解析、无参构造，拿不到实例。用 `JobBuilder.with(instanceKey)` 把实例键写进
  `constructor_args`（落账），job 运行时按键查进程级路由表取那个实例的注册表与 deps。`args` 仍是 `[taskId]`，所以
  `orphan-sweep.ts` / `run-history.ts` / watchdog 的账本查询一字不改；旧账本里 `constructor_args = []` 的行路由到唯一实例
  （单实例时与今天等价）。
- 要自己接手的：建库迁移（`backend.migrate()`）、静态队列 `grantQueueConfig`、关停顺序（我们的 cron 句柄 → `WorkerRuntime.shutdown()`
  → `backend.close()`），**绝不调 `Engine.close()`**。`ScheduledJobRegistry` 的静态表仍会登记 `b.schedule()` 建的 cron——我们自己
  `destroy()`，表里只剩已停句柄的引用（泄漏引用，不触发）；`whenBusy: 'skip'` 那档本来就自持 node-cron，不受影响。
  日志（`configureLogger`）是进程级的，留给 runtime。dashboard（8678）是 HTTP，归调用方。
- 工作量：`center.ts` 的模块级状态整体收进一个 `TaskCenter` 类（每实例一个），`realFacade` 换成上面那套组装，
  `StreamTaskJob` 加一个构造参数。uniqueness / 补跑 / 代际语义都还是 sidequest backend 与现有代码在做，不重写。
- 顺带发现（今天的单实例就有）：`startTaskCenter` 没传 `gracefulShutdown: false`，sidequest 自己在 SIGINT/SIGTERM 上挂了
  「关引擎 → `process.exit(0)`」，与 `serve.ts` 的 `shutdownThen` 竞速；换成组装式之后这条自然消失。

### D6. 模块级状态归实例的方式

- **能从内核取的就从内核取**：钩子类状态（`setXxxSource(fn)` 形状）改成域服务上的方法，调用点从 `ctx` 拿。
- **调用点拿不到 `ctx` 的**（深处的纯函数），改为显式参数传入；不引入 AsyncLocalStorage 一类的隐式上下文——它让「这份数据属于
  哪个实例」变得看不见，出错时最难查。
- 每处改完补一条用例：两个内核各设一个不同的来源，互相读不到。

### D7. 发布与边界

- `@streamapp/engine`：`package.json#exports` 只列 `src/engine/index.ts`（构建产物同理）。类型也只从这里导出。
- 守卫测试：`src/engine/index.ts` 的导出清单钉成快照，改动需要显式更新；`exports` 不出现内部路径。
- 现有的 `@streamapp/*` recipe 包、`sdk/plugin-sdk`、`shared/*` 不受影响。

**任务 6.1 现状与待定：** 导出清单守卫已有（`src/engine/exports.guard.test.ts`，按源码文本数、含类型导出、禁 `export *`）。
`package.json#exports` **没加**——发布布局要先定下面几件事，不是改一行能完的：
1. **包放哪。** 根包叫 `stream`、`private: true`，是应用本身；直接给它加 `exports` 会挡掉仓库里按路径的深引用，也不能改名发布。
   倾向：新建工作区包 `engine/`（`@streamapp/engine`），只放 `package.json` + 构建产物，源码仍在 `src/`。
2. **要不要构建。** 今天全仓 `.ts` 直跑（tsx）。发 npm 要么打包成 JS（`src/` 可达图很大，含 `shared/`、`capabilities/desktop`），
   要么要求调用方也用 TS 加载器——后者不适合当公开包。倾向：rolldown/esbuild 打一个 ESM 入口 + `tsc` 出 `.d.ts`，依赖外置。
3. **原生依赖与运行期资产。** `better-sqlite3`、`isolated-vm`、`sharp` 是原生依赖（peer 还是直接依赖）；内置 recipe 包目录
   （`packages/`）、RSSHub worker、`sidequest.jobs.js` 是按路径加载的运行期文件，要么随包发，要么由调用方经 `config.packages_dir`
   等给路径。
4. **版本与发布节奏**：与应用同版本号还是独立 semver。

## Risks / Trade-offs

- **装配顺序回归**：`serve.ts` 里的装配有大量顺序依赖与「前向引用的惰性 thunk」。搬迁按块走，每搬一块跑全量测试与一次真启动
  （`stream serve` + 面板 + 一次采集 + 一次 MCP 调用）。
- **sidequest 换实现**（若走 D5-B）：调度中心挂着真下单的任务。替换必须保住现有的 uniqueness、补跑、代际语义，原有测试全部保留。
- **漏网的全局状态**：清单靠 grep，闭包里的状态、第三方库的单例可能漏。双实例测试（任务 5）是兜底：它对每个域都做一次
  「A 写、B 读不到」。
- **工具接口固化**：`tools.list()` 的形状一旦有外部调用方就难改。先按 MCP 的工具定义原样透出，不发明新字段。

## Migration

- 无数据迁移。`stream serve` 的命令行、环境变量、端口、数据目录布局不变。
- 搬迁期间 `serve.ts` 与 `createStream` 并存一段，按块迁，每块一个提交，main 始终可发布。

## 附录 A：`serve.ts` 装配块清点（任务 0.1）

归属：**实例** = 进 `createStream`；**HTTP** = 留在调用方（`serve.ts` / `routes(app)`）；**进程** = 进 `StreamRuntime` 或留在进程入口。

| 块（`main()` 里的先后） | 归属 | 备注 |
|---|---|---|
| `acquireLock` / `releaseLock`（`stream-serve.pid`） | 进程 | serve 的防双开；实例另有数据目录锁（D2） |
| `createKernel` | 实例 | |
| `installProcessGuards` | 进程 | 通知经 lazy thunk 取实例的事件层 |
| `loadConfig()` | 进程 | env → config 的翻译点 |
| ext token / api token（`loadOrCreate*Token`） | 实例 | 落数据目录；消费方是 HTTP 访问守卫与三条中继 |
| `DeviceStore` / `ExtBindingStore` / `FacilityDeviceStore` / `NodeStore` / `SiteIdentityStore` | 实例 | D1 的 `devices`；前三个今天不关库 |
| `WsHub` | HTTP | 实例经 `broadcast` / `onItem` 回调往外推 |
| `DebugLog` + 失败落盘 | 实例 | 推 ws 那半是 HTTP |
| `OpTracker` / `startLoopLagMonitor` | 进程 | 实例收 `track` / `trackSync` |
| `createCapabilityHost` + `BROWSER_COOKIE_SERVICE` + `loadOptionalCapabilities` | 实例 | |
| `bootstrap()` | 实例 | |
| `installFetchFor` | 实例 | 今天写模块级 `impl`（附录 B） |
| `installGlobalFetchTrap` | 进程 | 改写 `globalThis.fetch` |
| 下载队列 / 库存变更 → ws 广播、enrich / 登录两条 ws 命令 | HTTP | |
| `actionRun`、扩展物化 / 代装 / 卸载 / 重载 | 实例 | 只有 HTTP 在调；随 D3 的工具接口再定 |
| `restart`（`classifyLauncher(process.env)`） | 进程 | |
| `createHttpApp` + 各 `mount*`（MCP、config rows、live、research、local recipes、生图、skills、设备、身份、扩展绑定、节点、任务、源健康、介入、面板、任务面板、插件网关、独立页） | HTTP | 其中 `LiveStreamService`、`SourceHealthIndex`、`ProfileClaims` 的构造是实例对象，只被路由用 |
| `TaskStore` / `RunLedger` / 包动作名录 / `compileOpts` | 实例 | |
| `markInterruptedAtBoot`（介入） | 实例 | |
| research watchers | 实例 | 推 ws 那半是 HTTP |
| standby 接线（`wireStandby`，模块级 hook） | 实例 | 读 `STREAM_PLUGIN_NETWORK` |
| `serve()` 监听 + `attachWs` + 三条中继 attach | HTTP | 中继的注册表是实例的 |
| `mountHostAgent`（养 Stream Desktop 本机进程） | 进程 | 要 `baseUrl`；一台机器一个 |
| `scheduler.start()`（`maybeStartScheduler`） | 实例 | 开关今天是 `STREAM_NO_SCHEDULER` |
| 调度中心（`taskDeps` + `startTaskCenter`） | 实例 | 见 D5 |
| `reportUnboundHooks` | 实例 | |
| `shutdownThen` 与信号 | 进程 | 关停本体（停任务中心、standby、`quiesceKernel`）是实例的 `close()` |

### `process.env` 读取点（从 `bootstrap.ts` + `serve.ts` 静态可达）

| 位置 | 变量 | 归属 |
|---|---|---|
| `serve.ts` | `STREAM_PORT`、`STREAM_DATA_DIR`（pid 锁）、`STREAM_OP_RING`、`STREAM_LOOP_PROFILE`、`STREAM_TRUSTED_ORIGINS`、`classifyLauncher(env)`、`VITEST` | 进程 / HTTP，留在 serve |
| `serve.ts` | `STREAM_NO_SCHEDULER`、`STREAM_RECIPE_UPDATE_CHECK` | 实例开关 → config |
| `bootstrap.ts` `loadConfig` | `STREAM_CONFIG`、`STREAM_DATA_DIR`、`STREAM_MANAGE_CONTAINERS`、`AUDIO_ARCHIVE_ROOT` | env → config 翻译，移出库入口可达范围 |
| `bootstrap.ts` | `STREAM_DESKTOP_SEE_MODEL` | 实例开关 → config |
| `kernel/plugins/agent.ts` | `STREAM_SEARCH_TEXT_FOLD`、`STREAM_SEARCH_SEMANTIC_FOLD` | 实例开关 → config |
| `kernel/plugins/conversions.ts` | `VOICEPRINT_URL` | 实例 → config |
| `kernel/plugins/credentials.ts`、`credentials/token-provider.ts`、`kernel/plugins/runtime-config.ts` | 整个 env（BYOK 回落表） | 实例：部署环境显式传入 |
| `plugins/plugin-target.ts`、`plugins/standby/wire.ts`、`plugins/gateway.ts` | `STREAM_PLUGIN_NETWORK`、`STREAM_GATEWAY_PORT` | 实例 → config（gateway 是 HTTP） |
| `docparse/client.ts`、`voiceprint/engine-client.ts` | `MINERU_URL`、`VOICEPRINT_URL` | 实例；客户端深处的回落，改成调用方传 |
| `packages/container-ops.ts`、`plugins/deprovision.ts`、`plugins/provision-wire.ts` | `DOCKER_HOST` 等（`resolveDockerEndpoint`） | 进程 |
| `rsshub-client.ts`、`rsshub-worker-log.ts` | `RSSHUB_PKG`、`CACHE_TYPE`、子进程 env、`RSSHUB_WORKER_LOG_PATH` | 进程（RSSHub worker，D4） |
| `browser/discover-chrome.ts` | `PATH` | 进程（Chrome 发现，D4） |
| `media/ffmpeg-bin.ts`、`intervention/acp-client.ts`、`tasks/exec-runner.ts`、`restart/policy.ts`、`capabilities/desktop` | 子进程继承 env | 进程 |
| `replay/desktop-driver.ts`、`replay/desktop-see.ts` | `STREAM_DESKTOP_SEE_TRACE` | 实例开关 → config |
| `replay/desktop-runner.ts` | `desktopStatusEnabled(env)` | 实例开关 → config |
| `replay/recipe-probe.ts` | `RECIPE_PROBE` | 实例开关 → config |
| `replay/recipe-registry.ts` | `STREAM_NPM_REGISTRY` | 实例 → config |
| `host-agent/mount.ts` | `hostAgentSkipReason(env)` | 进程 |
| `packages/Douyin_TikTok_Download_API`、`packages/pansou` | `DOUYIN_API_URL`、`PANSOU_URL` | 包代码；应改走 `ctx.backendUrl` / runtime config |

剩余的由 `src/engine/no-process-env.guard.test.ts` 的白名单逐条钉住（只减不增）。

## 附录 B：模块级状态复核（任务 0.3）

Context 4 那张表之外补上的：

| 类别 | 位置 | 处置 |
|---|---|---|
| 调度中心 | `tasks/center.ts` 的 `idQueues`（每 taskId 串行链） | 归实例（随 `TaskCenter` 类） |
| 来源钩子 | `providers/identities.ts` 的 `callsiteDefaults`、`plugins/plugin-target.ts` 的 `missReporter` | 归实例 |
| 媒体缓存 | `video/dash.ts` `seenSegHosts`（分片主机白名单 + 头，90 分钟） | 归实例：一个实例放行的主机不该让另一个实例的代理也放行 |
| 只读可共享 | `media/ffmpeg-bin.ts` `resolved`（ffmpeg 可执行文件解析结果） | 进 runtime / 保留 |
| 进程全局改写 | `devices/global-fetch-trap.ts`（改 `globalThis.fetch`）、`http/owned-outbound.ts`（快照原始 fetch）、`process-guard.ts`、`load-env.ts`（往 `process.env` 灌 `.env`） | 进程：留在入口，库入口不做 |
| 每次调用的上下文 | `devices/run-context.ts`、`http/host-relay.ts` 的 `AsyncLocalStorage` | 可共享：值按调用走，不按实例 |
| 第三方单例：sidequest | `dependencyRegistry`（配置 + backend）、`ScheduledJobRegistry`（静态 cron 表）、`gracefulShutdown`（SIGINT/SIGTERM 监听，`close` 时 `removeAllListeners`）、`configureLogger` | 见 D5：绕开 `Engine`，只用实例化零件；日志归 runtime |
| 第三方单例：RSSHub | 内嵌 RSSHub 的 request-rewriter 改写全局 `fetch` / `node:http` | 进程（D4 的 RSSHub worker） |

## 附录 C：工具的 `readOnlyHint` 分类（任务 4.3）

判据：**只读** = 不改用户能看见的状态、不在外部留下副作用（付费调用、内部缓存、在用户浏览器里开一个读完即关的页不算改）。
非只读再分两档：`destructiveHint: false` = 写本地状态、追加式或可撤；`true` = 外部副作用 / 移动删除文件 / 覆盖已有配置 /
在用户的浏览器或桌面上执行任意动作。**拿不准一律非只读。** 能力包工具没声明 `readOnlyHint` 的按 `false`。
名单钉在 `src/mcp/tool-registry.test.ts`（改它 = 改嵌入方给无人值守调用方的放行面）。全集 66 个（目录 63 + 就地 3）：

| 档 | 数 | 工具 |
|---|---|---|
| 只读 | 35 | `stream_list` `stream_search` `stream_sources` `stream_categories` `stream_status` `stream_read` `stream_fetch_url` `inbox_search` `content_search` `price_search` `web_search` `read_url` `video_search` `video_resolve` `get_conversions` `read_content` `list_person_appearances` `resolve_intent` `resolve` `list_sources` `netdisk_bindings` `netdisk_browse` `netdisk_residue` `netdisk_preview_spec` `netdisk_transcribe` `netdisk_share_verify` `reconcile_status` `harvest_capability` `capability_status` `cdp_shot` `graph_frontier` `get_agent_run` `intent_list` `intent_dossier` `get_events` |
| 写、可撤（`destructiveHint:false`） | 14 | `purchase_decide` `search_agent` `enumerate_candidates` `extract` `identify_speakers` `note_unonboardable` `intent_create` `subscribe_source` `reconcile_decide` `netdisk_sync` `graph_record_state` `graph_back` `graph_mark_irrelevant` `recipe_debug_abort` |
| 真动手（`destructiveHint:true`） | 17 | `run_action_recipe` `recipe_debug_start` `recipe_debug_next` `cdp_act` `cdp_look` `cdp_pages` `graph_act` `provision_capability_key` `stream_subscribe` `stream_unsubscribe` `netdisk_apply_spec` `netdisk_follow` `reconcile_open` `reconcile_execute` `reconcile_undo_run` `reconcile_adjudicate` `reconcile_revoke_adjudication` |

拿不准、按保守判的几个：
- `cdp_look` → 真动手：名字是「看」，但 `js` 是在用户已登录的 Chrome 里执行任意脚本、`url` 会开页，能做的事与 `cdp_act` 无异。
- `cdp_pages` → 真动手：带 `close` 时关掉用户的标签页。
- `extract` / `identify_speakers` → 写：起转换、落用户在卡片上看得见的记录，`rerun` 会覆盖旧记录。
- `purchase_decide` / `search_agent` / `enumerate_candidates` → 写：只读外网，但起后台 run、落库、花模型额度。
- `netdisk_sync` → 写：不动文件，但重算并持久化配对结果。
- `stream_subscribe` → 真动手：同 id 再订会覆盖那条流；`subscribe_source` 是确定性 upsert，判写。
- `reconcile_adjudicate` → 真动手：跑的过程中可能把追更候选转存进用户网盘。
- 判只读的边界：`stream_read` / `content_search` / `web_search` 会经用户的浏览器取页（读完即关，不落库）；`read_url` 可能走付费回落；
  `read_content` 长文会过一次摘要（写内部缓存）；`netdisk_transcribe` 花 ASR 钱、缓存结果——都不改用户可见状态。
