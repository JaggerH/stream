---
name: rsshub-routes
description: 用 RSSHub 路由把一个站点接进来（onboard-source 成本阶梯第 2 级：站外裸 HTTP、不跑 JS 就能取到）。检查已有路由是否覆盖、逆向目标站/API、写或修 RSSHub 路由代码、套官方 route/cache/date/script 规范、本地验证。新源的产出物是 recipe（分享跟着走）；既有 RSSHub 源只读消费。判路不在这里（那是 onboard-source）。
---

# RSSHub Routes

## Purpose

用这个 skill 做 RSSHub 路由工作：调查、实现、本地接入、或准备 PR。保持上下文精简：先读 workflow，再按当前步骤只加载相关的官方 reference。

## 在成本阶梯里的位置

这是 `onboard-source` 成本阶梯的**第 2 级——服务端 fetch 后端**，不是独立入口。当侦察表明目标数据**不跑页面 JS、裸 HTTP（可带 cookie）就能取到**时，入口派发到这里。它和 `write-recipe` 的页内 XHR 重放（第 3 级）是兄弟：都是"模板化 fetch → 映射字段"，只由一条判断分界——*不跑 JS 能不能取到？*。带着入口的证据报告进来，不要重跑 XHR 捕获（侦察归上游）。

## 分享：新源的产出物是 recipe，不是 RSSHub 路由

**第 2 级的产出物是 `kind:'http'` / `kind:'html'` 的 recipe**（`src/replay/recipe.ts`），住在用户自己的
`<dataDir>/recipes`，随 Channel/Stream 分享包走。`openspec/specs/acquisition-routing/spec.md` 把这条写死成
「Tier 2 **SHALL NOT** route to an external-repository contribution path」。

**为什么不是 RSSHub 路由**：路由住在 RSSHub 那个仓库里，A 写完分享给 B，B 那边没有这条路由，
Channel 里那个 id 就是空的——**分享链条断在这儿**，而且要等上游合并才能补上。recipe 没有这个问题：
它是用户自己的数据，不依赖任何人点头。

**用户个人想向 RSSHub 上游贡献路由，仍然可以**（社区行为，我们乐见）。退役的是「Stream 引导 agent 去提 PR」
这条**产品路径**，不是禁止贡献。

**RSSHub 的既有源一个不删**：`src/rsshub-catalog.ts` 扫已安装 npm 包里的路由，那 3000+ 个源继续当只读目录
消费。不主动迁成 recipe——只在某个源坏了要修时，顺手把那一个迁掉。

## Progressive Disclosure

Always read `references/rsshub-route-workflow.md` before reverse-engineering, editing RSSHub code, opening/updating a PR, or merging a route into a local branch.

Read these references only when the situation needs them:

- `references/official/start-code.md`: when creating or materially changing a route, namespace, radar metadata, route handler, docs entry, or route examples.
- `references/official/script-standard.md`: before writing or reviewing RSSHub route code.
- `references/official/use-cache.md`: when the route performs per-item detail fetches, repeated upstream calls, expensive parsing, or any request that should not run again on every feed hit.
- `references/official/pub-date.md`: whenever source data has dates, timestamps, relative time, unknown timezone, or no reliable date.
- `references/official/submit-route.md`: when preparing, updating, reopening, or reviewing a GitHub PR.

For PR work, also read these files from the current RSSHub checkout when present:

- `.github/PULL_REQUEST_TEMPLATE.md`
- `scripts/workflow/test-route/identify.mjs`
- `scripts/workflow/test-route/test.mjs`
- `.github/prompts/pr_review_rules.md`

## Operating Rules

- Start from the user-provided target URL or route requirement. Confirm existing RSSHub support before designing a new route.
- Do not code until one realistic upstream request has been replayed or otherwise proven to return the required data.
- Record material decisions and evidence: support search, existing PR state, official docs read, request shape, response fields, pagination findings, files changed, tests, local branch merge, and PR actions.
- Route-specific inputs belong in Hono path parameters; RSSHub common controls remain common query parameters. Do not invent custom query parameters for route configuration unless current maintainer guidance requires it.
- `route.parameters` must document only real path parameters, and keys must match the path parameter names exactly.
- Audit radar for the whole namespace whenever you add OR repair a route — a healthy handler can still mis-map a pasted URL, and a wrong radar rule is worse than none. Never leave a bare root catch-all (`host/:param`): it swallows reserved paths like `/watch` and `/feed`. See the workflow's Radar Rules.
- `features.requireConfig` is a contract downstream consumers read to decide credentials: mark `optional: true` when the route works without the config, and never name an API credential (`*_KEY`, `*_TOKEN`) as if it were a browser cookie (`*_COOKIE`, `*_SESSION`).
- Do not implement page-turning unless RSSHub maintainers explicitly ask for it. Prefer latest upstream items plus RSSHub common `limit`.
- Develop upstreamable work on a clean `feature-<site-or-provider>` branch cut from RSSHub's upstream default branch. Do not base new provider work on `local`.
- If the user needs the route locally, merge the completed feature branch into the local RSSHub branch named `local` after verification.
- Do not push, open, reopen, or close a PR unless the user asks for that PR action.

## Evidence Standard

Before implementation, know:

- the working upstream endpoint/request and required parameters;
- the stable fields for title, link, description/content, author/source, media/download URL, cover, categories, and dates when available;
- whether lyrics/full text/detail fields require secondary requests;
- whether pagination exists and whether it should be exposed;
- likely failure modes: missing data, rate limits, cookies, anti-bot checks, encrypted/obfuscated payloads, or expiring URLs.

If any evidence is missing, state what is missing and whether it blocks implementation or only weakens confidence.
