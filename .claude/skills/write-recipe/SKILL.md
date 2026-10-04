---
name: write-recipe
description: 写一份**可重放的 recipe** 去驱动一个界面——采集内容或做一件事（发消息、下单），面可以是**浏览器**（用户自己那个 Chrome，拦 XHR）、**桌面客户端**（控件树或屏幕识别，`kind:'desktop'`），将来还有手机。这条链路的唯一真相源：**写、跑、观察、修**全在这里。凡是碰它都读：采集没生效 / 抓不到东西 / 抓到的和页面上看到的对不上 / detail 打不开或很慢 / locate 掉进 fallback-nav / tab 被抢 / 账本(ledger)和 DOM 对不齐 / 桌面 recipe 每步都"成功"却 0 条 / 点到了看着像目标的另一个东西 / 要从零写一份新 recipe / 想给这条管线加能力。也在动手改 src/replay/ 或 packages/ 之前读。判断"该不该走这条路"是上游 onboard-source 的事（它的成本阶梯第 3–5 级才落到这里）。
---

# 写 recipe（Write Recipe）

**一份 recipe = 一段可重放的操作**：驱动一个界面，采集内容或做一件事。它有三个可变的维度，
写之前先各定一个——**判路不在这里**（那是 `onboard-source`），这里假设你已经知道要写 recipe 了。

| 维度 | 取值 | 在哪定 |
|---|---|---|
| **面**（在哪操作） | 浏览器 / 桌面客户端 / 将来手机 | 目标是网页还是原生客户端 |
| **目的** | 采集（喂 inbox）/ 动作（发消息、下单，`meta.action`） | 你要的是内容还是副作用 |
| **词汇**（怎么指一个东西） | 选择器（浏览器）/ 控件查询（a11y）/ `see` 指屏幕上的文字（像素） | 那个面上有什么可用，见下表 |

**先看你在哪个面上**——三个面的运行模型差别很大，坑也各不相同：

| 面 | 怎么驱动 | 特化篇 |
|---|---|---|
| **浏览器** | 用户自己那个 Chrome（扩展 relay 说 CDP），像人一样操作，**主要靠拦截页面自己发的 XHR** 拿数据——不重建签名请求，不从 DOM 抠字段 | 本文其余部分 + `references/` 大多数 |
| **桌面客户端** | Stream Desktop：有控件树的用 a11y 查询，自绘的（微信/QQ）用 `see` 指屏幕上的文字 | **`references/surface-desktop.md`** |
| **手机** | 还没有 | —— |

**三个面共用的东西**（改这些之前先读）：recipe 的契约与词汇在 `docs/PACKAGE.md` §2；
运行模型（步骤、`expect`、drift、账本）在 `references/pipeline.md`；
失败查表在 `references/failure-atlas.md`——**边界 1–6 是共通的，面特化的坑在各自的特化篇里**。

---

## 浏览器这一面

在**用户自己那个 Chrome** 里（经浏览器扩展的 relay 说 CDP）打开站点，**像人一样操作**（滚动、点开卡片），
数据**主要靠拦截页面自己发出的 XHR** 拿到——不重建签名请求，不从 DOM 抠字段。

**Stream 自己不带浏览器**，也没有"选哪个浏览器"这件事：用户的 Chrome 本来就是一个真人的浏览器，
所以没有 profile 要管、没有指纹要对。recipe 里**不要写** `session.transport`——`'cloak'` 装载即拒，
`'ext-cdp'` 收下但无效。

这是 Stream 采集的**最贵一条路**，只有站点把 API 签了名或锁在登录后、外部无法复现请求时才走。
**写和跑分不开**——写完就要跑、跑不通就要改 recipe——所以这两件事在同一个 skill 里：
从零写一份新 recipe 见 `references/authoring.md`，跑起来 / 观察 / 修见下面各节。

---

## 1. 你为什么会在这里（别在这里判路）

**判路不归这个 skill**——归 `onboard-source`（成本阶梯，0–5 级）。落到这里，意味着它已经拿到证据判定：
**站外复现不了这个请求**（签名被风控拒 / 数据只有用户自己的浏览器 session 能看到），所以必须上真浏览器。

如果你还没走过那条阶梯，**先回去走**。"接口能直连就绝不上浏览器"——这条路贵、单会话、要人的节奏，
不该被"我懒得试接口"带进来。

