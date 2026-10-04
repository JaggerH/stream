# 运行模型：账本 / 定位 / 落脚点

改这条链路的行为之前必读。代码锚点：`src/replay/feed-ledger.ts`、`src/replay/recipe-runner.ts`、
`src/replay/actions.ts`。

---

## 1. 账本从哪来：一次 feed recipe 运行

**没有"浏览会话"这一层**——没有 `Browse Task`、没有有状态的浏览对象，一次 recipe 运行就是全部：

```
一次 feed recipe 运行（xhs 现在是 xhs-search）
  → 持久 lane 的标签整页导航到这次的入口（搜索词变了 = 换一页）
  → 采到的这一批，按产出顺序 = 页面上卡片的铺排顺序
  → 整本替换这条 lane 的账本（FeedLedger）
detail（xhs-detail，rideCurrentPage）
  → 骑同一个标签，拿这本账本当坐标系 locate + 可信点击
lane 关掉（显式收尾 / 闲置回收）→ 账本一起丢
```

**谁建账本由 recipe 自己声明**：`ledger: { idField }`（见 `docs/PACKAGE.md` §2.2）。引擎不认 sourceId，
只按声明记账——"哪个字段是身份"是站点知识，属于 recipe 这份数据。

**关键语义，改之前先看懂：**

- **整本替换，不是追加。** 一次运行 = 那个标签被换成了这一批；旧账本描述的是一个已经不存在的
  页面，追加只会让坐标系错位。
- **`targetCount` 在续抓（`rideCurrentPage`）时是"增量"，不是"累计"。** 那一次运行的 network
  observer 从零开始，只看得见**这次新触发的** XHR。填累计值 → 永远达不到 → 滚到天荒地老。
- **账本按产出顺序排，只去重不重排。** 顺序即坐标系（见 §3）。

## 2. 账本（ledger）是脊椎

一本账本 = 一条 lane 的 `string[]`（有序身份），`FeedLedger` 按 `(facility, lane)` 存，进程内。

它同时扮演两个角色：

| 角色 | 谁用 | 坏了会怎样 |
|---|---|---|
| detail 定位卡片的**坐标系** | `locate` step（`orderedParam` 收下这一份；调用方没传时运行时按 facility 从 `FeedLedger` 自动填） | 定位失败 → 全量 fallback-nav |
| "这条 lane 的页面现在铺着什么"的唯一记录 | 收尾/回收（标签没了就丢） | 拿一批不存在的 id 去找，白烧一轮再 fallback |

**"账本和 DOM 对不齐"会表现成毫不相干的症状**，很容易被当成几个 bug 分头修。
一眼判据：`locate` 探针里 `known=0`（视口里有卡，但一张都不在账本里）。

**身份是从卡片链接里抠出来的**（`src/replay/card-id.ts`：路径最后一段、长得像 id 的十六进制串），
**不认站点的路由名**。同一条笔记在不同入口下的路径不同（`/explore/<id>` vs `/search_result/<id>`），
写死路由名的后果就是 `known=0`——匹配只认 id，不认路由。

**对不齐的三个真实成因：**
1. **首屏 SSR 那批没被采到**（见 SKILL §3 不变量 3）→ 账本从"第二批"才开始，页面顶部那一大片
   我们不认识。表现为 `known=0` 且目标卡的 docY 大得离谱。
2. **feed 被换了一批** —— 有第二个东西动了这个 tab，或站点在 back-nav 后重新拉取了推荐。
3. **根本没有账本** —— 用户直接从收件箱点开一条旧笔记（没搜过 / 标签已收），或那份 feed recipe
   压根没声明 `ledger`。`ledger=0` 是这一档的判据（探针那行分得清 `ledger=0` 和 `known=0`）。
   这是**降级不是故障**：locate 立刻 MISS，走 `fallbackUrl` 整页导航，数据照出。

## 3. locate：把目标卡片弄进视口，然后可信点击

