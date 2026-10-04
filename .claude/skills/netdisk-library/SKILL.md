---
name: netdisk-library
description: Use when the user wants episodes of a show filled in from netdisk shares ("这部剧给我补齐"、"第三季缺几集"、"开追更"), or wants a netdisk folder sorted into seasons ("把这个目录整理好"、"整理一下我夸克里那堆"), or asks why one episode was not recognised ("这一集怎么没认出来"). Not for changing the matcher's code — that is diagnose-netdisk-match.
---

# 影视网盘：找片 / 追更 / 归档（netdisk-library）

## 一句话

**路线归代码，你只站三个窄口。** 找缺集、验分享、转存、按季归位、加 `SxxExx - ` 前缀、把纯享搬走——
整条都在后端的追更循环（`FollowService`）和归档器（reconcile）里跑完，回执就是结论。你做的只有：
把用户的话变成一个 setId 加一个动作、把回执讲成人话、在**动手之前**把要发生的事说清楚。

为什么不自己组装：这条线上每一个动作都**真的动用户盘上的文件**——转存会写、归档会搬会改名、
`losers:true` 会把落选副本删进回收站。自己拼一套「搜到就转、看着像就删」，错了不是"不完整"，
是**盘上少了一集**，而删除是这里唯一走不回来的动作（`reconcile_undo_run` 撤得回搬和改名，撤不回删）。

## 触发与不触发

| 用户在做什么 | 做法 |
|---|---|
| "这部剧给我补齐" / "看看第三季缺几集" | `netdisk_bindings` 找 setId → `netdisk_follow view`。**缺集为空就停**，别去搜 |
| "开追更" / "以后自动补" | `netdisk_follow enable`；要立刻跑一轮先说清它会写盘，再 `run` |
| "把这个目录整理好" / "认领一下这堆文件" | `reconcile_status` 先看（binding 形式或 show），逐条核将删清单，再 `reconcile_execute` |
| "这一集怎么没认出来" | `netdisk_sync` 看 `bySeason` 的 `missing` → `netdisk_residue` 看是哪一侧没对上 → 必要时 `netdisk_preview_spec` 试规则 |
| 整季从 E02 起整体错位、或跨季判成同一集 | **不是改文件名**，是匹配器的判据错了 → `diagnose-netdisk-match` skill（改代码 + 补回归） |
| "这个目录里的东西归到某档节目下" 而 `reconcile_status` 里还没有这档节目 | `reconcile_open`（一次原子建好货架 + 绑定 + 下架源，别自己拼） |
| 想听一下某个文件到底是不是那一集 | `netdisk_transcribe`（头尾各两分钟的转写），然后 `reconcile_decide` |

落地细节两份：**找片 / 追更** → [references/find-and-follow.md](references/find-and-follow.md)；
**归档 / 整理 / 撤销 / 纯享** → [references/archive.md](references/archive.md)。

## 三条硬规则

<!-- persona:start -->
Netdisk TV library (追更 / 归档): the loop that fills in missing episodes and files them into season folders runs in the backend, not in your head. Find the binding with netdisk_bindings, then netdisk_follow with action 'view' — `missingAired` is the number that matters, and when it is empty you are DONE, do not go searching. Three rules that override anything else you might infer. (1) NEVER call reconcile_execute without reading a reconcile_status preview for that same show or binding first, and never report the preview's `counts` as things that already happened — nothing has moved until execute. (2) Before reconcile_execute, walk `plannedDeletes[]` entry by entry and check `path` and `keptPath` really are the same episode: two copies of one episode have EXACTLY equal durations, so `durationS !== keptDurationS` means stop and ask the user, and so does `keptSizeBytes < sizeBytes` (keeping the smaller file) or a missing/mismatched `episode`; `basis` on each entry says why the planner picked the keeper. A delete is the one action nothing walks back, and `plannedDeletesTruncated:true` means you are not holding the whole list — page through the rest by calling reconcile_status again with `deletesOffset` (50 per page, `plannedDeletesTotal` is the total), or say you did not finish checking; never claim you checked it. Pass the preview's `planFingerprint` to reconcile_execute as `expectFingerprint` so the plan you checked is the plan that runs. (3) netdisk_follow with action 'run' TRANSFERS files into the user's netdisk and then archives with losers deleted into the netdisk trash — tell the user what it will do and get their agreement BEFORE calling it; it returns immediately, so do not poll and never send a second `run`: wait about two minutes, call `view` ONCE, and read `lastRuns[0]`. After any execute that renamed files, call reconcile_status again before you trust or report the tree, and after files moved call netdisk_sync before you quote coverage numbers — quote its `bySeason` figures, never a count you did yourself.
<!-- persona:end -->