到这儿之后分两种事：
- **要写一份新 recipe** → `references/authoring.md`（+ `authoring-loop.md`、`recipe-template.md`）
- **已经有 recipe，但它不对/不跑/很慢** → 往下看（§3 不变量、§4 症状路由、§5 观察四律）

---

## 2. 管线长什么样（一张图）

```
feed recipe 一次运行（声明了 ledger）   src/replay/feed-ledger.ts
   │  产出这一批的有序身份 = 这条 lane 的【账本 ledger】（整本替换，标签关了就丢）
   │  xhs 现在的来源是 search（homefeed 面已删）；detail 骑同一个标签拿它当坐标系
   │
   ▼
RecipeRunner                          src/replay/recipe-runner.ts
   │  steps[]   = 在页面上【做】什么：scroll / locate+click / click / type / evaluate
   │              settle（动作前的闸门：等这块区域画完停住）**每步都收**，含 locate / openTarget /
   │                 evaluate——在这一步动手之前跑；没声明就是零代价空操作。
   │              expect（动作后的判据）**每步都收**，含 locate / openTarget ——
   │                 在它们的内建确认（URL 带不带 identity / 回落 fallbackUrl）之后、observers 读之前跑，
   │                 fallback-nav 那条路也照跑；但这两类**不吃 retryEvery**（装载时报错，各自已有
   │                 fallbackUrl / maxScrolls 兜底）。
   │  observers[] = 从页面上【读】什么：network(拦 XHR) / state(读 window) / dom(读渲染)
   │
   ▼
SessionRecipeExecutor → SessionManager → 用户的 Chrome(一条 lane 一个 tab，lane 内串行)
                                          src/replay/session-manager.ts
```

**账本是这条管线的脊椎。** 它是 detail 定位卡片的坐标系，也是"这条 lane 的页面现在铺着什么"的
唯一记录。**账本和页面 DOM 一旦对不齐，整条链路的表现就是"随机地不生效"。** 这是最高频的故障源，
先怀疑它。

### 2.1 `expect` 落空之后不只有"失败"一条路了

一步的 `expect` 没兑现（`StepExpectError`）时，runner 会**先按状态图认一眼当前页面**，
按这个顺序处置：

```
expect 落空
   → 按状态图认一眼（内置的全局图 ∪ 这份 recipe 自带的那张，见下）
       ├ 认出死路（如 cf/banned）      → 立刻终止，outcome 翻成 challenged
       ├ 认出有逃生口的障碍（如 cf/turnstile）
       │      → 跑逃生口的步骤清掉它，然后【重做这一步】
       │        **每一格最多清一次**：清完还在就不是"没点中"，是"清不掉"
       └ 认不出 / 只是认出个普通状态 → 什么都不做
   → 才轮到 recipe 自己的 retryFrom（整段重来）
```

**重做的是"这一步"不是"整段"**，而且这不违反「AI 介入后不在同一趟重走」那条：障碍在场意味着
页面**已经被替换了**，这一步根本没作用在目标页上，所以它没有副作用。

出口处（整趟跑完判 `blocked`/`drift` 时）还会再认一眼，认出死路或障碍就把结论翻成
**`challenged`**。理由是代价极不对称：判 `drift` 会让 `RepairLedger` 连着几次把这个源**静默隔离**，
此后它返回 `items:0 + errors:[]`——和「跑成功了、但确实没搜到」一模一样；判 `challenged` 只是
等一次 facility 冷却。这一步**排在 `loginCheck.wall` 探测之前**：具体的先于笼统的。

**状态图有三层，按 facility 装配**：内置全局那张（Cloudflare 三档：js-challenge / turnstile /
banned，`src/replay/states-builtin.ts`，白捡）∪ **包自带的 `packages/<id>/states.json`**（你写的那张，
契约见 `docs/PACKAGE.md` §2.10、写法见 `references/authoring.md` 的「给包写 `states.json`」）∪
本机学到的那层（`<dataDir>/state-graphs/<facility>.json`，接受 AI 介入的提议时写）。
整套模型见 `docs/ENGINE.md` §6。

