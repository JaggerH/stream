# 会话运行时：一个浏览器、lane、串行、时序

代码锚点：`src/replay/browser-ext.ts` + `src/replay/transport.ts`（怎么驱动那个浏览器）、
`src/replay/session-manager.ts`（tab 生命周期）、`src/replay/recipe-runner.ts`（时序）。

---

## 1. 采集跑在哪个浏览器里

**用户自己那个 Chrome，经浏览器扩展的 relay 说 CDP**（代码里这条通道叫 `ext-cdp`）。Stream **自己不带
浏览器**——没有要下载的 Chromium、没有 Stream 管的 profile、没有指纹要对。理由一句话：用户自己的
Chrome **本来就是**一个真人的浏览器，没有东西需要伪装。

> **只有一个浏览器，就是用户那台机器上的 Chrome。** 所以下面这些东西在这条链路里**不存在**，
> 见到就是过期指令（照做只会白费功夫）：Stream 自管的 profile（`data/browser-profiles/`）、
> `SingletonLock` 解锁、指纹伪装种子、"另起一个浏览器实例"、"这个站必须用哪种 transport"。
> recipe 里 `transport: 'ext-cdp'` 装载期收下但不生效，`transport: 'cloak'` **装载即拒**
> （`recipe-store.ts`）。

登录态**不需要"进"任何地方**：用户在自己的 Chrome 里本来就登录着。剩下的问题只有"掉了谁去重登"，
见 `login-and-session.md`。

### Lane —— "一个 tab"的单位（此前文档里从未写过，但它是这条链路的核心抽象）

**lane = `facility` + `laneKey`**，池子键就是 `${facility}\0${laneKey}`（`session-manager.ts`）。一条 lane = 一个 tab。

- `laneKey` 不传就是 `'default'`。**采集目前全都没传** —— 所以看起来像"一 facility 一个 tab"，
  那是**约定，不是限制**。（全仓唯一传了 laneKey 的是 AI 交互 lane：`facility='_agent'`、
  `laneKey=<会话 id>`，靠它在一个 facility 下开多条。）
- **上限 `maxLanesPerFacility` 默认 4。它是风控闸，不是内存闸** —— 理由写在代码里：
  *a human opens few tabs on one site*。真人在一个站开三四个 tab 正常，开二十个不正常。
  全局并发归 `maxLanesGlobal`(8) 管。（旧文档里还写着一条 `maxResidentMb`（物理内存 60%）的
  内存闸——那是 Stream 自己烧内存跑浏览器时代的东西，**已经没有了**：现在那些 tab 是用户
  Chrome 的内存，不归 Stream 预算。）
- **每条 lane 有自己的串行尾链（tail）**：同一条 lane 上的任务永不交错（look/act/shot 也排在它后面）；
  **不同 lane 之间不串行**。所以"同一时刻只有一个任务在跑"是 lane 内的事，不是 facility 内的事。
- **`lifecycle`** 决定谁来关：
  - `one-shot` —— release 即关。想开个临时 tab 干点事又不想操心关，用它。
  - `persistent` —— 复用热 tab（省掉每次预加载/导航的钱）；忘了关不会泄漏，
    预算会淘汰 idle lane（有 in-flight lease 的绝不淘汰，`graceMs` 覆盖"刚生出来还没被认领"那段）。

  **判据：这个 tab 留着，下一次有人用得上它吗？** 用得上的只有两种——① 有**定时流**在同一个
  facility 上反复采（省掉每轮的预加载），② 有**另一条 recipe 骑它的账本**（detail 要用 feed
  那一批卡片当坐标系）。两条都不成立就该是 `one-shot`：**留下的 tab 不是免费的**，它占着用户的
  浏览器、还是风控的活靶子。搜索类 recipe（xhs-search / douyin-search）今天全是 `one-shot`——
  用户搜完就看结果，没有下一次要复用的东西；detail 那侧靠自己的 `fallbackUrl` 直达，慢一点但
  功能不缺。
