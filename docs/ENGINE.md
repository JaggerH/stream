# ENGINE.md — Engine、Perception Vocabulary 与状态图

Recipe 描述**做什么**（steps）和**读什么**（observers）；本文定义与它正交的另外三件事：

- 一个动作**通过什么落地**——**Engine**（轴 B，§2）
- 一份 recipe **用什么词汇看被控对象**——**Perception Vocabulary**（轴 A，§3）
- 走不通的时候**怎么知道自己在哪**——**状态图**（§6–7）

前两根轴是让浏览器、桌面应用、纯视觉作为**兄弟**接入同一套 recipe 运行时的结构性前提；
第三件是这套运行时在**失败路径**上的骨架：`expect` 落空只说"不是预期"，不说"那是什么"，
而状态图就是把那半句补上的东西。

- Recipe 的概念、正交组成与验证术语见 `docs/PACKAGE.md` §2（recipe 槽位）（本文是它的补篇：把
  那一节里一笔带过的 `transport` 和只存在于代码、未进文档的 `PageDriver` 提升为一等概念）。
- 业务模型（Channel / Stream / Provider / Source / Plugin）见 `docs/ARCHITECTURE.md`。
- 拟人采集管线怎么跑 / 怎么观察 / 怎么修：`.claude/skills/write-recipe/SKILL.md`（唯一真相源）。
- 代码锚点在 `src/replay/`；§8 给出概念 → 代码的对照，§9 说清哪些格子今天还是空的。

> **两轴是概念契约，不是代码结构。** 「怎么找」和「怎么动」在概念上是两根可独立替换的轴，
> 而代码里它们**还没劈开**：现有 `PageDriver` 是这套抽象的**浏览器融合实现**（§8）。
> 缝的位置和两侧的契约在此钉死，真正劈开等有第二个词汇用真实需求验过接口形状再做。

---

## 1. 两根正交的轴

一次「在某个界面上定位一个目标并操作它」的行为，由两个**互相独立**的决定构成：

| 轴 | 名字 | 回答的问题 | 取值（目标态） |
|---|---|---|---|
| **A** | **Perception Vocabulary**（感知词汇） | 用什么语言**看**被控对象——既用于定位，也用于读取 | `dom` / `a11y` / `pixel` |
| **B** | **Actuation Engine**（驱动引擎） | 谁把动作**落地**到那个界面上 | `ext-cdp` / `host-desktop` / `sandbox` |

**两轴独立**：同一套 `dom` 词汇既跑在浏览器引擎上、也能跑在任何有 DOM 的被控面上；将来同一个
`host-desktop` 引擎既能配 `a11y` 词汇（读可访问性树）、也能配 `pixel` 词汇（纯视觉兜底）。词汇决定
「用什么找和读」，引擎决定「用什么手动」，两者可自由组合。

**为什么浏览器这一侧看不出两轴的区别**：浏览器的**词汇恒为 `dom`**，所以「换引擎」从来不需要
「换词汇」，两轴可以被一个字符串糊在一起也不露馅。**桌面是第一个「轴 A 也不同」的接入物**——它一
进来，糊在一起的那根轴就绷不住了。这正是本文存在的原因。

---

## 2. 轴 B：Actuation Engine —— 怎么动

Engine 是**引擎级动作原语的集合**，它**不认识「元素」，只认识坐标和动作**：

```
interface Engine {
  click(rect, button?)          // 在一个框的中心（或其坐标）落一次点击
  drag(fromRect, toRect)
  scroll(px | rect, direction)
  moveMouse(x, y)
  type(text)                    // 向当前焦点输入文本（键盘 → 必须先抢屏）
  press(keys)                   // 组合键 / 单键
  screenshot() → image
  sleep(ms)
}
```

这些原语**与感知词汇无关**：滚就是滚、点坐标就是点坐标，跟被控对象是不是浏览器毫无关系。因此
一个桌面 Engine **原样能实现它们**——这是「复制 UI-TARS 的控制逻辑」真正落地的地方。

**Engine 的实现（目标态）**：

| Engine | 是什么 | 位置 |
|---|---|---|
| `ext-cdp` | 用户自己那个可见的 Chrome，经扩展 CDP 驱动。**唯一的采集浏览器**：Stream 不带浏览器——用户的 Chrome 本来就是真人的浏览器，不需要伪装、下载、管 profile、对指纹 | 现有 |
| `host-desktop` | 宿主机上 **Stream Desktop** 的本机进程（可执行文件 `stream-desktop`，薄执行器：enigo 打输入 + per-OS `A11yBackend`），经 `/api/host` WS relay 受后端 `DesktopDriver` 驱动，操作真实鼠标键盘与屏幕。二进制按平台打成 npm 子包，生命周期由 Stream 后端自己在进程内持有（`src/host-agent/mount.ts`，挂 `capabilities/desktop/`）——不需要开桌面壳（约束：须在用户交互会话内，非 session-0 服务） | 现有 |
| `sandbox` | 自带虚拟桌面的隔离容器（云或本地）；控制的不是用户真实环境 | 目标态 |

**`host-desktop` 的接管指示与中止热键**：Stream Desktop 真的往屏幕上发键鼠输入时
（`focusApp`/`click`/`moveMouse`/`scroll`/`type`），屏幕顶部会出现一条点击穿透、不夺焦的提示：
`AI 正在操作你的电脑 · <recipe id> · <当前步骤> (i/n) · 按 Ctrl+Alt+Esc 停止`（步骤那一段由后端
每步发 `status` op 写上去，只有 recipe id 和步骤 label，不带参数；`STREAM_DESKTOP_STATUS=0` 关）。
只读的 op、`ensureApp`/`invoke`/`setValue` 和 `status` 本身都不亮它——这个信号只有一个含义：
**亮 = 现在别碰鼠标**。按下热键，agent 给中继发一帧
`{"type":"abort"}`，后端把挂起和排队的 op 一并以 `HostAbortedByUser` 拒掉，整趟 recipe 停在
那里，**任何一层都不会自动重试**（`run_action_recipe` 报 blocked、采集侧 decline，都不记 drift）。
判定在 agent 侧（`app/host-agent/src/overlay.rs` 是平台无关的策略，`overlay_win.rs` 是 Windows
渲染层），所以后端崩了条子也会自己灭。

