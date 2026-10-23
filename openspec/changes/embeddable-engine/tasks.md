## 0. 调研

- [x] 0.1 清点 `serve.ts` 的装配块：哪些属于实例、哪些属于 HTTP、哪些属于进程；列出全部 `process.env` 读取点与归属
- [x] 0.2 spike：sidequest 能否实例化（多个引擎 / 多个账本同进程）；不能则评估在 `SidequestFacade` 后换进程内实现的工作量（定 D5 走 A 还是 B）
- [x] 0.3 复核 design Context 4 的模块级状态清单，补上闭包里与第三方库的单例

## 1. 库入口骨架

- [ ] 1.1 `src/engine/index.ts`：`createStream({dataDir, config, log, runtime})` 包住现有 `bootstrap()`，`close()` 走 `quiesceKernel`
- [ ] 1.2 数据目录文件锁：同一目录第二次启动抛错
- [ ] 1.3 环境变量收进 config：库入口可达模块不读 `process.env`，守卫测试 + 白名单
- [ ] 1.4 `serve.ts` 改用 `createStream`；把非 HTTP 的装配按块搬进入口（每块一个提交，每块后跑全量测试 + 真启动）

## 2. 进程级共享资源

- [ ] 2.1 `createRuntime()`：RSSHub worker、isolated-vm、Chrome 发现、进程信号
- [ ] 2.2 `rsshub-adapter.ts`、`replay/author/facility-lock.ts` 改从 runtime 取
- [ ] 2.3 只读可共享的模块级状态加注释说明

## 3. 模块级状态归实例

- [ ] 3.1 调度中心（按 0.2 的结论）：`tasks/center.ts`、`tasks/deps.ts`、`tasks/registry.ts`
- [ ] 3.2 来源钩子：`search/seeds`、`links/recognize`、`media/serving`、`registry/public`、`http/client-item`、`providers/identities`、`credentials/cookie-provider`、`plugins/plugin-target`、`plugins/standby/hook`
- [ ] 3.3 内容缓存：`content/extract`、`adapters/favicon`；normalizer 注册表；`devices/fetch` 的 `impl`
- [ ] 3.4 每处补「两个内核互相读不到」的用例

## 4. 工具接口

- [ ] 4.1 `stream.tools.list()` / `call()`，内容同 MCP（含能力包动态工具）
- [ ] 4.2 `createMcpServer` 改为包在工具接口上；MCP 端点行为不变（现有 MCP 测试全过）
- [ ] 4.3 `ctx.caller` 记入运行记录；`annotations` 透出已有的风险信息

## 5. 双实例测试

- [ ] 5.1 同进程两个实例、两个临时数据目录：订阅 / 条目 / 设置 / 任务 / cookie / 缓存互不可见
- [ ] 5.2 关 A 不影响 B 的定时任务
- [ ] 5.3 共用一个 runtime 时只有一个 RSSHub worker

## 6. 发布与文档

- [ ] 6.1 `@streamapp/engine` 的 `package.json` 与 `exports`；导出清单快照守卫
- [ ] 6.2 `docs/ARCHITECTURE.md` 加「作为库使用」一节；README 提一句
- [ ] 6.3 真启动回归：`stream serve` + 面板 + 一次采集 + 一次 MCP 调用 + 一条定时任务