- `closeFacility(f)` 是**前缀扫描**，关掉该 facility 名下**所有** lane。

**lane→tab 只活在后端进程内存里，重启即丢。** 于是后端一重启，用户 Chrome 里还开着的采集标签
就没人认了——新进程不知道它、`closeFacility` 够不着。收尾归扩展侧：它每次**连上后端**都拉一次
`GET /api/ext/claimed-tabs`（后端此刻真正骑着的 tabId），组内 `probe` 出身、不在名单里的才回收
（`reclaimOrphanTabs`）。**时机是"连上"不是"SW 启动"**——后端重启那一刻 SW 往往还活着，
只挂在启动上等于永远不跑。三条红线：问不到后端（网络错/非 200）什么都不做（空集合 = 一个都不认，
和"不知道"是两回事）；`adopted`（用户拖入）永不 remove；`created`（给人看的）不动。
刚建出来的标签有 60s 宽限，挡住"后端还没登记进 lane"那一瞬的误杀。

**出身账本存在扩展的 `chrome.storage.local`，跨扩展重载存活**（开发期天天重载，存 `storage.session`
会让重载后所有标签的出身丢成 `adopted` = 永久免疫回收）。代价是 local 也跨浏览器重启存活，而
**tabId 只在一次浏览器会话内有意义**，所以账本配了一个失效判据：`chrome.runtime.onStartup`
（只在浏览器 profile 启动时触发、扩展重载不触发）一到就把账本作废，退回"认领现存 Stream 组、
一律 adopted"的保守老行为。判据不成立的那一格（整个浏览器会话里没有 onStartup ——
扩展在浏览器已经跑着的时候才被启用）在代码头注里写明了。要点：**看见组里的标签全是 `adopted`
而你并没有拖过它们，就是账本被作废过一次**，不是回收逻辑坏了。

**这意味着什么**：recipe 想"在第二个 tab 里打开详情、让 feed 那个 tab 原地不动"，机制上是通的
——缺的只是 recipe 语言里没有说法（今天没有任何 recipe 传 laneKey）。今天 detail 走的是
"同一个 tab 导航走再回来"，`ledger`/`locate`/`fallback-nav` 那一坨复杂度的根子就在这儿。

### `visibility` —— 这次运行要不要用户伸手

两档：`unattended`（采集，后台 tab，**永远不抢屏幕**）/ `interactive`（用户得亲自动手的流程——
登录、扫码、自助建 key——开在他当前窗口里可见）。

**判据是"谁动手"，不是"谁想看"。** 所有 Source 都是 `unattended`，包括要可信点击的。
lane 建好就发一条 `Emulation.setFocusEmulationEnabled`（`browser-ext.ts` 的 launch，一处开启），
隐藏 tab 的可信输入因此照常落地，**前台从来不是"点得动"的前提**。

活体对照（靶子是 example.com —— 完全静态、页面自己零活动，所以量到的纯粹是浏览器行为；
同一个 tab、同一段可信点击 = 8 次 mouseMoved + 按下 + 松开）：

| 条件 | 一次点击 |
|---|---|
| 它是活动标签（前台） | 204–257ms（5/5） |
| 隐藏，什么都不做 | **39.8–41.6s**（5/5） |
| 隐藏 + `Page.startScreencast` | 39.8s（无效） |
| 隐藏 + 每个动作后逼一帧 | 267ms / 1.2s / 39.8s（**不稳**） |
| **隐藏 + focus 仿真** | **162–185ms**（5/5） |

**倒数第二行是历史证据，不是今天的选项**：**采集 driver 一帧都不逼**——「逼帧」整条已经不存在。
它留在表里正是"为什么不该靠逼帧"的理由：那一档忽快忽慢，focus 仿真才是稳的那个。
摘掉的完整依据见下面「为什么今天一帧都不逼」。

