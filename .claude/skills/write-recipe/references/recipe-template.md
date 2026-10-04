# Recipe template

The output artifact of this skill. Fill it, validate it live, then save it — **where it goes depends on
which form you're in (源码检出 vs `npm` 装的)，见下面「写完的 recipe 放哪」**；在源码检出里就是
`packages/<facility>/<sourceId>.recipe.json`——**文件名必须以 `.recipe.json` 结尾**，扫描器只认这个后缀，
写成别的名字装载器一眼都不会看它（不报错，只是这条 Source 不存在）。落地 = 先过
`validateRecipe(sourceId, recipe)`（`src/replay/recipe-store.ts`）再写那份文件。The schema is `src/replay/recipe.ts`. A `kind:'fetch'` recipe is replayed by `runFetchRecipe` (`browser-fetch.ts`); a canonical `kind:'browser'` recipe by `RecipeRunner` + `ObserverPipeline`, dispatched via `SessionRecipeExecutor` on a facility session lease. `interpret.ts` holds the shared `getPath`/`substitute`/mapping helpers.

A recipe **self-describes as a Source** via its `meta` block: the loader projects it into a `SourceManifest` (`src/replay/recipe-manifest.ts` → `recipeToManifest`), so you do **not** hand-write a `manifests.yaml`. Structural fields derive from the recipe (`id`, `adapter: replay`, `capabilities`); author a one-line `meta.description`, and — **如果这条 recipe 要用户的登录态——`meta.auth`**（见下面「auth 不是装饰」）。A `manifests.yaml` entry, if present, is an optional full override.

## Annotated skeleton

```jsonc
{
  "version": 1,
  "kind": "fetch",                   // pure in-page XHR replay (FetchRecipe, this skeleton). The cheapest
                                     //   browser-recipe sub-rung; no session. A canonical BROWSER
                                     //   recipe (steps+observers) is the separate skeleton below.
  "sourceId": "<id>",                // the Source's LOCAL name — no package prefix, no "/" and no ":".
                                     // The host prefixes it with your package.json#name at load time
                                     // (`@streamapp/xhs/xhs-home`); see docs/PACKAGE.md §1.1.
                                     // A meta block (below) makes it a Source, no manifest needed
  "cookieDomain": "example.com",     // domain whose cookies authenticate the fetch; "" for public data
  "entryUrl": "https://example.com/search?q={query}",  // a page ON THE SITE'S ORIGIN so the in-page
                                     //   fetch is same-origin and any signing global is loaded
  "entryWait": "commit",             // commit | domcontentloaded | load | networkidle — see decision table
  "request": {
    "url": "https://example.com/api/search?q={query}&page={page}",  // the captured XHR, with {holes}
    "method": "GET",                 // or "POST"
    "headers": { "accept": "application/json" },                    // header templates may carry {holes}
    "body": "{\"cursor\":\"{cursor}\"}"                            // POST body template (omit for GET)
  },
  "pagination": { /* one of the two shapes below */ },
  "assert": [
    { "path": "data.items", "desc": "no items array — login-wall or endpoint moved" }
  ],
  "mapping": {                       // response dot-path (within ONE item) → DataItem field;
                                     // `{a.b}` holes = template; leading `=` = literal constant
                                     // ("author": "=转转回收" — a bare constant would be read as a path → undefined)
    "title":  "note.title",
    "link":   "note.share_link",     // "url" also accepted; normalized to link + a derived guid
    "author": "note.user.nickname",
    "like_count": "note.interact_info.liked",
    "pubDate": "note.time"
  },
  "meta": {                          // makes this recipe a Source (manifest synthesized); all fields optional
    "description": "<one line for search/discovery — the only field worth authoring>",
    "categories": ["news"],          // discovery facets (optional)
    "radar": ["example.com/u/:id"]   // URL patterns that resolve to this source (optional)
  }
}
```

## meta — self-describe as a Source (no `manifests.yaml`)

`meta` is how a recipe becomes a listable/schedulable Source without a separate manifest. All fields optional; anything set overrides the derived default. Full shape: `RecipeMeta` in `src/replay/recipe.ts`.

| field | default (if omitted) |
|---|---|
| `description` | `"<facility> 数据源"` placeholder — **author this**, it drives search/discovery |
| `capabilities` | `['timeline']` |
| `auth` | `{ type: 'none' }` — **要用户登录态的 recipe 必须自己申报，见下面「auth 不是装饰」** |
| `categories` / `topics` / `example_queries` | `[]` |
| `cadence_hint_seconds` | `1800` |
| `radar` (string[]) | none → sets manifest `radar` + `matchers` so a pasted URL resolves to this source |
| `type` / `facility` / `key_param` / `priority` / `discoverable` | `post` / package facility / — / — / `true` |

