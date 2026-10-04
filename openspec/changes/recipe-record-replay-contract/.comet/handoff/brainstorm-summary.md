# Brainstorm Summary

- Change: recipe-record-replay-contract
- Date: 2026-10-01

## Confirmed Technical Approach

用户确认的最终形态是**混合式运行模型**：

1. **有明确路径就只走它**——探索图编译成的静态 recipe 优先。
2. **历史里没有录制过相关的，才在运行期带图选路。**

用户原话：「我的目标最后是 B，但是现在我们实际上是 A……混合模式可能更合适」——
即最终目标是运行期图选路（B），但当下能交付的是静态编译（A），两者按上述优先级共存。

**本 change 的范围**：先交付 A 那半（探索图 → 静态 recipe 编译 + 优先级规则 + replay 侧两个真问题
+ 退役死路）；B 那半（运行期图选路）作为同 change 的第二阶段，不阻塞第一阶段的交付。

## 关键发现（本次 brainstorming 挖出来的，推翻了原 proposal 的前提）

1. **原 proposal 盯的是一条死路。** 它写的是 `src/replay/author/translate.ts` 那条
   `record translate --history` 链路，吃的是 `explore-*.json` + `.xhr.json`。而那个 `explore`
   子命令是 CloakBrowser 时代的，**2026-07-28 随「Stream 改成骑用户自己的 Chrome」一并退役**
   （`src/replay/author/cli.ts:8-13` 自陈；`cli.test.ts:25-28` 断言它已是 `Unknown command`）。
   **今天没有任何东西会产出 `explore-*.json`。**

2. **真正的探索能力在别处，而且已经在跑。** `src/intervention/explore-*`
   （`explore-session.ts` / `explore-graph.ts` / `explore-surface.ts` / `explore-manager.ts`），
   由 **CDP 扩展驱动活页面**，以 MCP 工具 `graph_act` / `graph_frontier` / `graph_record_state` /
   `graph_back` 暴露。落到 `<dataDir>/state-graphs/<facility>.explore-<runId>.json`。

3. **它记的是「怎么走 + 怎么认状态」，不是「读什么数据」。** `ExploreDraft` =
   `states[] + transitions[]`，transition 的 steps 是 `[{ do: 'click', selector }]`
   （`explore-graph.ts:91`），选择器由 `stableSelector()` 保证运行期可重放。另有一份
   `ObservationLedger` 记每个状态的特征真值，但那是喂**区分度闸**的，不是数据提取。

4. **所以缺口是**：草稿图**没有变成 recipe**。`readDraft` 的全部调用方只有探索会话自己和
   `serve.ts:852` 的一个 API 出口——没有任何代码把图编译成 recipe。

5. **这个缺口的直接含义**：编译出的 recipe 先服务**动作 recipe**（发消息、下单），
   因为那类只需要 steps。**采集 recipe 不行**——采集靠 observers 读数据，而探索根本没记那层。
   **采集明确不在本 change 范围。**

6. **B 那半不是从零加一条路。** 状态图**本来就已经是运行期输入**：`expect` 落空时 runner 会拿
   三层状态图（内置全局 ∪ 包自带 `states.json` ∪ 本机学到的那层）去认状态、选逃生口
   （`write-recipe` skill §2.1）。而探索产物写的正是第三层。所以 B 是把「图认状态」扩成「图导航」。

## Key Trade-offs and Risks

- **编译 vs 运行期选路**：静态编译符合本仓对 recipe 的定义（固化的可执行数据，运行期不经模型、
  不依赖别的文件）；运行期选路更接近用户描述的语义，但让运行期依赖一份会被后续探索改写的文件。
  **取混合：静态优先，图为 fallback。** 缓解图变动的风险靠读快照 + `writeDraft` 已是 tmp+rename。
- **优先级判据必须与 repair 账本键一致**（`facility + recipeId`），否则会出现
  「账本说这个源有 recipe、路由说没有」这种两边单看都正常的错位。
- **退役 `translate` 是 breaking**：任何人若还在用 `record translate` 会失去它。判断是可接受——
  它今天的输入已经没有任何产出方。
- **采集不在范围**：这是明确的 Non-Goal，必须在 proposal 里写死，否则会被误读成「探索能自动出采集 recipe」。

## Testing Strategy

- **编译**：单测「给定一份草稿图，编译出的 recipe 过 `validateRecipe` 且 steps 与最短路径一致」；
  边界：无路径可达 / 起点缺失 / 只有 one-way 边。
- **优先级**：单测「有 recipe 走 recipe、没有走图」，且两条路的判据键与 repair 账本键同源。
- **validate 共用 runner**：同一份旧形 recipe 经 validate 与经线上 replay 得到**同一个 outcome**。
- **repair 记账**：共用同一份 detail recipe 的两个 Source，一次漂移后**两个都被标出**。
- **真机验收**：探一条新路径 → 编译 → 上线跑通，全程不手改 recipe。

## Spec Patches

delta spec 需要重写（现有内容是写给已退役那条路的）：

- `browser-recipe-replay`：把「Record and Replay 使用同一 Recipe 契约」改成
  **「探索图编译成 Recipe + 混合运行优先级」**；保留并强化「Repair 以 Recipe 为失败单元」。
- 删掉围绕 `translate` / browser-use history / UNTRANSLATED 的场景。
- **不做新 capability**：编译与优先级都落在 `browser-recipe-replay` 内（它本来就覆盖
  Record / Translate / Validate / Replay / Repair 五格）。
