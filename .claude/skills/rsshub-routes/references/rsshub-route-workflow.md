# RSSHub Route Workflow

This is the execution guide for RSSHub provider work. Paths such as `.github/`, `scripts/`, and `lib/` are relative to the checked-out RSSHub repository root. Paths under `references/` are relative to this skill directory.

## Step Log

Keep a concise working log:

```markdown
## Target
- Site/provider:
- URL(s):
- Desired fields:
- Local availability needed:

## Existing Support
- Docs/source searched:
- Result:
- User decision if support exists:

## Existing PR
- PR URL/number:
- State:
- Latest official feedback:

## Reverse Engineering
- Entry URL:
- Request method/URL:
- Params/body:
- Headers/cookies/tokens:
- Response shape:
- Fields:
- Pagination:
- Sample input/result:

## Radar
- Routes in this namespace with NO radar rule:
- Root catch-all patterns found (`host/:param`):
- Reserved paths that must not match:
- Pasted-URL check (URL -> route + params):

## Config Declaration
- requireConfig names + kind (cookie | API credential):
- Optional (route works without it)? yes/no:

## Implementation
- Branch/base:
- Files changed:
- Route path:
- Official references read:
- Test cases/manual samples:

## Verification
- Commands:
- Results:
- Local merge:
- PR action:
```

## Reference Selection

Read official references only at the step that needs them:

| Task | Required references |
| --- | --- |
| Create/change route code | `official/start-code.md`, `official/script-standard.md` |
| Add namespace, docs metadata, route examples, radar | `official/start-code.md`, plus Radar Rules below |
| Add OR repair ANY route (radar audit is not optional) | Radar Rules + Config Declaration below |
| A route returns 503/empty and you must fix it | Repairing A Broken Route below |
| Per-item detail fetches or repeated upstream calls | `official/use-cache.md` |
| Any source-provided date/time/relative date/timezone | `official/pub-date.md` |
| Prepare/update/reopen PR | `official/submit-route.md`, RSSHub PR template, route-test parser, review rules |

Use current RSSHub repo files as the final authority when they differ from the downloaded references.

## Existing Support Check

1. Search current RSSHub docs and source for exact provider name, domain, product aliases, upstream API names, and Chinese/English names.
2. If a route exists, stop and ask whether to use it, repair it, or still build a distinct route because the existing one is not equivalent.
3. If no route exists, record the search terms and continue.

## Existing PR Check

Ask whether the user has an open RSSHub PR for this provider/site. If yes, inspect PR state and latest maintainer/reviewer comments before coding. Address official feedback before adding new scope.

## Reverse Engineering

Prove the data path before implementation:

1. Open or request the target page/API and identify the smallest request that returns useful data.
2. Record method, URL, params/body, required headers, cookies, tokens, referer/origin, response type, and rate-limit or anti-bot behavior.
3. Replay a realistic input outside the browser.
4. Identify stable feed fields: title, link, description/content, author/source, media/download URL, quality/format, cover/image, category, and source date.
5. Check detail endpoints and wrap repeated per-item requests with cache during implementation.
6. Check whether pagination exists. Do not expose it unless maintainer guidance or the route use case clearly requires it.

## Branch Flow

Use a clean feature branch from RSSHub's upstream default branch:

```bash
git switch <upstream-default-branch>
git switch -c feature-<site-or-provider>
```

If a branch already exists, verify it was not cut from `local` or another provider's branch. Use `local` only as an integration branch for the user's local RSSHub instance after the feature branch is complete and verified.

## Implementation

Follow `official/start-code.md` and `official/script-standard.md` for route shape and code style. In practice, expect to add or update:

- namespace metadata;
- one or more route modules;
- route tests and fixtures;
- docs/category metadata generated from route definitions;
- radar metadata only when the source URL can map cleanly to a route;
- maintainers and feature flags.

Keep new providers independent. Do not add a new provider's tests to an unrelated provider test file.

