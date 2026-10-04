## Purpose

`kind:'http'` 这一档纯声明式 recipe：复用既有抽取契约、宿主不跑带环境能力的代码、凭证绑定到它所属的域、请求经宿主自有出站通道发出——它是成本阶梯上可分享的采集单元。

## Requirements

### Requirement: Plain HTTP recipe kind

A recipe SHALL support a plain-HTTP kind (`kind: 'http'`) that is simply a request to an endpoint: the executor SHALL issue the recipe's `RecipeRequest` from the host process and SHALL NOT launch, attach to, or route through any browser. This kind SHALL be a sibling of the existing in-page `kind: 'fetch'` and page-driving `kind: 'browser'`, and SHALL NOT be modelled as a `transport` value on them, because those shapes require browser-only fields (`entryUrl` — a page to open to establish logged-in context; `entryWait` — a navigation wait condition) that are meaningless when no page is ever opened.

#### Scenario: 就是给某个端点发一个请求
- **WHEN** 一份 `kind: 'http'` 的 recipe 被执行
- **THEN** 执行器直接发出该请求并拿到 body，不启动浏览器（`ensureBrowser` 不被调用），也不需要声明任何入口页面

#### Scenario: 形状不含浏览器字段
- **WHEN** 用户编写一份 `kind: 'http'` 的 recipe
- **THEN** 该 recipe 无需声明 `entryUrl` / `entryWait`；声明它们 SHALL 视为无效

#### Scenario: 需要页面自算签名的站点不适用
- **WHEN** 目标站点要求页面自身计算请求签名，或数据必须跑页面 JS 才产生
- **THEN** 该 Source 不使用 `kind: 'http'`，仍走既有的浏览器 kind —— Stream 绝不逆向或伪造平台签名

### Requirement: Plain HTTP recipe reuses the existing extraction contract

The plain-HTTP kind SHALL feed its fetched body through the existing recipe output mapping (`itemsAt` / `dedupeBy` / `mapping`) via `ObserverPipeline.offer(body)`, SHALL NOT introduce a parallel extraction path, and SHALL reuse the existing `RecipePagination` semantics for paging. The mapping contract is already transport-agnostic — it serves both XHR and DOM bodies today — so serving a third body source SHALL require no new mapping semantics.

#### Scenario: JSON 响应直接走既有 dot-path 映射
- **WHEN** 一个 http recipe 取回 JSON body
- **THEN** items 由既有的 `itemsAt`/`dedupeBy`/`mapping` 产出，无需为 http 新增映射语义

#### Scenario: 分页语义不分叉
- **WHEN** 一个 http recipe 声明了 pagination
- **THEN** 翻页遵循既有 `RecipePagination` 规则，与浏览器 kind 一致

### Requirement: The host never runs recipe code that carries ambient capability

Extraction for the plain-HTTP kind SHALL be declarative (`itemsAt` / `dedupeBy` / `mapping` / selectors), and the host process SHALL NOT execute recipe-carried code in its own runtime. The reason is capability, not code: a script running in the host process could read deployment secrets, request any domain's cookies from the credential broker, touch the filesystem, and exfiltrate. The in-page `evaluate` step is no precedent for that, because it runs inside a browser page bounded by that page's origin. Sharing means running an author's artifact on a recipient's machine, so a capability-bearing payload would make a shared Channel/Stream an arbitrary-code-execution vector.

The one code path a recipe MAY use is a **zero-capability compute sandbox**, and it SHALL satisfy all of the following at once: the snippet runs in an isolated VM heap with no host globals (no `fetch`, `process`, `crypto`, `require`, filesystem); it may call only pure functions the host injects by name from a fixed whitelist, and only those the recipe declared; hard heap and wall-clock limits are enforced by the VM, not by trusting the code; the snippet returns a JSON value and nothing else; and it performs no I/O — every request, including any the computation depends on, is issued by the engine through the guarded outbound path. A snippet so bounded holds no capability to abuse, which is what the ban is protecting.

When a target exceeds the declarative primitives, the resolution SHALL be one of: a specific, auditable decode primitive; a pure snippet inside the zero-capability sandbox; or routing that target to a browser kind. It SHALL NOT be a code path with ambient capability in the host.

#### Scenario: 沙箱里没有环境能力
- **WHEN** 一份 recipe 携带的代码去够 `fetch` / `process` / `crypto` / `require` / 文件系统
- **THEN** 这些名字在它的执行环境里根本不存在，逃逸尝试以执行失败告终，拿不到任何宿主能力

#### Scenario: 只跑声明过的白名单纯函数
- **WHEN** 一份 recipe 声明了它要用的能力名
- **THEN** 只有既在白名单内、又被它声明过的名字可调用；白名单外的名字在装载时就被拒，不留到运行时

#### Scenario: 声明式解不动时的退路
- **WHEN** 某目标的解析超出既有声明式原语的表达力
- **THEN** 要么新增一个具体的、可审计的 decode 原语，要么用零能力沙箱里的纯计算，要么该目标改走浏览器 kind；不得在宿主运行时里执行带环境能力的代码

### Requirement: Response decoding into the mapping shape