> **红线不变**：Engine 只自动化**用户自己的**浏览/桌面会话，绝不逆向或伪造平台签名。签名/风控
> 挡路的正解是「让页面/应用在真环境里自己算」，不是重建请求。见
> `project_legal_red_line_no_signature_forgery`。

> **写效应随桌面放大**：`2026-07-17-capability-normalization` 的**效应轴**（read / write）定了「热插的
> 数据 recipe 不许含写操作」——引擎门禁只看得懂「请求发给谁」，看不懂「这个写到那边会干什么」。
> `host-desktop` Engine 把这个赌注放大一个量级：一个桌面写操作能删文件、清空网盘，比浏览器 POST 狠
> 得多。同一条规则对桌面只会更严——**写留在 code + 发版，直到有单份 recipe 显式授权 + 包来源签名的
> 信任模型**（Marketplace 阶段的产品课题）。

> **无 UI 的兄弟引擎**：`kind:'http'` / `kind:'html'`（宿主直发请求，无浏览器）与上表的
> UI 引擎同属一个 recipe 运行时家族，是成本阶梯最便宜的两级——但它们**没有驱动轴**（动作
> 只有「发请求」），感知词汇分别是 JSON dot-path 与 CSS selector。本文的两轴图景只描述
> 有 UI 的引擎；http 引擎自己的能力面（jar / compute 钩子 / probe 的 object 输出）定义在
> `internal design record` 与 `docs/PACKAGE.md` §2.3。

> **注意**：浏览器 Engine 多一个 `goto(url)` 原语（URL 导航是浏览器专有概念）。桌面 Engine 的
> 对应物是「启动/聚焦某个应用」，语义不同，不强行统一——`goto` 记为浏览器 Engine 的私有扩展，
> 不进通用 `Engine` 接口。

---

## 3. 轴 A：Perception Vocabulary —— 用什么词汇看

这是本文最需要纠正一个既有误解的地方：**「感知词汇」不只管「定位」，还管「读取」**。

因为 recipe 里「找一张要点的卡」（一个 `locate`/`openTarget` step）和「读出一批数据」
（一个 observer）用的是**同一套词汇**：在 `dom` 世界里，locate 靠 CSS selector + href，observer
也靠 `itemSelector` / `statePath` / href 属性。它们是一根轴的两个用途，共进退。所以轴 A 的准确
定义是——**这份 recipe 用什么语言感知被控对象**，它同时约束下面两个组件：

- **Locator**：把一个 query 解析成一个可操作的目标（供 step 使用）。
- **Observer**：从界面读出结构化数据（供 output 使用；即 `PACKAGE.md` §2.2 的 network/state/dom
  观察者家族）。

三种词汇：

| 词汇 | Locator 用什么找 | Observer 用什么读 | 何时用 |
|---|---|---|---|
| `dom` | CSS selector / href / `__INITIAL_STATE__` | 拦 XHR body / 读 `window` state / 读渲染 DOM | 浏览器（今天全部 recipe） |
| `a11y` | role / name / native class 提示 | 可访问性树属性（value / text） | 桌面应用有可访问性树时（成本阶梯主路径） |
| `pixel` | `see`：屏幕上的文字（系统 OCR）/ 缓存的模板 / 视觉模型报坐标，见 `src/replay/desktop-see.ts` | 同一条梯子读出来的文字框 | 无可访问性树（自绘界面、游戏、canvas、远程桌面）或它落空时的兜底 |

**`a11y` 是平台中性词汇，三个 OS 后端**：Windows **UIA**（ControlType/Name/Invoke）、macOS **AX**
（AXRole/AXTitle/AXPress）、Linux **AT-SPI**（role/name/action）。概念共通（role + name + rect +
invoke），Stream Desktop 的 per-OS 后端把中性 query 翻成各自 API——recipe 只写 role+name，尽量可移植。

这三档正是 `onboard-source` 成本阶梯在桌面上的映射：**`a11y` 是 DOM 的等价物（便宜、确定、微秒级、
免费）**，是主路径；`pixel` 是它落空后接住的网，不是第一选择。

`pixel` 自己也是一条按成本排的梯子，recipe 只写一句 `see`（「屏幕上的这段文字」或「这个图标长什么样」），
由 `resolveSee` 依次试，`via` 共六个值、五段（`SeeVia`，`desktop-see.ts`）：

| via | 这一段干什么 |
|---|---|
| `a11y` | 把 `text` 当控件名，在控件树里找一次 |
| `screen` | 读屏，按文字匹配 |
| `template` | 缓存里有这个 `see` 的模板，就在窗口截图上找（NCC） |
| `model` | 把可点框编号叠在截图上，视觉模型回一个编号 |
| `point` | **最后一档**：grounding 模型**直接报绝对坐标**。自带越界拒绝——报到窗口外面就当没报 |
| `pinned` | 不是一段，是**产物**：模型报完坐标之后回读控件树，把落点固化成一个句柄，下次直接用它 |

所以"模型永远碰不到坐标"这句**只对前四段成立**：`point` 那一档恰恰相反，它就是让模型报坐标——
因为到了这一档，前面每一种"能重新求值的定位式"都已经失败了，剩下的选择是报坐标还是放弃。
`pinned` 的存在正是为了让这一档**只发生一次**：坐标一旦落地成句柄，下一趟就不再是坐标了。

**第一段给出框就停，模型那两段是最后的、一趟 recipe 里的调用次数不超过步骤数**；`expect` 那条路根本不许调
模型——判据必须确定、免费、可重复轮询。模型命中后会把那一块裁成模板写进缓存，下一趟就落在 `template` 段；
**模板在用户自己的机器上长出来、也只属于这台机器**（`<dataDir>/desktop-see/<sourceId>/`，缓存键含窗口尺寸
与缩放比），不随包分发。每一步走了哪一段记在 `via` 里，`template` 命中却没兑现 `expect` 就作废那条模板。为什么这么分段见
`internal design record` §5。

---

## 4. 核心契约：`find(query) → { rect, handle? }`

两轴要能自由组合，全靠一个跨三种词汇都成立的最小公约数。轴 A 的核心操作是把一个 query 解析成
一个轴 B 能操作的目标：

