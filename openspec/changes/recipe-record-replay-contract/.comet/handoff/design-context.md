# Comet Design Handoff

- Change: recipe-record-replay-contract
- Phase: design
- Mode: compact
- Context hash: 85c3956f04fe8f063a2d18f9ec57ce3e2accd01f07718082260a1f2d9f597cfb

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/recipe-record-replay-contract/proposal.md

- Source: openspec/changes/recipe-record-replay-contract/proposal.md
- Lines: 1-76
- SHA256: ebb81fae39345689aa571787412831a091315a5ab9fd9d34abf354245fc953ba

```md
## Why

Stream 的采集与动作都靠 **recipe**——一份固化的可执行数据，运行期由本机调度器重放，**不经模型、不花 token**。
而写 recipe 今天靠手工：抓包 + 对照模板手写。

「AI 探一遍就自动生成 recipe」这条自动化，**在 2026-09-12 的探索建图落地之后只差最后一跳**：

- `src/intervention/explore-*` 已经能用 **CDP 扩展驱动活页面**，把途中的状态与边记成 `ExploreDraft`
  （`states[] + transitions[]`），每条边带一个由 `stableSelector()` 保证**运行期可重放**的选择器；
- 但它**没有变成 recipe**。`readDraft` 的全部调用方只有探索会话自己和 `serve.ts:852` 的一个 API 出口——
  **没有任何代码把这份草稿图编译成可重放的东西**。探完就停在那儿。

本 change 补上这一跳，并把运行模型定成**混合式**：**有明确路径就走它，历史里没有才带图选路。**

> **名字说明**：本 change 目录名里的 "record" 指的是 **2026-07-28 已退役**的那条路
> （CloakBrowser 时代的 `record explore` 子命令）。改名要动 `.comet.yaml` 与 handoff hash，
> 本次不改；以本文件的描述为准。

同时修两件与这条链路无关、但同样是 replay 侧的真问题：

- **`validate` 验的不是线上那条路**：`src/replay/author/validate.ts:79` 调旧 runner
  `runBrowserRecipe`，而线上跑的是 `RecipeRunner`。它会通过，然后线上以别的方式失败。
- **`repair` 记错源**：`src/replay/repair-ledger.ts` 的键是裸 `sourceId`，而一份 private detail
  Recipe 被多个语义 Source 共用（`packages/xhs/xhs-detail.recipe.json` 被 Home 与 Search 共用）。
  它漂了，账只记在**碰巧先失败的那个源**头上，其余继续被判健康。

并**退役一条死路**：`record translate` / `latestExplorePath` 吃的是 `explore-*.json` + `.xhr.json`，
而那个 `explore` 子命令已随「Stream 改成骑用户自己的 Chrome」退役
（`src/replay/author/cli.ts:8-13` 自陈；`cli.test.ts:25-28` 断言它已是 `Unknown command`）。
**今天没有任何东西会产出那两个文件。**

## What Changes

- **探索图 → 静态 recipe 编译**：从 `ExploreDraft` 选一条路径（`start` → 目标的最短路径），把路径上
  每条 transition 的 `steps`（今天是 `[{do:'click', selector}]`）串成 recipe 的 `steps[]`，
  补 `session`（facility / visibility）。产物走现有 recipe 装载路径。
- **混合运行优先级**：有明确 recipe → 走它；没有 → 图选路。判「有没有」的键 SHALL 与 repair 账本键同源。
- **`validate` 与 `replay` 共用 `RecipeRunner`**：两者只在 visibility 与 `onWall` hook 上不同。
  旧形 Recipe 经 `canonicalizeBrowserRecipe` 显式翻译后进同一个 runner。
- **`repair` 改按 `facility + recipeId + version` 记账**，状态里记 `affectedSources`。
- **退役 `translate` 死路**（**BREAKING**：`record translate` 及其 browser-use history 输入格式被移除；
  该路径的输入今天已无产出方）。
- **第二阶段（同 change，不阻塞第一阶段交付）**：运行期带图选路——复用已有的三层状态图装配，
  把「图认状态」扩成「图导航」。

## Capabilities

### Modified Capabilities

- `browser-recipe-replay`：编写侧从「手工 / 已退役的 translate 链路」改为**由探索图编译**；
  运行侧在 replay 之前增加一层**混合优先级**（静态 recipe 优先，图为 fallback）；
  Validate 与 Replay 收敛到同一个 runner；Repair 的失败单元从 Source 改为 Recipe。

## Non-Goals

- **不做采集 recipe 的自动生成。** 探索图记的是「怎么走 + 怎么认状态」，**没有 observers**
  （`explore-graph.ts:91` 的 transition steps 只有 click）。采集靠 observers 读数据，那一层
  探索根本没记——**采集 recipe 仍走手工抓包**（`write-recipe` skill 的 `references/capturing.md`）。
  编译产出的 recipe 首先服务**动作 recipe**（发消息、下单）。
- **不改 canonical Recipe 的 schema 本身**（`session + steps + observers + output + policy` 不变）。
- **不改 `RecipeRunner` 的执行语义**；本 change 只改「recipe 从哪来、谁验它、失败怎么记账、
  以及没有静态 recipe 时怎么走」。
- **不重写探索建图本身**（`src/intervention/explore-*` 的状态记录与 frontier 逻辑不动）。
- **不做 AI 自动改写 recipe**（`RepairRunner` 的那一半）。
- **不删旧 `actions + harvest` 的装载兼容**——存量 recipe 照旧能装。

## Impact

- `src/intervention/explore-graph.ts`（新增编译入口，或新增同级模块 `explore-compile.ts`）。
- `src/replay/recipe-canonical.ts`（接上生产调用方）。
- `src/replay/author/validate.ts`（改用 `RecipeRunner`）。
- `src/replay/repair-ledger.ts`、`src/replay/repair-runner.ts`，以及读它的
  `src/adapters/replay/adapter.ts`。
- `src/replay/author/translate.ts`、`src/replay/author/cli.ts`（退役）。
- 运行侧入口：`src/replay/recipe-runner.ts` 或其调用方（第二阶段的混合优先级）。
- 文档：`write-recipe` skill 的 authoring 一节与 `record` CLI 的输出术语。
```

