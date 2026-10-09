# PACKAGE.md — Stream packages: which slots they can fill and the contract of each slot

**There is exactly one unit for extending Stream: the Stream package.** Built-in packages live in the repo under `packages/<id>/` (49 of them); third-party packages the user installs from npm live under `<dataDir>/recipes/<@scope__name>/` (the directory name is a historical layout; the loader treats both locations identically). Same `package.json#stream` descriptor, same scanner, same loading path.

**Built-in package = factory snapshot; npm = update channel.** Every built-in recipe package is also an npm package (the `name` in `packages/<id>/package.json`, `@streamapp/<id>`). The workflow for changing a recipe: change it → bump that package's `version` → merge to `main`; CI (`release-recipes.yml`) publishes the versions npm does not have yet; no bump, no publish. **Precondition: CI tracks versions only for packages that are already on npm** — the first release of a package is a manual `npm publish` by a human (which packages are public is a business decision; CI does not infer "should publish" from "not found on npm"). The user's `stream update` installs the new version into `<dataDir>/recipes/`, and a package of the same name replaces the built-in copy as a whole (`mountRecipePackages`); the main CLI package does not need to be re-released. Packages in the `@streamapp/` scope are trusted at the same level as the built-in layer (credential injection works as usual, `OFFICIAL_SCOPE`); the same name under any other scope still gets no credentials. **When `STREAM_NPM_REGISTRY` points at a mirror, `@streamapp/` packages are additionally checked against the official registry's checksum** (`officialRegistryIfMirror` → `mirrorVerdict`): only a match counts as official; a mismatch / a version the official registry does not have / an unreachable official registry → the package is installed anyway, but a `.stream-trust.json` (`TRUST_SIDECAR`) is written into the package directory, gate 3 treats it as third-party, and `stream update` does not auto-install it. Without this check, the mirror would become the root of trust for "who gets credentials", and the root of trust can only be npm's official scope ownership. The backend checks for updates once a day (the `recipe-update-check` task in the scheduling center, which can also be run immediately by hand) and only prints a hint in the log (`STREAM_RECIPE_UPDATE_CHECK=0` turns it off).

A package declares which **capability slots** it fills:

| Slot | Declared in | What it lets the host do for the package | Contract in |
|---|---|---|---|
| Source manifests | `manifests.yaml` or `stream.sources` | Register these Sources into the registry | §1 |
| recipe data | `*.recipe.json` + `stream.facility` | Hand them to the replay runtime; the manifest is derived from the recipe's `meta` | §2 |
| code | `activate.ts` + `stream.code` | Call `activate(ctx)` at startup and accept the adapters / normalizers / actions it hands over | §3 |
| capability | `stream.capability` | `mount(ctx, config)` it inside the backend process and wire the tools it registers to `/api/mcp` | §5.9 |
| docker container | `stream.backend` | Create the container, attach it to the `stream` network, health-check it, standby reclaim, the `/_p/<id>` gateway | §4 |
| credential domains | `stream.credentials` | Mint a broker token; the container uses it to fetch cookies | §5 |

A "plugin" = a package that fills the plugin-class slots. Its directory looks like this:

```text
packages/<id>/
  package.json      # descriptor: the npm shell (name/version) + the `stream` field carrying domain fields
                    #   (id, catalog display fields, backend container declaration, credentials, normalizer key)
  manifests.yaml    # Source manifests contributed by this package (top-level YAML list)
  adapter.ts        # adapter code owned exclusively by this package (optionally absorbed; core/shared adapters stay in src/, see the §10 table)
  activate.ts       # entry point of the code slot: exports activate(ctx), hands over the adapters / normalizers / actions this package contributes (see §3)
```