A hand-written `packages/<facility>/manifests.yaml` entry (same schema as a plugin source) fully overrides the synthesized manifest for that `sourceId` — a power-user escape hatch, rarely needed.

## 写完的 recipe 放哪：两种形态，同一条装载路径

**这一节是「recipe 落在哪」的唯一说法**，本 skill 其它地方（`authoring.md` / `authoring-loop.md`）
都指回这里。两种形态走的是**同一个扫描器、同一条装载路径**（`mountRecipePackages`），
差别只在目录和命名空间：

| | 开发形态（有 Stream 源码检出） | 用户形态（`npm i -g @streamapp/stream`） |
|---|---|---|
| 放哪 | `packages/<facility>/<sourceId>.recipe.json` | `<dataDir>/recipes/<任意目录名>/` |
| 命名空间 | `package.json#name`（如 `@streamapp/xhs/xhs-home`） | **`local/<目录名>`**（包里没有 npm 名时的兜底） |
| 会不会顶掉别人 | 同包名整包覆盖 | **不会**——`local/` 前缀与任何 npm 名都不相等 |
| 生效 | 后端重载 | **写完就生效**，目录有 watcher，去抖后自动重挂 |

### 用户形态：两个文件，一条判据

`<dataDir>` 默认是 `~/.stream`；不确定就问那一口，它自己会说（下面 `dir` 字段）。

```
~/.stream/recipes/my-site/
├── package.json              # 不需要 npm 包名
└── feed.recipe.json
```

```jsonc
// package.json —— 最小可用；`name`/`version` 都可以没有
{ "stream": { "type": "recipe", "name": "my-site", "facility": "my-site", "schemaVersion": 1 } }
```

```jsonc
// feed.recipe.json —— 最小可用的 kind:'http'（实测能过校验；别再删格，见下）
{
  "version": 1,                    // ← 漏了它整份 recipe 不装，而且不报到用户面前
  "kind": "http",
  "sourceId": "feed",              // 局部名；全名会是 local/my-site/feed
  "request": { "url": "https://example.com/api/list?page=1", "method": "GET" },
  "pagination": { "mode": "increment", "param": "page", "start": 1, "step": 1,
                  "itemsAt": "data.items", "maxPages": 1 },
  "assert": [{ "path": "data.items", "desc": "list endpoint returned data.items" }],
  "mapping": { "title": "title", "link": "url", "guid": "example-{id}" },
  "meta": { "normalizer": "rsshub", "type": "post", "description": "某站最新列表" }
}
```

**判据只有一条**（别拿"我文件写好了"当判据）：

```bash
curl -s 127.0.0.1:8900/api/recipes/local
# → { "dir": "…/recipes", "ok": true,
#     "packages": [{ "id":"my-site", "sources":[{"id":"local/my-site/feed","mounted":true}] }] }
```

它把两端摆在一起，所以三种状态**分得开**——而在有这一口之前它们长得一模一样：

| 看到的 | 意思 | 下一步 |
|---|---|---|
| 那个包**根本没出现** | 写错地方了（`dir` 字段就是正确的那个），或者少了 `package.json` | 照 `dir` 重放一次 |
| 包在、带 `error` | 解析没过，**原文就在 error 里**（漏 `version` 是最常见的一种） | 照原文改 |
| 包在、`mounted:false` | 解析过了但 registry 里还没有：重挂还没发生或那一轮失败了 | 等一两秒再问；仍是 false 就看后端日志 |
| `ok:true` | 装载了。**再采不到就是源本身的事**，不是放错地方 | 去跑一次 refresh |

**这一口存在的理由**就是最后那一行：把「写了但没装载」和「装载了但源不工作」分开。分不开的话，
排查会从错的那一端开始——而两端的修法毫无共同之处。

### `auth` 不是装饰 —— 要登录态就必须申报

**采集不读它，另一个人读它。** `ReplayAdapter` 取数确实只用 recipe 的 `cookieDomain` 和用户
Chrome 里现成的登录态，所以"replay 不读 `manifest.auth`"这句话是对的——但**别照它推出
"可以不写"**。`manifest.auth` 有第二个消费者：`requiredCookieDomains`
（`src/credentials/required-domains.ts`）——**后端下发给扩展的「该同步哪些域的 cookie」那份
名单**。不申报 ⇒ 那个域不在名单里 ⇒ 扩展不去读它 ⇒ 取数拿到一份空 cookie。

