# Tasks — recipe-record-replay-contract

**分两个阶段**：第 1–5 组是第一阶段的**可交付整体**；第 6 组是第二阶段（运行期图选路），
**不阻塞**第一阶段交付。

## 1. 探索图 → 静态 recipe 编译

- [ ] 1.1 定义编译入口：输入 `ExploreDraft` + 目标状态，输出 canonical Recipe（新模块或 `explore-graph.ts` 的同级）
- [ ] 1.2 选路：在 `transitions` 上求 `draft.start` → 目标状态的**最短路径**；排除 `irrelevant` / `frozen` 状态
- [ ] 1.3 编译：路径上每条 transition 的 `steps` 串成 recipe 的 `steps[]`；补 `session`（facility / visibility / lifecycle）
- [ ] 1.4 产物 SHALL 直接过 `validateRecipe`，不需要人手改写
- [ ] 1.5 补测：给定一份草稿图 → 编译产物合法，且 `steps` 与最短路径逐条对应
- [ ] 1.6 补测边界：无路径可达 / `start` 缺失 / 路径只经过 `one-way` 边——三种各自给出明确结论，不静默产出空 recipe

## 2. 混合优先级：静态 recipe 优先

- [ ] 2.1 定义「有明确 recipe」的判据，**键与 repair 账本同源**（`facility + recipeId`）
- [ ] 2.2 运行侧：有 recipe 走 recipe；没有才走图选路
- [ ] 2.3 补测：两条路各自被走到；且**判据键的测试与 repair 账本键共用同一处定义**（防两处漂移）

## 3. replay 侧的两个真问题

- [ ] 3.1 `src/replay/author/validate.ts` 从 `runBrowserRecipe` 改用 `RecipeRunner`，`onWall` 作为 hook 传入
- [ ] 3.2 旧形 Recipe 进 runner 前经 `canonicalizeBrowserRecipe` 显式翻译——**这是它的第一个生产调用方**
- [ ] 3.3 validate 报告改用 canonical outcome 词汇（`ok|needsLogin|challenged|blocked|drift|cancelled|unavailable`）
- [ ] 3.4 确认 `runBrowserRecipe` 的剩余调用方（`src/adapters/replay/adapter.ts:323`）是否还需要；需要则写明为什么
- [ ] 3.5 补测：同一份旧形 recipe 经 validate 与经线上 replay 得到**同一个 outcome**
- [ ] 3.6 `RepairLedger` 的键从 `sourceId` 改为 `facility + recipeId + version`
- [ ] 3.7 `RepairState` 增加 `affectedSources`，方向是「用的人申报」（`SourceManifest.uses` / recipe 侧 `meta.uses`）
- [ ] 3.8 更新读账的调用方：`adapter.ts` 的 `recordDrift` / `recordSuccess`、`RepairRunner`
- [ ] 3.9 存量台账文件的迁移：旧形按 sourceId 的记录**读入还是丢弃**，给明确结论并写明代价——**不许留空**（留空的表现是升级后历史漂移记录静默消失）
- [ ] 3.10 补测：共用同一份 detail Recipe 的两个 Source，一次漂移后**两个都被标出**

## 4. 退役死路

- [ ] 4.1 移除 `record translate`：`src/replay/author/translate.ts` 的 browser-use history 解析与 `latestExplorePath`
- [ ] 4.2 `src/replay/author/cli.ts` 的 `ParsedArgs` 去掉 `translate`；`cli.test.ts` 相应断言（与已有的「退役命令」那条合并）
- [ ] 4.3 确认没有别的调用方（`translate.test.ts`、`.xhr.json` 的读取、`record translate` 的脚本入口）

## 5. 文档与验收

- [ ] 5.1 更新 `write-recipe` skill 的 authoring 一节：把「探索 → 编译 → 上线」写成一条路径，并注明**采集不在自动编译范围**
- [ ] 5.2 `pnpm test`、`pnpm typecheck`（走 `scripts/qrun.sh`）
- [ ] 5.3 真机验收：探一条新路径 → 编译 → 上线跑通，**全程不手改 recipe**（这是本阶段唯一的端到端判据，单测替代不了）

## 6. 第二阶段：运行期图选路（不阻塞第一阶段）

- [ ] 6.1 recipe（或无 recipe 时的入口）记 `{facility, 目标}`；运行期每到一步，按图算「当前状态 → 目标」的最短边
- [ ] 6.2 **复用已有的三层状态图装配**（内置全局 ∪ 包自带 `states.json` ∪ 本机学到的那层），不新开机制
- [ ] 6.3 读**快照**，避免探索写入中途被读到半成品（`writeDraft` 已是 tmp+rename，确认读取侧也成立）
- [ ] 6.4 补测：没有静态 recipe 时，按图从起点走到目标