```
Locator.find(query) → { rect, handle? }
```

- **`rect`（必有）**：目标在屏幕/视口里的坐标框（CSS px 或物理 px，由 Engine 的 scaleFactor 归一）。
  三种词汇都能给出——`dom` 有 `getBoundingClientRect`，`a11y` 有 BoundingRectangle（UIA）/ AXFrame
  （AX）等，`pixel` 直接吐框。**Engine 只靠 `rect` 就能动**：点它中心、从它拖到另一个 rect。这是所有
  词汇/引擎组合的保底路径。
- **`handle`（可选）**：原生元素句柄，是一条**快车道**。`dom` 能给 Playwright locator（做 trusted
  元素点击，比坐标点击更准、风控特征更像真人）；`a11y` 能给控件元素（调它自己的 Invoke/AXPress/
  action，绕过坐标）；`pixel` **没有** handle——而「没有 handle」恰恰是抽象该交给实现决定的事，
  不是抽象的缺陷。

**Engine 的取用规则**：有 `handle` 走 handle 快车道，没有则退化到 `rect` 坐标动作。这一条让
浏览器保住它现有的「trusted 元素点击」保真度，同时让纯视觉（只有 rect）也能跑。

**快车道不只是"更准"，它决定了这一步要不要抢用户的屏。** 坐标动作（含键盘 `type`——它投给
当前焦点窗口）必须先把目标窗口拿到前台；handle 动作的收件人是元素本身，不需要前台，锁屏也
生效。所以打字有两条路：`a11y` 的 `setValue`（UIA ValuePattern 一类，把文字写进元素）走快车道，
Engine 键盘是保底。**定时采集该走的是快车道**——半夜把用户的屏幕夺过去，正是这条链路要避免的。
控件不认 Value pattern 时退回键盘，但必须留痕（`DesktopRunOutcome.typedVia`），否则"抢屏"会
以一个查不动的形态原样长回来。见
`internal design record`。

坐标动作本身还有第三条路：**投给窗口**（`PostMessage` 到 hwnd，recipe 里 `input:"message"`）。
它和 handle 一样有收件人，所以不抢前台、锁屏照常——没有控件树的应用（微信 4.x）靠它才能
后台跑。代价是逐应用的兼容性（Electron 系多半不理会），所以它是 recipe 显式选的，不是自动退路；
契约见 `docs/PACKAGE.md` §2「`input`」，实测见 `internal design record`。

这就是为什么「基于抽象定义留缝」和「代码不动」不冲突：**契约在纸面上就能下死**，它容纳浏览器、
UIA、视觉三者，不需要先看真机。

---

## 5. 一个 step 在这套模型下怎么走

以「点开 feed 里某张卡」为例，拆成两轴各司其职：

```
step: locate + click 目标卡
  │
  ├─ 轴 A (Locator, 词汇=dom)：find("a.note-card", identity=noteId)
  │      → { rect: 卡的视口框, handle: Playwright locator }
  │      （dom 词汇下这一步内部就是现有的 locateCard 闭环：readViewport 看谁在视口、
  │        findCard 读某张卡的文档 Y、fitIndexToY 拟合、滚到位——全是 dom 词汇的私有实现）
  │
  └─ 轴 B (Engine)：有 handle → trusted 元素点击；无 → click(rect.center)
```

同一个 step 换成桌面：轴 B 换成 `host-desktop` Engine，轴 A 换成 `a11y` 词汇的 Locator（`find` 吃
role/name、返回控件 rect + 元素 handle），**step 本身的结构一字不改**。这就是「缝」的价值。

---

## 6. 状态图 —— 走不通的时候，怎么知道自己在哪

前面两轴回答「怎么看」和「怎么动」。这一节回答第三个问题：**动完发现不对，那是什么？**

`goto(url)` 只保证浏览器**去了一个地址**，对"你到了哪"没有任何保证。同一个 URL 后面至少藏着：
未登录、登录墙、人机验证、版式 A / 版式 B、空结果、限流、会话过期后的静默重定向。而且这些
**大半不是自己的动作引起的**——外力（风控升级、A/B 分流、cookie 过期）随时会改，脚本预测不了。

一个只有 `expect` 的引擎，等于一台**只有两个状态的状态机**：对 / 不对。`expect` 落空只说
"不是预期"，**不说"那是什么"**——信息在这里被扔掉，于是没法找路，只能失败。

### 6.1 今天接了线的是哪一段

**只有「回头认一眼」这一段**（`classifyByState`，`src/replay/state-classify.ts`）。完整的
「先认状态、再找路、再走」那台机器（`runToState`，`state-machine.ts`）代码写好了、测试齐了，
但**没有生产调用方**——写 recipe 仍然是写 `steps[]`，不是画状态图。

接了线的地方有两处，都在 `recipe-runner.ts` 的失败路径上：

```
一步的 expect 落空（StepExpectError）
   → 按状态图认一眼
       ├ 认出死路（cf/banned）        → 立刻终止，outcome 翻成 challenged
       ├ 认出有逃生口的障碍（cf/turnstile）
       │      → 跑逃生口的步骤清掉它，然后【重做这一步】，每格最多一次
       ├ 认不出（unknown）/ 同组撞车（ambiguous）
       │      → 抓一份现场，交给介入 Broker（§6.7）；本趟的处置不变
       └ 普通状态                     → 什么都不做
   → 才轮到 recipe 自己的 retryFrom（整段重来）

整趟跑完判 blocked / drift（含「一条 item 都没有」——它也走异常出口，不许绕开下面这几步）
   → 再认一眼，认出死路或障碍 → 翻成 challenged
   → unknown / ambiguous 同样带现场交给介入 Broker
   → 这一步排在 loginCheck.wall 探测【之前】：具体的先于笼统的
```

**交给 Broker 是旁路，不是处置**（`handOffVerdict`）：现场捕获（`captureBrowserScene`，
`src/replay/scene.ts`）每一项独立 best-effort，抓不到就不抓；问不出来也不抛——
**介入永远不许盖掉真正的失败原因**。这一趟照原来的样子失败，提议留给下一趟用。