**漏报的表现和"用户没登录"一字不差**，而且没有任何一处会喊。这一段之前写着
"display-only and safe to leave off"，东财的包照做了，于是那个域全靠 `config.yaml` 里一块给
别的东西用的旧配置意外顶着；删掉那块就整条断（2026-09-03 修，`3efad7a1`）。

```jsonc
// 站点自己有登录页、Stream 能弹扫码面板 → login: "qr"（成例 packages/xhs/*.recipe.json）
"auth": { "type": "session", "facility": "xhs", "login": "qr",
          "loginUrl": "…", "qrSelector": "…",
          "cookieDomain": "xiaohongshu.com", "sessionCookies": ["web_session"] }

// 站点自己没有账号体系、登录就是点一下"用 Google 继续" → login: "oauth"
// （成例 packages/groq/groq-create-key.recipe.json）。account 是每个用户各一份的邮箱，
// **绝不写进 recipe**——它住用户填的 runtime_config，登录时现取。见 login-and-session.md §1.2。
"auth": { "type": "session", "facility": "groq", "login": "oauth",
          "loginUrl": "https://console.groq.com/login", "oauthButton": "#oauth-google",
          "accountSelector": "[data-identifier=\"{email}\"]", "cookieDomain": "groq.com" }

// 会话就住在用户自己 Chrome 的 cookie 快照里、掉了由某条 recipe 自己登回来 → login: "cookie"
// （成例 packages/eastmoney/eastmoney-login.recipe.json）。facilityAuthView 按 login !== 'qr'
// 把它挡在授权面板外，所以不会多出一个点了没用的「重新登录」按钮。
"auth": { "type": "session", "facility": "eastmoney", "login": "cookie",
          "cookieDomain": "eastmoneysec.com" }
```

**包描述里的 `stream.credentials` 顶不上这一格**：那是**许可**名单（宿主可以把这个域交给
这个包），不是**需求**名单（去用户浏览器把它取回来）。两个都要的包，两处都写。

## Pagination — pick one

**cursor** — response echoes an opaque token the next request carries:
```json
{ "mode": "cursor", "itemsAt": "data.items", "cursorFrom": "data.cursor", "cursorParam": "cursor", "hasMore": "data.has_more", "maxPages": 5 }
```
Stops at `maxPages`, a falsy `hasMore` (optional), or an empty/absent cursor.

**increment** — a numeric page/offset counter injected as a param:
```json
{ "mode": "increment", "itemsAt": "data.items", "param": "page", "start": 0, "step": 1, "maxPages": 5 }
```
`step: 1` = page numbers (0,1,2…); `step: 20` = offset by page size (0,20,40…). Stops at `maxPages`, a falsy `hasMore` (optional), or the first empty item page.

## entryWait — decision table

| value | when |
|---|---|
| `commit` | same-origin API that needs no page JS to run first (fastest; avoids SPA render stalls) |
| `domcontentloaded` | default; page DOM ready is enough |
| `load` / `networkidle` | the site's **request-signing JS must finish initializing** before the fetch will sign correctly (e.g. xhs) |

## mapping targets (DataItem contract)

`title`, `link` (or `url`), `author`, `author_avatar`, `like_count`, `comment_count`, `pubDate`, `body_html`, `body_text`, `attachments`. A stable `guid` is derived (link → url → title) if you don't map one. These feed `makeStreamItem` (`src/stream-pipeline.ts`) unchanged.

## Canonical browser-recipe skeleton (`kind:'browser'` — steps + observers)

Use when you must DRIVE the logged-in page (call its request client, read a `window` global, scroll + read cards, click into a detail). This is the `CanonicalBrowserRecipe` shape: `session` + `steps` + `observers` + `output` (NOT `request`/`pagination` and NOT the deleted `actions`/`harvest.mode`). Schema: `CanonicalBrowserRecipe` / `RecipeStep` / `RecipeObserver` / `RecipeSessionSpec` / `RecipeOutput` in `src/replay/recipe.ts`. Pick the harvest method by tier (SKILL.md § Portability Model, § Choosing a harvest method).

