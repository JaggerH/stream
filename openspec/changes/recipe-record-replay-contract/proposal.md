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