**认不出来的时候会去问 AI**：`unknown`（一个都不认得）和 `ambiguous`（同组撞车）两种判决会带着
现场（截图 + 元素表 + 已知状态词汇）开一个**介入 run**，在运维页「源健康」里该源的修复页看得到——问了什么、
答了什么、闸怎么判的。**它的产物是提议，要人接受才生效**，接受后写进"学到的"那一层；本趟照常
按上面的顺序失败，不会因为问了 AI 就多走一步。

---

## 3. 三条硬不变量（违反必坏，不用 debug）

1. **一个 facility 只有一个 tab，而且是独占的。** 采集骑的是用户本人那一份登录；任何第二个东西
   （定时流、并发 harvest、你自己新开的那个 tab、调试脚本）碰同一个 facility，就会把浏览 feed 冲掉、
   账本作废。**"我的操作没生效"，先查有没有第二个人在动这个 tab，再改自己的代码。**

2. **观察者必须在被观察的事件之前挂上。** `network` observer 只能看见它挂上之后到达的响应。
   页面加载时发出的那批请求，如果观察者还没 start，就**永远不存在**。任何监听/订阅/拦截同理。

3. **首屏数据未必来自 XHR。** 很多站把第一批内容 SSR 进 `window.__INITIAL_STATE__`，**根本不发请求**。
   只挂 network observer = 静悄悄丢掉第一批，且不报错。判据：采集曲线第一次滚动前是 0。

---

## 4. 症状 → 去哪儿看（诊断路由）

先按症状定位到**哪一道边界**坏了，再去读对应 reference。不要从代码开始读。

| 症状 | 大概率的边界 | 读 |
|---|---|---|
| 操作没生效 / feed 莫名其妙换了一批 / 账本 inLedger=0 | 会话 | `references/session-runtime.md` |
| 偶发抓空 / 第二次刷新空 / 只有滚动碰巧触发才有数据 | 时序 | `references/session-runtime.md` |
| 抓到的和页面上看到的对不上 / 少了一批 / known=0 | 观察 | `references/observing.md` |
| 点不动 / 滚不动 / 定位不到卡片 / 一直 fallback | 操作 | `references/pipeline.md` |
| 抓到了但 item 是 0 条 / 字段全空 | 映射 | `references/authoring.md` §3 footgun |
| 重启后必失败（8900 上没人听；自托管档表现为 502 空 body） | 宿主 | `references/failure-atlas.md` |
| 掉登录 / 谁去重登 / 这份会话搬不搬得走（能不能不用浏览器） | 登录 | `references/login-and-session.md` |
| 卡在「☐ 请验证您是真人」/ 点了没反应 / token 恒空、提交按钮从不出现 | 人机验证 | `references/human-verification.md` |
| 点了但下一步找不到元素 / 表单流程走一半就断 / 点着了别的按钮 | 操作表单 | `references/authoring.md` §3.5（`click`/`settle`/`expect` 三个坑） |
| 桌面 recipe（`kind:'desktop'`）跑完 0 条、每步却都"成功"；点到了看着像目标的另一个东西 | **面特化：桌面** | `references/surface-desktop.md` |
| 报 `challenged` 而不是你以为的 drift / 日志里出现 `escape step#N` / reason 里带 `cf/...` | 状态图 | 见 §2.1 |
| 慢 | **别当性能问题** | 见下 |

**"慢"几乎总是"错"的影子。** 一个动作莫名其妙地慢，先问"它是不是在做本来不该做的事"，
而不是"怎么让它快点"。（实例：detail 要 5 秒，真因是它在滚过*我们自己没采到的那批内容*。）

**故障查表**（症状 / 一眼判据 / 修法，含站点特化条目）：`references/failure-atlas.md`

---

## 5. 观察四律（最贵的四条教训）

1. **别估一个系统能直接告诉你的东西。** 写"估算/推断/启发式"之前先问：这个值有没有权威来源？
   多数时候有，只是没去找。（实例：花了几轮拟合卡片坐标，而 DOM 里就存着它的 boundingRect。）
2. **探针要打在两个世界的交集上，不是各自的量。** 单独一个数字毙不掉猜想，交集才行。
   （实例：`vp=20 known=0` —— 页面上有 20 张卡 / 其中 0 张是我们认识的。一行日志终结了三轮瞎猜。）
