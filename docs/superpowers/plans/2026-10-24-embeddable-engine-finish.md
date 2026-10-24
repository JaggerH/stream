# embeddable-engine 收尾 · 开发计划

> 规范：`openspec/changes/embeddable-engine/`（proposal / design / specs / tasks）。本计划把 tasks.md 里没做完的项拆成可以逐个交付的任务，
> 每个任务写清改哪里、先写什么测试、怎样算做完。**按顺序做**，一个任务一个（或几个）提交，做完一个就推。
> 计划之外的设计决定不要自己拍：写进交付报告的「规范里没写、我自己定的」，影响接口或语义的先停下来问。

## 起点（2026-10-24，main = `642aab8`）

已在 main 上、但 tasks.md 还没勾：

| 提交 | 覆盖 |
|---|---|
| `652ddfd` | 3.1 调度中心每实例一份（D5-B） |
| `cd15e09` | 2.1 `createRuntime()`、2.2 rsshub-adapter / facility-lock 改从 runtime 取、2.3 共享缓存加注释；去掉 `createStream` 的 `kernel` 过渡口 |
| `642aab8` | 3.2 / 3.3 的一部分：search seeds、link recognition、normalizers |

没在 main 上的半成品：分支 `embeddable-engine-g23-wip`（worktree `.claude/worktrees/agent-ac83c71522aa2b1e0`）

| 提交 | 内容 | 处置 |
|---|---|---|
| `2798deb` | serving policies、source sites、item projection、cookie env 归实例（29 个文件，完整的一块） | 任务 1 救回来 |
| `c9f50db` | WIP，未测：plugin-target、standby、docparse / voiceprint / alist 客户端、bootstrap、serve 等 | 只作参考，不直接合；任务 2、5 重做时可以照抄其中对的部分 |

main 上剩下的模块级可变状态（`grep -E '^(export )?(let|var) '`）：

```
media/serving.ts  policySource            → 任务 1（2798deb）
registry/public.ts siteSource             → 任务 1
http/client-item.ts projectionSource      → 任务 1
credentials/cookie-provider.ts packageCookieEnvSource → 任务 1
providers/identities.ts packageIdentities, callsiteDefaults → 任务 3
plugins/plugin-target.ts injectedResolver, missReporter     → 任务 2
plugins/standby/hook.ts injected, inert                     → 任务 2
content/extract.ts content, adapters/favicon.ts content     → 任务 4
devices/fetch.ts impl                                       → 任务 4
—— 以下保留（进程级、只读可共享或独立进程），已有或要补注释 ——
rsshub-worker.ts pkgPromise, rsshub-adapter.ts fallbackWorker, exit-hooks.ts processHooks,
replay/compute-sandbox.ts ivmPromise, conversions/store.ts lastMs/seq, http/build-identity.ts 两个缓存,
event-source/worker/main.ts lockFd
```

## 通用要求（每个任务都适用）

- 先写测试，看它失败，再改代码。每个归实例的状态都要有一条「两个内核互相读不到」的用例（照 `642aab8` 里的写法）。
- 跑：改动涉及的目录 + `src/engine` + 守卫（`no-process-env`、`exports.guard`、`hosts-boundary`）；任务结束前跑一次 `src shared` 全量，
  失败项与未改动的 main 对照（javis 上 ffmpeg / npm 相关的失败是环境性的）。
- 每个任务结束做一次**真启动**：`STREAM_DATA_DIR=$(mktemp -d) STREAM_PORT=<空闲口> node_modules/.bin/tsx src/serve.ts`，
  确认 `/api/health`、MCP `tools/list`、日志里调度中心起来；SIGTERM 后进程退出码 0、数据目录里没有 `engine.lock`。
- 勾 tasks.md，并在对应项下写一行「做了什么 / 提交」。
- 公开仓库：提交、注释、文档里只写「嵌入别的进程 / 一个进程多个实例」这类中性动机。

---

## 任务 0：tasks.md 记账（不改代码）

- 勾上 2.1、2.2、2.3、3.1，各写一行对应的提交；3.2、3.3 下写明已做的部分（`642aab8`）与剩下的（本计划任务 1–4）。
- 提交：`docs(embeddable-engine): tick what 652ddfd..642aab8 finished`

**做完的标准**：tasks.md 与 main 的实际状态一致。

## 任务 1：救回 `2798deb`

- 在新的 worktree 里从 main 开分支，`git cherry-pick 2798deb`。冲突主要会在 `src/kernel/plugins/sources.ts`、`provider.ts`、`serve.ts`
  （`642aab8` 也动了它们）——两边的改动都要留：`642aab8` 加的 searchSeeds / links / normalizers 与 `2798deb` 加的 serving / sites /
  projection / cookie env 是并列的四样。
