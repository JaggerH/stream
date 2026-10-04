---
name: onboard-source
description: 把一个站点/API/频道接进 Stream 变成一个 Source、或给 Stream 加一个自建后端容器的唯一入口。凡是"能不能把这个接进来"、"这个地址怎么采"、"该走 RSSHub 还是写 recipe"、"这站反爬很厉害怎么办"、"我想追某类内容但不知道谁在产出"、"要加一个处理能力后端（ASR/转写/diarization/embedding/docparse）"、"给某个后端自己写 Dockerfile/镜像怎么建"——都先来这里。它做三件事：分诊（你手里是需求还是地址）→ 侦察（抓 XHR、试站外重放）→ 按成本阶梯判路并派发。它是路由器和证据收集器，不是实现：落地交给 rsshub-routes / write-recipe / 本 skill 的 references。
---

# Onboard a Source — 接入的唯一入口

Stream 沿一条**成本阶梯**取数据。这个 skill 走完那条阶梯：侦察目标，选出**最便宜的、跑得通的**那一级，派发给对应的落地手段。侦察（含 XHR 捕获）**只在这里做一次**，落地手段消费它的证据，不重复抓。

它是决策节点（"这数据能拿到吗？怎么拿？"），不是实现。它停在一个**有证据支撑的判路结论**上。

---

## 先认一下你在哪一种形态里（**判路会因此不同**）

| | **用户形态**：只装了 `@streamapp/stream` | **仓库形态**：有 Stream 源码检出 |
|---|---|---|
| 新 source 落在哪 | `<dataDir>/recipes/<名字>/`（一个包目录，热装载，不用重启） | `packages/<id>/` |
| 阶梯能走到哪 | **0（订阅已有）、1（装一个带后端的 npm 包）、2 的 recipe 那一半、3–5 全部** | 全部 |
| 走不了的 | 2 的 `rsshub-routes` 那一半、给引擎加能力、`wiring.md` 的接线 | —— |

**这张表就是这份 skill 的安全带。** 下面凡是标了 <sup>仓库</sup> 的那几格，用户形态里**没有等价路径**——
判路时不许把人派进去，得回到阶梯上换一级。反过来也别自我设限：第 1 级（设施自己发布的 API 后端）
**用户形态是成立的**，后端会自己按包描述符把容器建起来（`src/plugins/provisioner.ts` 头注：
「发行版用户没有仓库、也没有 compose CLI」），不需要 `pnpm plugins compose`。

---

## 第 0 步：分诊 —— 你手里到底是什么

| 你有 | 去哪 |
|---|---|
| **一个地址 / 一个站** | 往下走成本阶梯 |
| **一个需求 / 一个主题**（"我想追黄金"、"婴幼儿看的频道"）——不知道谁在产出 | `references/finding-candidates.md` 先产出候选清单，再把每个候选丢回这条阶梯 |
| **一个已接进来但坏了的源** | 先判它坏在哪一层：RSSHub 路由挂了 → `rsshub-routes`；拟人采集不出数 → `write-recipe`（有故障查表）；都不是 → 才回阶梯重新判路 |
| **不是内容源，是一种处理能力**（ASR / diarization / embedding / docparse ……要给 Stream 加一个 **Provider 能力后端**），或你已判到 tier 1 而这个后端**要 Stream 自己写镜像** | `references/authoring-backend-image.md`<sup>仓库</sup>（自建 ML 模型后端容器的构建运维 gotcha 库；不走下面的成本阶梯——那条只判内容源怎么取）。**用户形态里没有这条路**：自己写镜像要仓库的构建流水线。用户能做的是装一个**已经发布好的**带 `stream.backend` 的包（第 1 级），容器由后端自己建。 |

⚠️ **"从需求找候选"先搜存量，存量空了就去外面搜——两条都要走。** 存量走 `stream_search` / `GET /api/plugins/sources`（现有 source / plugin / RSSHub 路由表）；外面走 `search_agent`（网页搜索领路的两轴发现循环：A 名字直取 + B 品类找窝）+ `get_agent_run` 取结果，单页转成文字用 `stream_fetch_url`。**别停在"存量里没有"上**——`references/finding-candidates.md` 的阶梯第 4 级本来就是"公开站点 + GitHub"。

---

