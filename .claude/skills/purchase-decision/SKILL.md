---
name: purchase-decision
description: Use when the user is choosing WHAT to buy — a category, a budget, maybe a few things they care about ("买个内存条", "5000 以内拍照好的手机") — or asks which of several models is worth it, or comes back to change a condition (预算 / 用多久 / 转不转手) after a result. Not for a bare price check on one named model.
---

# 购买决策（purchase-decision）

## 一句话

**路线归代码，你只站三个窄口。** 整条决策——枚举全集 → 读横评看谁被点名 → 逐台比价 → 支配运算（斩杀线）——
在 Stream 后端的 `purchase_decide` 里跑完，回执就是终稿。你做的只有：把用户的话变成参数、把回执讲成人话、
在结果之后问那一个真会改变结论的问题。

为什么不自己组装：手工从搜索结果里凑候选、再自己排名，**最常被跳过的是枚举那一步**，而在一个碰巧读到的
子集上算"谁被谁斩"，结论不是"不完整"而是**误导**——"已排除 X"照样自信地印出去。

## 触发与不触发

| 用户在做什么 | 做法 |
|---|---|
| 选"买什么"（品类 + 预算 ± 在乎的点） | 立刻调 `purchase_decide` |
| 问"A 和 B 哪个值" | 同上，品类取它们共同的品类，让回执里的支配关系回答 |
| 结果之后改口（预算变了 / 会转手了 / 换个在乎的点） | **换参数重跑**，不要手改上一张表 |
| 只想知道某一台现在多少钱 | `price_search` 直查，不走这条 |
| 消耗品、一次性支出 | 也走 `purchase_decide`（`willResell:false`，`holdDays` 取用完的天数） |

## 第一步：先跑，不先问

<!-- persona:start -->
Purchase requests: when the user is choosing WHAT to buy (a category, a budget, maybe a few things they care about — "买个内存条", "5000 以内的手机"), call purchase_decide IMMEDIATELY with what they gave; do not interview them first and do not search with the vague words yourself. Only `category` is required — softCriteria default to [] (rank on price alone), holdDays to 730, willResell to false — and the receipt itself reports what was assumed or missing. It is ASYNC: it returns {runId} at once and the job takes 2–3 minutes; poll get_agent_run(runId) every 20–30 seconds (it reports the current stage), never start a second run for the same question, and when status is done read `receipt`. The receipt is the final deliverable: narrate it (frontier, what got ruled out and by whom, the coverage numbers, what was assumed or missing), do not re-enter it into any other tool, and never name a model that is not in it. Ask a follow-up only after showing the result, and only if the receipt says the missing input would change it. If the user names one concrete model and only wants its price, price_search directly.
<!-- persona:end -->

参数怎么填：

| 参数 | 从哪来 | 没说时 |
|---|---|---|
| `category` | 品类词，`["手机"]` | **必填**，这是唯一要问的 |
| `priceMin` / `priceMax` | "5000 以内" → `priceMax: 5000` | 不填 |
| `softCriteria` | 用户在乎的点，`["拍照"]` | `[]`（只按价格排） |
| `holdDays` | "用两年" → 730 | 730，答案里说明这是假设 |
| `willResell` | "一年后出掉" → true | false |

`softCriteria` **不是过滤器**：它决定"横评里为什么被点名"才算数。没被点名 ≠ 不满足。

### 它是异步的：发起 → 轮询 → 取回执

一次跑 2–3 分钟（枚举 + 读 6 篇横评 + 逐台比价），比多数宿主允许的单次工具调用长——同步等的下场是
"任务没做完就被掐断、后端还在跑、重试再叠一个"。所以：

```
purchase_decide({...})            → { runId, status: "queued" }
get_agent_run({ runId })          → { domain:"purchase", status:"running", stage:"找到 20 篇横评，读前 6 篇…", stages:[…] }
   …隔 20–30 秒再问一次，别连着轮询…
get_agent_run({ runId })          → { status:"done", receipt:{ frontier, dominated, products, coverage, residual, legend, note } }
```

