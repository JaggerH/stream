## Context

1. **内核已经是插件化的。** `bootstrap()` 建一棵 cordis 内核（`src/kernel/context.ts`），一域一插件（`src/kernel/plugins/*.ts`），
   域内用 `ctx.effect()` 登记句柄，关停时 `quiesceKernel` 一次撤掉。`Boot` 只剩 `{config, kernel}` 两格。这是本 change 的地基：
   「一个实例」天然就是「一棵内核」。
2. **但装配有一半在 `serve.ts`。** `main()` 在 `bootstrap()` 之外还装配了设备与节点表、能力主机、调度中心依赖、MCP、插件网关、
   面板资源、ws 推送等，并且读了 9 处环境变量。
3. **持久状态已经按数据目录走。** 约 25 个 store 各自 `new Database(dbPath)`，路径都从 `resolveDataDir(config)` 推出；
   settings、cookie 快照、缓存也在数据目录下。换一个数据目录就是换一套状态——不需要给每张表加租户列。
4. **模块级状态清单**（`grep -E '^(export )?(let|var) '` 与模块级 `new Map/Set`，排除常量表）：

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

### D6. 模块级状态归实例的方式

- **能从内核取的就从内核取**：钩子类状态（`setXxxSource(fn)` 形状）改成域服务上的方法，调用点从 `ctx` 拿。
- **调用点拿不到 `ctx` 的**（深处的纯函数），改为显式参数传入；不引入 AsyncLocalStorage 一类的隐式上下文——它让「这份数据属于
  哪个实例」变得看不见，出错时最难查。
- 每处改完补一条用例：两个内核各设一个不同的来源，互相读不到。

### D7. 发布与边界

- `@streamapp/engine`：`package.json#exports` 只列 `src/engine/index.ts`（构建产物同理）。类型也只从这里导出。
- 守卫测试：`src/engine/index.ts` 的导出清单钉成快照，改动需要显式更新；`exports` 不出现内部路径。
- 现有的 `@streamapp/*` recipe 包、`sdk/plugin-sdk`、`shared/*` 不受影响。

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