```jsonc
{
  "version": 1,
  "kind": "browser",
  "sourceId": "xhs-search",
  "cookieDomain": "xiaohongshu.com",
  // entryUrl = 这个 recipe 的**工作上下文**（feed），不是它要打开的那个目标页——目标页是 step 的
  // `fallbackUrl`。两个填成一样，`restore: back` 的落点确认就失效（→ pipeline.md §4.1）。
  "entryUrl": "https://www.xiaohongshu.com/search_result?keyword={keyword}",  // may template {param} holes
  "entryWait": "load",                 // signing/render JS must init first (xhs)
  "loginCheck": {
    "loggedIn": ".main-container .user",     // present ONLY when authenticated
    "wall": ".login-modal.reds-modal-open"   // the login/verify overlay (positive wall signal)
  },
  "session": {
    "facility": "xhs",
    // "laneKey": "search",            // 同一 facility 里的第二个标签（共用登录、各跑各的）
    "lifecycle": "persistent",         // one-shot | persistent (survives task leases)
    // unattended = 采集：后台标签，永不抢屏。**要可信点击也用它**——focus 仿真兜住隐藏 tab
    //              的可信输入，一次点击 0.19–0.33s（见 references/session-runtime.md）。
    // interactive = 用户得亲自动手的流程（登录/扫码/自助建 key），开在他眼前。
    // 判据是「谁动手」，不是「想不想看」：想看着它跑用 RECIPE_PROBE + data/failures，别改这里。
    "visibility": "unattended"
    // 没有 transport 这个键了：采集只有一个浏览器（用户自己的 Chrome + 扩展中继）。
    // 写 "ext-cdp" 收下但不做事；写 "cloak" **装载即拒**。
  },
  "steps": [
    // Tier-A `evaluate` — call the site's OWN request client (byte-identical signing),
    //   paged by its cursor. Render-independent → 后台标签零代价，不用逼帧。
    { "kind": "evaluate", "call": "async (cursor, num, params) => ({ items: [], cursor: '' })",
      "itemsAt": "items", "cursorField": "cursor", "pageSize": 20, "maxPages": 30 }
    //   把分页当等待循环用（生图要 60s+，页内一次求值有 relay 30s 上限）：还没出结果的页回
    //   `{ items: [], pending: true, cursor }` 并声明 "pendingField": "pending"——runner 只推进
    //   cursor、不进 harvest、不计空页。不声明的话等待页会被 assert 判成 malformed，连两页就 drift。
    // Tier-B alternatives: { "kind": "scroll", "dwell_s": [3,6], "maxTimes": 40, "noProgressStop": 6 }
    //   drives the feed for a `dom`/scroll-fired `network` observer.
    // { "kind": "openTarget", "selector": "a.cover", "identityParam": "noteId", "maxScrolls": 8,
    //     "restore": "entry",    // 可信点击进 detail。真帧靠 focus 仿真，不靠占前台。
    //     // 可选的额外判据：内建确认（URL 带不带 identity）只答"打开了没"，expect 答"开对了没"。
    //     // 跑在内建确认之后、observers 读之前；fallback-nav 那条路也照跑。
    //     // locate / openTarget **不吃 retryEvery**（装载时报错）——各自已有 fallbackUrl / maxScrolls。
    //     "expect": { "selector": "[data-testid=note-detail]", "timeout": 8000 },
    //     // settle（动作**之前**的闸门，见下面 click 那段）这两类也收：点卡之前等这块区域画完停住。
    //     "settle": { "selector": "#feed", "stableFrames": 3 } }
    //
    // ── 操作表单（不是刷 feed）：click + 两道闸门。三个坑见 authoring.md §3.5 ──
    // { "kind": "click", "selector": "[data-testid=create-button]",   // 点按钮**别用类型选择器**：
    //     "expect": { "selector": "[data-testid=name-input]" } },     //   click 点第一个匹配，会咬人
    // { "kind": "click", "selector": ":has(> input[name=\"cf-turnstile-response\"])",
    //     "position": { "x": 36, "y": 36 },        // 相对 rect 左上角；中心对某些目标就是错的点
    //     // settle = 动作**之前**的闸门：等这块区域画完停住再动手。用于"就绪与否 DOM 看不出来"
    //     //   的目标（closed shadow root 里的挑战控件）——过早动手是有害的，不只是无效。
    //     //   判据是「**变过了** + 停住了」，基线在开始等的那一刻取。
    //     //   ⚠ 变化由**上一步**触发、而上一步比那次重绘还慢时，基线取到的就是终态，"变过了"
    //     //   永远不成立 → 每次都白等满 15 秒再放行，**且完全静默**（timeout 不致命）。
    //     //   那种情况加 "alreadyStable": true（只要求停住）。故障查表 §4.3.55，判别键是帧数。
    //     "settle": { "selector": ":has(> input[name=\"cf-turnstile-response\"])", "stableFrames": 3 },
    //     // expect = 动作**之后**的判据：等它引发的结果。别把等待焊到动作自己的 timeout 上。
    //     "expect": { "selector": "[data-testid=form-submit]", "timeout": 45000 } },
    // { "kind": "type",  "selector": "[data-testid=name-input]", "text": "{name}" },
    // { "kind": "click", "selector": "[data-testid=form-submit]" }
  ],
  "observers": [
    // Empty when a step produces items directly (an `evaluate` step feeds `output`).
    // Tier-A `state`: read a window global the page SSR-rendered.
    // { "kind": "state", "statePath": "__INITIAL_STATE__.note.noteDetailMap", "trigger": "entry",
    //     "collection": "values", "keyField": "noteId", "identityParam": "noteId",
    //     "readyWhen": "comments.firstRequestFinish", "maxWaitMs": 15000, "pollMs": 50, "input": { … } }
    //   pollMs 是 gate 的精度：条目就绪的真实时刻会被向上取整到下一个 poll 边界。xhs-detail 实测
    //   355ms 就绪，pollMs:250 会拖到 500ms 才 offer——所以宁小勿大（读一次 state 很便宜）。
    // `network`: passive XHR interception (raw snake_case body — recalibrate mapping vs an `evaluate` step).
    // { "kind": "network", "urlPattern": "*/api/sns/web/v2/search/notes*", "windowMs": 300000,
    //     "maxBodyBytes": 4000000, "input": { "itemsAt": "data.items", "dedupeBy": "id", … } }
    // `dom`: read rendered cards after a scroll step (Tier B).
    // { "kind": "dom", "itemSelector": "section.note-item", "fields": { … }, "trigger": "after-step" }
  ],
  "output": {                          // the accumulator core every step/observer feeds
    "itemsAt": "items",
    "dedupeBy": "id",                  // RAW-item path (pre-mapping) — wrong path = silent 0-count ok
    "targetCount": 100,
    "mapping": {                       // raw dot-path within ONE item → DataItem field
      "noteId": "id", "guid": "id",
      "title": "noteCard.displayTitle",          // camelCase = SDK shape (an `evaluate` step);
      "author": "noteCard.user.nickName",        //   a `network` observer reads snake_case instead
      "link": "https://www.xiaohongshu.com/explore/{id}?xsec_token={xsecToken}"
    },
    "assert": [{ "path": "items", "desc": "no items — login-wall or shape moved" }]
  },
  "policy": { "minActionIntervalMs": 900, "maxTaskMs": 300000 },
  // 一次性抽取 —— recipe 唯一的写效应：把只显示一次的明文落进**自己声明的** secret 槽。
  //   没有 ref（由 meta.runtime_config.ref 绑定），字段必须在同一份声明里且 type:"secret"，
  //   恰好命中一处才写。契约与守卫见 docs/PACKAGE.md §2.2（Extract）。抽取的判据就是这个正则本身，
  //   所以它自带等待（值要一个网络往返才渲染），不需要另猜一个"出现了"的选择器。
  // "extract": { "field": "apiKey", "pattern": "gsk_[A-Za-z0-9_-]{20,}", "timeout": 20000 },
  // 只产 secret、不产 item 的 recipe：observers 留空 + allowEmpty:true。

  "meta": {                            // self-describes as a Source (see the meta section above)
    "description": "小红书 — 搜索结果",
    "categories": ["social-media"],
    "auth": { "type": "session", "facility": "xhs", "login": "qr" }
  }
}
```

