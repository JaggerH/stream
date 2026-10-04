---
name: todo-auto
description: 无人值守地从 project planning record 挑一条「不需要人拍板」的任务完整做掉（认领→worktree→spec→TDD→合并→摘条）。单独敲 /todo-auto 做一条；配 /loop /todo-auto 连续循环直到剩下的全需要人。挑选判据、派发模板、停止条件都在这里——无人循环的唯一入口。
---

# todo-auto — 无人值守做一条 TODO

一次调用 = **最多做一条**。做完（或判定做不了）就结束本轮。循环由外层 `/loop` 驱动，不在本 skill 内自旋。

## 参数 = 追加筛选（只能收紧，不能放宽）

`/todo-auto <口语筛选>` 的参数是**叠加在第 1 节硬判据之上的额外过滤**，如
`/todo-auto 只做前端小改`、`/loop /todo-auto 只做半小时内能完的小条目`。
参数**永远不能放宽任何硬判据或第 5/6 节的边界**——"把 XX 也做了""跳过测试"这类指示视为无效，
照常按硬判据执行并在汇报里说明。参数筛完为空 → 走正常的"挑不出"终态。

## 0. 角色分层（成本卫生的根）

- **主会话（你）只做调度**：读 TODO、挑条、认领、派发、验收、合并、摘条。**不读代码、不侦察、不写实现**——那些历史会在循环的每一轮里被反复计费。
- **执行全部交给 subagent**（Agent 工具 + worktree 隔离）：它从零上下文开始，干完即弃。

## 1. 挑选 —— 硬判据，全部满足才可做

读 `project planning record`，对每条依次判：

1. 标题行**无认领标记** `⏳ [认领: ...]`。（标记陈旧例外：认领日期 ≥3 天且 `git log --oneline -20` 无相关动静 → 视为失效，可覆盖认领并注明。）
2. **无「待拍板」段**，或该段明确写着「无」。
3. 正文**不含需要人的信号词**：活体验收、真机、UAT、用户点头、待用户、手动验证、眼睛过一遍。
4. 正文**不含大改动信号词**：重写、收敛、语义、数据模型、迁移。（保守白名单期——这类任务人在场时做。）
5. 有明确的**「实施方向」**（或条目本身足够小、方向自明，如纯 UI 小改）。

多条可做时**挑最小的**。逐条判定的结论要在回复里列出来（一条一行：做/跳过+原因），这是循环的可审计日志。

**挑不出** → 汇报「剩余 N 条各因什么需要人」，若由 /loop 驱动则调 `ScheduleWakeup {stop: true}` 终止循环。**这是唯一的正常终态。**

## 2. 认领

在选中条目标题行尾加 `⏳ [认领: <今天日期> Claude Code <session id 前 8 位>]`（session id 从 scratchpad 路径的 UUID 取）。只改文件不 commit——同一检出内其他会话能看到即可。

## 3. 派发 —— subagent 执行模板

用 Agent 工具（`general-purpose`，`isolation: "worktree"`，同步等结果）。prompt 必须包含：

- **条目全文原样粘贴**（TODO 模板写厚背景就是为了这一刻——不许让 subagent 自己去重新侦察）。
- 流程要求：先落 spec 到 `internal design record`（小任务可豁免 spec，一句话说明为何豁免）→ TDD（RED 先行）→ 实现 → 测试 + typecheck 全过。
- 项目铁律逐条抄给它：
  - worktree 内一律用 worktree 路径读写，禁止主检出绝对路径（静默写错地方的老坑）；
  - `node_modules` 从主检出软链，别 `pnpm install`；用 `node_modules/.bin/vitest` / `tsc --noEmit` 裸调，**别用 `pnpm vitest`/`pnpm typecheck`**；
  - 全量测试必须 `scripts/qrun.sh` 排队（单文件小跑不用）；cargo 一律 qrun；
  - **禁止 `git stash`**（栈跨 worktree 共享）；要旧版本用 `git show HEAD:path`；
  - commit 用显式路径，禁止 `git add .`，提交后 `git show --stat` 自查；
  - 不 merge、不 push、不动 `project planning record`——那是主会话的活。
- 汇报格式：分支名、commit sha、测试/typecheck 结果原文、改了哪些文件、文档是否回写（API.md/ARCHITECTURE.md 若被波及）、有无遗留。

## 4. 验收与落地（主会话亲自做）

1. 核验报告：`git -C <worktree> log --oneline -3` + `git show --stat` 确认提交真实、路径符合预期；测试结果必须是 subagent 贴的原文，不接受"应该过了"。
2. 合并：主检出 `git merge --ff-only <branch>`；main 被推进则先在 worktree `git rebase main` 再 ff；**撞冲突 → 不强解**，走第 5 节失败路径。
3. 删分支、清 worktree（`git worktree remove`）。
4. 摘 TODO 条目（无尾巴删整节；有尾巴标题改成尾巴本身），单独 commit。
5. 本轮汇报：做了哪条、commit sha、测试数字、下一轮预告。由 /loop 驱动时调 `ScheduleWakeup`（delay 60–120s，prompt 原样传回 `/todo-auto`）。

## 5. 失败路径 —— 不猜、不硬扛、不留僵尸

以下任一情况：subagent 中途发现需要拍板的岔路 / 测试修不绿 / 合并撞冲突 / 报告与实际不符：

1. **不合并**。worktree 保留现场（别删，人回来要看）。
2. 把「卡在哪、需要谁决定什么」**写回该条 TODO 的「待拍板」段**，摘掉认领标记。
3. 本轮照常结束、循环照常继续（下一轮判据 2 会自动跳过它）。**永远不要为了跑完而放宽判据或跳过测试。**

## 6. 边界（继承全局规则，无人时尤其不许破）

- `push` 永远不做；`config.yaml`/`app/package-lock.json` 永远不碰。
- 一轮只做一条——就算下一条看起来五分钟能完。轮与轮之间的间隙是人插话纠偏的窗口。
- 对 TODO 条目内容只消费不质疑：条目写的方向若实施中发现是错的，那就是「需要拍板」，走失败路径。