`locateCard` (`src/replay/actions.ts`)。**看 → 动 → 再看**，每轮重新测量，所以估错会被下一轮纠正
而不是累积。move 的依据按优先级三档降级：

1. **直接读**（常态）。加载过的 feed 通常把滚出视口的卡片**仍留在 DOM 里**，目标 anchor 就在那儿、
   带着真实 `boundingRect` → 一次查询拿到它的绝对 `docY`，一步滚过去。**不需要账本。**
2. **外推**。卡片确实没渲染（真·虚拟列表）→ 用视口里"认识的卡"最小二乘拟合 `账本index → docY`，
   外推目标位置。
3. **回顶逐屏滚**。视口里一张认识的卡都没有（feed 换了）→ 回顶，逐屏往下扫。

**移动方式：** 超过一屏用 `scrollTo` 直跳（已超人类滚速，没什么可模仿的）；一屏之内用**真实滚轮**——
点击前最后一个手势要像人。点击本身必须是 trusted click。

**两个必须保留的细节，删了就坏：**
- **每次移动后要 dwell。** feed 是异步重渲染的，移动后立刻读视口读到的是**旧卡**，看起来像"没动"。
- **空视口不是终态。** 重渲染期间读到 0 张卡是常态。要容忍连续几次空读，只有**一直**空才是"这不是 feed"。

**验收判据（唯一）：** probe 里 `step#0 open` 必须是 `locate+click`，不是 `fallback-nav`。

## 4. fallback-nav 是安全网，不是正常路径

定位失败会退化成"直接导航到详情 URL"。它**能出数据，所以不会报错**——这正是它危险的地方：
定位早就全线崩了，指标上却是绿的。**任何时候看到 fallback 比例上升，都当作故障处理。**
（而且它有副作用：导航走了再 back 回来，站点可能重新拉一批推荐 → 账本作废 → 下一次定位也失败，
形成雪崩。）

### 4.1 落脚点：`restore` 把 tab 放回哪，决定下一次是 locate 还是 fallback

每个 detail 跑完都要把 tab 放回 feed，靠 step 的 `restore`（`recipe-runner.ts` 的 `restore()`）：

| `restore` | 做什么 |
|---|---|
| `back` | `driver.back()`，**然后确认落点**——不在**落点**的上下文才补一次 `goto(落点)` |
| `entry` | 直接 `goto(entryUrl)`（显式声明的动作，不走下面那套推断） |
| 不写 | 什么都不做（tab 停在目标页） |

**落点是哪一页**：`rideCurrentPage` 的 recipe 骑进来时标签停在哪，哪儿就是它的工作上下文
（`ridingFrom`）——**不是 `entryUrl`**。xhs-detail 的 `entryUrl` 写的是 `/explore`（homefeed 时代
的 feed），而它现在骑的是**搜索结果页**；拿 `entryUrl` 当落点，每次 detail 跑完都会把标签从搜索
结果导航去推荐流，而账本记的是搜索那一批 → 下一次 `known=0` → MISS → 整页导航 → 又回推荐流。
**一次"清理"就把后面每一次 detail 都变成 fallback-nav。**

`ridingFrom` 有两道闸门，都在防"把不该当家的页面认成家"：**同源**才收（`about:blank` 的 origin 是
`null`，直接出局——它正是下面那个自我延续循环的起点）；**不能是这次 `fallbackUrl` 的目标**（上一次
运行可能把标签停在笔记页上）。两道都不过就退回 `entryUrl`。

**为什么 `back` 之后还要确认落点**（活体钉死的自我延续循环）：一条 lane 刚开出来的那个 tab 停在
`about:blank`；detail 带 `rideCurrentPage` 进场不导航 → `locate` 在空白页上 `readViewport` 恒空、
攒够 `blankReads` 就 break（0 次移动、白烧 1–1.9s）→ 走 `fallbackUrl` 整页导航 → `back` 又回到
`about:blank` → 下一次原样重来。**每一次 detail 都是整页导航，而整页导航是唯一会压崩渲染进程的
操作。** 落点确认就是把这个环剪断的地方。