**为什么非要翻成 `challenged`**：判 `drift` 会让 `RepairLedger` 连着几次把这个源**静默隔离**，
此后它返回 `items:0 + errors:[]`——和「跑成功了、但确实没搜到」一模一样；判 `challenged` 只是
等一次 facility 冷却。代价极不对称，所以宁可翻。

**清障重做的是"这一步"不是"整段"**，而且不违反「不在同一趟里重走」：障碍在场意味着页面
**已经被替换了**，这一步根本没作用在目标页上，所以它没有副作用。

**图分三层，按 facility 装配**（spec §9.1；状态是站点级的事，所以键是 facility 而不是 sourceId）：

| 层 | 在哪 | 谁写 | 随谁走 |
|---|---|---|---|
| 内置全局 | `src/replay/states-builtin.ts`（Cloudflare 三档） | 我们 | 随代码 |
| 包自带 | `packages/<id>/states.json`（recipe 契约的一个文件，见 `docs/PACKAGE.md` §2.10） | recipe 作者 | 随包分发，npm 包同样 |
| 本机学到的 | `<dataDir>/state-graphs/<facility>.json` | 接受提议时写 | 随 data 走，**不碰包目录** |

三层都是同一个 `StateGraph` schema。本地两层由 `StateGraphStore.graphFor(facility)` 合成
（`state-graph-store.ts`），`session-recipe-executor.ts` 按这条 recipe 的 `session.facility` 现取、
经 `RecipeRunOptions.stateGraph` 传下去，runner 再 `assembleGraph` 并上内置全局那张。
**任意两层 id 撞车一律抛错**，不让谁静默盖掉谁——盖掉的症状是「别的源都认得出、就这个认不出」，
而没有一处会说出原因。两层都缺席时 `graphFor` 如实回 `undefined`，不补一张空图。

学到那一层的每个状态多两格来源：`proposalId`、`acceptedAt`——能撤、能审、能一键「升格进包」；
装配进 runner 时剥掉。

### 6.2 `identify()` 回的是一组状态，不是一个

**状态是部分描述，不是快照。** 一个状态只声明自己在意的那几条特征，没声明的东西怎么变都不影响
它。所以一个屏上同时成立好几个状态是**正常的**——活体实测（QQ）：「中间列开着搜索面板」和
「右侧是和某人的对话」同时为真，两条都对。

**推论：组合爆炸从来不存在。** 任何为消除组合爆炸引入的机制（正交状态区域、状态层级、
XState 那类状态组合库）都是在解一个不存在的问题。

真正的歧义只发生在**同一组之内**。`group` 是人写的那句「这几个不可能同时为真」，自由字符串，
同组互斥、跨组可以同时成立。同组撞车才回 `ambiguous`，而且**绝不从里面挑一个返回**：挑一个
意味着引擎带着错误的信念继续走，而它不会崩溃——它会把后面每一步都做在错的前提上，一路做到
有副作用的那一格。

**省略 `group` 等于落进空串那个默认组，而默认组的含义是「和所有人互斥」**——这是最危险的那个
默认。内置的 CF 三档因此都显式写了 `group: 'global/cf'`：不写的话，本地图里同样没写 group 的
状态会和它们判成撞车，而 CF 拦截页是**同源返回**的、URL 一个字不变，靠 url 特征认的本地状态
在封禁页上照样为真。

### 6.3 特征、约束，与 `absent`

- **特征**回答"是什么"，用来认状态：URL 模式、DOM 选择器、a11y 查询、屏幕文字、一张模板图。
- **约束**回答"是哪个"，用来在多个候选里裁决：相对位置关系归定位层。

**这条有一个明确的例外，就是 `where`**（§7.2）。两者混进同一张表就写不出判据，所以这个例外
要写清楚边界。

**`absent` 是必需的一档，不是补充**：「已登录」最可靠的判据往往就是「登录按钮不在了」。
互斥也靠它撑开——CF 三档里 `js-challenge` 必须声明「Turnstile 的那个容器**不在**」，
否则挑战页上两档一起命中。

**背景色不作为特征**——它跟随系统主题变化，跨机器不可移植。类型上拦不住，靠 review。

### 6.4 区分度闸

判据不是"这条特征能不能描述当前页"，而是**"它能不能只匹配当前页"**。同一个 APP 的两个页面
长得像是常态。

`checkDiscriminative` 拿候选的**整组**特征去撞已知状态的历史观测，**撞上一个就打回**。看整组
而不是逐条，是因为单条不够、两条合起来唯一是完全正当的写法；**只和同组的比**，跨组同时成立
是正当的。

不设这道闸，状态库会越长越糊，最后每个状态都匹配上——而且查不出是哪天开始坏的。

**观测从哪来**：每次 `identify()` **成功**认出状态，`classifyByState` 把「那一刻为真的特征键」
经 `onObserved` 记进观测账本（`ObservationLedger`，`<dataDir>/state-observations/<facility>.json`，
按 facility 分文件、与状态图同一个键，每 facility 留最近 200 条）。没有账本，闸就是一道装了
但永远开着的门。

**闸装在入库前**：`state` / `discriminator` 两类提议进审核队列之前先过 `gateStateLike`
（`src/intervention/gate.ts`）两道，顺序固定——① **此刻成立**（候选的每条特征在当前现场上为真；
一条此刻都不成立的特征连"描述当前页"都做不到，拿它去撞历史观测没有意义），② **只匹配当前页**
（`checkDiscriminative` 拿整组特征撞同组状态的历史观测）。过不了的标 `rejection` 仍进 run 记录
（人要看到 AI 答了什么、为什么被拒），只是不进审核队列。

### 6.5 两条调用频率，一套骨架

| | `identify()` 代价 | `identifyPolicy` |
|---|---|---|
| 网页 | 近似免费（URL 是每时每刻都在的确定性标签，选择器判断也是本地的） | `every-step` |
| 桌面 | 要读屏，4K 一次 2.7–7.4s | **`on-failure`：顺路不认，`expect` 落空才认** |

**顺路那一支一次模型都不调。** 状态识别是故障处理器，不是主循环的一环。
**一次 `identify` 里屏只读一次**：多条文字特征各读一次屏是同一笔开销付好几遍，而且各次读到的
还可能不是同一帧——那会让 AND 判据在动画期间随机为假。