## Route Parameter Design

- Route-specific user inputs belong in `route.path` as Hono path parameters such as `:id`, `:category?`, or `:mode?`.
- `route.parameters` documents only real path parameters. Keys must match path parameter names exactly.
- RSSHub common post-processing options stay as query parameters: examples include `limit`, `filter`, `filterout`, `sorted`, common `mode`, and output format options.
- Do not add custom query parameters for route configuration, category, tag, SDK, sorting, or filtering. If a source-level option should be exposed, make it a path parameter with defaults and validation.
- Do not implement page-turning unless current RSSHub maintainer guidance asks for it. Prefer latest upstream page plus common `limit`.
- PR `routes` blocks and route `example` values must use concrete paths, never `/:param` placeholders.
- Radar `source` must be host/path only: no protocol, query, or hash. Add `target` only when the source URL contains enough information to construct the RSSHub path.

## Radar Rules

Radar is how a pasted URL becomes a subscription. **A wrong radar rule is worse than no rule**: it resolves confidently to garbage params, and the failure surfaces later as a misleading upstream error, far from its cause. Audit radar for the whole namespace whenever you add OR repair a route — a route handler can be perfectly healthy while its radar mis-maps.

Type facts (`lib/types.ts`, authoritative): `source: string[]` is host/path only — **it cannot express a query string**. `target` may be a string or a function, but **function targets are deprecated** (RSSHub-Radar 2.0.19); do not add one.

**Never leave a bare catch-all at the domain root.** `host/:param` matches EVERY single-segment path, including reserved ones (`/watch`, `/playlist`, `/feed`, `/search`, `/login`, `/about`). Real failure: youtube's `www.youtube.com/:username` captured `https://www.youtube.com/watch?v=…` as `username: "watch"`, and the subscribe attempt died upstream with `id is missing`. RSSHub has ~175 such root-level patterns, so assume yours is one of them until checked.

If the site genuinely puts identifiers at the root, anchor the pattern so it cannot swallow reserved paths — a distinguishing prefix or suffix (`www.youtube.com/@:username`, `www.youtube.com/:username/videos`) beats a bare `:param`. A catch-all is usually load-bearing for one real case, so **check what it is before removing it**: youtube's exists so `/@handle` captures the handle, and the capture EXCLUDES the `@` (`medium.com/@:user` is the shipped precedent), so a target that must keep it has to re-add it (`/user/@:username`). Splitting one catch-all into anchored rules is only correct if every case it served still resolves.

**A route a user would plausibly paste a URL for should have a radar rule** — with no rule it is invisible to URL-based subscription. But first check the rule is *expressible*: a missing rule is sometimes a mechanism limit, not an omission, and writing one anyway ships a rule that resolves to the wrong params.

**The identifier must live in the path.** `source` captures host + pathname only; the query string is not part of the capture. When the id lives only in the query (`?list=`, `?v=`), there is no working way to express it today:

- A **function `target`** looks like the escape hatch and ~92 routes use one, but they are **silently dead**: `scripts/workflow/build-routes.ts` interpolates the target into a template literal, so a function is `toString()`d into the shipped rules — `"target": "/linkedin(params,url)=>{const searchParams=…"`. That is why `lib/types.ts` marks them deprecated. Never add one, and don't trust an existing one.
- **Query in `source`** survives the build (`maoyan.com/films?showType=1`) but only as a *static disambiguator*. Whether the matcher can *capture* `?list=:id` is decided by the RSSHub-Radar extension, not this repo — verify before relying on it.

So: record the limitation and raise it with maintainers instead of inventing a pattern. Killing a bad catch-all makes such a URL resolve to *nothing* rather than to something wrong — strictly better, but do not call that "fixed".

**Verify against the BUILT artifact, not the source.** Subscribers consume `assets/build/radar-rules.json`; a rule can look right in the route file and be garbage after the build (see the function-target bug above). Walk a real pasted URL through the built rules by hand — URL → matched `source` → params → target route — and put the result in the Step Log's Radar block.