- 跑 `2798deb` 自带的那些测试（serving、registry/public、client-item、image-fetch、track-resolve、transcribe/media、audio-netdisk…）
  与 `src/kernel`、`src/http`。
- 提交保留原标题；冲突处理写进提交正文。

**做完的标准**：`media/serving`、`registry/public`、`http/client-item`、`credentials/cookie-provider` 不再有模块级 `let`；
各有两内核用例；全量对照无新增失败。

## 任务 2：plugin-target 与 standby 归实例

现状：`plugins/plugin-target.ts` 的 `injectedResolver`、`missReporter` 与 `plugins/standby/hook.ts` 的 `injected`、`inert` 是模块级注入口；
`plugin-target.ts` 还读 `STREAM_PLUGIN_NETWORK`。

- 改成实例上的服务（插件 / 能力包域上一个对象，持 resolver、miss reporter、standby manager 与 inert 原因），调用点从 `ctx` 取；
  拿不到 `ctx` 的深层调用改为显式传参（design D6：不用 AsyncLocalStorage）。
- `STREAM_PLUGIN_NETWORK` 收进 `AppConfig.deployment`（`deploymentFromEnv()` 翻译），从 `no-process-env` 名单删掉 `plugin-target.ts`。
- `serve.ts` 里 standby 的接线（`taskDeps.standbyManager`）随之改为从实例取。
- 可以参考 `c9f50db` 里对这几个文件的改法，但要自己补测试。

**测试**：两内核各注入不同的 resolver / standby，互相看不到；`STREAM_PLUGIN_NETWORK` 经 config 生效（原有行为的用例照过）。

## 任务 3：providers/identities 归实例

现状：`packageIdentities`、`callsiteDefaults` 由包激活时写入模块级变量。

- 移到 provider 域（`ctx.provider` 或 sources 域上的一张表），包激活 / 卸载时更新这一实例的表。
- 所有读它的地方（`grep -rn "packageIdentities\|callsiteDefaults\|identities.ts" src`）改为从实例取。

**测试**：实例 A 装了一个声明身份的包、实例 B 没装 → B 查不到；卸载后 A 也查不到。

## 任务 4：内容缓存与出站 fetch 归实例

- `content/extract.ts`、`adapters/favicon.ts` 的 `content` 句柄（与 `wireArticleCache` / `wireFaviconCache` 的接线）：缓存属于实例，
  落在实例数据目录里；模块里的内存 `cache` Map 一并归实例（或以实例为 key）。
- `devices/fetch.ts` 的 `impl`（`installFetchFor`）：选择用哪个出站实现是实例的事，改为实例上的 `fetchFor`；
  **进程级的全局 fetch 拦截仍归 runtime（`process: true`）**，不要动 `cd15e09` 的那部分语义。
- `serve.ts` 里的 `installFetchFor` 调用随之搬进 engine。

**测试**：两内核各写一条文章缓存、各取到自己的；favicon 同理；实例 A 换了 fetch 实现不影响 B。

## 任务 5：环境变量名单收到只剩进程级

`src/engine/no-process-env.guard.test.ts` 的名单（当前 16 项）处置：

| 文件 | 处置 |
|---|---|
| `docparse/client.ts`（MINERU_URL）、`voiceprint/engine-client.ts`（VOICEPRINT_URL） | 回落改由调用方从 `config.deployment` 传入；删出名单 |
| `replay/desktop-driver.ts`、`replay/desktop-see.ts`（STREAM_DESKTOP_SEE_TRACE）、`replay/desktop-runner.ts`（desktopStatusEnabled 缺省参数） | 收进 `config.deployment`；删出名单 |
| `replay/recipe-probe.ts`（RECIPE_PROBE）、`replay/recipe-registry.ts`（STREAM_NPM_REGISTRY） | 收进 `config.deployment`；删出名单 |
| `plugins/plugin-target.ts` | 任务 2 已处理 |
| `intervention/acp-client.ts`、`media/ffmpeg-bin.ts`（子进程继承环境） | 保留；理由写清 |
| `packages/container-ops.ts`、`plugins/deprovision.ts`、`plugins/provision-wire.ts`（DOCKER_HOST） | 收进 runtime（`createRuntime({ dockerHost })`，serve 从 env 翻译）；删出名单 |
| `rsshub-client.ts`、`rsshub-worker-log.ts` | 收进 runtime 的 RSSHub worker 配置；删出名单（若子进程继承环境必须保留，写清只剩哪一行） |
| `plugins/gateway.ts`（STREAM_GATEWAY_PORT） | HTTP 层的事，移到 `serve.ts` / `routes()` 的参数；删出名单 |

`serve.ts` 里还读的 `STREAM_NO_SCHEDULER`、`STREAM_RECIPE_UPDATE_CHECK` 改读 `config.deployment`。

