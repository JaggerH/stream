# 第 1 级落地：把一个外部 HTTP API 后端接成 plugin

> 这是 `onboard-source` skill 的一个 reference，不是独立 skill。onboard-source 成本阶梯第 1 级
> （设施有自己发布的 API 后端、带 openapi）落到这里：一个 plugin 一个 adapter，按每个 source
> manifest 声明式 `api.endpoint/query/unwrap` 路由到后端端点。

# Adding an external API plugin

An **external API plugin** fronts a facility whose data is a set of HTTP endpoints
(usually with an `/openapi.json`). Examples: Douyin_TikTok_Download_API (video-service),
any FastAPI/Express scraper. This skill is how you turn N endpoints into N Sources
**correctly and maintainably**.

## The two rules that override intuition

1. **One plugin → one adapter.** Never split a backend into `douyin`/`bilibili`/`tiktok`
   adapters just because it serves several sites. The plugin is the execution boundary
   (`docs/ARCHITECTURE.md`); the adapter id equals the plugin id. Facilities are
   distinguished per-source, not per-adapter.
2. **Routing is declarative data on the Source, not a `switch` in code.** Each Source
   carries an `api` binding in its manifest. There is NO `mode` param — a `mode` that
   selects an endpoint is an internal routing key and must never appear in `params_schema`
   (that leaks it to the user as a free-text field they have to guess).

## The `api` binding (manifest schema — see `ApiBinding` in `src/manifest/types.ts`)

```yaml
# Declarative arm — the generic executor runs it:
api:
  endpoint: /api/tiktok/web/fetch_user_post   # upstream path
  query:                                       # upstream key ← how it's sourced
    secUid: { from: sec_uid, required: true }  #   from: which params_schema field supplies it
    cursor: { from: cursor, default: 0 }       #   default: applied when the field is blank
    count:  { from: count,  default: 35 }      #   required: reject the fetch when blank
  unwrap: data.data.itemList                   # dot-path to the item array in the JSON response
  normalize: douyin                            # optional: map raw items → StreamItem bridge fields

# Handler arm — an escape hatch naming adapter code:
api: { handler: bilibili-danmaku }
```

Executor semantics (`src/adapters/<plugin>/executor.ts`): `value = params[from] ?? default`;
required-and-blank throws; blank omits the key; `unwrap` resolves a dot-path where an array
is used as-is, a single object becomes `[object]` (so anchor lookups fit the array contract),
and missing → `[]`.

## Procedure

### 1. Get the real API surface
```bash
curl -s http://127.0.0.1:8900/_p/<backend-service>/openapi.json -o openapi.json
```
Enumerate paths, methods, params (name/required/default), and — critically — note that
**formal `enum`s are rare**; option ranges are often only in the description text.

### 2. Map each endpoint to a Source (declarative first)
For each endpoint you want to expose: pick `endpoint`, map every user-facing param under
`query` (rename to the upstream key via `from`, carry defaults), and set `normalizer`.

### 3. ⚠️ Calibrate `unwrap` against the LIVE response — do NOT trust docs or old code
This is the step that bites. A backend often **passes through the upstream's own
envelope**, so the real payload is nested deeper than you'd guess. For video-service,
bilibili endpoints return `{code, data:{code,message,ttl,data:{…}}}` — the list is at
`data.data.list`, not `data.list`. **Verify every unwrap by curling the real endpoint:**
```bash
curl -s "http://127.0.0.1:8900/_p/<svc>/api/…?<real args>" | node -e '…inspect shape…'
```
If you can't get real args/credentials for some endpoints, mark those unwrap paths
PROVISIONAL in the yaml + a follow-up task — never silently ship a guess as verified.

### 4. Named handler when a declaration can't express it
Use `api: { handler: <name> }` and write the method in the adapter for: multi-step calls
(fetch A to get an id for B), pagination loops, conditional routing (param present →
different endpoint), a browser sidecar, or an injected-credential query param (login cookie).

