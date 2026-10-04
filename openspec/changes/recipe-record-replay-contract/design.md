## Context

Stream 的采集与动作都靠 recipe（固化的可执行数据，运行期重放，不经模型）。写 recipe 今天靠手工抓包 + 手写。

**探索建图（`src/intervention/explore-*`）已经能把「AI 用 CDP 驱动活页面走一遍」的过程记成图**：
`ExploreDraft = states[] + transitions[]`，每条 transition 带 `{from, to, steps, effect, via}`，
其中 `steps` 是 `[{ do: 'click', selector }]`，选择器由 `stableSelector()` 保证运行期可重放。
产物落 `<dataDir>/state-graphs/<facility>.explore-<runId>.json`。

**缺的是最后一跳**：`readDraft` 的全部调用方只有探索会话自身与 `serve.ts:852` 的一个 API 出口——
**没有任何代码把这份图编译成可重放的 recipe**。

同时 replay 侧有两个与这条链路无关、但同样真实的缺陷：`validate` 用旧 runner（验的不是线上那条路）、
`repair` 按裸 `sourceId` 记账（共享 detail 漂移记错源）。而 `record translate` 那条链路吃的是
CloakBrowser 时代 `explore` 子命令的产物，今天无任何产出方。

**本 change 的形态**：用户确认的最终形态是**混合式**——有明确路径就走它，历史里没有才带图选路。
当下能交付的是前一半（编译 + 优先级），后一半（运行期图选路）作为同 change 的第二阶段。

## Goals / Non-Goals

**Goals:**

- 让探索的产出**变成可重放的东西**：`ExploreDraft` → canonical Recipe，产物直接过 `validateRecipe`。
- 定死**混合取路顺序**：静态 Recipe 优先，图为 fallback；优先级判据与 Repair 账本键**同源**。
- 让 `validate` 与线上 `replay` **共用同一个 runner**。
- 让 `repair` 的失败单元从 Source 改为 Recipe，共享 recipe 漂移时**所有受影响 Source 一起标出**。
- **退役** `translate` 那条已无产出方的死路。

**Non-Goals:**

- **不做采集 recipe 的自动生成。** 探索图不含 observers；采集仍走手工抓包。
  编译产物服务**动作 recipe**。
- 不改 canonical Recipe 的 schema。
- 不改 `RecipeRunner` 的执行语义。
- 不重写探索建图本身。
- 不做 AI 自动改写 recipe。

## Decisions

### D1. 编译成静态 Recipe，而不是让运行期直接读图

**选择**：探索完把图编译成一份静态 recipe 落盘；运行期只跑 recipe。

**为什么**：符合本仓对 recipe 的定义——**固化的可执行数据**，运行期不经模型、不依赖别的文件。
让运行期直接读一份会被后续探索改写的草稿，等于把「跑到一半图变了」这种状态引进运行语义。

**替代方案**：运行期直接带图选路。**否掉作为主路**，但**保留为 fallback**（见 D2）——
用户在「历史里没有记录」时确实需要它。

### D2. 混合取路顺序：静态 Recipe 优先，图为 fallback

**选择**：有对应 recipe → 走它；没有 → 带图选路。这是用户确认的最终形态。

**为什么**：「有明确路径就只走它」保住快路径的全部好处（零 token、行为确定、可被账本记账）；
而「没录过就带图选路」让系统在陌生目标上仍能前进，而不是直接失败。

**关键约束**：判「是否存在对应 Recipe」的键 SHALL 与 Repair 账本键同源（`facility + recipeId`）。
两份判据分家的后果是「账本说有、路由说没有」这类**两边单看都正常**的错位。

### D3. 编译不生成 observers

**选择**：编译只产 `steps` + `session`，**不产 observers**；缺的部分显式缺席，不填默认值。

**为什么**：探索记录的是「怎么走 + 怎么认状态」（`recordAct` 造的 steps 只有 click；
`ObservationLedger` 记的特征真值是喂区分度闸的），**不含数据提取**。凭空生成 observers 会产出
一份「跑得通但永远 0 条」的采集 recipe——而那种失败是安静的。

**替代方案**：让编译尽量猜 observers。**否掉**——与本仓「缺席时补一个默认值就是在擦掉痕迹」
那条既有不变量直接冲突。

### D4. validate 与 replay 共用 `RecipeRunner`

**选择**：`validate.ts` 从 `runBrowserRecipe` 改为 `RecipeRunner`，`onWall` 作为 hook；
旧形 Recipe 经 `canonicalizeBrowserRecipe` 显式翻译后进同一个 runner。

