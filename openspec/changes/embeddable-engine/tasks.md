## 0. 调研

- [x] 0.1 清点 `serve.ts` 的装配块：哪些属于实例、哪些属于 HTTP、哪些属于进程；列出全部 `process.env` 读取点与归属
- [x] 0.2 spike：sidequest 能否实例化（多个引擎 / 多个账本同进程）；不能则评估在 `SidequestFacade` 后换进程内实现的工作量（定 D5 走 A 还是 B）
- [x] 0.3 复核 design Context 4 的模块级状态清单，补上闭包里与第三方库的单例

## 1. 库入口骨架

- [x] 1.1 `src/engine/index.ts`：`createStream({dataDir, config, log, runtime})` 包住现有 `bootstrap()`，`close()` 走 `quiesceKernel`
- [x] 1.2 数据目录文件锁：同一目录第二次启动抛错
- [x] 1.3 环境变量收进 config：库入口可达模块不读 `process.env`，守卫测试 + 白名单（收尾 `0511f43`：MINERU_URL/VOICEPRINT_URL 回落删除、desktop see/status、RECIPE_PROBE、STREAM_NPM_REGISTRY、DOCKER_HOST、RSSHUB_PKG、STREAM_GATEWAY_PORT、serve 里 STREAM_NO_SCHEDULER/RECIPE_UPDATE_CHECK 的直读全部翻译进 `deploymentFromEnv`；名单只剩 acp-client / ffmpeg-bin / rsshub-worker-log 三条子进程继承环境的条目）
  - 已做：`loadConfig()` 移到 `src/config-env.ts`（进程入口专用）；`bootstrap.ts` 只剩 `readConfig(path, env)`；新增
    `AppConfig.deployment`（`deploymentFromEnv()` 翻译），credentials / runtime-config / agent / conversions 四个域插件改为显式收。
    守卫 `src/engine/no-process-env.guard.test.ts`（只减不增的名单）。
  - 剩下（名单上 19 个文件）：实例开关 `STREAM_PLUGIN_NETWORK`、`STREAM_DESKTOP_SEE_TRACE`、`desktopStatusEnabled`、
    `RECIPE_PROBE`、`STREAM_NPM_REGISTRY`、`MINERU_URL` / `VOICEPRINT_URL` 的客户端回落、两个包（`DOUYIN_API_URL`、`PANSOU_URL`）；
    进程级的（Docker endpoint、RSSHub、Chrome 发现、子进程继承 env、gateway 口）等任务 2.1 收进 runtime。
- [ ] 1.4 `serve.ts` 改用 `createStream`；把非 HTTP 的装配按块搬进入口（每块一个提交，每块后跑全量测试 + 真启动）
  - 已搬：实例装配本体 + 关停（`stream.close()`）、设备 / 节点 / 身份表（`stream.devices`，顺带关库）、能力包宿主 + 浏览器
    cookie 服务 + 可选能力包（`stream.capabilities`）、两把令牌（`stream.secrets`）。顺带修了 sidequest 抢 SIGTERM 的竞速
    （`gracefulShutdown: false`）。
  - 剩下：
    - 内核仍由 serve 建、经 `kernel` 过渡口递入——进程兜底网（`installProcessGuards`）要在装配期就能发通知；runtime（2.1）
      收走进程兜底网后去掉这个口。
    - 调度中心（`TaskStore` / `RunLedger` / 包动作 / `compileOpts` / `taskDeps` / `startTaskCenter`）与 `scheduler.start()`：
      跟 D5 的重写（3.1）一起搬，开关改读 `config.deployment.scheduler` / `recipe_update_check`（今天 serve 还读两个环境变量）。
      要带上 standby 接线（`taskDeps.standbyManager`，它读 `STREAM_PLUGIN_NETWORK`）。
    - research watchers、`markInterruptedAtBoot`、`installFetchFor`（模块级 `impl`，见 3.3）。
    - `DebugLog` 失败落盘、`LiveStreamService` / `SourceHealthIndex` / `ProfileClaims` 这些只被路由用的实例对象：随 `routes(app)` 一起定。

## 2. 进程级共享资源

- [x] 2.1 `createRuntime()`：RSSHub worker、isolated-vm、Chrome 发现、进程信号（`cd15e09`：进程兜底网、全局 fetch 拦截等进程级资源都在 runtime 上）
- [x] 2.2 `rsshub-adapter.ts`、`replay/author/facility-lock.ts` 改从 runtime 取（`cd15e09`）
- [x] 2.3 只读可共享的模块级状态加注释说明（`cd15e09`、`642aab8`）

## 3. 模块级状态归实例

- [x] 3.1 调度中心（按 0.2 的结论 B，每实例一份）：`tasks/center.ts`、`tasks/deps.ts`、`tasks/registry.ts`（`652ddfd`）
- [x] 3.2 来源钩子：`search/seeds`、`links/recognize`、`media/serving`、`registry/public`、`http/client-item`、`providers/identities`、`credentials/cookie-provider`、`plugins/plugin-target`、`plugins/standby/hook`
  - `search/seeds`、`links/recognize`、normalizer 注册表（`642aab8`）；serving / sites / projection / cookie env（`12555f1`，原 `2798deb` 已丢失、按同样标准重做）；plugin-target 与 standby（`155698f`，`ctx.packages.targets` / `ctx.packages.standby`，`STREAM_PLUGIN_NETWORK` 收进 deployment）；providers/identities（`031ef7f`，`ProviderIdentityTable` 于 ctx.sources，seed/bindings/callsite/UserStore 均按实例表）。
- [x] 3.3 内容缓存：`content/extract`、`adapters/favicon`；normalizer 注册表；`devices/fetch` 的 `impl`
  - normalizer 注册表（`642aab8`）；extract/favicon 缓存与 devices/fetch 的 impl 归实例（`ce3b963`：`ctx.stores.articles/favicons`、`ctx.deviceFetch`，replay 的 http/html 档显式穿 fetch）。OCR 图片缓存（`content/images/ocr-cache.ts`）同形状但不在本项清单，未动。
- [ ] 3.4 每处补「两个内核互相读不到」的用例

## 4. 工具接口

- [x] 4.1 `stream.tools.list()` / `call()`，内容同 MCP（含能力包动态工具）
- [x] 4.2 `createMcpServer` 改为包在工具接口上；MCP 端点行为不变（现有 MCP 测试全过）
- [x] 4.3 `ctx.caller` 记入运行记录；`annotations` 透出已有的风险信息

## 5. 双实例测试

- [ ] 5.1 同进程两个实例、两个临时数据目录：订阅 / 条目 / 设置 / 任务 / cookie / 缓存互不可见
- [ ] 5.2 关 A 不影响 B 的定时任务
- [ ] 5.3 共用一个 runtime 时只有一个 RSSHub worker

## 6. 发布与文档

- [ ] 6.1 `@streamapp/engine` 的 `package.json` 与 `exports`；导出清单快照守卫
  - 已做：导出清单守卫 `src/engine/exports.guard.test.ts`。
  - 剩下：`package.json#exports` 与发布布局——包放哪、要不要构建、原生依赖与运行期资产、版本节奏，待定项见 design D7。
- [ ] 6.2 `docs/ARCHITECTURE.md` 加「作为库使用」一节；README 提一句
- [ ] 6.3 真启动回归：`stream serve` + 面板 + 一次采集 + 一次 MCP 调用 + 一条定时任务