**最后一行的 162–185ms 复现不出来，别拿它当预算。** 2026-09-03 同样开着 focus 仿真、同样的
后台标签（靶子 example.org），一次可信点击实测 **5.9 / 9.7 / 6.5 秒**——每个鼠标事件的回执还是
要等 0.5–0.9 秒。**真正的成本一直是回执，不是事件本身**：同一轮里页内探针显示 11 个事件
**在 262ms 内全都送达了页面**（间隔 6–111ms，正是设计的轨迹节奏），而同一条通道上一次
`Runtime.evaluate` 往返只要 36ms。

今天这一半由扩展接住：可信鼠标事件**发了就算，不等 Chrome 的回执**（`extension/src/lib/driver.ts`
的 `FIRE_AND_FORGET`）。改完实测 **0.19–0.33 秒**（5/5），页内事件顺序、条数、间隔都不变。

**focus 仿真照旧要开。** 它管的是"事件到不到得了"（不开是 39.8–41.6s 那一档），回执快不快是
另一件事——别因为点击变快了就去撤它，两者不是同一个自变量。

**病理**：隐藏 tab 的 trusted input 在等下一帧，而浏览器不打算给看不见的 tab 画。逼帧只让流水线
热一小会儿（所以那一档忽快忽慢，而不是稳定地慢）；screencast 无效是因为
CDP 要求逐帧 `Page.screencastFrameAck`，扩展的事件转发按订阅过滤、没人订 `Page` 域 → 没人 ack →
只吐一帧就停（命令本身确认成功，别据此以为"发失败了"）。

**它撒了什么谎**（如实记，别粉饰）：开启后页面读到 `hasFocus()===true`，而这个 tab 其实在后台
（A/B 实测：开关 ON 的背景标签读 `true`、OFF 读 `false`，判据干净地跟着开关走）。页面内部自洽，
能被统计到的是"整个会话从不 blur"。`visibilityState` 是不是也被一起改写，**没有实验证实**——
同一次实验里三个标签（含没开开关的那个）全读 `visible`，而那几个标签的窗口几何完全重合，这个
实验本身就分不出它们。要用这一条判断什么，先自己现测一次，别引这里。**没有任何实据表明站点据此作废会话**（查过：无测试、无日志、无记载；录制 launcher 也一直
明确开着它），别把这个当风险来源去关掉它。**封号治理的正解是限速，不是撒不撒谎**（见
`§ 频率闸门`）。

**它救不了什么：要合成器真产出一帧的命令**（这是这张表最容易被误读的地方）。开关给的是"页面
被当成有焦点"这个谎，可信输入等的正是这个谎；而 `Page.captureScreenshot` 等的是**真的有一帧**，
那由 OS 那层"这个 Chrome 窗口到底显不显示在屏幕上"说了算——被别的窗口盖住 / 最小化 / 锁屏都算，
页面撒的谎管不着。A/B 对照：开关 ON 也照样挂（18.66s、12.03s），OFF 挂（26.08s、30.00s×4），
快的时候两边都是 0.11–0.21s ——**开关不是自变量**。所以 `settle`（逐帧截图比字节）这类要真帧的
步骤不吃这条开关的红利（截图在扩展侧另有 1.5s 上界 `SCREENSHOT_BUDGET_MS`，到点回明确失败）；
排查见 `failure-atlas.md` §4.3.6。**别把"输入被救了"读成"帧的问题解决了"。**

### 为什么今天一帧都不逼

**采集 driver 不含任何"替页面产帧"的动作，别把它们加回来。** 两处候选——每个动作之后逼一帧、
dwell 期间按 250ms 一拍的心跳——都是逐格量掉的（2026-08-15，真 recipe 走 `POST /api/sources/preview`，
两臂交替、先后手换过，开关带计数落盘所以"跳了几次"是被证明的而不是被相信的）：

| arm | douyin-search（当时还靠滚动，targetCount 30） | xhs-home |
|---|---|---|
| 两处都逼 | 9/9 够数 | 109 / 111 / 112 |
| 只留 dwell 心跳 | 5/5 够数 | 112 / 111 |
| 全摘 | **13 轮里 11 轮只有 20**（少一整批） | 113 / 110 / 112 |