## 成本阶梯（便宜到贵，取第一个跑得通的）

**一个问题定生死：站外能不能把这个请求复现出来？**

| 级 | 判据 | 落地 |
|---|---|---|
| **0** | 已有 source 就能满足这个意图 | 直接选它。**不建新东西。** 用户形态：`subscribe_source` 订阅它就完了。仓库形态还要判它挂哪一层 → `references/wiring.md`<sup>仓库</sup>。 |
| **1** | 有一个 **HTTP API 后端**能满足意图 | 分两种镜像归属：设施**自己发布的第三方容器**（带 `/openapi.json`）→ `references/via-external-backend.md`（声明成 plugin；Stream 从不重新打包第三方抓取器）——**两种形态都成立**，用户形态就是装一个声明了 `stream.backend` 的 npm 包，容器由后端自己建。若这个后端要 **Stream 自己写 Dockerfile**（ML 模型服务等）→ `references/authoring-backend-image.md`<sup>仓库</sup>。 |
| **2** | 站外**裸 HTTP** 就能取到，**不跑页面 JS**（可带 cookie） | **先试 recipe**：上游给 JSON → `kind:'http'`；上游给 HTML → `kind:'html'`（linkedom + CSS 选择器）。一个 JSON 文件、零代码——**两种形态都成立**。recipe 表达不出来（要跑 JS、要复杂转换/拼接）才升级到 `rsshub-routes`<sup>仓库</sup>；**用户形态到这里就没有下一格了**，改判 3 级（在页面里跑）或换一个结构更规整的来源。 |
| **3** | 站外取不到（请求被签名 / 锁在登录后），但**在页面里重放它自己的 fetch** 能拿到 | `write-recipe`（Tier-B：页内 XHR 重放） |
| **4** | 页内重放**被风控拦**（签名对了照样被标记，因为凑不齐伴随头，如 xhs 少 `X-S-Common` → `300011`），但站点**自己的 request client 可调**（webpack 模块表里摸得到） | `write-recipe`（Tier-C `eval`：调它自己的请求客户端，拦截器把每个头装齐 → 字节一致 → 过） |
| **5** | body 是密文 / 摸不到 request client，但**渲染出来的 DOM 里有** | `write-recipe`（Tier-C DOM 采集） |
| **6** | **这东西根本没有网页**——它只有一个桌面客户端（微信、QQ），或者要在客户端里**做一件事**而不是取内容（发消息） | `write-recipe` 的 `references/surface-desktop.md`：有控件树的用 a11y 查询，自绘的用 `see` 指屏幕上的文字。**这一级明显更贵**（读一次屏 1–3.4 秒，识别会认错），只有 0–5 全走不通时才落到这里 |

- **0–5 判的是"网页怎么取"，6 判的是"根本没有网页"。** 先问一句：这东西有没有网页版 / 有没有 API？
  有就别落到 6——桌面那一级贵一个数量级，而且识别会认错（`surface-desktop.md` 里那几条失败形状全是
  它独有的）。**目标是"做一件事"而不是"取内容"时，也从这里进**（发消息、下单这类动作 recipe）。
- 2 和 3 是同一个"模板化 fetch → 映射字段"模式的两个**后端**，分界线只有一条：**不跑 JS 能不能取到？**
- 4 和 5 都是真浏览器采集。**摸得到 request client 就走 4**，只有密文/无 client 才掉到 5。
- 落到 3–5 级(真浏览器)的 source **不用再判"登录态怎么进来"**:采集跑在**用户自己的 Chrome** 里,
  他在那个站登着就是登着——没有注入、没有 profile 要管、没有指纹要对。仍要判的只剩"掉了谁来重登":
  用户自己去站上重登,还是让 Stream 出面——自家账号体系、扫码进 → `login: qr`(扫码面板);
  登录就是点一下"用 Google 继续" → `login: oauth`(骑浏览器里已有的第三方登录态)。
  见 `write-recipe` 的 `references/login-and-session.md`(§1.1 / §1.2)。**cookie 注入那条路只对第 2 级(站外裸 HTTP,broker cookie)
  还成立**,别把它套到浏览器档上。