### 6.6 退出条件

四件不同的事，拆开才写得出来（`RunResult.outcome`）：

| 退出 | 判据 |
|---|---|
| **成功** `reached` | 目标状态在 `identify` 的命中集合里（不要求它是唯一命中的那个） |
| **卡住** `stuck` | 一个都不认得，或认出来了但没有到目标的路 |
| **转圈** `looping` | 同一状态被访问到第 3 次（取 3 不取 2：合法的「回家重走一次」会让某个状态出现两次） |
| **花超** `budget` | 步数 / 墙钟时间 / AI 介入次数中任一超预算 |

**死路（`deadEnd`）优先于以上全部**，也优先于"撞车"：`ambiguous` 说的是"这几个我分不开"，
和"其中一个走不通"无关，所以死路要先扫一遍再报撞车。认出死路就该立刻停，而不是等防转圈撞满
三次、或者把预算耗光——**区分「再等等就好」和「再等也没用」，比认出「这是什么」更值钱**。
防转圈是最后一道网，不是判据。

**转圈是状态图独有的新风险**：线性脚本走不出环，状态图会——而 AI 介入会让它转得特别自信。
所以**必须记状态访问历史**，这不是可选的观测手段，是活性保证。

找路是 **BFS，刻意不是 Dijkstra**：除非边权有实测来源（耗时 / 成功率），否则 cost 是编的，
而编出来的权重只会让路径选择变得没法解释。

### 6.7 AI 介入闸

**触发口只有一个：`expect` 未兑现**（含起步时状态未知）。顺路的时候它不存在。
AI 被问到的只有三种问题（`RepairRunner`，实现是 `src/intervention/broker.ts`）：

1. **这是哪儿**（一个都不认得）→ 返回一组能认出当前状态的特征，过 §6.4 那两道闸后入库。
2. **拿什么区分这几个**（同组撞车）→ 返回一条区分性证据。这是区分度闸在运行时的对应物。
3. **下一步点哪**（认出来了但无出路）→ 返回目标 + 操作方式。只按 `name` 字面核对现场
   元素表，`selector` 一律放行；`find()` 现验尚未做。

**三种问题的输入是同一份**：触发那一刻的**现场截图** + **元素表**（浏览器侧是页面清单的编号/
标签/角色/名字/矩形，桌面侧是 a11y / detector / text 三档来源）+ **已知状态词汇**（这张图上现有
的状态及其特征）。模型只能用**这一侧判得了的**特征作答——浏览器侧 `url` / `dom`，桌面侧
`a11y` / `text` / `image`（名单 `ALLOWED_FEATURE_KINDS`，`src/intervention/ask.ts`）；提示词只摆
这几种，解析和入库闸再各拦一次。为什么按侧裁：一条浏览器侧求值不了的 `text` 特征进了图，那个
facility 此后每趟 identify 都抛，日志里只有一行「状态诊断失败」。`stateId` 的前缀是 **facility**
（`xhs/…`，不是来源名 `xhs-search/…`）：模型写错前缀不拒、改写，改写记进 `gateNote`。

**后台档（`visibility: unattended`）的现场没有截图**：Chrome 不给不显示在屏幕上的标签画帧，
截图命令在扩展侧 1.5s 到点判失败，现场只剩文字 + 元素表——这就够模型答对（活体 2026-09-11
xhs-search）。别为它加"抢到前台截一张"：后台档的承诺就是不抢屏。

**产物是提议，落在 `/api/interventions`**：每条提议带现场、模型的理由、闸的判定，在运维页
「源健康」里该源的修复页审（通知中心与频道配置里的状态词都直达那里）；**接受是这条链路上唯一会改状态图的动作**，而且只改**学到的那一层**
（`<dataDir>/state-graphs/<facility>.json`），不碰包目录——包自带的 `states.json` 归作者改。
同源同指纹的问题先查库再问（`fingerprint.ts`），拒过的答案也是知识。

三条纪律：

- **只修定位，绝不修断言。** 断言是任务的定义，AI 改了它就等于自己给自己发毕业证。
- **产物是提议，不是自动改写。**
- **不在同一趟里重走。** 重跑动作步 = 把同一个动作发两遍，这在有副作用的界面上是最贵的错。

**agent 档（修复会话）**：源被 `RepairLedger` 关进隔离时，若设置里配了 `ai-agent`（一条 ACP agent 的启动命令），
Broker 开一条 `kind:'repair'` 的 run：起子进程 → `initialize` → `session/new`（cwd 是包目录的**工作副本**
`<dataDir>/repair-work/<runId>/`，`mcpServers` 带我们的 `/api/mcp`）→ 任务书 → 每条 `session/update` 落成事件。
产物是一条 `recipe` 提议：候选体必须过四格校验（schema、version 恰好 +1、断言逐字未动、可选活体 probe），
人接受时才校验后原子写回 `recipePath` 本身，`shouldRun` 读到 version 升高自己放行。断言锁盯的是
`steps[].expect` 与 `steps[].require`、`loginCheck`、顶层 `assert`、`harvest.assert`、`output.assert`、
`observers[].input.assert`、`meta.params_schema[*].required`——这几处逐字未动才算过闸，改动定位以外的任何一处都拒。
审批门（`approval.ts`）只放读类与写副本内文件；其余进 `awaiting_confirmation` 等人。停止：`end_turn` + 校验过 =
干净完成；`UNREPAIRABLE:` 标记 = 修不了；卡住（同工具同参数 3 次 / ABAB 3 周期 / 校验连败 3 轮）与三闸
（12 轮 / 150 万 token / 30 分钟，各按 `+6 轮 / +100 万 token / +20 分钟` 续）= `paused`，人「继续」各抬一档。
后端重启把活会话收成 `paused`，人点「恢复」用 `session/load` 续。
**只对实测过的 adapter 标「已验」**（见 `internal design record`），
其余「按协议应当可用」。代码：`src/intervention/{acp-client,repair-session,repair-manager,approval,stuck,gates,recipe-validation,task-book}.ts`。

### 6.8 轨迹