- **Observer `input` vs recipe `output`:** an observer with its own `input` (own `itemsAt`/`dedupeBy`/`mapping`) reads a different body shape than `output`; otherwise it inherits `output`. A `dom` observer with `"fallback": true` only fills identities no primary observer produced.
- `fields.<name>` (dom observer): `{ selector?, attr?, extract? }` — omit `selector` to read the card itself, omit `attr` to read `textContent`, `extract` is a regex whose group 1 replaces the value.
- **`visibility` reminder:** **一律写 `unattended`，包括要可信点击的**。lane 建好就开 focus 仿真，隐藏标签的可信输入照常落地、一次点击 0.19–0.33s（不开则 39.8–41.6s；**要真帧的步骤它救不了**，见 `session-runtime.md` 的边界）。`interactive` 只给用户得亲自动手的流程（登录、扫码、自助建 key）——采集没有这一档，一次屏都不抢。对照见 `session-runtime.md` 的 `visibility`。
- Worked live examples on disk: `packages/xhs/xhs-like.recipe.json`（`evaluate` step，从 webpack 模块表里揪站点自己的请求函数）、`packages/xhs/xhs-search.recipe.json`（scroll + `network` observer）、`packages/douyin/douyin-search.recipe.json`（同形状）、`packages/xhs/xhs-detail.recipe.json`（`locate` + `state` observer）。