- **同一个问题只起一个 run**。上一个还在跑就等它，别再发一次 `purchase_decide`。
- `stage` 是人话，告诉用户"现在在读横评 / 在比价"比干等强。
- `status: "error"` 就照 `error` 说，不重跑第二次就当它是偶发。

### 工具不在手边时：停下来说，不要手搓

`purchase_decide` 不在你的工具列表里（或调用回 `Tool not found`），几乎总是**宿主的 MCP 工具清单过期了**
——它在会话开始时拍了一次快照，Stream 后端后来加的工具进不来（旧快照里可能还留着早已拆掉的
`purchase_brief` / `purchase_verdict`，能搜到、调不通）。判据：`price_search` / `content_search` 正常而
这一个缺席。处理：**告诉用户"工具清单过期，请重连 MCP（Claude Code 里 `/mcp`）或重开会话"，然后停。**

**不要**退回"自己搜横评 + 自己比价 + 自己排名"——那正是这条线要根治的病：在一篇碰巧读到的横评点名的
四台上算"谁更值"，再把它写成推荐。没有全集的排名不是"不完整"，是误导。

## 第二步：读回执

回执自带 `legend`（字段名的人话），先读它。几个最容易读错的：

| 字段 | 意思 | 别说成 |
|---|---|---|
| `coverage.stopped: "truncated"` | 枚举源自己说清单没取完，全集是残的 | "市面上就这些" |
| `universeSource: "catalog:<源全名>"` | 按品类+价格档**直查产品库**（哪个包的 recipe 在 `meta.catalog` 里认领了这个品类，就问它），结构化、可复现 | （这一档本来就强） |
| `universeSource: "discovery:catalog"` | 没有可直查的产品库，**走发现循环现找聚集页再抽**（品类找窝 → 抓窝 → 配对 → 比价验在售）。是一份**有出处的样本**，每台候选都带着抽到它的那个窝 | "全集" / 跟直查一样地讲。要连着 `gaps` 里 stage=universe 的行一起说 |
| `coverage.seeded > 0` | 这几个是**枚举漏掉**、靠横评点名回头验到"真买得到"才补进全集的。只证明买得到，不证明这个品类没有别的同类——所以这一轮 `stopped` 必是 truncated | "全集里就有它" / 不提这回事 |
| `unrankedCounts.no_mention` | 读过的横评没为软条件点它的名 | "它不满足条件" / "它拍照不行" |
| `residual.mode: "purchase_only"` | 用户要转手，有台在回收平台查不到，**且**实测的不足 2 台、没法借同伴估——整轮按买入价排、没扣残值 | "系统默认残值为 0" |
| `residual.mode: "known"` | 每台都有残值：查到的扣**上一代今日最高回收价**（最好机况，上限）；查不到的、以及**查到的数高过买入价（代理失真）**的，按同档实测保值率里**最保守的**估（basis 开头「估的」，台数在 `coverage.residualEstimated`），估的数只会让它偏贵 | "两年后能卖这个数" / "这台持有成本是 0" |
| `residual.mode: "none"` | 用户不转手，残值就是 0 | （这一档本来就对） |
| `cost.kind: "unit"` | **快消品档**：比的是每百抽 / 每百克，不是整包价。候选名（`洁柔`）是横评说话的粒度，**能买的是 `cost.sku`**（`洁柔粉Face 3层110抽*24包`）——转述时必须把 sku 带上 | 只报品牌名就让用户去买 / 把 `comparable_cost` 讲成整包价 |
| `unit_mismatch` | 这一轮按某个单位比，它的单位对不上（卷纸的「克」对抽纸的「抽」）或规格解析不出用量 | "买不到" / "它不好" |
| `pricing.mode: "listing"` | 比价对**所有**候选都空手，整轮改用枚举页那个价——有出处、枚举阶段验过真在售，**但它是标价不是到手价**，实付通常更低 | 讲成实付价 / 不提这回事 |
| `frontier` | 互不支配的那几台，差别是用户偏好 | "最优" / "第一名" |
| `dominated[].why` | 被斩的理由，带数字，用户能核 | 自己另编一套理由 |
| `experience_rank` | 按被横评点名的篇数排的序 | "质量分" / "评测得分" |