每一步落一个 JSON，路径 `<root>/<sourceId 里的斜杠换成下划线>/<runId>/NNN.json`。
最核心的字段是 **`identified.matched`——凭哪条特征判的**。只记"第 3 步点了 (620, 613)"是
回溯不了的，看不出它当时**为什么**觉得那儿对。

读的时候要知道两条：`identified.states` 是命中的**全部**状态、`matched` 是这些状态特征的
**并集**（配着 `states` 读，别以为它们都属于 `states[0]`）；**起步那次识别不写 `outcome`**，
硬写 `expectMet: false` 会和「动作做了但没兑现」在文件里长得一模一样。

### 6.9 明确不做的

每条都是量过或撞过之后否掉的，写在这儿是为了不被重新提一遍。

- **版面 / 区域切分（layout analysis）**：递归投影切分（XY-cut）在真实 UI 上实测失败——真实的
  列间隙只有 0.5–1.5 个行高（Discord 26px / 9px），放宽阈值又会让 Slack 消息区的留白冒充成一条
  1066px 的间隙。而且复杂度本来就不只来自区域（头像上多个未读数字，切区解决不了）。
  位置这一维由 §7.2 的 `where` 承担。
- **正交状态区域 / 状态层级 / XState 那类状态组合库**：见 §6.2 的推论。
- **`expect` → 状态图 `to` 的收敛**：`expect` 今天仍是二值判据。它在桌面 recipe 里牵着
  `require`、`branch.when`、打断表、`else`/`retry`/`abort` 一整套，改它等于动整个 recipe 契约和
  所有存量 recipe。**这是一份独立计划该干的事**，不是顺手做的。

---

## 7. 视觉侧：没有 a11y 的时候，特征从哪来

有 a11y 树就用 a11y——不是因为它更准，是因为它**便宜且可重放**。这一节只管没有 a11y 的那些
APP（如 QQ NT，它一个控件都不暴露）。

### 7.1 只有两种问法

| 问什么 | `Feature` | 怎么答 |
|---|---|---|
| 屏上有没有这串字 | `{ kind: 'text', text, where?, region?, absent? }` | 屏幕文字表，走 `pickTextDetailed` |
| 屏上有没有一小块长成这样 | `{ kind: 'image', png, minScore?, where?, absent? }` | NCC 模板匹配，走 `find_image` |

`image` 用于**文字答不了的那些**：只有图标没有标签的按钮、输入框拿到焦点时的那圈高亮、
头像角上的未读徽标。

**判法是 NCC（零均值归一化互相关），不是感知哈希。** NCC 抗线性亮度/对比度变化、且已带粗搜
加速——它是仓库里已有的生产实现（`app/host-agent/src/see.rs` 的 `find_image`，也是 `see` 梯子
`template` 那一段用的同一个），**别另写一套指纹算法**。**它扛不住明暗主题切换**（那是反色，
不是线性变化），主题变了就得重录参考图，这是这一档的固有边界，不是选错了算法。

**文字匹配走 `pickTextDetailed`，不走 `String.includes`。** 它带着两样这里必须有的东西：

- **按行拼**：OCR 每帧的分段不一样，QQ 那行「进入全网搜索我的手机」有时是一整段、有时被切成
  两段。按段做判据在被切开的那些帧上**永远匹配不上**，而表现和"这东西真的没出现"一模一样。
- **`where`**：见下。

**识别层可以拒答，定位层不能。** 同一串字在屏上多处命中时，判据路算它「在」（问的是"在不在"，
多处命中恰恰是更强的"在"）；动作路必须拒绝——点哪儿必须唯一。把定位层的纪律搬到识别层来，
会让"屏上有两处「发送」"变成"没有发送"。

### 7.2 `where`：锚点 + 方向 + 距离

照抄 UiPath 的 Anchor Base，没有 a11y 的界面上这是行业标准做法，不自己发明。

```jsonc
{ "kind": "text", "text": "$name",
  "where": { "anchor": { "text": "导入手机相册" }, "side": "left", "maxDist": 8 } }
```

它防的是「同一个名字在会话列表和标题栏里各有一份」那种认错对象，而**下一格就是发错人**。
四条判据：

- `side` 四选一：`left` / `right` / `above` / `below`。左右要求同行，上下要求同列。
- `maxDist` 的单位是**锚点框的宽（左右）或高（上下）的倍数**，不是像素——换分辨率不用重写。
- 锚点在**全屏**里找，不在收窄后的候选里找：锚点常常正好落在被 `region`/`not` 排掉的那一条上。
  锚点有好几处时**任意一处成立即成立**。
- **`where` 是过滤器不是选择器**：不做择优、不排序、不取最近，那是定位层的活。
- **`where` 和「按行拼」互斥**：拼行会把目标和锚点装进同一个包围盒，方位关系当场消失。

**一个状态如果全是带 `where` 的特征，那就是写歪了**：「我在哪个界面」该由不含位置的特征回答，
`where` 只用来钉「我在跟哪个对象打交道」。

**别和 `see` 搞混**：`where` 只长在**状态特征**上，`See` 类型里没有这个字段；`see.not` /
`see.below` 是定位层的收窄手段。两边不通用。

### 7.3 元素表：三档来源缝成一张

Rust 侧（`stream-desktop`）把三个来源缝成一张元素表，每条只有三个字段：`rect` / `name?` /
`kind`（`a11y` | `detector` | `text`）。合成规则（`synthesize_elements`）：

- **包含即命名**：检测器给的框套着一段文字 → 那段文字就是这个框的名字。
- **落单即入表**：没被任何框套住的文字段，自己成为一条 `kind: text`。
- **套娃的框折进同一条**——但**跨档不能这么折**。两把尺子：同档看重叠比（>0.7，留小的那个）、
  跨档看 IoU（>0.6）。合成一把尺子会吃掉能点的地方：a11y 报的工具栏套着检测器报的按钮，
  包含比恒为 1.0，按同档规则那个按钮会被合并掉，**少一块能点的地方**。

**没有 id、没有指纹、没有关系边。** layout graph（`labeled-by` 那一套）没有实现，§7.2 的
`where` 就是它那部分职责的落地形态。