- 用户说"**这站反爬很厉害**" → 直接从 3 起跳，0–2 不必试。
- **不许跳级**：往下走之前，要么真的重放成功了，要么**记下确凿的阻断证据**。"我懒得试"不算证据。
- **取得到 ≠ 接得上——两问都过才算这一级成立。** 一个页面可以完美满足"裸 HTTP 取得到"，而落地
  手段的字段提取**表达不出它的结构**，于是这一级实际落不了地。所以选定一级之后，必须**真跑一次
  那一级的提取器**（第 2 级：`extractFields` / `interpret`），看字段是不是真能被切出来。
  真撞过：Prix Jeunesse 获奖名单 curl 得到、`p:has(strong) + p` 选行也精确命中 19 条，但作品名和
  制作方同处一个 `<p>`、靠 `<br>` 分隔——`<br>` 不是元素，`HtmlField` 也没有正则/split，
  取出来是 `"MY LIFE: ME, MY HORSE & MY SPEAR Salt Street Productions Ltd, United Kingdom"`
  一整坨，**切不开**。换成 Wikipedia 的同一份名单（标准 wikitable，一行一 `<tr>`）当场就通了。
  二十行探针脚本的事，省下的是一个写完才发现跑不通的 recipe。
- **换不了来源、只能加能力时：先分清缺的是「站点知识」还是「通用机制」。判据一句话——换个站还成不成立？**
  成立 = 通用机制，进引擎（`src/replay/` 的 schema + runner）；不成立 = 站点知识（地址、选择器、
  属性号、值长什么样），留 recipe。原话在 `docs/PACKAGE.md` §2.1，成例在 §2.9：维基奖项名单要拿
  条目页上的 Wikidata Q 号去换 TMDb 编号——「再跳一次、能拼 URL、能解 JSON、能验形状」是通用的，
  做成引擎的 `hops`；「问哪个 API、哪个属性号（P4947/P4983/P345）、值是 `^tt\d+$` 还是 `^\d+$`」
  是站点知识，写在 recipe 里。
  **别拿「引擎现在没有这个能力」反推「设计上不该这么做」**——现状不是契约。说"recipe 做不到 X"
  之前先去读 §2.1 的原话；`kind:'http'` 早就有 `prefetch`（声明式额外请求 + `{param}` 模板 +
  `parse`），"声明式多跳"这件事引擎一直是认的。
  **用户形态只有一半可用**：判成「站点知识」的随时能写进自己的 recipe；判成「通用机制」就意味着
  要改 `src/replay/` 的引擎<sup>仓库</sup>——那时诚实说出来，别把一个改引擎的活写成用户的下一步。
- **给 recipe 加跳时的三条不变量**（真相源 `docs/PACKAGE.md` §2.9）：
  **①补充证据的跳必须容错**——一跳失败只让那几个字段留空，绝不放倒整行；这跟 `detail` 失败即中断
  是两种语义，别混。**②分索引的 id 不许合并成一个字段**——TMDb 的电影号和剧集号是两个命名空间，
  同一个数字在两边是两部不同的作品，合并即静默错配（落成 `tmdb_movie_id` / `tmdb_tv_id`，哪格有值
  本身就是 kind 的证据）。**③复用引擎已有的词汇**（`parse`、`{param}` 模板），别给第二个 recipe
  kind 造第二套方言。

---

## 侦察（在这里做，只做一次）

1. 只问缺失的关键信息：目标 URL、样例输入、想要哪些字段、列表分页要不要。
2. **先问这份信息还住在哪儿——选来源本身就是判路的一部分。** 同一批内容常常有好几个载体
   （官网 / 维基 / 聚合站 / 官方 API / PDF），**结构差异直接决定成本**，而它们的可信度往往一样。
   列出候选，挑**结构最规整**的那个（有表格 / 有 JSON / 一行一条 > 散文里夹着数据）。
   这一步几乎不花钱，省下的是一整轮返工——奖项名单那次，官网抓得到却切不开字段，
   维基同一份名单是标准表格，当场就通。
3. 看公开页：页面 HTML + 内嵌 config、network 调用、请求发起者/时序、cookie/session/token 怎么来的、响应类型和形状。
   *（想对**用户自己登录着的**页面做一次性读——DOM / computed style / 某个 `window` 全局 / 是否登录——用 `drive-live-ui`。那是读原语，不是这里的 XHR 捕获。）*