**为什么不是无条件 `goto`**（这是要害，别"顺手简化"回去）：

| | overlay 命中时 | fallback 之后 |
|---|---|---|
| `back` + 落点确认 | **0 次导航**（关掉浮层） | 1 次 back（bfcache 恢复，账本保住） |
| 无条件 `goto` | **1 次整页导航** | 1 次整页导航 |

feed 每次加载的内容都不同 —— 无条件 goto 等于给每次 detail 加一次导航 **+ 把账本冲掉**，
下一次 detail 就 `known=0` → 又是 fallback-nav，雪崩风险反而更高。**省的是雪崩，不是那一秒。**
报不出 URL 的 driver（没有 `currentUrl`）**不猜**：不导航。

**差价长什么样**：走 overlay 那条，一次 detail 的 locate+click 全程 **1.3–1.6s**（账本命中、卡还在
DOM 里，直接读坐标一步过去）；走 nav 那条要先白烧一段 locate 才 MISS，再加一次整页导航。

> **要引成本就自己去量**（`[recipe-probe]` 每轮都在打分阶段耗时），别从这里引，也别从记忆引：
> 浏览器和账本来源都换过，任何写死在文档里的耗时数字都无处附着。

**落点确认是 best-effort：它那次 `goto` 自己吞错，`'entry'` 分支那次不吞。** 它跑在采集完成
之后、纯粹为**下一次**运行准备环境；失败最坏是下次落在 foreign page、退回 fallback-nav——降级，
不是灾难。而 `Navigation ... is interrupted by another navigation` 在真浏览器上是常态（SPA 自己
的路由跳转、`back` 的导航尾巴、页面自身重定向），**且撞上了也不代表落点是错的**：2026-07-27 实测
就是报了这个错、页面确实停在 `/explore`、`/api/enrich` 却成了 502——一次已经成功的采集被清理
动作毁掉。和 `captureScene` 的「取证失败绝不能盖掉真正的失败原因」是同一条原则的两面。
`restore: 'entry'` 的 `goto` 反过来：它是 recipe 显式声明的动作，不是兜底清理，失败必须报出来。

**推论：`entryUrl` 和 `fallbackUrl` 是两个不同的东西，填成一样就等于没有落点确认。**
`entryUrl` = 这个 recipe 的**工作上下文**（detail 是 feed）；`fallbackUrl` = 定位失败时**目标页**
本身。两处填成同一个 URL 的后果：detail 停在笔记页会被判成"已经回到 entry"，落点确认形同虚设。

## 5. 想给这条管线加能力时

- **Recipe 是数据，不是代码。** 站点 selector / URL pattern / mapping 留在 recipe；通用能力（新的 step
  类型、新的 observer、新的 driver 方法）进 `recipe.ts` + runner/driver。**绝不把站点逻辑塞进 runner。**
- **driver 方法是可选的。** `PageDriver` 由可选方法拼装，缺一个，需要它的 recipe 就跑不了
  （runner 抛 `recipe requires <X> capability`）。**加之前先判它属于哪一层**：只认选择器、像素
  和 URL → 加进 `shared/browser-relay/page-driver.ts`，采集与 DSH 插件宿主一起得到；认识卡片 /
  字段表 / recipe → 加进 `src/replay/actions.ts` 的 `PageDriver`（它 extends 前者）。
  **然后要在两条臂上都实现**：
  `browser-ext-drive.ts` 的 `makeExtPageDriver` = **采集真正用的那条**（ext-cdp；翻译层从
  `shared/browser-relay/ext-page.ts` 拿，这里只加编排层那几格）；
  `browser-drive.ts` 的 `makePageDriver` = **Playwright 臂，只服务作者流程**（`record validate`
  经 `connectOverCDP` 连开发者自己起的调试 Chrome）。只补前者，作者流程就悄悄跑不了了。