**做完的标准**：名单只剩「子进程继承环境」这类确实属于进程的条目，每条有一句理由；`serve.ts` 与 `src/config-env.ts` 是仅有的环境变量翻译处。

## 任务 6：`serve.ts` 只剩进程入口（D1 的 `routes(app)`）

目标形状：

```ts
// serve.ts
const config = configFromEnv(process.env)            // src/config-env.ts
const runtime = createRuntime({ process: true, … })  // 进程兜底、信号、全局 fetch 拦截
const stream = await createStream({ dataDir, config, runtime, log })
const app = new Hono()
stream.routes(app, { port, … })                      // HTTP API、扩展 / host 中继、MCP、插件网关、面板资源
listen(app, port); onSignal(() => stream.close().then(() => runtime.close()))
```

- 把 research watchers、`markInterruptedAtBoot` 搬进 engine（它们是实例的事）。
- 新增 `stream.routes(app, opts)`：把今天 `serve.ts` 里挂路由、中继、MCP、插件网关、面板资源的部分搬进 `src/engine/routes.ts`；
  只被路由用到的实例对象（`DebugLog` 失败落盘、`LiveStreamService`、`SourceHealthIndex`、`ProfileClaims` 等）随之建在 `routes()` 里或实例上，
  按「不挂路由的嵌入方是否也需要它」判断：需要 → 实例；不需要 → `routes()`。判断写进 design D1 的附注。
- 挂载顺序的约束照旧（前端兜底 `*` 必须最后挂；见 `serve.ts` 现有注释）。
- 导出清单变化要更新 `exports.guard` 快照。

**测试**：`routes(app)` 挂到一个空 Hono 上，`/api/health`、`/api/mcp` 的 `tools/list` 可用；未调用 `routes()` 时没有任何端口被监听（spec「调用方自己决定怎么暴露」）。
`serve.routes` 现有测试照过。

**做完的标准**：`serve.ts` 不再 import 任何域插件或 store；行数大幅下降（预期 < 300 行）。

## 任务 7：同进程双实例测试（5.1–5.3，3.4）

新文件 `src/engine/two-instances.test.ts`，起两个 `createStream`（两个临时数据目录，共用一个 `createRuntime()`）：

1. A 订阅一个流（用测试夹具里的本地源，不出网）并采到条目 → B 的订阅列表、条目查询、`tools.call('stream_list')` 都看不到。
2. A 改设置（settings.json 的一项）→ B 不变。
3. A、B 各加一条定时任务 → 关闭 A → B 的那条照样按点触发（用短 cron 或注入时钟）；A 的账本不再被写。
4. A 写一条 cookie 快照 → B 读不到。
5. A、B 各写一条文章缓存 → 各取到自己的。
6. 两个实例都发起一次 RSSHub 路由调用 → 进程里只有一个 RSSHub worker（runtime 上可观测的计数）。
7. 第二个 `createStream` 用 A 的数据目录 → 抛错，A 照常。

3.4：前面任务 1–4 每项已有各自的两内核用例；这里的测试是整体兜底。勾 3.4、5.1–5.3。

## 任务 8：文档与真启动回归（6.2、6.3）

- `docs/ARCHITECTURE.md` 加「作为库使用」一节：`createRuntime` / `createStream` / `routes` / `tools` / `close` 的用法与生命周期、
  一个实例一个数据目录、哪些资源进程共享；README 提一句并链过去。
- 6.3 真启动回归（手动，结果写进交付报告）：`stream serve`（临时目录）→ 面板能打开 → 一次采集（本地夹具源或一个不需要登录的 RSSHub 路由）
  → 一次 MCP 调用 → 加一条定时任务并看它触发一次 → SIGTERM 干净退出、无锁残留。
- 6.1（`@streamapp/engine` 的发布形态）**不做**，等 design D7 的四个问题定下来。

---

## 验收要点（Claude 验收时看这些）

| 任务 | 必看 |
|---|---|
| 0 | tasks.md 与 `git log` 对得上 |
| 1 | cherry-pick 冲突处两边的改动都在；四个文件无模块级 `let` |
| 2–4 | 对应文件无模块级 `let`；每项一条两内核用例；行为用例照过 |
| 5 | 名单剩几项、每项理由；`grep -rn "process.env" src/serve.ts src/config-env.ts` 之外的读取点都在名单里 |
| 6 | `serve.ts` 的 import 清单与行数；`routes()` 的测试；挂载顺序 |
| 7 | 7 条场景逐条有断言；关 A 后 B 的定时确实触发（不是只断言「没报错」） |
| 8 | 文档一节；交付报告里 6.3 每一步的结果 |
| 全部 | 真启动记录；`src shared` 全量与 main 对照无新增失败；提交与文档只写中性动机 |