**为什么是这三条，而不是别的**：

1. **先 `reconcile_status` 再 `reconcile_execute`。** 预览里的 `counts` 全是**计划**，一个都还没发生。
   把它们讲成"已移动"，用户会以为完事了；而真正的执行还等着他点头。
2. **将删清单逐条核。** 删是唯一撤不回来的动作。回执把每条删除摊成 `{path 消失的那份, keptPath 留下的那份}`
   并带上两侧的时长与体积，正是为了让你核"这两份真是同一集"——判据是**两侧 `durationS` 精确相等**
   （详见 [references/archive.md](references/archive.md) §2）。一条判据要是指着回执里没有的字段，
   它就不是判据，只能被假装核过。
3. **`run` 之前先说、之后只 `view` 一次。** 它是写操作（转存 + `losers:true` 归档）。而且它立刻返回，
   回执只说"这一轮开始了"，不说结果——盯着轮询只会烧 token，重发第二次 `run` 也不会更快
   （在飞的那轮会回 `{started:false, alreadyRunning:true}`）。

## 工具不在手边时：停下来说，不要手搓

两档，症状不同、处理不同，但都不许退回手工搬文件。

### 工具在，但调用被权限层拒绝

回执里出现 `Permission … denied` / `Blocked by classifier` 这类字样（而不是 `Tool not found`），
就是**宿主不让调这个写操作**。这不是清单过期，**重连没用**。

处理：**停下来告诉用户要给这个工具放行**，并把**已经核完的结论一并交出去**——预览的四个数字、
将删清单逐条核对的结果、还剩哪几张待定卡。他点头放行之后你一次就能跑完。
**不要**退回"自己搜一条链接让用户手动转存"。

### 工具压根不在清单里

`netdisk_follow` / `netdisk_share_verify` 不在工具列表里（或调用回 `Tool not found`），几乎总是
**宿主的 MCP 工具清单过期了**——它在会话开始时拍了一次快照，后端后来加的工具进不来。
判据：**`netdisk_bindings` 正常而 `netdisk_follow` 缺席**（两个来自同一个后端能力，一个在、一个不在，
只能是快照的问题，不是能力没装）。处理：**告诉用户"工具清单过期，请重连 MCP（Claude Code 里 `/mcp`）
或重开会话"，然后停。**

**不要**退回"自己 `video_search` 一把、挑一条链接、让用户手动转存"——那绕开了验活、绕开了"这条分享
里到底有没有缺的那几集"的计算，也绕开了转存之后的归位。给出一条死链接比不给更浪费用户的时间。

## 验它照做（人肉验收）

判据只看副作用，四条。给一段用户话，看会话里真实的工具调用序列：

| 用户说 | 期望的序列 |
|---|---|
| "《XX》第三季给我补齐" | `netdisk_bindings` → `netdisk_follow view`；**缺集为空就到此为止**，答案里给出 `missingAired` 的数字 |
| "开追更并且现在就跑一轮" | `netdisk_follow view` → 一段"它会转存并删落选副本"的告知 → `enable` → `run` → 约两分钟后 `view` **一次** |
| "把 tv-12345 这个目录整理好" | `reconcile_status {show:'binding:<setId>'}` → 截断了就带 `deletesOffset` 再调直到翻完 → 答案里逐条讲 `plannedDeletes[]` → `reconcile_execute` 带上 `expectFingerprint` |
| "整理完了，现在有几集" | `netdisk_sync` → 引用它的 `bySeason`，不是自己数的 |