4. **先 `curl` 一次，看目标内容在不在返回的 HTML 里。在，就直接跳到第 6 步（第 2 级），别抓包。**
   服务端渲染的静态页（榜单、维基、论坛列表）没有 XHR 可抓，下一步是纯浪费——还要为它起一个
   带调试端口的 Chrome。只有 curl 回来是空壳 / 骨架 / `__NEXT_DATA__` 之外没有正文时，才往下走。
5. **抓 XHR**：找出 payload 里带着目标条目的那个请求（**常常不在你猜的那个域名上**——抓出来的
   才是真相）。**怎么抓的完整步骤和坑，唯一真相源是 `write-recipe/references/capturing.md`**，
   那里分两种形态写：**只装了 npm 包**走 MCP 的 `cdp_*` 三步（开页面 + 装拦截器**必须同一次调用**
   → `cdp_act` 触发 → 读回来）；**有源码检出**还可以用 `scripts/recipe-capture.ts`<sup>仓库</sup>
   把完整 body 落盘（控制台预览截断在 400 字符）。两种形态用的都是**你自己那个 Chrome**，
   所以登录墙后面的接口直接能抓。
6. 试着**在浏览器外重放**：从最小的端点开始，一个一个删请求头找出真正必需的，确认响应里有数据。
   成功 = 第 2 级。失败（被签名/被登录挡）→ 推到 3 级以上。
   **要抓响应体，不只是请求**——你需要它的形状来映射字段；而一个风控 body（`{code:300011,…}`）本身就是"手搓重放被标记了"的证据。
7. 被**风控**挡的（签对了照样拒）：**不要去凑请求头**。去站点的模块表里找它自己的 request client（`Object.keys(window)` 找 `webpackChunk…`，定位源码里出现该端点的模块，调它导出的请求函数）。摸得到 → 第 4 级；body 是密文或摸不到 client 而 DOM 有数据 → 第 5 级。
   注意：**首屏常常是 SSR 的**，分页 XHR 可能要滚动才发——"被动没看到 XHR" ≠ "没有 XHR"。
8. **拿真的提取器跑一遍**（见阶梯的"取得到 ≠ 接得上"）：确认每个目标字段真能被切出来。
   跑不出来 → 换来源（回第 2 步）或加能力，**别硬写 recipe**。两种形态：
   - **只装了 npm 包**：把 recipe 写成一个包放进 `<dataDir>/recipes/<名字>/`，用
     `GET /api/recipes/local` 确认它真装载了（要看到 `ok:true`，四种状态的分诊表在
     `write-recipe/references/recipe-template.md`），然后
     `POST /api/streams/<id>/refresh` **真跑一次**，看 `fetched` 和 `written`。
     字段切没切开看落进来的 item；失败现场在 `<dataDir>/failures/`。
   - **有源码检出**<sup>仓库</sup>：直接拿 `src/replay/html-extract.ts` 的 `extractFields`（HTML）
     或 `interpret`（JSON）对着存下来的样本跑——不用起后端，二十行探针脚本的事。
9. 梳理入参（path/query/body 参数、枚举、默认值、各 mode 差异）和出参（稳定 id/链接、标题、作者、时间戳、媒体 URL、清晰度/格式/大小、字幕、封面、标签）。
10. 列表要试分页（`page`/`offset`/`limit`/`cursor`/`next`/`hasMore`），真的取第二页，记下停止条件。
11. 按 `references/evidence-report.md` 产出证据报告，交给落地手段。

---

## 硬规则

- 用**设施的正规名字**称呼目标，不要用偶然碰到的子域名/端点。子域名记成入口 / API host。
- **风控 ≠ 签名。** 一个请求可以签得完全正确却照样被标记——少一个伴随头、指纹对不上、或者根本不是从真浏览器发出的。**永远不要为一个有风控的站手搓签名请求**——那是封号路径（手搓 `X-s`/`X-t` 而没有 `X-S-Common` → xhs `300011 账号异常`）。要复现，就在用户自己登录着的浏览器里**调它自己的请求客户端**，让它的拦截器把每个头装齐。真浏览器+自有客户端是安全的那一级；外部手搓是会被封号的那一级。
- 上游能力按**真实行为**切分：入参不同 / 响应形状不同 / 分页不同 / 选项不同 = 不同的能力。
- **报一个「代价」之前，先回答它是方案固有的、还是当前实现造成的。** 判路全靠成本比较，所以一个由
  缺陷撑起来的数字会把整条判断带偏。两种最常见的假代价：**(a) 少了一层本该有的复用**，于是"多一跳"
  被算成"每轮多发 N 倍请求"；**(b) 那一跳其实搭在已经要发的请求上**——采集本来就要抓每行的详情页，
  详情页里已经有 Q 号，再读一个 JSON 是顺手，不是新增一条链路。数字照报，但必须同时答出
  "换个实现它还在不在"。**答不出就别用它否掉一条路。**