3. **"空"和"没变化"是状态，不是结论。** 异步渲染的页面读到 0 张卡是常态，把瞬时读数当判决必错。
4. **工具的读回不等于真相——要在生效的那一侧量。** 第 1 律的反面：系统答了，但答的是它自己的模型，
   不是运行时的真实语义。（实例：Playwright `ctx.cookies('https://pan.quark.cn')` 报告 cookie"可见"，
   它却**不模拟 host-only 作用域**；页面里 `document.cookie` 一个登录 cookie 都没有 —— 假读数骗掉整轮
   诊断，还差点让人把"我注入错了"误判成"这站会话短命、得改扫码"。）
   **推论**：判据要落在**消费者**那一侧（页面的 `document.cookie`、一次真实请求的返回），不是生产者
   或中间层的自述。**并且：有反例在（同样的凭据在别处能用），就别归因于"凭据不行"，先怀疑自己。**

配套纪律：**每次修都要先给自己一条机器可读的验收判据**（例：`step#0 open` 必须是 `locate+click`
而不是 `fallback-nav`）。没有判据的"大面积修改"会退化成凭感觉重构。

具体怎么建立可观察性（probe 怎么读、怎么在活着的 tab 上求值/截图）：`references/observing.md`

**去读，别猜。** 采集正骑着的那个 tab 有读口——`cdp_look` / `cdp_shot` / `cdp_act`
（`target: 'facility:<name>'`），等价 HTTP 是 `GET /api/facilities/:id/page`、
`GET /api/facilities/:id/page/screenshot`、`POST /api/facilities/:id/page/evaluations {expression}`。
它排队在该 facility 的任务尾链之后，不会和跑着的 recipe 交错。**为什么必须从这儿看**：你想看的
本来就是**那个** tab——它的滚动位置、账本对应的那批卡片、中途的 DOM，新开一个 tab 一样都看不到；
而且对单会话站点，另开一个会话会把用户本人踢下线。在此之前调这条链路只能"改代码→重启→重跑→
看自己提前埋的那几个数字"，一轮一分半，而且只看得见你**预先想到要埋**的东西。用法见 `drive-live-ui`。

---

## Resources

- `references/capturing.md` — **抓包**：找出页面自己在跟哪个接口要数据，把请求和回包抄下来（写 recipe 的原料）。两种形态：只装了 npm 包走 `cdp_*` 三步，有源码检出还可以用仓库脚本落盘完整 body。
- `references/authoring.md` — **从零写一份新 recipe**（Tier-B 页内重放 / Tier-C eval / Tier-C DOM 的选型与写法）。
- `references/authoring-loop.md` — 写 recipe 的迭代循环。
- `references/recipe-template.md` — 可复制的 recipe 骨架。
- `references/pipeline.md` — 运行模型：账本从哪来 / locate 定位 / rideCurrentPage / 落脚点 / targetCount 语义。**改这条链路的行为前必读。**
- `references/session-runtime.md` — 采集跑在哪个浏览器里、lane 是什么、facility 单 tab 与串行、`visibility` 两档（`unattended` 采集 / `interactive` 要人动手）、后台的代价、抢占怎么探测怎么修、观察者挂载时序。
- `references/login-and-session.md` — 登录态在哪、掉了谁去重登、这份会话能不能离开浏览器（决定成本阶梯停在哪级）、红线。**接登录态 source 前必读。**
- `references/observing.md` — 观察手段清单与建立可观察性的方法。
- recipe 写好想分享出去 / 想装别人发的包 → `share-recipes` skill（发布检查清单 + 安装流程）。
- `references/human-verification.md` — **人机验证挑战**（Cloudflare Turnstile 等）：怎么判断这页有、怎么定位那个复选框（widget 在 closed shadow root 里，只能靠宿主 rect + 偏移）、用什么点、两个会静默卡死你的前提（tab 必须可见；点中心点不动）。**撞到「请验证您是真人」先读它。**
- `references/failure-atlas.md` — 症状→根因查表（六道边界分层 + 站点特化附录）。
- 相邻 skill：`onboard-source`（判路取证，上游）、`drive-live-ui`（看一眼页面：随手开的 tab vs 采集正骑着的那个 tab）。
- 概念与验证术语：`docs/PACKAGE.md` §2（recipe 槽位）。业务模型：`docs/ARCHITECTURE.md`。
