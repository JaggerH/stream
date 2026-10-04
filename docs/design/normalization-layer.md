# Stream Normalization & Enrichment Layer — Design

> Decision record from the 2026-06 brainstorm. Captures the architecture; v1 build
> scope is the **display adaptor layer** (raw → archetype Content). Tagging,
> entity-linking, and the shared commons are roadmap, recorded here so the v1
> contracts don't paint us into a corner.
>
> This record calls the layer "presenter"/`present()` throughout, matching the
> code as first shipped. The code has since been renamed to match THIS doc's own
> higher-level vocabulary — "normalizer"/`normalize()` — so read `presenter` here
> as `normalizer` and `present()` as `normalize()`; left as originally written
> since this is a decision record, not living documentation.

## Where Stream sits

```
RSSHub (free upstream fetch; community-maintained; absorbs scraper breakage + ToS surface)
   │   ← we DON'T fork or take it over. We contribute scrapers upstream (path "C").
   ▼
Stream = the encapsulation layer:  normalize → de-junk → tag → entity-link → reusable unit
   │   ← this is the moat. Fetching is free; making feeds into reusable knowledge is the value.
   ▼
wiki / knowledgebase (the user's sovereign knowledge)
```

RSSHub is a **free信源**, not a thing we control. Its one downside — we don't control
what/how a published route scrapes (it flattens structure into html) — is handled per
source by the **input strategy** below, not by forking.

## Value, precisely

Stream turns a raw feed item into a **reusable, KB-ready knowledge unit**:
1. **normalize** — one typed model regardless of source (this doc's v1 scope)
2. **de-junk** — drop noise/low-quality items
3. **tag** — topical tags on each post
4. **entity-link** — resolve mentioned entities to a shared entity graph
5. **canonicalize to the article** — same article across feeds/users = one unit

(2)–(5) are roadmap; (1) is v1.

## Public commons vs private — the load-bearing line

"All users benefit from shared processing" only holds by **content visibility**:

| Shared | When | Why |
|---|---|---|
| **Rules** (presenters, tag taxonomy, entity dict) | always | data/logic, no privacy — a community asset (the "RSSHub of normalization") |
| **Enriched content** (clean text + tags + entities of a *public* item) | public only | do-once-all-benefit; a knowledge **commons**; amortizes heavy compute |
| **Entity graph** | always (the registry); private *links* stay private | canonical entities are shared; what private content links to them is not |
| **Private item enrichment** (DMs, private bookmarks) | never | sovereign; stays in the user's own vault — the original "private data" thesis |

→ Two planes coexist: a **public commons** (shareable, monetizable hosted compute) and a
**private personal** plane (sovereign, self-hosted). Economics fall out: public enrichment
is hosted/paid (compute once, all benefit, great margin); private is self-host/free.

## canonical_id — the join primitive (roadmap)

Article-level identity (`bilibili:BV…`, article URL, content hash) is the join key for:
dedup across users+feeds · shared-enrichment cache key · entity-link anchor.
Not built in v1, but `Content` leaves room for it.

## v1 scope: the display adaptor layer

A **presenter** maps a raw source item → a typed `Content` (archetype + media + quoted).
The frontend renders `Content` by archetype; it never parses source html again.

### Content model (the stable contract)

```ts
type Archetype = 'text' | 'article' | 'video' | 'gallery' | 'link' | 'forward'
                 // | 'message' | 'email'  (reserved; not in v1 core)
type Media =
  | { kind:'image'; url; thumb?; w?; h?; alt? }
  | { kind:'video'; embed?; poster?; duration_s?; page_url? }
  | { kind:'link';  url; title?; summary?; image? }
interface Quoted { author?; text?; media?: Media[]; permalink?; archetype?: Archetype }
interface Content {
  archetype: Archetype
  title?: string      // article title
  text?: string       // own text, cleaned (noise stripped)
  media?: Media[]
  quoted?: Quoted     // forward target (recursive)
}
```

### Presenter dispatch + input strategy

- `present(raw, manifest) → Content`. A registry keyed by `manifest.presenter`
  (falls back to a generic default).
- **Default presenter**: generic over RSSHub html — attachments→video, `<img>`→gallery,
  else text/article; strips RSSHub noise (cover img already shown as player, "视频地址:"/
  "专栏地址:" tails, `[图片]` placeholders).
- **Per-source presenters** (e.g. bilibili): classify into archetype + extract typed fields.
- **Declarative first, code as escape hatch**: community sources ship a *declarative*
  presenter spec (safe to interpret — no untrusted code execution); complex/trusted
  ("hero") sources may ship a code presenter. v1 ships code presenters (default + bilibili)
  and leaves the declarative DSL as the next step.
- **Input strategy per source** (cost/risk ROI, not blanket):
  - long tail → ride RSSHub html + declarative presenter (cheap; fine for flat content)
  - hero source w/ cheap stable API → own fetch adapter → structured JSON → clean presenter
    (RSSHub flattens retweets/pics into html lossily; structured input avoids un-parsing soup)

### Where it runs

Backend, at persist time: the scheduler computes `content = present(raw, manifest)` for each
new item and stores it on the `StreamItem`. `/api/items` returns `content`; the frontend
renders it. Normalize once; all consumers (UI + MCP/agents) get clean structured content.

## bilibili presenter (first concrete one)

Classify from the raw RSSHub item (validated against real data):
```
attachments has player           → video    {media:[video], text=desc − cover<img> − 视频地址行, title}
title/desc matches 转发/转发自     → forward  {text=own comment, quoted:{author,text,media:images}}
desc has /opus/ link             → article  {title, text=html, media:[link]}
desc has ≥1 <img> (no video)     → gallery  {text, media:images}
else                             → text     {text}
```
```