**为什么**：这是本 change 里最坏的静默缺陷——「验过了」验的和线上跑的不是同一个解释器，
它会通过，然后线上以别的方式失败。共用之后「验证通过」与「线上能跑」才是同一句话。

**代价**：validate 报告改用 canonical outcome 词汇，读报告的人要重新认一遍词（同批更新文档）。

### D5. Repair 键改为 `facility + recipeId + version`

**选择**：key 换掉裸 `sourceId`；`RepairState` 增 `affectedSources`，**方向是「用的人申报」**
（`SourceManifest.uses` / recipe 侧 `meta.uses`），查询侧两端经四级解析归一成全名。

**为什么**：一份 private detail Recipe 今天被 Home 与 Search 共用。按 sourceId 记账时，
一次漂移只会记在**碰巧先失败的那个源**头上，另一个继续被判健康——而**没有任何一处会喊**。

### D6. 退役 `translate`

**选择**：移除 `record translate` 与 `latestExplorePath`、browser-use history 解析。

**为什么**：它吃 `explore-*.json` + `.xhr.json`，而产出那两个文件的 `explore` 子命令
2026-07-28 已退役（`cli.ts:8-13` 自陈、`cli.test.ts:25-28` 断言它已是 `Unknown command`）。
**保留一条输入已无产出方的链路，只会让下一个人以为那条路还活着**——正是本仓反复记过的
「注释/文档把死路说成设计意图」。

### D7. 第二阶段复用已有机制，不新开一条

**选择**：运行期图选路复用**已有的三层状态图装配**（内置全局 ∪ 包自带 `states.json` ∪
本机学到的那层），把「图认状态」扩成「图导航」。

**为什么**：状态图**本来就已经是运行期输入**（`expect` 落空时 runner 拿它认状态、选逃生口）。
新开一条平行的读图路径会造成两份装配、两次解析、两个失效点。

## Risks / Trade-offs

- **[编译产物没有 observers，被误当成采集 recipe]** → 症状是「跑通但 0 条」，与「确实没搜到」无法区分。
  缓解：D3 把缺失做成显式；proposal 的 Non-Goals 写死采集不在范围；`write-recipe` skill 同步说明。
- **[图为 fallback 时会变]** → 后续探索会改写同一份图。缓解：读快照；`writeDraft` 已是 tmp+rename，
  需确认读取侧同样成立（tasks 6.3）。
- **[退役 `translate` 是 breaking]** → 缓解：它今天的输入已无产出方；在 proposal 标 **BREAKING** 并写明理由。
- **[存量台账迁移不许留空]** → 旧形按 sourceId 的记录读入还是丢弃，必须给结论（tasks 3.9）。
  留空的表现是升级后历史漂移记录**静默消失**。
- **[真机验收不能用单测替代]** → tasks 5.3 的「探一条新路径 → 编译 → 上线跑通」是本阶段唯一的端到端判据；
  单测证明不了「编译产物在真页面上跑得起来」。
- **[优先级判据与账本键漂移]** → 两处判据分家是静默错位。缓解：tasks 2.3 要求两者**共用同一处定义**并有测试钉住。

## Migration Plan

1. **编译**（组 1）：新增编译入口；先让它能过 `validateRecipe`，再谈接入。
2. **优先级**（组 2）：定义判据键并**与 repair 账本键同源**；再接运行侧取路顺序。
3. **replay 两个真问题**（组 3）：validate 换 runner（先接 `canonicalizeBrowserRecipe` 的生产调用方，
   再切 validate）；repair 换键与存量迁移**同批**，不留半迁移状态。
4. **退役 translate**（组 4）：确认无其他调用方后移除。
5. **文档与验收**（组 5）。
6. **第二阶段**（组 6）：运行期图选路。可与 1–5 并行设计，但**不阻塞**其交付。

**回滚**：除退役组外全部是增量改动，回滚 = revert 本次提交；退役组回滚需恢复 `translate.ts` 与 CLI 分支。

## Open Questions

- **tasks 3.4**：`runBrowserRecipe` 在 `src/adapters/replay/adapter.ts:323` 的调用方是否还需要？
  需要则写明为什么——这是 D4 落地前必须回答的。
- **tasks 3.9**：存量台账按 sourceId 的记录读入还是丢弃？代价分别是什么？
- **第二阶段的收口**：组 6 在本 change 内完成，还是留到下一个 change？本设计按「同 change 第二阶段」写，
  但它的验收判据（6.4）与第一阶段（5.3）不同层，若第一阶段先交付，需要明确第二阶段的独立验收。