- **动作位**：摘掉对产出零影响（中间一行）。可信输入等的是 focus 仿真那个谎，不是帧。
- **dwell 心跳**：当时**只有 douyin 靠它**——xhs 三臂无差别，因为它的懒加载在后台标签里零逼帧
  照常跑（实测定时器 40/40 拍、`rAF` 在跑、`scrollHeight` 2983 → 6978）。而 `douyin-search`
  随后改成站内直调（`evaluate` step，不再滚动、不再 dwell），**这条心跳的唯一消费者就此消失**，
  于是它也摘了。

**不是时间的功劳**（这条排除很重要）：掉到 20 的那些全摘轮次，scroll 步花的墙钟**更长**
（6.3–9.2s），而够数的只用 3.2–4.7s。用更多时间换到更少东西 —— 自变量是帧，不是时长。

**要不要帧是站点差异，不是通用规律。** 上面这张表**不能**读成"后台标签的懒加载都不需要帧"——
它只说 xhs 不需要、当时的 douyin 需要。**给新站点写 scroll + dwell 型 recipe 时，这一格要自己
现测**：跑几轮看抓够没抓够（判据是产出，不是耗时）。真撞上"非有帧不可"的站，先考虑换成
render-independent 的取数（调站点自己的请求客户端，Tier A），那正是 douyin 走的路——**别把心跳
加回来**：帧由 OS 那层"窗口显不显示"说了算，窗口一收起来它就空转，是个修不干净的依赖。

**推论：想"看着它跑"不要改这个字段。** 采集 tab 一直在标签栏里，自己切过去就看得见；
`visibility` 只决定 tab 开在前台还是后台，**runner 一层不碰焦点**。排查靠 `RECIPE_PROBE` 的
分阶段账本和 `data/failures` 的失败现场——那是事后能回放的，比实时盯着有用。把窗口提到最前只
发生在用户显式要求时（点「在浏览器里完成登录」→ `RecipeSessionManager.focusFacilityTab`）。

**这一节被同一类错误绊过三次**，共同的形状是**把"当时缺一个开关"写成了"物理上做不到"**：
先是"ext-cdp 后台跑不了可信输入 / silent IMPOSSIBLE"，再是"要可信点击就得声明前台档"，
最后是那个前台档自己——它多出来的唯一动作（每次运行前把窗口抢到最前）在 focus 仿真之后
就已经没有理由，却又活了两个月，全靠"没人给它排定时"守着。

### 频率闸门 —— 封号治理在这里，不在拟人

**站点数的是频率，不是像不像人。** 2026-07-29 亲历：连续几分钟高频打 xhs detail → 登录墙，而
拟人光标轨迹、900ms 动作间隔**全程都开着**。humanize 管的是单次动作长什么样，管不了"一分钟来了
三十次"。

`FacilityRateLimiter`（`src/replay/facility-rate-limit.ts`）：每个 facility 一个令牌桶，单位是
**一次 recipe 运行**（搜索 / detail / 互动各算一次，那才是落到站点上的一次访问），闸门装在
`SessionRecipeExecutor.execute` 最前面——一个 facility 上同时有几条线在打，只有那个共同入口看得见
总量；被限速时连标签都不开。

- 配置在 `packages/<facility>/package.json` 的 `stream.rateLimit`，**不声明就不限速**：闸门是针对具体站点
  的实测结论，不该由一个凭空的全局默认替所有站点做主。xhs = `burst 5 / perMinute 6 / maxWaitMs 15s`。
- **闸门有两道，叠着走，两道都过才放行**：facility 那道（上面这个）管整站总量；**单条 recipe
  还能自带一道**（写在 recipe 自己的 `rateLimit` 上，见 `src/replay/recipe.ts`）。
  为什么需要第二道：同一个站的**读腿和写腿安全速率差一个数量级**——闲鱼查残值 4–10 发没事，
  上架 15 分钟 6 发就把整站打成 404。只有一道的话，为了按住写腿就得压 facility 桶，
  **等于把读腿一起压死**。所以：要限的是"这一份 recipe 太猛"就写在 recipe 上，别去动 facility 那道。