**检测器住 Rust 侧**，因为截图已经在 Rust 手里了；放 Node 就得把整帧像素传一次。用 OmniParser
的 `icon_detect`（只要检测那一半，**不要** caption 那一半），ONNX Runtime CPU 后端，不需要 GPU、
不需要 torch。实测：`icon_detect.onnx` 12.25MB，检测 34–150ms 且与分辨率基本无关；
**瓶颈是 OCR**（4K 一次 2.7–7.4s）。置信度阈值**必须是 0.02**——0.05 时 QQ 左侧三个图标检不出来，
那一档的分数本来就低，不是"调松一点更好"。

两个必踩的工程坑，都已经踩过并修好，改这块时别退回去：**输入要 letterbox 不能直接 resize**
（640×640 是方的、桌面窗口是宽的，直接压会把图标压扁）；**NMS 要自己做**（导出时一般没缝进图里）。

> 检测器权重的许可证还没拍板（现成的 ONNX 是 Ultralytics 的 YOLOv8 底，AGPL，而它已经随
> `stream-desktop` 一起分发），见 `project planning record`。

### 7.4 「本地认它、AI 说它是什么」这条分工还没做

> **本地只回答「这是不是上次那个东西」，AI 回答「这是什么」。**
> 前者可以无限次免费跑；后者每个东西一辈子只问一次，答案落成 `(状态, 指纹) → 功能` 字典。

今天**一行都没实现**。真要做时，三个前提漏一个字典就是错的：

1. **指纹会失效**：APP 升级重画图标，模板就不认了。失效表现是**查不到**（退回问一次 AI），
   不是点错——这是安全的失败方向。但它是**静默**的，得有"连续 N 次认不出就提示重录"的信号。
2. **键必须是 `(状态, 指纹)`，不能只有指纹。** 同一个指纹在不同状态下可能是不同功能——返回
   箭头在哪儿都长一样。这一条漏了，字典整个是错的，而且错得很安静。
3. **AI 会猜错，猜错和猜对长得一模一样。** 每条新绑定第一次使用必须有 `expect` 兜底：
   没兑现就**作废这条绑定**，而不是重试。

### 7.5 持久化的是"怎么再找到它"，不是"它在哪"

存下来的必须是**能重新求值的定位式**：a11y 查询、一段文字（可带 `where`）、一张模板图、
一个选择器。**绝不存 `(x, y)`。** 坐标会漂，而且它不会报错——它会点到别的东西上，
这是这类系统最贵的失败形态。

`see` 梯子最后那一档 `point`（模型直接报坐标）是这条规则唯一的缺口，而 `pinned` 正是用来
把缺口补上的：坐标一落地就回读控件树固化成句柄，**下一趟就不再是坐标了**。

---

## 8. 现状对照（当前代码 vs 目标态定义）

**轴 B（Engine）今天已经是一个对象：`Transport`（`src/replay/transport.ts`）。轴 A（Perception）
还没抽出——它连同 Engine 的定位动作一起融在浏览器专用的 `PageDriver`（`src/replay/actions.ts`）里。**
两轴的落地进度不一样，分开看。

### 轴 B —— 已对象化为 `Transport`

`2026-07-16-ext-cdp-first-class` 的 CP1 把散在三处（`session-recipe-executor` / `bootstrap`
resolveLauncher / makeLauncher）的 transport if/else 收成了一个对象。它就是 Engine 轴：

```ts
interface Transport {                         // src/replay/transport.ts
  launcher
  driverFactory(rawPage) → PageDriver         // 造这条 transport 的 PageDriver
  relayFactory(rawPage)  → ObserverRelay?      // 造网络观察 relay
  evaluate(rawPage, expr)                      // ← transport 无关原语，`look` 骑它
  screenshot(rawPage) / elementShot(rawPage, sel)  // ← transport 无关原语，`shot` 骑它
  url(rawPage)                                 // ← 问浏览器进程，不问页面（信引擎不信被控面）
  bringToFront(rawPage)                        // ← 只在用户显式要求时（focusFacilityTab）
}
```

`resolveTransport(deps)` 只产**一个**实现：用户自己的 Chrome 经扩展 relay（没有第二个浏览器可选）。
缝没有因此作废——session manager 和执行器
是**对着 Transport 写的**，它们手里从来不是一个 Playwright page。`evaluate` / `screenshot` / `url` 是
**与感知词汇无关的 Engine 原语**——`look` / `act` / `shot` 三个看活页面读口骑在它上面
（`session-manager.ts`），`/api/facilities/:id/page*` 就是这么出结果的。**ENGINE.md §2 说的
「Engine 原语与词汇无关」在这里已是代码事实，不只是主张。**

一个安全立场已经埋进 `url()`：它读浏览器进程的导航记录，**不 `evaluate('location.href')`**——「问页面
等于问嫌疑人」。桌面 Engine 直接继承：它的「我在哪个应用/窗口」必须问操作系统窗口管理器，不问被控
应用自己。

### 轴 A —— 仍融在浏览器专用的 `PageDriver` 里

`Transport.driverFactory` 造出的 `PageDriver` 满口 `selector: string`，`findCard` 内部直接
`href.match(/\/explore\/([0-9a-f]+)/)`——它是**浏览器专用**接口，假设被控对象有 URL、DOM、CSS
selector、href。按两轴归类它的方法，能看清哪里还融着：

| PageDriver 方法 | 归属 | 说明 |
|---|---|---|
| `scrollOnce` `moveMouse` `back` `sleep` `scrollProbe` `goto` | 轴 B（Engine 原语） | 词汇无关，桌面 Engine 原样可实现（`goto` 除外，浏览器私有） |
| `openTarget` `type` `submit` `openItem` | **融合**（Engine 动作 + dom 定位） | 参数带 selector 的动作——将来拆成 `find(sel)→rect` + `engine.act(rect)` 的地方 |
| `findCard` `readViewport` `exists` | 轴 A（dom Locator） | 全部说 CSS selector |
| `readItems` `readState` `evalJson` | 轴 A（dom Observer） | `PACKAGE.md` §2.2 的 network/state/dom 观察者家族的 driver 侧 |

**这套词汇分两层**：只认选择器、像素和 URL 的那一半（goto / click / type / scroll / exists…）住在
`shared/browser-relay/page-driver.ts`，DSH 浏览器插件在没有 Stream 后端的机器上 import 的正是它；
认识卡片、字段表与 recipe 的那几格（`openItem`/`openTarget`/`readItems`/`readState`/`readViewport`/
`findCard`）在 `src/replay/actions.ts` 的 `PageDriver` 里（它 extends 前者）。加动词之前先判归属。

