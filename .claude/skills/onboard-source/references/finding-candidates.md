# Discover or build a Source (stable-first)

You have an intent or a capability gap; produce a **stable, contract-verified Source** to bind into an exclusive Stream's ladder or a Provider's members (vocabulary: `docs/ARCHITECTURE.md` / `references/model.md`). "Finding a source" is one step — iterate until the capability contract is met.

**「候选」在这个仓库里有两种，别走错门。** 这一份找的是**源**（谁在产出这类内容，接进来
之后长期供数）。要找的若是**一批具体的东西**（符合某组约束的商品型号、某个品类下有哪些
选项），那是发现循环的商品档 `enumerate_candidates`——一次性枚举、当场用完，不进 registry、
不建 Stream。两者共用同一条 `runSearch` 骨架（找聚集地 → 进窝抽 → 验），只是域不同，机制见
`docs/ARCHITECTURE.md` "There is one discovery loop and two domains"。**判据一句话：产出的是"以后一直从这儿
取数"还是"这一次要的那几条"？** 前者才走下面这条阶梯。

## What counts as a capability (read first)

The **capability registry is the packages' manifests** (`packages/<id>/manifests.yaml`, plus the manifests derived from recipe `meta`) — and ONLY that. A manifest is the authoritative declaration of what a Source can do (`provides` / `capabilities` / `categories` / `topics` / `description`). **Source code is NOT the capability registry**: `src/adapters/*`, and especially `src/audio/**`, are *implementation*. A capability that exists only in code is **UNDECLARED** — treat it as not-available. Do NOT grep code to claim a capability; either declare it (annotate a manifest) or advance the ladder.

## The acquisition ladder — advance, never substitute

STOP at the first tier that satisfies the contract. If a tier does not, **advance to the next**; do not fall back to grepping source code.

1. **Manifests** (`packages/<id>/manifests.yaml`, `packages/<id>/package.json` → `stream.sources`) — use `stream_sources` (MCP tool) /
   `GET /api/plugins/sources?query=&capability=search` to search the WHOLE registry (curated +
   RSSHub catalog, cross-plugin, faceted, grouped by plugin) in one call by the intent's topic —
   don't hand-grep manifest files. None matches the capability → tier 1.5.
