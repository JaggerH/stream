# 从零写一份 browser recipe（onboard-source 成本阶梯第 3–5 级的落地）

> 这是 `write-recipe` skill 的一个 reference，不是独立 skill。它只管**从零写出一份 recipe**
> （授权 / Tier 选型 / schema / 字段映射）。一条 recipe **跑起来之后**的事——管线怎么运行、
> 怎么观察、怎么修——回 `write-recipe/SKILL.md` 及它的 pipeline / observing / failure-atlas。

## Overview

`onboard-source` 成本阶梯的最贵三级（第 3 级页内重放 / 第 4 级 eval 自有客户端 / 第 5 级 DOM 采集）都落到这里。产物是一份可执行 **Recipe**（`src/replay/recipe.ts`），跑在一个保持一致浏览器身份的真浏览器引擎里，用户自己的登录态因此生效，用**页面自己的 JS** 复现站点的签名。运行期确定、零 token——**所有 AI 成本都在这里，在写的时候，一次。**

消费 `onboard-source` 的证据报告，但和它不同：入口决定数据**能不能拿到、怎么拿**；这里把"被签名 / 被登录挡"那种情况**编译成一份能跑的 Recipe**。

### Canonical runtime (read this before authoring)

A `kind:'browser'` recipe is the **canonical form** `CanonicalBrowserRecipe` (`src/replay/recipe.ts`): a declarative program of two lists over a session.