- 选令牌桶不选固定间隔：真人一阵一阵——连点五条笔记再去读十分钟。固定间隔会把这种正常节奏也罚站。
- **闸门有两维，别只看速率**：`burst`/`perMinute` 管**瞬时形状**（一阵能打多密），`perHour` 管
  **累计量**（一小时最多几发）。有的站点数的是后者：Google 一小时约百发之后稳定回 `/sorry/index`
  （IP 级，同出口的 Brave 一起弹）。**光靠速率闸门按不住它**——合规跑满 `perMinute 30` 一小时就是
  1800 发，比撞墙点高 18 倍；反过来 2.7 次/分连打 15 分钟就够撞，而令牌桶一次都不会拒。
  `google = burst 6 / perMinute 30 / perHour 100`（100 是实测撞墙点，贴着墙走、零余量）。
- **两维撞满的处置不同**：速率撞满按 `maxWaitMs` 决定等还是拒；**累计预算撞满立刻拒**（等下一格
  36s 起步，等回满一小时），由调用方决定回落——搜索腿是 `src/search/web-search-ladder.ts` 走备胎 /
  当这条腿不存在。**预算只在真正放行时才扣**：被速率闸门拒掉的那次连标签都没开，不算累计量。
- **被限速不是"源坏了"**：`RateLimitedError` 继承 `EnvironmentUnavailableError`，走"什么都不记"
  那条。记成失败 = 用户手快点几下就把这个源点成红的、连点几次掉档，而源一点毛病都没有。

## 2. 默认单 lane —— 独占 + 串行

`SessionManager` 按 **(facility, laneKey)** 维护 persistent entry（见 §1 的 lane）。一个 facility **可以**
有多条 lane（各一个 tab、各一条 `tail`、彼此并行，最多 `maxLanesPerFacility`），**但现在全部 19 条采集
recipe 都不传 laneKey**，于是都落在同一条**默认 lane** 上——所以实践中就是"一个 facility 一个 tab"。
每条 lane 用一条 `tail` promise 把它自己的任务**串成一条链**（尾链序列化）。这意味着（对默认 lane）：

- 同一 facility、同一默认 lane 的两个 recipe 运行**不会并发**，会排队。
- 但**排队 ≠ 隔离**：前一个任务把页面滚到哪、导航到哪，后一个任务就从哪开始。
  这正是 `rideCurrentPage` 能工作的原因，也是**"被抢占"这个故障存在的原因**。
  （想让 detail 开在**另一个** tab、不冲掉 feed，机制上只差在 recipe 的 `session` 里写个 `laneKey`；
  校验已放行该键、打错字会在装载期报错，见 `recipe-lane.test.ts`。目前没有 recipe 这么用。）

### 停在入口页的 persistent lane 会被重载

persistent lane 上一轮跑完停在哪就在哪。它停在**入口页**上时，runner 进场会 `goto(entryUrl)` 一次
（= 重载）：停着的那份渲染是**上一轮的答案**，站点这期间已经往前走了（对话多了新图、feed 多了新帖），
不重载读到的就是旧的（doubao-chat-images 实测连跑两次同一个 guid）。只有 `rideCurrentPage` 明说
"页面停在哪就是我的工作上下文"才不动它；one-shot tab 刚开在入口页上，也不重载。
**recipe 不必自己写第 0 步 goto 来对付这件事。**

### 骑用户自己开着的 tab：`adoptTab`

recipe 顶层写 `"adoptTab": { "urlPrefix": "https://…/chat/", "param": "url" }`，runner 进场前先向扩展要
会话标签组的成员列表，只挑 **`origin: 'adopted'`（用户亲手拖进组的）**、URL 以 `urlPrefix` 开头的 tab：