## Config Declaration (`features.requireConfig`)

Downstream consumers derive a route's credential requirements from `requireConfig`, so it is a contract, not a comment. Two things carry meaning:

- **`optional: true` means the route works without the config** (youtube falls back to scraping when `YOUTUBE_KEY` is absent). Omit it and consumers hard-fail a route that would have worked unauthenticated.
- **The env var name signals its kind.** `*_COOKIE` / `*_COOKIES` / `*_SESSION` / `*_AUTH_*` are browser cookies a cookie jar can supply; `*_KEY` / `*_TOKEN` / `*_CLIENT_ID` / `*_SECRET` are API credentials that a cookie must never be stuffed into. Real failure: a consumer treated `YOUTUBE_KEY` (a Google API key) as a cookie and reported a bogus "no cookie for youtube.com" for a route that needs no cookie at all.

When repairing a route, re-check that its `requireConfig` still matches reality — a rewrite can make a credential unnecessary.

## Repairing A Broken Route

Before redesigning anything, locate the failure layer — the same 503 can come from three places:

1. **Global middleware** (`lib/middleware/*`) — if EVERY route fails, the route is innocent. Real failure: a broken `entities.decodeXML` import in `parameter.ts` 503'd the entire instance.
2. **The handler** — read the running instance's logs for the actual stack, then replay the smallest upstream request yourself.
3. **Upstream moved.** A page that stops yielding data is often behind a new anti-bot/WAF challenge, or its data moved to an API. Check for an official API before writing a scraper: IMDb's chart pages now return a WAF interstitial with no `__NEXT_DATA__`, while `api.graphql.imdb.com` serves the same data unauthenticated.

## Cache And Date Rules

- Read `official/use-cache.md` before adding detail fetches inside `map`, loops, or per-item enrichment.
- Prefer `cache.tryGet()` for processed item/detail results. Do not rely on assignments outside the `tryGet()` callback during cache hits.
- Read `official/pub-date.md` for every source date. Use `parseDate()` or `parseRelativeDate()` rather than raw strings when possible.
- Leave `pubDate` undefined when the source provides no reliable date. Do not invent a time when the source only provides a date.
- Apply timezone conversion when the source timestamp is in a known timezone that differs from the server interpretation.

## Verification

Run the narrowest meaningful checks first:

- route-specific tests, for example `pnpm test lib/<provider>.test.ts`;
- route build/format/lint commands required by current RSSHub docs or touched files;
- manual local request for each concrete route example.

Record failures separately from unrelated ambient failures.

## PR Readiness

Before any PR action:

1. Read `official/submit-route.md`.
2. Read `.github/PULL_REQUEST_TEMPLATE.md` and fill the `routes` fenced block with concrete route examples.
3. Read `scripts/workflow/test-route/identify.mjs` to confirm the examples are parseable.
4. Read `.github/prompts/pr_review_rules.md` and review the changed diff against it.
5. Ensure route examples start with `/`, contain no placeholders, and cover materially different enumerable modes.
6. Use `NOROUTE` only for non-route changes.

Common blockers: placeholder examples, route name repeats namespace name, `parameters` keys do not match path params, source dates skip parsing, repeated detail requests skip cache, radar source includes protocol/query/hash, custom route options are put in query parameters, a bare root catch-all radar pattern (`host/:param`) that swallows reserved paths, a deprecated function `target`, and `requireConfig` that omits `optional` or names an API credential as if it were a cookie.

## Local Branch Merge

When the user wants the route usable locally:

1. Finish and verify the feature branch.
2. Switch to `local`, creating it only if the user explicitly wants that and it does not exist.
3. Merge the feature branch into `local`.
4. Resolve conflicts without dropping unrelated local changes.
5. Report feature branch head and local branch head.
