# Authoring loop (source of truth)

The full procedure for compiling a request-signed / login-gated site into a Recipe. SKILL.md is the summary; this is the detail. Fill the artifact in `references/recipe-template.md` as you go.

## 0. Precondition gate (do not skip)

This skill is correct ONLY when all hold:
1. A stable Source is genuinely needed (onboard-source 判定确实需要一个稳定 Source).
2. The data is **not** directly fetchable from outside — `onboard-source` (or your own recon) shows it's request-signed / login-gated / refuses a plain replay.
3. The **user's own logged-in page** can see the data (a page-internal XHR returns it).

If the API is directly reachable → STOP. That's `onboard-source` → a normal source, a cheaper rung. A browser recipe is the most expensive rung; only request-signed / login-gated sites earn one.

## 1. Consume the router's recon evidence (do NOT re-capture)

The XHR-capture recon is owned by `onboard-source` (the router). You arrive here already dispatched with an evidence report — read it instead of re-running capture:

- **The data XHR** it identified (`METHOD status url` + payload shape), and which query values map to your inputs (search term, page, cursor → `{param}` holes). The real data XHR is often a **different host** than the page — the router's capture already resolved that; trust it.
- **The rung** it chose: **Tier-B** (the XHR body is usable → replay the page's own signed `fetch`, sections 2–5 below) or **Tier-C** (the body is opaque/encrypted but the rendered DOM carries the items → DOM harvest, see the DOM-harvest branch below and SKILL.md § Choosing a harvest method). A usable body may instead map to a Tier-A `network`/`evaluate`/`state` harvest on a canonical browser recipe — prefer that: Tier A is render-independent, so it runs full-speed in a background tab and never has to pay for frames.
- Input contract + pagination shape (cursor vs increment) from the report.

If you got here without a report (or nothing useful was captured — data loads on interaction, or after a longer delay), stop and run `onboard-source` first; its recon step is where that is resolved. **怎么抓见 `capturing.md`**（两种形态：只装了 npm 包走 `cdp_*`，有源码检出还可以用仓库脚本落盘全量 body）。

**Enhancing/debugging an EXISTING recipe is the exception to "do NOT re-capture".** If a live recipe maps a field wrong or a nested object comes back empty, re-capture the real response yourself (see SKILL.md § *Enhancing an existing recipe*) —— 照 `capturing.md` 抓一次，拿真实回包对 dot-path。Never bare-curl a signed/WAF-gated XHR (it returns a challenge page, not JSON), and never guess dot-paths from memory.

## 2. Templatize into the Recipe

Copy the chosen XHR into `request` (url/method/headers/body), replacing varying inputs with `{param}` holes.

Choose `pagination`:
- If the response echoes a token you send back → **cursor** mode. Find `cursorFrom` (dot-path to the next token), `cursorParam` (the param that carries it), `itemsAt` (dot-path to the item array), optional `hasMore`.
- If you advance a number (`page=0,1,2` or `offset=0,20,40`) → **increment** mode. Set `param`, `start`, `step`, `itemsAt`.

Set `entryUrl` (a page on the site's origin), `entryWait` (see the decision table in `recipe-template.md` — `commit` for a no-JS same-origin API, `load`/`networkidle` when signing JS must init first), `cookieDomain`, `sourceId`.

## 3. Map + assert

- `mapping`: response dot-path within ONE item → DataItem fields (`title`, `link`, `author`, `like_count`, `pubDate`, …). See the DataItem contract in `recipe-template.md`.
- `assert`: the guards that DEFINE drift. At minimum the items-array path; add the cursor path and anything that separates a real response from a login-wall or block page. A failing assert quarantines the source and (under the repair policy) triggers re-authoring.

## 4. Validate live (before saving)

Run the recipe through the real interpreter against the live site and confirm items come back AND page 2 works.

- **Fetch recipe (`kind:'fetch'`)** — quick, in a scratch script on the host, against the debuggable
  Chrome you started yourself (`--remote-debugging-port=9333`):
  ```ts
  import { runFetchRecipe } from 'src/replay/browser-fetch.ts'
  import { makeCdpLauncher } from 'src/replay/browser.ts'
  const items = await runFetchRecipe(recipe, { query: 'test' }, makeCdpLauncher())
  console.log(items.length, items[0])
  ```
  It opens its own tab in that browser and closes only that tab. In production the same recipe runs
  on the ext-cdp launcher instead — same page, same session, no rewrite.
- **Canonical browser recipe (`kind:'browser'`, `steps`+`observers`)** — runs through `SessionRecipeExecutor` on a session lease, not a bare launcher call. Build/debug against your own logged-in Chrome via the extension relay and watch the items map; that is also production, so there is nothing to flip afterwards. (`record validate <sourceId>` / `runValidate` only replays the **legacy** `actions`+`harvest` form — a canonical recipe is exercised by triggering a harvest.)
- Or add a gated test mirroring `src/adapters/replay/adapter.integration.test.ts` and run with `RUN_BROWSER_TESTS=1`.

If it 401s / returns a login-wall / empty: revisit `entryWait` (signing JS not ready), cookies (`cookieDomain` + broker), or your endpoint choice (you may have picked a telemetry/isalive XHR, not the data one).

## 5. Save (+ optionally publish as a Source)

校验后写进包目录那份文件：

```ts
import { validateRecipe } from 'src/replay/recipe-store.ts'
validateRecipe(recipe.sourceId, recipe)        // 先过校验，别写一份装不上的
// → packages/<facility>/<sourceId>.recipe.json
```

**文件名必须以 `.recipe.json` 结尾**：扫描器只认这个后缀。写成 `<sourceId>.json` 装载器一眼都不会
看它——不报错、不警告，只是这条 Source 从此不存在。

> 这是**源码检出**那一档。`npm` 装的那一档写进 `<dataDir>/recipes/<名字>/`（两个文件、写完就
> 生效、判据是 `GET /api/recipes/local`）——唯一的说法在 `recipe-template.md` 的
> 「写完的 recipe 放哪」。

The recipe's **`meta` block makes it a Source** — the loader synthesizes the `SourceManifest` from `meta` + the recipe body (`src/replay/recipe-manifest.ts` → `recipeToManifest`), so you do **not** hand-write a manifest. Set `meta.description` (the one field worth authoring); `id`/`adapter`/`capabilities`/`auth` derive automatically. A `manifests.yaml` entry is an optional full override.

## DOM-harvest branch (Tier B — `dom` observer)

Take this branch when the router's evidence says the feed XHR is signed **and its body is opaque/encrypted** and no request client is reachable, but the rendered DOM shows the items. Instead of replaying an XHR you scroll the logged-in page and read the rendered cards. This is a **Tier-B** recipe (needs live render) — it runs in a background tab too, it just has to force a frame per action (see `authoring.md` §1). Sections 2–4 above (templatize XHR / map / paginate — the `kind:'fetch'` path) are replaced by the steps below; `entryUrl`/`entryWait`/`cookieDomain`/`sourceId`/`session` still apply.

**C1. Snapshot the DOM.** From the same logged-in session, capture structure instead of network. It
drives a Chrome **you** started with a debugging port (not one in the container — that image has no
browser), so run it on the host:
```bash
chrome --user-data-dir=/tmp/stream-chrome --remote-debugging-port=9333 &
pnpm exec tsx scripts/recipe-dom-capture.ts "<entryUrl>"
```
It reports **repeating-container candidates** (the repeated feed card → your `itemSelector`) and **field candidates** (child selectors with stable text/href → your `fields`). To eyeball the same surfaces live instead, use `cdp_look` (see `drive-live-ui`).

**C2. Build the `dom` observer + `scroll` step.** Canonical shape (`steps` + `observers`, schema in `recipe-template.md`):
- `steps: [{ "kind": "scroll", "dwell_s": [3,6], "maxTimes": 40, "noProgressStop": 6 }]` — drives the feed so more cards render. Give `noProgressStop`/`maxTimes` headroom.
- `observers: [{ "kind": "dom", "itemSelector": <card>, "fields": { <name>: { selector?, attr?, extract? } }, "trigger": "after-step" }]` — read the rendered cards after each scroll tick. Omit `selector` to read the card itself; omit `attr` to read `textContent`; `extract` is a regex whose group 1 replaces the value.
- `output`: `itemsAt: "items"`, a **stable per-card id** in `dedupeBy` (usually the note id from the card's `href` via `extract`), `targetCount`, and the `mapping`.

**C3. Login-wall two-signal.** Set `loginCheck` with BOTH a `loggedIn` selector (present only when authenticated) and a positive `wall` selector (the login/verify overlay). The runner probes login state at entry and on every scroll tick and **aborts the instant WALLED** — so a login wall surfaces as `needsLogin`, never as drift. Read both signatures off the live page with `cdp_look` — log out in a spare profile to see the wall one.

**C4. Session.** Set `session: { facility, lifecycle, visibility }` (there is no `transport` key — one browser). `visibility` **一律写 `unattended`，包括要可信点击的 Tier B**——focus 仿真兜住隐藏 tab 的可信输入（一次点击 0.19–0.33s，见 `session-runtime.md`；要真帧的步骤它救不了，同一节）。`interactive` 只给用户得亲自动手的流程（登录、扫码、自助建 key），采集没有这一档。Every scroll decision is seeded → replay is deterministic and token-free.

**C5. Validate to target within tolerance.** Trigger a harvest against the live logged-in session; confirm it reaches `targetCount` deduped items within the tolerance (xhs: 100 items in 5 min), no drift, and — when logged out — that it reports `needsLogin` (not drift). Then save it (§5).

## Worked example — Hacker News (benign, no login)

1. 抓一次（`capturing.md`；实测这一页两种形态都走通过）→ 数据是那条 POST 到 Algolia 云的
   `…/1/indexes/Item_dev/query`，回包 `{"hits":[…]}`，请求 body 里 `"page":0` 就是翻页那一格。
   为了一个更简单的公开门面，我们改用 HN 自己的 REST 端点 `https://hn.algolia.com/api/v1/search`。
2. `request.url = https://hn.algolia.com/api/v1/search?query={query}&hitsPerPage=20&page={page}`, `method GET`.
3. `pagination = { mode: 'increment', itemsAt: 'hits', param: 'page', start: 0, step: 1, maxPages: 2 }`.
4. `entryUrl = https://hn.algolia.com/`, `entryWait = commit`, `cookieDomain = ""`.
5. `mapping = { title, url, author, like_count: 'points', pubDate: 'created_at' }`; `assert = [{ path: 'hits', desc: 'no hits array' }]`.
6. Validate live → items return, page 2 works. 校验后写 `packages/<facility>/replay-hn.recipe.json`（§5）。

The committed result is one recipe file inside the facility's package: `packages/<facility>/replay-hn.recipe.json`（manifest 由 recipe 的 `meta` 派生，不用另写）。

## Guardrails

- **Credential hygiene.** Prove the flow on a neutral / low-stakes target first; bring the user's own session (e.g. xhs) only once the mechanism is green. Single session, human cadence — it is literally the user's own account in their own browser, so a runaway loop is visible to them and costs them the session. Never paste a credential into a recipe: a recipe is shareable code-as-data.
- **Recipe = data.** If the site needs behavior the schema can't express, extend `recipe.ts` + `interpret.ts`, don't smuggle logic into the recipe.
- **Authoring only.** Nothing here runs at runtime; the `replay` adapter executes the saved recipe deterministically, zero tokens.