- **顺手的一步别包装成一套机制。** "多一跳"这个说法本身就在暗示代价；先问它是不是只是在已有请求
  链上多读一个字段。为一个不存在的成本设计缓存/降级/条件跳，比那一跳本身贵得多。
- 凭证、cookie、token、签名密钥当敏感信息：记它的**作用和获取流程**，永远不记具体值。
- 失败模式是一等证据：限流、媒体 URL 过期、不支持的平台、缺字段、5xx、依赖地区/IP、bot 检测、混淆、加密。

---

## 交付标准（判路成立的条件）

- 这是哪个正规设施？入口 URL 和观察到的 API host？
- 这份信息还有哪些载体？为什么选了这一个（结构规整度，不只是"能取到"）？
- 选了哪一级，**为什么**——更便宜的那几级各自被什么排除的？
- **落地手段的提取器真跑过了吗**——贴出跑出来的字段，不是"应该能选到"。
- 如果为它加了引擎能力：哪部分是通用机制（进 `src/replay/`）、哪部分是站点知识（留 recipe）？
  按"换个站还成不成立"逐项答，答不出的那一项就是放错地方了。
- 哪个请求成功重放了？或者，**确切**是什么挡住了它、下一个实验该做什么？
- 入参契约 + 合法取值集；要的字段哪些有、哪些没有、哪些要再调一次才拿得到？
- 有没有分页？
- 生产环境里它会怎么坏？

落地做完之后：**用户形态**到这儿就结束了——包在 `<dataDir>/recipes/` 里装载好（`GET /api/recipes/local`
报 `ok:true`），`subscribe_source` 订阅它，采集就归调度中心管了。**仓库形态**还有一步，
回到 `references/wiring.md`<sup>仓库</sup>：这个 source 该当 Stream 成员、某条 Provider 行的成员、
还是一条新的 Provider 行 / 调用点；站点知识写进包的哪一格，宿主什么时候才要改。

---

## Resources

- `references/finding-candidates.md` — 只有需求、没有地址：怎么找出候选源（存量优先）。
- `references/via-external-backend.md` — 第 1 级落地：把第三方 HTTP API 后端接成 plugin（worked example: douyin）。**两种形态都成立。**
- `references/authoring-backend-image.md`<sup>仓库</sup> — 第 1 级的另一半：Stream **自己写镜像**的后端容器（ML 模型服务：diarization/embedding，如 voiceprint；这类只声明容器的包住 `JaggerH/stream-packages`，用户 `stream add`）的构建运维 gotcha 库（模型烤入、国内镜像源、pip cuDNN wheel、provider opt-in、healthcheck 探针、build cache 分层、容器 DNS 真实路径测试）。也是"加一个 Provider 处理能力后端"的落地。
- `references/wiring.md`<sup>仓库</sup> — 接入之后放哪一层、怎么接线（Stream 成员 / Provider 行成员 / 包出的 Provider 行 / 新调用点）与怎么验它真被派发到。用户形态没有这一步：装上包、`subscribe_source` 订阅就完了。
- `references/evidence-report.md` — 交给落地手段的证据报告格式。
- 相邻 skill：`write-recipe`（第 3–5 级 + 跑起来 + 修，**两种形态都成立**）、`drive-live-ui`（一次性看一眼页面）、`share-recipes`（把写好的 recipe 包发出去 / 装进来）；`rsshub-routes`（第 2 级的另一半）<sup>仓库</sup>。
- 概念与不变量：`docs/ARCHITECTURE.md`（Source / Stream / Provider / Plugin / Channel 的权威定义）。