### 5. Normalize only if `makeStreamItem` can't read the raw item
`makeStreamItem` reads `title/link/author/pubDate` + `pickIdSeed`. If the raw item already
carries usable fields (bilibili/tiktok raw JSON, read by their display normalizer, §7), return
it raw. If not (douyin awemes), register an adapter-layer normalizer and reference it via
`api.normalize` — this is the OTHER normalize (facility payload → Stream item), upstream of and
distinct from the display normalizer in §7; see the header comment in `src/content/normalize.ts`.

### 6. One adapter: executor + handler dispatch
`fetch(params, manifest)` → `isDeclarative(api)` ? `runDeclarative(...)` : dispatch
`api.handler`. Keep sidecar/follow/credentials on the single class. The package hands the
instance over ONCE from its `activate(ctx)` (`adapters: { <name>: … }`, name declared in
`package.json#stream.code.adapters`, PACKAGE.md §3) — the host never constructs it.

### 7. Display normalizer per facility (not the adapter `normalize` in §5)
The display normalizer is chosen per-source (`manifest.normalizer`; `presenter` still accepted
as a legacy alias), so one adapter can feed `douyin` / `bilibili-web` / `tiktok` display
normalizers. A normalizer lives in the package that owns the facility and is handed over from
`activate()` (`normalizers: { <name>: … }`, name declared in `stream.code.normalizers`; a name
collision refuses the whole package). `src/content/normalize.ts` keeps only normalizers whose
facility has no package yet. These normalize raw → `Content` for DISPLAY; the adapter-layer
normalize (§5) handles the StreamItem bridge. Don't conflate them.

### 8. Test against the REAL response shape
The old three-adapter tests mocked a **single-layer** payload (`{data:{list:[…]}}`) while
production returned two layers — so the tests were green but the sources returned empty in
production for a long time. **Mock the doubly-nested shape you confirmed in step 3.** The
executor's own logic (query/unwrap/normalize) is unit-tested in `executor.test.ts`; the
adapter test verifies wiring + handlers.

## Worked example — Douyin_TikTok_Download_API

- `packages/Douyin_TikTok_Download_API/manifests.yaml` — 28 sources across douyin/bilibili/tiktok,
  each with an `api` binding; **no `mode`** in any `params_schema`. `package.json#stream` also
  declares four `providers[]` rows (a `resolve` + a `transform` row per platform, `callsites`
  written on every row) and `code.enrichers` / `code.connect` — the whole facility lives in the
  package; the host has no per-platform branch (PACKAGE.md §10.1).
- `packages/Douyin_TikTok_Download_API/adapter/` — `adapter.ts` (dispatch + handlers +
  sidecar/follow; container address = `DOUYIN_API_URL` env override, else `ctx.backendUrl()`
  as a thunk under `ctx.withAwake`), `executor.ts` (declarative runner, unit-tested),
  `normalize.ts` (`toDouyinItem` bridge), `play-addr.ts` (per-platform play url extraction;
  the TikTok shape is PROVISIONAL), `danmaku.ts`.
- Declarative (18): most bilibili/tiktok anchor+timeline sources.
- Handlers (10): `douyin-user` (url→sec_user_id), `douyin-follow` (cookie),
  `douyin-resolve`/`tiktok-resolve` (vid → `/api/hybrid/video_data` → play url; member of the
  `video.resolve` rows), `douyin-fetch-url`/`tiktok-fetch-url` (url → `FetchUrlResult`,
  `output: object`; member of the `content.enrich` rows), `bilibili-comments`/`tiktok-comments`
  (conditional routing), `bilibili-danmaku` (two-step + XML), `tiktok-user-collect` (cookie).
- Constrained values as Select: `douyin-search` `sort_type`/`publish_time` carry a hand-
  written `options` list (the openapi only documented them in prose). RSSHub-catalog sources
  get `options` automatically from `routes.json`; API plugins hand-author them.
- Calibration lesson: bilibili unwrap is `data.data.*` (verified live); tiktok unwrap is
  still PROVISIONAL pending real sec_uid/item_id (see the yaml banner + follow-up task).