2. **Already-loaded but untagged** — a source can be *structurally* capable (the adapter can do it, the RSSHub route exists and is already in the loaded catalog) yet *organizationally invisible* (no manifest declares the `provides` tag a Provider's `mode:'auto'` fan-out matches on), because `provides` is curation-only and never auto-derived. Check this BEFORE assuming tier 2/3 work is needed:
   - RSSHub's catalog loader (`src/rsshub-catalog.ts`) auto-tags `capabilities:['search']` on any route whose path matches `/search` or whose params include a query-like name (`kw`/`keyword`/`query`/`q`/…) — but it never sets `provides`. So a real, working, zero-adapter-code route can already sit in the registry under `rsshub:<facility>/<route>` with `capabilities:[search]` and simply not participate in the Provider you need.
   - `stream_sources` / `GET /api/plugins/sources?query=<facility>&capability=search` (same tool as tier 1) surfaces these too — a route with `capabilities:[search]` but no matching `provides` tag is exactly a tier-1.5 hit, not a tier-1 miss to escalate past.
   - Found one → **present it to the user before wiring anything in** (which candidate to use is a judgment call — see `extend.md`'s search → confirm → wire workflow), then **don't build anything** — add (or extend) a curated override entry for that route in `packages/<id>/manifests.yaml` (or `stream.sources` in `packages/<id>/package.json`) with `provides: [<target-type>]` (see `docs/PACKAGE.md` §1). The route's `{...}` placeholder names are yours to choose (they only need to match whatever `params` the calling code passes — e.g. content-search always calls with `params.keyword`, so write the route template as `/facility/route/{keyword}`, regardless of what RSSHub's own docs call that param). Worked example: `bilibili-search` in `packages/rsshub/manifests.yaml` — RSSHub's `bilibili/vsearch/:kw/...` route already existed and was already catalog-tagged `capabilities:[search]`; the only work was one curated entry adding `provides:[search-content]` + a route template using `{keyword}`.
   - None found → tier 2.
3. **RSSHub** (build a NEW route binding, not present at all) — the loaded catalog (`config.rsshub_catalog`) AND the configured local checkout (plus any `feature-*` route branches). Search routes / docs / Radar for the site, domain, upstream service name. A found route → annotate a manifest (`provides` / `key_param` / `fixed_params`) → a **stable Source**. Else → tier 3.
4. **Online public sources + GitHub** — public hosted sites / APIs and open-source libraries that fit. A self-hostable lib → wrap as a plugin backend (`packages/<id>/package.json` → `stream.backend`, see `docs/PACKAGE.md` §4) → **stable**. A third-party hosted site you don't control → **ephemeral**. Else → tier 4.
5. **Build a new RSSHub route** — LAST resort, only when the site's API is reachable / reverse-engineerable. **REQUIRED SUB-SKILL: use `rsshub-routes`.**

Converge findings into stable Sources and **declare them as manifests** so they enter the registry.

**Don't trust an existing normalizer/binding as proof a capability is live.** A named normalizer (e.g. `bilibiliSearchNormalizer`) or a legacy binding (e.g. old `flows/seeds.ts` search-bindings) can predate a *different* implementation than the one you're about to wire — check the shape it actually expects (raw item fields) against what your chosen route/adapter actually returns before reusing it; if they don't match, use the generic normalizer for that adapter instead of forcing the specific one.

### Cold start vs cluster expansion (which technique when)

The ladder works from a **bare intent with no known site** — that's the common case, and **tiers 1–2 ARE the cold start**: search the packages' manifests by the intent's topic, then RSSHub's catalog / Radar / category browse by the intent's **topic, domain, or upstream-service keywords** — none of which require a site you already know. You go from "vague intent" to "first candidate" here.

**Fingerprint search (below) is a SECONDARY, cluster-expansion technique**, not a cold-start one: use it only once tiers 1–2 have handed you ≥1 sample, to find that sample's siblings. If you have zero candidates, you are doing tier-1/2 topic search — not fingerprint search.

## Finding sibling sources — fingerprint search (high-leverage, needs ≥1 sample)

Given ONE known source, find its siblings by searching the **distinctive on-page signature the known examples share**, NOT generic capability terms. This is "find more like this".

- **Worked case (netease lossless):** `music.znnu.com` + `wyapi.toubiec.cn` both carry the phrase **"网易云音乐解析工具" / "网易云无损解析"**. Searching that exact phrase surfaced 5 more parser sites (`music.ins2.cn`, `tools.kalvinbg.cn`, `tools.qzxdp.cn/wyy_vip`, `gljlw.com`, `bzqll.com`) that generic queries ("netease lossless download api") never returned.
- **Region caveat:** web search is region-bound. A US-region engine under-covers Chinese long-tail sites; for region-specific clusters (Chinese parser/finance/news sites, etc.) use a **same-region search path** (a Chinese engine / hand off the fingerprint phrase), or you miss the whole cluster.

## Capability-contract check

For each candidate Source: 1) **Fresh?** latest content, push / low-cadence not slow poll. 2) **First-hand / real-time?** original source, not a lagging mirror. 3) **Broad enough?** covers the intent's breadth, or add more. 4) **Access constraint met?** e.g. *usable without the user's own paid account* (a self-hosted parser needing the user's own VIP fails an "I don't want to pay" contract; a public site with its own access passes). 5) **Durable enough for the intent?** A one-shot fetch can tolerate an ephemeral tier-3 source; an ongoing **subscription** cannot — an uncontrolled ephemeral source can vanish, so for a subscribe-intent prefer a stable tier-1/2 source and ship ephemeral only as a flagged stopgap.

Iterate (add / prune) until met or no further stable Source exists. **Verify end-to-end** (actually fetch one result), not the page's *claim*.

## Output

A candidate list: `{ source, tier, stability: stable | ephemeral, contract_verdict, claimed_capability, verified? }`. **Present this list to the user and confirm which candidate(s) to use before wiring anything in** — don't silently pick the top-ranked hit. Once confirmed, bind the stable, contract-satisfying Source(s) as a Provider's members (ordered, stable-first) → `references/extend.md`'s search → confirm → wire workflow (live `/api/providers` CRUD, not `providers/seed.ts`).

## Common mistakes

- **Grepping source code to claim a capability.** Capability = what the packages' manifests declare, not what code implements. `src/audio/**` is legacy. Only in code = undeclared; advance the ladder or annotate a manifest.
- **Stopping after the manifest tier is empty.** Empty = advance to RSSHub / online, NOT conclude "nothing".
- **Reaching for fingerprint search with no sample in hand.** That's a cold start → tier-1/2 topic search first; fingerprint only expands an existing sample's cluster.
- **Searching generic capability terms instead of a known sample's page signature** (once you have a sample). Fingerprint-search the shared on-page phrase to get the cluster.
- **Trusting a page's claim without an end-to-end probe**, and ignoring access / durability constraints (a "lossless" site that needs the user's own VIP, a flash feed that's actually a slow poll, or an ephemeral site you'd subscribe to).
- **Auto-wiring the top candidate without asking the user.** Search tools rank by text match, not by the freshness/region/redundancy/access judgment calls in the contract-check above — always confirm the pick with the user first.
- **Editing `providers/seed.ts` to add a source to a live deployment.** Seed rows only apply to a fresh install with an empty `providers` table; a running deployment's Provider row lives in the DB and must be changed via `/api/providers` CRUD (see `extend.md`).