**两个 driver，一套词汇**：`makeExtPageDriver`（`browser-ext-drive.ts`，走裸 CDP）是**采集**用的那个；
`makePageDriver`（`browser-drive.ts`，走 Playwright）只服务**作者流程**——`record validate` 连开发者
自己起的调试端口 Chrome（`browser.ts` 的 `connectOverCDP`），采集运行时不经过它。两者产出**同一套
selector-based 方法**，即同一个 `dom` 词汇说的同一种语言。

### 「transport」这个词的两个高度

- **对象** `interface Transport` = Engine 轴，已做对：单一 seam，加一条 transport 是加一条
  `resolveTransport` 分支，不是改三处。
- **枚举字段** `transport?: …` = Engine 轴被限制在浏览器上的投影，**运行时没有任何代码读它**。
  只有装载点（`recipe-store.ts`）拿它把关：`'ext-cdp'` 接受但无效（写了也是冗余），`'cloak'`
  **装载即拒**（一份要求无人值守隐身浏览器的 recipe 悄悄拿到用户可见的那个，是值得当场失败的意外），
  其他值按拼写错误拒。**新 recipe 不要写这个字段。**

概念 → 代码对照：

| 本文概念 | 当前代码位置 | 现状 |
|---|---|---|
| Engine（轴 B） | `Transport`（`src/replay/transport.ts`） | **已对象化**：driverFactory/evaluate/screenshot/url/relayFactory/bringToFront 单一 seam |
| `ext-cdp` Engine | `resolveTransport` → `makeExtPageDriver` | 现有，且是唯一的浏览器 Engine |
| Perception Vocabulary（轴 A） | `PageDriver` 里带 selector 的方法 + observer 家族 | 只有 `dom` 一种，写死在方法签名里，未抽出 |
| `find → {rect, handle?}` | `findCard` / `readViewport` / `openTarget` 的组合 | dom 私有；未抽象成统一契约 |
| Engine 选择枚举 | `transport?: …` | 只在装载点把关，运行时无人读；新 recipe 不写 |

---

## 9. 今天还是空的那几格

**桌面走的是独立路径**（沿 http/html 的先例）：`host-desktop` Engine = `app/host-agent/` 的 Rust
进程（UIA/AX + enigo），经 `/api/host` WS 驱动 `DesktopDriver` + desktop runner
（`src/replay/desktop-*.ts`）+ `kind:'desktop'` recipe。**它没有动浏览器的 `Transport`/`PageDriver`**
——所以下面这两格空着**不是桌面落地的前提**，别以为要先补它们。

- **`Transport` 泛化到非浏览器**：`resolveTransport` 只产浏览器 `PageDriver`。桌面要进来是新增一条
  产出 `host-desktop` driver 的分支——seam 在，缺这条分支。
- **轴 A 抽出**：`PageDriver` 满口 selector，感知词汇写死为 `dom`。要让 `a11y` / `pixel` 进来，
  得把「定位/读取」从 selector 语言提炼成一根可声明的 vocab 轴（把 `openTarget` / `type` 这类融合
  方法拆成 `find(query)→{rect,handle?}` + `engine.act`）。
- **状态图的主循环**：`runToState` 仍**没有生产调用方**（见 §6.1）——今天接线的只有失败路径上
  「回头认一眼」那一段。桌面侧的 `DesktopPerception` 建好了，同样没接线。
- **`a11y` 的 Mac(AX) / Linux(AT-SPI) 后端**：等各自靶子出现再填，不凭空造。

**两个动代码时才有答案的形状问题**（不是抽象问题，用真实需求回答）：`handle` 的具体类型
（每种词汇/引擎私有，抽象只承诺「有或没有」）；浏览器 Engine 要不要改点击行为——`openTarget`
今天对 selector 做 trusted `.click()`（locate 与 click 融合、从不算坐标），而坐标点击与元素点击
的风控特征不同，「有 handle 走 trusted 元素点击」这条快车道保不保留，动代码时定。

**临时驱动**（不写 recipe、不产出 item）：`cdp_look`/`cdp_shot`/`cdp_act`/`cdp_pages` 的
`target: 'desktop'` 与 `'app:<进程>[/<标题>]'` 两档，与浏览器侧同一套动词、同一个 `expect`
做完确认。用法与坑见 `drive-live-ui` skill。

---

## 10. 交叉引用

- `docs/PACKAGE.md` §2 — Recipe 的概念、正交组成（session/steps/observers/output/policy）与验证术语。
  本文补齐它未展开的 Engine / Perception 两轴。
- `docs/ARCHITECTURE.md` — 业务模型；「Browser Recipe execution (session-backed T2)」一节描述
  recipe 在调度体系中的位置。
- `.claude/skills/write-recipe/SKILL.md` — 拟人采集运行经验的唯一真相源。
- **轴 B（Engine）的地基 spec**：
  - `internal design record` — 把采集路径的
    transport 抽象打通（`Transport` seam 的起点）。
  - `internal design record` — CP1
    Transport 对象化、CP2 look/shot 跨 transport、CP3 ext-cdp 持久交互 lane；用户原话「两种除了终端
    窗口和进程不一样，逻辑完全互通，抽象出一个接口两者复用」即在此。
  - `internal design record` — 为什么浏览器 Engine
    只有用户自己的 Chrome 这一个；后台标签**不拒绝**可信输入（由 focus 仿真接住，一帧都不用逼），
    所以前台从来不是可行性前提；`visibility` 只分 `unattended` / `interactive`（谁动手），
    采集一律不抢屏。
- **相邻的正交轴**：`internal design record` 的三轴
  （表达 code/data、分发 image/hot-drop、效应 read/write）是**能力治理**的切法，与本文两轴正交、不冲突；
  其效应轴是桌面写风险的约束来源（见 §2）。
- 相关记忆：`project_legal_red_line_no_signature_forgery`（红线）、
  `project_xhs_harvest_transport`（xhs 走哪条抓取路径的实战结论）。