- 给了 `{param}`：有同地址的用户 tab 就骑它；没有 → 走 lane，照常开自己的。
- 没给 `{param}`：恰好一个候选 → 骑它，并把它的地址填进 `{param}`；0 个或多个 → `blocked`，reason
  把候选列出来，不猜。

骑用户 tab 的三条铁律：**不 goto、不重载**（那是他正看着的活页面，重载丢他的滚动位置；页面是活的，
也没有"旧渲染"要治）；**是一次独立租约，不进 lane map**（lane 按 facility 键、被该 facility 的所有
recipe 共用——把用户的 tab 登记成 lane，下一条 recipe 就会在他的对话上 goto）；**release 不关它**。
我们自己开的 lane tab（origin `created`/`probe`）即便地址一样也**不骑**——那正是上一节说的旧渲染。

**后台 tab 上别写轮询等待。** 用户开着但没在看的 tab，Chrome 对隐藏超过 5 分钟的页面把链式
`setTimeout` 对齐到每分钟一次；实测单个 `setTimeout(500)` 要 1264ms，一段 10s 的轮询就撞中继 30s
超时——而同一 tab 上同步求值 3ms 就回。recipe 的 evaluate 要按"页面早就渲染完了"来写：一次读完
就返回；真要滚动翻历史，让用户把 tab 切到前台。

### 谁会抢这个 tab（按出现频率）

1. **定时流 / scheduler**。一条按 cadence 跑的 Stream，周期性 harvest 同一个 facility → 把浏览 feed
   冲掉、账本作废。**这是"我的操作随机不生效"的头号真因。**
2. **前端并发调用**（刷新按钮连点、滚到底重复触发续抓）。
3. **你自己**——手动在那个 facility 的标签上点来点去、或者用 `cdp_act` 动它。采集和你共用同一个
   浏览器，所以这不是"两个进程抢 profile"，而是**同一个标签上两只手**。

### 怎么探测被抢占了

按成本从低到高：

| 手段 | 看什么 | 判据 |
|---|---|---|
| **`locate` 探针** | `vp=N known=0` | 视口里有卡，但一张都不在账本里 → feed 已被换掉 |
| **账本长度** | `ledger=0` / `inLedger=false` | 账本压根是空的 → 上游 harvest 被清了 |
| **同 facility 的 probe 行号** | 两个不同 sourceId 的 `[recipe-probe]` 交替出现 | 有第二个任务在跑 |
| **查有没有定时流** | `user-store` 里该 facility 的 system stream / channel | 有就是它 |

### 怎么修

- **退役掉抢 tab 的定时流**（把 pull 型的浏览会话和 push 型的定时入库彻底分开）。
- **前端单飞**（loading 标志位），别让一次滚动连发。
- **调试期不要另开这个站的第二个会话**——采集骑的是用户本人那个登录，你抢的是他自己。用下面
  §4 的手段观察正在跑的那个 tab，别新开一个 tab 去"看看情况"。
  **对单会话站点（xhs 这类：站点只允许一个登录在线）这条尤其硬**：作者工具那个带调试端口的
  Chrome（`--user-data-dir=/tmp/stream-chrome`，见 `failure-atlas.md` §6.3）和用户日常那个是
  **两个 user-data-dir、两份登录态**，在那种站上它们会互相把对方踢下线——你以为在调 recipe，
  实际上是把用户的登录挤没了。

## 3. 时序：观察者必须先于事件挂上

`RecipeRunner` 的正确顺序（**改动它之前先理解为什么**）：

```
构造 ObserverPipeline
  ↓
observers.start()        ← 先挂上监听
  ↓
driver.goto(entryUrl)    ← 才进入口页
  ↓
detectLoginState()
  ↓
observers.observe('entry')
  ↓
跑 steps[]
```

**为什么必须这个顺序：** `network` observer 只能报告**它挂上之后到达**的响应。如果先 goto 再 start，
页面加载时发出的首批请求就**不存在**了——采集只能靠"后面某次滚动碰巧又触发了一次请求"活着。
表现：**偶发抓空**（某次滚动没触发新请求 → 一条都没有 → 一个空的"刷新"）。