A pure recipe package fills none of the plugin slots; its directory contains only `package.json` + some `*.recipe.json` (example: `packages/bt0/`).
A recipe package can also fill the code slot — `packages/xhs/` is four recipes + `activate.ts` (the normalizer / enricher / adapter all
run the package's own recipes through `ctx.readSource`, see §3.2); once it fills the code slot it appears in `/api/plugins`.

> The scanner (`scanPackages` in `src/packages/scan.ts`; `src/plugins/loader.ts` is a thin shell around it) loads by folder: the `stream` field of `package.json` is the descriptor (parsed by `parseStreamDescriptor` in `src/packages/descriptor.ts`), and the top-level list of `manifests.yaml` is merged into `sources` (declaring both at once is a hard error). A loose `*.yaml` at the top level of `packages/` is not a package and is rejected loudly. The built-in package directory is set by the config field **`packages_dir`** (default `./packages`). The authoritative design of the package shape is in `internal design record`; the publish/install flow is in `.claude/skills/share-recipes/SKILL.md`. The Sources of a recipe package are **self-describing**: a `SourceManifest` is derived from the recipe's `meta` block via `recipeToManifest` (`src/replay/recipe-manifest.ts`) — recipes generated by an agent/user need no hand-written `manifests.yaml` (when present it is an optional full-override escape hatch and still goes through the same `manifestSchema`).

### "Is it a plugin" is decided by slot, not by directory

The check is a named function: **`fillsPluginSlot`** (`src/plugins/loader.ts`) — if a package fills any one of `backend` / `code` / `capability` / `normalizer` / `sources` / `sourceGrouping` / `credentials`, it has something to project through the plugin path.

- **`/api/plugins` lists only packages that fill plugin-class slots** (today **22**, a subset of the 49 packages in the repo). Pure recipe packages are not listed there. This is the **product scope**, not an omission — `/api/plugins` answers "for whom does the host do work". The "what have I installed" view the user sees is a third read model, `GET /api/packages` (all packages from both layers, see §8).
- **Filling both kinds of slot is legal** (a recipe package that carries a container); it then appears in both projections — which is exactly why the decision is by slot and not by directory.
- **Keep the check generous**: missing a package = its container is not taken over, `/_p/<id>` is always 404, the credential token is not minted, and **nothing in any log mentions this kind of gap**. When adding a new slot to `StreamDescriptor` that means "the host should do something for the package", `fillsPluginSlot` needs a new line too; the number is pinned by `src/plugins/loader.real.test.ts`, which goes red on the spot if the check is loosened.
- **The two projections must not consume the same manifest twice**: the `manifests.yaml` of a plugin package is already registered into the registry through the plugin path, so the recipe projection must not consume it again — the same manifest in two registry groups makes `Registry.swapGroup` throw `Duplicate manifest id`, and the backend does not start.
- **To list more packages in the UI, change the projection, not `fillsPluginSlot`.** This check governs three things at once — whether the container is taken over, whether `/_p/<id>` is reachable, whether the credential token is minted. Loosening it just to make a package show up in the UI would incidentally make the host take over a container it should not touch. "Who is listed in the UI" and "for whom the host does work" are two different questions; do not use one switch for both.

### The two UI entry points: "Sources" and "Components"

Split by what the user is doing, not by code layering:

| Entry | Question it answers | Frequency | Endpoints it consumes |
|---|---|---|---|
| **Sources** (`/sources`) — UI label 「源」 | Find a Source and configure it into my Stream | Every day | `/api/plugins` + `/api/plugins/:id/sources` |
| **Components** (`/packages`) — UI label 「组件」 | What is installed / is it still alive / how do I configure it / install another one | Only when something breaks or when extending capabilities | `/api/packages` + `/api/providers` (install/uninstall go through `/api/recipes/packages/*`) |

The seam sits between **using and owning**. So the enable switch, container status, and install/uninstall/upgrade
**have exactly one implementation, on the Components page** —
the Sources page only has a read-only "disabled" marker (「已停用」) and a button that jumps over. If the same switch were written twice,
the two copies would sooner or later disagree, and the symptom of disagreement is "this page says it is on, that page says it is off", with each page looking fine on its own.

The Components page lists two kinds of component side by side: **packages** (three bands, see below) and **Provider rows** (the capability-row band: category / member count / parked;
clicking a row enters the Provider workbench — the whole custom editing surface for members / routes / test-and-configure lives in the workbench; the `/providers` route is kept
but is **not a first-level entry**; spec `2026-08-17-component-page-design.md`).

The package part is split into three bands by **"what happens when it breaks"** (named criterion `bandOf`, `app/src/components/packages/PackagesPage.tsx`):
containers (`hosted`) / built-in capabilities (provide Source manifests or code) / harvest recipes (recipe data only).
The container band **takes up space only when something goes wrong**: erroring ones are pinned open, the rest are folded away. The design is in
`internal design record`.

### Where the things the host does for a package live

The Stream process (`src/`) is the host/orchestrator. It is responsible for:

- Loading **source manifests** (`packages/<id>/manifests.yaml`) — the declarative contract of each data source (`src/manifest/types.ts`).
- Loading **plugin descriptors** (the `stream` field of `packages/<id>/package.json`) — the standard that turns a facility into a Stream-hosted plugin (`src/plugins/types.ts`).
- Registering **adapters** — facility API → Stream item, routed by `manifest.adapter`. A facility's adapter is handed over by the **package itself** in `activate(ctx)` (`packages/<id>/adapter.ts` + `activate.ts`, see §3); what `src/bootstrap.ts` still wires by hand is only the four host ones (builtin / rsshub / replay / browser).
- Registering **normalizers** (`registerNormalizer` in `src/content/normalize.ts`) — normalize a raw item into the display model, routed by `manifest.normalizer` (the `presenter` field is still accepted as a backward-compatible alias). A package's normalizer is handed over by the package in `activate`; a name collision is always a hard rejection, never an override.
- Resolving **credentials** (`src/credentials/*`) — login-state cookies are credential provider #1 (see §5).
- Exposing the **enricher** a package hands over on two surfaces (`GET /api/enrich` in `src/http/app.ts` and the WS command `enrich.open` in `src/http/enrich-ws.ts`) — "where to fetch on demand when this item is opened" is written by the package's normalizer into `Content.enrich`, the frontend calls accordingly, and the host knows no site (contract in §3.2, protocol in "Handlers a package hands over" of `docs/API.md`).
- Reading **facility-level declarations** (`rateLimit` / `cookieDomain` / `serving` / `retires` / `providers` / `links` / `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` / `item` of `package.json#stream`) — they are **facts about this site**, and the host merely reads the table: rate limiting, pulling login state, routing media direct links through the proxy, keeping RSSHub routes that have been superseded out of the catalog, building the Provider rows this package contributes, recognizing "who owns this link and what is it", stamping a normalizer onto the RSSHub namespaces it has claimed, not dropping routes that run fine over plain HTTP because of an upstream falsely marked `requirePuppeteer`, and handing login state over under the environment-variable name RSSHub expects. **Declaration ≠ slot**: a package that fills them is still a pure recipe package and does not enter `/api/plugins` (`fillsPluginSlot` does not recognize them). See the next section.

### The host/package boundary: what counts as "the host knows a site"

**In one sentence: the host holds only mechanisms and interfaces; "what a site looks like and how to call it" lives in that site's package.** "Host" = backend `src/`,
`shared/`, frontend `app/src/`, extension `extension/src/`, the DSH artifact `hosts/dsh/src/`, and capability packages `capabilities/*/src/`
— the guard `src/no-facility-names.guard.test.ts` scans these six roots (`.ts` / `.tsx`) against one and the same list.

Whether "the host knows a site" is decided by code only, not by prose:

| Counts as "knows" (must not appear in the host) | Does not count (allowed) |
|---|---|
| A site domain appearing in **code** (strings, regexes, URL concatenation) | A comment citing a site as **live evidence** (which day, which item, how many seconds, which CDN rejected) |
| Literals of Source ids / package names / platform keys (`'<site>-detail'`, `@streamapp/<site>`) | The auto-generated whole-network catalog (`app/src/lib/source-domains.ts`, the full RSSHub site table, exempted by its full path) |
| Identifiers that exist for one site only (`<site>Comment`, `<site>NoteId`, `fetch<site>`) | Golden corpora (`golden-*.ts`, `gold.ts`) and test fixtures (`__fixtures__/`, `*.test.*`) |
| Reading the field names of a site's upstream response | **The host's domain model**: the TMDb id as the primary key of film/TV identity; the netdisk share-link grammar (`shared/netdisk/share-link.ts`, which also covers netdisks that have no package) |
| | **Netdisk domain implementation**: `shared/netdisk/<disk>/` (the Quark / Baidu clients for verifying shares, saving, playback, redirects) and the host-side netdisk driver mapping (the mount path / driver name → netdisk key in `src/netdisk/backend.ts` and `src/netdisk/sync.ts`). The netdisk is a first-class domain of the host (matching, archiving and the follow loop are all built on it), and the logic exists once, shared by the host and the `capabilities/netdisk` capability package — the same nature as the share-link grammar |
| | **AList / OpenList is the host's netdisk base**: `src/netdisk/alist-client.ts`, the takeover sequence, `settings.rows('alist')`, and the offline member `{plugin:'alist', source:'alist-audio'}` belong to the domain model. "Which package is the base" is answered in exactly one place in the whole repo, `NETDISK_BASE_PACKAGE_ID` in `src/netdisk/base-package.ts`; **the frontend still does not branch on package id** — the backend puts `role: 'netdisk-base'` on the wire in `/api/packages`, and the frontend looks only at `role` |
| Branching on site name (`stream_id.includes('<site>')`, `source === '<site>-detail'`) | **The host's product defaults**: the order of the default members of a ladder, the seed Sources of the default Channels — must be written with the **full package name** (`@streamapp/<package>/<source>`), with a comment next to it saying "why this is the host's call" |

**The frontend follows the same rule, plus one more: the frontend does not branch on site.** The frontend only renders what the item / content / Source catalog **declares**:
where to fetch the author avatar (`item.author_enrich`), whether there is a like button (`item.actions`), what the Source is called (`item.source_label`),
which domain the icon uses (`item.source_site` / the `site` of the Source catalog) are all declared by the package and projected to the frontend by the backend (the wire format is in `docs/API.md`,
"Projection cells in the Items wire shape").

**Which declaration slot the knowledge belongs in** (all keys of `package.json#stream` are as defined by `STREAM_DECLARATION_KEYS`, and the sub-cells of `code` as defined by
`codeSchema`, both in `src/packages/descriptor.ts`):

| What I want to tell the host… | Declaration slot | Contract |
|---|---|---|
| Who this package is, what it is called, where its website is (website host = the `site` of the Source catalog and of items) | `id` / `name` / `tagline` / `description` / `homepage` / `repository` / `docsUrl` / `author` / `facility` | §0 |
| Which host version is required | `hostVersion` | §6.3 |
| Which Sources I provide | `sources` / `manifests.yaml`; derived from the recipe's `meta` | §1, §2 |
| How these Sources are grouped on the selection surface | `sourceGrouping` | §8 |
| How my raw items become Content | `normalizer` (old alias `presenter`) + `code.normalizers` | §3 |
| Which code executes my Source | `code.entry` + `code.adapters` | §3.1 |
| Where to fetch the rest on demand when an item is opened | `code.enrichers` + the `Content.enrich` written by the normalizer | §3.2 |
| How to log in again when the login state is lost | `code.connect` (the domain must be in `credentials`) | §3.2, §3.4.6 |
| Which domains' login state I need | `credentials` / `cookieDomain` | §5 |
| I want a container | `backend` | §4 |
| I carry a capability (MCP tools) | `capability` | §5.9 |
| How fast this site will ban me | `rateLimit` | §0.5 |
| This site's media direct links are not reachable by the browser | `serving` | §0.5 |
| Which RSSHub catalog routes I supersede | `retires` | §0.5 |
| I provide Provider rows, and for which callsites I am the default member | `providers` (`callsites`) | §0.5 |
| Which links belong to me (hosts, short links) and what they are (track / download relay page) | `links` (`hosts` / `shortHosts` / `patterns`; old aliases `trackUrl` / `downloadPages`) | §0.5 "`links`" |
| In the RSSHub catalog, which namespaces I render / which in fact need no browser / under which environment-variable name the cookie is handed over | `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` | §0.5 |
| How my Source is recognized in resource search | `searchSources` | §0.5 |
| My items need an author avatar / clickable actions drawn | `item` (`authorEnrich` / `actions`) | §0.5 |
| Which kind of aggregation may automatically take this recipe in / which category's product library it is | the recipe's `meta.provides` / `meta.catalog` | end of §0.5 |
| The discriminator fields of an old-form recipe package | `type` / `schemaVersion` | §2.7.1 |
| The user may not turn this package off | `required` | §8 |

**Rules for adding a declaration slot**: first check whether the table above can already express it; add one only if not. When adding, give four things together: the schema (`descriptor.ts`),
load-time validation (a bad declaration makes the whole package refuse to install, and the error message points at the field path), a drift guard (the
`src/replay/recipe-package.declares-knowledge.test.ts`, driven by `STREAM_DECLARATION_KEYS`, forces you to answer "does it count as facility knowledge"), and a row in the table above.

> This document covers only the **Plugin layer** of the architecture (ownership and execution boundary of a Source). The authoritative definitions, invariants and data flow of the five concepts
> (Channel / Stream / Provider / Source / Plugin) are in
> **[docs/ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 0. End state: the component model (target state, landing in slices)

> This section describes the **target state**, not the current state. The current state (how each slot is declared and loaded) starts at §1; this section defines
> what it all eventually converges to, and each time a migration slice's spec lands, that slice is rewritten from "target state" into body text.

**Component = a management unit that can be installed, configured, stopped, and referenced.** Only two kinds of thing in Stream qualify as components:
**packages** (built-in / installed from npm) and **Provider rows** (system-provided / user-created). **A Source is not a component** —
it is an expansion item declared by a package, folded under its owning package in the management surface; **a Channel is not a component** — it is user data
(subscriptions and views), managed by the Channels page.

Three convergences, aligned with the component shape of the DSH/cordis family:

1. **Everything configurable = a row with a schema.** The schema is declared with
   [schemastery](https://github.com/shigma/schemastery) (the schema library of the cordis family; the kernel is already
   cordis, and DSH uses the same one) for fields, types and defaults. One declaration benefits three places: write-time validation, default-value semantics in layered
   merging, and **automatic form generation**. The four hand-rolled mechanisms of today each go to their place: the hand-written GET/PUT + hand-drawn forms of the 6 `/api/settings/*`
   endpoint families, the two-layer merge of `withRuntimeDefaults` for a Source's `runtime_config`, the Provider row's own editing surface, the partial overrides of Channel slots — all replaced by the same row model. Hand-written forms remain only for what
   genuinely needs custom interaction (such as the netdisk directory picker).
2. **One layered table for storage**: `layer + rowId + value`, with a fixed merge order of **built-in default → user global → local**
   (the Channel slot `options.slots` is one instance of the local layer; the semantics are unchanged, only the storage changes). The existing criterion is preserved:
   an empty string = the user deliberately cleared it, and does not fall back to the default.
3. **One management surface over one component table** — the "Components" page: the three package bands + the Provider capability-row band listed side by side, the Provider
   workbench is the detail surface entered by clicking a row, and there are 3 management entry points in total (see "The two UI entry points" above). Still owed: the package row's
   "referenced by whom" (reverse lookup of Stream members / bindings).

**Boundary that does not move**: the invariant "Stream package ≠ Cordis plugin" holds (see the kernel section of ARCHITECTURE) —
what converges is the **configuration and management model**, not the loading mechanism; a package remains a cross-process trust boundary, and the six-slot contract (§1–§5)
stays in force as is. Whether the loading layer is also handed to the cordis Loader is a separate later decision, not committed to in this section.

---

## 0.5 Facility-level declarations: `rateLimit` / `cookieDomain` / `serving` / `retires` / `providers` / `links` / `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` / `searchSources` / `item`

**Package = the complete knowledge unit of one facility.** The facts of a site are declared once on its package, and every recipe that belongs to it inherits them automatically;
the source code holds only generic mechanisms. The check: "is this piece of knowledge about the **site** (the CDN's temperament, rate limits, login domains, which upstream routes it supersedes),
or about **one particular endpoint** (field paths)?" The former goes into `package.json#stream`, the latter into the recipe.

| Field | Meaning | Consumer | When it takes effect |
|---|---|---|---|
| `rateLimit` | Rate gate (when several packages share one facility, the strictest wins) | Harvest `FacilityRateLimiter` | Takes effect on hot reload |
| `cookieDomain` | Which domain to pull the login state from | Credential injection | Takes effect on hot reload |
| `serving[]` | `{ match, hosts?, referer?, reason }`: media direct links that hit `match` are proxied by the backend instead, and may be switched to the alternative hosts in `hosts`; `referer` = the Referer that must accompany a fetch of this host's bytes (an image host with reverse hotlink protection, example: the Douban image host in `packages/rsshub`), and every place where the host fetches bytes on its behalf (image proxy / poster comparison / this table's proxy passthrough) sends it | `servingPolicyFor` in `src/media/serving.ts` (playback + fetching bytes for transcription), `refererForUrl` (`src/http/image-fetch.ts` / `src/video/poster-similarity.ts`) | Takes effect on hot reload (thunk, fetched on demand) |
| `retires` | `{ 'rsshub:<ns>/<path>': reason }`: which RSSHub catalog routes this package supersedes — upstream has already made them dead, **or one Source of this package takes over the same route** | Blocked by `src/rsshub-catalog.ts` when it resolves the catalog; `pruneDeadMembers` in `src/providers/seed.ts` clears the system-row members that point at it | **Next catalog refresh / restart** (the catalog is resolved only then) |
| `providers[]` | The Provider rows this package contributes (`{id, category, serveKeys, strategy, label, description, members, callsites?, fallback?, contract?, expand?, provides?}`, shape in `ProviderDeclaration` in `src/packages/descriptor.ts`). The host merges them into the identity table, and `ensureSystemRows` builds the rows and marks them `system:true`. `strategy:'expand'` must carry `expand` (A→B composite-unit config, entering and leaving together); `provides:[tag]` lets this row be taken in **as a composite member** by any `{mode:'auto', provides:tag}` segment (the same tag table as a source manifest's `provides`, receiving the raw input; this row and its ancestor rows are skipped automatically) — a composite row contributed by a package enters the host's aggregate row through it, without being named | `src/providers/identities.ts` → `src/providers/seed.ts`; the auto segment is in `src/providers/executor.ts` | **Next startup** (the identity table is a snapshot, rationale in the header comment of identities.ts) |
| `links` | "Which links are mine and what are they": `{ hosts, shortHosts?, patterns? }` — claimed hosts (with / without platform), short-link hosts, path-level types (`track` carries the named group `id`; `download-page` carries `yields` and doubles as the SSRF allowlist). See "`links`" at the end of this section | The recognition function `src/links/recognize.ts` (the `content.enrich` dispatch key, track recognition, download relay pages, `GET /api/links/recognize`); validation in `src/packages/links.ts` | Takes effect on hot reload (thunk, fetched on demand) |
| `trackUrl[]` / `downloadPages[]` | Migration-period aliases, translated into `links.patterns` at load time, see "`links`" at the end of this section. Built-in packages must not write them anymore | — | — |
| `searchSources[]` | "How my Source is recognized in resource search": `{ source \| provider, key, label, param, kind: 'digest'\|'flat', nsfw?, searchUrl? }`. Exactly one of `source` (this package's local name, completed to the full name at load time; an RSSHub catalog route id containing `:`, `rsshub:<ns>/<path>`, is kept as is — catalog routes belong to no package namespace, example `packages/rsshub`) and `provider` (the id of a row this package contributes; a composite appears under the row's identity) is given; `key` is stamped on `Release.source` so the frontend can attach a badge; `param` is the name of the main query parameter; `kind` is the item shape (`digest` = one entry is a collection of "title + a string of netdisk links", `flat` = one torrent per row); `searchUrl` is the in-site search page template, with `{q}` replaced by the encoded query | `searchMetaBySourceId` in `src/search/seeds.ts` (the whole table comes from package declarations, the host keeps not a single line) | Takes effect on hot reload (thunk, fetched on demand, same as `links`) |
| `rsshubNamespaces[]` | "Routes in these namespaces of the RSSHub catalog use my normalizer"; normalizer key = the package's facility | `src/rsshub-catalog.ts` stamps `normalizer` on them when resolving the catalog and also replaces the route's `facility.label` with the package name (`facility.key` unchanged) | **Next catalog refresh / restart** |
| `rsshubNoBrowserNamespaces[]` | "Routes in these namespaces of the catalog are tagged `requirePuppeteer`, but run fine over plain HTTP with a cookie" — the package's one-line rebuttal of the upstream tag. In namespaces that are not declared, routes tagged puppeteer never enter the catalog (the host has no browser, and does not name any site) | `src/rsshub-catalog.ts` does not drop them for `requirePuppeteer` when resolving the catalog (declarations of all packages are unioned; two packages naming the same namespace is not a conflict) | **Next catalog refresh / restart** |
| `item` | "What extra the items produced by this package's Sources carry": `{ authorEnrich?: { enricher, params }, actions?: [{ id, icon, label, recipe, params, toggle: [value sent when not pressed, value sent when pressed] }] }`. Only `{dotted-path}` placeholders are recognized in the values of `params` (taken from the item: `author`, `content.enrich.params.<k>`, `content.meta.<k>`…), and **if any one cannot be resolved, the whole thing is omitted for that item**; no expressions, no conditions. `authorEnrich` is emitted only when the item has no `author_avatar` and has an `author`; the enricher returns `{ name?, face?, url? }` (`url` is the author's homepage; site addresses live only in the package). Clicking an action goes through `POST /api/recipes/action`, with parameters = `params` + `action: toggle[…]`. Load-time validation (failing any one makes the whole package refuse to install): `recipe` must be **this package's full name** (a package without an npm name may not declare actions), `icon` must be in the host vocabulary (`ITEM_ACTION_ICONS` in `shared/item/actions.ts`, today `heart` / `bookmark`), `toggle` must be exactly two non-empty values, action ids must not repeat, and `authorEnrich.enricher` must be in this package's `code.enrichers`. **Applies only to this package's Sources**: `rsshub:<ns>/…` is claimed by `rsshubNamespaces`, the rest by the `facility.key` of the Source catalog entry | `src/packages/item-projection.ts`, **computed at projection time** through the wire exit `toClientItem` (all four item read paths go through it) — nothing is written into the stored content, so existing items take effect immediately and so does a package upgrade | Takes effect on hot reload (thunk, fetched on demand) |
| `rsshubCookieEnv` | `NAME_{CookieName}`: write that domain's cookie string into this environment variable handed to RSSHub, with `{CookieName}` replaced by the value of the cookie of that name. Grammar `/^[A-Z][A-Z0-9_]*(\{[A-Za-z0-9_]+\}[A-Z0-9_]*)*$/`; a non-match makes the whole package refuse to install. The template table is registered once for the **package facility and once for each namespace in `rsshubNamespaces`** (the `inject.ref` of an RSSHub route is a namespace); when two packages give different templates for the same key, the later one is ignored and one log line is written | `src/credentials/cookie-provider.ts` (consulted first, then the host `transformRegistry`) | Takes effect on hot reload (thunk, fetched on demand) |

**The recipe level also has two cells of site knowledge**, written in the `meta` of `*.recipe.json` (the manifest projection strips unknown keys, and consumers read the
original recipe): `meta.provides: [tag]` lets this recipe be automatically taken in as an aggregate member by `{mode:'auto', provides}` segments with the same tag
(`search-download` / `resolve-download` / `search-price` / `search-resale` / `search-content`…; installing it brings it in, turning it off takes it out,
and the host rows name no site; manifest Sources declare it with `provides` too, such as `magnet-btbtla` in the BT Movies (BT影视) package);
`meta.catalog: { category, param?, bands?, exhaustive? }` is the declaration of a product library — "when a purchase decision enumerates the full set, this category comes to ask me, in these bands"
(the host's `src/agent/purchase/universe-catalog.ts` is a read-only table; if `exhaustive` is omitted, the result is treated as a sample and marked `truncated`;
example `packages/zol/zol-phones.recipe.json`).

**When a package with the same npm name exists in both layers** (built-in `packages/<id>` + a newer same-name version installed by the user via `stream add`), **everything of only the higher-version
layer is loaded** — code, `manifests.yaml`, recipes, the declarations in the table above, and `states.json` — and the other layer is skipped as a whole with one log line
(`[stream] package <npm name>: user layer <v> supersedes builtin <v>` / `builtin <v> kept, user layer <v> skipped`).
The yardstick = `shared/package-sdk/semver.ts`: user layer strictly higher → user layer; equal, lower, or either layer lacking a valid `x.y.z` → built-in (version strings that cannot be parsed —
`v1.0.0`, `1.2`, missing — are read as "not higher than the built-in"). Why both directions are needed: a built-in package ships with the same version as the host, so its declarations
match the host mechanisms, whereas the user-layer copy may be any old version, and an old version missing one declaration cell silently loses a capability (playback turns into 502, catalog routes vanish, Provider rows cannot be built),
and nothing anywhere complains — so an old version must not win; yet built-in packages are also published to npm, and the new version `stream update` fetches exists so that the user can get the
new declarations without upgrading the host — so a new version must win, and what wins is the **whole package** (a new version missing a declaration cell = the author deleted it, and the old version's is not layered in). The decision lives in exactly one place:
`pickLayers` (`src/packages/pick-layer.ts`), and four consumers take the same conclusion — code activation (`src/kernel/plugins/packages.ts`),
recipe / manifests loading and declaration merging (`mountRecipePackages` /
`mergeRecipePackagesByFacility` in `src/replay/recipe-package.ts`), and the curated projection (`src/kernel/plugins/sources.ts`: the `manifests.yaml` of a superseded built-in package
no longer enters the registry through the plugin-descriptor path — otherwise it collides with the user-layer copy as `Duplicate manifest id`, and the package the user installed is skipped as a whole). Picking per layer as a whole is required:
letting each path do its own per-id "same id overrides" is not enough: the `manifests.yaml` of a built-in package has the curated path as a second route, which per-item overriding cannot reach.
What is compared is the npm name, not `stream.id`: the id is written by the package itself, while uniqueness of npm names is guaranteed by the registry; local packages placed by hand without an npm name do not take part in
the comparison (with the same full name the user layer covers builtin, and on a collision with curated, the per-package retry at startup removes it). A superseded built-in package stays in the `/api/plugins`
catalog (that is a snapshot of descriptors at startup, marking only the metadata of the built-in copy), while the catalog of `/api/packages` and `stream list` are the source of truth for "what is installed".
**A disabled built-in package still takes part by version** (the whole-package rule does not look at the switch); if the user layer wins while the built-in plugin is disabled → the user-layer copy
is not installed either (the switch works by "a disabled plugin does not emit curated", the superseded built-in emits nothing anyway, so the user layer must be blocked together with it, otherwise the switch is a dead letter),
and it is installed back on the next hot reload after the switch is turned on. When a same-name new version is installed **while running**: the choice stays frozen at what was decided at startup (curated is not hot-swapped; computing it live would make every later round
of hot reload collide on `Duplicate`), so this round does not install it yet, and the log says `user layer installed, takes over on restart` (only when the superseded built-in
really has a curated list; if the superseded one is a pure recipe package it takes effect directly) — the switch happens after a restart.

**When both layers have a package of the same facility but with different npm names** (an add-on package from a third party for this facility): the recipes of both layers are mounted (the merge key is the
full name `<npm package name>/<local name>`, so different package names coexist); descriptors are merged by facility, and version numbers of different packages are not comparable, so **declarations in the table above other than `rateLimit`,
and `states.json`, are always taken from the built-in** (the list = `DECLARATION_FIELDS` in `src/replay/recipe-package.ts`),
the user layer only layers on cells the built-in did not declare, plus recipes and display fields (`stream.name` / npm name / version come from the user layer); `rateLimit` takes the strictest.

`match` must have at least two label segments (`.fm` is rejected, `.lizhi.fm` accepted): once `hosts` is attached, this policy **replaces the host**,
and a single label segment would amount to deciding, for every facility under that whole suffix, where the bytes come from.

`serving.hosts` are addresses the **backend** connects to — a third-party package could use them to make the backend hit the intranet. At load time this list of hosts is normalized to the form
the URL layer would actually connect to (`0177.0.0.1`, `[::ffff:127.0.0.1]`, `localhost.` are all restored first) and then judged: private network /
loopback / link-local IPs, single-label names, and strings that cannot be parsed — hitting any one makes the whole package refuse to install. **A public hostname that resolves to a private IP
cannot be detected** (loading does no DNS), so the install confirmation page must display `proxies` (a preview field), letting the user see whom it will connect to.
`retires` holds only two kinds: those "upstream has already made dead", and those "one Source of this package takes over the same route" (keeping the old route in the same catalog
would make content search return two copies); "we prefer our own copy, but the two routes differ" belongs to `priority`.

**Name-collision rules for `providers` (hard rejection, no override)**: if `id` collides with any existing row, or any key in `serveKeys` is already served by a row of the **same category**
→ that one declaration is rejected and one log line is written, the rest go in as usual; a second `fallback` in the same category is rejected likewise. When two packages declare the same
key, first come first served. Rows the user **built** (`system: 0`) do not take part in this check — that is the user's own data. On the next startup after a package is uninstalled,
the existing clean-up path in `ensureSystemRows` ("`system=1` and the id is not in the identity table → clear the slot + delete the row") collects it naturally, and no migration is needed.
In the same startup, named members on system rows that point at something "a loaded package no longer provides" are cleared by `pruneDeadMembers`, and members of system rows that point at a catalog route
declared in `retires` are cleared the same way (exact rules in the header comment of `src/providers/seed.ts`). The install confirmation page shows these rows from the preview's `providers` field and states that they **appear only after the backend
is restarted**.

Semantics of `callsites`: this row is the **default member** of those callsites. The default row list of a callsite = the host's own defaults ∪ all
package rows that declared the callsite (`ensureDefaults` skips callsites whose default is empty); the "call location"
note of this row on `/api/providers` is also generated by reverse lookup from the callsite's `label` (`callSitesOf` in `src/providers/seed.ts`) — the host's own rows are still a hand-written
table, and package rows need not enter that table. **All dispatch callsites read the package rows' `callsites`** (the ones with
`mode: 'dispatch'` in `src/providers/callsites.ts`, the check is fetched on demand from `src/providers/identities.ts`, no hand-copied list): `music.track.resolve` /
`music.track.download` / `video.resolve` / `content.enrich`, plus the four netdisk ones `netdisk.share.verify` /
`netdisk.share.save` / `netdisk.play` / `netdisk.folder` (this is how the Quark and Baidu package rows get in):

- `video.resolve` dispatches by platform, with the key `<platform>-video`; `GET /api/media/play|dash` and fetching bytes for transcription / frame extraction all go through here.
- `content.enrich` dispatches by `<platform>-link` (the platform comes from the recognition function, see "`links`" at the end of this section; `stream_fetch_url` /
  `GET /api/media/from-url`), and the default members = the host's fallback row `fetch-url` ∪ package rows that declared `callsites: ['content.enrich']`.
  **A transform row whose `serveKeys` is `<platform>-link` is unreachable forever if this cell is not written** — no other callsite will ask for it;
  **the package must also claim those hosts in `links.hosts`**, otherwise the recognition function cannot identify the platform and the key cannot be assembled.

The input these two callsites give to a member is a **plain object** (`{vid, format}` / `{url}`), and the package's Source receives an empty key + the whole object
spread into `params` (`memberCallArgs`, `src/providers/invoke-types.ts`) — so the package's adapter / recipe reads from
`params.vid` and `params.url`, not from positional arguments.

`rsshubNamespaces`: two packages claiming the same namespace → throws at load time (that is two rendering rule sets that cannot see each other contending for the same routes,
and first-come-first-served would drift with disk order). The host's own `NS_NORMALIZER` table is empty today (the mechanism is kept).

The table above lists **descriptor fields**. There is another kind of site knowledge that does not go through the descriptor but through the code slot (§3): the normalizer writes `enrich: { source, params }` on each
`Content`, and the host exposes the enricher a package hands over on both surfaces, `GET /api/enrich` and the WS command
`enrich.open` (for the same source, one request in flight at a time, a new click displaces the old one, and the same params share a ride; protocol in `docs/API.md`) —
"where to fetch the rest on demand when this item is opened" is therefore also stated by the package, and the host contains no per-site detail branch.

Examples: `packages/netease/package.json` (`providers` / `links` (the track pattern) / `rsshubNamespaces` all present),
`packages/btbtla/package.json` (`links`' `download-page`),
`packages/xhs/package.json` (`rsshubNoBrowserNamespaces` / `item.actions`),
`packages/lizhi/package.json` (`serving` / `retires`), `packages/bilibili/package.json`
(`rsshubCookieEnv` / `retires` / `links` (including short links) / two `providers` (one each for `video.resolve` and `content.enrich`) /
`code.enrichers` / `code.connect` / `item.authorEnrich` all present), `packages/Douyin_TikTok_Download_API/package.json` (**one container package serving
two platforms**: four `providers` — per platform one `resolve` (`<platform>-video`) + one `transform` (`<platform>-link`, with `links.hosts` writing the platform explicitly), all members riding
the same adapter that calls the container, with the address fetched on demand through `ctx.backendUrl`; full breakdown in §10.1).

### `links`: "which links are mine and what are they"

When a user pastes a link and says "download its video / play it / read the body", the system first answers **recognition** (which package, which platform, what type, and
what id this link has), then answers **dispatch** (which Provider row to hand it to). Recognition has exactly one table — the `stream.links` of each package; the host has exactly one recognition function,
`recognizeLink(url)` (`src/links/recognize.ts`), and knows no site.

```json
"links": {
  "hosts": ["example.com", "exm.pl", { "host": "other-site.com", "platform": "other" }],
  "shortHosts": ["exm.pl"],
  "patterns": [
    { "kind": "track", "pattern": "^https://music\\.example\\.com/song\\?id=(?<id>\\d+)" },
    { "kind": "download-page", "pattern": "^https://(www\\.)?example\\.com/down/\\d+\\.html$", "yields": "magnet" }
  ]
}
```

- **`hosts`**: these hosts (including subdomains, matched as a suffix on label boundaries — `evil-example.com` does not count as `example.com`) belong to this package. A string or
  `{ host, platform }`.
- **`shortHosts`**: this package's short-link hosts, each of which must be covered by `hosts`. `recognizeLink` sends requests only to them to expand
  (`redirect:'manual'`, at most 3 hops, 5 seconds per hop; if nobody claims the next hop's host it stops and recognizes by the address it stopped at; on expansion failure it recognizes by the original link,
  and the reason goes to the DebugBox `links` channel) — it only hits public hosts a package has declared, so it is not an open proxy.
- **`patterns`**: path-level type claims; `kind` is a closed vocabulary of the host, with two values today:
  - `track`: must have the named group `id`. Track recognition (intent recognition on a pasted URL, music search results) consumes it, and the result is `platform:id`.
  - `download-page`: must end with `$` and carry `yields` (`magnet|ed2k|quark|baidu|aliyun|unknown`). The resolver uses it to mark rows
    `needsResolve`, and download resolution uses it to allow fetching — **it doubles as the SSRF allowlist**, and `magnet` has a generic solution (fetch the page and take the first `magnet:`).
  - Adding a new type = adding a value to the host vocabulary, and the first consumer must land at the same time; no types are reserved that nobody uses.
- Recognition order: `patterns` first (declaration order, first declared wins) give kind / id; if none hits, `hosts` gives only the platform (longest suffix wins).

**Platform ownership**: `platform` defaults to the package's `stream.facility`; when there is no facility, every entry must write it explicitly (`Douyin_TikTok_Download_API`, one package with two platforms,
is written exactly this way). Platform keys accept only `[A-Za-z0-9][A-Za-z0-9_-]*` — it gets spliced into the dispatch key.
**A host and platform belong to only one package**: at load time the tables are merged in declaration order (`linkTableOf` in `src/replay/recipe-package.ts`), and on a collision the **entire** `links` of the later package
is rejected, logged, and emitted on the `recipe-reload` channel (same as a `serveKeys` collision: the later one is rejected). The built-in layer and user layer of the same package leave only one copy
("when the same name exists in both layers, only the higher version is loaded"), which does not count as a collision; nested hosts belonging to two packages (`example.com` / `m.example.com`)
do not count as a collision either, and at recognition time the longest suffix wins.

**Load-time validation** (hitting any one makes the whole package refuse to install; `linkPatternProblem` and `normalizeLinks` in `src/packages/links.ts`):

- The pattern starts with `^https://` or `^https?://`; it compiles and does not match the empty string; the source string is at most 200 characters and contains no nested quantifiers (`(a+)+`);
  it is run twice on pathological strings, and the better run must not exceed 50ms; it must not hit any other party's control URL (such as `https://example.com/`).
- The host segment of the pattern (after the scheme, before the first `/`) must name at least one literal domain (an escaped `\.` + letters), and **each one must fall within this package's
  `hosts`** — a package cannot claim other sites' links through a pattern; the host segment must not contain wildcards that can cross the host boundary (bare `.`, `[^…]`, `\S`).
- `hosts` / `shortHosts`: at least two label segments, not a public suffix, and passing `servingHostProblem` (public hosts only).

**Dispatch-key convention: `<platform>-<noun>`, assembled from the recognition result; no domain-shaped keys are written in any declaration** (built-in packages are guarded by
`src/packages/legacy-link-fields.guard.test.ts`):

| Callsite | Key |
|---|---|
| `content.enrich` (paste a link to grab media) | `<platform>-link` |
| `video.resolve` | `<platform>-video` |
| `music.track.resolve` / `music.track.download` | platform key |
| `netdisk.*` | `<netdisk>-verify` etc. |

**`trackUrl` / `downloadPages` are migration-period aliases**: older versions of packages already published to npm still have them, and at load time they are translated into `links.patterns`
(`trackUrl` gets the prefix `^https?://(?:[a-z0-9-]+\.)*` prepended and its first capture group renamed `(?<id>…)`; the `kind` of `downloadPages` becomes
`yields`; `hosts` is inferred from the literal domains, and `platform` = the package's facility), and after translation they pass the validation above as usual. When `content.enrich`
cannot dispatch on `<platform>-link`, it tries once more with the old host key (full host, apex); a hit is used as is and leaves a trace in the DebugBox `links` channel.
New packages always write `links`.

`GET /api/links/recognize?url=` returns the recognition result (`docs/API.md`). Design and trade-offs are in the spec
`internal design record`.


---

## 1. Slot: Source manifests (`manifests.yaml`)

Each Source a package contributes is one entry in the manifest (a top-level YAML list). One entry = one invocation mode; field semantics are in `src/manifest/types.ts`; examples of how to write them are in §10.

`description` / `topics` / `example_queries` are what `stream_search` matches against — if they are poorly written, the Source cannot be found by search.
In `route`, use `{key}` placeholders, filled from the Stream's `params` (such as `/bilibili/user/dynamic/{uid}`); ad-hoc routes go through the non-discoverable
`rsshub-raw` Source, which takes a literal `route` parameter.

> Key fact: the source manifest's `auth: { type: 'cookie', domain }` **already is** the credential declaration (do not invent `needs_credential` again). The `credentials: [domain, ...]` of the plugin descriptor declares the cookie domains that the plugin's **backend container** needs through the broker (§5).

### 1.1 sourceId: you write the local name, the host synthesizes the full name

The id of a Source is **`<npm package name>/<local name>`**, called the **full name**.

```
@streamapp/xhs/xhs-detail          scoped package, the full name has two "/"
@streamapp/builtin/fetch-url
my-recipes/fetch-url               unscoped package
local/<directory name>/<local name>              a local package placed by hand into <dataDir>/recipes/ (package.json has no name)
```

**What a package author writes is always the local name** — the `id` in `manifests.yaml` and the `sourceId` in the recipe never carry the package's own name.
The prefix is **synthesized by the host at load time** (`src/registry/source-id.ts` + `toPluginDescriptor` /
`loadRecipePackages`), isomorphic to `pluginId`: the derived field is written in stone before entering the Registry, and the read side does zero derivation.
The reason is practical: writing the package name into every recipe file means a rename requires editing them all, and during local development the package name is often not decided yet.

**Global uniqueness is guaranteed by the npm registry**, and the host maintains no name table. Two packages with the same full name ⇒ the same npm name ⇒
they were the same package all along.

The local name has two hard constraints, rejected at load time (`validateRecipe` and `scanPackages` each have one check — the two loading paths
are independent, and pinning only one would let things slip through from the other side):

- **Must not contain `/`**: it is the separator between package name and local name. Allowing it creates a whole family of ambiguity (the local name `a/b` of package `<p>`
  looks exactly like the local name `b` of package `<p>/a`).
- **Must not contain `:`**: `:` is occupied by the plugin prefix of existing stream rows (level 2 below), and allowing it would make the stripping rule misfire on
  a full name.

#### How an id is resolved (the four-level rule of `Registry.get`)

| Level | Rule | Reason for existing |
|---|---|---|
| 1 | Exact hit | The full name, and the `rsshub:…` ids of the RSSHub catalog |
| 2 | Contains `:` → strip the segment before the first `:`, return to level 1 | Stream rows in the database are stored in two columns, `plugin_id` + `source_template_id`, and `canonicalSourceId` joins them back into `xhs:<id>` |
| 3 | Bare name (local name) → resolves if there is a unique hit | Rows in the database, old bundles shared by others, and ids typed by users are all bare names |
| 4 | A bare name hits several → **the built-in layer's one wins** (an ambiguity record is logged to the `recipe-reload` channel); if the built-in layer has ≥2, or all candidates are in the third-party layer → throw `AmbiguousSourceIdError`, with all candidate full names listed in the message | See below |

Levels 3 and 4 act on the string **after** the level-2 stripping, and the order cannot be reversed.

**Bare-name resolution is a permanent capability, not a transition.** It serves user data (rows in the database, old bundles, hand-typed ids),
and such things will always exist. It is also not an "old path", it is a "short name" — isomorphic to the shell looking up an executable by bare name in `PATH`.

**Why the built-in wins on ambiguity**: a stored record that holds a bare name could, at the moment it was written, only have meant the built-in one — the third-party package was
installed later. Letting a latecomer change the meaning of an old record is the most expensive kind of silent distortion on this line. When no winner can be determined, it **throws**
instead of returning `undefined`: "this Source does not exist" and "it exists in two copies" call for entirely different handling (the former is a configuration error, the latter
needs the user to rewrite with the full name), and squashing them into the same `undefined` turns an error that could be explained clearly into one that cannot.

**But the host's own code does not eat bare names.** Named sources in the source code, in the `defaultMembers` of `SYSTEM_IDENTITIES`, and in
`VIDEO_RANKING_STREAMS` (the seed list of default rankings for the film/TV channel) are always written with the full name — a third party installing a same-name package could push the host's own calls into the
ambiguity branch. This is pinned by "every named default member points
at a real source" in `src/providers/system/index.real.test.ts`. RSSHub catalog ids (`rsshub:…`) belong to no package namespace, get no prefix, and do not enter
the index built by local name.

### `uses`: this Source is complete only with other Sources

If a Source's output **depends on another Source**, declare it in `uses` (`uses` in `manifests.yaml`,
`meta.uses` in a recipe). It answers the question the other way around: **when one recipe breaks, who gets dragged down**.

```json
"meta": { "uses": ["xhs-detail"] }
```

**Within the same package write local names, and the host synthesizes full names at load time** (the same rule as `sourceId`, see §1.1). To point at a Source in another package,
write the full name — local names must not contain `/`, so "contains `/` = full name" is an exact check, not a guess.

**The direction is "the user declares".** The shared recipe **does not** register its own users: otherwise every new consumer would require going back to edit it,
and a miss would raise no error and just quietly undercount by one. The declaration is written in the consumer's own file, and adding a consumer touches only that
one file.

**It does not affect scheduling** — the host will not run that Source for you because of a `uses` cell. It is a declaration for diagnostics to read,
consumed by `GET /api/sources/affected?id=…` ([API.md](API.md)) and by the `affectedSources` written into the
repair ledger at the moment drift is recorded (`src/replay/repair-ledger.ts`).

**The live case**: `xhs-home` / `xhs-search` both `uses: ["xhs-detail"]` — the body text, image sets,
and comments needed to open a note are fetched on demand by the shared detail recipe. When detail drifts, these two Sources **keep harvesting successfully, with health status green all the way**,
yet every note cannot be opened; without the declaration, nothing anywhere would count them among the affected Sources.

### Runtime Source Configuration

Use `runtime_config` when a Source requires deployment-private credentials or stable facility
values. Do not put API keys, endpoints, or tokens in `params_schema`, `fixed_params`, Provider
member params, or a plugin container environment. `params_schema` describes one invocation;
`runtime_config` is resolved privately at execution time.

```yaml
runtime_config:
  ref: tmdb                 # shared by every Source using this facility config
  fields:
    apiKey:
      type: secret
      label: TMDb API Key
      required: true
      description: Short note, shown below the field in the Source Config Sheet.
      helpUrl: https://provider.example.com/api-keys
    language: { type: string, label: 语言, default: zh-CN }   # label 语言 = "Language"
```

`secret` values are write-only and their HTTP status exposes only whether they are configured.
`string` values are returned to the Source Config Sheet. A Source may share a `ref` only when its
fields describe exactly the same facility configuration.

**Endpoint exception**: only values that are truly private and do not vary per call go into `runtime_config`. Endpoints that can be self-hosted and have a public default
(which most people need not touch) go through `params_schema` (`baseUrl`, `required: false`, with the description stating the
default), leaving only the secret itself to `runtime_config` — `ocr-vlm` and `article-firecrawl` (living in `packages/firecrawl/`) both have this shape:
`baseUrl` in `params_schema`, `apiKey` in `runtime_config`.

**Optional secret (keyless)**: some facilities provide an anonymous free quota, and `runtime_config.fields.apiKey` may declare
`required: false` to let it go unfilled. But a keyless quota is usually metered by **egress IP** and shared with other callers behind the same egress; when someone else has used it up first, it shows up only as a 429,
which the caller has no way to investigate — `article-firecrawl`
(Firecrawl keyless free tier, 1000 credits/month) is exactly this trap. For a field declared `required: false`,
the `description` must point out this trap and give a way out (register a free account and fill in a key: the quota is the same but is booked to your own account and
predictable).

### 1.2 Key grammar for lyrics Sources

For Sources whose `categories` contain `lyrics`, the `lyrics-search` row fetches them on demand by category (member `{mode:'auto', category:'lyrics'}`), and
the subscription key is poured by `buildParams` into the parameter named by `key_param`. The key is `<platform>:<id>` (a known track reference,
`platform` = the facility of some package) or `<title>::<artist>` (fuzzy).

**On receiving another platform's prefix, return `[]` (decline)** to leave the chance to the next rung of the ladder; do not return `{matched:false}`
— that means "I checked, and there is none", and it would nail another platform's song down as a song that cannot be found. Caching belongs to the caller (`GET /api/resolutions` and the MCP
`resolve` share `src/audio/lyrics-cache.ts`); a Source must not cache on its own. Example `packages/netease/lyrics.ts`.

---

## 2. Slot: recipe data (`*.recipe.json`)

A recipe is Stream's formal name for browser harvest behavior: a versioned data contract that can be
**recorded, validated, replayed, and repaired**. It describes how to use a logged-in browser session to
perform actions, observe the data the page produces, map it to items, and detect login expiry or site
drift.

- For the authoring workflow for writing a recipe from scratch, see `.claude/skills/write-recipe/references/authoring.md`.
- **How the human-like harvest pipeline (the user's own Chrome + a single facility session + intercepted XHR) runs, how to observe it, and how to repair it:
  `.claude/skills/write-recipe/SKILL.md` is the single source of truth.** This section only defines concepts and the contract,
  and does not repeat operating experience; when the two conflict, the skill wins.
- This section holds the authoritative concepts, semantics, and validation terms for Recipe; the code anchor is `src/replay/`.

### 2.1 What a Recipe is not

- A Recipe is **not a Source**. A Source is the entry point a user can understand; a Recipe is the execution contract of that entry point.
- A Recipe is **not a new Workflow business layer**. Action orchestration is internal structure of the Recipe, not a separate top-level concept.
- DOM, XHR, page state, and eval are **not different Sources**. They are the means of reading results during execution.
- A persistent shadow session is **not a Stream**. It is only a browser execution resource reused across Provider calls.
- A Recipe is data, not a container for arbitrary site code. General capabilities go into the schema/runner; site selectors, URL
  patterns, and mappings stay in the recipe.
- A Recipe is **not an independent unit of distribution**. There is only one unit of distribution: the **Stream package**. Recipe data is one
  **slot** of a package (`*.recipe.json` + `stream.facility`), alongside the Source manifest / code / docker container /
  credential domain slots — the same package can fill both the recipe slot and the container slot.

For example, Xiaohongshu keeps these entries by semantics (the table below lists **local names**, i.e. the `sourceId` in the recipe file;
their full names in the registry are `@streamapp/xhs/<local name>`, see §1.1):

| Local name | Role | Data destination |
|---|---|---|
| `xhs-home` | Home recommendation timeline Source (subscribable) | Stored |
| `xhs-search` | Search Source / Provider | Returned transiently, not stored |
| `xhs-detail` | Private detail recipe shared by Home/Search; an internal Source with `discoverable:false`, called by this package's `xhs-detail` enricher through `ctx.readSource` (§3.2) | Transient enrich result, not stored |
| `xhs-like` | Interaction write (like/favorite), on-demand and never scheduled; the frontend triggers it via `POST /api/recipes/action` | Produces no items |

Do not derive further Sources by implementation path, such as `xhs-home-xhr`, `xhs-home-dom`, or `xhs-home-click`.

### 2.2 The orthogonal composition of a Recipe

The target structure of a Browser Recipe consists of five parts:

```ts
interface BrowserRecipe {
  version: number
  kind: 'browser'
  sourceId: string
  session: {
    facility: string
    lifecycle: 'one-shot' | 'persistent'
    visibility: 'unattended' | 'interactive'
  }
  loginCheck: LoginCheck
  steps: RecipeStep[]
  observers: RecipeObserver[]
  output: RecipeOutput
  ledger?: { idField: string }
  policy?: RecipePolicy
  extract?: RecipeExtract
}
```

#### Session

- `one-shot`: one execution obtains a tab and releases it when done; suited to ordinary fetch/browser recipes.
- `persistent`: a facility-scoped session held long-term by the session manager; Search/Detail can reuse it.
- `unattended`: harvest. A background tab; the user need not be present, and it **never grabs the screen**. Every Source uses this tier.
- `interactive`: a flow where the user must act in person (login, QR scan, self-service key creation). It opens visibly in the window the user is currently in, because the user has to click on it.
- **There is no `transport` field to choose**: there is only one browser (the user's own Chrome). Old recipes that write `'ext-cdp'`
  are still accepted but have no effect; writing `'cloak'` is **rejected at load time** with the migration action spelled out (`src/replay/recipe-store.ts`).

The criterion is **who acts**, not who wants to watch. When writing a recipe, ask one question: does this run need the user to reach in? If yes → `interactive`,
if not → `unattended`. Wanting to watch it run during development is **not** a reason to change this field (that is a temporary need of one run, and writing it into a file that
travels with git means having to remember to change it back) — use `RECIPE_PROBE`'s staged ledger and the failure scenes in `data/failures` instead.

**Visible ≠ stealing focus.** The harvest tab is always in the tab bar, and the user can switch to it at any time; `interactive` only decides whether the tab opens in the
foreground or background, and the runner never touches focus at any layer. Bringing the window to the front happens only when the user **explicitly asks** (clicking "Finish
login in the browser" → `RecipeSessionManager.focusFacilityTab`).

Why the background tier can still click: as soon as a lane is built it sends one `Emulation.setFocusEmulationEnabled`, so trusted input to a hidden tab
lands as usual; combined with "mouse events do not wait for Chrome's receipt" (`FIRE_AND_FORGET` in `extension/src/lib/driver.ts`),
one trusted click takes 0.19–0.33s.
So **"needs a trusted click" has never been a reason to need the foreground**. **Commands that need the compositor to actually produce a frame (screenshots / `settle`) do not get this
benefit** — those are governed by the OS layer, namely whether the Chrome window is displayed on screen; see
`references/session-runtime.md` of the `write-recipe` skill.

For the numbers comparing the four tiers, the pathologies, and "what lie it tells the page", see the `visibility` section of `.claude/skills/write-recipe/references/session-runtime.md`
(the source of truth for operating experience is in the skill; this section only defines the conceptual contract).

#### Ledger (the output of this recipe is also an ordered ledger)

`ledger: { idField }` declares "which entries this run laid out on this lane's page, and in what order". It is the **coordinate system** of the downstream
`locate` step: for detail to find the target card on the feed, scroll it into the viewport, and click it with trusted input, it relies on this ledger.
When the caller did not pass `params[orderedParam]`, **at run time it is filled from `FeedLedger` by this recipe's facility**
(`orderedFor` of `SessionRecipeExecutor` → `RecipeRunner`) — "finding a card on the feed" naturally needs the feed's
order, which is the locate step's run-time contract and not any caller's business; if it was passed explicitly (even `[]`), the passed value is used.

- **Whoever is the origin declares.** The engine does not know sourceId and only keeps the books by declaration — "which field is the identity" is site knowledge and belongs to the recipe
  data. `idField` must be the same field as the consumer `locate`'s `identityParam`.
- **Whole replacement, not append.** One run = that tab was replaced with this batch.
- **When the lane closes, the ledger is lost with it.** It describes that tab; once the tab is gone the ledger is waste paper.
- Having no ledger is not a fault: `locate` MISSes immediately, takes `fallbackUrl` for a full-page navigation, and the data still comes out (degraded).

The recipe runner does not create or destroy tabs; it acquires/releases a session handle from the session manager. The extension only
operates on owned tabs that it created and registered itself, and never attaches to or closes a tab the user opened manually.

#### Steps

Steps express user behavior observable on the site, such as navigating, typing, submitting, scrolling, clicking a target card, and going back.
Production replay uses CDP trusted input. Humanization is a pacing/trajectory policy for task actions, not
randomly manufactured clicks unrelated to the user's intent.

`click` means "press this named element" (a different thing from `openItems`, "open the Nth entry of the feed"). It can carry
`position: {x, y}` — a CSS px offset relative to the top-left corner of the element rect, defaulting to the center when omitted; the field name and semantics come from
Playwright's `locator.click({ position })`. It exists because **for some targets the center is simply the wrong point**,
not as a tunable knob.

`setFiles` means "put local files on the browser's machine into the page's `<input type=file>`" (CDP
`DOM.setFileInputFiles`): `{ kind:'setFiles', selector, paths }`, where `paths` is absolute paths joined by newlines,
usually written as `{files}` — the shape after translating a parameter with `format:'path', multiple:true` (WSL paths already translated by the host to
the Windows-side form). **Large files should not go through the control channel**: `evaluate` serializes the whole parameter bag into one evaluation expression,
and encoding a tens-of-MB image as a data URL and stuffing it into params makes a tens-of-MB CDP message that also squeezes into the in-page evaluation 30s budget;
this step lets the **browser process read the disk directly**, and the `File` the page receives is the same as one the user picks in a file dialog. If `paths` is empty
(the parameter is absent), the step is skipped and recorded in the trace; the element being absent / not a file input / CDP refusing all throw. Example:
`packages/photopea/photopea-run.recipe.json` (the input is first built on the host page by an `evaluate` step).

Each step can also carry two gates, which answer **two different questions**:

- **`settle` (before the action) — "can I act now?"** Wait until the region of the target has **finished painting and stopped moving** before executing. The criterion is
  "has changed + has stopped", comparing the picture cropped to that element's rect frame by frame. It exists because for some targets **readiness cannot be observed from the DOM
  at all** (a challenge widget living in a closed shadow root), and **acting too early is harmful, not merely ineffective**.
  Where to capture is given by the DOM's rect: **the DOM says where, the picture says when.**
  **Every kind of step accepts it** (`locate` / `openTarget` / `evaluate` included); if not declared it is a zero-cost no-op.
  `evaluate` does not operate on the page and only calls the site's own JS, so it usually needs no declaration.
- **`expect` (after the action) — "did what I did take effect?"** `{ selector, state: 'present'|'gone',
  timeout, retryEvery }`, with semantics taken from Playwright's `waitFor({ state, timeout })`. If it is not satisfied, it **breaks at this step**:
  the causal chain breaks here, and later steps would only fail with unrelated symptoms. The state is called `present` rather than `visible`,
  because the criterion is whether the element is attached to the DOM, not CSS visibility — the name has to tell the truth.

**Waiting belongs to `expect`, not to the action's own timeout.** What a step waits for is never "how long this click takes",
but "when the thing it triggers happens".

**Where `expect` sits on `locate` / `openTarget`.** These two kinds of step carry a **built-in confirmation** (after opening, check whether the URL carries the
identity; if not, fall back to `fallbackUrl`), which answers "**did it open?**". `expect` is an extra criterion written by the user,
answering "**is what opened the one I want / is the page in place?**" — so it runs **after the built-in confirmation and before the observers read**.
Before the observers is a hard requirement: once an observer reads data off a wrong page, what it gets is real data that merely comes from elsewhere,
which is the hardest kind of error to trace. The path that falls back via `fallback-nav` **goes through this gate as well**: `expect` judges the final state,
not which route got there.

**These two kinds of step do not support `expect.retryEvery`, and loading reports an error** (it is not silently ignored). The semantics of `retryEvery` is "every
so often, redo the **action**", but they each already have their own retry: a `locate` failure falls back to `fallbackUrl` (redoing locate
= re-scrolling to locate + one human-like click, and humanize is the bulk of this path's time), and `openTarget` has its own `maxScrolls`
retry loop. Stacking another redo on top is redundant and expensive; to loosen it, adjust only `expect.timeout`.

When a run fails it leaves behind a **scene** (which URL it stopped at, the page's visible text, a viewport screenshot, and the observation of the failing step itself):
a one-shot session is destroyed on failure, so the scene gets only this one chance.

#### Observers

Observers read results within a bounded window during step execution, and can be combined rather than being mutually exclusive:

- `network`: subscribes to matching CDP Network responses and reads the body by requestId.
- `state`: reads structured state the page has already produced (such as `__INITIAL_STATE__`).
- `dom`: reads the current rendering result, usually used for locating, validation, or fallback.

An Observer only reads content already produced by the page flow. Actively calling the site's internal webpack request client is not equivalent to
"observing XHR" and must not be the default path for simulating user browsing; if retained, it can only be an explicit, restricted compatibility step.

A CDP event body is read only within the bounded window of a matching observer, to avoid unbounded logs and the spread of sensitive data.

#### Output

Output is responsible for dedup, assert, mapping, and the raw item shape before the normalizer. The results of multiple observers are merged by the
backend observer pipeline; the extension does not interpret the Recipe and does no field mapping.

- **`timestampFrom: 'harvest-order'`** (optional): the entry timestamp is not taken from `pubDate` in the mapping but becomes
  "this round's harvest time − sequence number in seconds", i.e. **ordered by the order harvested**. It is for lists like "my favorites": upstream only gives the content's
  publish time and not "when I favorited it", while page order is the favoriting order. The consequence of not enabling it is that an
  old video favorited yesterday sinks to the bottom by publish time, visible in the first 30 entries of the favorites page but unreachable by scrolling in Stream, which looks like "the harvest missed it".
  Stamping happens in exactly one place, `stampHarvestOrder` (`src/adapters/replay/adapter.ts`), after the observer's first batch and the
  evaluate pagination batches are merged — do not compute it yourself in the recipe's mapping; the network observer's
  mapping is a declarative dot-path and cannot compute.
- **`files`** (optional, effective only for **action recipes**): which mapping fields are **files** — binaries handed over as base64 from inside the page.
  The host writes them to `<dataDir>/action-artifacts/` (reclaimed after 7 days), and that cell in the receipt is replaced with an absolute path.
  The key is the mapping field name, and the value gives `ext` (a fixed extension) or `extFrom` (a field in the same item holding the format;
  for `jpg:0.8` the part before the colon is taken); if neither is a mapping field, loading reports an error. **File-type outputs have no second route**: the receipt
  is written as-is into the run ledger (`agent-runs.db`), and the ledger rejects results over 1MB (`RESULT_MAX_BYTES`) — an
  exported image is tens of MB, and encoding it as text into the ledger ends with the ledger swelling to GB and an OOM at boot. Example: `packages/photopea/`.
- **`track_id`** (a reserved mapping field, used by audio sources): the **field path** of this item's stable audio-track id on the source site.
  The normalizer uses it + the owning package's `facility` to compose `(platform, track_id)` — the key for archive / netdisk alignment / playback resolution.
  `platform` **must not be written in the mapping** and is always equal to the package's facility: a package cannot hang a track into another package's id space.
  Having `track_id` without `enclosure_url` = a paid/exclusive episode (`resolveOnly`, playable only if it exists in the netdisk).

#### Extract (one-time extraction: the Recipe's only write effect)

`extract` is the **only** thing in the Recipe contract that **changes Stream's own state**: it writes plaintext shown only once on the page
(a freshly created API key) into this Source's own `runtime_config` secret slot. Apart from it, a Recipe is entirely
"operate the site + read items back", and writes nothing locally.

Because what it writes is the credential store, the boundary is written into the contract rather than left to the implementation's good conduct:

- **There is no ref in `extract`.** The target is bound by the executing side from the `runtime_config.ref` of this Recipe's **own manifest**,
  so a Recipe cannot name someone else's config to write to at run time.
- **The field must be declared `type:'secret'` in the same `runtime_config`**, otherwise the write is refused; this is refused at the **load point**
  (the moment a shared Recipe is reviewed), not silently ineffective at run time.
- **Write only when exactly one place matches.** 0 or multiple matches are both refused — picking any of several candidates is a guess, and a wrongly guessed credential only
  turns into a "key invalid" far downstream.
- **Write-only, never read**: there is no path that sends a `runtime_config` secret back to the page.
- The value does not enter the trace / outcome / logs; `outcome.extract` reports only field names and lengths.

An `extract` Recipe can produce no items at all (`observers: []` + `allowEmpty`); its output is that key.

**Declaring it amounts to signing up as the self-service application entry for that slot.** The host looks up "ref → who can produce it" by the named criterion `provisionedConfigSlot`
(`src/replay/recipe-provisioner.ts`), and the "Do it for me" button
on the config card is a projection of this index (mechanism in `docs/ARCHITECTURE.md`, "Self-Service Provisioning"). Two boundaries to know:
**only built-in packages** enter this index (a third-party package declaring the same ref does not make the built-in card grow a button); when the same ref has multiple
candidates, the first by Source full name is taken — today `firecrawl` has two (`-create-key` / `-read-key`),
and the entry points to the one sorted first.

**Where the plaintext comes from — two tiers, decided by `extract.from`:**

- Default = **the page's visible text** (including the `value` of form controls: a credential shown only once almost always sits in a read-only input box next to a
  copy button).
- `from: { network: '<url glob>' }` = **the response body**. Meant for platforms where the plaintext **never enters the DOM**.
  After Zhipu creates a key, the list always shows a mask, and the plaintext is returned separately by `/api_keys/copy/<id>` only when copy is clicked, going straight into the
  clipboard — the page-text route is dead for it.

  The capture for this tier is **attached by the engine itself** (capture only, no accumulation). **A Recipe must not declare a network observer for this**:
  a credential is not an item, and declaring it as an observer sends it into the items pipeline, where the response it captured is judged by the empty `output` as
  malformed → **drift**, and drift outranks `allowEmpty`, so the extraction's own verdict is covered up and invisible.

#### Policy

Policy describes rate, dwell time, scroll distance, retries, and the task budget. Its goal is to make the action sequence consistent with a real task and avoid
overly fast requests, not to generate superficial random noise. When risk control, a login wall, or insurmountable background throttling appears, it must stop and notify the user.

### 2.3 The Probe archetype (the probe form of `kind:'http'`)

The second recipe archetype besides Feed: **ask a target one question and hand back a verdict object** (netdisk liveness checking is the example:
`packages/quark/quark-share.recipe.json`, `packages/baidu/baidu-share.recipe.json`). All differences from the contract of
feed are declared explicitly:

- **`output: 'object'`**: the return value of `decode` is the member result, bypassing pagination/mapping (load validation
  rejects mixing them); `null` = actively abstain. The verdict enters the Provider member contract as an object identity (`manifest.output`
  projection + unwrapping at the executor seam), not dressed up as an item.
- **`acceptNonOk: true`**: a probe's verdict often lives in an upstream error response body (the code of a quark 403/404 is
  the cause of death), so a non-2xx goes to decode instead of throwing. A feed must never enable this — reading a 500 as "no news today" would empty
  a stream's items.
- **The probe semantics are three-way (invariant)**: "the target is dead" (not-usable), "cannot see in" (unknown), and
  "the network/risk control is broken" (throws → the upper layer files it as unknown) are never merged. Reporting "extraction code rejected" as a dead link makes
  a live link silently disappear under default hiding.
- **`jar: true`** (optional): remembers upstream `Set-Cookie` for the later requests of this execution to carry. Three iron rules are enforced by the
  engine: bucketed by domain, never crossing sites; lives for one execution only, not written to disk and not written back to the broker; kept separate from broker credentials (deduped by
  cookie name when sending, jar value wins). Companions: `compute.params` (parameters derived before the request), prefetch
  `parse: 'json'|'text'|'none'`, `request.redirect: 'manual'`.

Write capabilities (save, delete, like/favorite) **can also be recipes**: a recipe may write to the user's account, with no trust grading / provenance vetting.
Sharing/loading a third-party recipe only carries a uniform disclaimer (① security is not guaranteed ② the user must decide for themselves whether third-party content is trustworthy).
For the full picture of where the line is drawn, see `internal design record` §2.

A write-operation recipe self-reports `effects: ['write']` in `meta` (default = read-only), and the capabilities/effects shown in the npm package install preview
are read from this self-reported field — **the host does no cross-validation**, so a recipe that likes/favorites/saves
will make the confirmation page show "no side effects" as long as it does not truthfully mark `effects: ['write']`. This contract holds only for honest packages; for the publish/install
flow (checklist, preview/install API) see `.claude/skills/share-recipes/SKILL.md`.

### 2.4 Desktop recipes (`kind:'desktop'`)

A recipe that drives a **native desktop application** (not a browser, not HTTP). It uses the `a11y` perception vocabulary (role/name/native-class +
native invoke) rather than CSS selectors. It has a **separate `DesktopDriver` interface + desktop runner** (`src/replay/
desktop-*.ts`), alongside the browser `PageDriver`/`Transport` and not intruding on it (following the http/html precedent).
The runtime is the `host-desktop` Engine
on the host (the `app/host-agent/` Rust sidecar: Windows UIA for reading + enigo for acting), and the backend drives it through the
`/api/host` WS relay (mirroring the process boundary of ext-cdp). The lifecycle of this sidecar is held in-process by the Stream backend itself
(`src/host-agent/mount.ts` hands `capabilities/desktop/` (**Stream Desktop**) to
`src/capabilities/host.ts` to mount as a **built-in capability**, §5.9), and the binary ships per platform as an npm sub-package
(`@streamapp/desktop-<os>-<cpu>`) — **desktop control does not require installing the desktop shell**. The first recipe is `telegram-search` (`packages/
telegram/`): it drives the Telegram desktop client to search and reads the results as resource items, read-only. For the concepts and the two-axis model (Engine /
Perception Vocabulary) see `docs/ENGINE.md`; for the full design and live verification see `internal design records/specs/
2026-07-19-desktop-uia-engine-telegram-design.md`.

> For operating experience when writing/debugging this kind of recipe (resetting, multiple same-role lists, how to lift drift isolation) see
> `.claude/skills/write-recipe/references/surface-desktop.md`.

#### Action type: only does things, reads nothing

A desktop recipe does not necessarily produce items ("send a message to a contact", "install this directory as an extension"). This tier is
**`allowEmpty: true`, and omits `observer` / `read` entirely** — do not forge an always-true observer to get past the gate that
judges "nothing read at all" as drift: a forged one is worse than a missing one, because what it reads and whether it read anything are no longer watched by anyone, yet it looks
like a real verification.

An action-type recipe needs `meta.action: true` as an explicit opt-in, and then has three entry points, all on **the same backend path**
(`src/mcp/action-recipe.ts`: two-step confirmation, validation against `params_schema`, credential injection, rate limiting); do not wire each separately:

| Entry point | Used by | How confirmation is given |
|---|---|---|
| MCP `run_action_recipe` | The agent in a chat host | First call without `confirmed` to get a receipt; after the user agrees, call with `confirmed:true` |
| `POST /api/recipes/action` | Scripts / UI | Same as above, the `confirmed` field |
| `stream recipe run <id> [--param k=v]… [--yes]` | Command line, **the command executor of the scheduling center** | `--yes`; without it, it only prints what it would do and exits with code 2 |

To run an action recipe **on a schedule, unattended, without going through a model**, use the third row: the task's command is `stream` and its arguments are
`recipe run <id> … --yes` (`src/tasks/user-tasks.ts` only recognizes two kinds of executor, command / action, and does not add a third kind for
recipes — the CLI is that bridge). A non-zero exit code is marked red by the task center, and 3 means "did not finish normally; part of the action may already have been done".

**An action that leaves an artifact when it finishes** declares one more cell: `meta.produces: "images"`. A recipe that declares it appears, with its sourceId as the model name, in
the host's OpenAI-shaped image-generation endpoint (`GET /v1/models` / `POST /v1/images/generations`, `src/http/image-generation-routes.ts`);
entries must carry `url` (the one that fell back to a watermarked image is marked `watermarked:'true'`), `output.targetCount` is the upper limit of one round (how many images actually come out is decided by the site; if too few, the route opens another round); to wire up image-to-image, declare `images` in `params_schema` (data URLs of the reference images, joined by lines when multiple), which `/v1/images/edits` passes in. That endpoint is
a **host adapter** that does not know package names — wiring up a new image-generation site means writing one more recipe that declares `produces`, with not a line changed in the host.
A package has **no** slot for "mounting its own HTTP routes" (there is none in `PluginContext`); do not write routes carrying a package name into `src/http/`.

Four things that let "a fixed set of UI operations" be written entirely into a recipe (all are **general shapes**, not special cases of one flow):

| Syntax | Problem it solves |
|---|---|
| `skipIf: <query>` | **Skip this step if something is already present.** Idempotent switches need it: Chrome's "Developer mode" toggle is always there and its name carries no state, so the switch state cannot be read, and clicking it again when it is already on turns it off. (`optional` asks "is my own target present", which is a different matter; do not confuse them.) |
| `{ kind: 'window', match, timeoutMs?, focus?, waitFor?, optional? }` | **Switch to another top-level window** and wait for it to appear. A native file dialog is an owned window of the main window and **not** a descendant of the `app` tree (the process may even be the same one — Chrome's folder dialog was measured to live inside `chrome.exe`, so do not expect to tell them apart by process name); without switching windows, the path box is searched for in the original tree forever. `waitFor`: the title changes first and the UI is built later, so also wait for an always-present control to appear. `optional`: skip if it does not appear — **a "nice to have" stretch of steps should be skippable as a whole**; marking only the `invoke`s inside as optional while leaving out the `window` they stand on leaves a hole that can sentence an already-successful flow to death. |
| `{ kind: 'pickFile', path, dialog?, timeoutMs?, closeTimeoutMs? }` | **Feed a system file dialog that has already popped up**: wait for it to appear → write `path` into the file-name box → give the file-name box focus and press Enter → wait for it to disappear → the scope and foreground target are **automatically switched back** to the window from before this step. The previous step (clicking the "send file" icon) is responsible for popping the dialog up. It absorbs the four steps that used to be copied by hand (`window` waits for the dialog → `type` fills in the path → `invoke` clicks confirm → `window` switches back), and fixes the most fragile cell among them: **the confirm button is not necessarily in the control tree** (WeChat's "Select file" dialog; on the same machine, two captures of the tree once had a `Button` "打开(O)" ("Open (O)") and once did not, 2026-09-18) — the main path is setValue + Enter (verified live), and a confirm button in the tree is only a fallback for when Enter did not close it. `path` is usually written as `{path}` (the shape after a `format:"path"` parameter is translated). When `dialog` is omitted = the default is taken by the platform the agent reports: on win32 `{process:<app process>, titleAnyOf:['打开','选择文件','Open']}` (the comdlg default is "打开" ("Open"), which an application can change), on darwin it is NSOpenPanel (synthesized titles `<无标题 AXSheet>` ("<untitled AXSheet>") / `<无标题 AXDialog>` ("<untitled AXDialog>")); if given, it is recognized as given, with title containment matching and `{param}` filled in as usual. `timeoutMs` waits for appearance (default 12s; the first pop-up was measured at several seconds), `closeTimeoutMs` waits for disappearance (default 8s). It is an action step: `expect` is verified in the original window after the scope switches back ("the file card appears in the input area"), and the always-true pre-check is also done in the original window, so a same-named card left over from the previous round is pointed out on the spot; if no criterion can be written, use `blind`. **The four failure prefixes each point to one segment**: `pickFile/dialog-missing` (did not pop up — the previous step did not click the target) / `pickFile/edit-missing` (the dialog is there but the file-name box is not — UI language or version) / `pickFile/set-value-failed` / `pickFile/dialog-still-open` (confirmed but it does not close — the path cannot be opened or an error box popped up). The receipt of a successful run is `DesktopRunOutcome.pickFile[label]`: `via` (`value+enter` / `keyboard+enter` / `button` / darwin `goto+enter`), `ms{appear,fill,close,total}`, and `foregroundBack` (whether the main window returned to the foreground after the dialog was gone — for a mount with no text criterion (an image) this is the only weak signal left, recorded but not judged). **The macOS path has no real machine and is written by AppKit convention (type `/` on the panel → `PathTextField` writes the path → Enter → `OKButton`); all of it awaits live verification (since 2026-09-18).** |
| Window titles **are matched by containment** | So the candidate titles of two `window` steps **must not contain each other**. This was hit in live use: the extensions page was written as "扩展程序" ("Extensions"), while the folder dialog is called "选择扩展程序目录。" ("Select extensions directory.") — the step after installation matched the dialog that was closing, yet what was reported was "could not return to the extensions page". Write the full title ("扩展程序 - Google Chrome" ("Extensions - Google Chrome")), and pin this invariant with a test. |
| `nameAnyOf: []` / `titleAnyOf: []` | **Multiple candidate names.** Control names and window titles follow the UI language; betting on one language and changing machines gives an empty result, and an empty result looks exactly like "this version changed the UI". Expansion happens locally in the runner and does not go on the wire. |
| `requireTarget: true` on `type` | **Stop if the input box is not found**, without falling back to the keyboard. The default fallback is right for harvest but harmful for "fill specific content into a specific box": the text goes to whatever happens to have focus, and this step still "succeeds". |
| A step's `label` | The sentence shown to a human on failure. Without it, a twenty-step recipe that fails reports only a JSON query, and the reader has to go back and count which step it was. **Required for user-facing flows.** While running, it is also the second line of the takeover banner (`<label> (i/n)`). |
| `meta.title` / `meta.purpose` | **The first line of the takeover banner**: `<title> · <purpose with parameters filled in>` (`微信发消息 · 发给 文件传输助手` ("WeChat send message · send to File Transfer Assistant")). `title` is this Source's display name (projected into the manifest `title`, falling back to sourceId when absent); `purpose` is specific to the banner: a template for this run's purpose, where `{x}` may only reference keys declared in `params_schema` (rejected at load time), and **must not reference `secret_params`** — purpose is the only place on this path where a parameter value reaches the screen, and it is exposed only when the author names it explicitly, while `{contact}` in a step label is still left as-is. Both are optional. |

#### `see` / `expect` / `interrupts` in desktop recipes

**`see`: points at what a human eye can see on the screen, not at coordinates.** Besides `query` (a11y
role/name), the target of `invoke` / `type` can be written as `see`; only one of the two can be given — a target bets on one vocabulary only. In `see`, exactly one of `text` (this piece of
text on screen, supporting `{param}` interpolation) and `icon` (a one-sentence description when there is no text to point at) is given, and an optional `region` limits where to look by the window's nine-grid
(edge cells take 1/3, `center` takes the central 1/3×1/3), or conversely uses `not-left` / `not-right` /
`not-top` / `not-bottom` to exclude one third of one side and count everything else — meant for **fixed-width sidebars**: WeChat conversation titles sit right next to the
fixed-width left column and drift between the middle and the left third as the window size changes, so no positive cell can cover them, while "outside the left column" holds at any size.
**Fixed-pixel bars (WeChat's left column 335 logical pixels, top title bar 80, bottom input area 220) use `{unit:'dip', x, y, w?, h?}`**:
logical pixels, measured from the window's top-left corner, with negative x/y measured back from the right/bottom edge, w/h omitted = to the window edge, multiplied at run time by the `scale` of that screen read.
A proportional rectangle bets on "the fraction of the window", and such bars do not move with the window — when maximized at 4K the left column takes only 0.09, and `x:0.2` would cut off entirely the
conversation title and the start of the body right next to the left column (OCR reads half-words and the containment match misses), while on a 1600-wide window the same recipe is fine.
How this intent is turned into a box belongs to the recognition layer
(`src/replay/desktop-see.ts`; for the ladder see `docs/ENGINE.md` §3), and not a single number should appear in the recipe —
coordinates bet on "the window being placed at this position this time and this machine having this scale", and on another machine they click somewhere else while every step still "succeeds".

**`see.below` / `see.notBelow`: find by section sub-heading.** In a sectioned list the same text appears several times (WeChat's search candidate popup:
the first entry under "搜索网络结果" ("Search web results") is the very text you typed, the real account is under "联系人" ("Contacts") / "功能" ("Features") / "公众号" ("Official accounts"), and under "收藏" ("Favorites")
there is also "来自：某某" ("From: someone")), and the position of each section changes dynamically with the results, so `region` cannot cut it. `below` lists the sub-headings that **count**, and `notBelow`
lists those that **do not count**; the two together are the complete set of "which texts are sub-headings"; a candidate belongs to the nearest sub-heading above it, and one with no known sub-heading above
does not count. It is only meaningful for `text` targets, and when given it skips the a11y segment (the control tree has no "under which sub-heading" dimension).

**`see.not`: do not take that row.** If any of these texts appears in the **row the candidate sits in**, the whole row is out. Meant for rows that
"look like the target but are actually another entry": when QQ searches a contact, the left column shows both the real conversation row and, at the bottom, a row
"进入全网搜索<名字>" ("Enter web-wide search <name>"), and both rows bear that name. **Position cannot tell them apart** (it was once cut by x: the real row at x=121, the
fallback row's second half at x=210 — a slightly longer name misaligns it, which encodes a semantic distinction as a pixel threshold and fails silently), whereas
"that row carries 『进入全网搜索』 ("Enter web-wide search")" is stable and semantic, and is exactly what a human uses to tell them apart at a glance.

**The criterion falls on the row, not on the segment**, and this is required: OCR segments differently on each frame, and that fallback entry is sometimes one whole segment
"进入全网搜索我的手机" ("Enter web-wide search my phone") and sometimes cut into "进入全网搜索" ("Enter web-wide search") + "我的手机" ("my phone") — dropping by segment only drops the first half, and
the second half is still a fake candidate fully equal to the target (recorded on this machine 2026-09-07). After aggregating by row, however it is cut does not affect the conclusion.

**`require`: a precondition.** Any step can carry `require: { see | query, timeoutMs }` — it must hold before the action; wait until it holds
(at most `timeoutMs`) and then act; if it never does, handle it per this step's `else` (`abort` = send no more input from then on). It is the opposite of `expect`
(that one must be false before the action and true after), and fills the cell where **the criterion lives in another window**: after clicking a row in the candidate popup the popup
closes, and the criterion "the conversation title is him" is in the main window, so it can only be attached in front of the next step (typing the body). **No always-true check** — "must
be true right now" is exactly its semantics. Another shape of the same cell: **the action is in a dialog, the delivery criterion is in the main window, and no other action step follows**
(`wechat-send-file`: clicking "打开" ("Open") sends it out, and back in the main window all that is left is "look at the file bubble") — after switching back to the main window attach a `wait 1ms` step and
write the criterion as its `require`. Writing it as `expect` does not work: the pre-check "must be false before the action" happens after the window switch, by which time a small file's bubble is already there, and a
genuinely successful send would be judged as an always-true decoration.

**The cost ladder of the recognition layer and the master switch.** `see` resolves in increasing cost: a pinned handle (a previous run located it with the model and left a control name)
→ control tree → screen read (PP-OCRv5 running on ONNX Runtime; the three model files `ocr-det.onnx` / `ocr-rec.onnx` /
`ocr-rec-dict.txt` and the runtime library all sit next to the exe; if any one is missing, both platforms directly report `ocr-missing` / `ort-missing`
with no fallback) → template (local cache) → a local detector giving clickable boxes (OmniParser icon_detect, `see-detector.onnx` next to the exe,
computed only for `icon` targets and before asking the model) → vision model picking by number (the `desktop.see` callsite)
→ **grounding model reporting coordinates** (the `desktop.point` callsite, the most expensive and last).

**The last two tiers are two different questions, not two ways of saying one tier.** `desktop.see` asks "which of these candidates is it", and the candidates
always come from the element table — so **something the element table does not contain at all can never be pointed at** (when the candidate pool is empty it can only honestly say there is none).
`desktop.point` asks "where is it", and the model can report a position that does not exist in the element table. Hence each has its own callsite,
to bind two kinds of model: the former picks by looking at the picture, and the latter needs a GUI-specific grounding model.

**Only `see.point` targets reach the last tier**, and **only on the action path** — criteria (`expect` / `require` /
`branch.when`) never call a model, so a criterion written with only `point` can never hold.

**It is pinned immediately after the click, so this tier is paid for only once per cell.** After the model reports the coordinates, the element table is read back once to see whether that position
has a named control; if so, the name is stored in the local `handles.json`, and the next run walks the ladder from tier one (saving a whole-window
OCR), and **when coordinates drift the handle is still there** — on the desktop an a11y query is the equivalent of XPath. Once a stored handle
has been clicked but `expect` did not come true, it is invalidated together with the stale template (see the intervention gate below).

**The price of screen reading goes by area and number of lines, so `region` is not an optimization but a precondition for this path to be usable**: the whole window takes 1–3.4 seconds
(det is linear in pixel area, rec does one inference per line at 20~50ms a line), and a small block with `region` takes roughly tens of milliseconds — criteria
almost all carry a region, so the normal path is fast. Recognition results are cached by the image content of the box, and the second time on the same screen only the changed lines are recognized.

**The first tier of the ladder (the control tree) is now cheap**: one whole-window enumeration takes tens to hundreds of milliseconds (an empty tree ~50ms, a real tree with several hundred controls
~0.6s), and "not found" also takes tens of milliseconds. So there is no reason for an application that has a control tree to bypass it — do not write pixel criteria because "a11y is slow".

**The detector only answers "where is something clickable"; it cannot answer "which one is mine"**: the boxes it gives have no names, and names are scraped by OCR from the
text inside the box (so a button labeled 「发送」 ("Send") has a name).

**Worse than "nameless" is "not even a box"**: an input box that is a large blank area has no text to recognize, and the detector (trained to find icons and
buttons) gives no box either, so it **does not exist in any of the three tables** — it is not that recognition is inaccurate; there is genuinely nothing there to point at.
The QQ message input box on this machine on 2026-09-07 is exactly this tier.

**This tier is exactly why `see.point` exists**: `text` / `icon` both pick from a table, and if it is not in the table it cannot be picked;
`point` directly asks the model "where is it". Try three things in order: first ask whether the control tree has it (cheapest); if not, write `point`
(paying the model once the first time, then pinned as a handle); only if neither works, change the **criterion** to "the consequence of the action"
(where the body appears after typing) rather than "the target of the action" — note that the last one changes the criterion, not the target.

The backend environment variable `STREAM_DESKTOP_SEE_MODEL=off` removes the last **two** tiers entirely, leaving only local capability — `icon` and
`point` targets then have no solution, while `text` targets are unaffected. **How far local capability goes was measured once** (2026-09-07, QQ send message):
search, disambiguation, identity verification, and the delivery criterion all work, and it stops at "clicking something that has no text and no stable name".

**The intervention gate: `expect` not coming true is the only trigger that calls the AI.** When a step is finally given up, if its target was **given by the cache**
(a `template` image / a `point` coordinate / a `pinned` control name), that target is invalidated and a **locator
proposal** (`RepairProposal`, through the seam at `src/replay/repair-runner.ts`) is handed out. Three boundaries:

- **Only invalidate; do not replay within the same run.** This run has already clicked once and the side effect may already have happened; trying again would be a second click.
- **The proposal does not change the recipe.** Silent self-healing would mix "the UI really changed" and "this time the click missed" into one thing, and if the latter
  "succeeds" by self-healing, a real bug is automatically bypassed every time, so nobody ever finds out.
- **The scope is locked to the locator.** What the proposal carries is always the `see` of the action step, and not one cell of the criterion may be rewritten —
  if the criterion could be rewritten by the model, the whole thing would degrade into "the model says it itself succeeded".

The `screen` / `a11y` tiers do not take this hit: they are **read live**, and an unfulfilled result means the thing is truly not on the UI,
not that the target is stale.

**`branch`: branching.** `{ kind:"branch", when:{ see | query, timeoutMs? }, skip:N }` — if `when` holds right now, skip the next
N steps; if not, continue; it is evaluated once, in the current scope, with no always-true check and no model call. For flows where "the target state may already be in place"
(if the conversation is already his, do not search). It bypasses no gate: the `require` / `expect` of the step after the skipped steps still take effect as usual. A per-step
`skipIf` cannot replace it — if among several steps one has its scope in another window, the same criterion evaluated there means something entirely different.

The second shape of `when` is **branching by parameter**: `when:{ param:"send", equals:false }` — it does not read the screen and only looks at the parameter given by the caller
(which is already a string by the time it reaches the runner, and `equals` compares via `String()`; parameter absent = does not hold, with the default filled in only at
`params_schema.default`). `param` must be a key declared in `params_schema` (rejected at load time: a misspelled branch never holds, which shows up as "the switch had no effect").
For "same flow, whether the last shot fires is decided by the caller" — `wechat-send`'s `send:false` types the body into the input box, skips the Enter, and
the run ends with `ok`. **Only a parameter branch is allowed to jump to the end of the recipe** (swallowing all remaining steps); a screen-reading branch jumping to the end is "did
nothing yet ok", and is rejected at load time. What was skipped goes into the receipt: `DesktopRunOutcome.skipped` (`run_action_recipe`'s `done`
carries it too), each item `<label of the skipped step> ← <label of the branch>`, and with no step skipped this field is absent — looking at `done` alone, "typed in but not sent"
and "sent" look exactly the same, and this line is what tells them apart.

A parameter branch can also carry **`unverified:"<reason>"`**: this branch holding = the only criterion of this run was skipped, and the runner records the reason in the receipt
`DesktopRunOutcome.unverified[]` (`done` carries it too). For flows where "the criterion is split by parameter and one route has no criterion at all":
`wechat-send-file` sending an image — WeChat mounts an image into the input box by drawing only a thumbnail with no file name, so a text criterion never holds, and that route can only skip the criterion
and use "the dialog is closed" as a weak criterion, with the receipt marked `unverified:['image-no-caption']`. A run of `ok` + `unverified` means "did it", not
"saw it done", and the caller must be able to tell them apart. It is allowed only on parameter branches (a screen-reading branch holding means a state was read, so it does not count as unverified).

**`params_schema.<k>.format:"path"`: this parameter is a file path on the target machine.** Before execution (`materializeParams`,
`src/mcp/validate-params.ts`, the same one for all three entry points): a Linux-shaped path is first checked for existence, and if the backend is in WSL it is translated to
`\\wsl.localhost\<distro>\...` (`wslpath -w`, the same translation as the one used for installing extensions on behalf of the user); a path already in `C:\...` / UNC shape is
passed through as-is (`wslpath` would eat the backslashes, so it must not touch them); a path that cannot be translated / a file that does not exist / a relative path is rejected here with
`invalid-params` — handing a path that can never be filled in to the dialog makes the failure look like "control not found". Five fragments are also derived
(`src/replay/path-params.ts`): `{<k>_name}` the file name, `{<k>_stem}` the stem without extension, **`{<k>_stem6}` the first 6 characters of the stem**,
`{<k>_ext}` the lowercase extension (without the dot), and **`{<k>_kind}`** `image` (png/jpg/jpeg/gif/webp) or `file`. What the UI shows is the
file name and not the path, and **long file names get truncated** (WeChat: 「中基协登记备...2期.pdf」 (a long Chinese file name truncated in the middle)), so using the full name as the criterion is bound to fail — the criterion uses `_stem6`
for a containment match (the mount / delivery criteria of `wechat-send-file` both use it); an image has no text to point at, so `branch` splits by `_kind`.
Derived keys are not in the schema, so a caller passing one is rejected by the undeclared-key gate; `branch.when.param` recognizes them.

**`clear`: clear the input box that currently has focus.** `{ kind:"clear" }` — select all + delete; which modifier key to use belongs to the platform backend, and the recipe does not know
and should not know. For the tier "the last round stopped after typing the body and the body became a draft": without clearing, the next round's body is appended after the draft and sent out together.
**Right after the step that takes focus** — it clears whatever currently has focus, and if focus is elsewhere it clears the wrong place. It is not a channel for "press a key combination"
(once `Ctrl+A` is allowed, `Ctrl+W` / `Alt+F4` are on the same road), and its semantics are narrowed to this one thing; it only takes the screen-grabbing route,
and under `input:"message"` the agent rejects it directly.

**`input`: whom coordinate input is delivered to.** Omitted = delivered to the screen: the agent synthesizes keyboard and mouse input, and before each coordinate step first brings the `app` to the
foreground; if it cannot (locked screen, covered by another window) it stops and sends no input at all. `"input": "message"` = delivered to the window itself
(`PostMessage` to its hwnd): **it does not grab the foreground and runs normally on a locked screen**, and the `focus` step is reduced to limiting scope. This is the only way for an
application without a control tree to "work in the background while no one is there", verified end to end on WeChat 4.x with the screen locked. **It is chosen explicitly and is not an automatic fallback**:
applications that run their own compositor (the Electron family) mostly ignore the messages posted in, and fail quietly. Which applications accept it can only be measured once on a real machine
(`stream-desktop.exe see-probe` can see the UI but cannot see whether input went in — the criterion is each step's `expect`); measure first,
then write; a recipe that writes `input:"message"` in particular must not omit `expect`. The recipient is the **top-level** window matched by `app`, and
input posted to a custom-drawn child window does not get in.

**`app.a11y`: whether this application has a control tree.** Defaults to `true`. `"a11y": false` is the author's **declaration of fact** (not an optimization switch):
the element-table read before an action (`readElements`) no longer enumerates the control tree, saving 80–90ms per step; the criterion path (`readText`) is unaffected.
When to write it: `kind:"a11y"` in the `elements` of `see-probe` is always empty **and** the application is known to be custom-drawn (the whole WeChat 4.x window has only
one custom-drawn Pane). It is not the same thing as the "ask once, empty, blacklist permanently" that the agent rejects — that infers a permanent
conclusion from a temporary state, whereas this is the author declaring a fact that does not change between foreground and background. How a wrong declaration shows up: the a11y segment is always absent, all clicks go by coordinates, and every step still "succeeds",
with the only trace being that every `elements` read in the log shows `a11y=0ms(off)`. A non-boolean is rejected at load time.

**`expect`: whether this step took effect, verified step by step — required for action steps, enforced at load time.** `invoke` / `type` /
`click` / `scroll` / `press` / `clear` / `pickFile` can all carry `{ see | query, timeoutMs }` (default 3000). **Either give `expect`,
or give `blind` (a sentence explaining why this step has no observable consequence)**, one of the two; if neither is given, loading rejects it.

> **Why it is mandatory**: the rule "I clicked something, so next I should see something" was always written here, but because it
> used to be optional, almost nobody followed it — measured once, **18 of the 21 action steps** in desktop recipes had none. Not following it
> gave no warning either, and the cost was that a missed click surfaced in another guise two or three steps later, by which time the scene was long out of reach.
>
> `blind` is not an exemption; it **separates "forgot to write it" from "thought about it and there truly is none"**. Some transitions are genuinely invisible on certain backends:
> "the input box got focus" produces no picture change at all in the vision approach. Then write it down and say which step takes over the responsibility
> (the 「点搜索框」 ("click the search box") step of `qq-send-see`: whether the click landed is covered by the `expect` of the next step, 「输入联系人」 ("type the contact"), which is `abort`).
>
> **The shape of the criterion follows the backend**, but the rule is the same one: on a browser it is a selector appearing/disappearing, on the control tree a control
> appearing, and on the vision approach a piece of text appearing in a region.
>
> **When a verified expect cannot be written, do not make one up.** An unverified expect is worse than none — it looks
> rigorous but is actually a guess. Write it honestly into `blind` (`qq-send` / `telegram-search` are handled this way,
> using 「未补判据」 ("criterion not yet added") as a greppable to-do marker).

Two disciplines are carried over unchanged from the browser side: **false before the action, true after**
— before the action the runner first reads once immediately, and a criterion that already holds at that moment is named "always-true" and judged drift on the spot, because an always-true criterion is decoration, not supervision;
after the action it polls until it holds or times out. When it does not hold, follow `else`: `drift` (the default, stop and leave the scene), `retry` (redo this step, at most once), or
`abort` (stop cleanly, **sending no more input from then on**). **Flows with side effects must use `abort` to seal off the error path**:
`wechat-send` uses `abort` at both "the name appears in the search box" and "the conversation title is him", and never types the body without seeing them —
the route of sending to the wrong person no longer exists by shape.

**`expect.fresh: true`: use when a region that "definitely does not contain it before the action" cannot be drawn.** It replaces "false before the action" with "after the action, a position appears that
was not there before the action": before the action the runner records all positions of this text in the region as a list (with no always-true pre-check), and after the action it must see
a position not on the list to count as fulfilled (an OCR box on the same line that jitters by a few pixels still counts as the original position). Only for `see.text`, and only on `expect`
(`require` has only the one frame of "right now"). The typical case is a chat input box: the user can drag it taller or shorter, and there is no fixed line between the input box and the bubbles —
both the "type the body" and "press Enter to send" steps of `wechat-send` use one 「会话区」 ("conversation area") region + `fresh`: typing → one more place in the input box; Enter →
one more place among the bubbles, and if it was not sent only the original place in the input box remains; sending the same sentence repeatedly is fine, since the previous one's position is already on the list. Cost: the region can
be widened but screen reading is priced by area, so cover only the stretch that is truly needed.

**`interrupts`: things that can pop up at any time and can simply be closed to continue.** A recipe-level table (update prompts, ads, permission asks),
each entry being `{ see, dismiss }`, where `dismiss` accepts only `invoke` (with `see`/`query`) or `press` (`Escape` / `Enter`;
in ordinary steps `press` **only allows `Escape`**, and Enter is still written as `type` with `\n` — do not give the same thing two spellings). **The table is consulted only when some step's expect does not hold**, so the normal path
sends not one extra screen read; on a hit it dismisses, re-verifies the original expect once, and only if it still does not hold handles it per `else`. **At most one dismissal per step** —
allowing a loop costs getting stuck on a popup that cannot be closed. Two things do not go in this table: login walls (they cannot be closed and belong to `loginCheck` →
`needsLogin`) and popups never written in the table (that is drift: leave the scene for a human to see, and never click around on an unrecognized UI).

#### `map`: extract top-level fields from a lump of text

The a11y tree can only give a control's `name` — the name of a Telegram message is the whole body squeezed into one line. But a Stream
item wants **top-level** fields like `title`/`link`: **the frontend shows the top-level `item.title` everywhere**, and extracting again in the normalizer
is wasted effort (the lesson is recorded in `packages/alist/normalizer.ts`). So a desktop recipe has a `map` layer,
`target field → { from: source field, match: regex }`, taking the first capture group (the whole match if there is no capture group):

```jsonc
"observer": { "itemQuery": { "role": "ListItem" }, "fields": { "text": { "read": "name" } }, "dedupeBy": "text" },
"map": {
  "title": { "from": "text", "match": "名称：(.+)" },
  "link":  { "from": "text", "match": "https?://[^\\s]+" }
},
"read": { "dedupeBy": "link", "targetCount": 30 }
```

(Here `"名称：(.+)"` is the regex literal for the "Name:" label in the page text, so it stays Chinese.)

Four rules:

- **Extracted fields are additive**; the original field stays (tracing relies on it).
- **If nothing is extracted, do not write the key**, and never write an empty string — an empty string disguises "nothing extracted" as "extracted an empty title",
  while `(untitled)` at least makes the absence visible.
- **`map` runs before dedupe**, so `read.dedupeBy` can point at an extracted field. Deduping by the whole body is unstable:
  the tail of the body carries things like view counts and 「已编辑」 ("edited") that change on every read. Conversely, an entry whose dedupe key cannot be extracted is
  dropped — ad strips usually have no link, which works as a filter.
- **The regex is compiled at load time**, and a bad regex is rejected on the spot. Letting it blow up at run time looks like "this round extracted nothing",
  exactly like "the page changed and the rule no longer matches", and would disguise a typo as source-site drift.

#### Grounding (`groundings`) and contributions

**A step = intent + criterion + several labeled groundings.** The graph (which steps there are, from where to where) and the criterion are cross-platform,
while "how to recognize the current state and where to click to get through" forks by (platform, app version, UI language) — the two differ by an order of magnitude in stability,
and writing them in the same line would make one platform difference look like the whole recipe being invalidated. For the authoritative design see
`internal design record`.

```jsonc
{
  "label": "等候选弹层",                       // Required and unique across the whole file: it is the key for local overrides and contributions. ("Wait for the candidate popup")
  "intent": "Wait until the search candidates are computed, and switch the scope to where the candidates are",   // Plain-language intent, for a future filler to read
  "kind": "window", "match": { "process": "Weixin.exe", "title": "Weixin" },  // Top-level body = the universal grounding
  "groundings": [
    {
      "on": { "platform": "darwin" },        // A key not written = unrestricted
      "kind": "wait", "ms": 600,
      "note": "mac has no such popup; the candidates are drawn in the main window's left column",
      "verified": { "runs": 3, "first": "2026-09-12", "last": "2026-09-12", "by": "author" }
    }
  ]
}
```

- **The top-level body is the universal grounding**: a recipe without `groundings` runs unchanged, not a word altered.
- **The criterion lives only at the top level**: `label` / `intent` / `expect` / `require` / `else` / `optional` / `blind` /
  `skipIf` / `groundings` appearing inside a grounding is a format error, rejected at load. The reason is the precondition for the cache to be safely refilled —
  if a different way of getting in is used, what gets checked is still the same thing; a wrong fill is stopped by the criterion and not sent out.
- **A grounding must not hard-code parameters**: for a top-level field carrying `{param}`, the same path in the grounding must still carry the same
  `{param}` (if it is phrased differently or does not have the field, it is not checked). This is both the cross-call correctness of the recipe and the de-identification gate of the contribution chain.
- **Keys of `on`**: `platform` (`win32` | `darwin`), `app` (version range), `lang`.
  Range syntax accepts only space-separated `>= > <= < =` and bare version numbers (`>=4.0 <4.1`, `4.0.6`), all of which must hold;
  `^` / `~` / `||` are rejected at load time as syntax errors.
- **`on.app` must be written together with `on.platform`** (a convention, not enforced at load time): the version formats reported by the two platforms are not the same thing — Windows reports the exe's
  file version (four segments, such as `4.0.6.36`), and mac reports the bundle's `CFBundleShortVersionString` (such as `4.0.6`).
  A range without platform lands on an unexpected side on the other platform. When the agent cannot report a version, any grounding carrying `app`
  **does not match**.
- **Facts come from the agent** (`WindowInfo.platform` / `appVersion`), not from `process.platform`: with the backend in WSL and the
  agent on Windows, the backend's own platform is the wrong answer. An old-version agent that does not report the platform → only the universal body is left.
- **Selection and fallback**: candidates = in-package `groundings` ∪ local override ∪ top-level universal body; after filtering by facts they are ordered by
  **fit** (how many `on` keys are written) > **source** (package `author` > package `contributed` > local `human` > local `ai`)
  > `verified.runs`, with the universal body always last. Try them one by one: execute the body, then run the top-level `expect`, and use it if it passes;
  the `else: "abort"` step is not allowed to fall through (a path with side effects cannot be tried a second time). If all are tried and none passes → the drift reason carries the
  `no-grounding@<label>` prefix, with the list of those tried and the current facts. `DesktopRunOutcome.groundings` records which one each step
  used (`package:<platform>[@app]` / `local:…` / `universal`) — **a fallback must leave a trace**.
- **`edges[]` (conditional edges) are only shape-validated, not executed**: the format is pinned first so that two spellings do not each drift.
- **Step `kind` has an allowlist**, and groundings consume the same list: a misspelled kind gets selected and then does nothing, which is worse than not having it.

##### Named areas: the criterion's text is universal, while the screen block the criterion looks at is grounded per platform

`expect.see.region` carries two things: "the body appears in the bubble area" is the criterion, universal across platforms; "which block of this machine's window the bubble area occupies"
is a grounding fact, of the same kind as "where the input box is". Split them: top-level `areas` declares several named areas, and `see` references them with `area` (mutually exclusive with `region`).

```jsonc
"areas": {
  "气泡区": {
    "intent": "The block where sent messages sit; the bottom edge must exclude the input box at the bottom",
    "region": { "x": 0.34, "y": 0.06, "w": 0.66, "h": 0.72 },     // Universal (may be omitted)
    "groundings": [
      { "on": { "platform": "win32" }, "region": { "x": 0.34, "y": 0.40, "w": 0.66, "h": 0.38 }, "verified": { "runs": 1, "first": "2026-09-13", "last": "2026-09-13", "by": "author" } },
      { "on": { "platform": "darwin" }, "region": { "x": 0.34, "y": 0.06, "w": 0.66, "h": 0.52 } }
    ]
  }
},
"steps": [{ "label": "回车发出去", "kind": "type", "text": "\n", "expect": { "see": { "text": "{message}", "area": "气泡区" } } }]
```

(Here `气泡区` means "bubble area" and `回车发出去` means "press Enter to send"; both are names used as data.)

- The body of an area grounding **has only `region`** (nine-grid name / `not-<edge>` / proportional rectangle / dip rectangle); any other key is rejected at load.
- **Selection is a table lookup, not trying one by one**: before the run, one is taken for each area by facts (platform, version) (fit > source > runs, universal last);
  if not a single one can be selected, the whole run stops with `no-grounding@area:<name>` before any input is sent — an area has no expect of its own as a fallback,
  and trying one by one would wash a real failure into success using other areas.
- Bookkeeping, local overrides (the `areas` section in the file), contributions (`stream recipe contribute <id> --area <name>`), and absorption
  (`pnpm recipe:absorb`) all go through the same machinery as steps; only a **positive** conclusion is recorded (the "must not hold right now" check before the action does not count).
- **When to use**: the same block of screen is referenced by several criteria (the title bar), or the position differs between the two platforms (input area, bubble area). A rectangle used in only one place and
  identical on both platforms stays inline as `region`. An area that is declared but referenced by no one is rejected at load.

**Local override**: `<dataDir>/recipe-overrides/<sourceId>.json` — **not in the package directory**, since an installed package lives in
`<dataDir>/recipes/<package name>/` and an upgrade overwrites the whole directory. Its shape is the same as the in-package `groundings[]`, with just an extra source section,
so every entry is a block that can be merged back into the package, not a private hack. The count bookkeeping for in-package groundings is also kept here (package files are read-only).

```jsonc
{
  "recipe": "wechat-send",
  "package": { "name": "@streamapp/wechat", "version": "1.0.1" },
  "steps": {
    "点进消息输入框拿焦点": {
      "groundings": [{
        "on": { "platform": "darwin", "app": ">=4.0.6 <=4.0.6" },
        "kind": "click", "at": { "x": 0.6, "y": 0.87 },
        "verified": { "runs": 4, "first": "2026-09-14", "last": "2026-09-16", "by": "human" },
        "shadowed": false
      }]
    }
  },
  "edges": []
}
```

(Here the step label `点进消息输入框拿焦点` means "click into the message input box to take focus".)

**Local override entries have only two sources today** (there is no automatic filler — AI/human-machine filling comes later): the runtime bookkeeping of **in-package**
groundings (`by: "author"` / `"contributed"`, whose source is the package itself and which therefore can never be contributed), and entries **hand-written into**
`<dataDir>/recipe-overrides/<id>.json` (`by: "human"`, which become contributable once past the threshold). So `stream recipe
contribute` on a machine where nobody has hand-written anything only says 「没有可贡献的落地方式」 ("there are no groundings to contribute") — that is correct, not broken.

After a recipe run reaches `done`, one record is made: `verified.runs += 1`, `last` is updated, and an `on.app` of the `>=a <=b` shape
is widened to the version of this run. Reconciliation happens **at the start of each run** (the runner calls
`overrides.reconcile` before picking a grounding the first time), not at load time — after a package hot update that run immediately gets the new reconciliation result, rather than running to the end with the previous version's
local groundings. Reconciliation does two things: if the one learned locally has already entered the package (same label, same `on`, same body) → delete it;
if its `on` is covered by an in-package entry but the body differs → mark it `shadowed` (it does not participate at run time, and is visible and deletable in the UI). With no change it stays silent.

**Contributing back to the package.** The destination is stated by the package itself, and we maintain no collection service; if either of the two cells is missing it is "this package does not accept contributions", with no guessing
and no fallback to the Stream repository:

```json
"repository": "github:JaggerH/stream",
"stream": { "contribute": { "path": "packages/wechat/wechat-send.recipe.json" } }
```

- Threshold: a local grounding needs `verified.runs >= 3`, `last - first >= 2 days`, `by ∈ {ai, human}`, and
  not shadowed to count as contributable. The gate is necessary — it filters out one-off lucky guesses.
- One action on the user side: `stream recipe contribute <sourceId> [--step <label> | --area <name>]` (`--step` filters to one step,
  `--area` filters to one named area; only one of the two may be given). If the local `gh` is logged in → fork +
  branch `contrib/<recipe>/<platform>-<hash8>` + file `contributions/<recipe>/<platform>-<hash8>.json` + PR;
  otherwise open a prefilled issue link (label `recipe-contribution`); if the body exceeds what the address bar can hold → write it to
  `<dataDir>/recipe-overrides/<recipe>.<hash8>.contribution.md` and print the path.
- A contribution carries: platform, version range, Stream version, the grounding itself, count and first/last dates, and the filler type.
  It **does not carry** screenshots, control trees, `origin`, or any parameter literal. The only evidence is "in how many real runs it passed the criterion".
- **The de-templating gate runs once more before sending out**: the local override file does not pass the load gate (only `JSON.parse`),
  and it is allowed to be hand-written — so an entry that hard-codes the top-level `{contact}` as a real contact name cannot be stopped by a gate placed at load time.
  `stream recipe contribute` checks each entry against the recipe in the package as the baseline, and skips those that fail, printing which step.
- Author side: `pnpm recipe:absorb <issue or PR number>`. Four cases — same `on` and same body → only merge `verified`;
  same `on` different body → place it **alongside** as a second entry without replacing (tried one by one at run time, with the criterion as the fallback); none → insert;
  the label cannot be found → reject. The inserted entry gets `verified.by = "contributed"` plus a `ref`.
  The script only writes files and **does not commit**: the author runs the guard tests and commits themselves.

### 2.5 Silent shadow session data flow

> **This section is only the conceptual contract.** The runtime model of this pipeline (where the ledger comes from, the three-tier degradation of `locate`,
> exclusive tab ownership and preemption detection, observer attach timing) and the full fault lookup table are in
> **`.claude/skills/write-recipe/SKILL.md` (the single source of truth)**. Read it before touching `src/replay/`.

Search is a T2 Provider invocation: it executes per call, the result returns to the caller, and it is never written to the feed ItemStore.
The underlying session may live for a long time, but that does not change the transient nature of the business data. (**Home / recommendation feeds are not supported** — scraping someone else's recommendation feed
is not what Stream is for; see spec `2026-07-28-xhs-harvest-on-user-chrome-design.md` for the reasoning.)

```text
Command direction: frontend -> backend -> /api/ext WS -> extension/CDP -> site
Event direction:   site -> extension/CDP -> /api/ext WS -> backend -> /ws -> frontend
```

The recommended flow when a user clicks into a detail (the host side is the same for every site; site names live only in the package):

1. The frontend takes where to fetch on demand from the item's `content.enrich` (`{ source, params }` written by the package's normalizer, §3.2) and
   sends the WS command `enrich.open { correlationId, source, params }` (protocol in `docs/API.md`).
2. The backend dispatches to the same-named enricher handed over by the package; the enricher runs the package's detail recipe via `ctx.readSource`.
3. The recipe's `locate` step finds the target card in the facility's shadow session according to the feed ledger (the ledger is filled by the runtime,
   §2.2 Ledger), scrolling to look for it if necessary; a CDP trusted input click is issued; network/state/DOM observers are opened at the same time for a bounded observation window.
4. The backend pushes back `enrich.article` / `enrich.comments` / `enrich.completed` in chunks keyed by correlationId.
5. The session returns to the original Search context and stands by.
6. When the target card has been recycled by the virtual list and cannot be restored, degrading to detail-URL navigation is allowed, but the degraded path must be recorded.

A card carrying `content.enrich` must not trigger the detail recipe automatically when it approaches the viewport (the frontend's `allowsAutomaticEnrichment` is always false for it);
the detail is triggered only by a real user click or an explicit call.

### 2.6 Record -> Translate -> Validate -> Replay

The four phases must use the same Recipe schema and the same official runner:

1. **Record**: capture actions, Network samples and DOM/state clues in a debug-visible session.
2. **Translate**: produce a Recipe draft of `steps + observers + output`; do not save coordinate macros or AgentHistory.
3. **Validate**: replay on a real machine with the official runner, verifying capability, login, output and drift semantics.
4. **Replay**: switch to the production session policy (`unattended`) and execute deterministically with zero tokens.

The repair ledger should identify a failure unit by `{facility, recipeId, version}` and record the affected Sources. When a shared detail
recipe drifts, it should produce a single repair state, rather than separate unrelated faults for Home and Search.

### 2.7 The four-cell "validation" terminology

| # | Name | Meaning | PASS criterion | Code anchor |
|---|---|---|---|---|
| ① | Login-state detection | Runtime `LOGGED_IN / WALLED / UNKNOWN` classification, wall takes priority | WALLED -> needsLogin; UNKNOWN is not disguised as wall/drift | `src/replay/actions.ts` |
| ② | Login flow / account creation | Manual login: the user logs in as usual **in their own Chrome** (Stream has no profile of its own to feed). When Stream needs to log in on the user's behalf, `meta.auth` declares `login: 'qr'` (QR-code panel) or `login: 'oauth'` (clicks through "Continue with Google" for the user, riding the third-party login state already present in the browser) | Login succeeds; positive/negative selectors can recognize it. The two branches that declare `login` must also be able to appear in the re-login panel (`PANEL_LOGIN_KINDS`) | The site's own login flow; `src/auth/browser-{qr,oauth}-login-provider.ts` |
| ③ | Recipe schema validation | Static check with zero browser at load time | Schema, references and capabilities are valid | `src/replay/recipe-store.ts` |
| ④ | Recipe end-to-end acceptance | A real session executes the complete recipe | outcome=ok, no drift, output target satisfied | `src/replay/author/validate.ts` |

When saying "validate", always name the object, the phase and an observable criterion, for example:

> Validate the ④ end-to-end replay of xhs-detail: in a debug session, triggered by a trusted click on a Home card, a matching
> detail response/state is received, media + comments are output, `outcome=ok` and `driftReason=null`.

#### Login-wall policy for Record and Replay

- record / `interactive`: wall appears -> pause, prompt for manual handling, one resume.
- replay / `unattended`: wall appears -> abort, `needsLogin`, notify the user; this is not drift and does not quarantine.

### 2.7.1 Three version fields, each answering its own question — none of them is a "field-semantics version"

The three names look alike but ask three different things. Mixing them up leads to counterproductive actions, so use them according to this table:

| Field | Where it lives | What it answers | Who reads it |
|---|---|---|---|
| `version` | recipe file | "I have touched this recipe, so the earlier failures no longer count" | `RepairLedger`: three drifts trigger quarantine, which is **lifted only when the version goes up** |
| `schemaVersion` | package descriptor (old shape) | "Which package format version this package was written against" | The **upper bound** at load time: an app that is too old refuses to install it |
| `hostVersion` | package descriptor | "How new a host I require at minimum" | The **lower bound** at load time |

Two disciplines follow from this:

- **`version` is required, and must not be used as a format version.** Without it, `shouldRun`'s `recipeVersion > s.recipeVersion`
  is always false — once a source is quarantined it is **quarantined forever**, no matter how many times it is changed, and it happens quietly (during quarantine it is simply
  DECLINED, "本轮未采集" ("not harvested this round"), with no error and no failure recorded). Conversely, using it as a format version amounts to declaring that the format changed every time a broken
  recipe is fixed.
- **A recipe's old/new shape is decided by structure, not by version number**: `isCanonicalBrowserRecipe` (whether it has
  `steps`/`observers`/`output`) does the branching, and converting the old shape to the new shape is the job of `canonicalizeBrowserRecipe`.
  To add another level of shape migration, add it on that path; do not carve ranges out of `version`.

### 2.7.2 `pick_in`: on which **picking surface** this source can be picked

The UI has two places for picking a source, and they want two different things:

| Surface | What the user is doing | Who belongs here |
|---|---|---|
| `stream` | Adding to a Channel a **Stream that keeps delivering content** | Per-site timelines, keyword search streams, RSSHub routes |
| `provider` | Picking a **working member** for a Provider row | Search legs (google/brave/telegram/baidu), netdisk liveness checks (quark/baidu-share), the expand tier inside a composite |

Declare it in the recipe's `meta` (the same-named field in a hand-written manifest):

```jsonc
"pick_in": ["provider"]   // can be picked only on the member surface
"pick_in": []             // appears on neither surface: called directly by name from backend code / config flows
// (omitted)              // = can be picked on both surfaces (the vast majority of sources)
```

**The permissive default is deliberate**: 3000+ RSSHub routes are valid on both sides anyway, so they stay silent; a source that needs narrowing declares it itself.
The reverse (nobody can pick by default) would make a new source whose author forgot to declare silently disappear from both entry points — nobody
would be notified that "a source is missing". The cost is that a missing declaration does not raise an error, so the list is pinned one by one by `src/manifest/pick.real.test.ts`: if a new
recipe that should be narrowed forgets to declare, that case turns red on the spot.

**Do not use `discoverable` as a substitute for it.** That field governs only two places (the home page's featured list, and the ranking of intent-based source search) and says
"do not show up in recommendations". The two have been mixed up, and wrongly in both directions: what should be hidden was not hidden — the generic picker does not look at
`discoverable`, so the write operation "给笔记点赞" ("like a note") could be picked as a source; what should be shown was hidden too far — the netdisk source could not be picked in the generic entry because of
`discoverable:false`, which forced the panel to duplicate a member editor.

**The criterion is a named function**, `pickableIn` / `pickableAnywhere` (`src/manifest/pick.ts`); the endpoint filters by
`?surface=`, and a misspelled surface name always returns 400 (it is never silently treated as "not passed", which would send a wider list). When adding a third picking surface,
change `PICK_SURFACES` in one place, and both consumers (the list + cross-plugin search) follow automatically.

### 2.8 Engineering boundaries

Target control points:

- `recipe.ts`: the Recipe schema, defining only the data contract.
- `session-manager.ts`: facility session lifecycle, unattended/interactive, recovery and concurrency.
- `recipe-runner.ts`: orchestration of steps and observers, cancellation, correlation.
- `actions.ts`: generic trusted browser actions.
- `observer-pipeline.ts`: Network/state/DOM observers and output merging.
- `browser-ext*.ts`: the backend CDP driver / transport adapter.
- `extension/src/lib/driver.ts`: owned tabs, raw CDP RPC/event transport; no Recipe business logic.
- `repair-ledger.ts`: Recipe-level drift/quarantine/repair state.

The `harvest` schema and the one-shot `ReplayLauncher` are kept only for compatibility reads — **new Recipes never write the old mutually exclusive harvest
mode**. Before removing this compatibility layer, the builtin/user packages must be migrated first, or a clear version error must be provided.

Three disciplines for the contract layer:

- When a selector drifts, update the Recipe; **never hard-code site selectors into the generic runner**.
- Evaluate expressions passed to the page must be self-contained and bounded by the Recipe schema/runner capabilities.
- `data/`, real profiles, cookies and `config.yaml` never enter a Stream package or git.

### 2.9 The per-row hop chain (`hops`) of `kind:'html'`

A `kind:'html'` recipe (host bare fetch + linkedom, no browser) can, besides `list` / `detail`, declare a series of extra hops (`hops`) for **each row**:
one hop = one more request whose URL is assembled from the fields this row has accumulated so far (a `{field}` template with the same
vocabulary as `{param}` in `RecipeRequest.url`; or `urlFrom` takes some field directly as the URL, one of the two), and the
response is read according to `parse` — `'html'` (the default; fields extracted with CSS selectors) or `'json'` (fields taken by dot-path, with the path semantics the same as the http engine's `itemsAt`). The extracted fields are merged into this row, so a later hop can use the products of earlier hops (chaining).

- **Fault tolerance is the contract**: when a hop fails (network error, non-2xx, a hole in the URL template with no value, unparseable JSON), only those fields are left empty,
  and it **never fails the whole row, let alone the whole harvest round** — a hop is supplementary evidence. By contrast, the failure semantics of `detail` are unchanged (it still aborts),
  and not a single old recipe needs to change.
- Every hop goes through the same guarded `fetchHtml` (SSRF public-network check + `cookieDomain` coverage check), and hops are sent serially.
- There is also a generic piece at the field level: `HtmlField.extract` / the `extract` of a json field — a regex whose capture group 1 (or the full match)
  replaces the value, and a non-match drops the field. It is both a slicer (stripping `Q\d+` from a wikidata href) and a shape gate (`^tt\d+$`
  and the like, so garbage values cannot get into an item).
- Site knowledge (which API, which property number, what the value looks like) stays in the recipe; the engine provides only four generic capabilities: "hop once more, assemble a URL, parse
  JSON, verify a shape" — the boundary stated verbatim in §2.1.
- Example: `packages/wikipedia/wikipedia-award-list.recipe.json` — detail extracts the Wikidata entity
  link from the entry page (`extract` strips out the Q number), three json hops take the Q number and query Wikidata's `wbgetclaims` (P4947/P4983/P345),
  and the TMDb/IMDb ids obtained are stored as `tmdb_movie_id` / `tmdb_tv_id` / `imdb_id`; the film-and-TV canonical ladder consumes
  these ready-made ids directly (Wikidata is no longer accessed during the exchange stage).

### 2.10 State graph: `states.json`

A package can bring its own **state graph**, which answers "I acted and something looks wrong — what is this?" — not logged in / login wall / human verification /
layout A / empty results, the things that hide behind the same URL. The file is `packages/<id>/states.json` (the same for npm packages,
placed at the package root), and the package scanner reads it into `RecipePackage.states`.

The **shape** is simply the JSON of `StateGraph` (`src/replay/state-graph.ts`):

```jsonc
{
  "states": [
    {
      "id": "xhs/results",                    // must be `<facility>/<state>`
      "features": [{ "kind": "url", "pattern": "/search_result" },
                   { "kind": "dom", "selector": ".note-item" }],
      "group": "xhs/page",                    // states in the same group are mutually exclusive; across groups they can hold at the same time
      "note": "搜索结果页"                     // goes only into traces and proposals, not used for matching ("search results page")
    },
    { "id": "xhs/banned", "features": [...], "deadEnd": "账号被限制" }   // deadEnd value: "account restricted"
  ],
  "transitions": [
    { "from": "xhs/login-wall", "steps": [ /* reuse the recipe's step types, no new ones */ ] }
  ],
  "anchor": "xhs/home"                        // optional, reserved
}
```

**A state id must carry the `<facility>/` prefix** (`assertStateIdPrefix`). The prefix is not decoration: **it decides which graph the state goes into**.
A state with a wrong prefix raises no runtime error, it is simply recognized by no one — so the scanner blocks it at load time.

**There are only five kinds of feature vocabulary** (`Feature`), and a state is recognized only when all of them match (AND):

| `kind` | What it asks | Notes |
|---|---|---|
| `url` | Whether the URL matches this pattern | The cheapest one on the web side |
| `dom` | Whether this selector selects anything | Supports `absent` |
| `a11y` | Whether the control tree contains anything hit by this query | Supports `absent` |
| `text` | Whether this string of text is on screen | Supports `absent`, `region`, `where` |
| `image` | Whether a small patch looking like this is on screen | A base64 reference image, NCC template matching; supports `absent` |

`absent: true` is a required tier, not a supplement: the most reliable check for "logged in" is often "the login button is gone",
and mutual exclusion also relies on it to pull states apart. **Background color is not used as a feature** (it follows the system theme and is not portable across machines).

**Checks for rejecting the whole package** (`validateStateGraph` + the scanner; when `states.json` is broken the whole package is not loaded, instead of
quietly missing one graph — the symptom of a missing graph is "this source can never recognize where it is", and nothing shouts about it):

- The top level is not `{ states: [], transitions: [] }` (unparseable JSON counts too).
- A state has empty `features` — it would match everything, which is equivalent to switching `identify` off.
- Duplicate state ids, or a missing `<facility>/` prefix.
- A transition's `from` / `to` points to a nonexistent state.
- A state that declares `deadEnd` also has an exit — the two contradict each other, and if kept, the person reading the graph and the engine would each believe half of it.

**This is one of three layers**: the built-in global one (`states-builtin.ts`, three Cloudflare tiers) ∪ the one the package brings ∪ the one learned on this machine
(`<dataDir>/state-graphs/<facility>.json`, written when an AI-intervention proposal is accepted). The key is the **facility**, not the
sourceId — states are a site-level matter (`xhs/results` holds for xhs-search, xhs-home and xhs-detail alike).
An id collision between any two layers is always an error. The division of labor among the three layers and the reasons are in spec
`internal design record` §9.1; assembly and runtime behavior are in
`docs/ENGINE.md` §6.

**How to pick features, how to verify, and how a learned state is promoted into the package**: see the `write-recipe` skill
(the section "Writing `states.json` for a package" in `references/authoring.md`).

---

## 3. Slot: code (`stream.code` + `activate(ctx)`)

A package with code **declares for itself what it contributes**; the host only hands over the context and receives the result. The host does not know the constructor of any package.

### 3.1 Declaration: `stream.code`

```json
"stream": {
  "id": "alist",
  "code": {
    "entry": "dist/index.js",
    "adapters": ["alist"],
    "normalizers": ["alist"]
  }
}
```

- `entry` — the module that exports `activate` (relative to the package root). The user layer accepts only the literal `dist/index.js` (§6.4); builtin packages write it the same way
  (the copy on npm needs it), but the builtin layer's loading does not read it — the static table in `packages/index.ts` points directly at `./<pkg>/activate.ts` (§3.3).
- `adapters` / `normalizers` — the **complete set of names** this package registers.
- `enrichers?: string[]` — the complete set of names for `GET /api/enrich?source=<name>`; a name that collides with another package's, or with the host's own
  `/api/enrich` branch names, is rejected.
- `connect?: string[]` — the complete set of domains for `POST /api/credentials/<domain>/connect` (case-insensitive); every domain **must**
  also appear in this package's `credentials`, and if two packages declare the same domain, loading throws (same as the §3.4 name-collision rule).

**Why the lists must be explicit**: name collisions must be rejected **before any package code is executed**. Once `import` happens and `activate` is called, the package's code is already running in this process — discovering then that "this name is taken by someone else" is too late; the damage is done. So "who may register which name" can only be decided by the **static** list in `package.json`, not by "run it first and see what it returns". The list and the keys `activate` actually returns **must match character for character**: the difference between the two sets (returned but not declared, declared but not returned) throws an error, and declared-but-missing is likewise an error — otherwise a name that quietly stops being registered shows up as "some source suddenly cannot resolve its adapter".

**A package can hand over an Adapter that replaces a builtin fn.** The host's `builtin` adapter is a registry of in-process functions
(`BuiltinFn(input, params, context)`); for a package to move one of those entries into its own home, it hands over an **`Adapter`**
(`src/adapters/types.ts`: `id` / `init` / `fetch(params, manifest, context)`), and the manifest's `adapter`
names this adapter instead of `builtin`. **The input shape changes**: on the `resolveEngine.fetchSource` path,
the subscription key is poured by `buildParams` into the parameter named by `manifest.key_param`, so the adapter reads
`params[key_param]` (e.g. `key_param: input` ⇒ `params.input`), not the first positional argument.
Example: `packages/netease/lyrics.ts` + `packages/netease/manifests.yaml`.

### 3.2 Contract: `activate(ctx)`

```ts
export const activate: ActivateFn = (ctx) => ({
  adapters: { alist: new AlistAdapter(ctx.config.url as string | undefined, ctx.config.token as string | undefined) },
  normalizers: { alist: alistNormalizer },
})
```

A synchronous function that returns `{ adapters?, normalizers?, actions?, enrichers?, connect? }`; the keys are the registration names. Normalizers are registered in place by the loader into the global registry; adapter instances are **handed back to the caller** (bootstrap uses them to fill the adapters Map, and a source is routed to one by the manifest's `adapter` field — the package's resolve / fetch-url / comment members all ride the same instance to hit the container, and the host never takes any adapter from a list for its own use). For `actions` see §3.4.5; for `enrichers` / `connect` see below.

#### `enrichers` / `connect`

- `enrichers: Record<name, (query, signal?) => Promise<unknown>>` — the host exposes it on **two surfaces**: when HTTP `GET /api/enrich?source=<name>&…` hits, the whole query bag is handed over and the return value is sent as JSON as-is; when the WS command `enrich.open { source, params }` hits, `params` is handed over and the result is split into `enrich.article / comments / completed` chunks pushed back (protocol in `docs/API.md`, "Handlers handed over by packages"). Parameter validation belongs to the package: an invalid parameter throws `ValidationError` (`shared/package-sdk/errors.ts`; the host identifies it by the duck-typed marker `validation: true`, not `instanceof` — see §3.7) → HTTP 400 / WS `enrich.failed`; `RecipeBlockedError` (rate limit / login wall) → WS `enrich.blocked`; any other exception → 502 / `enrich.failed`. The second parameter `signal` is the cancellation signal for when the caller abandons this result (fired on the WS surface when a new click replaces the same source; not passed on the HTTP surface); an enricher that does not read it stays compatible.
- **`Content.enrich` — the normalizer tells the frontend "where to fetch the rest on demand when this is opened".** The optional field `enrich?: { source, params }` on `Content` (`src/content/types.ts`) is written by the package's normalizer at harvest time; `source` must be a name declared in this package's `code.enrichers` (not validated at load time — a normalizer is a pure function, and a wrong value shows up as a 400 / `enrich.failed` when the frontend opens it: loud, not silent), and `params` are all strings. The frontend's `enrichParamsFor(item)` **looks at it first** and, if present, uses it as-is for the call; only otherwise does it fall through to the host's own few checks. An item carrying `enrich` is not auto-prefetched by default (it mostly needs to ride a browser tab to run a recipe once), and is fetched on demand through WS `enrich.open` only when the user really opens it; a package can add `prefetch: true` on it to self-report "this on-demand fetch is cheap: bare off-site HTTP, no tab ridden, no facility budget spent" (the forum-reply kind), and the frontend lets scroll prefetch through on that basis and goes over HTTP request/response — only the package that writes the enricher can say this, so it is the one that declares it, and the frontend does not guess by site name. **The enricher results a package hands over are sanitized uniformly by the host at the load point** (`sanitizeEnricher`: `article.html` and every `comments[].html`, including nested replies), and both the HTTP and WS exits consume the same copy — the frontend does a raw `innerHTML` on these two fields; it trusts the host, not the package. Example: `packages/xhs/normalizer.ts` writes `{ source: 'xhs-detail', params: { noteId, xsec_token } }`, and the enricher in `detail.ts` runs the same-named recipe via `ctx.readSource`. **Same name, different things**: the `Content.enrich` here is the "where to fetch on demand when opened" written on an item; the Provider callsite id `content.enrich` (the `callsites` of the `providers` row in §0.5, the dispatch points `stream_fetch_url` / `GET /api/media/from-url` that paste a link to fetch media) is a different matter, and the two merely collide in spelling.
- `connect: Record<domain, () => Promise<{ stream, extra? }>>` — called once when `POST /api/credentials/<domain>/connect` hits; the host runs `subscribe(stream)` and replies `{ ok:true, id, ...extra }`. The key must appear in `credentials`.

**The comment enricher has a frontend contract; other names are free.** For any video carrying `(provider, vid)`, the frontend always requests
`source=<facility>-comments&vid=…` (`enrichParamsFor` in `app/src/lib/enrich.ts`), and when paging it sends the `cursor` returned by the previous page
back as `page` (`app/src/lib/preload.ts`). So the comment enricher of a video-platform package **must** be named
`<facility>-comments`, accept `vid` (+ optional `page`), and return the `Enrichment`-shaped
`{ comments: Comment[], total, cursor?: string | null }` (`src/content/types.ts`; `cursor` is the cursor string for the next page —
a page number or the site's numeric cursor both work, and the frontend only passes it back as-is — **`null` or absent = there is no next page**, and the frontend treats the two spellings identically
(`packages/bilibili/` gives `null`, `packages/Douyin_TikTok_Download_API/` simply omits the key on the last page); the detail panel relies on it to decide
whether "load more" is shown). A misspelled name does not show up as an error but as the **frontend failing to find it**:
the request falls into the host's own branch and returns `400 bad enrich request`. Other enrichers (uploader, user profile…) can be named freely,
receive the whole raw query bag, and have their return values sent as-is as well.

Both are declared in `stream.code` (§3.1), the lists match the returned keys character for character, and name collisions are hard-rejected at load time (§3.4). Example: `packages/bilibili/`.

`ctx` (`PluginContext`, `src/packages/activate.ts`) has exactly seven members, and **this is the only door through which a package reaches the host**:

| Member | What it is |
|---|---|
| `backendUrl(service?)` | The reachable address of the backend service this package declares. In the compose tier it is container DNS, in the host tier a random loopback port — the difference between the two tiers is managed by the host's resolver, and the package should not know about it. A package without a backend gets `undefined`. |
| `withAwake(service, fn)` | Standby wake-up: if the container is asleep, wake it first, then call. |
| `cookieFor(domain)` | The Cookie header for that domain. **Only domains declared in this package's `credentials` are allowed**; any other **throws** (it does not return `undefined`) — silently returning empty would make the package think "this domain has no login state" and take the degraded path, ending up as an inexplicable harvest failure whose real cause (one missing declaration line) is nowhere near the scene. |
| `login(facility)` | **Log this facility back in**: the host finds the recipe with `meta.login` for it, runs it in the user's own Chrome, and after it finishes **fetches a fresh cookie from the browser and then overwrites the in-memory cache** (two layers, see §3.4.6). It returns on success and throws on a failure at any tier (including "this facility has no login recipe"). **The callsite is the "establish the session" step, not around the whole action** — the host deliberately does not do "rerun the whole thing on failure" for the package, because whether rerunning an action is safe is known only to the package, and rerunning an action that has already half-placed an order means placing the order twice. See §3.4.6. |
| `readSource(sourceId, params, { signal? })` | **Run one source this package itself declares** (recipe / manifest) and get back the raw items before normalization. A bare name is qualified by the package's npm name (`'x-detail'` → `<npm name>/x-detail`, the same rule as recipe `meta.uses`; the check is in `src/packages/read-source.ts`); a full name containing `/` must start with this package's prefix, otherwise it **throws** — a package must not use `ctx` to run someone else's recipe, as that would bypass that package's rateLimit and ledger. **It carries no `userInitiated`**: package code is not a user's on-the-spot click, so action recipes (`meta.action:true`) are still gated on this path as usual; actions triggered by a user click go through `POST /api/recipes/action`. A recipe with a `locate` step does not need `ordered` passed in; at run time it is filled from the feed ledger by facility (§2 Ledger). |
| `log(msg)` | Logging prefixed with the package id. |
| `readArticle(url)` | The body text of a public web page (the host's Defuddle extraction, the same implementation and the same cache as `/api/enrich?source=link`); returns `null` if nothing can be extracted. It carries no login state and anyone can use it — **do not bring a second body-text extractor into a package**. The returned html is not necessarily clean: the enricher results a package hands over are sanitized uniformly by the host (§3.2). The SDK mirrors `ArticleContent`, with the two-way guard `plugin-sdk-compat.test.ts`. |
| `config` | Deployment config resolved by the host and distributed per package. **A package does not read config.yaml / env / settings itself** — where config comes from and how it is resolved is the host's business. |

Adding a field to `ctx` = adding an entry to "what all packages can do"; before adding, ask whether this should be given to all packages.

### 3.3 How builtin packages are loaded

`packages/index.ts` holds a **static import table**:

```ts
import { activate as alist } from './alist/activate.ts'

export const BUILTIN_ACTIVATIONS = new Map<string, ActivateFn>([
  ['alist', alist],
])
```

Literal `import`s — so esbuild can bundle them into the release bundle and tsc covers them all. **Adding a builtin package with code = adding one line here.** Declaring `code` but not being in this table **throws** rather than being skipped: missing the import table shows up as "some source suddenly cannot resolve its adapter", which is silent and extremely hard to trace.

Loading has two stages (`activatePackages`): first the lists of all packages with code are **checked in full** (name collisions, already-occupied normalizer names, missing import-table entries), and only when everything passes does it call `activate` one by one.

### 3.4 Name collisions are always hard-rejected, never overridden

When an adapter name or a normalizer name collides — whether two packages collide with each other, or one package collides with an already registered name — **neither is activated, and an error is thrown directly**. Allowing override would let one package silently replace another package's implementation, which is a supply-chain attack surface. (Two layers with the same npm name — code, recipe, manifests, declarations — are handled by installing only the layer with the higher `version`, as a whole package; that is "two versions of the same package" and is a different matter from two different packages colliding on a name, see §0.5.)

### 3.4.5 Actions: the third thing `activate()` hands over

```ts
export const activate: ActivateFn = (ctx) => ({
  actions: {
    // global name = `<package id>:<key>`, e.g. `eastmoney:repo`
    repo: async (params) => await doIt(ctx, { live: params.trading === true }),
  },
})
```

A **user scheduled task** can point its executable at this name (`UserTaskRow.action`, mutually exclusive with `command`).
The contract is in `src/tasks/package-actions.ts`, and the authoritative design is in
`internal design record`. Four key points:

- **A package provides actions, not scheduling.** When to run, whether to run, and which account to use are all matters of the user's task row
  (it lives in the db, is edited in the UI, and needs no restart). The check is the header comment of `src/tasks/task-store.ts`: operations tasks stay in code,
  **business tasks go into the database**. If a facility needs the host to write a `case` for it in `configForPackage`, the slot
  was not designed right.
- **Parameters come from the config row bound to that task** (`configRef`), not from argv / env — `GET /api/tasks` echoes
  the whole row, and a value that went into argv enters the task list and `ps` in plaintext. And they are fetched **at call time**: once the user edits that cell,
  the next round should use the new value; a stored snapshot shows up as "I changed it and nothing happened", with no error.
- **An action cannot reach the host's internals.** The signature has only the parameter bag; everything else relies on the `ctx` closed over by `activate(ctx)`.
  To add a new capability, add a member to `PluginContext` (and answer "should this be given to all packages"), rather than stuffing it into the signature.
- **No declaration needed.** Adapters / normalizers must be declared in `stream.code` because they are registered into a global namespace,
  and a name collision must be confirmed before execution. An action name is prefixed with the package id, and the id of a package with a code slot is globally exclusive — collisions are impossible.
  A mistyped name is rejected on the spot by the write route (`GET /api/tasks` also returns the selectable action names); if it is not found at run time it **throws**
  rather than being silently skipped.

**Do not add a "dangerous / costs money" declaration to tasks.** `ScheduledTask` once had a field `effect`, which has been removed,
because no backend consumed it — a wrong value raised no error, yet readers assumed it governed something. Guardrails for real money are pinned in the action's own
implementation, and must be executable: a time-window cutoff, a dry-run tier, and the whole task marked red if any single order fails. "Whether to really place orders"
is likewise not a label; it is a field in that task's config row (default false — "forgot to configure" must equal "do not place orders").

### 3.4.6 Login state lost: the package speaks up, the host logs in

A package that needs login state (one that goes through `cookieFor`) will sooner or later hit "session expired". **The host provides the mechanism; the package decides where to use it.**

A recipe declares itself as the login entry of some facility:

```jsonc
"meta": {
  "action": true,          // login implies action: logging in creates a session and kicks out logins on the same account elsewhere
  "login": true            // ← this field
},
"session": { "facility": "eastmoney", … }   // ← the host indexes by this
```

At the **establish-the-session** step the package catches the expiry, calls `ctx.login(facility)`, and then redoes only the session-establishing segment:

```ts
const open = async () => await openSession(await ctx.cookieFor(DOMAIN))
try { return await open() }
catch (e) {
  if (!(e instanceof SessionExpired)) throw e
  await ctx.login('eastmoney')   // host: find the recipe → run it → refresh the cookie snapshot
  return await open()            // establishing a session has no side effects, so redoing it is safe
}
```

Three boundaries, each plugging a concrete hole:

- **The retry wraps only the segment without side effects.** The host does not do "the action failed, rerun the whole thing" for the package — whether that is safe is known only to
  the package. Automatically rerunning an action that has already half-placed an order means placing the order twice.
- **Retry only once.** If it is still expired after logging back in, the problem is not the session (risk control, site maintenance); logging in again only hits the
  login endpoint one more time, and "consecutive failed logins" has consequences on some sites.
- **Look up by `meta.login`, do not guess "this facility happens to have only one action recipe".** The check must have a name:
  the guessing approach silently changes its target the day the package gets one more action recipe, logging into a different account, with no error anywhere. If more than one
  matches → the host throws instead of picking one.

The host half is in `src/credentials/facility-login.ts`, and the wiring is in the `auth` domain (it owns facility login state,
and the packages domain cannot inject `sources` — `sources` itself injects `packages`, which would be a cycle).

**Fetching the cookie after the run has two layers, and missing either one shows up as "login succeeded but still not logged in"**; both layers have really bitten:

1. **First ask the browser for one** (`cookiePuller.pull`). At the moment the login recipe finishes, the fresh cookie exists only in the browser,
   and the local snapshot is not updated until the extension pushes it over — rereading only the local copy is **reading oneself**. Measured: the task started at 03:44:17,
   the cookie file was written to disk only at 03:45:01, and the retry in between got the copy from before the login.
2. **Then overwrite the in-memory cache** (`cookieProvider.refresh`). `CookieProvider` has a separate 60-second TTL,
   so the disk is new while memory is still old. The measured symptom is "it fixes itself after a minute".

### 3.5 Why the four host pieces do not take this path

The adapters Map in `src/bootstrap.ts` holds only `builtin` / `rsshub` / `replay` / `browser`. Their construction depends on **host infrastructure** such as transport / ledger / sessionFetch / `ensureHarvestBrowser` — they are the host's own things, not some facility's adapters. They continue to be wired by hand and **never enter the public surface** (`ctx` will not have these handles either). The check in one sentence: if a piece needs anything beyond the seven `ctx` members to be built, it is not a package.

### 3.6 Turn a package off, and the implementations it provides disappear together

After the user **turns off a video-platform package** on the "Packages" page, its `*-resolve` source, the member of the `<platform>-video` row in `providers[]`, the comment enricher and connect all disappear together — the manifest, implementation and row declaration all live in the package, and the host has nothing that covers for it. From then on `GET /api/media/play?platform=<platform>` loudly returns `502 { error: 'unresolved' }` (no row serves this key, and `detail` is not carried), and `/api/enrich?source=<platform>-comments` returns `400 bad enrich request`. This is deliberate ("I turned this platform off"), not a bug; the loud error is deliberate too — silently passing an undefined implementation would make it crash only at some later playback, far from the scene.

### 3.7 What a package may import: types, `shared/package-sdk`, `ctx` — only these three

A package with code is bundled by tsdown into one **self-contained** `dist/index.js` (§3.8), and every runtime import in the reachability graph of `activate.ts`
is **copied** into that artifact. Copying pure functions is harmless; copying anything else is a silent fault, so there are only three rules:

| What you need | Where to get it | Why |
|---|---|---|
| **Types** (`Adapter` / `Normalizer` / `SourceManifest` / `Enricher` / `ConnectFn` / `Content` / `Media` / `VideoResolved`…) | `import type` from the host `src/` (`import type { Adapter } from '../../src/adapters/types.ts'`) | Erased at compile time, so it is not in dist. It **must** be `import type`, or every item inside the braces must carry `type` — the mixed form `{ ValidationError, type Enricher }` counts as a runtime import |
| **Pure functions / constants / error classes**: `ValidationError` / `ContentUnavailableError`, `mediaPlayUrl`, `toText` / `extractImages` / `stripImages` / `firstLink` / `extractLinks`, `BROWSER_UA`, `compareVersions` | `shared/package-sdk/` (`import { ValidationError } from '../../shared/package-sdk/index.ts'`; third-party authors get the same set from `@streamapp/plugin-sdk`) | The host and the package **consume the same source**, so inlining it into the package's bundle is harmless. Error classes carry duck-typed markers (`validation: true` / `unavailable: true`), and the host looks only at the marker (`isValidationError` / `isUnavailable`), never `instanceof` — so a copy thrown from inside the bundle is still recognized as 400 / 404 |
| **Host singletons / stateful things**: container address, standby wake-up, cookie, login, running this package's recipe, logging, config | `ctx` (the seven members in §3.2) | Copying a singleton creates a second table: the package registers into the copy while the host looks at the original, which stays empty forever. The segment trust table is this kind — the package does **not** register; it only hands over `headers` on the `DashResult`, and the `/api/media/dash` route calls `rememberSegHosts` itself once it has the result (see below) |

**Any other runtime import from `src/` is forbidden.** The guard `src/packages/self-contained.guard.test.ts` starts from the `activate.ts` of every package with code and
walks along relative imports (following into `shared/` as well); a hit turns it red. To use some host function: if it is pure, move it into `shared/package-sdk/`
(and have the host import it from there); if it is stateful, add a member to `ctx` (first answer "should this be given to all packages").

**`DashResult.headers`** (`src/video/dash.ts`): after a package resolves a dash stream, the request headers to carry when fetching segments (for Bilibili, `Referer` + `Cookie`)
go in this field; **default = carry no headers**. The route registers all stream URLs together with this headers into the segment trust table, and the segment proxy takes headers by host. A site whose CDN lets requests through by Referer / Cookie
and that leaves this unfilled shows up as the MPD parsing successfully while every segment returns 403 — the player keeps spinning, and the log shows only the CDN's 403.

### 3.8 Build and release

The builtin layer **loads from source** (the static table in §3.3), while the copy on npm is the **precompiled artifact** — the same package in two loading forms, which the package code does not perceive.

**Build**: each package with code has one `tsdown.config.ts` (a bare object, no `import 'tsdown'` — the package directory has no node_modules,
and this file is in the root tsconfig's include):

```ts
export default {
  entry: { index: 'activate.ts' },   // the key name is the artifact name; written as an array it would emit dist/activate.js, which the loader cannot find
  format: 'esm',
  outDir: 'dist',
  dts: false,                         // no consumer: the artifact is only dynamically imported by the backend at runtime
  noExternal: [/.*/],                 // shared/** is all inlined; if chunks get split, let it fail at build time
  clean: true,                        // the previous generation's artifacts would enter the tarball via files: ["dist"]
}
```

- **`pnpm packages:bundle`** (the root script `scripts/bundle-code-packages.mjs`): for every package in `packages/*` that fills `stream.code`,
  it runs the root `node_modules/.bin/tsdown -c tsdown.config.ts` with the package directory as cwd, and the whole run fails if any package exits non-zero or `dist/index.js` is missing / empty.
  Passing directory arguments builds only those (a package's own `pnpm bundle` passes `.`). The check is whether `stream.code` is present, not a hand-written list —
  missing one shows up as the package, once published to npm, having `code.entry` pointing at a file that does not exist.
- **`STREAM_TSDOWN_BIN=<path>`**: borrow a tsdown from elsewhere (in a worktree, borrow the main checkout's when the root dependencies have not been refreshed). If neither place has one, it exits 1 with an install hint,
  and does not silently skip.
- `dist/` is in `.gitignore`; `packages/index.ts` does not read it.

Builtin packages with containers (alist / pansou / Douyin parser) are not published to npm today: third-party container clamping (the service is assigned by the host, `mem` must be written, id grammar)
and "should a user-layer container package with the same name replace or coexist" have not been designed yet, so they stay `private`, and the build chain still emits dist for them to have ready.

**The shipping shape of `package.json`** (the same for all 4 publishable packages):

```json
"files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
"scripts": {
  "bundle": "node ../../scripts/bundle-code-packages.mjs .",
  "prepack": "node ../../scripts/assert-npm-artifact.mjs"
},
"stream": { "code": { "entry": "dist/index.js", … } }
```

Do not write `private` (it is to be published to npm); do not write `repository` / `homepage` (the repository is private, so they are dead links externally, and the gate rejects them); the README must not contain relative paths pointing into the repository's
`docs/` (same reason). The absence of `manifests.yaml` / `README.md` is not an error — a package that only does actions naturally has no Source manifest.

**The `prepack` gate** (`scripts/assert-npm-artifact.mjs`, which `npm publish` / `npm pack` must run): `stream.code.entry` exists on disk and is non-empty;
`dist/` contains **only** it (split-out chunks, sourcemaps and leftovers from the previous generation are all rejected — the user-layer install gate recognizes only the single file `dist/index.js`, and one more file gets the whole package rejected);
every entry of the `npm pack --dry-run` listing passes the install gate's whitelist (borrowing `scripts/recipe-release-plan.ts --check`; the check is that one install-gate function
`isAllowedPackageFile`, not copied separately). Hanging it on `prepack` rather than only writing it in a workflow ensures that people who bypass the workflow and publish by hand are blocked too.

**Release** (CI `release-recipes.yml`, `scripts/recipe-release-plan.ts --publish`): publishable = has a `name`, is not `private`, and
fills the recipe slot **or** the code slot. For each publishable package it queries `npm view <name> versions`: **the name already exists on npm** (any version; only an explicit
E404 counts as absent, while being offline / rate limited / an auth error turns the pipeline red) **and this version is not yet published** → for packages with code, bundle first and then pass `assert-npm-artifact.mjs`,
then check the whitelist and run `npm publish --access public`. **CI does not act for packages not on npm** — the first publication is a human action (which packages go public is a business
decision), and at decision time it prints one line "first publication needs a human: `cd packages/<x> && pnpm bundle && npm publish --access public`". After the first publication, CI
takes over subsequent versions: change the code or recipe → bump `version` → merge into `main` → publish.

**Same name in two layers**: if the user's `stream add @streamapp/<x>` installs a version higher than the builtin one → the user layer wins as a whole package (code / manifests / recipe /
declarations) and the builtin copy is skipped as a whole (log `supersedes builtin`); equal or lower → the builtin wins and the user layer is skipped as a whole. The rule and the log are in §0.5.

---

## 4. Slot: container (`stream.backend`)

For a package that declares a `backend`, its backend container is **hosted** by Stream, using the **image the facility publishes itself** (Stream **never** repackages it). Example: Douyin_TikTok_Download_API → `douyin-tiktok-download-api`. All containers sit on the shared `stream` network and reach each other through **same-network DNS** (`http://<service>:<port>`); no ports need to be published to the host machine.

For the full set of `PluginBackend` fields see "Appendix: current shape cheat sheet"; for how to bring the container **up** see §7.

> ⚠️ **A backend container can only be brought up through the generated compose or host takeover** (§7). **Do not** hand-write `docker run` / `docker build` for a plugin backend — the backend is **declared** in `stream.backend` of `packages/<id>/package.json`, and the generated compose attaches the `stream` network, healthcheck, volumes and memory limits uniformly. Hand-rolled docker commands bypass all of that and are wrong.

**A package that only declares a container, with no Source and no credentials, does not live in the built-in layer** (§5.9.6): these are optional packages, with source and manifests in
`github.com/JaggerH/stream-packages` (one directory = one Dockerfile + one `package.json#stream.backend`;
the tag `<name>-v<version>` pins both the ghcr image and the npm manifest). There are four today: `@streamapp/ddddocr` (captcha recognition, used by the
`call` step of a recipe), `@streamapp/dewatermark` (watermark removal for generated images), `@streamapp/mineru` (document parsing, GPU), and
`@streamapp/voiceprint` (speaker diarization, GPU only). The user runs
`stream add @streamapp/<x>`; the container is only built by host takeover when `manage_containers: true` (§7.2), and GPU packages need the
nvidia container toolkit. On the stream side only consumers remain, and every consumer must have a named fallback for when the package is absent: the `ocr-mineru`
ladder member does not light up; speaker naming falls back to anonymous segments (`identify_speakers` is not registered); image generation comes back watermarked and, if the dewatermark address cannot be resolved,
the request returns 503 with a hint to run `stream add @streamapp/dewatermark` (it never silently returns the watermarked image — that would be used as a finished product);
if the `service` named by a recipe `call` step cannot be resolved, that step fails hard (`call-service.ts`, which has always had this semantics).

### 4.1 Invariant: containers are disposable; state worth keeping must be declared as `volumes`

**For a package that declares `backend`, everything that must survive a restart has to be written into `backend.volumes` (`name:/absolute-path-in-container`). When the image and the declaration disagree, the host deletes the container and rebuilds it from the new declaration, and everything in the container's writable layer is lost.** Volumes are unaffected — the container is removed with a remove that does not carry `v`, so the named volume stays on the host as it was and is mounted back under the same name after the rebuild.

The criterion is "how long does this data live inside the container", not "does it look important": a config database the facility writes under the image's default path, downloaded model weights, a generated index cache — as long as you do not want users to reconfigure or redownload it after a package upgrade, it needs a volume. Read-only repository files use a host bind mount (only built-in packages may; a host bind from a third-party package is clamped and rejected at install time, see §6).

The built-in packages show the current practice: alist's config lives at `alist-data:/opt/openlist/data`, and douyin / pansou are stateless; among the optional packages, ddddocr / dewatermark are stateless, and mineru / voiceprint each have their own volume for the model cache (volume names at the user layer carry a package prefix, such as `mineru_mineru-cache`, see §6.2).

**A newly created named volume is owned by root.** If the image runs as non-root and its entrypoint only checks whether the data directory is writable without chown-ing it (OpenList running as UID 1001 is exactly this case), the container exits immediately on a brand-new volume, with a single log line `does not have write ... permissions for the ./data directory`. Such images declare `user: "0:0"` (numeric `uid` or `uid:gid` form) in `backend`; both the compose generator and host takeover pass it through identically, and the container starts as root. This field is **for built-in packages only**; third-party declarations are always rejected (§6.2).

### 4.2 Capability backends and the sharded Job skeleton

Some plugin backends are not content sources but **Provider capabilities** — model services such as ASR / diarization (speaker separation) / embedding /
docparse (for example `voiceprint`=sherpa-onnx). This kind of backend has one
extra **hard invariant**:

> **A container endpoint must be second-scale, stateless, and replayable** — the compute of a single request is measured in seconds (no long computations); the response body is the **only**
> exit for the result, and the container itself writes nothing to disk and keeps no intermediate results (no result storage); the same input can safely be resent (replayable).

**Why**: undici's default `headersTimeout` is a 300s ceiling, and the container must finish computing before it sends response headers, so a long computation blows through it;
and a container should not hold persistent state — the premise of this system is that standby can casually stop an idle container, and once a container has state, stopping it means
losing results, so "casually stopping" is no longer safe. So the result of one request lives only for the instant of that one TCP response, and the container itself must be a pure compute unit that can be
restarted and replayed at any time.

**Who slices the long work and who assembles it** — the division of labor sits in the **backend (the Stream side)**, not in the container:

- **planner**: cuts one long input into pieces that can each be computed within seconds (time windows, page numbers, overlap sizes are defined per capability).
  Example: `planAudioWindows` in `src/media/audio-windows.ts` cuts the extracted audio track into 120s windows (10s overlap).
  `planSttChunks` in the same file is its sister planner, serving the cloud STT members (Groq/OpenAI Whisper, which go through an API, not a container):
  it compresses to 32kbps m4a; a single chunk of ≤24MB is uploaded directly, otherwise it is cut into 600s chunks with **no overlap** (overlap would duplicate transcribed text at the seams),
  and assembly shifts the time axis by `startS` and concatenates (see `internal design record`).
- **per-piece short calls**: hit the container endpoint (such as `/diarize`) once for each piece, and the container only sees that piece.
- **assembler**: assembles the per-piece results back into one overall result (cross-piece dedup / merge / concatenation, with semantics defined per capability).
  Example: `mergeWindows` in `src/voiceprint/windowed.ts` merges the local speakers identified independently in each window into global speakers using global
  average-linkage agglomeration (no window order; anchors take part in clustering, fragments attach to the nearest cluster), and dedups by the midpoint of the overlap region.
- **ledger**: `CapabilityJobStore` (`src/jobs/store.ts`) hangs off `ConversionRunner`
  (`src/conversions/runner.ts`) — the conversion-type capabilities (OCR / transcription / filling in speakers / summarization) share this one ledger,
  which handles queuing / checkpoint resume (after a restart it continues from the completed pieces; it does not retrieve results — the container is stateless, so the only recovery form is "rerun") /
  reclamation (done rows are deleted immediately, error rows are kept for 7 days, and on startup orphans **older than 24h** are marked error, while orphans within 24h go through checkpoint resume
  rather than being marked error directly). The piece files of each conversion are written under the `ctx.jobDir` that the runner supplies.

**Worked example: voiceprint** (an optional package; container source in `stream-packages/voiceprint/app.py`) — its `/diarize` is a single-window pure function that
analyzes only one audio segment at a time; anything longer than `VOICEPRINT_MAX_SINGLE_S` (default 300s) is rejected outright (413), handing the judgment of "this segment is too long"
back to the caller instead of toughing it out inside the container until OOM. Cross-window slicing (planner) and cross-window speaker merging (assembler) both live
on the TS side; the container itself does not know, and does not need to know, whether it is part of a windowed call. For the full design see
`internal design record`.

---

## 5. Slot: credential domains (`stream.credentials`)

### 5.1 There is only one direction: the host dispatches, the package does not ask

**The host is the only scheduler.** A package does not initiate calls — when handling a request, the host decides whom to ask for what, and then hands the package **the one piece
needed for this call**. The adapter is that compatibility layer: it runs inside the host process, the credentials are injected by the host, and it passes the
necessary part along with the request to its own container.

```
user/scheduler → host → (fetch cookie) → adapter (in-process) → plugin container
                                      ↑ host injects          ↑ passed down with the request
```

**The declaration (`stream.credentials`) is an allowlist, not a data-fetching path.** It answers "which domains' login state the host may hand to this package", and the gate is `makeCookieFor` in `src/packages/activate.ts` — `ctx.cookieFor`
only lets through the domains that were declared and throws on the spot for everything else (returning undefined silently would make the package take a degraded path, which ultimately shows up as an inexplicable
harvest failure, with the real cause a long way from the scene). Domain comparison is case-insensitive.

**An allowlist is not a needs list — both must be written.** `credentials` only says "the host **may** give me this domain";
"**go and fetch this domain from the user's browser**" is another field: **`auth` in the manifest / recipe** (`requiredCookieDomains`
derives the sync-domain list pushed down to the extension only from it and `config.session_exports`, see §5.2). A package that only writes
`credentials` passes the `ctx.cookieFor` gate, but the snapshot contains no cookie for that domain at all — **it looks exactly like
"the user is not logged in", and nothing anywhere complains**. Eastmoney (东财) tripped on this (2026-09-03, `3efad7a1`): its login domains were only held up by accident by an old block in
`config.yaml` that was configured for something else. For how to write it on the recipe side see
`.claude/skills/write-recipe/references/recipe-template.md` section 「`auth` 不是装饰」 ("`auth` is not decoration").

`auth: cookie` is **hard**: if it cannot be resolved it throws an actionable error (loud, isolated per stream), and does not silently degrade into an empty feed;
there is no "optional cookie" type — silently returning empty is exactly its nastiest failure mode.

> **Do not introduce a path where "the package asks the host for credentials"** — the shape is a credential broker: `GET /api/credential`,
> with the container knocking on the door in reverse carrying its own `STREAM_CREDENTIAL_TOKEN`.
>
> **The direction is backwards**: it conjures a long-lived secret that sits permanently in the container's environment variables, and it buys nothing the host could not already do —
> the host already knows which domain's login state this call needs. The cost is real: that secret has to be written into the generated
> `docker-compose.yml`, and that file gets `cat`-ed and accidentally committed (that compose was in fact once tracked by git).
>
> The only scenario that seems to need it is "a third-party package that is only a container, with no code" — when the host forwards generically, it does not know that package's API shape,
> so it cannot stuff the cookie in. **This scenario does not exist under the product's stance**: anything brought in is always given an adapter layer, which is precisely why the adapter
> exists.

**`credentials` may only contain concrete site domains** (`douyin.com`, `pan.quark.cn`). Single labels (`cn`) and public suffixes
(`com.cn`, `co.uk`) are rejected by the descriptor validation, and the package cannot be installed at all — because cookies are fetched by **suffix match**, so declaring one
suffix = declaring the login state of every site under it, which hollows out the allowlist boundary.

**The generated compose contains no credentials at all** (a guard in `src/plugins/cli.test.ts` and one in `src/plugins/compose.test.ts`
each pin this). Container env holds only non-secret configuration.

The cookie itself is fetched by `CookieProvider.cookieString(domain)` (it assembles a `name=value` header by domain-suffix match),
and is only called inside the host process. **What sits behind it is decided by §5.2; the caller does not need to know.**

### 5.2 Where login state comes from

**Default: the backend fetches it from the user's Chrome itself, with zero containers.** The backend sends `op:'cookiePull'` over the relay, the extension returns the
cookies for those domains, and the backend writes the whole set into `data/cookies.json` (0600). There is no third-party process anywhere on this path
— the extension and the backend already talk to each other directly (ext-relay has a token, and human-like harvest goes through it the whole time), so the cookies have no reason to take a detour.

**Why the backend pulls, instead of the extension pushing on a timer**: only the backend knows when login state is needed — this round is about to harvest, how old
the copy in hand is, whether it just got a 401. The extension knows none of these, so it can only guess by time, and the cost of guessing is
**waiting out a whole cycle after cookie rotation** (Quark `__puus` expires → every stream fetch during that time returns 412). The scheduling authority for fetching
must sit on the end that knows "when it is needed".

- **Three pull moments** (wired in `bootstrap.ts`, implemented in `src/credentials/cookie-puller.ts`):
  as soon as the relay connects (Chrome has just started and the snapshot is oldest) / before each harvest round starts if the snapshot is older than 5 minutes / when the extension reports
  "a cookie in the sync domains has changed". **There is no periodic timer** — do not add one, for the reason above.
- **The scope gate is on the extension side, not in the backend**: the extension only answers the sync domains it has itself declared (user-entered ∪ the backend-pushed
  `requiredDomains`), and returns anything outside that scope as `refused`. If the requester sets the scope itself, there is no scope.
  A non-empty `refused` must be raised loudly as a configuration problem — it looks exactly the same as "the user is not logged in".
- **Always pull the full set, never "just the ones that changed"**: because the write entry is a **whole-set replacement**. Writing only the changed ones would require switching to per-domain
  merging, and merging would let domains the user has logged out of linger in the snapshot forever as zombies.
- **No encryption.** The backend is the consuming end and already holds plaintext cookies when it harvests and sends requests; decrypting its own encryption would just put the key and
  the ciphertext in the same directory. Manage it with file permissions (0600). **Do not add encryption back.**
- **The snapshot must be kept**: when Chrome is closed nothing can be fetched (reading its cookie file is a dead end — App-Bound Encryption
  plus an exclusive lock), and harvest runs on a schedule, so the round in the middle of the night mostly has no browser. So a failed pull **never clears the snapshot**:
  stale login state, however old, beats none; clearing it would amplify a blip into guest state across the whole site.
- Which domains the extension should sync is pushed down by the backend (`requiredDomains` of `GET /api/ext/sync-config`, derived from **what is installed**,
  see §5.1). This endpoint **pushes down no secrets**, and must never do so — the moment it carries a key, anyone who can reach this
  address obtains the entire cookie store.

**There is only this one source of login state.** The consuming side always uses the same seam, `CookieProvider.cookieString(domain)`,
so if the source ever has to change, the consuming side does not notice.

> **Do not introduce a shape of "point a third-party server at it to pull cookies"** (much less make it a container in the generated compose).
> That machine would become the one dependency on the harvest chain without which the whole site falls into guest state — whereas the plugin containers (pansou / mineru / voiceprint)
> are all optional capabilities, and without them you merely have a few fewer sources. When it is unreachable it fails in the worst way: the cookie fetch fails silently, everything runs in guest state,
> and everything looks normal.

### 5.3 Packaged-out facility capabilities: optional capability packages, with the netdisk as the example

**A capability package is also a Stream package** — it fills the capability slot (`package.json#stream.capability`). The only difference is
whether the capability ships with the distribution or is installed by the user on demand:

| | Built-in capability | Optional capability package |
|---|---|---|
| Lives in | `capabilities/desktop/` (Stream Desktop, `private: true`, shipped inside the backend bundle) | `capabilities/netdisk/` in this repository (npm `@streamapp/netdisk`) or an independently published compatible capability package; installed to `<dataDir>/recipes/<@scope__name>/` |
| Who loads it | The backend statically imports it, and `src/host-agent/mount.ts` hands it to the host | The backend scans `<dataDir>/recipes/` and dynamically imports `dist/index.js` (`src/capabilities/load.ts`) |
| How to install | Comes with installing `@streamapp/stream` | `stream add @streamapp/<x>`, or click install on the components page; `stream remove` uninstalls |
| Where tools come out | All through 8900's `/api/mcp` — the host's line (`stream mcp`) never needs to change | Same as left |
| When it takes effect | With the backend start | **After the backend reloads** (at install time it is only written to disk) |

**The contract of the capability slot itself is in §5.9** (declaration shape, self-containment requirement, the host's seven fields, hard rejection on name collision, mount order,
and the built-in/optional criterion). This section only covers **the four boundaries to follow when a facility capability is packaged out**.

The netdisk (verifying shares / saving / fetching direct links / jumping to the netdisk) is the example capability package (`capabilities/netdisk/`, spec
`internal design record`). To package out another facility capability,
follow its four boundaries:

| Boundary | How the netdisk package does it |
|---|---|
| **There is only one copy of the logic** | Verdicts and data fetching live in `shared/netdisk/`; the Stream orchestration layer and the capability package import the same copy, and at package build time everything is inlined into `dist/index.js` (the installed directory has no node_modules, so any external import cannot be resolved). Do not duplicate it inside the package — it silently drifts. |
| **Credentials are still dispatched by the host** (§5.1 unchanged) | Declare which domains to borrow in `package.json#stream.credentials` (validated by the install gate, named domain by domain on the confirmation page), and at fetch time `ctx.require('streamBrowserCookies')` **fetches on demand every time** — the backend mounts that service in the same process, and cookies are not written to disk and do not leave the process. When the service is absent, verbs that need login state return "failure + pointer to what to do", not a silent empty result. |
| **The two tiers are decided by configuration, not guessed at runtime** | Given `openlistUrl` + a permanent `openlistToken` = external tier (Stream is present: the user gets `<origin>/_p/alist` and the permanent token from `GET /api/netdisk/openlist-access` and writes them into their own configuration), read-only / save / playback, and it does not touch storage admin; when not given = managed tier (the package pulls the container itself through `shared/docker/engine-api.ts`, takes over admin, mounts, and reclaims it when idle). A 48h-JWT-shaped token is rejected outright — the package has no 401 re-login channel. |
| **On the same machine, yield to the host; the criterion is evidence** | On every call the managed tier first checks whether the machine has a container labeled `com.docker.compose.service=alist` (Stream is managing it); if so it does not create a second one, and the reason names that container and points to the external tier. Its own container is labeled `netdisk-openlist` and gets its own volume — standby adopts any container with the `alist` label, and a label collision means two brains fighting over one container. |
| **Write operations are reviewed code** | Saving (writing to the user's drive) is `shared/netdisk/quark/save.ts`, released with the version; the two recipe liveness checks are, in the package, the TS version of the same verdict (the recipe runtime depends on isolated-vm, which cannot be bundled into a capability package). |

"Let the model flip through the drive directly" is not a tool the capability package writes: OpenList ships a read-only MCP (`/mcp`, `fs.list/get/link`), and one line of
`dsh-mcp-client` pointing at it is enough (the handshake takes three steps: `initialize` → `notifications/initialized` → `tools/list`; skip the middle
one and `tools/list` silently returns `null`; `Authorization` carries the permanent token bare, with no `Bearer`).

---

## 5.9 Slot: capability (`stream.capability`)

One capability slot = **one capability at hand** (computer operation, the netdisk, etc.): it hands the model a few verbs, rather than handing
Stream a data source. A package that fills this slot is mounted by the backend **inside its own process**, and the tools it registers go out through 8900's
`/api/mcp`, through the same door as the backend's own tools.

### 5.9.1 Declaration

```jsonc
// package.json
{
  "name": "@streamapp/netdisk",
  "stream": {
    "id": "netdisk",                    // required: package id, unique within the two-layer namespace
    "capability": "dist/index.js",      // exports `capability: Capability`
    "credentials": ["quark.cn"]         // which domains' login state to borrow (optional, §5.1)
  }
}
```

- **The value only accepts the literal `dist/index.js`** (`PACKAGE_CODE_ENTRY` in `src/packages/code-entry.ts`, the same constant as
  `stream.code`; the schema is `z.literal`). Aliased spellings like `./dist/index.js` are always rejected —
  letting aliases through means letting a whole family of paths through.
- **`stream.id` is required**, as with every other package. A package that writes `capability` but not `id` **can never be installed**:
  the install gate throws `stream.id — required` as soon as it parses the descriptor, while the package's own tests, `npm pack`, and the artifact assertions are
  all green — they only ask "is the file there" and none of them parses that manifest (this has really bitten us, 2026-09-06). The
  `package.json` of the two packages in the repository is pinned by `src/capabilities/optional-package.e2e.test.ts` running it straight through
  `parseStreamDescriptor`.
- **Credential domains are declared only in `stream.credentials`**, not on the module. That field goes through the install gate (schema validation + the confirmation page
  **naming each domain** for the user to approve), while module-level properties are only readable after installation — putting it on the module splits "the list the user approved"
  from "the list actually used for syncing" into two copies, and when two copies drift nothing anywhere complains. The domains declared by mounted capabilities are merged into `requiredCookieDomains`
  via `host.credentialDomains()` (the third source), so the extension will go read them.

### 5.9.2 Must be self-contained

The directory installed to `<dataDir>/recipes/<@scope__name>/` **has no `node_modules`**, and the install gate's tarball
allowlist accepts only `package.json`, `README`/`LICENSE`/`NOTICE`/`CHANGELOG`, `manifests.yaml`,
`*.recipe.json`, plus `dist/index.js` as the **one** path containing a `/`; everything else is rejected. So all dependencies must be
bundled into that one file (tsdown `noExternal: [/.*/]`), leaving only `node:` built-ins.

`import`-ing a library that was not bundled in = `ERR_MODULE_NOT_FOUND` at load time, and this package **simply does not take effect this time**, while
the rest of Stream starts normally. **The smoke test must run the artifact, not the source** (`capabilities/netdisk/scripts/smoke-managed.mjs`
is written that way): running the source cannot catch "a relative import was missed in the bundle", and that is exactly what this constraint is most meant to catch.

### 5.9.3 The host's seven fields: how the backend implements them

The contract is `CapabilityContext` in `shared/capability/types.ts`; **the one and only host implementation** is
`createCapabilityHost` in `src/capabilities/host.ts`. The built-in Stream Desktop and the optional packages the user installs
go through the **same** `mount()` — the difference is only in "how the module gets there".

| Field | Backend implementation |
|---|---|
| `dataDir` | `<dataDir>/capabilities/<capability name>/`, **`mkdir` only when read** (lazy getter). Most capabilities never write to disk, and `mkdir` can fail because of permissions / read-only mounts — creating the directory eagerly lets a side effect nobody uses veto the mount of the whole capability |
| `log` | Two methods, `info` / `warn`, with prefix `[stream-<capability name>]` (the built-in one uses `[stream-desktop]`). The log sink defaults to the backend's stdout |
| `require(service)` | An in-process `Map`; if it cannot be found it gives `undefined` (the package degrades on its own and calls `log.warn`; it does not throw) |
| `provide(service, value)` | The same `Map`, **hard rejection on the same name**. A name on the service bus can have only one owner; silently overwriting would hand the consumers of the package that arrived first something they do not recognize, and each side looks fine on its own. The only pair today: the backend does `provide('streamBrowserCookies')` and netdisk does `require` on it |
| `registerTools(defs)` | Goes into the host's tool table; `toolDefs()` feeds it fresh each time to every `createMcpServer()` (`/api/mcp` is **one server per request**, so it is mounted once and registered every time). **Hard rejection on name collision**, see below |
| `destructiveGate` | Always `'host'`: `annotations.destructiveHint` is passed through to MCP as is, and the host (Claude Code / Codex / DSH) itself pops up the confirmation. When a package reads `'none'` it must fail closed and not let things through on its own |
| `onDispose(fn)` | Collected into a list, executed in **reverse mount order** when the backend shuts down, with errors swallowed one by one and logged as one line; when the whole host closes up, the service bus is `clear()`-ed too |

### 5.9.4 Hard rejection on name collision, mount order, failure semantics

- **Tool-name collisions are hard-rejected**, checking two lists **before** entering the table (the defs already collected + the backend's own tool names, the latter being a
  thunk and not a snapshot — the tool surface is computed live by domain availability). It is not "overwrite + log a line": a user can `stream add` any package,
  and a third-party package that names a tool `extract` could displace the backend's verb, with the model only feeling that this tool has suddenly become dumber.
- **Mount order: the built-in Stream Desktop first, optional packages after.** Under hard rejection **the order directly decides who gets rejected** — in the reverse order,
  a user installing a package named `desktop` could displace the Stream Desktop on the machine.
- **When one package's mount throws, log one line and go on to install the next**, without dragging down other packages or the backend; the tools / services / dispose functions it had already
  registered before throwing are **rolled back together** (otherwise the tool surface carries the verbs of a package that was never installed, calls to them are bound to blow up, and
  nothing anywhere says that the package was not installed). The fallback sits at the loader level (`src/capabilities/load.ts`), not in the host
  — the host throws the error as usual, so that "installed" and "blew up while installing" can be told apart.
- **`import` and `mount` each have a 30s timeout.** On expiry the only guarantee is "the loader stops waiting for it" (neither an ESM import nor the package's own
  mount can be stopped), and it goes through the same per-package try/catch.

### 5.9.5 How to install, and when it takes effect

```bash
stream add @streamapp/netdisk        # = preview + install, through the install gate; clicking install on the components page is the same path
stream remove @streamapp/netdisk
```

**After installation there is no hot loading; it only takes effect after the backend restarts** — at install time it is only written to disk. `loadOptionalCapabilities` runs
only once on the startup path, and an ESM module that has already been `import`-ed cannot be unloaded at runtime. The install/uninstall receipts say this out loud,
and **it must not silently fail to take effect** — install reads "the source takes effect immediately; the capability package (tools) only appears after the backend reloads", and uninstall reads "it is only
really unloaded after the backend restarts — already-loaded tools and credential-domain declarations remain until the restart". The wording of both sentences is
pinned by `src/install/add-command.test.ts`; change one and you must change the other place, not just one side.

The load result is visible on the **components page**: each row of `GET /api/packages` has two extra fields — `slots.capability` (the entry path;
the package directory alone has the answer) and `slots.tools` (which verbs this package has registered right now, fetched live at runtime). A package that declares a capability but has
`tools: []` is telling the truth: either loading did not succeed or it registered no tools.

### 5.9.6 What is built-in and what is optional

**The criterion in one sentence: is this capability something "a person who installed Stream should have by default".**

- **Built-in** (shipped with `@streamapp/stream`): pure recipe data packages (a few KB of JSON, zero cost if not subscribed) +
  the core shell (builtin / replay / rsshub) + **Stream Desktop** (computer operation, the only built-in capability today).
- **Optional** (`stream add`, published independently on npm): anything that **carries code, carries a container, binds a third-party service, or charges money**.

**Eastmoney (东方财富) belongs to the paid VIP series and must never go into a built-in package.** It is the first that has to be moved out: when moving it, note that on the dev machine
8900 has its subscription / reverse-repo scheduled tasks hanging on it, so **install it at the user layer first, then remove it from the built-in layer**. For the paid-distribution mechanism see
`project planning record`.

**Packages that only declare a container (ddddocr / dewatermark / mineru / voiceprint) are already in the optional layer**:
they live in `github.com/JaggerH/stream-packages`, installed with `stream add @streamapp/<x>` (start of §4). The install gate does not clamp the sizes of `gpu` and `mem`
(§6.2), so GPU container packages can be installed.

By this rule, what still should be moved out today is the 3 container packages (alist / Douyin parsing / pansou) and Eastmoney — they
carry a Source manifest or code and are not pure container declarations; **move them together when the first one really has to be split out** (container packages take no resources if not started).
For the trigger conditions for moving into stream-packages see `project planning record`.

---

## 6. Distribution and loading: built-in packages vs third-party packages installed from npm

Built-in packages (in the repository's `packages/`, released together with the app) and third-party packages (installed by the user from npm in the UI and placed in `<dataDir>/recipes/<package name>/`) **are the same kind of package with the same `package.json#stream` grammar**. They differ in only two places: **which fields they may fill**, and **which gates they must pass at install time**.

**Installing a package that carries code = trusting its author**: the code runs inside the backend process (with the same privileges as Stream), and a higher version with the same npm name **replaces the code of the built-in one** — this is not the same privilege tier as installing a pure recipe package, and the install page rates it at the highest tier `code` per §6.6.

### 6.1 Which fields can be filled

| Field | Built-in package | Third-party package |
|---|---|---|
| Manifest (`manifests.yaml` / `stream.sources`) | ✅ | ✅ |
| Recipe data (`*.recipe.json`) | ✅ | ✅ |
| Code (`stream.code`) | ✅ | ✅, but the entry path is pinned (see §6.4) |
| Capability (`stream.capability`) | ✅ (today only `capabilities/desktop/`, statically compiled into the bundle) | ✅, the same pinned entry path (see §5.9) |
| Container backend (`stream.backend`) | ✅ declared as is | ✅, but the whole declaration is clamped first (see §6.2) |

### 6.2 The container field: what a third party may declare and what it gets clamped to

A third party's `backend` always goes through `src/packages/container-policy.ts` (`clampThirdPartyBackend`) first: anything non-compliant **throws at install time** (it is not left to runtime), and anything compliant is **rewritten into a safe form** before it is written to disk. **The `package.json` written to disk holds the clamped declaration** — what the user sees on the confirmation page, what the provisioner reads when it creates the container, and what lies on disk are the same bytes. Built-in packages do not go through this (we wrote them ourselves; they are declared as is).

**The sizes of `gpu` and `mem` are not clamped and not tiered by author**: installing a package is already trusting its author (the same stance as dsh plugins); asking for a GPU or
10G of memory is the package's honest declaration about its own image, and clamping them stops nobody and only keeps legitimate GPU packages out. `mem` still **must
be written** (not writing it = no limit, which is an omission, not a choice). The confirmation page surfaces `gpu` (`summarizeBackend`); "it will not start
without the nvidia toolkit" is a prerequisite the package README should state. What remains clamped is only the host namespace and the filesystem boundary: `service` / `dev` / `user` /
`publish` are rejected, env and volumes have upper limits, standby has a fallback, and volume names get a prefix.

**`image` must be pinned to a version (a tag or a digest; `:latest` / no tag is not accepted)** — this is a precondition of the update mechanism, not a trust question:
host takeover only compares the container's `Config.Image` string, and `stream update` swapping the manifest = swapping the tag → judged inconsistent → deleted and rebuilt at the next start
(`provisioner.ts` `recreateOnImageMismatch`). With a floating tag the string does not change after a manifest update, and the container forever runs the
layer it pulled on the day of installation. So **the image version ships together with the package version**: stream-packages pushes the tag `<dir>-v1.2.0`, which simultaneously produces the image `:1.2.0` and a manifest with
`image: …:1.2.0`. After `stream update` finishes it prompts "the container will be rebuilt on the new image after the backend restarts".

**Three fields the host decides on the package's behalf**:

- **The `service` name is assigned by the host and always equals the package id** (a package writing `service` itself = rejected; the package id has its own grammar constraint, see the table below). The service name is a single global namespace shared in three places — the `/_p/<service>` gateway route, the standby roster, and the compose service key; package ids are already guaranteed not to collide at install time, so id unique ⇒ service name unique ⇒ no conflict among the three places by construction. **External shape**: the container is at `/_p/<service>/`. A duplicate name in the roster throws at construction time, but `buildStandbyOrDegrade` in `serve.ts` degrades that into one log line — the consequence is not a failure to boot but **standby failing for everyone** (no plugin container is reclaimed or woken, and the UI says nothing at all), so the load-bearing part is the name-collision gate at install time.
- **Named volumes get a package prefix**: a package writes `data:/var/lib/x`, and the actual mount is `<package id>_data`. Without the prefix, two packages each writing `data:` would share the same docker volume, and A could read and write B's data.
- **`standby` defaults to a 30-minute idle reclaim as a fallback** (`DEFAULT_STANDBY_IDLE_MINUTES`). A fallback rather than a rejection: staying resident is a resource-governance matter, not a security boundary, and waking from standby is transparent to callers. The filled-in value goes into the clamped declaration, so on the confirmation page the user can see "reclaimed after 30 minutes idle".

**Always rejected (the error message says which rule, why, and how to fix it)**:

| Reason for rejection | Trigger |
|---|---|
| The service name may not be chosen by the package | `backend.service` is declared |
| No extra host ports | `backend.publish` is declared |
| A dev override would bind host source into the container | `backend.dev` is declared |
| Who runs inside the container is decided by the image's own USER; this field could lift an image designed for non-root up to root, and the host knows nothing about what runs inside a third-party image | `backend.user` is declared |
| No declared memory limit = no limit = can eat all host memory | `backend.mem` is missing, or `mem` cannot be parsed (any size is fine, but it must be a number) |
| The image is not pinned to a version: `stream update` triggers a container rebuild by swapping the tag (host takeover only compares the `Config.Image` string), a floating tag can never trigger a rebuild, and the user keeps running the image from the day of installation with nothing anywhere complaining | `backend.image` has no tag, or the tag is `latest` (only a pinned version tag or an `@sha256:` digest passes; `floatingImageTag`) |
| The package id does not fit the grammar | `stream.id` does not match `^[a-z0-9][a-z0-9_-]*$`. The id is assigned as the service name, and so is at once the container name `stream-<id>`, the volume-name prefix, and a URL path segment; and the name-collision gate is an exact comparison, so `Alist` does not get blocked by the built-in `alist` |
| The health check would send the probe to someone else's host | `backend.health` is not a local path starting with a single `/` (`@evil.com/`, `//evil.com/`, `healthz`, containing whitespace or a backslash). The probe URL is assembled by the host backend, and the host of `http://127.0.0.1:<port>@evil.com/` is `evil.com` |
| A time field exceeds its upper bound | `standby.startTimeoutSeconds` > 300 (preparing containers is a serial loop awaited at startup, and this number is "how long a container that never becomes healthy can stall boot"), `standby.idleMinutes` > 1440 (equivalent to declaring it resident) |
| Hands the host filesystem to the container | `volumes` contains a host path bind (the check reuses the same `isHostBindMount` as at runtime), or is not of the shape `name:/absolute-path`, or the package id itself cannot serve as a volume-name prefix |
| Every volume is long-lived storage taking up space on the host | more than 4 `volumes` |
| env goes into the container as is, and unbounded means an unbounded injection surface | more than 32 `env` entries, or some value longer than 4096 characters |
| Overrides an env var the host injects | an `env` name starts with `STREAM_` (the host namespace) |
| The service name (= package id) is already taken | A collision means two sides fighting for the same `/_p/` route + the same standby roster slot. **This gate checks `occupied.services`, not `occupied.ids`** — a built-in package's service name is not necessarily equal to its id (the service of `Douyin_TikTok_Download_API` is `douyin-tiktok-download-api`), and checking only ids would not see it |

**Credentials are dispatched by the host**: a package uses `stream.credentials: [domain]` to declare which domains' login state it may obtain, and the host injects it at call time (see §5.1). Secrets do not go into the image, into `backend.env`, or into the generated compose.

**Installed does not mean running**: third-party containers and built-in containers go through the same line (§7.2), and for one to actually be created the user must turn on `manage_containers` (**off by default**). While it is off, the host issues no docker write operation at all. Containers are prepared **at startup**, so right after installation it does not exist yet — it appears after the backend restarts.

**Uninstall removes the container but not the volumes**: uninstalling a package that has a container first runs `docker rm -f` on its container and then deletes the package directory (without looking at `manage_containers` — that switch governs "whether to create things for you", and cleaning up what it created is not under its control). **Named volumes are left in place**: they hold data, and deleting is irreversible. Since they are left, this must be said — when the uninstall succeeds, the notification center names which volumes were left and how to type `docker volume rm`. Do not let this notification share a `dedupeKey` with the "container could not be cleaned up" one: for an unread event with the same key the event layer only refreshes the timestamp and **drops the new body**, so the lighter notification would swallow the heavier one.

### 6.3 `hostVersion`

`stream.hostVersion` supports only the **`>=X.Y.Z`** form; `^`/`~`/x-range/`latest` are all rejected on the spot — pretending to understand them is more dangerous than rejecting them. The host's own version is injected at build time (`--define` in `scripts/build-server.mjs`), and the source path falls back to reading the repository root `package.json`. **It fails closed when it cannot be read**: any package that declares `hostVersion` is refused installation (a gate that has silently stopped working is far more dangerous than refusing the install). Packages that do not declare `hostVersion` are unaffected.

**The host version = the `version` of the repository root `package.json`, and it is the contract version for "which declaration slots a package may depend on".** When the host adds new declaration slots / new semantics that packages will
depend on (for example `links`, `item`), bump its minor; packages that use those slots write
`hostVersion: ">=<that version>"` in the same round. **Both must be done together**: bumping the host without writing a lower bound means an old host installing a new package
**silently drops** the keys it does not recognize (the schema is not strict), and the capability vanishes without a sound; writing a lower bound without bumping the host means the lower bound can never tell new from old. The current contract version
`0.1.0` introduced `links` and `item`.

### 6.4 How to package a code package

- **The entry must be exactly `dist/index.js`** — a literal path, not a pattern, not a directory. Aliased spellings such as `./dist/index.js`, `dist//index.js`, `DIST/INDEX.JS` are all rejected (letting aliases through means letting a whole family of paths through).
- **Pre-bundle into a single-file ESM with all dependencies bundled in**: the host does not run `npm install` after installing, and `node_modules` does not appear in the package directory. `import`-ing a third-party library that was not bundled in = `ERR_MODULE_NOT_FOUND` at load time, and this package **simply does not take effect this time** (the rest of Stream starts normally, and the notification center gets a `扩展包未生效` ("extension package not in effect") entry). Bundle into one file with something like esbuild/rollup.
- **There may be only this one code file**. The tarball allowlist accepts only `package.json`, `*.recipe.json`, `manifests.yaml`, README/LICENSE/NOTICE/CHANGELOG, plus the single exception of `dist/index.js`; every other path containing `/` or `\` is rejected.
- **The declaration and the actual files must match character for character**: declaring `stream.code` without that file → rejected; having that file without declaring it → **smuggled code**, also rejected.
- Types come from `@streamapp/plugin-sdk` (`ActivateFn` / `PluginContext`…), and runtime utilities come from it too (`ValidationError` /
  `ContentUnavailableError` / html utilities / `mediaPlayUrl` / `BROWSER_UA` — that is the `shared/package-sdk/` batch, bundled into your own
  dist, and the host recognizes them by duck-typing markers); the contract of `activate(ctx)` is exactly the same as for built-in packages (§3). The 7 built-in packages that carry code take exactly this path
  (§3.7 / §3.8), and their shape is pinned by them.

### 6.5 When an installation takes effect

| What was installed | When it takes effect |
|---|---|
| Recipe data / manifests | **Hot reload**, effective as soon as installed (the watcher remounts the recipe package) |
| Code (`stream.code`) | **After Stream restarts** — package code is `import()`-ed only once at startup |
| Capability (`stream.capability`) | **After Stream restarts** — same as above, the loader runs only once on the startup path (§5.9.5) |
| Container (`stream.backend`) | **After Stream restarts** — changing the `image` tag only writes to disk; the host rebuilds the container with the new tag only when it compares the image declaration on the prepare path at restart (§4.1, `recreateOnImageMismatch`) |

The same goes for **uninstall and upgrade**: files are deleted/replaced immediately, but the ESM module that has already been `import`-ed cannot be unloaded at runtime, and it keeps running until the restart. Both the install page and the uninstall confirmation page say this out loud.

**The pending-effect list is computed, not recorded**: the user layer loaded at startup is frozen into a snapshot, and `GET /api/packages/pending`
scans the user-layer directory on disk on every request, reconciles it against the snapshot, and returns a `PendingChange[]` (`{ name, kind:
'installed'|'updated'|'removed', from?, to?, needsRestart, why }`); the check looks only at slots — a new install / update / uninstall of recipe data alone
needs no restart, while anything carrying `code` / `capability` / `backend` does. The same count goes into
`GET /api/health.pending_restart` (just a number, keeping health light), and each entry of `GET /api/packages` also carries a `pending?` field
matched by package name. If the backend does not wire this query it returns `503` / health simply has no such field — there is no ledger kept, so there is also no such thing as "the ledger is broken".
Credential domains are **not counted separately** in the check: they are an allowlist for code / containers, and those three slots have already determined the restart; install / replace / uninstall all use the same yardstick.

**How to restart**: `POST /api/restart` (contract in `docs/API.md`) gracefully shuts the process down and starts it again — **it is not a hot reload**;
code / capabilities / containers / credential-domain declarations all start over along the normal startup path. Three entry points all hit this one endpoint:
`stream add` / `stream update` / `stream remove` ask right after installing `现在重启后端？[y/N]` ("Restart the backend now? [y/N]") (`--restart` /
`--no-restart` skip that question, for scripts); the standalone command `stream restart [--force]`; and the banner at the top of the packages page,
`N 项变更等待重启生效` ("N changes waiting for a restart to take effect"). If tasks are running (scheduled harvest/trading tasks on 8900) it is blocked with `409`, unless `?force=1` is passed
— the restart moment belongs to the human, and a package update should not interrupt running tasks.

**Who launched me decides how I come back** (`src/restart/policy.ts`; the `mode` in the receipt is this field):

| How launched | Check | Wrap-up |
|---|---|---|
| Supervised (a systemd service, the `stream mcp` shell, another supervisor) | env `INVOCATION_ID` or `STREAM_SUPERVISED=1` → `supervised` | Shut down gracefully and exit with 75; the supervisor relaunches |
| `stream` run in the foreground by the user | neither is present → `reexec` | Shut down gracefully, start another copy of itself, and exit. **The new copy has detached from the terminal**: Ctrl-C cannot reach it; to stop it, find the pid by port |
| `scripts/dev.sh` (kept alive by `tsx watch`) | the script does `export STREAM_RESTART_MODE=watch` | Does not shut itself down; touches `restart-sentinel` in the repository root, and the watcher sends SIGTERM + relaunches |

An explicitly set `STREAM_RESTART_MODE=supervised|reexec|watch` overrides the auto-detection. **When you need to set it**: `INVOCATION_ID`
is inherited by scopes / terminals launched by systemd user services, and running `stream` in the foreground in such a terminal is misjudged as supervised, so after exiting with 75
nobody relaunches it — there you need `export STREAM_RESTART_MODE=reexec`.

**A backend launched by `stream mcp` keeps serving after a restart, but the `tools/list` snapshot on the host side does not refresh with it** — the tools of a newly installed capability package
only show up after reopening the conversation.

### 6.6 What the install page surfaces

preview lays out the package's declarations, and `app/src/components/recipes/risk.ts` rates them into four tiers, **in strictly ascending order `plain < elevated < container < code`**:

- **`code` (highest)** — the preview contains `code` **or `capability`**. The copy states plainly "this package's code has the same privileges as Stream: it can read all cookies and tokens, and send requests to any address as you", and **lays out the adapter / normalizer registration names it will occupy** and the code entry path, plus the line "takes effect only after a restart". **The official `@streamapp/` scope is not exempt from this tier** — what the prefix can tell you is only that "overriding a built-in source is an upgrade rather than a substitution in disguise"; it cannot tell you what the code in these bytes intends to do.
- **`container`** — the preview contains `backend`. The page lays out **the full image name, the memory limit, the volumes, the env key names, the login-state domains it can obtain, and how long idle before reclaim** (env shows key names only, never the values — a value may be a token the package author stuffed in, and the confirmation page gets screenshotted and shared). The reason it sits between `elevated` and `code` is the capability surface: heavier than elevated (it runs an arbitrary image on the user's machine long-term, with network access, and can obtain the login state of the declared domains via the broker), lighter than code (a separate process and a separate filesystem namespace: host binds are rejected, volumes get a package prefix, memory has a limit, GPU is rejected, no extra host port is opened, and credentials reach only the declared domains). When a container and code coexist the level is `code`, but **both reasons are shown** — the container one carries the full image name, the only concrete thing the user can verify.
  **A capability package (`capability`) gets its own reason** (if both fields are filled, both are shown — the same file, different things registered):
  the capability entry path, **each declared credential domain named individually**, "it runs inside the backend process, with the same privileges as Stream, and can obtain the browser
  login state", and `重启后端才生效` ("takes effect only after the backend restarts"). **Which tools it will register usually cannot be shown** — tool names are known only after import + mount,
  and confirmation happens before that. So that sentence speaks about the **privilege itself**, not about counting verbs: using a number that cannot be counted
  as the risk measure would make people think 0 tools is safe.
- **Not a tier, but a row shown at every tier: `proxies`** — when a package has a `serving` declaration, the page lists the hosts the backend will connect to on its behalf
  (the union of `match` and `hosts`). This is the fact that "the backend makes outbound requests on behalf of a third party", on the same level as rate limiting and login domains; with no declaration it takes no row.
- **`elevated`** — a recipe in the package declares `effects: write` (it writes to the user's account), or a package from a non-official scope overrides a built-in source.
- **`plain`** — a pure data package; its tier is unchanged (it is not implicated by the addition of the code field).

Everything above `plain` triggers the **slow confirmation gate** (the second-confirmation control).

**Semantics of `overrides`: "you are replacing this built-in package with this version from npm; these are the full names being replaced".**
The criterion is the **package name**, not the sourceId: installing `@streamapp/xhs` → same name as that package in the built-in layer → full names identical one by one →
the user layer covers the built-in layer wholesale. So an override is **always a self-upgrade**, and a third-party package cannot cover an official source (full names start with the package name,
so the namespaces of two packages are naturally separate). The rule "non-official scope overriding a built-in source → elevated" in `risk.ts` therefore
never fires — it was not deleted but rewritten as the assertion `assertOverridesAreSelfUpgrade`: if it does fire, something is wrong with prefix composition
or preview, and it must be reported loudly rather than silently walking into a stricter confirmation box and calling it done.

### 6.7 What is rejected at install time (the most useful table for package authors)

The same yardstick governs both npm tarballs and local zip import (`assertInstallable`); switching the entry point does not get around it:

| Reason for rejection | Trigger |
|---|---|
| schemaVersion too high | the old-form `stream.schemaVersion` exceeds the upper bound this app supports |
| hostVersion not satisfied / spelling unsupported / host version unreadable | see §6.3 |
| Container declaration non-compliant | `backend` writes `service`/`publish`/`dev`/`user`, lacks `mem` or `mem` cannot be parsed, `image` is not pinned (no tag / `:latest`), a volume is a host bind or over the limit, env is over the limit or uses a `STREAM_`-prefixed name (the whole table is in §6.2; the sizes of `gpu` and `mem` are not clamped) |
| Container service name collision | the service name assigned from `stream.id` is already held by a built-in package or another installed third-party package |
| Collision with a built-in **plugin** package id | `stream.id` has the same name as a built-in package that **fills a plugin slot** (any of `backend` / `code` / `normalizer` / `sources` / `sourceGrouping` / `credentials`, see `fillsPluginSlot`). Colliding with the id of a built-in **pure recipe package** is **not rejected** — that is a supported override (see `overrides` in §6.6). **A built-in package with the same npm name does not count as a collision**: installing a new version of `@streamapp/xhs` is installing that same package as the built-in xhs, and the occupancy table removes that one built-in package by the npm name being installed (`occupiedByBuiltins(packages, selfPkgName)`); at startup, per the yardstick in §0.5, only the layer with the higher version is loaded |
| Adapter name collision | the declared adapter name is already taken by a **built-in package** (except the one with the same npm name, as above), **another installed third-party package**, or the host's four (`builtin`/`rsshub`/`replay`/`browser`) |
| Normalizer name collision | the declared normalizer name is already taken by a built-in package (except the one with the same npm name) or another installed third-party package |
| Enricher name collision | the declared `code.enrichers` name is already taken by a built-in package (except the one with the same npm name), another installed third-party package, or the host's own `/api/enrich` sources (`HOST_ENRICH_SOURCES`). A collision at startup means "neither side is activated" → the packages domain cannot start, so it is rejected before installation |
| Connect domain collision | the declared `code.connect` domain (compared in lowercase) is already taken by a built-in package (except the one with the same npm name) or another installed third-party package — one site can have only one package providing one-click subscribe |
| **Duplicate paths in the tarball** | the same path appears more than once (validation reads the first copy and the disk keeps the last = what the user approved and what was installed are not the same bytes) |
| Wrong code entry path | `stream.code.entry` is not `dist/index.js`; `stream.capability` is not the same literal |
| Code declared but no file | `stream.code` **or `stream.capability`** is declared and the package has no `dist/index.js` |
| **Smuggled code** | the package has `dist/index.js` but neither field declares it |
| Files outside the allowlist | any other path containing `/` or `\`, or a top-level file not in the accepted-extension list |
| sourceId clash | a sourceId is duplicated **within the same package** (two would be composed into the same full name, and the latter silently overwrites the former). The same name across packages is not a conflict — full names carry the package-name prefix, and two packages cannot produce the same id (§1.1) |
| Local-name grammar violation | the `id` in `manifests.yaml` or the `sourceId` of a recipe contains `/` or `:` (§1.1) |
| Size / count over the limit | tarball > 2MB, unpacked > 20MB, entries > 200 |
| Package-name grammar violation / name mismatch | the package name does not fit npm grammar, or `package.json#name` in the tarball differs from the requested name |
| Tarball integrity mismatch | the integrity does not match what the registry gave, or the package was swapped after preview (the confirm token does not match) |

### 6.8 The two routes at load time

At startup `activatePackages` obtains modules by two routes: built-in packages go through the **static import table** in `packages/index.ts`, and third-party packages in the user directory that carry `code` go through the runtime **`import(file://…/dist/index.js)`**.

**Routing is by package object identity, not by id** — the package object is scanned by the host, and nothing written inside a package can forge it; if a set were built by id, a third party writing `stream.id` as `alist` would get the **built-in** alist judged as dynamic too and the host would try to import its `.ts` source (not shipped in the release bundle) → the backend would not start. For the same reason, do not swap this for a `layer` field written on the package object.

`code.entry` is also resolved and confirmed to stay inside the package directory (`../../…` and absolute paths are always rejected).

**Check synchronously, execute asynchronously**: `activatePackages` itself is **not an `async function`**, and its first phase (name collisions, reserved names, package-directory boundary, leaking into the import table) throws synchronously before the Promise is returned. This is not a trick — `import()` itself executes the module's top-level code, with no need for `activate` to be called, so the confirmation of "can this name be registered" must come before any import, and "a synchronous throw necessarily happens before import" is guaranteed by control flow, so tests can pin it directly with `expect(() => …).toThrow()`.

**Failure comes in two tiers; the difference is "whose code is it"**:

| When | Built-in package (static table) | Third-party package (dynamic import) |
|---|---|---|
| **Name checks** (name collision / reserved name / entry path out of bounds; first phase, before execution) | Fatal, the backend does not start | Fatal, the backend does not start |
| **Execution time** (`import()` throws, module top level blows up, no `activate` exported, the list handed back does not match the declaration) | Fatal, the backend does not start | **Only that package does not take effect**: one log line + one notification (`package.activate-failed`), and bootstrap runs to completion as usual |

Name checks happen before any package code runs and are part of the trust boundary; **they must not be downgraded**. Execution time is different: a third-party package forgetting to bundle one dependency should not stop the whole of Stream from starting — if it did, the user could not recover from the UI at all and would have to dig through the filesystem to delete the package. Built-in packages are the reverse: that is our own code, and if it is broken it should fail to start.

---

## 7. Bringing up containers

### 7.1 Generating the compose

The compose is **not a hand-written static file** — it is generated from the **currently active plugin set** (`generateCompose`, `src/plugins/compose.ts`, a pure function with sorted keys, deterministic and diffable).

Print the generated compose:

```bash
pnpm plugins compose            # = tsx src/plugins/cli.ts compose
```

Output (the currently active set is douyin; **the example below shows only the plugin-backend part**):

```yaml
networks:
  stream:
    driver: bridge
services:
  douyin-tiktok-download-api:
    expose:
      - "80"
    healthcheck:
      interval: 10s
      retries: 5
      test:
        - CMD-SHELL
        - wget -qO- http://localhost:80/docs || exit 1
      timeout: 5s
    image: ghcr.io/jaggerh/douyin_tiktok_download_api:latest
    networks:
      - stream
```

> **Note**: the default output contains **only plugin containers** — Stream's own backend runs on the host and is itself the front door; there is no `serve-backend`/`gateway`, and no `./Caddyfile` is written. For the whole set of containers (NAS/VPS self-hosting) use `pnpm plugins compose --selfhost`: only that tier injects those two plus a top-level `volumes: { stream-data }`, and also writes `./Caddyfile` on the side (stderr prints `[plugins] wrote ./Caddyfile`). The example above is excerpted to focus on plugins; the actual run is authoritative for the full output.

Start and stop (idempotent — `up -d` reconciles to the currently active set):

```bash
pnpm plugins compose > docker-compose.yml
docker compose up -d
```

> ⚠️ **Do not use `docker compose down` to shut down the plugin layer.** It **deletes** the containers, while standby can only start and stop, never create
> — afterwards any `/_p/<plugin>` returns 502 immediately (inspect cannot find the container; it is not "asleep"). To stop, use `stop`; if you have already
> run `down`, run `docker compose create` to build them back (without starting them; standby wakes them on demand as before).

> ⚠️ **After changing the generator you must regenerate, and `--force-recreate` that container.** `docker-compose.yml` is a **product**
> and does not follow `src/plugins/compose.ts`; a container's healthcheck, volumes and memory limit are baked in **at the moment it is created**,
> so later changes to the generator do not affect existing containers at all, and `docker compose up -d` recreates only when the compose file **itself** has changed.
>
> This failure is extremely quiet, and has been hit in practice: the probe once hard-coded a `wget`, the Douyin image has no wget at all, so the container was
> **Up and forever unhealthy** (128 consecutive failures) while the service itself was fine (a direct `/docs` returned 200), and only the host could not get
> its base address — reported as `Failed to parse URL from /api/hybrid/video_data?…`, which **looks like a code bug but
> is actually infrastructure state**. The generator had long been fixed to pick one of `wget || curl || python3`, with a test pinning it, but the compose on disk
> was stuck at three weeks earlier, and all containers were built on the broken probe. How to tell:
>
> ```bash
> docker inspect <container> --format '{{json .State.Health}}'   # look at FailingStreak and the probe's raw output
> ```

**Development (base image + mounted source + reload, zero rebuild)**: the descriptor's `backend.dev` declares a base image + mount path + reload command; `--dev` outputs an override containing **only the dev delta**, and compose **automatically merges** `docker-compose.yml` + `docker-compose.override.yml`:

```bash
pnpm plugins compose       > docker-compose.yml            # baked image (distribution default)
pnpm plugins compose --dev > docker-compose.override.yml   # development only: services under dev switch to base + mount + reload
docker compose up -d                                        # the two files merge automatically
```

Plugins without `backend.dev` do not appear in the override → they keep their respective baked images. Changing source takes effect immediately — **no rebuild, no "redeploy"**. `backend.dev` = `{ image, mount, workdir?, command }` (see the douyin example in §10).

For gateway ports/routing rules, the difference between `expose` and `publish`, and the troubleshooting order → **see the dedicated topic `docs/GATEWAY.md`** (read it first when the backend cannot connect or ports do not line up).

### 7.2 The backend takes over containers itself (`manage_containers`, off by default)

Users of the released distribution have no repository and no compose CLI. After `config.yaml` sets `manage_containers: true` (or `STREAM_MANAGE_CONTAINERS=1`), at startup the backend prepares the containers **itself** according to each plugin's `stream.backend` declaration: if one is missing it does `pull` + `create` + `start`, and if it is already running it does one `list`+`inspect` and nothing else. The containers it creates carry the labels standby recognizes, so the containers produced by the two routes (compose / backend takeover) look exactly the same.

**Preparation governs "does it exist", standby governs "is it running".** When a container exists but is **stopped**, preparation **leaves it alone** (`'asleep'`, zero write operations) — that "stopped" is a correct decision standby's idle reclaim has just made, and starting it would put two owners fighting over the same thing, and every backend restart would wake all the sleeping containers (during development, a restart on every file save), voiding standby's memory saving altogether. The only ones preparation will start are **resident containers that did not declare `backend.standby`** — nobody is responsible for waking them.

**Off by default, and while off not a single docker write operation is issued** — containers are still governed by compose above.

Built-in packages (`packages/`) and third-party packages installed by the user (`<dataDir>/recipes/`) go through **the same line**: both are taken over and have containers created,
both enter the standby roster (so the fallback `standby: { idleMinutes: 30 }` of third parties really has a reaper collecting it),
and if `credentials` is declared both get login state dispatched by the host at call time. Third parties have two extra runtime gates:
creation is refused when `mem` is missing, and a host-path bind in volumes is refused (the route where the `package.json` on disk is hand-edited after installation).

Two rules (`src/plugins/provision-wire.ts`):

- **When the image and the declaration disagree, delete and rebuild** (the moment a package upgrade changes the image tag), without asking and without a button, and after the rebuild send an info notice in the notification center. The premise is the invariant in §4.1: the container layer must not hold state.
- **An unreachable docker does not topple startup**: one log line + one error notification, and the rest of Stream runs as usual.

`backend.publish` (a fixed host port for a self-contained management UI, such as AList) is not yet supported on this route — declaring it sends a notification explaining that the port will not be published, and that container still has to go through compose.

---

## 8. Plugin / Source catalog (the read model of `/channels`)

What the frontend `/channels` sees is not a "manifest list" but a **server-owned two-layer catalog**:

```text
Plugin              capability-package boundary: what exists, how it starts, health/config status, broad capabilities
  owns Source[]     concrete entry points that can be bound into a Stream / Provider (each source manifest = one Source; a subscription itself points to a Channel)
Source
  categories[]      merely facets inside a Plugin (filter/tab) — they do not decide ownership
  facility?         the external facility this Source belongs to ({key,label}), usable as input to the manifest.facility grouping resolver
  capabilities[]    the minimal executable contract of this Source (drives UI controls and execution validation)
  detail loaded on demand    docs / params schema / examples / credentials are fetched only when a Source is opened
```

Four invariants (`openspec/specs/plugin-source-catalog/`):

1. **The Plugin is the only ownership boundary**. `Source.pluginId` is supplied by the backend, and the frontend **must not** guess ownership via `id.startsWith('rsshub:')` or an adapter prefix.
2. **A category is a facet, not ownership**. Changing how categories are grouped never moves a Source out of the Plugin it belongs to.
3. **The list is light, the detail is heavy**. The list returns only a summary (id/title/categories/capabilities/auth/badges/param counts), **without** docs markdown or the full params schema; those are left to the detail.
4. **Source grouping can be enabled only explicitly by the Plugin descriptor**. `stream.sourceGrouping` in `packages/<id>/package.json` decides whether the Plugin shows a first-level grouping page and which resolver the backend calls: `manifest.facility` reads the Source's `facility` field, `adapter.<function>` calls the adapter grouping function of the current Plugin runtime, and `plugin.<function>` calls the plugin grouping function of the current Plugin runtime. `facility` by itself is only a facet/metadata and must not let the frontend infer a grouping; a Source for which no group is resolved falls into the explicit 「未分类」 ("Uncategorized", `key: ''`) group.

Four endpoints (`src/http/app.ts`; the read model is `StreamService` in `src/mcp/tools.ts`):

```text
GET /api/plugins                                  → PluginSummary[]
GET /api/plugins/sources                          → { sources, plugins, facets, nextCursor?, total? }   (cross-plugin Source search, grouped by plugin)
GET /api/plugins/:pluginId/sources                → { plugin, sources: SourceSummary[], groups, facets, nextCursor?, total? }
GET /api/plugins/:pluginId/sources/:sourceId      → SourceDetail   (sourceId URL-encoded: RSSHub ids contain : and /)
```

> The MCP counterpart of cross-plugin Source search is `stream_sources` (faceted, grouped by plugin); `stream_search` remains the intent-ranked discovery tool, and the two have different responsibilities.

**Plugin display metadata comes only from the descriptor** (`stream.name/tagline/description/homepage/repository/docsUrl` in `packages/<id>/package.json`) — `pluginMetadata(descriptors, id)` inside `plugins()` is the only source, and a plugin without a descriptor falls back to the bare `id`. **Do not** write a second hard-coded copy of the text in `tools.ts`.

> Current debt (recorded in the design Risks): apart from the runtime state wired in by `mergePluginStatus`, `status`/`launch.health` are still mostly placeholders. The ownership boundary (`pluginIdForDescriptor` / `pluginIdOf` in `src/registry/seal.ts`) recognizes only `package.json#stream.id` and the `adapter` the manifest itself writes; the host maintains no aliases for any package. The key boundary has been achieved: **the frontend does not guess ownership**.

---

## 9. Source failover + health ledger + doctor

The multiple `members` of one Stream (code type `StreamRecord`, `src/store/types.ts`) are **fan-out** by default (pull everything every cycle + DedupStore deduplication). After declaring `strategy: exclusive`, `members` becomes an **ordered ladder**: the scheduler pulls only **the first healthy Source** and stops at the first hit; on a hard error it moves on to the next rung within the same tick.

> Vocabulary mapping ([ARCHITECTURE.md](ARCHITECTURE.md)): these are the two `strategy` values of a Stream — fan-out ≡ `fanout`, the disaster-recovery ladder ≡ `exclusive`. The "failover" in prose means exactly this, but **only `exclusive` may be written in configuration**; writing `failover` is rejected by the user store.

The **health ledger** (`src/source-health-store.ts`, JSON, keyed by `source_id`) records every **real** pull (cache hits are not recorded, design D3):
- Hard failure (`adapter.fetch` throws) → 2 consecutive failures mark it `dead` (1 marks it `degraded`).
- Soft failure (returns `[]`) → marked `degraded` only if the Source has produced output historically (`lifetimeItemCount > 0`) **and has been empty ≥ K times in a row (default 4)**; quiet Sources are not wrongly penalized.
- **re-probe**: every M (default 6) cadences the highest-ranked non-healthy Source is probed again; on success it is promoted back to `healthy`, and selection automatically returns to it.

> Health is a **global property of the Source** (keyed by `source_id`, shared across Streams); priority is **the order of each Stream's `members`** (an edge property). The ledger is the **only shared source of truth** for failover and doctor.

**Browser as the last rung**: a Source with `adapter: browser` renders a URL as the generic last rung. Rendering happens in **the user's own Chrome** (through the extension relay; the renderer is injected by bootstrap, and the adapter itself has no default implementation — Stream ships no browser, and this rung in particular must not quietly start another one). Put it at the end of `members`; it is reached only when all the Sources above are degraded/dead. See `packages/browser/manifests.yaml` (`browser-page`).

**`pnpm doctor`**: reads the same ledger and prints, per Source, the active state / degradation reason (such as `empty ×6`) / a prescription for missing credentials (the `auth: cookie` domain cannot be resolved in the login-state snapshot → prompts you to log in in the browser). `pnpm doctor --reprobe <source>` re-probes one Source immediately.

```jsonc
// POST /api/streams — if the primary Source dies it automatically falls back to the backup Source, and finally falls back to the browser
{
  "id": "my-music",
  "label": "我的音乐收藏",   // "My music collection"
  "strategy": "exclusive",
  "members": [                                                                    // order = ladder
    { "plugin": "replay",  "source": "zuna-playlist", "params": { "id": "…" } },  // primary
    { "plugin": "rsshub",  "source": "rsshub-raw",    "params": { "route": "…" } },  // backup
    { "plugin": "browser", "source": "browser-page",  "params": { "url": "https://…" } }  // last-rung fallback
  ],
  "cadence_seconds": 1800,
  "options": { "vault_subdir": "music" }
}
```

---

## 10. Examples and templates

A complete plugin has at most 6 pieces:

| # | Piece | Location | Required? |
|---|----|------|--------|
| a | adapter class (mode → backend endpoint) | `packages/<id>/adapter.ts` (exclusively owned, the default); placed in `src/adapters/` only when shared by several plugins or part of the application core | Yes |
| b | plugin descriptor (catalog display fields + backend mirror + credentials + normalizer) | `packages/<id>/package.json` (the `stream` field) | Yes |
| c | source manifest(s) (one per call mode) | `packages/<id>/manifests.yaml` (top-level list) | Yes |
| d | normalizer (raw item → display model) | `packages/<id>/<facility>.ts`, handed over by `activate` (§3) | Yes |
| e | declared credential domains (broker service) | the descriptor's `credentials: [...]` | Only when a login state is needed |
| f | code slot: `activate(ctx)` + the `stream.code` lists (hand a/d to the host to register) | `packages/<id>/activate.ts` + the descriptor's `stream.code` (§3) | Required whenever there is code |

### 10.1 Example (complete): douyin

**(a) adapter** — `packages/Douyin_TikTok_Download_API/adapter/adapter.ts` (`DouyinTiktokDownloadApiAdapter`; the same directory also holds the executor / normalize / danmaku / play-addr implementation pieces and `__fixtures__/`). A thin HTTP client for the **externally running Douyin_TikTok_Download_API container**: the whole package has **one adapter**, which routes to backend endpoints according to the declarative `api.endpoint/query/unwrap` of each source manifest (see references/via-external-backend.md in the `onboard-source` skill) and returns the raw list; `api.handler` is the escape hatch, used by members such as resolve / fetch-url whose shape is not a "list". The container address:

```
env DOUYIN_API_URL (explicit override, e.g. a copy the user runs themselves at http://10.0.0.21:3007)
  →  ctx.backendUrl() (default: this package's own backend service; in the compose tier it is the container DNS name, in the host tier it is the loopback port of the awake container)
```

`ctx.backendUrl` is **passed as a thunk, not as a value** (`() => ctx.backendUrl()`): in the host tier the loopback origin exists only while the container is awake, so a snapshot taken at construction time is always an empty string. Every call to the container is wrapped in `ctx.withAwake`, which wakes a sleeping container first. The host's `config.yaml` has **no** entry for this container's address — the address belongs to the package, and the host only manages the resolver.

(The cookie for login-state modes (collection / follow / search) goes through the **adapter path**: the host resolves it via the manifest's `auth: { type: cookie, domain: douyin.com }` and injects it into `init`/`sidecar.start`, and the adapter passes it to the container as a query parameter — the adapter itself **does not ask for credentials**. The user mode is a public profile page, with `auth: none` and no cookie needed.)

**(b) descriptor** — `packages/Douyin_TikTok_Download_API/package.json`:

```json
{
  "name": "@streamapp/douyin-tiktok-download-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "bundle": "node ../../scripts/bundle-code-packages.mjs .",
    "prepack": "node ../../scripts/assert-npm-artifact.mjs"
  },
  "files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
  "stream": {
    "id": "Douyin_TikTok_Download_API",
    "name": "抖音 / TikTok",
    "tagline": "视频平台搜索与解析服务",
    "description": "抖音搜索、用户作品、关注流、合集与视频媒体解析。",
    "backend": {
      "image": "ghcr.io/jaggerh/douyin_tiktok_download_api:latest",
      "service": "douyin-tiktok-download-api",
      "port": 80,
      "health": "/health",
      "standby": { "idleMinutes": 30 }
    },
    "credentials": ["douyin.com", "tiktok.com"],
    "links": {
      "hosts": [
        { "host": "douyin.com", "platform": "douyin" },
        { "host": "iesdouyin.com", "platform": "douyin" },
        { "host": "tiktok.com", "platform": "tiktok" }
      ],
      "shortHosts": ["v.douyin.com", "vm.tiktok.com"]
    },
    "normalizer": "douyin",
    "sourceGrouping": { "enabled": true, "resolver": "manifest.facility" },
    "code": {
      "entry": "dist/index.js",
      "adapters": ["Douyin_TikTok_Download_API"],
      "normalizers": ["douyin", "tiktok", "bilibili-web"],
      "enrichers": ["douyin-comments"],
      "connect": ["douyin.com"]
    },
    "providers": [
      { "id": "video-douyin", "category": "resolve", "serveKeys": ["douyin-video"], "strategy": "sequential",
        "label": "douyin 视频解析", "description": "作品 id → play_addr 直连 CDN（带 Referer，range 串流）",
        "members": [{ "source": "douyin-resolve" }], "callsites": ["video.resolve"] },
      { "id": "video-tiktok", "category": "resolve", "serveKeys": ["tiktok-video"], "strategy": "sequential",
        "label": "tiktok 视频解析", "description": "作品 id → play_addr 直连 CDN",
        "members": [{ "source": "tiktok-resolve" }], "callsites": ["video.resolve"] },
      { "id": "douyin-url", "category": "transform", "serveKeys": ["douyin-link"], "strategy": "sequential",
        "label": "抖音链接抓媒体", "description": "douyin.com / iesdouyin.com / v.douyin.com 的链接 → 标题、作者与可播放地址",
        "members": [{ "source": "douyin-fetch-url" }], "callsites": ["content.enrich"] },
      { "id": "tiktok-url", "category": "transform", "serveKeys": ["tiktok-link"], "strategy": "sequential",
        "label": "TikTok 链接抓媒体", "description": "tiktok.com 的链接 → 标题、作者与可播放地址",
        "members": [{ "source": "tiktok-fetch-url" }], "callsites": ["content.enrich"] }
    ]
  }
}
```

> The Chinese strings in this descriptor are literal catalog / UI strings and stay Chinese: `name` "抖音 / TikTok" (Douyin / TikTok), `tagline` "视频平台搜索与解析服务" ("video platform search and resolve service"), `description` "抖音搜索、用户作品、关注流、合集与视频媒体解析。" ("Douyin search, user works, follow streams, collections and video media resolution."), and the provider `label`s "douyin 视频解析" ("douyin video resolve"), "tiktok 视频解析" ("tiktok video resolve"), "抖音链接抓媒体" ("Douyin link media fetch"), "TikTok 链接抓媒体" ("TikTok link media fetch"). The provider `description`s read: "work id → play_addr direct CDN (with Referer, range streaming)"; "links on douyin.com / iesdouyin.com / v.douyin.com → title, author and playable address"; "links on tiktok.com → title, author and playable address".

> The four `providers[]` rows are this package's outward **capability surface** (§0.5): `resolve` rows are dispatched to by `<platform>-video`, from `GET /api/media/play|dash`
> and from transcription / frame extraction fetching bytes; `transform` rows are dispatched to by `<platform>-link`, from `stream_fetch_url` / `GET /api/media/from-url`
> (the claim function recognizes the platform by suffix-matching `links.hosts`, so the single `douyin.com` entry covers `www.` / `v.`; one package serves two platforms, so every host spells out `platform` explicitly). **Every row declares `callsites`** —
> without them no callsite ever asks for it. Member contract: `*-resolve` takes `{ vid, format }` and returns `VideoResolved[]` (`[]` = decline,
> `dash` honestly returns empty; a deleted / private work **throws** `ContentUnavailableError`, which the play route turns into a 404 rather than a 502); `*-fetch-url`
> takes `{ url }`, has manifest `output: object`, and returns `[FetchUrlResult]`. The shape of `vid` belongs to the package: for Douyin it is the `aweme_id`, for TikTok the
> work `id` (both numeric strings), and the resolver builds a main-site link from the id to hand to the container; **do not use a share link as the `vid`** — it is half of the dispatch key and the progress key,
> and a share link carrying signed parameters differs on every call.

> The top-level `name`/`version`/`files`/`scripts` are the npm shell (a package with code is published to npm, so it does not write `private`; `bundle` / `prepack` /
> `files` are the shipping shape of §3.8); domain fields always live inside `stream`.
> **`"type": "module"` is mandatory** (guarded by `src/plugins/loader.real.test.ts`): Node honors the **nearest**
> package.json, so once `packages/<id>/package.json` exists, the `"type": "module"` at the repository root no longer governs
> that subtree. Omitting it = the whole `packages/<id>/**` is parsed as CommonJS, and every `src/**` module it `import`s gets
> **an extra copy** in the CJS cache — the wiring bootstrap does on the ESM copy (`setPluginTargetResolver` /
> `setStandbyManager`) is never seen by the plugin: in the host tier `pluginTarget()` is always null (base empty string → fetch a
> relative URL → `Failed to parse URL`), `withAwake()` becomes a no-op, and `standbyOrigin()` is always null.
> No error is raised and unit tests still pass green (in the test process neither copy is wired); only the live host tier blows up.
> **When you hit `Failed to parse URL`, look at the DebugBox `plugin-target` channel first**: every time `pluginTarget()` answers empty
> it records a snapshot of the scene (reason, whether the container exists, what state standby thinks it is in, the host port found by inspecting the live container vs
> the cached origin), enough to tell directly whether it is "not awake", "the allow list missed it", or "the cache is stale". To dig through old records afterwards, read the copy written to disk
> (the ring holds only 200 entries and is cleared on restart): `grep '"plugin-target"' data/debug-failures.jsonl`.
> **`reason: not-awake` is mostly routine noise, not a scene worth inspecting**: the capability probe asks for the address every minute, and a container
> put to sleep by standby honestly answers empty (measured: 1184 entries in 21 hours, content identical down to the character). The disk write folds them, and **rows carrying `_repeated`
> are this kind**. The scene to look for looks different: no `_repeated`, and standby says `awake` (then the problem is something other than not being awake), or the cached origin does not match the host port found by live inspection
> (then the Cell cache is stale).
> `name/tagline/description` are catalog display fields (§8), the sole source of Plugin metadata.
> `image` uses the image the facility publishes itself; `service` is the compose service name (default = `id`), and the gateway goes through `/_p/<service>`;
> `health` is ready when it returns 2xx (default `/`) — **pick the facility's own dedicated health endpoint; do not substitute the home page or a docs page**:
> the probe fires every 10 seconds and keeps firing as long as the container is alive; for the Douyin facility `/health` is 65 bytes at 2.6ms,
> `/docs` (the Swagger page) is 958 bytes, and the `/` home page is 7.6KB. Before choosing, measure each with `curl -w '%{size_download} %{time_total}'`,
> a matter of seconds; a package that declares `backend.dev` mounts its source and runs hot under `compose --dev` (this package runs the baked image and does not declare it);
> the domains in `credentials` are an allow list of the login states the host **may** hand to this package (direction in §5.1; the package does not ask for them).

**(c) source manifests** — `packages/Douyin_TikTok_Download_API/manifests.yaml` (a top-level list, one entry per Source; the real file in the repository is authoritative):

```yaml
- id: douyin-user
  adapter: Douyin_TikTok_Download_API                          # routes to the in-package adapter
  normalizer: douyin
  description: 抖音 — 指定用户的作品（按主页链接或 sec_user_id）。   # ← discovery/search match against this field (Douyin — works of a given user, by profile link or sec_user_id)
  topics: [douyin, 抖音, 用户, 作品, video, social-media]         # ← discovery facet (抖音 = Douyin, 用户 = user, 作品 = works)
  categories: [social-media, video]
  example_queries: [某个抖音博主的最新视频, douyin user videos]     # ← intent-retrieval samples ("the latest videos of some Douyin creator")
  capabilities: [timeline]
  auth: { type: none }                                         # user = public profile, no login needed; login-state modes use auth: { type: cookie, domain: douyin.com } (host injects into the adapter)
  cadence_hint_seconds: 3600
  params_schema:
    url:  { type: string, required: false }
    sec_user_id: { type: string, required: false }
    count: { type: number, required: false }
# A Provider row's member is also a source: not discoverable, goes through the handler escape hatch, and params is the object passed by the callsite, spread in full
- id: douyin-resolve
  adapter: Douyin_TikTok_Download_API
  title: 抖音视频解析
  description: 抖音作品播放解析（作品 id → play_addr 直连 CDN，带 Referer，range 串流）；video-douyin Provider 行的成员。
  facility: { key: douyin, label: 抖音 }
  auth: { type: none }
  discoverable: false
  api: { handler: douyin-resolve }                             # vid → main-site link → container /api/hybrid/video_data
  params_schema:
    vid: { type: string, required: true, description: "作品 id（aweme_id）" }
    format: { type: string, required: false, description: "progressive | dash | audio（dash 如实回空）" }
```

> The Chinese values in the second entry are literal strings: `title` 抖音视频解析 ("Douyin video resolve"); `description` "Douyin work playback resolution (work id → play_addr direct CDN, with Referer, range streaming); a member of the video-douyin Provider row."; `facility.label` 抖音 (Douyin); `vid` description "work id (aweme_id)"; `format` description "progressive | dash | audio (dash honestly returns empty)".

> `schema_version` / `type` / `discoverable` may be omitted (the loader supplies defaults); but `description` / `topics` / `example_queries` are the basis for discovery and search — **do not omit them**.
> The same file also holds `tiktok-resolve` / `douyin-fetch-url` / `tiktok-fetch-url` (the latter two with `output: object`), with the same shape.

**(d) normalizer** — `packages/Douyin_TikTok_Download_API/douyin.ts` (`douyinNormalizer`; `tiktok.ts` in the same directory is the other platform on the same container). The package hands it over itself in `activate` (see (f) below), and the loader registers it in the registry of `src/content/normalize.ts`. Video media carries only the `(provider, vid)` identity (`vid` = `aweme_id`); the playback address is resolved on the spot by the package's resolve member at play time, so the normalizer bakes in no route string and no embed; `page_url` is kept (the frontend's "open original page" and dedup both use it).

**(f) code slot** — `packages/Douyin_TikTok_Download_API/activate.ts` exports `activate(ctx)`; the four lists declared by `stream.code` in the descriptor (`adapters` / `normalizers` / `enrichers` / `connect`) match the returned keys character for character:

```ts
export const activate: ActivateFn = (ctx) => {
  // Pass the container address as a thunk, not a value: in the host tier the loopback origin exists only while the container is awake, so a snapshot at construction time is always empty.
  // ctx.backendUrl() with no argument = this package's own backend service. An explicit override is read by the package itself from DOUYIN_API_URL, not through ctx.config.
  const adapter = new DouyinTiktokDownloadApiAdapter({ backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake })
  return {
    adapters: { Douyin_TikTok_Download_API: adapter },
    normalizers: { douyin: douyinNormalizer, tiktok: tiktokNormalizer, 'bilibili-web': bilibiliWebNormalizer },
    enrichers: makeEnrichers(adapter),   // { 'douyin-comments': ({ vid, cursor|page }) => { comments, total, cursor? } }
    connect: makeConnect(),              // { 'douyin.com': () => ({ stream: 「我的抖音关注」 }) }   (「我的抖音关注」 = "My Douyin follows", a literal stream name)
  }
}
```

- **enricher** `douyin-comments` (`enrich.ts`) rides the same adapter to hit the container's comments endpoint: it takes `vid` (missing → `ValidationError` → 400),
  and for the paging cursor prefers `cursor` while also accepting the `page` that the frontend's generic paging passes back; the last page **carries no** `cursor` (the contract of §3.2: `null` or absent both mean "no next page").
- **connect** `douyin.com` (`connect.ts`) takes zero input and does not go through the container: it builds one `douyin-follow` Stream (source `douyin-follow` + `{ mode: 'follow' }`),
  and the login state is needed only at harvest time. The key must appear in `credentials`.

For the contract and the seven things in ctx, see **§3.2**.

**(e) credential domains** — the descriptor's `credentials: [douyin.com, tiktok.com]`: an **allow list** stating which domains' login states the host may hand to this package. Data fetching is initiated by the host (the adapter obtains the injected cookie inside the host process and passes it along with the request to the container), and the package never asks for it in reverse — see the direction explanation in §5.1. Secrets do not go into the image, into `backend.env`, or into the generated compose.

Once added to the activation set, `pnpm plugins compose` automatically adds the `douyin-tiktok-download-api` backend to the generated compose.

### 10.2 Template (search-only external service, no credentials): pansou

pansou is a netdisk resource search service — **search only, no login state**. This is the simplest plugin shape: one backend container + adapter + manifest + normalizer, **with no `credentials`**.

**(b) descriptor** — `packages/pansou/package.json`:

```json
{
  "name": "@streamapp/pansou",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "bundle": "node ../../scripts/bundle-code-packages.mjs .",
    "prepack": "node ../../scripts/assert-npm-artifact.mjs"
  },
  "files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
  "stream": {
    "id": "pansou",
    "backend": {
      "image": "ghcr.io/fish2018/pansou:latest",
      "port": 8888,
      "health": "/"
    },
    "normalizer": "pansou"
  }
}
```

> Replace `image`/`health` with the image and health-probe path that pansou actually publishes. There are no `credentials`: search needs no login state.

**(a) adapter** skeleton — `packages/pansou/adapter.ts`. Anything pointing back into `src/` may only be `import type` (via `../../src/...`);
the container address and wake-up are **passed in through `ctx`**, and the package does not import the host's `pluginTarget` / `withAwake` singletons (the guard
`src/packages/self-contained.guard.test.ts` turns red — once inlined into the package's bundle, those two singletons become a second table that is always empty):

```ts
import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

export const PANSOU_SERVICE = 'pansou'   // the wake key of withAwake = the compose service name

export interface PansouAdapterDeps {
  backendUrl: () => string | undefined   // a thunk, not a value: the host-tier loopback origin exists only while the container is awake
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
}

/** Explicit override (ctx.config.url) → PANSOU_URL env → the container address the host gives right now (none tier → ''). */
export function resolvePansouUrl(explicit: string | undefined, backendUrl: () => string | undefined): string {
  return explicit ?? process.env.PANSOU_URL ?? backendUrl() ?? ''
}

export class PansouAdapter implements Adapter {
  readonly id = 'pansou'
  constructor(private readonly deps: PansouAdapterDeps, private readonly explicitUrl?: string) {}
  /** Resolved afresh on every evaluation; fetch always runs inside the withAwake callback, so the container is awake at evaluation time. */
  private get baseUrl(): string {
    return resolvePansouUrl(this.explicitUrl, this.deps.backendUrl).replace(/\/$/, '')
  }
  async init(_env: Record<string, string>): Promise<void> {}   // no credentials

  async fetch(params: Record<string, unknown>, _m: SourceManifest): Promise<unknown[]> {
    const kw = String(params.keyword ?? '')
    if (!kw) throw new Error('[pansou] search needs `keyword`')
    const r = await this.deps.withAwake(PANSOU_SERVICE, () =>
      fetch(`${this.baseUrl}/api/search?kw=${encodeURIComponent(kw)}`))
    if (!r.ok) throw new Error(`[pansou] HTTP ${r.status}`)
    const data = await r.json()
    return /* TODO: extract the result array from pansou's response structure */ []
  }
}
```

**(c) manifest** skeleton — `packages/pansou/manifests.yaml` (one entry of the top-level list):

```yaml
- id: pansou-search
  adapter: pansou
  normalizer: pansou
  description: 网盘资源搜索 — 按关键词搜全网网盘（百度/阿里/夸克…）资源链接。   # basis for discovery/search (Netdisk resource search — search netdisk resource links across the web by keyword (Baidu/Aliyun/Quark…))
  topics: [pansou, 网盘, 资源, 搜索, 百度网盘, 阿里云盘, netdisk, search]   # (网盘 = netdisk, 资源 = resource, 搜索 = search, 百度网盘 = Baidu Netdisk, 阿里云盘 = Aliyun Drive)
  categories: [search, resource]
  example_queries: [搜网盘资源, 某电影 网盘资源]   # ("search netdisk resources", "some movie netdisk resources")
  capabilities: [search]
  auth: { type: none }
  cadence_hint_seconds: 3600
  params_schema:
    keyword: { type: string, required: true, description: search keyword }
```

**(d) normalizer** skeleton — `packages/pansou/normalizer.ts` (`pansouNormalizer`, living in the package; it only `import type`s the host's
`Normalizer` / `Media`), handed over by the package in `activate`; no row is added to the registry in the host's `src/content/normalize.ts`.

**(e) credentials**: none (search needs no login).

**(f) code slot** — `packages/pansou/activate.ts` exports `activate(ctx)`, and the descriptor adds `"code": { "entry": "dist/index.js", "adapters": ["pansou"], "normalizers": ["pansou"] }` (`entry` points to the precompiled artifact on npm, §3.8; the built-in tier imports `activate.ts` directly per the static table in §3.3):

```ts
export const activate: ActivateFn = (ctx) => ({
  adapters: {
    pansou: new PansouAdapter(
      { backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake },   // pass a thunk, not a value
      ctx.config.url as string | undefined,
    ),
  },
  normalizers: { pansou: pansouNormalizer },
})
```

A built-in package also needs one row added to the static import table in `packages/index.ts` (see §3.3). **Do not add a row to the adapters Map in `src/bootstrap.ts`** — that table holds only the host's four.

Once added to the activation set, `pnpm plugins compose` automatically adds the `pansou` backend to the generated compose.

---

## Appendix: Quick reference of the current shapes

- **PluginDescriptor**: `{ id, name?, tagline?, description?, homepage?, repository?, docsUrl?, required?, backend?, sourceGrouping?, credentials?: string[], normalizer?, code?, capability?, sources? }` (`code?: { entry, adapters?: string[], normalizers?: string[], enrichers?: string[], connect?: string[] }` see §3; `capability?: 'dist/index.js'` see §5.9) (`src/packages/descriptor.ts` `parseStreamDescriptor` / `src/plugins/types.ts`; `presenter?` is kept as a deprecated alias for `normalizer`). `name/tagline/description/homepage/repository/docsUrl` are **catalog display fields** (§8) and the sole source of Plugin metadata. `required?: boolean` marks base plugins (`rsshub`/`builtin` use `required: true`). `sources` is merged in by the scanner from `manifests.yaml` (`stream.sources` inline and `manifests.yaml` are mutually exclusive; giving both is an error).
- **PluginBackend**: `{ image, service?, port, health?, env?, gpu?, volumes?, mem?, user?, publish?, dev?, standby? }` (`src/packages/descriptor.ts` `backendSchema`) — `image` is the facility's own image; `service` defaults to `id`; same-network DNS goes through `http://<service>:<port>`; **secrets never go into `env`** — to get a login state, declare `credentials`, and the host dispatches it with the request (§5.1). `gpu` (nvidia reservation, optional; used by the `voiceprint`/`mineru` packages; a third-party declaration is clamped and rejected, official packages pass, §6.2), `volumes`/`mem` (resources, used by many facilities), `user` (who to run as inside the container, used by `alist`, see §4.1), `publish` (extra published host ports; present in the schema, no plugin currently uses it). `dev = { image, mount, workdir?, command }` is emitted only by `compose --dev` (base + mount + reload).
- **Generated compose structure**: `{ networks: { stream }, services: {…} }`, keys sorted, deterministic. By default it holds only plugin containers. Only `--selfhost` appends Stream's own two pieces: `serve-backend` (`build: .`, `STREAM_PLUGIN_NETWORK: compose` + an explicit `STREAM_PORT: 4555`, i.e. the owner of `/_p`, which also serves the UI) and `gateway` (`caddy:2-alpine`, the **only port published to the host** in that tier, `127.0.0.1:8900:80`) + a top-level `volumes: { stream-data }`, and it also writes `./Caddyfile`. A single `ComposeService` may contain `image/build/command/env_file/expose/ports/volumes/deploy(GPU)/mem_limit/depends_on/networks/healthcheck/environment`. The real output is whatever `pnpm plugins compose` prints.
- **BrowserRecipe**: `{ version, kind, sourceId, session{facility,lifecycle,visibility}, loginCheck, steps[], observers[], output, ledger?, policy?, extract? }` (§2.2). There is also the `kind:'http'` probe prototype (§2.3) and the `kind:'desktop'` desktop prototype (§2.4).