## openspec/changes/recipe-record-replay-contract/design.md

- Source: openspec/changes/recipe-record-replay-contract/design.md
- Lines: 1-138
- SHA256: 7ca57fe55ea1dbb4049f53958bd28aaf5300ca7151487fb918ef6a1846086e3e

[TRUNCATED]

```md
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
```

Full source: openspec/changes/recipe-record-replay-contract/design.md

## openspec/changes/recipe-record-replay-contract/tasks.md

- Source: openspec/changes/recipe-record-replay-contract/tasks.md
- Lines: 1-51
- SHA256: bfcbbd9dc8520fbf683ddca9acbcab5c01accf0d22777befd7f7931230e8faa4

```md
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
```

## openspec/changes/recipe-record-replay-contract/specs/browser-recipe-replay/spec.md

- Source: openspec/changes/recipe-record-replay-contract/specs/browser-recipe-replay/spec.md
- Lines: 1-100
- SHA256: 573923efec489047ff483e0b4d9cc76447266f0b2b3a8c2f147faebb515f5586

[TRUNCATED]

```md
## REMOVED Requirements

### Requirement: Record and Replay 使用同一 Recipe 契约
**Reason**: 它的 "Record" 指的是 CloakBrowser 时代的 `record explore` / `translate` 链路——
那个子命令于 2026-07-28 随「Stream 改成骑用户自己的 Chrome」退役，`explore-*.json` 与 `.xhr.json`
今天没有任何产出方。围绕 browser-use history 与 UNTRANSLATED 的场景随之失效。
**Migration**: 编写侧改由**探索图编译**承接（见新增要求「探索图编译成可重放的 Recipe」）；
其中仍然成立的那条——Validate 与 Replay 必须共用同一个 runner——由新增要求
「Validate 与 Replay 共用同一个 runner」原样承接，判据不变。

## ADDED Requirements

### Requirement: 探索图编译成可重放的 Recipe

系统 SHALL 能把一次探索产出的草稿图（`ExploreDraft`：`states[] + transitions[]`）编译成一份
**canonical Recipe**，使「AI 探一遍」的结果直接成为可重放的东西，而不是停在草稿文件里。

编译 SHALL 在 `transitions` 上求一条从 `draft.start` 到目标状态的路径，并把该路径上每条 transition
的 `steps` 按序串成 Recipe 的 `steps[]`。编译产物 SHALL 直接通过 `validateRecipe`，
SHALL NOT 需要人手改写成 steps 才跑得起来。

系统 SHALL NOT 在本能力里生成 `observers`：探索记录的是「怎么走」与「怎么认状态」，
**不含数据提取**。因此编译产物服务的是**动作类** Recipe；采集类 Recipe 不在本能力范围。

#### Scenario: 从草稿图编译出可重放的 Recipe

- **WHEN** 对一份含 `start` 且目标状态可达的草稿图发起编译
- **THEN** 产出是一份通过 `validateRecipe` 的 canonical Recipe，其 `steps[]` 与所选路径逐条对应，
  且无需人手改写即可交给运行侧

#### Scenario: 不可达时明说，不产出空 Recipe

- **WHEN** 草稿图里目标状态没有任何 transition 路径可达（或 `start` 缺失）
- **THEN** 编译以明确的结论失败并指出原因，SHALL NOT 产出一份 steps 为空的 Recipe

#### Scenario: 不生成 observers

- **WHEN** 编译一份草稿图
- **THEN** 产物 SHALL NOT 含凭空生成的 observers；若该 Recipe 需要采集，缺失是显式的而不是被默认值填上的

### Requirement: 混合运行优先级：静态 Recipe 优先，图为 fallback

运行侧 SHALL 采用混合的取路顺序：**存在与该目标对应的明确 Recipe 时只走那份 Recipe**；
只有在历史里没有对应记录时，才转为**带图选路**（按状态图在运行期选择下一步）。

判「是否存在对应 Recipe」的键 SHALL 与 Repair 的账本键同源（`facility + recipeId`）。
两份判据分家的后果是「账本说这个源有 Recipe、路由说没有」这类**两边单看都正常**的错位。

#### Scenario: 有明确 Recipe 时只走它

- **WHEN** 目标对应一份已装载的 Recipe
- **THEN** 运行侧直接重放该 Recipe，不进入图选路

#### Scenario: 没有记录时带图选路

- **WHEN** 历史里没有任何与该目标对应的 Recipe，但本机有该 facility 的状态图
- **THEN** 运行侧按状态图选择下一步，而不是直接失败

#### Scenario: 优先级判据与账本键同源

- **WHEN** 改动「是否存在对应 Recipe」的判据键
- **THEN** 存在一条测试因 Repair 账本键与它不一致而变红

### Requirement: Validate 与 Replay 共用同一个 runner

Validate 与 Replay SHALL 使用同一个正式 runner（`RecipeRunner`），两者 SHALL 只在 visibility 与
`onWall` hook 上不同，SHALL NOT 各自持有一套解释器——用另一个解释器验过的 Recipe，
「验证通过」说的不是线上会发生什么。

旧 `actions + harvest` 形状的 Recipe SHALL 在进入 runner 之前被**显式翻译**成 canonical 形状，
翻译结果 SHALL 与手写的 canonical Recipe 走完全相同的执行路径。

#### Scenario: 同一份旧形 Recipe 两条路同一个结论

- **WHEN** 同一份旧 `actions + harvest` Recipe 分别经 validate 与经线上 replay
- **THEN** 两者得到同一个 outcome

#### Scenario: 旧形 Recipe 走同一条路

- **WHEN** validate 或 replay 拿到一份旧形 Recipe
```

Full source: openspec/changes/recipe-record-replay-contract/specs/browser-recipe-replay/spec.md