The plain-HTTP kind SHALL decode JSON responses into the shape the dot-path mapping consumes. An HTML-serving upstream on the same rung SHALL be served by a sibling bare-host-fetch kind that maps rows with CSS selectors parsed by the in-process DOM dependency rather than a browser. Decoding SHALL serve only the item/field consumption shape and SHALL NOT grow into a general DOM query language.

#### Scenario: JSON 响应直接解码
- **WHEN** 一个 http recipe 取回 JSON body
- **THEN** body 被解析后交给既有 `itemsAt`/`mapping`，无新增映射语义

#### Scenario: HTML 响应可提取，同样不开浏览器
- **WHEN** 上游给的是 HTML 而不是 JSON
- **THEN** 该源走同一档的 HTML kind，用 CSS 选择器在宿主进程内解析出条目与字段，全程不启动浏览器

### Requirement: A shared recipe cannot forge requests into private space

The request URL of a plain-HTTP recipe SHALL be validated against an SSRF guard before the request is issued: loopback, link-local, and private address ranges SHALL be refused, and the guard SHALL be the project's existing one rather than a second implementation. This is required because `RecipeRequest` is by construction a request-forgery primitive — a shared recipe is an author-supplied URL that the recipient's own process fetches — and the declarative-extraction rule does not constrain it: with no code execution at all, an author could point a recipe at the credential broker or at any plugin backend reachable on the host's internal network and map the response into items.

#### Scenario: 指向内网的 recipe 被拒
- **WHEN** 一份 http recipe 的请求 URL 解析到回环、私网或 link-local 地址（例如凭据 broker、其他插件后端）
- **THEN** 执行器拒绝发出该请求，该 recipe 视为无效

#### Scenario: 公网目标正常放行
- **WHEN** 一份 http recipe 的请求 URL 指向公网主机
- **THEN** 请求正常发出

### Requirement: Credentials are bound to the domain they belong to

When a plain-HTTP recipe declares a `cookieDomain`, the executor SHALL attach the resolved cookie only to a request whose URL host matches that domain, and SHALL refuse the recipe when they do not match. Nothing in the recipe shape ties the two together on its own, so without this rule an author could declare a victim site's `cookieDomain` alongside a URL pointing at their own collector and obtain the recipient's live session cookie — a complete credential exfiltration achieved declaratively, with zero code execution.

#### Scenario: cookieDomain 与请求 host 不符 → 拒绝
- **WHEN** 一份 http recipe 声明 `cookieDomain: 'a.com'` 而其请求 URL 指向 `b.com`
- **THEN** 执行器拒绝执行该 recipe，且不向该请求附加任何凭据

#### Scenario: 相符时才附加凭据
- **WHEN** 一份 http recipe 的 `cookieDomain` 与请求 URL 的 host 相符且该域有可用 cookie
- **THEN** 凭据被附加并发出

### Requirement: The executor issues requests through the host's owned outbound path

The plain-HTTP executor SHALL NOT issue its requests through the process-global `fetch`, because this process's globals are rewritten at runtime by the embedded RSSHub request-rewriter — which replaces `globalThis.fetch`, `Headers`, `Request`, `Response`, and the `get`/`request` methods of `node:http` and `node:https`, and injects a self-origin `Referer` when none is present. Routing recipe traffic through it would silently alter recipient-side requests and make behaviour depend on whether RSSHub happens to have been loaded yet.

#### Scenario: 出站不经被改写的全局 fetch
- **WHEN** 一个 http recipe 发出请求
- **THEN** 该请求不经过 RSSHub 改写器，不被注入 self-origin `Referer`，且行为与 RSSHub 是否已加载无关

### Requirement: Credentials are optional for a plain HTTP recipe

A plain-HTTP recipe SHALL treat credentials as optional: a public endpoint SHALL require no `cookieDomain`, and when a `cookieDomain` IS declared the executor SHALL resolve it through the existing `cookieFor(cookieDomain)` path and attach the cookie to the outgoing request — still without a browser. A target needing a login session but no page JS SHALL therefore be servable by this kind.

#### Scenario: 公开端点无需任何凭据声明
- **WHEN** 一个 http recipe 未声明 `cookieDomain`
- **THEN** 请求以无凭据方式发出，执行成功，不因缺少凭据字段而报错

#### Scenario: 带登录态的裸 HTTP 取数
- **WHEN** 一个 http recipe 声明了 `cookieDomain` 且该域有可用 cookie
- **THEN** 请求携带该 cookie 发出，且不启动浏览器

### Requirement: Recipes are the shareable acquisition unit across the ladder

A user-authored Source at acquisition tier 2 SHALL be expressible as a recipe — the same unit already used at tiers 3–4 — and a recipe SHALL be shareable as user data (`<dataDir>/recipes`) that travels with a shared Channel/Stream, so producing a usable Source SHALL NOT require a contribution to, or a merge in, any external repository.

#### Scenario: 用户新增裸 HTTP 源，产出可分享 recipe
- **WHEN** 用户接入一个站外裸 HTTP 就能取到的新信息源
- **THEN** 产出物是一份 recipe，可随 Channel/Stream 分享给他人，全程不依赖 RSSHub 上游合并

#### Scenario: 接收方无需浏览器即可复用
- **WHEN** 用户 B 收到一个引用了 `kind: 'http'` recipe 的 Channel/Stream
- **THEN** B 无需可用的浏览器环境、也无需更新任何外部代码库即可执行该 Source