带 network observer 的 recipe 必须**强制走一次加载**（观察者得*看着*这次加载发生），
即使当前 URL 已经在入口页上。

> **通用化：** 这不是浏览器特有的。任何监听/订阅/拦截，都要确认它在被观察的事件**之前**就位。
> "偶发"往往是时序，不是随机。

## 4. 观察正在跑的那个 tab

想看正在跑的那个 tab 长什么样、读 `__INITIAL_STATE__` 的真实形状、确认卡片在不在 DOM 里——
**有专门的读口，别再靠"改代码 + 重启"做二分猜测**（那个一分半一轮、只能看预埋数字的老循环已经不必要了）：

- **`cdp_look({ target: 'facility:<name>', js })`** —— 在那个 tab 上 eval，拿回值（MCP 工具；等价 HTTP
  `POST /api/facilities/:id/page/evaluations`）。看 DOM、window 全局、选择器命不命中都靠它。
- **`cdp_shot({ target: 'facility:<name>' })`** —— 截图（等价 `GET .../page/screenshot`）。DOM 说不清的（隐藏遮罩、
  没渲染、验证墙）用眼睛看。
- **`cdp_act({ target: 'facility:<name>', kind, ... })`** —— 想在那个 tab 上真点一下试试（可信点击），走它。
  带 `expect` 选择器就点完确认预期特征出没出现（`confirmed` / `acted-unconfirmed`），不盲赌。

三者都排在该 facility 任务尾链之后、不与 recipe 交错。详见 `drive-live-ui` skill。
（地址旧写作 `cloak:<facility>`，别名已随 CloakBrowser 一起摘掉，现在会报 unknown target scheme。）
想读一个页面没有直接给出、但站点自己算得出的东西，仍可以**加一条 probe**。

配方创作脚本（`scripts/recipe-capture.ts` / `recipe-dom-capture.ts` / `record validate`）**不能用来调试
正在跑的采集**——它们连的是你自己另起的那个带调试端口的 Chrome（`STREAM_AUTHORING_CDP_URL`），
开的是自己的新标签，看不到采集那一轮的滚动位置、账本和中途状态。它们是给"侦察新站点、写新 recipe"用的。

**绝对不要**为了"看一眼页面"去开同一个站点的第二个登录会话——单会话站点会把其中一个踢下线，
而被踢的那个是用户本人。

## 5. 宿主层（容器/进程）

- **浏览器在宿主，不在容器里。** backend 容器只顺着 websocket 说 CDP，镜像里没有任何浏览器。
  所以 capture / validate 一律**在宿主上** `pnpm exec tsx …`，连你自己起的那个调试 Chrome；
  `docker exec` 进容器跑它们必然失败（见 `failure-atlas.md` §6.3）。
- **Chrome 关着时不算故障。** 采集要用浏览器而它不在（Chrome 没开 / 扩展没连），`ensureHarvestBrowser()`
  先去唤起（桌面端在就 `ensureApp`，只让进程活着、不抢屏）；唤不起就抛 `EnvironmentUnavailableError`，
  调度侧**跳过本轮**而不是记一次源故障——否则好源会被拉进退避黑名单。详见 `failure-atlas.md` §6.2。
- **`src/**` 改动要重启 backend 容器**才生效（前端 HMR 不用）。
- **pid 不能标识进程。** 容器重启后 pid 会复用，pid 锁里记的那个 pid 很可能又活了，而且**正好是你自己的
  启动器**（cmdline 里同样有 `serve.ts`）→ 锁误判"另一个实例在跑"→ **拒绝启动** → 上游对所有请求回
  **502 空 body**。要么记启动时间（`/proc/<pid>/stat` 字段 22），要么别拿 pid 当身份。
- **502 空 body 的形状会告诉你故障层**：应用层出错会回 JSON；**空 body 只能是上游根本没应答**，
  也就是后端压根没起来。别把它当"浏览器冷启动慢"。