五条红线（出现任何一条就是没照做）：执行前没有预览；答案把预览的 `counts` 说成已完成；
将删清单截断了却没翻页、还声称核过；`run` 之前没有告知；报的集数不是 `netdisk_sync` 给的。

## 活体里撞过的错（都修在代码里了，这里是为了认出复发）

- **跨季同期号判成同一集**：第 2 季和第 3 季都有「第7期」，一锅裁决把它们判成同一集，一轮预览
  128 行里 52 行跨季错判（21 条 replace + 2 条 delete-loser）。已修：归档器和同步走同一条季分区路
  （先按叶子文件夹定季，再每季单独匹配）。**复发的判据**：预览里出现 `keptPath` 与 `path` 分属两个
  不同季目录的删除/替换行。
- **前缀刻错了号**：`第N期` 被当成 `E<N>`，而 TMDb 那一季一期拆成多集（「上/下」或「（一）（二）」），
  于是前缀从 E02 起集体错位，且**前缀一刻上去就成了下一轮的证据**。撞过两次：上/下那种修了，括号段号
  那种又漏了一回（13 条刻错、五轮全撤重跑）。已修：两种标题下裸期号都不认；归档器刻前缀前另核一遍
  「文件名的第N期 = 清单这一集的第M期」，不等就出卡。**复发的判据**：`S0x/` 里 `SxxEyy - …第N期…`
  的 N 与这一集 TMDb 标题的期号对不上——执行完顺手扫一遍（scratchpad 的 `check-prefix.mjs` 那种：
  逐条比文件名期号 vs `leftTitle` 期号），不要只核删除清单。**搬运和改名不是"总能搬回来"就无害**。
- **纯享被当成落选副本删**：加完前缀之后「名字与集标题一致」这一档恒站在正主那边，于是
  「第1期纯享版」被判成第 1 期的落选副本，一轮 10 条。已修：带「纯享」的文件顶掉落选副本那一路，
  直接进 `纯享/S<nn>/` 货架；同集两份时长差出容差时出对照卡，不自动删。
  **复发的判据**：`plannedDeletes[]` 里 `path` 含「纯享」「加更」「花絮」「top10」而 `kind` 是
  `delete-loser` 或 `replace`。
- **追更转存进来的目录判不出季**：分享目录名是乱码、只装最近几期（文件数对不上任何一季），LLM 兜底拿到的
  上下文是空的，答 null 还被永久缓存，整批卡成 `season-unresolved`。已修：文件名里的日期落进哪一季的
  播出区间就是哪一季，排在缓存之前。**复发的判据**：`season-unresolved` 卡的文件名带日期而那一季的
  TMDb 集有 airDate——那是代码没跟上，不是让用户改目录名。
- **体量压过了名字**：判谁是正主时体积档排在名字档前面，一个体积更大的合集压掉了名字精确对上的
  那一集。已修：名字精确匹配优先于体量。**复发的判据**：留下的那份文件名和集标题对不上，
  而它只是"更大"。

## 边界

- 没有 Stream 后端就没有这条线：绑定、匹配引擎、归档器、追更循环都是它的能力，skill 里没有替代品。
  **认盘**那四个动词（验分享 / 转存 / 直链 / 跳转）也要 Stream：它们来自可选能力包
  `@streamapp/netdisk`，`stream add @streamapp/netdisk` 装进后端、重载后出现在同一行 MCP 里。
  登录态由后端在同一个进程里递给它，不用另装什么。
- `netdisk_share_verify` **只支持夸克**；别的网盘回 `validity:'unsupported'`，那**不是**死链，如实说
  "这个我们查不了，你可以自己打开看看"。百度/阿里的链接我们也不转存。
- 匹配器本身的判据（五档 stage、三个门槛）不归这里：读 `docs/MATCHING.md`，改它走 `diagnose-netdisk-match`。
- 追更循环内部的每一步（回访 → 搜新源 → 转存 → 同步 → 归档 → 通知）见 `docs/ARCHITECTURE.md`
  「追更循环」一节；**绝不**手工去调 `executeBinding` 那一层绕开它。