`gaps` 是哪一步、哪一台、为什么失败——不是日志，是结论的一部分。横评一篇都没读成
（`reviewsRead: 0`）时，没有体验序，**如实说没法比，不要硬推**。

## 第三步：讲结论

必须带上的三样：

1. **底盘多大**：枚举了多少台、几台被点名、几台进了比较、清单全不全。没有出处的候选集不是结论，
   是一张披着表格的猜测。
2. **谁被谁斩、凭什么**：照 `dominated[].why` 讲，数字原样带。
3. **假设了什么、缺了什么**：默认的持有天数、没接的残值、没读成的横评。

前沿不止一台时说清"它们之间的差别是你的偏好"，不替用户选。前沿只有一台时也要说清它赢在哪根轴——
常见情形是"最便宜且没被证明更差"，那要明说这是**够用且最省**的推荐，不是软条件上最强的。

**答案里出现的型号必须都在回执里。** 回执之外的型号一个都不许出现，包括"顺便提一下 X 也不错"。

## 第四步：结果之后才追问

只问回执说"缺了会改变结论"的那一格，一次问一个：

- `residual.mode === 'purchase_only'` 且前沿里有高保值机型 → 告知哪几台在回收平台查不到（看 `gaps` 里 stage=residual 的行），问要不要按"不转手"重算。
- `holdDays` 用的是默认 → 问真实持有时间（它是分母，两年和一年结论会翻）。
- `reviewsRead` 很少而 `unmatched` 很多 → 说明横评在讲另一批型号，可能是全集漏了，问要不要换个品类词重跑。

不要问的：使用场景、品牌偏好、屏幕刷新率这类"再多给我一些信息"——它们不会让回执变得更完整，只会让用户填表。

## 没有卡片的宿主

装了 Stream UI 插件的 DSH 会把回执画成对比卡；在 Claude Code / Codex 里没有卡，用 `scripts/render.mjs` 把回执转成
markdown 表再贴给用户：

```bash
node .claude/skills/purchase-decision/scripts/render.mjs receipt.json
```

## 验它照做（人肉验收 / 写测试）

判据只看副作用，三条：

1. 会话里第一个工具调用是 `purchase_decide`，且它之前没有对用户的追问。
2. 答案里点名的型号 ⊆ 回执里的型号。
3. 答案带着 `coverage` 的数字。

`scripts/verify.mjs` 做 2 和 3：

```bash
node .claude/skills/purchase-decision/scripts/verify.mjs receipt.json answer.md
```

## 活体里撞过的错（都修在代码里了，这里是为了认出复发）

- **开场先甩五行问卷、一个工具都没调**——用户给的信息明明够。根因是工具描述写着"先问再跑"。
- **`willResell: true` 时前沿为空**——残值没来源，旧版把那些台全踢出比较，模型手里没东西可交，只能拿一桌
  五选一的菜单把决定推回给用户。
- **把回执逐字段手抄进另一个工具**——抄的时候把"残值查不到"补成"残值按 0 计"。这就是为什么现在只有一个工具。
- **把 `softCriteria` 讲成"硬性条件"**——"没人在横评里夸高刷"被讲成"市面上没有高刷的手机"。
- **回执被截断，前沿排在后面被切掉**——模型说"完整的 frontier 没有可核对地呈现"并拒绝下结论。
  现在结论在前、明细在后。

## 边界

- 没有 Stream 后端就没有这条线：全集、横评、比价、转写都是它的能力，skill 里没有替代品。
- **枚举有两档，强度差一截**：有直查产品库的品类（今天只有手机）拿到的是结构化清单；其余品类
  走发现循环现找聚集页（`discovery:catalog`）——能跑通，但它是样本不是穷举。要把某个品类升到
  直查档，就是给它接一个枚举源（走 `onboard-source`，接完在那份 recipe 的 `meta.catalog` 里声明
  品类词与价格档，范例 `packages/zol/zol-phones.recipe.json`；宿主不用改），这是这条线的常规动作，
  不需要单独设计。
- y 轴（体验序）目前是"被几篇横评点名"，同为 1 次时并列，于是最便宜的那台会斩掉所有人——
  这是已知的粗，不是 bug；升级方向见 `internal design record`。