- **`session`** — `{ facility, laneKey?, lifecycle, visibility, keepAlive? }`. `keepAlive: true` (persistent only) exempts the lane from idle reaping, budget eviction and close-on-blocked — for a workbench tab whose every reload is an expensive full page load and that holds the user's own work (Photopea). Harvest lanes don't set it: idle reaping is their resource budget. Who owns the tab, whether it survives task leases, and **whether the user has to work through it himself** (`visibility: 'unattended' | 'interactive'` — §1). There is no browser to choose: every session runs in the user's own Chrome over the extension relay. (A leftover `transport: 'ext-cdp'` is accepted and does nothing; `transport: 'cloak'` is **refused at load** — `recipe-store.ts`.)
- **`steps[]`** — what you DO in the page: `scroll`, `evaluate` (call the site's own request client, paged by its cursor), `openTarget` (trusted click into a detail whose href carries an identity param), `click` (press ONE named element — see below), plus `goto`/`type`/`submit`, and `setFiles` (put local files into an `<input type=file>` via CDP — the browser reads the disk itself; big files never go through the control channel as data URLs, see `docs/PACKAGE.md` § Steps). Every step may carry **`expect`** (its verdict AFTER it) — including `locate`/`openTarget`, where it runs after their built-in open-confirmation and before the observers read, but **without** `retryEvery` (load-time error; they already retry via `fallbackUrl`/`maxScrolls`). **`settle`** (a gate BEFORE the action) is likewise taken by **every** step — `locate`/`openTarget`/`evaluate` included; undeclared it costs nothing. See §"操作表单的三件套".
  **`retryFrom` 排第二，不是第一**：`expect` 落空时 runner **先按状态图认一眼**——认出死路就立刻
  终止，认出有逃生口的障碍就清掉并**重做这一步**（每格最多一次），认不出才轮到 `retryFrom`
  整段重来。见 `SKILL.md` §2.1。清障重做的是"这一步"而不是"整段"，且不违反「不在同一趟里重走」：
  障碍在场意味着页面已经被替换，这一步根本没作用在目标页上，所以它没有副作用。
  **`retryFrom` / `retryTimes` 长在步骤上，不在 `expect` 里**（写进 `expect` 是装载期错误）：它管的是
  "这一步失败了怎么办"，而失败有两种——`expect` 的断言没满足，或这一步**自己的结果不合格**
  （`call` 的 `match` 没过）。后一种没有 `expect` 可挂：OCR 认完之后页面上没有任何东西可断言，
  而 `expect.selector` 是必填的，编一个出来就是把恒真判据写进去。代价实测过（2026-09-03 东财登录）：
  重试写在提交那一步的 `expect` 里，而识别失败在更早的 `call` 步——那一步永远跑不到，
  于是"会被 retryFrom 接住"这句注释描述了一个不存在的机制，流程当场终止、一次都没重来。
- **`click` 的 `synthetic: true`** — **不发真鼠标，页内 `el.click()`**。默认（不写）是可信点击。
  一次可信点击不是一个动作，是 **11 次往返**（1 次问位置 + 8 次拟人挪鼠标 + 按下 + 松开），
  而每个鼠标事件浏览器都要先做**命中测试**（这坐标下压着谁），命中测试要等一帧，后台标签
  没帧可等。活体同一轮的对照：`type`（键盘，不需命中测试）6 条命令 9–164ms；`click` 11 条
  命令 **7.0–35.1 秒**。开了之后：**35s → 4ms**（东财登录整条 70s → 6.3s）。
  **判据不是「这站看起来正不正规」，是「它查不查我们的手势」** —— 可信点击存在的理由有活体
  代价背书（groq 建 key，人手点过 Turnstile、瞬移点过不了）。判不出来就别开：默认那档只是慢，
  开错了是点击被静默忽略。只配在**有 `expect` 盯着结果**的步骤上，让它以"判据没满足"暴露。
- **`call`** — 问外面一件事，把答案绑成参数（截图 → 识别服务 → 填回输入框）。三条焊死的边界见
  `src/replay/recipe.ts` 那一格头注。可以带 **`options`**：recipe 里写死的**字面量**，原样并进
  请求体，用来让通用服务换个档位跑（`{ "charset": "0123456789" }` 让 OCR 只在数字里挑——
  **限字符集是通用机制归服务，限成哪一套是站点知识归 recipe**；东财验证码实测 17/20 → 20/20）。
  **引擎绝不对 `options` 做 `{param}` 插值**，装载期直接拒带花括号的值：参数袋里装着宿主注入的
  凭据，能引用它就等于给了第三方 recipe 一条外泄路。
- **`extract`** (optional, recipe-level) — the ONE thing a recipe writes back into Stream: a value visible only once (a freshly created API key) captured into this Source's own `runtime_config` secret. Contract + guards: `docs/PACKAGE.md` §2.2 (Extract). A recipe may legitimately produce **zero items** when its whole output is that secret (`observers: []` + `allowEmpty`).
- **`observers[]`** — what you READ: `network` (passive XHR interception), `state` (read a `window` global), `dom` (read rendered cards). Each has a `trigger` (`entry`/`after-step`/`final`) and an optional per-observer `input` mapping.
- **`output`** — the accumulator core every observer/step feeds: `itemsAt` / `dedupeBy` / `targetCount` / `mapping` / `assert`.
- **`loginCheck`** — two-signal (`loggedIn` + `wall`).

The runtime that runs it:

- `RecipeRunner` (`src/replay/recipe-runner.ts`) — walks `steps`, drives login-wall probes, and owns the `evaluate`/`openTarget` step loops.
- `ObserverPipeline` (`src/replay/observer-pipeline.ts`) — composes the `network`/`state`/`dom` observers and merges their items by output identity.
- `SessionRecipeExecutor` (`src/replay/session-recipe-executor.ts`) — the bridge: acquires a facility session lease, takes the one `Transport`, and hands its `(driver, relay)` to the runner. It never touches focus — harvest does not steal the screen.
- `PageDriver` (`src/replay/actions.ts`) — the drive contract. **Two implementations, and they are not two browsers to choose between:** `makeExtPageDriver` (`browser-ext-drive.ts`) is the one harvesting rides; `makePageDriver` (`browser-drive.ts`, Playwright over `connectOverCDP`) serves **only the authoring CLIs** (`record validate`, which replays the legacy form). Changing the `PageDriver` contract still means implementing it on both.
- `ObserverRelay` (`observer-pipeline.ts`) — the network contract; `ExtRelay` (CDP over the extension) is the only implementation.

> **DELETED — do not author these.** The old `harvest: { mode: 'eval'|'dom'|'state'|'xhr' }` block, the `actions` array, and `runRecipe`/`runRecipeC`/`EvalHarvest` engine surfaces are the **legacy `BrowserRecipe`** shape. A canonical recipe has NO `harvest`/`actions` keys — it has `steps`+`observers`+`output`+`session`. (`FetchRecipe`, `kind:'fetch'`, is a separate, still-valid cheapest sub-rung — pure in-page `request`/`pagination` replay with no session. The HN example below is one.)

---

## 1. FIRST decision — render-independent or not (Tier A vs Tier B)

Before you pick a harvest method, decide which tier it lands in. One axis governs everything: **does the capability need the page to actually paint?** Author in Tier A whenever the site allows it — a Tier-A recipe never has to think about frames or focus.

| Tier | Capabilities | What it costs |
|---|---|---|
| **A — render-independent** | `evaluate` step (call the site's own request client) · `state` observer (read a `window` global) · `network` observer **when the request is fired by an `evaluate` step** | Runs in a background tab at full speed. **Prefer here.** |
| **B — needs trusted input and/or live render** | `scroll` · `openTarget`/click · `type`·`submit` · `dom` observer (`readItems`) · `network` observer **when it depends on scroll to make the page emit the request** | 可信输入那一半同样能在后台跑：lane 建好就开 focus 仿真、鼠标事件不等回执，隐藏 tab 一次可信点击 0.19–0.33s。**采集 driver 一帧都不逼**（实测：动作位不需要帧；xhs 的懒加载在后台标签里照常跑）。**要真帧的只剩 `settle`**，它不吃这条开关的红利。**但"下一批要不要真帧"是站点差异**——写 scroll + dwell 型 recipe 时这一格要自己现测，见 `session-runtime.md` 的 `visibility` 与「为什么今天一帧都不逼」。 |

> **Tier B 不是要前台的理由。** 现有 recipe **全部是 `unattended`**（`douyin-search` 只有
> `scroll`；`xhs-search`/`xhs-detail` 要可信点击 + 真帧，也照样 unattended）。`interactive` 只有一个用途：
> **让用户亲眼看着**、**用户主动按下的那一次**——定时采集抢用户的屏是灾难。
>
> **一个例外**：有些**站点自己**读 `document.visibilityState`，看见 `hidden` 就干脆不运行（Turnstile
> 这类人机验证控件实测如此——控件根本不渲染，token 恒空）。那不是"压着不产帧"，**没有帧可逼，因为
> 它没开始**；但连这一类也不用占前台，focus 仿真会让页面读到 `visible`，见 `human-verification.md` §1。

---

## 2. Driver capability matrix

`PageDriver` is assembled from OPTIONAL methods — a driver that lacks one **cannot run a recipe that needs it** (the runner throws `recipe requires <X> capability`). Harvesting has exactly one driver; the Playwright column is the **authoring** arm (`record validate` on the legacy form), listed because changing the contract means implementing it twice:

| Capability | Used by | **harvest** (`makeExtPageDriver`, ext-cdp) | **authoring only** (`makePageDriver`, Playwright) |
|---|---|---|---|
| `scrollOnce` | `scroll` step, `openTarget` scroll-to | ✅ trusted CDP `Input.mouseWheel`（不逼帧） | ✅ `mouse.wheel` |
| `evalJson` | `evaluate` step | ✅ `Runtime.evaluate` (awaitPromise) | ✅ `page.evaluate` |
| `readState` | `state` observer | ✅ (in-page `JSON.stringify`) | ✅ `page.evaluate` |
| `readItems` | `dom` observer | ✅ `Runtime.evaluate` | ✅ `page.$$eval` |
| `openTarget` | `openTarget` step | ✅ CDP trusted click at the card's rect centre | ✅ locator click (href-contains-identity) |
| `currentUrl` | persistent-tab re-entry guard | ✅ | ✅ `page.url()` |
| **`ObserverRelay`** | `network` observer | ✅ `ExtRelay` — CDP `Network.getResponseBody` | ❌ none — **a canonical `steps`+`observers` recipe does not run on this arm at all** |

---

## 3. Footgun checklist

1. **后台 tab 的可信输入不用你操心**：lane 建好就开 focus 仿真，隐藏 tab 的可信输入照常落地，**一帧都不用逼**（逼过，2026-08-15 实测摘掉对产出零影响）。**别因为"要可信点击"去要前台。** 但**要真帧的步骤是另一回事**（截图 / `settle`），focus 仿真救不了，见 `session-runtime.md`。**尤其：你这个站的"下一批"是不是要真帧，必须现测**——douyin 走站内直调之前要（摘掉心跳就少一整批），xhs 不要，**没有通用答案，而且 driver 不替你产帧**。
2. **CDP 的 body 有到达时刻。** The observer tolerates a failed body read (`try/catch` → diagnostic note), so one missed body is not drift — but on a recipe whose only matching XHR is that body, "tolerated" reads as **`recipe produced no items`**, so check the notes before blaming the site.
   `Network.responseReceived` 只表示**响应头**到了；此刻 `getResponseBody` 会回 `-32000 No data found for resource with given identifier`（DevTools 认得这个 requestId，只是缓冲区还没有内容）。body 可读的信号是 `Network.loadingFinished`——pipeline 就是在它上面读的。**不要把这条 -32000 归因成"缓冲被逐出"**（那是它的另一个成因，方向完全相反：一个是读早了，一个是读晚了）。判据是响应体大小与站点相关性：body 小的站点（xhs feed）在响应头时刻读常常侥幸成功，body 大的（douyin 搜索结果 JSON 大几百 KB）**100% 失败**——"换个站就恒挂、老站一直好好的"正是读早了的签名，逐出则应表现为随机抖动。
3. **Body field-casing differs by method.** A `network` observer reads the site's **raw wire body** (xhs: snake_case `note_card` / `xsec_token`); an `evaluate` step reads the site's **SDK-transformed** shape (camelCase `noteCard` / `xsecToken`). **Switching a site from `evaluate` to `network` changes every mapping dot-path** — calibrate against a live intercepted body, never from memory.
4. **Reactive-store serialization.** V8 `returnByValue` hands back `{}` for a Vue/MobX Proxy — you must `JSON.stringify` in-page (that is what `readStateExpr` does). A V8 issue, so it bites on both driver arms; unconditional.
5. **`dedupeBy` is a RAW-item path (pre-mapping).** It keys the site's nested item *before* mapping (xhs: `id`, not the mapped `noteId`). Wrong path → every item dropped as "missing id" → a **silent 0-count `ok`**. Same for the `output` and each observer `input`.
6. **`visibility` 问的是「这次运行要不要用户伸手」，不是「能不能跑」，更不是「想不想看」。** `unattended` = 采集，后台标签，**永不抢屏**（`unattended` + `scroll` 完全合法——douyin-search 就是）；`interactive` = 用户得亲自动手的流程（登录、扫码、自助建 key），开在他眼前。采集链路一层都不碰焦点；把窗口提到最前只发生在用户显式要求时（`focusFacilityTab`）。开发期想看着它跑**不是**改这个字段的理由——用 `RECIPE_PROBE` 和 `data/failures`。
7. **`goto` readiness timing.** CDP `Page.navigate` acks *before* the document exists (the driver polls `readyState`). `driver.goto` hides that by honoring `waitUntil`, but a recipe must not assume the page is ready the instant `goto` returns — gate on a `loggedIn`/content selector, not a bare nav.
8. **`PageDriver` is assembled from OPTIONAL methods.** A driver missing one cannot run recipes needing it → the capability matrix above is load-bearing, not decoration.

---

## 3.5 操作表单的三件套：`click` / `settle` / `expect`

Feed 词汇（滚 + 打开第 N 条）写不出"填一个表单并提交"。这三样是补上的那部分，**每一样都是活体逼出来的**，
不是设计出来的。写这类 recipe 前把三个坑读完，能省掉一整晚。

### `click` — 按下一个具名元素

与 `openItems`（打开信息流第 N 条）是两件事。可带 `position: {x, y}`（相对元素 rect 左上角的 CSS px，
省略 = 中心），字段名与语义取自 Playwright 的 `locator.click({ position })`。

> **坑 1：`click` 点的是第一个匹配 —— 类型选择器会咬人。**
> `button[type=submit]` 在 `console.groq.com/keys` 第一个命中的是 **「Sign Out」**。这份 recipe 跑起来
> 会把用户签退，而不是建 key。**优先 `data-testid` / 唯一 id，别用类型或标签选择器点按钮。**

> **坑 2：中心点对某些目标就是错的点。** Turnstile 的 widget 是 300×72，复选框在最左侧方块区、
> 中间是文字 —— 点中心 12 秒无反应，点左侧一秒过。`position` 就是为这个存在的，不是调优旋钮。

### `expect` — 这一步的**判据**（动作之后）

`{ selector, state?: 'present'|'gone', countIncreases?, alreadyThere?, timeout?, retryEvery? }`。
语义抄 Playwright 的 `waitFor({ state, timeout })`。没满足就**在这一步断掉**，报出真实步骤下标 + 本步观测。

> #### 判据必须有**区分力**：动作前为假，动作后为真
>
> **一个动作前就已经成立的 `expect` 是恒真的** —— 它永远不会失败，所以它看起来像监督、实际是装饰。
> 这不是"不够严谨"，是**这一步从此没有监督**：动作没生效也照样判过，失败会在几步之外以一副
> 无关的面孔出现。
>
> 活体代价（2026-07-30，`zhipu-create-key`）：建 key 那步的判据写成「表格最后一行有复制图标」，
> 可列表里本来就有一把旧 key、那图标一直都在。于是「确定」根本没建成也判过，下一步点到了**旧那行**
> 的复制按钮，整件事最后报的是两步之外的「抽取命中 0 处」。**四步全绿、结果全错、报错指向错的地方。**
>
> 引擎替你守这一条（`actions.ts`）：动作**之前**多读一次，已经成立就当场断
> （`StepExpectVacuousError`），而且断在动手之前 —— 判据都不成立，就别再去改页面状态了。
>
> - **「多了一行 / 多了一个」用 `countIncreases: true`**，不要用 `present`。动作前数一次命中数，
>   之后等它**严格变大**。这类结果用 `present` 表达必然恒真：那个选择器本来就命中着旧的那些。
>   trace 里会记 `2→3`，一眼看得出它真的动了。
> - `alreadyThere: true` 是显式豁免，**极少数才该用**。想用它之前先问一句：我是不是其实需要
>   `countIncreases`？多数"它本来就在"的场景，真正想判的就是"它变多了"。
>
> **这条规则的来历值得记一下**：同一次会话里，手动用 `drive-live-ui` 驱动那一路，每一步都在监督
> —— 数选择器命中数、看可见性、点完读一遍表格行。写成 recipe 的时候监督被丢掉了。
> **recipe 是把手动步骤固化下来，监督必须跟着一起固化**；只固化动作、不固化判据，就是把一段
> 本来看得见的流程变成了瞎跑。

- 叫 `present` 不叫 `visible`：判据是 `driver.exists`（挂没挂上），**不是 CSS 可见性**。
- `gone` 常用：Turnstile 过了之后那个隐藏 input 直接从 DOM 移除。
- **别把等待焊到 `click` 的 timeout 上** —— 等的不是自己那次点击，是它引发的结果。
  "提交按钮要等 token 到手才渲染"属于 `expect`，不属于 `click`。
- `retryEvery` 只能用在 `click`/`type`（装载时就拒别的）：重做一次有副作用的动作不叫重试。
- **`locate` / `openTarget` 也吃 `expect`**，位置很讲究：跑在这两步**内建确认**（打开后看 URL 带不带
  identity，不成就回落 `fallbackUrl`）**之后**、`observers` 读**之前**。内建确认答的是「打开了没」，
  `expect` 答的是「打开的是不是我要的那个」。在 observers 之前是硬要求 —— observer 从错的页面上读走的
  是**真数据、只是来自别处**，这类错没有任何症状指向它。走 `fallback-nav` 回落时**照样跑**：判的是最终
  状态，不是走哪条路到的。
- **但这两类不吃 `retryEvery`，装载时直接报错**（不是静默忽略）：`locate` 已经有 `fallbackUrl` 兜底
  （重做一次 = 重新滚动定位 + 一次拟人点击，humanize 是这条路径的耗时大头），`openTarget` 已经有
  `maxScrolls` 重试循环。要放宽只调 `expect.timeout`。

### `settle` — 动作之前的**闸门**（这一条是这三件里最反直觉的）

`{ selector, stableFrames?, intervalMs?, timeout? }`：等那块区域**画完并停住**再动手。
判据是**"变过了 + 停住了"**，逐帧比裁剪后的 JPEG **字节** —— 不解码、不存参考图、不联网。

**什么时候需要它**：目标"就绪没有"**从 DOM 里根本看不出来**。实测 Turnstile：对话框打开后
DOM 连续 **9.3 秒一个字节不动**、`window.frames.length` 也不动，而这 2 秒里复选框正从
「空」→「转圈」→「可点」。**页面不肯说，但它在画。**

> **坑 3：早点不是白点，是有害的。** 在 widget 就绪之前点下去会把它打进失败态，之后重做 8 次
> 全废。所以这里必须是"等到"，不能是"先试试再说" —— 这也是为什么 `retryEvery` 救不了这个场景。

截哪里由 DOM 的 rect 给：**DOM 说在哪，画面说什么时候**。各自干自己能干的事。

**哪些步骤收 `settle`：全都收**，`locate` / `openTarget` / `evaluate` 也在内（编排层在每一步动手
之前统一过这道闸门）。`locate`/`openTarget` 干的事就是"点一张卡"，虚拟列表还在重排时点下去、点着的
往往是别的卡——这道闸门对它们和对 `click` 一样适用。`evaluate` 不操作页面、只调站点自己的 JS，
**通常没必要声明**。不声明 = 一次驱动调用都不发生的空操作，也不占一行 probe；声明了才多一行
`step#N settle`（它最长能等 15s，不给行就会把这段墙钟悄悄记到下一个阶段头上）。

> `settle` 与 `expect` 都由**编排层统一接一次**，对每种步骤一致生效。加能力时别在各分支里各接
> 一遍：漏接的那一支不报错、不报警，只是**不干活**（写在 `locate`/`openTarget` 上照样加载通过）。

---

## 4. 只有一个浏览器 —— 你要选的是 `visibility`，不是 transport

采集跑在**用户自己的 Chrome** 里，经扩展中继（`ext-cdp`）。没有第二个浏览器可选，所以**没有"先在 CDP 上写、写完翻到生产"这一步了：你调试的那个浏览器就是生产的那个**。理由一句话：用户自己的 Chrome **本来就是**一个真人的浏览器，没有东西需要伪装、下载、管 profile 或对指纹。

`session.transport` 因此退役：`'ext-cdp'` 收下但什么都不做，`'cloak'` **装载即拒**并指出迁移动作（删掉这个键，或写成 `'ext-cdp'`）——不是静默忽略，因为"要一个无人值守的隐身浏览器、结果悄悄拿到用户看得见的那个"是值得当场失败的意外（`src/replay/recipe-store.ts`）。

剩下的那个选择是 `session.visibility`：

- **`silent`**（默认档，**包括要可信点击的 recipe**）— 后台标签，不抢焦点。Tier A、Tier B 的可信输入都零额外代价（focus 仿真兜住，见 `session-runtime.md`）。
- **`interactive`** — 用户得亲自动手的流程（登录、扫码、自助建 key），标签开在他眼前。**采集没有这一档**：`xhs-search` / `xhs-detail` 要可信点击，也照样 `unattended`。（要真帧的步骤别靠改这个字段去救——`interactive` 也只是把标签开在前台，窗口被盖住照样没帧。）
- **`debug`** — 显式可见，调试用。

站点"只允许一个登录会话"（xhs）**正是用用户那个浏览器的理由**：只能有一个会话，就该用他已经登着的那个，而不是另养一个跟它抢。

---

## 5. Choosing a harvest method

Guided by Tier A first (§1). All run in the logged-in page; they differ in **where the data is read**.

| Method | Read from | Tier | When |
|---|---|---|---|
| **`evaluate` step** | the site's **own request client** called in-page (its interceptor assembles every signed header → byte-identical → passes risk control) | **A** | rebuilt request is flagged by risk control (a valid signature still rejected — e.g. xhs `X-S-Common` → `300011`) **and** a callable request client is reachable. Richer JSON than the DOM, render-independent. **The winning move on a signed site.** |
| **`state` observer** | a JSON blob the site already SSR-rendered onto `window` (e.g. `__INITIAL_STATE__`) | **A** | the entry page server-renders the items into a global. One read, no scroll (xhs-detail). |
| **`network` observer** | the site's raw XHR response body, matched by `urlPattern` | **A** if the request is fired by an `evaluate` step; **B** if it needs a scroll to fire | the body is usable JSON and you can make the page emit it. Reads snake_case wire shape (footgun 3). Worked example: `packages/douyin/douyin-search.recipe.json` (scroll-fired, `silent`). |
| **`dom` observer** | rendered feed cards via `readItems` | **B** | body is truly ciphertext / no request client reachable, but the DOM shows items. Last resort. |

Finding the site's request client (for an `evaluate` step): grab the webpack require via `webpackChunkxhs_pc_web.push([[id],{},r=>req=r])`, scan `req.m[id].toString()` for the endpoint's readable fn name (e.g. `postApiSnsWebV1NoteLike`), then scan the module's exports for the fn whose source names the endpoint path. **Never hardcode the module id or export letter** — key off a semantic string so it survives re-minification. Worked examples: `packages/xhs/xhs-like.recipe.json` (an `evaluate` step doing exactly this) and `packages/xhs/xhs-detail.recipe.json` (a `state` observer).

---

## 6. Core rule — the precondition gate

这一整套只在三条同时成立时用：(1) 确实需要一个稳定 Source；(2) 数据站外取不到（被签名 / 被登录挡——onboard-source 判定"站外复现不了"）；(3) 用户自己登录着的页面能通过内部 XHR 看到它。

接口能直连 → **停**。那是 `onboard-source` 更便宜的级别。只有被签名 / 被登录挡的站才值得一份 browser recipe（最贵的那级）。

## 7. Workflow

Read `references/authoring-loop.md` (source of truth) and fill `references/recipe-template.md`. In brief:

1. **消费入口的证据** —— 你是被 `onboard-source` 派发到这里的，它已经跑完 XHR 捕获侦察、选好了方法。读它的证据报告：数据 XHR（DOM 采集则是"body 不透明、条目在 DOM 里"）、入口 URL/host、入参契约、分页。**不要重抓**——侦察归上游。（没带报告就先回去跑 `onboard-source`。）
2. **Pick the tier + method** (§1, §5). Default to a Tier-A `evaluate`/`state`/eval-fired-`network` recipe so it never has to pay for frames.
3. **Author the recipe** — `session` (facility/lifecycle/**visibility**), `steps`, `observers`, `output` (`itemsAt`/`dedupeBy`/`targetCount`/`mapping`/`assert`), `loginCheck` (two signals), `entryUrl`/`entryWait`/`cookieDomain`. Set `meta.description`.
4. **Validate live** — trigger a harvest against your own logged-in Chrome via the extension relay; confirm items return and page 2 works. There is nothing to "flip to for production": harvesting runs in that same browser, so what you debugged IS what ships. (Legacy `kind:'fetch'`/`actions`+`harvest` recipes still validate via `record validate <sourceId>` / `runValidate`, which drives a Chrome you started with `--remote-debugging-port=9333`; the canonical `steps`+`observers` form runs through `SessionRecipeExecutor` and is exercised by triggering a harvest.)
5. **Save** — 放哪由形态决定（源码检出 `packages/<facility>/`，npm 装的
   `<dataDir>/recipes/<名字>/`，判据是 `GET /api/recipes/local`）：**唯一的说法在
   `recipe-template.md` 的「写完的 recipe 放哪」**，别在这里另立一份。源码检出里就是
   `packages/<facility>/<sourceId>.recipe.json`（**后缀必须是 `.recipe.json`**，扫描器只认它），
   写之前先过 `validateRecipe`。The `meta` block makes it a Source (the manifest is synthesized by `recipeToManifest` — set `meta.description`; no `manifests.yaml` to write).

## 8. Enhancing an existing recipe (re-capture IS allowed here)

Section 1's "do NOT re-capture" is for authoring a NEW recipe (the router owns recon). When you're fixing a recipe that already runs — a field maps wrong, a nested object comes back empty, the site changed — **re-capture the live response instead of guessing new dot-paths from memory.**

Re-capture through the browser (a bare host curl cannot — see the red line below). **两种形态、
完整步骤和实测坑都在 `capturing.md`**，这里只说这一步要什么：拿到真实的请求（url/method/body）
和真实的回包，照着它对 dot-path。

- 只装了 npm 包 → `cdp_*` 那三步（开+装拦截器同一次调用 → `cdp_act` 触发 → 读回来）。
- 有源码检出 → 还可以用 `scripts/recipe-capture.ts "<entryUrl>" "<urlSubstr>"` 把**完整 JSON
  body** 落到 `data/capture-dump.json`——控制台预览截断在 400 字符，嵌套对象看不全，这是脚本
  唯一比 MCP 那条省事的地方。（`scripts/recipe-dom-capture.ts` 对 DOM 结构同理。）
- **Login-gated capture needs no cookie plumbing:** it is YOUR browser, so whatever you are logged into is what it captures. To capture as some OTHER session, set `COOKIE_HEADER` + `COOKIE_DOMAIN` yourself — there is no endpoint to curl a cookie out of Stream (the credential broker was retired 2026-08-07; the host hands credentials down, nothing asks the host for them).
- **Not in the container:** capture/validate drive the browser on your machine, not one inside the backend container (there is no browser in that image any more). Run them with a host `pnpm exec`, never `docker exec`. Point them elsewhere with `STREAM_AUTHORING_CDP_URL`.
- **Casing after a method switch:** if you moved a source from an `evaluate` step to a `network` observer (or back), re-capture — every `mapping` dot-path changes case (footgun 3).

❌ **Never bare-curl a signed / gated XHR from the host to "just check the shape".** A request-signed / WAF-gated endpoint (e.g. xueqiu behind Aliyun WAF) returns a challenge or login HTML page to raw curl, not JSON — that IS the reason it's a browser recipe. Only the in-browser capture above sees the real body.

After fixing the mapping: bump the recipe `version`, restart the backend to reload it, then re-harvest. Dedup is by item guid, so **existing stored items are NOT backfilled** — clear the affected items (or wait for new ones) to observe the change.

## 9. 给包写 `states.json`

`steps[]` 回答"怎么走"，`states.json` 回答**"走不通的时候我在哪"**。文件放 `packages/<id>/states.json`，
形状与拒载判据是契约，写在 `docs/PACKAGE.md` §2.10；运行时怎么用它见 `docs/ENGINE.md` §6。
这一节只讲写的手艺。

### 什么时候值得写

- **这个站有好几个界面要认**：结果页 / 空结果 / 登录墙 / 版式 A、B。`expect` 只会说"不是预期"，
  说不出"那是什么"，于是只能失败。
- **有障碍页要清**：出来一张验证/风控页，点一下或等一下就能回去。写成一个状态 + 一条逃生口
  `transition`（`to` 省略 = 没有目的地，清完重认），runner 会清掉它再**重做那一步**。
- **有彻底走不通的那一格**（账号被封、地区限制）：写成 `deadEnd`，认出就立刻停——
  区分「再等等就好」和「再等也没用」，比认出「这是什么」更值钱。

不值得写的：只有一个界面、失败就是失败的源。一张半对的状态图比没有更坏。

### 每个状态怎么挑特征

- **便宜且可重放优先**：`url` > `dom` / `a11y` > `text` > `image`。网页侧 `url` 近似免费；
  `image` 扛不住明暗主题切换（那是反色，重录参考图是它的固有边界）。
- **判据是"只匹配当前页"，不是"能描述当前页"**。同一个站两个页面长得像是常态，所以特征要整组
  唯一：单条不够、两条合起来唯一是完全正当的写法。
- **`absent` 是一档，不是补充**。「已登录」最可靠的判据往往是「登录按钮不在了」；互斥也靠它撑开
  （CF 的 `js-challenge` 必须声明「Turnstile 容器**不在**」，否则挑战页上两档一起命中）。
- **同组互斥用 `group`**。**省略 = 落进空串那个默认组，含义是「和所有人互斥」**——这是最危险的
  默认：CF 拦截页同源返回、URL 一个字不变，你那些靠 url 认的状态在封禁页上照样为真，不写 group
  就会和 CF 三档判成撞车。一个屏上同时成立好几个状态是正常的，跨组并存不是错。
- **别拿背景色当特征**（跟随系统主题，跨机器不可移植；类型上拦不住，靠 review）。

### 怎么验

1. **装载这一关**：后端重载，包能装上就说明 `states.json` 过了校验（空特征、id 重复、缺
   `<facility>/` 前缀、转移指向不存在的状态、死路又有出口——任一不过是**整包拒载**，
   后端日志里点名是哪个包、哪一条）。
2. **认没认出来**：跑一趟让它落到失败路径上。认出死路或障碍时 outcome 会翻成 `challenged`、
   reason 里带状态名，probe 的 `recipe` 频道能看到 `escape step#N`。
3. **硬证据在观测账本**：`identify()` **成功**才记一笔，`<dataDir>/state-observations/<facility>.json`
   里出现你的状态 id + 当时为真的特征键，就是它真被认出来过（顺带也是区分度闸日后比对的底料）。
4. **一个都没认出来**会开一个介入 run（运维页「源健康」→ 该源的修复页，历史一栏）——那本身就是"这张图还缺一格"的信号，
   里面有当时的截图和元素表可以照着补。

### 学到的那层怎么升格进包

接受 AI 提议写的是**本机学到的**那层（`<dataDir>/state-graphs/<facility>.json`），随 data 走、
不随包分发。一条在你机器上稳住了、想让所有人都有：**手工搬**——把那个状态从学到的文件里复制进
包的 `states.json`，**去掉 `proposalId` / `acceptedAt` 两格**（它们只是来源记账，包里的状态没有
这个概念），然后把学到的那份里的原条目删掉——**两层 id 撞车会让本地图装配直接抛错**，
executor 单独兜住它（日志 `[state] 本地状态图装配失败`，本趟退化成只用内置全局图、采集照跑），
所以症状不是红灯而是「这个源忽然一个状态都认不出」。

## Guardrails

- **Credential hygiene.** Prove the flow on a neutral public target first; bring the user's own session (e.g. xhs) only once the mechanism is green. Single session, human cadence — it is the user's own account, personal-scale use. The session lives where it always did: in the user's own Chrome (or, for the HTTP rung, in the broker). **Never in the recipe, never in an image.** A recipe is shareable code-as-data — anything you paste into it ships to whoever imports it.
- **Recipe = data, not code.** If the site needs behavior the schema can't express, extend `recipe.ts` + the runner/observers; never smuggle logic into a recipe.
- **Authoring only.** Nothing here runs at runtime; the `replay` adapter executes the saved recipe deterministically, zero tokens. Repair (re-authoring on drift) reuses this exact loop under a token budget.

## Resources

- `references/authoring-loop.md` — the full step-by-step procedure + a worked HN example (source of truth).
- `references/recipe-template.md` — the Recipe output artifact: annotated canonical skeleton, observer/output shapes, `entryWait` decision table, DataItem mapping targets.
- Code it drives: `src/replay/recipe.ts` (`CanonicalBrowserRecipe`/`RecipeStep`/`RecipeObserver`/`RecipeSessionSpec`/`RecipeOutput`), `src/replay/recipe-runner.ts` + `observer-pipeline.ts` (run it), `src/replay/session-recipe-executor.ts` (drives a lease), `src/replay/transport.ts` (the one seam: launcher + driver + network relay + `bringToFront`), `src/replay/browser-ext-drive.ts` (the harvest driver — note it forces no frames at all), `src/replay/browser.ts` (the authoring-only Playwright half — read its header for why there is no Stream-owned browser), `scripts/recipe-capture.ts` (capture), `src/replay/recipe-store.ts` (`validateRecipe` + the retired-transport rejection).
