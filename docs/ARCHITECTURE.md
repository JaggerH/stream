# Stream Architecture

Stream is a self-hostable **information-flow layer**: it ingests many sources (RSSHub routes plus
native adapters like xhs / bilibili / douyin) into one inbox, normalizes them with per-source
normalizers, and exposes everything — feeds, search, resolution, transcription — to both a web
frontend and AI agents (MCP) from a single process. Data sources mount as plugins.

This document is the authoritative definition of the concepts and their dependency structure.
`docs/PACKAGE.md` covers one layer of it (Stream packages / Plugins) in depth.

## The model at a glance

Five concepts. The **aggregation chain** is `Channel → Stream → Source`. A Source carries the id
of the Plugin it belongs to, and is *executed through* that Plugin at runtime — the Plugin is the
**ownership and execution boundary**, not a layer of the aggregation chain. A **Provider** sits
outside the chain: a global, stateless, on-demand capability. (**Present** is not a sixth
concept — it is the official registry of Channel consumption modes that `Channel.present`
indexes into; see Channel below.)

```
  subscription / call ──────────────▶ Channel       (entry point; present: timeline | search | audio | video
                                                     + options.slots: per-Channel Callsite→Provider overrides)
                                        │ aggregates ≥1
                                        ▼
                                      Stream        (scheduled feed member; strategy: fanout | exclusive;
                                                     mode: feed | collection — storage shape)
                                        │ references ≥1
                                        ▼
                                      Source        (one manifest entry; knows its owning Plugin)
                                        │ executed through
                                        ▼
  ┌───────────────────────────────── Plugin ─────────────────────────────────┐
  │ adapter (facility API → raw items)   normalizer (raw → display model)    │
  │ optional managed backend container   declared credential domains         │
  └──────────────────────────────────────────────────────────────────────────┘

  Provider  (global stateless capability: identity belongs in code (system component) or in rows (user-created);
             orchestration members/options belong in rows;
             callsite = category + key extraction + invoke(); dispatch = ProviderDirectory.match — never scheduled, owned by no Channel;
             Channels may override routing per Callsite via options.slots, but the Provider row itself is always global, referenced rather than owned)
```

| Concept | Definition | Lives in (target state — see [Data & File Structures](#data--file-structures-target-state)) |
|---|---|---|
| **Channel** | The only subscribe/invoke entry point. A **view**: references ≥1 Streams by id; one `present` per Channel (an id into the official Present registry) decides the full consumption mode (acquisition + rendering + attachable capabilities); `options.slots` optionally overrides which Provider fills a Callsite for this Channel. | user store (`channels` table) |
| **Stream** | A scheduled feed unit with **global identity**, reusable across Channels; aggregates ≥1 Sources with a `strategy`; its `mode` (`feed`\|`collection`) is the storage-shape authority | user store (`streams` table) |
| **Provider** | A global, stateless, on-demand capability. Identity (category/serves keys/fallback/strategy/contract): system components belong in code (`src/providers/system/`), user-created ones belong in rows; orchestration (members/options) always belongs in rows. Dispatch goes through `ProviderDirectory.match` | identity: code + user store; orchestration: user store (`providers` table) |
| **Source** | One concrete callable entry declared by a manifest, or derived from a recipe's `meta`; carries its owning `pluginId` | its Stream package (`packages/<id>/manifests.yaml`, or a `*.recipe.json`) |
| **Plugin** | A Stream package that fills ≥1 **plugin slot** (manifest(s) / adapter code / normalizer / managed backend container / credential domains / source grouping) | `packages/<id>/` (builtin) or `<dataDir>/recipes/<@scope__name>/` (user-installed) |

## Capability Normalization: Three Axes, Each Draws Its Own Line

"builtin vs recipe" is a false dichotomy: it smears three independent axes into one word, letting
"what the engine happens to support" draw design boundaries. Any facility capability (live check,
save to the netdisk, resolve, search, and so on) independently answers three questions
(authoritative definition and decision record: `internal design record`):

| Axis | Question | Values | Who cares |
|---|---|---|---|
| **Expression** | TS code or declarative data? | code / data | Nobody: the Source implementation is private, invisible to upper layers |
| **Distribution** | Baked into the image or hot-dropped? | image / hot-drop | Product: paid touchpoints require "adding a facility = adding data, no release" |
| **Effect** | Read-only, or changes the outside world? | read / write | Security: engine gates can structurally contain the worst case for reads, but not for writes |

**Boundary result**: read capabilities → data, hot-drop
(the SSRF public-network gate + cookieDomain binding + jar domain bucketing structurally contain the worst case); **write capabilities can also be recipes**
— `xhs-like` (liking/favoriting writes to the user's account) is a recipe, and recipes may write to user accounts.
The gate cannot understand what a POST does, but **do not block it by saying "writes stay in code"**: third-party content cannot be audited,
installing it or not is the user's own tradeoff, with no trust tiers and no origin adjudication. Sharing/loading third-party recipes only shows a **unified disclaimer**
(1. no security guarantee 2. users must confirm for themselves whether third-party content is trustworthy), with **no per-item authorization and no package-origin signature**.
Example: Quark/Baidu **live checks** are both recipes (hot-drop data), while Quark **save to the netdisk** is currently code (`shared/netdisk/quark/save.ts`,
following the facility): an implementation choice, not a prohibition.

**The netdisk area is split by "recognize disk / assign show"** (spec `internal design record`):

- **Recognize disk**: things done to a netdisk: check whether a share is alive, list its files, save content into the user's own disk, get a playable
  direct link, jump to the netdisk web page, upload files into the disk (OpenList `fs/put`, streaming), create share links for directories on the disk (Quark
  `share` → `task` → `share/password` in three steps, `shared/netdisk/quark/share-api.ts`; path→fid uses the same `browse.ts` as "jump to Quark"),
  list shares the user created (Quark `share/mypage/detail`, paginated), and delete shares by shareId
  (Quark `share/delete`, **deletes the link, not the file, and is irreversible**; sends one by one to get per-item results). The orchestration for these three operations is all in
  `src/netdisk/share-create.ts` (listing/deleting does not look at the mount table: "My shares" is an account-level table), and the HTTP surface
  `POST /api/netdisk/{fs/put,share/create,share/delete}` + `GET /api/netdisk/share/list`
  is for local export scripts; see `docs/API.md`. They are all cookie-authenticated, unsigned public APIs, at facility level, and packageable. The implementation lives in `shared/netdisk/`
  (OpenList client, Quark save / play / browse / verify / share create/list/delete, Baidu verify, adjudication vocabulary), and **both hosts consume the same copy**:
  the Stream orchestration layer (`src/netdisk/`, `src/kernel/plugins/provider.ts`) and the netdisk capability package
  `@streamapp/netdisk` (`capabilities/netdisk/`, optional capability package; login state is fetched on demand from the
  `streamBrowserCookies` service exposed to the backend **in the same process**). There is one install path: `stream add @streamapp/netdisk`; after the backend reloads,
  `src/capabilities/load.ts` mounts it (see the "Capability Packages" section below), so the model gains four `netdisk_*` verbs.
  Configuration is the `capabilities.netdisk` slot in `config.yaml`: providing `openlistUrl` + a permanent token =
  **external tier** (get `<origin>/_p/alist` and that token from `GET /api/netdisk/openlist-access`;
  the package does not touch storage admin); leaving it empty = **managed tier**, where the package uses `shared/docker/engine-api.ts` (the same Docker Engine API client as standby)
  to pull the container itself, take over admin, mount, and reclaim when idle; if it discovers Stream's
  `alist` container on the same machine, it yields.
- **Assign show**: align files on the netdisk with the program guide: binding, matching (`src/netdisk/match-engine/`, pure functions), and archive. Only the orchestration layer can see
  both the program guide and the netdisk directory, so this stays in Stream and does not enter plugins.

### Capability Packages: The Stream Backend Is the Only Host, and a Capability Is One Slot in a Stream Package

**Capability package** is the distribution unit for "one capability in hand". Source code lives in `capabilities/<x>/`, and the contract is
`shared/capability/types.ts`: `export const capability`; `mount(ctx, config)` gets the seven slots
`dataDir` / `log` / `require` / `provide` / `registerTools` /
`destructiveGate` / `onDispose` from `CapabilityContext`. **The only host implementation is in the backend**: `src/capabilities/host.ts`.

| | Built-in | Optional |
|---|---|---|
| Who | **Stream Desktop** (capability name `desktop`, computer operation: relay + four `cdp_*` tools + cookie service + the `stream-desktop` command) | `@streamapp/netdisk` (four recognize-disk verbs) and compatible capability packages installed by the user as needed |
| How it enters | `private: true`, shipped with the backend bundle; `src/host-agent/mount.ts` hands it to the host to mount | `stream add @streamapp/<x>` → `<dataDir>/recipes/<@scope__name>/`; after the backend reloads, `src/capabilities/load.ts` scans packages with non-empty `stream.capability` and dynamically imports `dist/index.js` |
| Where tools come from | `/api/mcp` on 8900 | Same as left: the host line (`claude mcp add stream -- stream mcp`) never needs to change |

**Mount order: built-ins first, optionals later**, because name collisions are **hard rejects** (`registerTools` and `provide` both check two lists:
registered capability tools and the backend's own tool names), so order directly decides who gets rejected. If reversed, a user could install a package named
`desktop` and override the Stream Desktop on the machine.

**If one package's mount throws, record one line and continue installing the next one**. It does not kill other packages or the backend; tools / services /
dispose functions it already registered are rolled back together. `import` and `mount` each have a timeout (default 30s).

**Login state delivery is process-local only**. This is a constraint, not an implementation choice: netdisk needs the login state held by the browser, and once cookies cross processes
they become an irreversible security surface (spec `2026-09-02-netdisk-capability-plugin-design.md` §4.1). Therefore there is only
one pair: backend `provide(BROWSER_COOKIE_SERVICE)`, netdisk `require(BROWSER_COOKIE_SERVICE)`.
Which domains a package can access is declared by the package itself in `package.json#stream.credentials`; the host asks the extension for them accordingly.
**The direction is always host dispatches, package does not request**.

**`stream mcp` is not the orchestration layer.** How recipes run, how desktop actions are chained, and how netdisk files align with the program guide all live in the backend
on 8900. This subcommand (`src/install/mcp-command.ts`) only does two chores: **probe once** against local
`/api/health` (2s timeout); if present, forward the whole surface to `/api/mcp`; if absent, start the backend first and then forward.
The probe runs only once, and the command does not switch if the backend starts or stops midway: switching means the tool surface changes in the middle of a session, and the host's tool snapshot cannot keep up.

**Matching is a general capability; netdisk is only one shelf for it.** The engine consumes abstract file entries (path, size, duration), and file operations go through
a five-action interface (list / mkdir / move / delete / direct link). Differences between shelves, such as case sensitivity, whether deletes can be undone, whether listing reflects
current state, and whether it can report "still writing", are declared by the shelf **itself** in a self-description table (`ShelfTraits` in `shared/netdisk/shelf.ts`).
The planner degrades according to that declaration and does not recognize source types. Adding a shelf (local directory) = implement five actions + fill this table, with no planner changes;
an omitted field is a compile-time missing field. One guard test pins "the engine does not know I/O" (`reconcile/engine-boundary.test.ts`), and
a contract test suite (`reconcile/shelf-contract.ts`) makes each implementation run the same cases. The only implementation today is `AlistClient`
(`id === 'openlist'`), so the key that determines the ledger includes the shelf id. For each check and threshold, see `docs/MATCHING.md`
"How the archiver degrades when input is distorted".

**The three shelves in one binding must be on the same shelf** is not yet enforced by a check: cross-shelf "move" must become "copy + delete",
and the five-action interface has no such tier, while today there is only one shelf and nothing to compare against. Do this together when the second shelf lands.

## Two configuration layers

| Layer | Holds | Written by | Read |
|---|---|---|---|
| `config.yaml` | where things live on this machine: paths, dirs, ports, ad-filter rules | a human, in a text editor | once at boot (`loadConfig`) |
| `data/settings.json` (`SettingsStore`) | everything set from the running app: LLM connections, AList, per-Source runtime config, plugin toggles, harvest browser | the Settings page / the extension's one-click Connect / `PUT /api/settings/*` | every read, hot-applied |

**The overlay always wins** (`settings.get().x ?? config.x`) — so the same value must not be kept in
both. A duplicate in `config.yaml` does nothing at all until the overlay is lost, and then it
**silently takes over** with a value nobody has maintained: the failure mode is not an error but
wrong data (an old AList host still answering, serving another machine's files).
Anything a user can change from the UI belongs in the overlay only.

## Runtime Source Configuration

Runtime Source Configuration is the private deployment configuration a Source needs to execute:
API keys, tokens, endpoints, language, region, model, and similar facility values. It is neither a
Provider field nor a call parameter. A manifest declares `runtime_config { ref, fields }`; `ref`
is the persistence identity, so multiple Sources may intentionally share one facility config (for
example TMDb metadata and images). Values live in the private SettingsStore overlay, while the
manifest carries only the public schema.

The existing Source Config Sheet is the only editing surface. Backend Settings owns host/deployment
settings only. Secret fields are write-only: HTTP status reports whether a secret is configured,
never its value. Before execution, an adapter resolves the Source ref into a private execution
context. That context never enters Stream/Provider member params, cache keys, diagnostics, or item
storage. Login cookies remain separate: `auth.cookie` dynamically resolves browser cookies by domain.

### Self-Service Provisioning: Who Can Fill One Config Slot for the User

A config slot has declarations in two directions, and originally only one direction was usable: **needs** (a Source manifest says
"I need ref X") and **produces** (a recipe declares `extract` + its own `runtime_config`; after one run it writes the
one-time-display plaintext into X). The producing side used to have no index at all. The config UI only held "I need X" and could not look up
"who can give me X", so a self-service request that could run was effectively nonexistent in the UI.

The check is the named function **`provisionedConfigSlot`** (`src/replay/recipe-provisioner.ts`): canonical
browser recipe + `extract` + the target field is declared as `secret` in **its own** `runtime_config`. It is also
the binding check for the extraction sink (`SessionRecipeExecutor.sinkFor`): one check for both directions; do not write separate ones.
The numbers are pinned by `src/replay/recipe-provisioner.test.ts` (today exactly 4 built-in recipes produce 3 refs).

The reverse lookup index lives in the Source domain: **`SourcesService.configProvisionerFor(ref)`** (`src/kernel/plugins/sources.ts`).
It **only recognizes built-in-layer recipes**, mirroring the same reason as `secret_params` gate 3: otherwise a third-party package could merely declare
`runtime_config.ref: 'groq'`, and the built-in groq config card would grow a button that runs that package's code and writes the user's real key.

The HTTP surface has two slots, both mounted on that existing endpoint pair (no new read-only endpoint):
the receipt from `POST /api/source-runtime-config/status` gains a `provisioner` slot (`null` = nobody can help),
and `POST /api/source-runtime-config/provision` actually runs that recipe (`userInitiated: true`,
first-party UI path, same as `xhs-like`). **The success check is not request 2xx**: this kind of recipe is `allowEmpty` and produces no
item, so success and a no-op run look identical in the runner's receipt. Therefore, after the endpoint finishes running, it asks `secrets[field].configured` once;
if not true, it reports 502 and points to `failures/`. The UI is in the Source Config Sheet: when it hits "this key is required but missing",
it shows guidance once (two buttons: register myself = `helpUrl` external link / complete it for me in one click = run recipe),
and later returns via the button beside the field.

**The manifest side cannot read the recipe body**, so `recipeToManifest` projects the conclusion of this check into
`runtime_config.provisions` (`src/manifest/types.ts`): **derived, not handwritten by the package author**;
copying one into `meta` is stripped. `selfProvisionRecipesFor` (`src/auth/self-provision.ts`) only recognizes this slot.
Do not use "declared the same `ref`" as the check: that only means this Source is related to that config slot, and the direction may be opposite
(`eastmoney-login` declares `ref: eastmoney` in order to **read** the fund account / trading password entered manually by the user).

**There is only one implementation for run + verify afterward**: `provisionConfigSlot` (`src/credentials/provision-slot.ts`).
The endpoint above and the tool held by the model in chat both use the same function. Drift from writing the two sides separately is silent:
one side verifies, while the other describes a no-op run as "I have already applied for it for you".

**Two tools on the chat surface** (`src/mcp/tool-catalog.ts`, checks in `src/mcp/capability-gaps.ts`):

* **`capability_status` (read)**: "why this cannot be done, and who can fix it". The source of truth for availability is
  the `branches` on the extract row in `conversions.kinds()` (the backend uses exactly that to choose branches); **do not create another sniffer**.
  "Who can fix it" is found by reverse-looking up from the members of the Provider row that this capability rides: the declared cost ladder
  (`defaultMembers` in `SYSTEM_IDENTITIES`) ∪ existing members in the user's store, asking each manifest which
  `runtime_config` slot it needs. The declared half cannot be omitted: the `transcribe` row is built as "write whichever tiers have keys",
  and when there is no key at all, **that row does not exist at all**. A read-only store would answer "no members", which is true and useless.
  The receipt `state` has four tiers, each corresponding to a different next step: `ready` / `needs-key-self-serve` (missing key and a
  recipe can produce it → guide the user to choose one of two options) / `needs-key-manual` (missing key and nobody can produce it → only provide `helpUrl`) /
  `blocked-other` (**not missing a key**: ffmpeg is absent on the machine, proxy is empty, or the key is configured but the backend has not restarted).
  Listing the fourth tier separately is a hard requirement: telling it "I will apply for a key for you" points down the wrong path, and nowhere on that wrong path reports an error.
* **`provision_capability_key` (write)**: wraps `provisionConfigSlot` and **requires explicit second confirmation**
  (without `confirmed`, not a single step executes; same shape as `run_action_recipe`). The confirmation receipt must spell out the account-level side effect:
  in the user's own Chrome, using that user's account, create a real key; key creation is not idempotent.
  Live verification steps are in `docs/AGENT-TOOLING.md` §5.1.

## Ad filtering (fold, don't delete)

Item-level, deterministic, opt-in. Add an `ad_filter` block to `config.yaml`:
```yaml
ad_filter:
  keywords: [推广, 赞助, 恰饭, sponsored]   # vs title + body + source category tags
  domains:  [taobao.com, jd.com]            # vs item urls; also matches subdomains
```
Keywords also match the source's own `category` tags (RSSHub `item.category`) — the
high-precision signal: v2ex's 推广 ("promotion") node flags promos there even when the title looks
innocent. Caveat: broad topic words (`广告`) substring-match *news about* advertising
on news feeds — prefer ad-specific phrases and lean on category.
On ingest each item is checked; a match sets `muted: { reason: 'ad', rule }` on the
`StreamItem` (the matched rule is kept so the routing is explainable). Muted items are
**folded into a dedicated 广告 ("Ads") channel** in the sidebar (below the channel list) —
they still land in the read model and are kept out of All Latest and every stream view,
but one click on 广告 shows them. Nothing is dropped, so a false positive is fully
recoverable. A canonical default rule set ships built-in (`src/content/ad-rules.default.ts`);
config rules extend it. Classifier: `src/content/ad-filter.ts`; the channel is a
client-side virtual view (`app/src/lib/items.ts`, `ADS_CHANNEL`).

## Channel

A Channel (called `频道` ("Channel") in the UI) is what a user (or agent)
subscribes to and what every ref names. It is a **view**: it references its member Streams by id
(never owns them) and materializes on read — the referenced Streams' stored items are merged,
ad-filtered, and deduped on each item's cross-source ref. Items belong to Streams, not Channels:
a Stream referenced by several Channels is harvested once, on its own cadence, and its items are
stored once. A member that fails only *degrades* the result (fewer items) — it never fails the
Channel.

**Present** — one per Channel, an id into the official **Present registry**
(`src/providers/presents.ts`) — selects the full consumption mode: how data is acquired, how it
is rendered, and which capabilities attach. Every descriptor answers two orthogonal questions:

| Axis | Question | Values |
|---|---|---|
| `needsStreams` | Does this Present bind Streams? | true / false |
| `data` | How is the data acquired? | `collected` (Source -> harvest -> item store -> read store) / `live` (execute on demand when the request arrives, without writing to disk) |

|  | `needsStreams: true` | `needsStreams: false` |
|---|---|---|
| **`data: 'collected'`** | timeline / audio / video — regularly harvest into storage by cadence, and read from the store | — |
| **`data: 'live'`** | research — binds Streams, but each request reads the Source of the Stream member on demand, without writing to disk | search — binds nothing, dispatches the query to search Providers at call time; tasks — the execution ledger for the scheduling engine; embed — an external web page |

- **Timeline** — members are harvested on schedule and shown as a merged feed.
- **Search** — no standing harvest; a query dispatches to search **Providers** at call time.
- **Audio** — members produce playable playlists; playback/download capabilities (audio
  **Providers**) attach.
- **Video** — members produce work/episode rows; video resolve, resource search and detail
  enrichment **Providers** attach.
- **Research** — a Channel binds a Stream whose member Source points at a `cockpit_sdk` run
  artifacts directory; a general live-list face (`GET /api/live/streams/:streamId/items`) reads
  that directory fresh on every call and returns one row per run — no harvest, no storage. Run
  detail (manifest + individual artifacts) does **not** ride the same general face: a list is
  structurally the same shape across every live Present, but a detail view is not — video's
  detail is a player, research's is a manifest-driven artifact grid. A single columnar frame
  abstraction general enough to carry both would end up carrying neither well, so detail is not
  generalized at all: research gets its own two routes
  (`GET /api/research/streams/:streamId/runs/:runId[/artifacts/:name]`,
  `src/http/research-routes.ts`) that mirror Cockpit's own `/api/runs/{id}` shape verbatim.
- **Embed (external panel)** — one Channel = one external web page: `options.url` (an absolute
  http(s) URL, validated on write) is rendered as a full-pane `<iframe>` (`embedMode` in
  `app/src/panel/StreamPanel.tsx`; sandbox allows scripts/same-origin/forms/popups since the
  page is a user-configured trusted dashboard). No Streams, no slots, no local data; a missing
  or non-http(s) URL shows an explanatory placeholder, never an empty frame. The URL is edited in
  the Channel's config tab via `PRESENT_EXTRAS.embed`. Design:
  `internal design record`.

A Present descriptor is `{ id, label, needsStreams, data, slots }`, where `slots` is the set of
Provider **Callsites** that surface on that Present's channels (derived by grouping
`PROVIDER_CALLSITES` entries — the callsite list is the one source of truth, the Present
registry only aggregates it, it never double-declares slots). `GET /api/presents` exposes the
registry. *Status note: the current code models this as `ChannelRecord.present: 'timeline' |
'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'` (`src/store/types.ts`); all seven
official Presents are built-in — no user-defined/plugin Presents yet (see
`internal design record` §9 non-goals).*

**Channel-level slots** — a Channel's `options.slots: Record<callsiteId, providerIds[]>`
overrides the global Callsite→Provider binding *within that Channel only* (e.g. an NSFW
Channel's `search.resources` slot routes to a Channel-specific search Provider while every
other Channel keeps using the global default). Slots are validated with the exact same rule as
a global binding (`ProviderBindings.validateSelection` — fixed needs exactly one compatible
Provider, dispatch needs ≥1, variant must match); a Provider referenced by any Channel's slot
cannot be deleted until the slot is cleared (see Provider below).

**Broken slot = loud error, never a silent fallback (spec §5.1).** A filled slot is explicit
user intent, so if none of its `providerIds` resolve to a usable row (all parked or deleted),
resolution does *not* fall back to the global binding or a hardcoded default — it throws
`SlotBrokenError`, which the HTTP layer turns into `422 slot_broken` plus a `provider.slot_broken`
Bell event (the resource-search UI additionally shows a toast); see [API.md](API.md).

Resolution order: Channel
slot (if the calling HTTP endpoint carries a `channelId` and that Channel has the slot filled)
→ global binding → none.

**Management surfaces derive from the Present descriptor** (2026-07-25): the in-context
`ChannelManageSheet` (`app/src/components/manage/`) renders its sections from a Channel's
`{ needsStreams, slots }` — a subscription section iff `needsStreams`, one provider selector per
declared slot, plus a `PRESENT_EXTRAS` registry as the seam for future Present-specific
sections — and `SlotSwitcher` edits the same `options.slots` inline at a callsite's own UI
surface (v1: the resource-search results surface only — `search.resources`, not `search.video`;
changing the provider re-runs the query, and a
`422 slot_broken` puts the chip in a warning state — the streamed resource search resolves the
slot *before* opening the NDJSON stream and fans out over the resolved row's members, so both
halves are real). The Plugins/Channels/Providers pages are unchanged in function but demoted to
a collapsed sidebar group (`nav.manage`, default-collapsed unless one of those three views is
active; when the sidebar itself is collapsed to icons the group drops the collapsible wrapper
and the three entries stay as always-visible icon buttons — a collapsed group inside an icon
rail would be unreachable) — they remain the inventory for objects with no
browsing context (an unreferenced Provider, a plugin container, a not-yet-subscribed Channel).
Design: `internal design record`.

## Stream

A Stream is a scheduled feed unit: at each cadence tick the scheduler runs it with **no
call-time input** and it produces items, stored under the Stream's own id. Streams have global
identity and are freely reusable across Channels (harvest once, view anywhere). A Stream
aggregates ≥1 Sources under one `strategy`:

- **`fanout`** — harvest ALL member Sources, merge + dedup (a discovery feed spanning several
  platforms).
- **`exclusive`** — members are a priority ladder; only the first Source that successfully
  responds wins (one podcaster's playlist reachable through two mutually exclusive RSSHub
  routes). Health is tracked per Source in a global ledger (`src/source-health-store.ts`);
  degraded/dead members are skipped and re-probed.

Both strategies return the same shape (a batch of items); they differ only in the combine rule
(union vs first-success). That is why they are one concept with a strategy field, not two
concepts.

**Storage shape** is a second, independent axis: `mode: 'feed' | 'collection'`.
`scheduler.modeOf(streamId)` is the sole authority — a Stream's own `mode` wins when set, else
it derives from any member Source's manifest declaring `mode:'collection'`, else `'feed'`:

- **`feed`** (default) — an unbounded timeline: each harvest persists only genuinely-new items
  (dedup-gated append), and ItemStore evicts down to a rolling per-stream cap (`capPerStream`,
  500) so storage stays bounded.
- **`collection`** — a bounded upstream set (a playlist, a podcast's full back-catalog, a
  favourites list, a ranking board): each harvest re-fetches full depth and the result is
  written via `ItemStore.replaceStream` — the stream's stored items are rebuilt wholesale in
  upstream order, not gated by dedup — and the Stream is excluded from the all-latest timeline.
  Replacement is **per member source's shard**, and it is **not unconditional** — see below.

**Collection replacement has two gates** (`src/collection-replace-guard.ts`, 2026-07-30 spec). An empty snapshot
has two completely different possible sources, but the replacement layer sees exactly the same shape: upstream is truly empty (should replace) vs upstream glitched / this round
harvested nothing at all (replacement = data loss, 2026-07-24 Yile 1015 items). Therefore:

1. **The harvest side provides a success pointer** — `AdapterFetchResult.authoritative` (defaults to true). Error paths keep throwing;
   decline paths (environment absent / Browser-Fallback off / isolated) return `authoritative:false`. Non-authoritative results
   **do not replace shards, do not enter the request cache, and do not record health**; they only make noise through `onHarvestSkipped`.
2. **The replacement side catches "nearly all empty"** — when the result is authoritative but the new snapshot has 0 items while the old shard has data, the first round only holds the shard without replacing it, and it only truly replaces after **two consecutive rounds**
   say the same thing. A real clear only takes effect one round later. It deliberately **does not block by shrinkage percentage** (that would wrongly catch real large deletions).
   The armed bit is per (stream, source), persisted in the `collection_guard` table in `stream.db`.

Both layers make noise through the general event layer (`harvest.snapshot-held`), and the terminal `reason` is encoded into `dedupeKey`.

`strategy` (how members combine) and `mode` (how the result is stored) are orthogonal — a
`collection` Stream can still be `fanout` or `exclusive`. **There is no `Stream.kind`**, and
nothing else implies collection-shaped storage on the side: not an `audio` flag, not
`manifest.ordering==='snapshot'`, not an item-count ceiling. `manifest.ordering:'snapshot'`
exists ONLY as a loader read-alias to `mode:'collection'` (`src/manifest/loader.ts`). Consumption
routing — which view a Stream's items render in (timeline feed vs audio player) — is a
**separate** authority: `Channel.present` (see Channel above).

## Provider

Provider implementation selection is not determined by a Provider id hard-coded by the caller. Code declares a stable **Callsite** contract (input/output, variant, fixed or key-based dispatch); `stream.db.provider_bindings` stores user-editable references from Callsites to Providers. The caller resolves the binding first, then reuses the same `ProviderExecutor.invoke()` / `collect()` for execution. This keeps the Source order inside a Provider row and the Provider routing order of a dispatch Callsite independent at two layers, while references can be looked up from either end. A Provider referenced by a binding cannot be deleted; built-in default Providers/bindings can be restored, but they are not permanently locked rows.

**Channel-level slots override the global binding (2026-07-24)**: `ProviderBindings.fixed()`/`.dispatch()` both accept optional
`{ channelId }`; when it is present and that Channel's `options.slots[callsiteId]` is non-empty -> use the Provider set specified by the slot instead of the
global binding (parked rows are filtered on the slot path as well, with semantics consistent with the global binding); without `channelId`, or when that
Channel has not filled this slot -> fall back to the global binding, with behavior unchanged. At the HTTP layer, only callsites that carry Channel context (Video Present
search/playback resolution, music playback resolution, etc.) upload `channelId` in the query string; callsites without
Channel context, such as MCP global search and radar enrich, do not pass it and always use the global binding. Call counts are still recorded only inside the executor, and the slot path is covered by the same counting.
A Provider referenced by any Channel slot cannot be deleted under the same rule as a Provider referenced by a binding (`DELETE
/api/providers/:id` returns `409 error.details.channels` listing the referencing Channels + callsites).

**Broken slot = explicit error, never silent fallback (spec §5.1)**: a slot is explicit user intent. When no usable row can be selected from the slot
(all parked/deleted), do not fall back to the global binding and do not fall back to the default value hard-coded by the callsite -- throw `SlotBrokenError`.
The HTTP layer catches it and converts it to `422 slot_broken` + a `provider.slot_broken` Bell event (Bell covers all endpoints;
the toast is currently wired only on the resource search surface, and the remaining endpoints rely on Bell).

A Provider is a **global, call-driven, on-demand capability**, expressed as **one config row**
(isomorphic to Stream; design converged and landed on 2026-07-03):

```
Identity (category / serves key / fallback / strategy / contract / expand)
  ├─ System Provider: lives in code -- one module per row under src/providers/system/ (SYSTEM_IDENTITIES static table);
  │   identity fields on the row are only persisted copies; both read and write sides treat code as authoritative (PATCH identity fields -> 400 loud rejection)
  └─ User-created Provider: lives on the row (it has no code)
Orchestration (members / options / binding): always lives on the stream.db row, user-editable and shareable
Callsite = its own category (compile-time identity) + routing-key extractor function (input -> key) + one invoke()
Dispatch = ProviderDirectory.match(category, key, {fallback}) -- the only entry point for row-selection checks:
         named serves key hits have priority; when there is no hit, only callsites that explicitly pass fallback:true fall to the fallback row,
         and hit results carry viaFallback into the ledger/DebugBox. '*' is only the online/persisted shape of the fallback boolean.
```

- **variant** determines the input/output signature and default strategy: `search` (query term -> item list, concurrent merge),
  `resolve` (key -> one object, sequential first win), `download` (ref -> asset, sequential + contract),
  `transform` (content -> content, sequential). `timeline` is not a variant -- that is Stream.
- **members** have four forms: `{source}` explicit Source member, `{matches}` radar match segment (real-time expansion of Sources hit
  by URL pattern), `{mode:'auto', provides:X}` derived segment (Sources that declare `provides: [X]` are expanded into the row in real time, and newly installed
  plugins are added automatically), and `{provider}` **composition member** (one Provider references another Provider). The first three all expand
  to Sources; `{provider}` is a **composition closure** -- the executor **recursively `invoke()`s** the child Provider (black box: the child's
  strategy/gating/deduplication are the child's internal semantics, and the parent layer does not copy them), and the child's items-shaped results merge into the parent. Recursion carries the access path and **prevents
  self-reference/cycles/excessive depth** (`MAX_COMPOSITION_DEPTH`; exceeding it throws and does not enter an invoke loop); a Provider referenced
  by a `{provider}` member cannot be deleted (isomorphic to binding reference protection). Member parameters declare binding through `$input` holes, and input values are supplied by
  the callsite at invocation time -- binding belongs to the row definition, input belongs to the callsite. If the input supplied by the callsite is a **plain object** (for example
  `{vid, format}` from `video.resolve`, or `{url}` from `content.enrich`), non-builtin members receive an
  empty key + the entire object spread into `params` (`memberCallArgs`, `src/providers/invoke-types.ts`);
  builtin member implementation functions receive the entire input object directly.
- **Claim -> dispatch: links are claimed first, then dispatched by key**. A callsite such as "the user pasted a link" has two steps: **claim** answers which package,
  which platform, which type, and which id this link is -- there is only one table (each package's `stream.links`) and one function (`recognizeLink`,
  `src/links/recognize.ts`), and the host does not know any site; **dispatch** builds a key from the claim result (`<platform>-<noun>`: `content.enrich`
  uses `<platform>-link`, `video.resolve` uses `<platform>-video`, and song retrieval uses the platform key), then hands it to the Provider row that declared that key.
  No declaration writes a key shaped like a domain name. Links that nobody claims go through the host's generic fallback (direct media link / webpage body). Track recognition and download transit pages
  also consume only claim results. `radar` (which Source this page can be subscribed as) and `serving` (how bytes from this CDN host are served) answer different questions
  and are not in this table. Declaration shape and validation are in [PACKAGE.md](PACKAGE.md) §0.5 "`links`"; design is in
  `internal design record`.
- **Multiple-instance members and per-instance key** (LLM normalization, 2026-07-27): a `{source}` member may optionally carry `name` --
  the same Source can appear multiple times in one row, each with different `params`; addressing keys (deduplication, sorting,
  `options.exclude`, call ledger) always use `name ?? source`, not the bare sourceId. The `llm` row uses exactly this:
  `llm-openai` (OpenAI-compatible Source) is configured with multiple instances, each of whose `params.{baseUrl, model,
  tokenName}` self-sufficiently describes an endpoint, without shared config. The key lands on the **member instance**, not the whole Source: for a Source whose manifest
  declares `runtime_config.perInstance: true` (today only `llm-openai`), a key is stored at the layer pointed to by
  `params.tokenName` (convention: `<ref namespace>:<instance name>`, for example `llm:<instance name>`), not at
  the `runtime_config.ref` layer -- `resolvedMembers[].keyState` from `GET /api/providers`
  (`stored`/`env`/`missing`) is fetched from exactly this layer by `keyRefOf` (`src/credentials/key-state.ts`), so one
  instance missing a key does not implicate another. Callsites (`llm.summarize`/`llm.chat`/`netdisk.spec.suggest`) can carry
  `params.model` on the binding as an override, which wins over the member's own default -- model choice is therefore delegated to "which
  model this invocation wants", not "which model this connection fixes". Note that `params.model` **only changes the model name, not the endpoint and key**: switching to
  another provider (another baseUrl + token) is "switch member", not editing this override. The chat channel switches this way: each
  session records a **member key** (`member` from `GET /api/agent/models`, stored on `model_member` in the session table),
  and the switch in the lower-left of the input box writes it; it stores the key, not the model name. The model name is the member's own parameter and can be changed. **Invariant**: instance names and the real source ids
  expanded by auto segments (`{mode:'auto', provides}`) share the same addressing namespace -- when `name` collides with any registered source id, the write side rejects it
  (`422 name_shadows_source`), because once addressing keys collide the real Source is silently displaced by this instance, behavior becomes abnormal, and the UI
  cannot show it (`name` equal to its own `source` does not count as a collision and is equivalent to omitting `name`). See the "LLM
  settings" section in [API.md](API.md) and `internal design record`.
- **strategy `expand`** (dependent A->B combinator, provisional): applies to ordered two-member `[A,B]` -- invoke A ->
  parameterize B for each A-item(handle) through **pure field access** from `$item.<field>` in `expand.map` (without introducing arbitrary evaluation,
  preserving the red line that "data does not get ambient capability") -> invoke B -> assemble B's items into that entry's
  `links[]{url,type,desc}` through `expand.assemble`. Bounded concurrency + handle cap + per-drill failure/timeout skip. The contract is set to be sufficient for the first consumer
  (btbtla: search yields season cards -> drill each detail page to retrieve download rows, producing the pansou multi-link shape), and awaits convergence from a second sample.
- **Two member result shapes** (2026-07-17 capability normalization): **items shape** = item array (`[]` = decline,
  as in all existing members); **object shape** = one decision/result object (`null` = decline; probes and resolvers -- decisions
  do not wear an item costume). The shape is declared by the Source's `manifest.output` (corresponding to
  `output:'object'` on the recipe side), and the executor stitches in unpacking. Members of the `resolve` variant should be object-shaped (key -> one
  object is its definition in the first place); existing array-shaped resolve members are migrated opportunistically.
- **contract**: a named result acceptance check (for example `{accept:'lossless'}`) -- non-conforming results are treated as misses and fall through.
- Runtime is **one executor** (`invoke()` in `src/providers/executor.ts`): the sequential branch has three kinds of misses that fall through --
  decline/contract rejection/thrown error -- and returns the first acceptable result with `via`; the concurrent branch merges all members and
  assigns ownership per Source. **Call counts are recorded only inside the executor** (`cache.db.provider_calls`), and the management page uses this to verify
  whether a callsite really went through a Provider row.
- **Execution strategy is a swappable registry** (`src/providers/strategies/`, with three built-ins: sequential/concurrent/expand;
  `BUILTIN_STRATEGY_NAMES` drives write validation) -- adding a new strategy does not change the executor body. Cross-cutting concerns
  (timeout / classification / health accounting) do not live in any single strategy; they are centralized in the single-member pipeline `member-pipeline.ts`
  (the only opening that touches members), and the three strategies share the same one. **Degrade is read as circuit breaking, not reordering**: order is always the original order
  defined in the row, and `SourceBreaker` only uses the health ledger to decide "whether to try this member this time" (only errors/timeouts count; empty results do not trigger it;
  cooldown increases with consecutive failures and has a cap; it never permanently degrades). The authoritative design is in
  `internal design record`.
- **`ResolveEngine` (`src/resolve/engine.ts`) consumes the same kit**, not a second separately written ladder:
  `resolve()` is original-order fallthrough + the same `SourceBreaker` decision (the whole table goes through `plan()`: skip entries in cooldown; when all are cooling down,
  forcibly try the tier with the **shortest** remaining cooldown -- one call always truly probes at least one tier). There is only one implementation
  of that fallback invariant (`forceProbeShortest`), and the sequential strategy consumes the same one -- its per-member `admit` exists only to exempt composition members.
  Member calls go through `member-pipeline.ts`.
  **Timeouts only consume `member_timeout_ms` self-reported by the manifest; there is no global default** -- all resolve callers are interactive
  (`GET /api/resolve`, MCP `resolve_target`; periodic harvest uses `Scheduler.fetchSource` and does not go through here),
  and they can indeed be dragged down by a hung Source. The reason a global gate is still not set is that the wall-clock cap currently has two coexisting tables, and which layer owns the value must be decided together with
  the `project planning record` item; adding a third number first would only create another system. The resolve rule "empty = this tier cannot answer this key,
  fall to the next tier" stays as-is, and empty never triggers circuit breaking.
- **`collect()` is not a second semantics; it is another result shape under collect-all (concurrent) semantics**: `invoke()` merges acceptable results
  into one items array, while `collect()` preserves the paired structure of "which member produced which payload" for callsites that **merge fields by source**
  (the three-line video details case is exactly: TMDb and OMDb must both run, then fill gaps in declaration order). Under sequential (first win stops) semantics,
  collect is self-contradictory -- "ask one by one but stop for none" is not sequential, it is concurrent. Both sides reject loudly: at executor dispatch,
  missing `strategy.collect` throws (with strategy name and row id); on binding write, the `collect: true` marker in `PROVIDER_CALLSITES` plus
  `ProviderBindings.validateSelection` rejects early (global binding and Channel slots share this rule, and slots do not create a separate rule) -- do not let
  "a first-win row was bound" explode only when the detail page actually fetches data.

The litmus test against Stream is **trigger + result ownership**, not parameter count. A Stream is
time-driven (T1) and persists feed items; a Provider is call-driven (T2) and returns results to its
caller. A Provider invocation carries no durable per-call state in the user-data model, but its

### Video detail enrichment

Video work details keep the same ownership split: a Stream owns discovery, episode rows, and
availability (netdisk, magnet, external link, or a future local playback Stream). Discovery only
stores its list-facing facts (`videoRef`: title, explicit work year/kind, source URL, and native
authority IDs). It never triggers metadata traffic.

Netdisk availability, however, does not *require* a Stream. A binding's left side is「where the
episode list comes from」, a discriminant -- not「a subscribed Stream」. `left.kind:'stream'` reads
the list from ItemStore; `left.kind:'tmdb'` reads it from the TMDb authority, so an un-subscribed
movie or series binds a netdisk folder and plays without ever becoming a Stream. The alignment
engine never learns which -- it only ever consumes `LeftEntry[]`. This does **not** introduce a
sixth top-level concept: 「a film」stays un-modelled (its identity already lives, cache-shaped, in
`video_details` keyed `tmdb:<id>`); the discriminant names a *source*, not an entity. Design:
`internal design record`.

Enrich has **two trigger points**, both landing on the same cache: opening the detail page (run on the spot on cache miss), and **the moment harvest writes an item into
the read model** (`VideoEnrichQueue`, attached to the Scheduler's `onItemPersisted`, scoped to member
Streams of video Channels). The latter is the source of list-side covers and Chinese names -- a Source that has only a one-line title (such as an awards list) cannot provide an image itself. If it is not
enriched during harvest, works that have never been opened stay gray boxes on the wall forever. The queue only requests identities whose cache has expired, deduplicates by cacheKey,
and logs failures only: it is a background action and is not allowed to slow down or bring down a harvest round.

On a detail cache miss, the `video-canonical` resolver receives those facts and verifies an
authority-side TMDb/IMDb reference without fetching the discovery page. Its evidence may include
localized titles, aliases, explicit year/kind, and normalizer-provided people; a non-verifiable
candidate is a miss, never a fuzzy substitution. The `video-metadata` Provider and then the
`video-images` Provider receive the resulting confirmed IDs to supply normalized metadata,
posters, backdrops, and logos. Member order is merge priority even when a Provider is concurrent.
The combined result is cached in `stream.db` table `video_details`, keyed by the discovery lookup
so the next detail open returns without another Provider call. Future local embedded artwork and
screen grabs join `video-images` as Sources--no Stream or detail-page rewrite. Ranking feeds,
including Douban rankings, remain discovery inputs rather than detail metadata Sources.
implementation MAY reuse a facility-scoped runtime resource such as a logged-in browser session.
It MAY also be parameterless: Home recommendation is the canonical example.

*Landed scope of the row model: `stream.db.providers` stores the whole row; `/api/providers` provides full CRUD + match preview;
audio dual-chain / three search types / magnet / enrich-url / ResolveEngine all execute through rows and are counted. Capabilities that **do not yet** go through rows:
parse(MinerU), transcribe(ASR), enrich aggregation, summarize(LLM) -- their "async queue + write to disk" shape
does not fit invoke, and the management page's "pending migration" area marks each call location.*

### Video Page Resource Finder

Episodes bound to AList go through `gateResolveOnlyVideoMedia` (`src/content/video-playability.ts`): episodes that the alignment executor
matches to files are playable; unmatched episodes are a gray `网盘未匹配` ("netdisk unmatched") card. The `找资源` ("find resources") button on the gray card goes straight to the existing
`/api/search?scope=resources&stream=1`, and the video secondary-page hero has another same-named entry point at whole-series scope.

**Deduplication is backend-side, filtering is frontend-side** -- they are different kinds of things; do not merge them:

- **Deduplication is a data-quality issue.** `resource-search` deduplicates across Sources (`Deduper` in `src/video/dedupe.ts`, with the key
  supplied by `dedupeKey`: magnet uses btih, ed2k uses file hash, netdisk uses share ID). It is inserted between `extract -> aggregate`,
  and the batch path and streaming path share `facetOneSource` from `src/video/facet-source.ts`. Duplicates are dirty for everyone,
  so the AI path through MCP `video_search` benefits as well. The order semantics of the two paths are **intentionally different**: the batch path follows Provider
  member declaration order (deterministic), while the streaming path follows arrival order (first-come, first-served -- waiting for all results to honor declaration priority would destroy streaming).
  `VideoSourceTiming.dropped` separates "all were duplicates" from "no results"; otherwise a Source whose results are all duplicates would falsely report `status:'empty'`.
- **Filtering is a view issue of "what can this machine use".** Allowed set = `searchableSourceTypes` from `GET /api/netdisk/mounts`
  (`src/netdisk/source-types.ts`: magnet/ed2k unconditionally + types mapped from AList's **actually mounted**
  drivers). The source of truth is `listStorages()`, not `MOUNT_PRESETS` -- presets are only the mount
  helper's checklist, and manually mounted Baidu/Ali should be recognized too. Filtering happens in `app/src/lib/resourceFilter.ts`, walking
  `links[]` **link by link** (one pansou message often carries mixed-type links; filtering by item would wrongly kill a result whose "first link is Baidu, but it also carries Quark"),
  then mirrors the surviving first link back into `link`/`sourceType`/`password`. If AList is unreachable -> fall back to `{magnet, ed2k}` and mark degraded.

The results panel is `app/src/components/ResourceFinder.tsx` (flattened facet tree, one-click copy); `VideoChannel`
mounts in global search and is another entry point.

**For the link -> file segment, netdisk episodes are connected, but magnet/ed2k are not yet.** Search returns links, not files: netdisk links become files through
save (the user manually clicks `转存` ("save"), or the follow loop automatically saves missing episodes; see the "Follow Loop" section), while magnet/ed2k still
have no downloader to catch them and cannot land. Once a file lands on AList, the latter half (alignment executor -> resolve URL -> gray card becomes live)
works. Live verification = recipe (hot-swappable data; quark/baidu both use this path), save = code (implementation choice, not a prohibition -- the policy for the write-effect
tier is "recipes may also write accounts"; see the "Capability Normalization" section).
Design is in `internal design record`.

### Reconciler: after files land in the netdisk, who moves them to the right place

Saving only places files into the shared upstream directory; "identify it by episode identity, fold it into the claimed shelf or secondary shelf, choose the best among multiple copies of the same episode,
and silently clear true duplicates" is another piece of work, living in `src/netdisk/reconcile/` -- a three-layer model. **The object being organized is a binding**,
not "a show": video one-click dedupe is a degenerate configuration with no staging area and no secondary shelf, sharing the same code as podcast organization,
not a parallel implementation.

- **There is only one brain for episode claiming**: "which episode is this file" is answered by the **binding matcher** (`src/netdisk/match-engine/`:
  the evidence layer collects all facts -> the adjudication layer decides by rule table R1-R14, duration as primary anchor + name floor + threshold system;
  see `docs/MATCHING.md`). The spec it uses is the same one binding sync uses
  (`resolveSpec` in `sync.ts`). **The reconciler must not have its own decision logic** -- it only turns conclusions into actions.
  To change the decision, change the spec, and binding plus reconciler change together.
- **Grouping key** (`makeIdentity()` in `src/netdisk/identity.ts`): built-in generic cleaning (watermark/noisy bracket notes/punctuation/
  variant-character normalization/lowercasing) + title-prefix stripping and episode-number regex from the binding `MatchSpec`. It **only produces the grouping key**: manual exemptions
  are stored by it, and byte-identical duplicates use it to decide "whether this is the same episode".
- **Input pool**: source directories (read-only scan, `sourceDirs`, **optional** -- when absent this is in-place mode, which only picks winners from files already on the claimed shelf
  and decides deletion of losing copies, with no moving) **union existing files on the claimed shelf (`claimed`)** -- whether the copy inside the library is
  this episode can likewise only be answered by that one matching brain. The secondary shelf (`secondary`) does not enter the pool (its contract is "does not pair"),
  and is only used to decide byte-identical duplicates and same-name placeholders; if this binding has no `secondary` (such as video), this layer does not exist.
- **Archive**: `buildPlan` in `plan.ts` is a pure function. Its order is exemption/tombstone -> byte-identical duplicate (`delete-dup`) ->
  run the matcher once -> four buckets (`claimed` goes to the claimed shelf, `offline` goes to the secondary shelf -- when `secondary` is not configured,
  keep the decision recorded and leave in place; `copy` passes three gates (the rightful copy is on-shelf, quality is comparable, and it matched an episode before it counts as a duplicate) -> decide
  `delete-loser` (for the same episode, keep only the highest-quality copy; when quality ties, keep the copy whose **name matches this episode title**, with the check in
  `docs/MATCHING.md`); if any gate fails, send to human adjudication as a side-by-side `compare`; `hold` means duration is unknown and probing continues next round).
  Only after that does `execute.ts` truly call AList move/remove according to the plan. Design is in
  `internal design record` and
  `internal design record`.
  - **There are only three destinations**: claimed shelf, secondary shelf, subprogram directory (plus the two deletion actions `delete-dup`/`delete-loser`,
    which are not "where to move" but direct removal). A subprogram (independent numbering system + independent folder)'s `numPattern` **only chooses
    the destination and does not exempt matching**: a hit merely changes the landing point of `claimed` from the claimed-shelf root to the subprogram folder, while the claim itself
    is still decided by the matcher. Making "name hit means claimed" into a pre-pass is a second decision brain -- a mismatched file would be claimed by name
    and stay in place, while the correct copy would remain forever in `swap-hold` waiting for a position that never clears (deadlock).
  - **The real contracts of the two shelves differ**, but their names describe provenance, so translate once while reading: `claimed` = **things that should pair with
    the program list** (the binding's landing directory; only this is seen by the matcher; podcasts and videos both always have it); `secondary`
    (in podcast scenarios, `下架` ("taken down")) = **things that do not pair and whose file itself is an episode** -- it is itself harvested as an alist source
    (`packages/alist/normalizer.ts`), and each file directly becomes a playable item. So "move to `secondary`"
    does not make the file disappear; it moves it to another path. This is also why "not matched" can be an automatic and safe default result.
    `secondary` is an optional concept -- video does not have it, and unrecognized files stay in place and are never deleted.
  - **The addresses of the two shelves are not in reconciler config** (spec §6 P8): the address of `claimed` is the binding's `right.path`
    (the binding belongs to the resolution layer, and its job is to supply audio/video for paid episodes); the address of `secondary` is the directory scanned by that subscription's **taken-down
    stream** (taken-down episodes are a supplementary source for the authoritative list, and are themselves a Stream scanning the netdisk). The reconciler resolves them on each round
    (`ReconcileService.shelvesOf`), and config only has `sourceDirs`. A binding whose left side comes from TMDb
    (`left.kind:'tmdb'`, typically video) naturally has no concept of "taken down", so `secondary` is empty and that is not an error; but if the left side
    comes from a subscribed Stream (`left.kind:'stream'`) and the taken-down source cannot be resolved, or its address collides with a source directory, stop and report an error instead of
    filling in a path from elsewhere: without a directory scanned by a Stream, moving files there makes them unplayable and absent from every list, which is equivalent to making them
    disappear from the user.
  - **`durationS === undefined` means "not probed", not "duration mismatch"**: it can only enter `hold`, never `offline`
    -- otherwise one expired Quark credential would move a batch of good files off the shelf.
  - **Never move into a directory that already has a same-named file**: `executePlan` groups moves by `(srcDir -> dstDir)`, and order between groups
    is not guaranteed, so cross-moves in the same round can collide by name. On collision, degrade to `pending swap-hold`, and the next round naturally lands it -- **unless the placeholder
    is deleted unconditionally in this round**, in which case it is promoted back to `move` and carries `evicts`; the executor deletes first, then moves, and if deletion fails this
    move does not run either (slot swapping; check in `docs/MATCHING.md`).
  - **Multi-season video bindings (`left.kind:'tmdb' && media:'tv'`) use a separate rule set for landing points and renaming**: claimed episodes do not land at
    the claimed-shelf root; they land at `tv-<id>/S<nn>/` (`<nn>` is the season number from the leftKey assigned by the matcher, zero-padded to two digits).
    On `auto` claim, prefix the file name with `S03E14 - ` (the original name follows unchanged; never stuff the title into it -- the reason for harmony avoidance
    is unchanged). If the **correct** prefix is already present, do not change it. If the prefix **conflicts** with the engine's decision (the name says S03E14, while the engine judges it as
    S03E15), emit `pending` (`evidence-conflict`) and do not move or rename -- when the name and engine conflict, the machine must not unilaterally
    rewrite evidence. The criterion for "same episode" also changes: files matched to an episode are judged same-episode by the leftKey assigned by the matcher (`tmdb:<id>:S03E14`);
    two cross-season files both named `第7期` ("Episode 7") naturally do not collide. Files not matched to an episode stay in place and only perform byte-identical dedupe within the **same directory**
    (`delete-dup`), and never participate in `delete-loser`/`replace` -- a losing copy only counts if the engine identified it as the same
    episode. The reconciler and binding sync **use the same season-partitioned matching path** (first decide the season by leaf folder, then match each season separately;
    see "multi-season video archive" in `docs/MATCHING.md`) -- a single pot of adjudication would judge cross-season same-period files as the same episode. File names
    containing `纯享` ("pure version") are another playback line, not that episode: they go into `tv-<id>/纯享/S<nn>/`, with no numbering prefix,
    and do not go through the losing-copy path either (unless the engine recognizes one as the rightful copy of a certain episode, in which case it is that episode).
    Renames (`rename` action), like moves, record provenance first. All actions in one round share one `run_id` and can be undone as a whole round
    (`POST /api/netdisk/reconcile/undo-run`, descending by rowid).

**It is reconciliation-style, with no independent progress ledger**: the source directories themselves are the pending-processing queue. Each round scans again and decides again; idempotence relies on the filesystem
state, not a record of "where the last run got to" -- this is also why `runScheduled` can rerun the whole set every day without aligning a resume point.
`service.ts` writes three kinds of state, all in `data/netdisk.db` (the netdisk domain has one domain database, alongside `stream.db`/`cache.db`
-- seven tables total for bindings / binding entries / organization config / adjudication / ledger / audit / duration cache; design is in
`internal design record` §4; the external APIs of each Store
stay unchanged, only the substrate changes):
**decision ledger** (`decisions` table, manual `exempt`/`tombstone`; on hit, skip without moving or reporting) + **provenance**
(`run_actions` table, one row per move/delete, carrying matching `basis` and supporting `undo`) + **run ledger**
(`reconcile_runs` table, one row per preview/execute, also copied as-is into API responses). The run ledger is the only landing point for "what exactly happened in this round":
each file entering the round has exactly one row (including no-op rows), `conservation` proves
`input === sum of buckets`, `authority` records list count/paid count/duration coverage, and `errors` collects probe failures and AList
errors -- **errors are rows, not logs**. Two additional fields control "whether this round counts": `trigger` (`'scheduled'` /
`'manual'`) and `gated` (the round blocked by the list-health gate, with `reason` + `detail`). **The authoritative-list health gate uses them
to pick the baseline** -- only scheduled rounds and manual executes that were not gated can serve as the baseline; the check is in the
"how the reconciler degrades when input is distorted" section of `docs/MATCHING.md`.

Default is **observe mode** (`autoExecute:false`): scheduled jobs only report counts and do not move files. A human must explicitly confirm
`execute` in the UI (or later configure a show as `autoExecute:true` so it truly lands automatically -- but deletion actions, even with
`autoExecute:true`, must still pass one "to-delete list" preview confirmation; moves and byte-identical duplicates are not blocked by this gate). Routes:
`/api/netdisk/reconcile/*` (config/preview/execute/undo/provenance/decisions; see
`src/http/netdisk-routes.ts`); also `/api/netdisk/reconcile/bindings/:bindingId/preview|execute` --
without relying on a preconfigured organization show, it runs one-click dedupe directly for any binding (UI entry points: MovieChannel work binding menu,
organization panel `扫全部绑定去重` ("scan all bindings for dedupe")). The scheduled task `netdisk-reconcile` (`0 30 3 * * *`, mutex group `netdisk` --
sharing the same login state with netdisk sync and the follow loop, so only one runs at a time; see the "Scheduling Center"
section) runs `runScheduled()` once a day and summarizes one notification per show (`dedupeKey: reconcile:<show>`) --
a scheduled round never deletes lower-quality losing copies of the same episode by itself; it only reports counts.

### Follow Loop: find resources -> fill missing episodes -> put them in place, while the human flips one switch

TMDb TV bindings have a `追` ("follow") switch (`MappingSet.follow.enabled`): newly created tv bindings default to on; migrated existing bindings
default to off; movie bindings never have this field. For shows where it is on, the system decides by itself which episodes have aired but are not yet acquired, revisits known
shares, searches for new shares if none are found, saves only the missing episodes, syncs and files them into place, and pushes the result as a notification -- the human does not click search or save,
only decides whether to follow. The implementation is in `src/netdisk/follow/`: pure policy lives in `plan.ts` (no I/O), and execution lives in `service.ts`.

**The check for aired but not acquired is**: `entries` has no claimed file, `airDate` exists, and `airDate <=` today.
**Missing `airDate` does not count as aired** -- when TMDb provides no date, prefer missing the follow; do not use "absent" as "not aired" as an excuse, and do not
treat it as "already aired" and search blindly.

One round (`FollowService.runOnce`) proceeds in order:

1. **Sync + calculate missing episodes**: first run `sync` once to get the latest episodes and current pairings, then calculate `missingAired`. Empty -> this round ends.
2. **Revisit old Sources**: for every share in the ledger not marked "unavailable", live-verify it one by one and recursively list directories (max depth 3, 200
   entries per level). The candidate pool is **all files in this share that have not been saved before** (outside `savedFids`), not "files unseen last time"
   -- files seen in a previous round but not matched at that time (not aired yet), or files whose save failed, must still be recognized in this round; "how many more files than last time"
   is only a number for humans. Feed them to the match engine to pair against missing episodes; hits enter the save list.
3. **Find new Sources** (only when missing episodes remain after revisits): search the seasons where missing episodes fall (seasons with more missing episodes first, max 3 seasons). For each season,
   query string = work name + `第N季` ("Season N"; try both Arabic numerals and Chinese numerals; see the check in `docs/MATCHING.md`), using
   the same batch search function behind `/api/search?scope=resources`; keep only netdisks that support save, live-verify them, calculate "how many missing episodes this share covers",
   and take the top 3 by **coverage count -> total bytes of covered files -> total pair count of this share**.
4. **Save**: submit only matched files, not the entire share. The landing point is a subfolder **under the binding's right-side directory with the same name as the share** (a file
   at `第三季（4K）/xxx.mp4` ("Season 3 (4K)/xxx.mp4") inside the share lands at `tv-<id>/第三季（4K）/xxx.mp4`), not flattened into the work root --
   the root directory may already contain same-named files from another season, such as `第7期上` ("Episode 7 Part 1"), and episode claiming relies exactly on that season folder. Three hard constraints on the Quark side
   (`shared/netdisk/quark/save.ts`): a file token is bound to the session that fetched it, so before saving always refetch by parent directory using its own session;
   submit grouped by the parent directory inside the share, with each group carrying its own `pdir_fid`; `status 2` does not mean everything arrived, and the reported
   landed count (`save_as_sum_num`) is written into the result.
5. **Sync**: save is an async task on Quark's side and AList lags another beat, so after saving, sync at most 6 rounds with 10 seconds between rounds
   (`RESYNC_ATTEMPTS` / `RESYNC_INTERVAL_MS`), stopping once recognized.
6. **Archive**: if the first `sync` did not fail, run this regardless of whether the round saved new files -- call
   `reconcile.executeBinding(setId, { losers: true, gated: true })`: `losers:true` lets losing copies of the same episode be automatically deleted to the recycle bin
   (user-approved, no human intervention; the Quark recycle bin is a roughly 10-day fallback); `gated:true` uses the same authoritative-list health gate as the scheduled
   `netdisk-reconcile` round, and if gated it only records the ledger and does not move files. The result is recorded in
   `follow_runs.archived` (`{runId, moved, deleted, renamed, gated?}`); if the reconciler is not assembled -> record one
   error row and do not affect the save result of this round. If archive moved / deleted / renamed files, that means files just landed in season folders, so sync one more round to
   recognize them. The two scheduled jobs `netdisk-follow` and `netdisk-reconcile` acquire a **per-binding mutex**
   for the same binding (`Map<bindingId, Promise>` inside `ReconcileService`, in-process); the later one waits for the earlier one to finish,
   so they do not concurrently modify the same directory with one saving while the other plans moves/deletions.
7. **End-of-round adjudication** (spec `2026-09-03-netdisk-llm-adjudicator`): after archive, package archive pending cards together with follow candidates judged
   `pending` in this round (files exist in the share, but confidence is not high enough for automatic save) and ask the model once. After conclusions pass code gates,
   write them to the decision ledger; archive cards that pass the gate immediately rerun archive, and follow candidates that pass the gate are saved directly to the shelf. If the adjudicator is not assembled
   (`deps.adjudicate` structural-type injection is absent) -> skip, and it does not count as a fault. Results are recorded in `follow_runs.adjudicated`
   (`{runId, asked, applied, rejected, unsure, failed?}`); if anything is accepted, sync one more round to recognize newly landed / newly adjudicated
   files. See the "end-of-round adjudication" section in `docs/MATCHING.md`.
8. **Notification**: one `follow.round` event, `dedupeKey: follow:<setId>`; rounds with zero missing episodes and zero errors send nothing. If files were saved
   but none were recognized in any round (Quark is still moving / file names do not expose episode numbers), the title truthfully says `转存了 N 个文件，还没认出集` ("saved N files, but no episode recognized yet"),
   and this kind of round does not count as no-result. If archive moved or deleted things, the notification adds `归档：搬 N · 删 M · 改名 K` ("archive: moved N · deleted M · renamed K"); if gated, it adds
   `归档被闸：<detail>` ("archive gated: <detail>").

**This round can also be started from chat**: the MCP tool surface has `netdisk_follow` (view / enable / disable / run one round) and
`netdisk_share_verify` (read-only live verification of one share), riding on `FollowService`'s own methods -- the ledger, backoff,
and filing step all live inside those methods, so the model follows the same path as scheduled rounds; there is no "bypass the loop and save by itself" tier.
`run` truly saves + deletes losing copies under `losers:true`, and the tool description says "tell the user first". **`run` returns immediately after starting**
(returning `{started, setId, note}`): one round is minutes-scale, while one tool call times out at 200 seconds -- waiting would only leave the model holding
a "failed" result while that round is still truly saving in the background and truly deleting copies. Read the result from `lastRuns[0]` in `view`
(that row additionally carries `errorList`). When the same binding is already running, return `{started:false, alreadyRunning:true}`;
the running roster belongs to `FollowService` itself (scheduled rounds and the tool surface share one entry point).

**How the match engine is used without duration**: candidate files only have names and sizes, and the binding's own `matchSpec` runs the rule table.
When duration evidence is absent, use the name floor; **only accept pairings with `status:'auto'`**. `pending` is never saved -- better to miss than to take the wrong file;
a wrong file occupies a slot, while a missed one can be filled next round. The invariant "there is only one brain for episode claiming" does not loosen when duration is absent:
candidate filtering and post-landing pairing use the same `NetdiskService.matchExternalFiles`.

**Two ledgers** (`data/netdisk.db`): `binding_shares` records shares known by each binding (`origin: 'manual' |
'search'`, last live-verification result, fids of files already saved), and is the basis for revisits; `follow_runs` has one row per round (missing episodes, revisit
details, search details, save details, pair counts before/after sync, errors). Notifications and detail pages both read from it, and **errors are rows, not logs**.

**Failure and degradation**:
- First `sync` fails -> this round ends directly, without advancing cadence or changing the no-result count; the next cycle retries unchanged.
- Quark login state is lost (`quarkSave` returns `stage:'auth'`) -> skip all remaining saves in this round, do not count it as a no-result round, and emit
  one `follow.auth` event (`severity:'warn'`, `dedupeKey: 'follow-auth'`).
- Live verification / listing directories / search / matching reports `unknown` or throws (cannot ask the answer) -> record one error row, but **do not count it as a no-result round** -- "could not
  ask the answer" and "asked, and the answer is none" are different; the former should not slow the cadence. Only when it truly asked and the answer is "this round did not fill
  any episode" should it count as one no-result round.

**Cadence** (`nextCheckAt` in `follow/plan.ts`, pure function):

| State | Interval |
|---|---|
| Has missing episodes and the most recent episode's `airDate` is within 3 days (`FRESH_WINDOW_DAYS`) | 6 hours (`FRESH_INTERVAL_H`) |
| Has missing episodes, other cases | 24 hours x 2^min(no-result rounds, 3), capped at 7 days (`BASE_INTERVAL_H` / `MAX_BACKOFF_POW`) |
| No missing episodes, but has unaired episodes (airing season) | 20:00 local timezone on the next episode's `airDate` (`AIR_CHECK_HOUR`) |
| No missing episodes and no unaired episodes | 30 days (`IDLE_DAYS`, waiting for TMDb to add a new season) |

Scheduling: built-in task `netdisk-follow` (scan once per hour, only running due bindings, `serial:true`). **Whether something is due is recalculated on every scan from the
current episode set** (`FollowService.dueAt`: anchored at `lastCheckAt`, and judges "aired" by the real today), not trusting the
`nextCheckAt` stored by the previous round -- episodes can change between two rounds (a human / adjudicator filled missing episodes, TMDb added dates to placeholders, or today happens to be the air date).
The stored number is only the answer at that moment; if the recalculated value differs, it is written back, so the panel's "next check" display is real. When the switch is just opened,
`nextCheckAt` is cleared = immediately due, and this does not change.

**The denominator of progress only counts aired episodes** (`progressOf` / `isUnaired` in `follow/plan.ts`, the same ruler used by the work panel and `bySeason` in `netdisk_sync`):
TMDb first lists placeholders for the whole season. Episodes that have not aired yet (airDate after today) or are unscheduled (no airDate), and for which the disk has
no candidate file, do not enter the denominator and do not count as missing; they are reported separately as `unaired`. Episodes that are paired or already have candidates on disk always enter the denominator.

Routes (all four return 503 when `FollowService` is not assembled): `GET/PATCH /api/netdisk/mappings/:id/follow` (peek /
toggle), `POST /api/netdisk/mappings/:id/follow/run` (manually run one round), `POST /api/netdisk/follow` (for an unbound
show: create work directory + create empty binding + enable switch).

**Current limitation**: shares that are saved first and only manually bound afterward do not enter `binding_shares` -- the ledger is written only on the path where the save carries the
`bind` parameter and automatically binds directly (`POST /api/netdisk/share/save`); for users who do the two steps separately, the experience is
"save succeeded, but this share is never known by the follow loop".

## Source

A Source is one concrete callable entry, declared by a manifest entry in its package's
`packages/<id>/manifests.yaml` (or derived from a recipe's `meta`): id,
description (load-bearing for discovery/search), topics, capabilities, `auth` (credential
declaration), route/params schema, cadence hint. A Source belongs to exactly one Plugin
(`pluginId` is assigned by the backend catalog) and is only ever executed through it. Sources
are members — of Streams and of Providers — never subscribed to directly.

### Who logs back in when login state is lost: the three tiers of `auth.login`

`auth: { type: 'session', login }` says **not where the login state is stored** (the browser tier
always lives in the user's own Chrome), but **who steps in when it is lost**:

| `login` | Who steps in | Shape |
|---|---|---|
| `cookie` | The user logs back in on Chrome themselves | Only declares `cookieDomain`; **does not enter the re-login panel** (clicking would be useless) |
| `qr` | Stream opens a QR-scan panel, and the scan happens on this facility's own harvest lane | `loginUrl` + `qrSelector` |
| `oauth` | Stream clicks `"用 Google 继续"` ("Continue with Google") for the user, riding the third-party login state already present in the browser | `loginUrl` + `oauthButton` + `accountSelector`; **`account` is not in the package**; it is each user's own email address, lives in `runtime_config`, and is fetched on demand at login time |

The latter two tiers share one assembly path (the same lane, the same Transport-backed login page,
`src/kernel/plugins/auth.ts`); the only difference is the provider. **Which tiers appear in the
re-login panel is a named list**: `PANEL_LOGIN_KINDS` (`src/auth/facility-auth-view.ts`) — when
adding a fourth login tier, this is where it must answer once whether Stream needs to step in. If
this is missed, the provider is registered and can run, but the banner never lights up, that row is
absent from the panel, and the whole capability is silently dead code. Operating experience (a
provider not recognizing any verification method, the boundary of `needsHuman`, and pitfalls found
by live verification) is in `.claude/skills/write-recipe/references/login-and-session.md`.

## Plugin

There is exactly **one unit of extension: the Stream package**. Builtin packages live in
`packages/<id>/` in the repo (directory named by the `packages_dir` config field, default
`./packages`); packages the user installs from npm live in `<dataDir>/recipes/<@scope__name>/`.
Both are scanned by the same scanner, described by the same `package.json#stream` field, and
loaded down the same path. A package declares which **capability slots** it fills: source
manifests, recipe data, code (`activate(ctx)`), a docker container, credential domains.

A **Plugin** is a package that fills ≥1 *plugin* slot — the judgement is the named predicate
`fillsPluginSlot` (`src/plugins/loader.ts`), **not** which directory it lives in. `/api/plugins`
lists only those (10 today, out of 29 builtin packages); pure recipe packages have their own
pages. A package may fill both projections at once (a recipe package that also ships a container).

A Plugin adapts one external facility into Stream. It is the **ownership and execution
boundary** of its Sources — every Source resolves to exactly one Plugin, and harvesting a Source
means running its Plugin's machinery:

- **adapter** (`packages/<id>/adapter.ts`, handed to the host by the package's `activate(ctx)`;
  only shared/core adapters stay in `src/adapters/`) — maps the facility's API to raw Stream
  items, dispatching on `params.mode`.
- **normalizer** (`src/content/<id>.ts`, registered in `src/content/normalize.ts`) — normalizes raw
  adapter output into the display model. Normalizers run **at ingest** and the normalized result
  is stored; changing a normalizer only affects newly harvested items.
- **managed backend container** (optional, declared under `stream.backend` in `packages/<id>/package.json`) —
  the facility's own published image (Stream never repackages third-party scrapers). Never
  hand-run: `pnpm plugins compose > docker-compose.yml && docker compose up -d` generates and
  brings up the whole active plugin set on the shared `stream` network, with health checks
  (that generated file holds **only** plugin containers — Stream's own backend/frontend run on
  the host; `--selfhost` emits the all-in-one form instead); the
  generated file holds **no credentials at all** — secrets never bake into images, into `env`,
  or into the compose. `pnpm plugins compose --dev` emits a bind-mount override for
  zero-rebuild development.
- **credential domains** — declared on the manifest (`auth: { type: cookie, domain }`) or on the
  descriptor (`credentials: [domain]`). Either way it is a **declaration of what the host may
  hand this package**, never a fetch path: the host is the only scheduler, it resolves the cookie
  a call needs and injects it (`init(env)` / `sidecar.start(creds)` / `ctx.cookieFor`). Nothing
  calls back into the host for credentials — see `docs/PACKAGE.md` §5.1.

Full package/plugin guide (slot contracts, worked example + template): `docs/PACKAGE.md`.
Gateway & port rules (`expose` vs `publish`, one host port `127.0.0.1:8900`, troubleshooting order): `docs/GATEWAY.md`.
Dev/prod container runtime & how deps reach the container (add-a-dependency flow, anonymous-volume staleness): `docs/DEVELOPMENT.md`.

## Intent

There are two layers of subscription unit: Stream subscribes to a **Source** ("this podcast's
RSS"), while Intent subscribes to a **purpose** ("I want to follow a certain kind of content, no
matter where it appears"). An Intent aggregates ≥1 Stream (some are existing Streams bound
manually, and some are subscribed through recruiting Sources). It does not harvest by itself; it
only digests items already harvested by the Streams under it. It is not a replacement for Channel
— Channel is still "how to view" (present + render), while Intent is "which things count after
viewing, and what they settle into"; the two are independent from each other and can both point to
the same group of Streams.

- **Recruiting Sources (`recruit`) finds Sources in the local Source registry, and one call
  directly persists subscriptions**: the registry searches by `goal+criteria` (taking the first 30
  candidates) → the LLM picks at most 5 from the candidates → parameters are checked one by one
  (a Source is dropped if any field in `params_schema.required` is missing; better to miss than to
  guess parameters) → duplicates are checked (a Stream already subscribed with the same source and
  equal params → reuse it, do not subscribe again) → the tasting gate runs (`previewSource` with an
  empty result or error is dropped) → on the first real subscription, lazily create the
  intent-specific Channel `intent-<first 8 chars of id>` and subscribe the new Stream into it →
  record `subscribed`/`reused`/`dropped` and emit an event (also emit on zero hits, explaining
  whether the candidate pool was empty or every candidate was blocked by gates). This lands in
  `src/intent/recruit.ts::runRecruit`.
- **Retiring (`retire`) sets `status` to `retired` and rolls back subscriptions created by
  recruiting Sources**: take offline every Stream subscribed through recruiting Sources for this
  Intent (`recruitedStreamIds`; manually bound Streams are not touched), and delete the
  intent-specific Channel; a single rollback failure is only logged and does not roll back the
  whole retire. `intent-digest-scan` only scans Intents with `status: 'active'`; retired ones do
  not participate, but a digest round can still be triggered manually.
- **`criteria` is generated once when the Intent is created**: `goal` (the user's original words,
  not rewritten) is handed to the LLM, producing `criteria` (plain-language check criteria: what
  counts as relevant and what is explicitly excluded). After that, `criteria` is read-only and is
  not modified — every judgement during digesting relies on it, so there is no case where the
  standard changes halfway through. If the LLM is unavailable, the Intent is not created (`create`
  throws directly), leaving no empty shell without check criteria.
- **Annotations are Intent-driven; there is no general tag system.** Stream-layer items do not
  carry general fields such as "relevant/not relevant"; relevance only exists in a given Intent's
  ledger — the same item may be relevant in Intent A's ledger, and may never appear in Intent B's
  ledger (because B did not subscribe to that Stream at all) or be judged not relevant. The check
  criterion is not a global classifier; it is this one Intent's private ruler.
- **Digest outputs = ledger + dossier, with different properties**:
  - **Ledger** (one per Intent, key = itemId) records "this item has been judged, what the result
    was, and what the summary was". **The ledger is the incremental cursor** — one digest round
    only processes items not in the ledger, so there is no need for an additional "where the last
    digest stopped" pointer; items that fail judgement do not enter the ledger and naturally retry
    in the next round, so they are not permanently missed because of one LLM fluctuation.
  - **Dossier** is **accumulated and rewritten knowledge**, not a stacked log of per-item
    summaries: each digest round merges new relevant content into the existing dossier, and the
    LLM rewrites an updated overall understanding (the reader is a human, not a running account of
    "item N: ..."). The dossier is written before the ledger — if merging the dossier fails during
    a round, the whole round writes no ledger entries and `lastDigestAt` does not advance, so the
    next round rejudges everything (zero loss, at the cost of one repeated judgement); if merging
    succeeds but writing the ledger fails, the relevant content has already entered the dossier and
    will not disappear from the dossier because the ledger write did not complete. Before writing
    the dossier, keep one copy of the current version at `dossier.prev.md` (same directory,
    overwrite style, only the previous version retained) — when the LLM rewrite has a problem
    (such as damaging or emptying the dossier), it can be checked against the previous version or
    manually restored.
- **Scheduling**: a full scan runs every 10 minutes (`intent-digest-scan`,
  `src/tasks/builtin.ts`, connected to the general scheduling center and unrelated to Data
  Scheduling's T1/T2/T3 — it does not produce Stream items; it only drives the operational periodic
  work of "digest the Intents that should be digested"). The due check is
  `lastDigestAt + cadenceHours*3600s <= now` (or never digested before); a failure digesting one
  Intent does not interrupt other due Intents. Digesting itself (`IntentService.digestNow`) is
  single-slot serial — manually triggered digests and patrol scans share the same queue, avoiding
  multiple LLM rounds at the same time. One digest round judges at most `maxJudged` items (100 in
  production), and leaves overflow to the next round (the ledger is naturally the checkpoint);
  when truncation happens (`remaining > 0`), this round does not advance `lastDigestAt`, and the
  next `intent-digest-scan` will judge it still due and immediately enqueue it again, without
  waiting for the whole cadence — otherwise Intents whose daily volume exceeds `maxJudged` only
  accumulate more and more backlog. `listItems` takes only the most recent 200 items from each
  stream (the window); when a stream adds more than 200 items between two rounds, the oldest items
  are permanently missed — when `runDigestRound` detects that the whole window is unjudged items,
  it logs this and reports the stream in `DigestOutcome.windowSaturated`. If all judged items in a
  round fail (`errors === judged`, usually because the LLM endpoint is wholly unavailable), the
  round counts as a failed round and triggers exponential backoff: `digestBackoffUntil` starts at
  30 minutes, doubles on each consecutive failed round, and caps at 4 hours; during the backoff
  period, that Intent is skipped by `scanDue` (it does not consume the retry budget of the regular
  scan); one successful judgement clears the backoff count.
- **Landing**: `src/intent/` (`types.ts` data shape, `store.ts` persistence — JSON written to
  disk, one Intent list `intents.json`, each Intent with its own `ledger.json` + `dossier.md`,
  `llm.ts` with the four primitives `parseIntent`/`judgeItem`/`mergeDossier`/`pickSources`,
  `digest.ts` as the pure function for one digest round, `recruit.ts` as the pure function for
  recruiting Sources inside the registry, and `service.ts` as the service surface). HTTP surface
  `/api/intents*` (7 routes; see [API.md](API.md)). MCP surface has three tools: `intent_create` /
  `intent_list` go through the general catalog, while `intent_dossier` is manually registered
  separately in `src/mcp/server.ts` because it must deliver raw markdown directly to the client
  (and must not be escaped by the `json(...)` envelope), following the same kind of precedent as
  `stream_subscribe`, where the shape differs and therefore is bespoke. Recruiting Sources and
  active digesting do not enter the MCP surface — those are background scheduling or HTTP
  operations, not queries.

## Configuration sharing (stream-bundle)

Plugin/Recipe distributes **capability** (the distribution layer only reads declarations);
**configuration sharing** distributes the layer above that — the **orchestration** accumulated by
the user in `stream.db` (Channel/Stream/Provider closure). The code is in `src/sharing/`, and the
routes are mounted at `/api/sharing/*` (`src/http/sharing-routes.ts`). Design: `internal design
record` (closure/package format) + `2026-07-24-import-decision-ledger-design.md` (import ledger).

- **Sharing unit** = any one of Channel/Stream/Provider as the root, collecting the closure along
  `stream_ids → members → {plugin,source}`.
- **Package shape** = a single `stream-bundle/v1` JSON (form B): code Plugins only enter
  `requires.plugins` (declaration + version constraint, cannot be stuffed in); data Recipes are
  embedded whole in `embedded.recipes` (ready to use for the other side). The judgement only goes
  through plugin-source-catalog.
- **Credential red line**: a package **never** contains any cookie/token/apiKey value —
  `auth:cookie` domains and `runtime_config` are only translated into requirement declarations
  (schemas) in `requires.credentials`/`runtimeConfig`. Export performs a sensitive-field physical
  check on `members.params`, and rejects on a hit.
- **Transport is host-agnostic**: import accepts a URL (through `ownedFetch`, with no special host
  cases) or a local file.
- **Two-axis conflicts**: configuration row id collision → remap (generate new ids + rewrite
  references inside the package, never touch existing local rows; system Channel `stream_ids`
  append reuses, slot-key-level merge — locally unconfigured entries are silently merged in, while
  already configured entries become `slot-conflict` pending decision); recipe version collision →
  semver merge (upgrade/reuse/stop across major and create a notice).
- **Zero execution on import**: import only writes configuration rows + writes embedded recipes to
  disk; a recipe only runs on the next T1 tick of a referenced Stream.
- **Import decision ledger** (`src/sharing/import-run-store.ts` + `decide.ts`): one import = one
  addressable run, and leftovers are unified as items (`parked-provider`/`slot-conflict`/`notice`,
  each with mine/theirs/choices); decision is the only state transition, and execution failure does
  not half-commit. It writes one **local private JSON** (data directory, not in
  `stream.db`/`cache.db`), offline and not sent out. API: `POST/GET /api/sharing/imports*` +
  `POST /api/sharing/imports/:id/decisions`. The UI import result page and AI "help me import and
  handle it" consume the same data.

**External prerequisite dependency (not yet landed)**: the recipe package's **author-scoped
identity** (`@author/facility` + semver + integrity) belongs to the `recipe-packages` spec and is
another change. This sharing layer's conflict interface has already been written around scoped
ids, and embedded loading first remains compatible with the current facility single-package shape;
after the prerequisite lands, replacing the binding's `plugin` position with `@author/facility`
enables the three branches, with **no need to rewrite conflict logic**. Submission-side work
(prefilled issue/token silent submission), one-click publish, and the central registry are all
non-goals for this period.

### Capability piggybacking (capability-share, config-sharing v2)

A shared package can optionally carry the author's **capability layer** — because Provider is a
**global route** (dispatch happens by serves+variant at the callsite), adding one changes the
behavior of all of the other side's Channels with the same variant, so it **cannot copy Stream's
additive semantics directly**. In the three-layer dispatch, only the callsite is code (application
contract, present on both sides, and not in the package); binding and Provider rows are data, so
only they are carried.

- **Top-level optional blocks** `providers` / `providerBindings` (peers of `channels`, **not in
  the Channel closure**) — included only when the author **explicitly checks** them, and only rows
  with `system!==true` are collected.
- **Park-on-import**: imported Providers are written to the database with `options.parked=true`,
  but are **excluded from all serves match/enumeration points**
  (`ProviderExecutor.match`→`listActiveProviders`, `ProviderBindings.dispatch`, and
  `/api/provider-callsites` options each filter `isParked`); after import, the other side's
  routing is **byte-for-byte unchanged**. Binding overrides land as candidates in
  `options.candidateBinding`, and **do not write active `provider_bindings`**.
- **Conflicts are resolved only on activation**: each parked Provider creates one
  `parked-provider` item in the import run (choices: use imported / use local / coexist in order /
  leave it alone for now); `GET /api/sharing/imports/:id` projects a real-time conflict physical
  check for serves overlap / candidate binding preemption, and the decision executes activation
  (clears `parked`, writes `provider_bindings` as needed), while the other side's dispatch remains
  unchanged during this.

**Follow-up**: sharing netdisk alignment bindings (`netdisk-binding-share`, change B) reuses this
section's foundation of "top-level optional blocks + explicit check + park-on-import" — see below.

### Netdisk binding piggybacking (netdisk-binding-share, config-sharing v2 · B)

The shared package's top-level optional `netdiskBindings` block carries the **portable subset** of
`MappingSet`: `left + matchSpec + manually corrected entries only` (+ optional `shareUrl`) —
**zero fileId, no `right.path` (the author's local AList path), and no credentials**. This relies
on verified truths: `matchSpec` is the rule (matching on `{name,size}`),
`rightFile`/`right.path` is path/file-name identity, and saving to the netdisk preserves the
directory tree. Import stages each entry as a **pending MappingSet** with unresolved `right` and
`autoSync:false` (**zero execution on import**: no saving to the netdisk, no sync, no harvest), and
returns a list to be saved to the netdisk; the other side uses their own Quark login state to save
to the netdisk → mounts AList → uses the **existing** `rebind` → `sync` uses the package-carried
matchSpec to complete the first binding with **deterministic recomputation**, with **no rerun of
AI and no changes to the alignment engine** (zero changes to `sync.ts`/`mapping-store.ts`).
stream-left where the stream is not included in the package → report missing / create a notice
item (tmdb-left does not have this problem).

At this point **config-sharing v2 closes**: A (custom Provider capability piggybacking) + B
(netdisk binding piggybacking) share the same sharing safety foundation of "top-level optional
blocks + explicit check + import does not change the other side's current state (Provider parks on
import / netdisk stages pending)".

## Invariants

1. **Entry-point rule** — every subscription and invocation names a Channel. When a user
   subscribes to a bare Stream, the system implicitly wraps it in a same-named single-member
   Timeline Channel; a "standalone Stream" is UI shorthand only.
2. **Plugin is the sole ownership edge** — a Source belongs to exactly one Plugin; the frontend
   and upper layers never guess ownership from id prefixes. (Established in
   `openspec/specs/plugin-source-catalog/`; see `docs/PACKAGE.md` §8.)
3. **Stream vs Provider criterion** — what triggers execution, and where do results land?
   T1 time-driven + persisted feed items → Stream. T2 call-driven + returned directly → Provider.
   Call-time params are common for Providers but are **not** the discriminator: a parameterless
   recommendation invocation (for example a logged-in Home Feed) is still a Provider when it runs
   only on demand and its ephemeral results are never persisted as feed items.
4. **Trigger exclusivity** — every data acquisition is initiated by exactly one of the three
   scheduling triggers (T1 tick / T2 invoke / T3 enqueue — see [Data Scheduling](#data-scheduling)).
   No other code path fetches. A second standing harvest loop is by definition a bug.
5. **Folding never prevents insertion into storage** — folding homogeneous content (next section)
   only answers "should these items be placed in one cell or three cells"; it never answers "should
   this item be stored". The latter belongs only to `DedupStore`. The consequence of merging these
   two is that the second copy harvested cross-platform is treated as a duplicate and discarded at
   the insertion step, so even the fact that "they also posted it to Bilibili" cannot be stored.

## Homogeneous Content Folding (story fold)

**Reposts, mirrors, and multiple copies of the same thing occupy only one slot.** The code is in `src/story-fold/`; the authoritative design is in

- **It is a presentation-layer capability**, not a harvest-layer capability: it only produces "who is in the same fold, who is the representative, and why";
  it does not delete a single piece of content (`rep + members` expands to the input, and tests pin this invariant).
- **Its boundary with `DedupStore`** is covered by invariant 5 above. One manages "whether to store"; the other manages "how many slots to show".
- **The skeleton is shared, but thresholds are not**: evidence providers (url-identity / title-dice / future media fingerprints,
  author identity, semantics) are shared, and each scenario configures its own `FoldProfile`. One threshold that covers both
  "reposts" and "different content by the same author" inevitably merges items incorrectly.
- **Sequence identity is the critical check**: number + season/issue + Part 1/Part 2 (with Chinese numerals normalized) mismatch -> hard veto,
  and it runs before any similarity check. **The site is not the check**: Baijiahao / Sohuhao / NetEasehao are "one domain name, countless publishers";
  the places with the densest reposting are exactly inside the same site, so "two episodes of the same show must not merge" is carried entirely by this veto.
- **A "title looks similar" pair on the same site only counts as suspicious and must fetch body text in tier 2 to confirm** (`titleNeedsTextConfirm`): the same account
  updates a column every day with only the tail words changed. In live measurement, Sohu's two-day titles `每日一练｜时事政治模拟题` ("Daily Practice | Current Affairs Politics Mock Questions") had Dice 0.857
  and crossed 0.85, but the questions were completely different, and sequence identity could not block it (there was no number in the title). After degradation, this pair
  forms separate folds in tier 1 and naturally flows to tier 2, without opening a separate confirmation path. **Cross-site pairs do not degrade** (if titles look similar, they merge for free,
  which is the value of tier 1), and **the same link also does not degrade** (URL identity is a fact).
  Degradation is set by `withSameHostTextConfirm` according to whether tier 2 is actually available: **if tier 2 is absent, do not degrade**,
  because a "suspicious" state that nobody can catch means permanently splitting same-site reposts with identical titles.
- There is only one literal-similarity formula in the whole backend: `src/text/similarity.ts` (netdisk episode recognition and folding share the same ruler).
- **Check: folding only takes effect when the consumer can expand it**. Folding without an expand entry point is silently hiding content.

**Two attachment points, two scenario profiles** (`src/story-fold/profiles.ts` / `inbox.ts`):

| Tier | Where attached | Main evidence | Consumer |
| --- | --- | --- | --- |
| A Search folding | Web search ladder exit (`src/search/web-search-ladder.ts`) | Three-level ladder, each level more expensive than the previous one, and only reached when the previous level cannot decide: **1. URL normalization + title Dice** (local, zero requests; same-site title evidence degrades to suspicious and is handed to 2) -> **2. longest shared body-text block** (`story-fold/text-fold.ts`, fetch body text) -> **3. ask the model "is this the same article?"** (`story-fold/semantic-fold.ts`, zero crawling, one call) | MCP `web_search` / chat agent / search_agent (shared exit) |
| B Inbox folding | The harvest hop only **records ledger + queues** (`scheduler.ts`) -> **background worker decides** (`story-fold/worker.ts`) -> ledger -> `/api/items` projection | **Media-to-media uses acoustic fingerprints** (chromaprint, deciding "the same recording"; see spec); all other pairs use **text** (body text / transcript) | Frontend list (`app/src/lib/storyFold.ts`) |

### Tier A's Second Check: Compare Body Text (`src/story-fold/text-fold.ts`)

The cases that links and titles cannot decide -- **portal reposts, aggregation sites, and mirror sites rewrite titles**, so the Dice between two items is only 0.3,
while the body text is the same paragraph. This tier exists to rescue them.

**The check is "longest continuous shared block" >= 130 characters, not sketch Jaccard** (`src/text/shingle.ts`'s
`longestSharedRun`). The reason is measured: extracted web body text inevitably drags along a body of boilerplate (navigation, recommendation slots,
disclaimers, stock-forum tickers), and **whole-article Jaccard for true reposts is only 0.076-0.14**, while for "separate articles about the same event"
it is 0.006-0.016. Both numbers sit near 0, with no safe place to cut between them; after switching to longest shared block, the same data set is
**246 characters vs 11 characters**. Boilerplate text (such as "Investors operate accordingly at their own risk") is all at the dozens-of-characters scale and cannot reach the threshold.
Tier B still uses sketches because both sides are not present at the same time and only a fingerprint can be stored -- **the two rulers each have their own scenario; do not replace one with the other**.

- **Fetching body text rescues the cases tier 1 cannot decide**: reposts whose titles do not look similar, and **the same-site cases whose "titles look similar but only count as suspicious"**
  (see the previous section): `fold()` runs first, and supplemental checks run only **between the remaining fold representatives**.
  Therefore the cost is O(number of folds) fetches, not O(number of pairs): comparison is free; fetching is what costs.
- The **candidate gate** (`worthFetchingText`) has two rules: both sides must have an extractable host (items without one are magnets/non-http,
  which cannot fetch body text anyway), and sequence identity must not conflict (body text for Episode 2 and Episode 3 may be very similar, so this hard veto must run
  before spending money); **there is no lower bound on title similarity** ("titles look completely different" is exactly why it exists). The upper limit is 12 items,
  truncated by input order (= relevance order).
- **A same-site pair first strips the shared header/footer before comparison** (`sharedStoryRun`): any two pages on the same site naturally share
  a whole block of boilerplate, and it is long enough to **cross the threshold by itself**: measured values are The Paper 484 characters and NetEasehao 209 characters (between three same-site article pairs
  with wholly unrelated content, character-for-character identical), Baijiahao 66 characters, and Sohu 37 characters. The boilerplate on all four sites **is exactly the common suffix of the two articles**,
  so the code strips the measured segment, not relying on a list or structural markers. After stripping, remaining >= threshold means the body text
  really contains a large identical block. When the shared edge is longer than half the shorter article, it is instead treated as body text (a same-site verbatim repost).
  Cross-site pairs are never stripped: a common suffix across two different sites is content, not boilerplate.
- Text conversion reuses the same path behind `read_url` (`makeArticleFetchDep`) and does not create another fetcher; sketches are cached in-process by normalized URL,
  so the same address is fetched only once per process.
- **Cannot fetch = cannot decide != not similar**: failure, timeout (8s), and body text too short (<200 characters, usually an interception page/login wall --
  two sites hitting the same "Just a moment..." screen would have similarity 1.0, and the character-count threshold prevents that false merge) all only keep that pair
  unchanged. The whole segment falls back and never turns a valid search result into an error.
- Kill switch `STREAM_SEARCH_TEXT_FOLD=0` (enabled by default): turning it off only returns to "compare only links and titles".
- **"Separate articles about the same event" is outside this tier's range** (NHK's own article vs a wire repost: longest shared block 8 characters).
  That is the third type of homogeneous content in the design; do not expect to merge it by tuning this threshold -- tier 3 does not do it either; see below.

### Tier A's Third Check: Ask the Model (`src/story-fold/semantic-fold.ts`)

When **the same wire article has been rewritten by AI**, almost nothing remains literally shared: live verification measured Sina's verbatim repost sharing **246 characters**,
while Sohu's AI rewrite leaves only **17 characters**, and "separate articles about the same event" is **6-11 characters**. Since 17 and 11 sit next to each other,
**there is no place to cut on this line**, so the check has to move from "literal text" to "meaning".

All three tiers **always ask the same question: is this the same content**. Tier 1 looks at links, tier 2 looks at literal text, tier 3 looks at meaning.
**"Two outlets each reporting the same event" is not merged by any of the three tiers**: those are two different articles, each with its own reporting and angle, and both should remain visible.

- **Zero crawling**: it consumes only the body texts tier 2 has already fetched (looked up by normalized URL); folds without body text do not participate.
  Its full cost is **at most one model call per search** (through `llmContentQuiet` + the `story-fold.semantic`
  callsite, with the model bindable separately), not one question per pair.
- **The model's answer is not authoritative**: the hard sequence-identity veto runs **both before asking and after receiving the answer**.
  The beginnings of two episodes of the same show are almost identical, and the model does not have enough information to distinguish them; distinguishing them depends on the number in the title.
  Same-site boilerplate does not contaminate this tier: the model receives the **beginning** 600 characters of the body text, while boilerplate is at the page tail.
- The **evidence kind is `semantic`, and must never be mixed into `text-identity`**: this tier is asked, not calculated,
  so its confidence is naturally one level softer, and readers need to tell at a glance which level made the judgment.
- **Anything that cannot be decided keeps its original shape**: no configured LLM, the whole ladder declines, timeout (20s), unreadable response,
  or body text not fetched. It never becomes an error.
- Kill switch `STREAM_SEARCH_SEMANTIC_FOLD=0` (enabled by default).
- **Known weak spot** (live verification): the model tends to slide toward "the same event" -- two different writeups of the same interview are sometimes judged as the same article.
  The prompt line "would deleting one lose information" is the main check that reins it in; read the header comment in
  `semantic-fold.ts` before changing the prompt.
- **The new cost after allowing same-site merging**: the title-similarity tier no longer looks at site, so **two items on the same site with extremely similar titles
  and no sequence number to distinguish them** can be merged. A live real sample: Sohu `a/613889193_121124005` and
  `a/577012683_121124005` are two days of `每日一练｜时事政治模拟题`, with completely different questions and title Dice
  0.857 -> merged. Sequence identity cannot help this class (there is no number in the title).

### Tier B's Check: Content Identity = The Content Itself (Text or Waveform)

**When the same piece of content is republished, the title can be rewritten, the cover can change, duration can differ by a few seconds because of transcoding or clipped intros, and the link is necessarily
different -- only the content itself remains unchanged.** Identity lands on two checks by form:

- Text content: the body text is already present and free; web links use body-text fetching. The check is text sketches
  (`src/text/shingle.ts`, MinHash, storing 64 numbers per item).
- Media-to-media (both sides are audio/video): acoustic fingerprints (chromaprint, `src/media/audio-fingerprint.ts`);
  it compares the waveform, not text -- local, zero model calls, naturally robust to encoding differences and intro offsets. The design is in
- Cross-form pairs (one side article, one side audio/video): the media side is transcribed to text and then compared as text; media longer than 20 minutes is protected by the cost
  gate (`src/story-fold/text-source.ts`'s `maxMediaSeconds`), so this kind of pair cannot be decided.

**Title and duration degrade into candidate generators** (`store.neighbors` + `worthChecking`), and not a single character participates in the conclusion.
This rule was beaten out by live verification: when duration was used as a check, two playlists sharing dozens of songs caused songs around four minutes long to fold into each other,
and one fold grew to 22 items. **Duration is never identity.**

**Getting text has a cost** (transcription measured average 16s, slowest 142s), so:

- The check moves to a **background worker**, not the hot harvest path;
- **Text is fetched only for items with candidates**: if an item has no candidates, it is never transcribed;
- Reuse the `extract` chain (it decides its own branch, caches itself, and does not charge twice for a prior transcription); do not create another transcription path;
- Audio/video that is too long (>20 minutes) is temporarily not converted to text, so it **cannot be decided** (it is not judged "not the same item").
  This gate opens after sampled transcription lands.
- **"Cannot decide" and "not similar" must stay separate**: the former remains in the pending-review queue waiting for text; the latter leaves the queue. If they are collapsed into one,
  items waiting for text are treated as already checked and are never revisited.

**Author does not participate in the judgment.** The same piece of content is the same piece of content, and who posted it does not change that fact: a reposting account's copy and the original author's copy
should naturally be gathered together. After folding, "source" has only **one** remaining use: **seeing which Source consistently publishes first among homogeneous content**
(`source_lead` table -> `GET /api/story-fold/leaderboard`; in the list, the facade item shows "first published, N hours earlier").

**This line does not ask the user a single word.** The fact that two Sources often post the same content is accumulated by the merge count itself
(`story_pair`): an observable fact has no reason to become a pending task that bothers someone.

Tier B has several hard rules; break any one of them and this capability becomes "content mysteriously disappears":

- **Never fold within the same Stream**: one Stream = one source + one account, so its own two items are by definition
  two pieces of content. This gate does not depend on any threshold and is more reliable than thresholds.
- **Collection Streams (playlists/favorites) do not enter this line at all**. They are **directory snapshots, not publish events**:
  one song appearing in two playlists means "both playlists contain it"; what "who published first" calculates is **how long elapsed between the user's
  two saves**. On 2026-08-13, live verification really calculated a round this way, and the leaderboard solemnly reported
  "average lead 15253 seconds". The check is placed in `scheduler.ts`'s collection branch, which intentionally lacks the folding hop.
- **Representative = the earliest published item**, recalculated on every merge/split. It is not "the item I harvested first" -- that only reflects harvest
  order (whoever has the shorter cadence gets harvested first) and has nothing to do with "who published first", which is exactly the question this line answers.
- **Record lead only once per pair**: if both items are in the pending-review queue, the first checked item has already merged them; if the later checked item runs
  again, the same pair's "who published first" is recorded a second time and the lead count doubles directly. Already-folded items leave the queue immediately.
- **Manual split must record a veto** (`story_fold_veto`): if only membership is deleted, the next harvest merges them back according to the original check.
- **When the representative is not on the current page, members still display normally** (frontend): the fold's representative may be outside pagination, and hiding it means
  "this item disappeared out of thin air", with no entry point to recover it.
- **Ties are not forcibly ordered**: items published in the same second record only the source pair, not lead. Deciding who was faster would fabricate precision.
- **Duration is never identity**; it is only a retrieval key that shrinks the candidate set to single digits (on 2026-08-13, it once served as the live
  check: two NetEase Cloud Music playlists shared dozens of songs, and after that any two songs around four minutes long were folded into one pile, with one pile growing to
  22 items). The only check is text.

The entire ledger lives in `cache.db`: **purely additive; deleting it all returns the system to a state with no folding**. There is not a single slot in it that is user-
entered manually (homogeneous relationships and lead values are accumulated from the harvested content itself; delete it and rerun harvest to get them again).

## Data Scheduling

The single authority on **when data moves, what drives it, how fetch parameters compose, and
where results land**. Historically this was never defined, so parallel engines and ad-hoc param
plumbing accumulated; this chapter is the contract every acquisition path must satisfy.

### Triggers — exactly three

| | Trigger | Driven by | Executor | Results |
|---|---|---|---|---|
| **T1** | `tick(stream)` | time (`cadence_seconds`) | Scheduler | persisted to ItemStore under the Stream's id |
| **T2** | `invoke(provider, key)` | a call site | Provider executor | returned to the caller — never stored as feed items |
| **T3** | `enqueue(job)` | a call site, long-running | a job queue | persisted to the job's dedicated ledger |

- **T1** — fanout: harvest ALL members (fetched concurrently; persisted sequentially through the
  shared dedup), merge. One failing member degrades the tick, it does not fail it — a tick errors
  only when every attempted member failed. On scheduled ticks a repeatedly-failing member backs
  off exponentially (skip 0/1/3/… ticks, capped); a manual refresh always attempts every member.
  exclusive: members are a priority ladder — start at the first healthy rung, fall through on
  hard error, first success wins; non-healthy tops are re-probed every K ticks. Failures degrade,
  never fail the Stream. Cadence timers are chained (next tick arms after the previous finishes —
  a slow harvest can never overlap itself) and first fires are jittered so same-cadence Streams
  don't volley in sync.
- **T2** — sequential: try members in order; decline / contract-reject / hard error are three
  miss kinds that fall through; first qualifying result returns with `via` provenance.
  concurrent: all members run, results merge with per-item source provenance.
- **T3** — *declared contract only* (details live in each capability's own spec): triggered by a
  call, queued with a persistent job ledger, idempotent on a job key, results land in dedicated
  ledgers (audio archive, transcripts, parses) that deliberately outlive feed items. The
  still-planned Provider capabilities (parse / transcribe / summarize) are T3-shaped — their
  async queue + persistence is why they don't fit `invoke()`.

### Parameter composition — one pipeline, one precedence

Every fetch's effective params compose in this order (later wins):

```
defaults            manifest params_schema defaults (the single home of per-source defaults)
⊕ source-config     per-source invocation values (cross-plugin, schema-validated; never runtime secrets)
⊕ policy            scheduler-injected scheduling policy (e.g. harvest backfill limit) — T1 only
⊕ member bindings   the row's bound params; constants on Streams,
                    `$input` holes filled with the key on Providers
⊕ call-time extra   the caller's own params — T2 only
```

Member bindings outrank policy on purpose: an explicitly bound param is a statement of intent;
policy fills gaps, it never overrides configuration. Effective params feed both `adapter.fetch`
and the cache key — two fetches with different effective params never share a cache entry.

### Harvest policy (T1)

A Stream MAY declare `options.harvest = { backfillLimit?, incrementalLimit? }`. The scheduler
injects `limit` per the pipeline above: `backfillLimit` on **first harvest** — defined as *no
item ever persisted under the Stream's id* (durable dedup count, no extra state field) — else
`incrementalLimit`. A failed first harvest persists nothing, so the next tick retries the
backfill (idempotent). Streams without `options.harvest` are fetched with unchanged params —
the policy is strictly opt-in (meant for slow-updating archives, not busy feeds).

### Caching

Cache key = `(adapter, source id, effective params)`. TTL derives from the manifest's cadence
hint, clamped [5 min, 24 h] — and on T1 it is additionally capped by the Stream's own
`cadence_seconds`, so a user-set cadence below the floor still gets a real fetch every tick.
Concurrent identical fetches collapse onto one in-flight request. Live previews (Stream/Source
preview) fetch **fresh** — they bypass the cache-hit check (still joining any in-flight fetch,
still refilling the cache) because a preview answers "what does the source say NOW".
**A cache hit never moves health** — health reflects the upstream facility, not our cache.

**Per-item enrichment** goes through `ContentCache` (`src/content-cache.ts`, `content_cache`
table in cache.db — the regenerable side): a tryGet-style `(namespace, key) → fact` cache with
per-namespace TTL, schema `version` (bump = all old rows become misses, no migrations),
optional negative caching and optional stale-fallback. Consumers register their namespace in
their own `wire*` function so the spec lives next to the projection it describes (current:
`article`, `favicon`). Invalidation is entirely mechanical — TTL, version bump, or the user's
explicit refresh (`fresh`); no module ever "remembers to clear" a cache. **Red line: cache
stable facts only — never signed/expiring CDN URLs** (that class of value is resolved live;
it is why the embedded RSSHub's content cache stays disabled). Deliberately OUTSIDE this
pattern: T3 ledgers (artifacts, not caches), DiscoverCache (SWR product semantics),
AList link caches (TTL owned by the upstream signature), and `video_details` (a richer
organism — canonical pipeline, partial writes, four-state reads — that would lose capability
squeezed into tryGet).

### Health accounting

Only real acquisition attempts write the health ledger: T1 harvests and T2 ladder attempts.
Ad-hoc reads (UI preview, MCP browse, doctor views) pass `recordHealth=false` and never
contaminate it. The ledger drives the exclusive ladder's starting rung and re-probe cycle.

### Persistence

- **T1** → normalizer (at ingest) → ad-filter → dedup → ItemStore keyed by stream id; a
  `feed`-mode Stream dedup-gates and appends (evicting to `capPerStream`), a `collection`-mode
  Stream calls `replaceStream` and rebuilds that source's shard each harvest — **subject to the
  two replace gates** (success pointer + near-empty) — see Stream → storage shape above.
- **T2** → returned to the caller; never stored as feed items.
- **T3** → the job's dedicated ledger; no FK to evictable feed items.

### Read state — per-Stream unread watermark

`StreamSeenStore` (`src/stream-seen-store.ts`, own sqlite in the user data dir) persists, per Stream,
the highest ItemStore `seq` the viewer has seen. It is **Channel-agnostic** — any view can ask a
Stream's unread state via `ItemStore.newCountSince(streamId, seenSeq)` (count of items inserted after
the watermark) and advance it via `POST /api/streams/:id/seen` (→ `maxSeq`). The watermark only
advances (`max()`), so re-marking is idempotent. First consumer: the video Channel's **正在追的**
("Currently Following") section, where `/api/channels` attaches `newCount` to a video Channel's
non-ranking members (its presence is what marks a Stream as "followed") and the badge clears on
open. `seq` (not `timestamp`)
is the key so counts are robust to missing/unreliable publish dates.

### Existing-Item Query — Read “the batch already harvested into the database”

`ItemStore.search({ streams, author, q, since, until, limit, order })` is the only entry point for
**reading existing items by condition**: it ANDs the filter dimensions, sorts by publish time
(`timestamp`, falling back to `created_at` by default), and returns `{ items, matched }` —
`matched` is the total number of hits before `limit`, which consumers use to say "N total, M
returned here".

- **The implementation is plain SQLite LIKE, not FTS5**. This is a measured decision: on a live
  13k-row / 190MB `cache.db`, author filtering is ~140ms and body keyword search is ~93ms. FTS5
  requires building an index + migration, and also keeping it in sync with the four write paths
  (`add`/`addMany`/`replaceStream`/`rewriteItems`), while that kind of drift is **silent**.
  **Re-evaluation triggers: this query exceeds ~500ms, or the table exceeds ~100k rows** (written
  in the head comment of `src/item-store.ts`).
- `q` scans only title / `body_text` / `content.text`; it **does not scan the full json**. `raw`
  contains the upstream payload as-is, and scanning it would also match url, id, and irrelevant
  fields.
- **Consumer**: MCP's `inbox_search` (`src/mcp/inbox-search.ts`). It projects each item into a
  slim receipt (id/stream_id/title/author/timestamp/url/excerpt, with `excerpt_truncated` set when
  the excerpt is truncated) and **never includes `raw`/`body_html`/`content.media`**: the complete
  JSON for one item is about 850 characters, and dozens of items can blow up one conversation's
  context. Channel filtering is resolved at that layer (Channel id or the name the user says → the
  set of streams it references; if it cannot recognize the Channel, it lists the existing Channels
  in the receipt). ItemStore itself does not know Channels.
- **How much body text to return follows the `planExtract` branch** (`shared/extract/plan.ts`, the
  single authority for 「这条 item 的正文该怎么取」 ("how to get the body text for this item")): the
  `inline` tier (the body text is already on the item) returns up to 1000 characters and marks
  `full_text: true` when it is not truncated — **explicitly saying not to call `extract` on it
  again**; the other branches (audio/video/image/external link, where the body text exists only
  after running a conversion pass) return 300 characters. The cost of merging the two tiers has
  been measured: the model called extract 10 times for 8 plain-text posts, each time merely
  fetching the same text again unchanged. **The "next step" in a receipt is also a commitment** —
  if it points to a path that does not hold for this type of data, the model follows it.

### Live preview (no store)

"See how it looks" before committing: fetch a Stream (or one ad-hoc source with unsaved params),
normalize it, and render it in the UI exactly like the Channel timeline — **without writing
anything**. This is the read-side counterpart to T1: same fetch + normalizer path, none of the
persistence.

- **Scheduler** — `readStreamNormalized(streamId, { limit })` fans out over the Stream's
  members, normalizes each, merges newest-first (no dedup — a preview shows raw overlap), caps at
  `limit ?? 20`. `readSourceNormalized(sourceId, params)` does the same for a single source with
  ad-hoc params. Both call `fetchSource` **without `recordHealth`** (invariant above) and
  collect per-source failures into `errors[]` (classified via `classifyError`) instead of
  throwing — a partial preview still renders.
- **Service** — `StreamService.previewStream` / `previewSource` delegate verbatim (MCP-reachable).
- **REST** — `GET /api/streams/:id/preview?limit=` and `POST /api/sources/preview`
  (`{ sourceId, params }`), both returning `PreviewResult { items, errors }`.
- **UI** — a「预览」("Preview") button per Stream (the channel's 配置 ("Configuration") tab) and in the source config sheet opens a modal
  that reuses the timeline's `PostItemRow`; failures surface through the shared `Warnings` panel.
  Nothing touches ItemStore or the health ledger.

### Browser Recipe execution (session-backed T2)

A **Recipe** is a versioned, declarative execution contract owned by the replay plugin. It records
how a Source uses a logged-in browser session: session requirements, ordered browser actions,
simultaneous observations (Network response bodies, page state, or DOM fallback), output mapping,
and validation/drift guards. Recipe remains the product and file-format term; the architecture does
not introduce a parallel top-level "Workflow" concept.

**Drift is not decided by a single boolean.** When one step's `expect` misses, or when the whole run
is classified as `blocked`/`drift`, the runner first recognizes the current page through a **state
graph** (`src/replay/state-*.ts`; today only the three built-in Cloudflare states exist): if it
recognizes a dead end or an obstacle with an escape route, the conclusion flips to `challenged`
instead of `drift`. This is an **architecture-level check**, because the costs on the two sides are
highly asymmetric — classifying as `drift` causes `RepairLedger` to **silently isolate** this Source
after several consecutive occurrences, after which it returns `items:0 + errors:[]`, exactly like
"the run succeeded, but genuinely found nothing"; classifying as `challenged` only waits for one
facility cooldown. This step **comes before `loginCheck.wall` probing**: the specific precedes the
generic. See `docs/ENGINE.md` §6 for the full model.

These axes are independent:

- **Source** is the externally meaningful entry point (`xhs-home`, `xhs-search`). A Source MUST NOT
  be duplicated merely because the same entry can be observed through DOM, XHR, or page state.
- **Recipe** is the Source's execution contract. One package MAY contain private reusable recipes
  such as `xhs-detail`, shared by multiple Source entry recipes and not exposed in discovery.
- **Session** is runtime state. A recipe declares `one-shot` or facility-scoped `persistent`
  lifecycle and `unattended` / `interactive` visibility; the session manager, not the recipe
  runner, owns the Chrome tab lifetime. There is exactly ONE browser — the user's own Chrome over
  the extension relay; Stream ships no browser of its own (see `docs/ENGINE.md` §2). The relay has
  exactly one peer at a time, and that peer is Stream's own backend: the relay, the four
  `cdp_look`/`cdp_shot`/`cdp_act`/`cdp_pages` verbs (all four tiers: chrome/facility/webview/
  desktop) and the extension's `/api/ext/verify` gate all live in the backend, with the
  chrome-tier implementation and the tools' descriptions/param schemas in
  `shared/browser-relay/` (`cdp-chrome.ts`, `tool-specs.ts`); see `.claude/skills/drive-live-ui/`.
  Ownership on a machine is a single last-writer-wins pointer (`~/.stream/datadir`) plus a single
  native-messaging registration, and neither says a word when it is overwritten — so a second
  Stream backend on the same box silently takes the hand. Pairing was verified end to end on a
  real Windows box against a real extension, with the green falsified by a negative control (drop
  only the native-messaging registration and the extension never arrives):
  `internal design record`; the mechanism is
  `internal design record`.
- **Observer** describes how results are read while actions execute. Network/state/DOM observers
  are composable and MAY run together; they are not separate Sources and not mutually exclusive
  harvest modes.

A facility-scoped persistent browser session does not make the Provider stateful in the user-data
model. The Provider invocation is still T2: it receives a call, returns ephemeral normalized items,
and writes no feed rows. The session is an execution resource, like a connection pool, held only to
preserve a plausible continuous browser context.

For a silent shadow session, the normal data flow is:

```
frontend invocation
  -> backend Provider / correlated Recipe task
  -> extension CDP transport
  -> owned Chrome automation tab in the user's current profile
  -> trusted browser actions + bounded observer windows
  -> backend normalization (normalizer)
  -> frontend result or incremental WS events
```

The host names no site anywhere on this path. The package's normalizer writes on each item
*where* to fetch the rest (`content.enrich = { source, params }`), the frontend opens it over the
generic `enrich.open` WS command (`docs/API.md`), the host dispatches to the package's enricher of
that name, and the enricher runs the package's own detail recipe through `ctx.readSource`
(`docs/PACKAGE.md` §3.2). Adding a site with a live-fetched detail = shipping a package; nothing in
`src/` changes.

The reverse event path is `site -> extension -> backend -> frontend`. The extension remains a pure
CDP transport: it may forward raw command results and subscribed CDP events, but recipe selection,
action sequencing, response matching, mapping, rate policy, and drift classification remain in the
backend.

`xhs-home` (recommend) and `xhs-search` (search) are distinct Source entry points sharing a private
detail recipe/session. `xhs-search` is a T2 Provider invocation: its feed and detail results are
ephemeral: only an explicit user action that materializes an item may place a normalized snapshot
into storage. (**Do not build a surface that renders `xhs-home` live** — a never-ending rec feed does
not serve an AI-facing collection layer, and it is the one thing that would need a fat browser tab
kept alive.)

## Task Scheduling Center

There is another class of periodic tasks inside the Stream process, and they are completely different from the T1/T2/T3 in the Data Scheduling section: they do not produce
Stream items, but are operational background work such as refreshing cookies, sweeping expired jobs, the standby reaper, and netdisk autosync.
They are collected in the scheduling center — **do not start a bare `setInterval` for a periodic need**, because that means every place has its own retry/logging/failure
handling and cannot reuse the others. The scheduling center embeds [Sidequest](https://github.com/lukin/sidequest) (inline runner + SQLite write to disk,
no extra container/queue needed), is driven by cron expressions, and includes retries plus observable run records for failures.

- **How to add a periodic task**: add a `ScheduledTask` entry (cron + handler) in `src/tasks/builtin.ts`;
  dependencies needed by the handler (cookie provider, events sink, netdisk store...) are injected declaratively through `TaskDeps`
  (`src/tasks/types.ts`), and `serve.ts` wires them once at startup with `setTaskDeps()`; do not capture global singletons
  in handler closures.
- **Two task types**: operational tasks are hard-coded in `src/tasks/builtin.ts` (Stream's own internals; change code to change schedules);
  business tasks live in the `scheduled_tasks` table in `data/stream.db`, and `run` means **run an external command**
  (`src/tasks/exec-runner.ts`); their schedule is edited in the UI, and after editing they are rescheduled immediately without restart. Both types compile into the same
  `ScheduledTask`, use the same Job class, and write to the same ledger — every past execution uses the same query path.
- **How external tasks report results**: the exit code only says the process did not crash. By convention, a task prints one line to stdout:
  `::outcome:: {"summary":"...","detail":{...}}`; the executor takes the last line, parses it into `TaskOutcome`,
  and stores it in the ledger (`src/tasks/outcome.ts`). If it does not report one, there is only the sentence `exit 0（任务没报 ::outcome::）` ("exit 0 (task did not report ::outcome::)").
- **Panel**: the task list, schedule, and past executions are in the channel whose `present` is `'tasks'` (`app/src/components/tasks/`;
  data goes through `/api/tasks`, `src/http/task-routes.ts`). The top bar uses the same slot as the other four Present modes
  (`ChannelTitleMenu` + 32px title row), and cards use acrylic `Card`/`Badge`/`Button`.
  Sidequest's built-in `/_p/sidequest` (through the gateway prefix; see `src/plugins/gateway.ts`) is still there, but it is
  a job perspective; all tasks share one Job class, so it cannot tell which is which — use the former to inspect a single task.
- **How schedules are read and edited on the page**: nobody can read raw cron at a glance, so on cards **human wording is primary, raw cron
  is secondary, followed by the next three trigger times** (`app/src/lib/cronFriendly.ts`: translation + preset compilation + next-trigger
  solving, with no third-party cron dependency). Editing a schedule means **first choosing the shape (every N minutes / hourly / daily / weekly / monthly), then filling in
  numbers**; the expression is generated from the preset. Complex expressions keep a `自定义表达式` ("custom expression") escape hatch, with validation and human wording while typing.
  Two rules must not be broken: **if it is not recognized, fall back to the raw text and never invent approximate human wording**; **when crossing time zones, or when "day of month" and "day of week"
  are both constrained, explicitly say `算不出来` ("cannot calculate") for the next trigger time instead of guessing** (cron implementations disagree on those two semantics).
- **Updating a user task must send the whole row back**: the write route only has a single-row upsert (`PUT /api/tasks/:id`); sending only
  `{ enabled: false }` is blocked with 400 at "command is required". The page's pause/resume and schedule-edit actions take the row from the list,
  send it back as-is, and override only one key (`saveTask` in `app/src/lib/api.tasks.ts`). These two controls are not drawn
  for built-in tasks — their schedules are changed in code, not in the database.
- **Grouping (`group`) only affects how this page is laid out.** The task table renders sections by it, with each section using a group-name subheading; rows without a `group`
  fall into the final `未分组` ("ungrouped") section (no group name is fabricated for them), and if all rows are ungrouped, no group heading is drawn at all. It **does not participate in scheduling,
  dependencies, concurrency, or routing** — do not give it execution semantics. It exists because tasks have been split more finely: one task per data source (different sources update at different times;
  sharing one cron would make freshness meaningless), and after splitting, the list is longer, so the UI cannot show that "these rows belong to the same market".
  Group names are not a whitelist: that editor cell is an **editable dropdown** whose candidates come from group names already used by existing tasks (including built-ins),
  and it can also accept a new one typed on the spot. Group order and candidate order are both sorted by group name (`localeCompare`, Chinese by pinyin), while order within each group is preserved as-is
  — the order is stable, and adding one task does not reorder the whole page. Built-in tasks are split into four groups: **登录态 / 网盘 / 意图 / 运维**
  ("login state / netdisk / intent / operations"; `GROUPS` in `src/tasks/builtin.ts`); the column in DB is called **`group_name`** because `group` is a SQL keyword.
- **Concurrency is controlled by three fields, each answering one question** (`src/tasks/types.ts`; see the `stream-cron` skill for the decision flow):
  - `serial` — **this task does not overlap with itself** (reject while uniqueness is live: if the previous run has not finished, skip this run).
    It only controls this task and itself; **it does not decide the queue and does not make it mutually exclusive with other tasks**. Invariant: **terminal jobs do not carry
    `unique_digest`** — carrying one would mean "forever queued", and every future shift for the same task would be judged duplicated. The startup sweep
    (`src/tasks/orphan-sweep.ts`) clears the digest when it marks claimed/running rows left by the previous process as failed,
    and also clears any terminal row that still has a digest, then logs it.
  - `exclusiveOn` — **the name of the thing this task exclusively owns** (the worker for an external data bridge, a login-state
    label, a write lock for a database file, the quota for one key). Tasks with the same name share queue `x:<组名>` (concurrency 1),
    so only one runs at a time; absent = goes into `default` (concurrency 4) and is not mutually exclusive with anyone. The name is the name of the **resource**,
    not the business category: `jq-bridge` is good (the harvester can tell at a glance whether it belongs in it), `cn-data` is bad
    ("does my task count?" is forever unclear). **An exclusively owned thing does not need a queue** — if only one task uses it, `serial` is enough.
  - `whenBusy` — when it cannot get a turn: `queue` (default, queue it) or `skip` (do not run this shift). There is only one check:
    **after being late, is it still the same work?** Backfilling, exporting, and publishing count -> queue them (queueing does not consume `timeoutMs`; that timer starts only when the child process
    is spawned, so "waiting" has no hidden cost). Actions with an external time window (subscription/reverse repo purchases, quoting before auction,
    submissions with deadlines) do not count -> skip this shift, and leave one record each in the backend log and the events panel (`task.skipped`, warn).
  Mutually exclusive queues are **created at runtime** (`Sidequest.queue.create`, concurrency 1): group names are typed by users on the page,
  so they do not exist in the static `queues` declaration. If a queue cannot be created, that task **is not scheduled** — a job for an unknown queue would write to the ledger and then
  never be picked up, which is worse than not scheduling it. The ticker for the `skip` tier is held by the scheduling center's own node-cron and does not go through Sidequest's
  `schedule()`: that path writes a ledger row directly when the time arrives and has no hook in between, while "if the group is busy, do not enqueue" must be answered **before enqueueing**
  (checking after enqueueing is too late — queue concurrency is 1, and that job will quietly sit in line, then run after the earlier one finishes).
  Missed-shift self-healing also passes through this check: missed shifts for skip tasks are not backfilled while the group is busy (`skipped-busy`, included in that watchdog round's
  summary and detail). `立即跑一次` ("run once now") is a human click and does not look at `whenBusy`; it enqueues as usual and lets the queue preserve mutual exclusion.
  The DB columns are `exclusive_on` / `when_busy`; on the page, rows with a mutual-exclusion group draw a small inline marker (group name + the `不排队` ("do not queue") label
  for the skip tier), without adding a new column — the vast majority of rows do not have it.
- **`立即跑一次` ("Run once now") always requires two-step confirmation**, and the confirmation state expires by itself after 5 seconds; **it is not tiered by task**. The reason is concrete: one mistaken click on an A-share
  reverse repo task = cancel all open orders + buy reverse repos with the whole position, and it cannot be undone that day. **The gate is attached to the action, not to
  the task's self-description** — do not add a self-description enum such as `effect` to task rows to tier them again: that field is filled by the row owner,
  has no backend consumer, and a wrong value does not error, so the gate silently disappears. The cost of this tier (one extra click for read-only tasks)
  is far smaller than the "no gaps" it buys.
- **All parameters of a task are its command line** (`command` / `args` / `env` / `cwd`); there is no second-level parameter
  model. "Which account to run with" is a word in argv (`--alias jagger`), so the configuration page puts these four fields in the same block;
  actual passwords/tokens are not on the task row at all. They live in the script's own configuration or in Stream's `runtime_config`.
- **Ledger retention**: `ledger-prune` cleans once every day at 04:15; for each task, keep the latest 200 runs or 30 days, whichever is wider.
- **Login-state export (`session-export`, every 10 minutes)**: the **outbound direction** of the credential domain. Previously the login state held by the host
  had only two in-process consumers (harvest injection into env, plugin containers receiving Cookie headers). This is the third one — **a local process we do not
  own**, which reads a disk file according to its own convention. It exists to remove the second browser that process started itself
  just to get login state: the same login state already exists in the user's own Chrome, and Stream is already fetching it
  (`cookiePull`). The declaration exists only in `session_exports` in `config.yaml` (if there are no entries = the whole slot is not assembled,
  and this task does not appear in the task table). The implementation and three boundaries are in the header comment of `src/credentials/session-export.ts`:
  **no API/UI entrypoint**, `extras[].url` must fall under the declared `domain` and pass the SSRF gate, and files are 0600.
  The declared `domain` is merged into `requiredCookieDomains` (the second source; `auth` in the manifest is the first)
  — missing this union means every round receives empty cookies and **no place reports an error**. The period is 10 minutes, not merely "fresh enough":
  that cookie-bearing GET also resets the site's session idle timer to zero; **besides keeping it fresh, it keeps it alive**,
  intentionally.
- **The backend must keep itself alive**: the scheduling center runs inside the backend process, so "whether the backend is present" directly decides "whether tasks run". The resident form
  is `scripts/stream-back.service` (`Restart=always` + start on boot, with installation instructions in the file header comment); `scripts/dev.sh`
  stops it on entry and starts it back on exit, and the two competing for the same 8900 are covered by the single-instance lock in `serve.ts`.
- **Boundary (no takeover across it)**: the scheduling center only handles "operational periodic tasks"; the main harvest path (T1 `tick(stream)`, see
  `scheduler.ts` in the Data Scheduling section above) does not migrate into it — that path's chained `setTimeout` self-rearming, jitter,
  exclusive degrade, and other semantics are harvest-specific. The two schedulers each own their own area and do not swallow each other.
- **Regression prevention**: `src/tasks/no-bare-setinterval.test.ts` runs a full word-boundary grep over `src/` (`\bsetInterval\b`);
  anything outside the whitelist FAILs — new periodic needs must not bypass the scheduling center by starting bare timers.

## In-Process Kernel (Cordis): Domain Plugin Tree and Lifecycle

The backend process assembly skeleton is [Cordis](https://github.com/cordiverse/cordis) (`cordis@4.0.0-rc.8`,
with the exact version locked). `bootstrap()` (`src/bootstrap.ts`, ~530 lines) does only one thing: create kernel -> mount
**domain plugins** in dependency order -> return `{ config, kernel }`. Cross-module capabilities all live on `ctx.<domain>`, and domain plugins live in
`src/kernel/plugins/`, one file and one aggregate object per domain (declaration merging is declared nearby).

Assembly order (that is, dependency order): settings -> credentials -> packages -> sources -> storage -> streamEvents ->
harvest -> auth -> adapters -> provider -> llm -> netdisk -> search-fanout -> conversions -> agent ->
scheduling. There are also three mechanism pieces: `runtime-config` (the only runtimeConfig parser), `backend-directory`
(the only merged list of packages with backends), and `module-hooks` (module-level hooks mounted/unmounted with the kernel + unwired report).

`ctx.llm` (`src/kernel/plugins/llm.ts`) is the single point for **the backend itself** to make all outbound LLM calls, with only two slots:
`forTask` (task-level calls routed by callsite, with a callsite-by-day usage ledger and validate-failure escalation) and
`usage` (ledger, cache.db). **It has no HTTP surface** — all consumers are inside this process, and not a single HTTP hop is involved.
A new feature that needs LLM = register a callsite + bind a Provider row; do not configure a separate endpoint+key entrypoint.

The model in the chat is **another path**: it belongs to the user's own host (Claude Code / Codex / DSH), and the host directly calls
its configured gateway. It does not go through `ctx.llm` or any Stream endpoint (see the "Chat" section below). Each path keeps
its own ledger; do not expect to see everything in one place.

Rules (must read before changing this layer):

- **ctx keys always carry a domain prefix or domain name**; upstream cordis occupies `logger/events/registry/reflect/fiber` —
  especially `events`: `provide('events')` does not throw and does not override; it is **silently ineffective**, so the event layer is called `streamEvents`.
  See the header comment of `src/kernel/context.ts` for the full rules.
- **Objects holding handles/timers/watchers/WSS must be registered with `ctx.effect()`**, and their disposer closes them. Shutdown uniformly goes through
  `quiesceKernel(kernel)` (revocation in reverse registration order); handwritten shutdown in the serve layer is reduced to stopTaskCenter/standbyMgr.
- **Forward dependencies between domains use runtime dereferencing** (thunks / reading `ctx.<domain>` at call time), never destructuring during assembly and saving snapshots —
  symptoms of assembly-time freezing are hot-swap failure/startup-window silent distortion, with no error. The real scheduler<->service cycle is closed
  inside the scheduling domain (the `onFeedTitle` callback dereferences at runtime).
- **HttpDeps keys are frozen** (header comment in `src/http/app.ts`): add new capabilities under `ctx.<domain>`, not by adding keys.
  Note that there are several **direct connections that do not go through HttpDeps** (plugin gateway, standby, taskDeps, mountMcp, mountLlmIngress, mountConfigRows, registerDshRoutes,
  mountLiveRoutes, mountResearchRoutes, two WS attaches, stdio disk tier) — when changing domains, use
  `rg "boot\.<字段>"` plus the closing scan keys from each batch spec to cross-check.
- **Stream packages are not Cordis plugins**: packages (`packages/<id>/`) are a cross-process trust boundary (the six-slot model);
  kernel plugins are in-process composition units, and the two never merge.

Evolution history and each batch of verification live in the `internal design record` (parent spec + eight batches).

## Serving

The core backend (`src/serve.ts`) hosts the REST API (`/api/*`), the WebSocket feed (`/ws`),
MCP mounted at `/api/mcp` (streamable HTTP, same
Bearer auth), and reverse-proxies `/_p/<plugin>` to plugin containers (see GATEWAY.md). It is
served behind **one published entry, `127.0.0.1:8900`**:

- **Native host process (dev / installed CLI / MCP — the main path)** — the node
  backend binds `127.0.0.1:8900` **directly and is itself the door**: no Caddy anywhere. `/api`,
  `/ws`, `/_p` it answers itself; `/panel/*` serves the prebuilt panel bundles
  (`src/http/panel-mount.ts`); everything else falls through to the standalone front door, a
  self-contained page that mounts those bundles (`src/http/standalone-page.ts`). It must live outside the container to see the *user's own
  Chrome* (probe it, launch it, share a filesystem with it) — see
  `2026-07-29-backend-native-single-entry-design.md`. Packaged, it is the bundled `server.mjs`
  the `stream` command runs; in dev it is `tsx watch src/serve.ts`.
- **Docker Compose (self-host branch only — NAS/VPS)** — the `gateway` container (Caddy)
  publishes `127.0.0.1:8900→80` and forwards to `serve-backend`, which listens on `4555`
  **inside** the network (not published; host `curl :4555` won't hit it). Generated by
  `pnpm plugins compose --selfhost`. That form has no "user's browser" side at all, so
  login-gated human harvest doesn't belong to it.

Ways that one backend gets started (all the same process, same port, same door): `pnpm dev`
(= `scripts/dev.sh`: `tsx watch` + a host Vite, the dev default), `pnpm serve` (= `tsx src/serve.ts`,
no watch — what the packaged `server.mjs` is), or the self-host container.
Never two at once on `8900`; there is exactly one entry per machine.

**Process-level fallback net** (`src/process-guard.ts`, attached in `main()` right after `createKernel()`; the source tree and packaged
`server.mjs` share the same entry, so both forms are covered): an orphan promise's `unhandledRejection` **no longer takes down the entire
process** — the full stack goes to the error log + one `process.unhandled-rejection` notification (severity `error`);
`uncaughtException` is also recorded + notified (`process.uncaught-exception`), but **still exits(1)** and lets the
supervisor bring it back up (the stack is torn halfway through, and continuing to serve with half-state is worse than dying). **This is not a silencer**: logs must never be
degraded into summaries, and this layer must never grow a whitelist for "classify and then ignore some categories" — the thing to fix is the orphan promise itself.

### Frontend↔Backend Transport (two kinds; authoritative definition is in the `backend-connection` spec)

Stream's own UI is several IIFE bundles built from `app/` (`app/dist-panel/panel*.js`), served by the backend door
(`:8900`) from `/panel/*` (`src/http/panel-mount.ts`), so the page is same-origin with the API. There are two shells that mount it:
the standalone front door on 8900 (`src/http/standalone-page.ts`; every path not claimed by `/api`, `/_p`, or `/panel` falls to it),
and the Stream UI plugin page inside the user's DSH (cross-origin, but the origin is a local address and `isTrustedOrigin` trusts it by default).

There is only one transport: **native `fetch` + native `WebSocket`**. The same-origin tier (the browser talks directly to `:8900` — in dev the page
is Vite reverse-proxied by the backend, in release it is static assets served by the backend; the self-host tier is same-origin hosted by the edge Caddy) has an empty base URL and
uses relative paths; the cross-origin tier (the panel lives on the user's DSH page) uses the backend's own origin as the base URL.

**Who upstream points to (discovery ladder)**: ① the **remote backend URL** the user configured in settings — first priority, probe health and use it directly;
② not configured → same-origin relative paths, no port probing. Configured but probe fails → fall back to same-origin.

### MCP over stdio (on-demand)

MCP has two transports over **one** tool codebase (`src/mcp/tools.ts` + `src/mcp/tool-catalog.ts`):
the HTTP mount above (`/api/mcp`, unchanged — requires the backend already running) and **stdio**,
which an MCP client spawns on demand — no standing backend required.

**On a normal install the stdio entry is the CLI itself: `stream mcp`** (`src/install/mcp-command.ts`,
registered as `claude mcp add stream -- stream mcp`). It is a pure forwarder: probe `GET /api/health`
on `STREAM_BACKEND_URL` (default `http://127.0.0.1:8900`, 2 s), then relay every `tools/list` /
`tools/call` to that backend's `/api/mcp`. It builds no StreamService and opens no database, so it
cannot become a second writer. Backend absent → it spawns one (the same `bin/stream.mjs`, not a
second startup path) and forwards once health goes green.

**A source checkout keeps a second, richer stdio entry** (`src/mcp/stdio-entry.ts`, run via
`pnpm mcp:stdio` = `tsx src/mcp/stdio-entry.ts`). It exists for the case `stream mcp` deliberately
does not cover: answering **read** tools with no backend anywhere. On startup it probes the same
`GET /api/health` on `STREAM_BACKEND_URL` (default `http://127.0.0.1:8900`, 800ms timeout — any
failure or timeout counts as absent, `shared/mcp/probe-backend.ts`):

- **Backend present** → the process becomes a thin **backend-forward** proxy
  (`shared/mcp/backend-forward.ts`, the same forwarder `stream mcp` uses): every tool call is
  relayed to the running backend's `/api/mcp`.
  It never opens `stream.db`/`cache.db` itself — the backend stays the DB's sole writer.
- **Backend absent** → the process opens the on-disk stores itself via `bootstrap()`
  (`src/mcp/disk-service.ts`, **without** starting the scheduler) and serves **read** tools
  (list/search/preview/status, …) directly off disk. **Write/action tools** (subscribe,
  unsubscribe, schedule/reschedule/unschedule a Stream, refresh, transcribe, netdisk apply-spec,
  search-agent start, chrome_cdp/close-tab, …) degrade: they throw/reject a structured
  `NeedsBackendError` (`code: 'needs_backend'`, message tells the caller to start the backend and
  retry) instead of touching the DB or driving a live browser — zero writes, zero process/browser
  spawns.

Relevant env vars: `STREAM_DATA_DIR` (data dir for the disk-service branch — same variable the
Docker/desktop backend uses), `STREAM_CONFIG` (config.yaml path override), `STREAM_BACKEND_URL`
(probe target, default `http://127.0.0.1:8900`), `STREAM_NO_SCHEDULER=1` (query-only backend: skip
`scheduler.start()` so no standing harvest runs — `spawn-backend.ts` injects it by default when the
stdio router spawns a full backend on demand, matching the disk-service branch's scheduler-free
posture; explicit callers can override).

Claude Desktop `mcpServers` config sample — the normal install first, the checkout form second:

```json
{
  "mcpServers": {
    "stream": { "command": "stream", "args": ["mcp"] },
    "stream-checkout": {
      "command": "npx",
      "args": ["tsx", "--tsconfig", "/path/to/stream/tsconfig.json", "/path/to/stream/src/mcp/stdio-entry.ts"],
      "env": { "STREAM_DATA_DIR": "/path/to/stream/data" }
    }
  }
}
```

The **checkout** entry is still a `tsx`-run TypeScript file and is not packaged into a binary; the
published package reaches the same tools through `stream mcp`, whose bin is the bundled
`server.mjs` CLI (that packages `serve.ts`, not `stdio-entry.ts`).

Per-client registration recipes (Claude Code, Codex, antigravity/Gemini CLI, Claude Desktop) for
both transports live in [`README.md` → *MCP usage*](../README.md#mcp-usage). Note that the served
tool set is defined here, server-side: when tools change (e.g. a rename), clients pick it up by
reconnecting/restarting — a running MCP session keeps the `tools/list` it fetched at startup.

### Backend Lifecycle: Two Modes + Layered Installation

On-demand MCP (the stdio section above) solves "queries do not need a standing backend"; but **timeline harvest fundamentally needs "someone to go
run on schedule"** — without a live process, nobody triggers the cadence timer. This is the fundamental difference between harvest and MCP queries, and it is also where the question "does the backend
need to be standing after all" comes from. The answer is not two products, but **two modes of the same core**, differing along only one axis:
whether there is a standing resident process (OS service).

|  | **No resident process** | **Has a resident process (OS service)** |
|---|---|---|
| Pure MCP | On demand: stdio starts, disk reads / writes degrade to `needs_backend`. When everything is closed, nothing runs. | Headless server: the backend stays resident as an OS service, MCP always forwards to it, Channels update automatically in the background, and Claude can query the latest state. |

**The core (node backend + MCP, one codebase, one entry) does not change by even one byte between these two cells.** The only thing that changes is "who is responsible for keeping it alive".
The DB single-accessor invariant holds automatically, without relying on locks: the probe-first discipline (see the stdio section above) guarantees "if the service is running, forward/reuse it;
only do disk reads when it is not running".

**Layered installation** (put "core is the only invariant" into the physical installation layer, not just runtime behavior):

```
L0 core base   node backend + MCP (one codebase, one entry)   ← always present, the only invariant
L1 MCP registration    stdio command written into client config                ← points to L0, almost always present
L2 resident (optional) OS service unit (systemd user / LaunchAgent / login task)  ← points to L0, runtime switch
```

**There is no desktop-shell layer**: the UI is the panel served by the 8900 door, plus the Stream UI plugin inside the user's DSH. L2 only
"points to L0"; it can be installed or removed at any time without changing L0. A pure MCP user really installs only L0+L1.

**Companion extension (`extension/`).** A standalone WXT/MV3 Chrome extension is a thin face
over this API: it tells Stream which cookie domains are worth pulling (and answers the backend's
`op:'cookiePull'` over the relay) and discovers/subscribes sources for the current
page via `GET /api/intents` + `POST /api/streams/from-intent` (classify a URL → build the
member → create the Stream in one call). It ships no radar rules and no resolve logic — the
brain stays in Stream. See `extension/README.md`.

**How it gets installed into the user's Chrome.** The three-state decision comes from `GET /api/browser-capability`
(`ready` / `disconnected` / `never-seen`); onboarding appears only for `never-seen` — `disconnected` means
"installed before and then dropped", so it goes to troubleshooting, not another prompt to install it. Onboarding appears in three places: the banner when the panel first opens (after one decline,
`extension_onboarding.declinedAt` is written to `settings.json`, and it is no longer mentioned on startup), the fixed entry in the settings page that is
**always present**, and the in-context prompt shown when a user-initiated action cannot complete because the extension is not connected (the same capability is
mentioned at most once per day).

Three action endpoints: `POST /api/extension/materialize` (materializes the extension directory into `<dataDir>/extension/`,
returns the absolute path), `POST /api/extension/install` (assisted install, see below), `POST /api/extension/decline`;
also `POST /api/extension/uninstall` (uninstall) and `POST /api/extension/reload` (clicks `重新加载` ("Reload") on the extension details page,
using the relay obtaining a new connection as the check; **the whole flow goes through Stream Desktop and not through the relay**, so it remains reachable when the extension is disconnected),
`POST /api/extension/console` (reads the extension background console, also not through the relay) — these four desktop recipes share the four `openExtensionsPageSteps` (`src/browser/chrome-ext-page.ts`) steps to enter the extension page;
also `GET /api/extension/onboarding` reads "whether it has been declined before". **Manual install and assisted install point to the same directory**,
so when something goes wrong there is only one troubleshooting path. There are three directory sources (the check is always **whether the artifact exists**, not "whether this is dev mode";
resolution lives in `shared/browser-relay/extension-dir.ts`):

1. `extension/.output/chrome-mv3` in the repository — development machines (the check is whether an artifact exists at that relative path under cwd).
2. npm package `@streamapp/chrome-extension` (directory = `chrome-mv3` under the package root) — CLI distribution packages
   (`cli/package.json` depends on it) use this tier: on a clean install machine, the repository artifact is absent.
   This package is published by `scripts/publish-extension.mjs`, and its version copies the extension's `manifest.version`.

Assisted install (`src/browser/extension-install.ts`) and uninstall (`extension-uninstall.ts`) are each a
`kind:'desktop'` recipe, running on the same `runDesktopRecipe` as telegram/qq — the same failure checks,
the same captured scene, and the same session lease (the takeover indicator and the `Ctrl+Alt+Esc` abort both hang off that lease). Three facts must be
known: whether developer mode is on **cannot be read**; the check is whether the `加载未打包` ("Load unpacked") button exists. The folder dialog
is an **independent top-level window** (an owned window of the Chrome main window, but the process is still `chrome.exe` itself),
so you must `scopeWindow` into it before its controls can be found. Window-title matching is **contains** matching, so the extension page title must be
written in full as `扩展程序 - Google Chrome` ("Extensions - Google Chrome") — writing only `扩展程序` ("Extensions") also matches the dialog's `选择扩展程序目录。` ("Select extension directory.").
The control-name candidate table is in `src/browser/chrome-ext-page.ts`, all from live measurements; every step leaves one
`[desktop-probe]` timestamp line in `out.log`, so look there first when something goes wrong.

**There is only one success check: the extension connects to the relay** (`browser-capability` becomes `ready`). Seeing a card appear on the page does not count
— the two can quietly split, most commonly because the native messaging manifest is registered only after this Chrome launch. Therefore
"steps completed but not connected" returns `needs-chrome-restart`, not "install failed". The developer-mode extension bubble on every startup
is a known cost and cannot be worked around (store publication can avoid it, but the extension needs to read the local `data/ext-relay-token`).

### Process Outbound HTTP Ownership

The embedded RSSHub request-rewriter patches `globalThis.fetch` and
`node:http`/`node:https` `get`/`request` at **process level** during lazy loading (when there is no Referer, it force-injects a self-origin Referer). So outbound traffic has two branches:

- **Stream's own outbound traffic** → always goes through `src/http/owned-outbound.ts`: `ownedFetch` (Response semantics) or
  `owned.{httpGet,httpsGet,httpRequest,httpsRequest}` (streaming / Range / precise headers). It snapshots the original bindings
  **synchronously at top level** during process startup (structurally before RSSHub runtime lazy loading), so the rewriter cannot reach them; `serve.ts` imports it **first** after `load-env`
  to guarantee capture order; the key sentinel test `owned-outbound.sentinel.test.ts` locks down the capture mechanism itself
  (patch after import, and the already-stored references are unaffected).
- **RSSHub routes** → go through their own rewriter and not through owned (that is RSSHub's internal affair; do not touch it).
- The SSRF guard (`safe-fetch.ts` `isPrivateHost`/`publicHttpUrl`) and per-host Referer policy
  (`media/serving.ts` `refererForUrl`; data comes from the package's `serving[].referer` declaration) are **business-layer** responsibilities; they run above owned and do not sink into owned.
- **Do not create a fourth private bypass**: outbound traffic that must be unreachable by the rewriter should import owned; do not write another node-http snapshot. The remaining
  global `fetch` callsites are migrated in evidence-based batches (see `openspec/changes/owned-outbound-http/recon.md`).

## Diagnostics — Two "Flight Recorders", Different Layers, Do Not Mix

They have the same name but no relationship. Both are called flight recorders because the idea is the same: when a failure happens, the participant is already dead and cannot report for itself,
so the only option is sampling ahead of time and collecting evidence afterward.

| | Event-loop lag recorder | OOM diagnostics recorder |
|---|---|---|
| Observes whom | **backend** Node process | **frontend** Chrome tab (renderer) |
| Code | `src/loop-lag.ts` → `src/serve.ts` | `app/src/lib/diagnostics/` |
| Records what | `perf_hooks` event-loop delay histogram + task-level attribution (`src/op-track.ts`, always on) + CPU profile attribution (on demand) | heap / DOM scale / audio buffers / audio events |
| Records where | one stdout line + DebugBox `loop` Channel | browser IndexedDB (`stream-diagnostics`) |
| Normal state | **always on**, zero noise when idle | **off by default**, enabled in the backend settings Sheet |
| Why needed | When synchronous operations block the event loop, even its own logs cannot be printed | After the renderer is killed by OOM, no code can execute anymore |

### DebugBox's Two Layers: Use the Ring for the Present, Use the File for Intermittent Issues

Both are fed by the same `recordDebug` in `serve.ts`; producers for any Channel do not need to care which layer they enter:

| | In-memory ring (`src/http/debug-log.ts`) | Written to disk (`src/http/debug-sink.ts`) |
|---|---|---|
| Stores where | In-process, 200 entries **shared across all Channels** | `data/debug-failures.jsonl`, one JSON entry per line |
| Collects what | All entries | **Only `ok:false`**, and **byte-identical duplicates are folded in 10-minute windows** — the file is evidence, not a transaction log |
| Lives how long | **Gone as soon as the process restarts** | Stays around; over 4MB it rotates to `.jsonl.1`, keeping only one generation |
| Read by whom | `GET /api/debug/log?channel=…`, frontend DebugBox | humans / agents directly `grep '"<频道>"' data/debug-failures.jsonl` (`<频道>` = `<Channel>`) |

**When reading this file, check `_repeated` first**: a line with this field means "it also appeared N times in the previous window",
so it is **normal-state noise**, not an intermittent scene. Lines without this field are the ones that only rang once.

**Why the second layer is mandatory** (learned the hard way): investigations for intermittent failures are all written as "observability is in place; wait until a scene appears",
but that sentence is false when probes only enter the in-memory ring — during development, `tsx watch` hot-reloads dozens of times a day, and one harvest round can flush all 200 entries.
Live measurement: for three TODOs that had each waited several days, reading the ring later showed only the one minute when the backend started.
**Observability placed somewhere that gets cleared is equivalent to no observability**; these walls/races also heal themselves, so without a retained scene they can never be reproduced.

The only check for "which entries are worth preserving" is the one in the sink — the ring unconditionally forwards every entry to it (`debug-log.test.ts` pins this down;
adding a second `ok` filter in the ring turns the test red immediately).

**Why fold duplicates** (also learned the hard way): half a day after writing-to-disk went online it had already accumulated 2.2MB, and among 1216 `plugin-target` entries,
**1184 entries were byte-identical** — standby put the voiceprint container to sleep, and the routine probe truthfully answered `没有地址` ("no address") once per minute,
continuing for 21 hours. This is not a failure, but at this rate it runs through one rotation in a day or two, while the intermittent scene being waited for may only appear after several weeks:
**noise pushes evidence out before it arrives**, which just changes "cleared in a few minutes" into "flushed in a few days". The folding check is
**byte-identical** (channel+key+summary+fields), and must not be relaxed to channel+key — real scenes carry
duration/status code in their summary and almost never repeat, and after relaxing, the second real scene with the same key would be blocked by the first one.

**Key invariants of the OOM diagnostics recorder** (design and details: `internal design record`):

- Write `running` as soon as the session starts. Seeing `running` again on the next startup = the previous run could not finish → rewrite to
  `suspected-abnormal`. This is **inference, not confirmation** — do not describe it in the UI or conclusions as "confirmed OOM".
- Data is **stored only locally and exported only by explicit user action**; it is not uploaded to the backend or given to third parties. Playback URLs keep only the host +
  hash of the pathname, and discard query/fragment (the signing key is in the query).
- Field value `null` = **not measured**, not "measured as 0". `performance.memory` is a Chromium-only
  **trend** metric; it is not equal to total renderer memory and cannot be used alone for attribution.
- Pruning is isolated by session; session eviction first drops routine `ended` sessions and sorts by `lastWriteAt`. **Both are lessons learned the hard way**:
  global pruning lets new sessions evict samples from a crashed session; sorting by `startedAt` treats a session that "played for 70 minutes before crashing"
  as the oldest and deletes it — both variants destroy exactly the only meaning of this feature.

## Conversation

**Conversation is not in Stream; it is in the host.** Stream contains three kinds of things, each with a different home (spec
`2026-09-05-stream-stops-hosting-dsh-design.md` §1.3): **backend** (scheduling, harvest, follow loop, archive -- the resident process,
the backend on 8900), **capability** (called once, does one job; the form exposed to agents is MCP + skill), and **viewing** (monitor, inbox,
film and music, netdisk browsing -- the standalone front door on 8900, `src/http/standalone-page.ts`, mounting the panel bundles under
`app/dist-panel/`, with no conversation inside). Conversation belongs to the user's own host: Claude Code, Codex, and DSH all drive the backend through
`/api/mcp`, and skills tell them how to use it (`src/skills/shipped.ts`).

**The host side has only one line, pointing to Stream**: `claude mcp add stream -- stream mcp` (Codex has one `mcp_servers` line in
`config.toml`; in DSH's stream-ui bundle, that `dsh-mcp-client` line points directly to
`http://127.0.0.1:8900/api/mcp`). `stream mcp` (`src/install/mcp-command.ts`) is a stdio shell:
it probes the backend once, forwards the whole surface when it is present, and starts it first when it is absent. **This line does not need to change afterward** -- no matter how many capability packages are added to Stream,
tools all go out through the same opening.

**Stream does not install, start, or proxy any host.** The repository does not contain DSH version numbers; `child_process` does not contain `dsh`
(`src/no-dsh-hosting.guard.test.ts` pins this down). If this is packaged into a product with conversation in the future, the thing that starts DSH is a **launcher** above the backend and
DSH, not the backend (spec §2.1).

**The DSH path has one more thing: the Stream UI plugin** (`hosts/dsh/`, npm `@streamapp/dsh-plugin-stream-ui`).
It is a DSH **bundle**: after the user runs `dsh plugin --profile web add` to add it to a profile with a web UI, the package's `cordis.patch.yml`
is overlaid onto that profile -- it turns off the web-app full-page shell and sidebar, inserts a `dsh-mcp-client` line pointing to Stream's
`/api/mcp` (`serverName: stream`; the name seen by the model is `mcp__stream__<raw>`, and the UI plugin registers custom cards by this prefix),
and inserts this package. After installation, DSH's whole face is Stream (the content stream is the main surface and conversation is the side column; the same panel
bundles are fetched from `/panel/*` on 8900), and cards and sessions can send data to each other -- this is DSH-specific icing; the 8900 standalone page
has no conversation, so it also has no such linkage. The mechanism readings for shell inversion are in spec `2026-08-17-stream-as-dsh-plugin-design.md`
§9-§15; the installer is the user.

**The "space -> Channel" navigation is the panel bundle's second mount point** (`mountNav`), not something owned by the host: the standalone
front door on 8900 places it in the left column, and the DSH shell places it in that segment of the sidebar. Both places mount the same code; the host only decides where to place it and where to point the
`--stream-nav-*` color tokens in its own variables. The "current Channel" is synchronized inside the bundle between the two mount points;
**the host is not an intermediate relay** -- the old round-trip contract where each host kept its own mirrored state has been retired
(spec `2026-09-06-shared-sidebar-nav-design.md`).

Under the navigation tree there is also a **host action bar** (`mountNav`'s `footer`): the `管理` ("manage") entry and the light/dark toggle, **each is drawn only if supplied,
and if neither slot is supplied the whole bar does not appear**. The standalone front door on 8900 supplies both slots (so that page **has no top bar** -- title, management,
and light/dark all live in this bar; management is an overlay over the content, and the content area's tree stays alive from beginning to end and is never unmounted); DSH supplies no slot
(it has its own settings window and theme toggle), so the DOM in the sidebar is byte-for-byte the same as when this bar does not exist.

That page needs to call Stream's `/api/*`, while its origin is the user's dsh web port -- Stream does not know that number and does not need to:
local origins (127.0.0.1 / localhost on any port) are trusted by `isTrustedOrigin` by default. Only when the backend and DSH are not on the same machine
does that page's origin need to be registered in the allowlist through `STREAM_TRUSTED_ORIGINS` (comma-separated, exact string match).

**Models, tool surfaces, and presets all belong to the user's DSH.** Models are configured in DSH's `设置 - 模型` ("Settings - Models") page; whether the model has bash in hand is
the user's profile's concern, and Stream neither guarantees nor guards it. Session titles use the user's own model.

**Capability packages are installed into Stream, not into DSH** (see the definition of "capability package" in the "Capability normalization" section):
`stream add @streamapp/<x>`, and tools go out through `/api/mcp` on 8900. On the DSH side there is only one MCP client line pointing at
`http://127.0.0.1:8900/api/mcp`; whether capability packages are installed or not, it does not need to change a single word. The only thing that needs to be installed into the DSH profile is
`dsh-plugin-stream-ui` (that package must go into a profile with `dsh-web-app`, for example `web`). When a netdisk package needs to reuse Stream's
OpenList (external file), it calls `GET /api/netdisk/openlist-access` to get the gateway path and permanent token,
and writes them into the `capabilities.netdisk` slot in `config.yaml`.

**The backend does not read the host's private files, with no exceptions.** What the user and host have talked about belongs to the host itself (DSH has its own session history),
and Stream provides no read interface -- reading another product's internal log format silently reads empty as soon as the format changes.

**What remains under `src/agent/` is not chat**: `search/` (goal-oriented discovery loop, spec 2026-07-15) and
intent tracking / web-search ladders / `mcpExtras` tool surfaces in the `ctx.agent` domain -- they were never related to the chat path;
they only share the same `llm.chat` callsite and the same tool surface.

**There is one discovery loop and two domains** (spec 2026-09-01). `runSearch` (`src/agent/search/flow.ts`)
is the skeleton for "search leads the way -> find habitats -> enter nests and extract candidates -> verify -> search another round after learning"; the code determines branches and stopping
conditions, and the LLM is only asked at three joints (what search terms / whether this item is a nest or goods / whether it is on topic). **All domain differences are contained in
one injected `DiscoveryDomain`, with only five slots** (`domain.ts`): `parse` (recognize candidates from a nest page),
`check` (whether this item counts), `habitat` (where this kind of thing usually appears), `identityOf` (whether two items are the same
one), and `originsOf` (which nests this item comes from).

| Domain | What the candidate is | Verifier | Tool surface |
|---|---|---|---|
| `netdisk` (`domains/netdisk.ts`) | One netdisk share link | Open the link to verify liveness (`netdisk.share.verify`) | `search_agent` -- takes one free-form description and finds acquisition channels for **one specific thing** |
| `catalog` (`domains/catalog.ts`) | One product model + price + origin | `price_search` (existing capability, no new Source) | `enumerate_candidates` -- takes **structured constraints** and answers "which ones meet the conditions" |

The two tools are separate instead of adding a parameter because **their input shapes differ** (free-form description vs constraints that are already structured); stuffing them into
the same `goal: string` is equivalent to flattening structure into prose and then asking the LLM to guess it back. Both share one run library
(`agent-runs.db`) and `get_agent_run`; the `domain` on the record is **a prerequisite for reading `targets`** -- the two
domains have different candidate shapes while sharing one slot.

**Candidate sets must carry provenance.** Enumeration cannot be exhaustive, so `stopped` (converged / truncated by round limit / early stop /
source expansion dried up) and `coverage` (how many rounds, how many nests opened, how many remain unopened, how many extracted, how many remain after verification) are first-class
products in the receipt: **computing dominance over any subset is not "incomplete" but misleading** -- "X has been excluded" is printed with equal confidence,
while the actually cost-effective item may never have entered the candidate set. The downstream consumer of this check is the dominance calculation in `purchase_decide` (see `research record` in the "Best price-performance"
section).

**The entire purchase-decision route runs in code, not in prompts** (`src/agent/purchase/job.ts`, spec
`2026-09-02-purchase-decision-job-design.md`). The tool is `purchase_decide`: one call completes
"enumerate the full set -> who was named in comparative reviews -> fetch prices for each item -> dominance calculation -> receipt". **The model is only at three narrow openings**:
turn the user's words into structured constraints, read one comparative-review page, and explain the receipt in human language. It cannot change numbers, and models that appear in the answer must
be in the receipt.

Why this belongs in code: **a prompt is a request, not a constraint** -- writing nine steps as a few hundred words of instructions and handing them to the model to execute conscientiously
most often skips exactly the enumeration step. Likewise, **this line has only this one entry point on the tool surface**: if the model is also given a tool to "manually
assemble the final answer", it will copy the receipt field by field and change the semantics while copying (`残值查不到` ("residual value unavailable") -> `残值按 0 计` ("count residual value as 0")).
The receipt is the final answer, and the Stream UI plugin renders it directly as comparison cards. **Run first, ask later**: only the category is required; everything else starts with defaults,
and the receipt reports its assumptions itself -- making it interview the user first produces a five-line questionnaire and no tool call. **There is only one source file for wording**:
`.claude/skills/purchase-decision/SKILL.md`, and every host that ships to users reads it (`src/skills/shipped.ts`).
The fixed shape of a closed job = one MCP tool (the route) + one skill (the wording).

The three checks that only this chain has are all in `job.ts`:

- **Enumeration prefers direct lookup first, not discovery first**. Categories with a product library to query (`手机` ("mobile phone") -> `packages/zol/`) assemble URLs by category and
  price band and fetch them once, with zero LLM. The discovery path is reserved for categories without a product library.
- **The enum at the extraction joint must include an escape item** (`NOT_IN_SET` in `signal.ts`). Forcing the model to choose from the candidate set
  without giving it a "none of these" item makes it pick one and write a perfectly plausible reason -- **the field itself becomes a fake correct answer**.
  The escape item's count is a first-class receipt field: it is the only clue for whether "full-set capture missed anything". In addition to the enum there is also post hoc set validation;
  both are required (this path has no grammar-level constrained decoding available; see spec §4).
- **Numbers that cannot be fetched must not be silently replaced with defaults, and must not make the system play dead either**. If the user says they will resell but retention-rate data cannot be found, do not calculate
  "holding cost" with residual value treated as 0 (that records an extra cost out of thin air and incorrectly cuts the item, while the table looks normal), and do not kick it out of comparison
  (that leaves the frontier empty and gives the model nothing to hand over). The approach is to **degrade the entire receipt uniformly to sorting by purchase price** and say so loudly in the first-class field
  `residual.mode: 'purchase_only'` -- the semantics must be consistent for everyone; deducting one item but not another puts them on different axes.

**Found -> connect as subscription.** After an address is found in conversation, connecting it is a three-step jump: the search tool gives a URL ->
`resolve_intent` (`RadarMatcher`, finding who can consume it by domain + path template) -> `subscribe_source` creates a Stream.
Streams subscribed on behalf of the user all land in the Channel `对话订的` ("subscribed from conversation", id `agent-subscriptions`) -- this gives the user a way back and makes it obvious at a glance what the AI
subscribed for them. **Creating the Channel must come before subscribe**: when `StreamService.subscribe` receives a nonexistent Channel id,
it silently does not attach (the Stream is created and scheduling is added, but it belongs to no Channel and no error is reported anywhere), so that step has converged into the named
`ensureChannel`. When connection fails (`matches` is empty), the assistant says so truthfully and stops, while calling `note_unonboardable` to record it in
the `想接还接不了` ("wants to connect but cannot yet") list (`/api/onboard/wishlist`) -- that list depends on the model proactively calling it and is **not guaranteed to be complete**.

## Data & File Structures (target state)

The designed shapes, from the model above — current code differs (see
[Where things live (current code)](#where-things-live-current-code) and
[Migration notes](#migration-notes)).

**One base shape, two states.** Stream and Provider share a base record; the discriminant is a
derivable property — are all member params bound? — not a flag (invariant 3 encoded in data):

```ts
interface StreamBase {
  id: string                            // global identity (Streams are reusable across Channels)
  label?: string
  strategy: 'fanout' | 'exclusive'      // members complementary → fanout; interchangeable → exclusive
  members: SourceBinding[]              // ordered = priority when exclusive
  contract?: CapabilityContract         // exclusive accept-predicate (e.g. lossless)
}

interface Stream extends StreamBase {   // fully bound → schedulable
  cadence_seconds: number
  mode?: 'feed' | 'collection'          // storage shape: unbounded append/evict vs bounded full-refresh
  inputs?: never
}

interface Provider extends StreamBase { // call-driven → on-demand; may be parameterless
  inputs?: Record<string, ParamSpec>    // declared call-time params when the capability needs them
  capability: string                    // glue-layer index ('search', 'audio.download', …)
  cadence_seconds?: never
}

interface SourceBinding {
  plugin: string                        // pluginId
  source: string                        // source template id within that plugin
  params: Record<string, Value | { $input: string }>  // constants, or references to declared inputs
}

interface Channel {                     // a view — references, never owns
  id: string
  label: string
  present: 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'   // Present registry id
  streamIds: string[]
  options?: {                           // per-present config (e.g. audio download policy) +
    slots?: Record<string, string[]>    // callsiteId → Provider ids, overrides the global
                                         // binding within this Channel only (see Provider above)
  }
}
```

Validation rules: every `$input` must name a declared Provider input. A Provider has `capability`
and no cadence, but MAY have no inputs (for example `recommend`). A Stream has
`cadence_seconds`, no call-time inputs, and is executed only by T1.

**Distribution layer** (committed, read-only declarations) — a plugin is a self-contained
package:

```
packages/<pluginId>/
  config.yaml        # descriptor: backend, credentials, normalizer, official flag
  manifests.yaml     # ALL of this plugin's Source templates (params schema, auth, capabilities —
                     #   the capabilities declarations are what Provider derivation reads)
```

(Huge generated catalogs — RSSHub — keep their runtime catalog loader; static `manifests.yaml`
is for hand-written plugins.)

#### RSSHub has two sources, but only one catalog

RSSHub runs in its own worker thread (`src/rsshub-worker.ts`), and the package itself resolves
from three places. The order is in
`resolveRsshubPkg` (`src/rsshub-client.ts`):

| Tier | What it is | Who uses it | Needs tsx? |
|---|---|---|---|
| development checkout | The **TypeScript source** of `RSSHUB_PKG` (by default the adjacent git clone) | Source form. When writing RSSHub routes locally, changes must run immediately, so **the checkout wins whenever it is present** | Yes (.ts + tsconfig `@/*` paths) |
| `<dataDir>/rsshub/` | Prebuilt ESM `dist-lib/pkg.mjs` | Distribution install. **The first time an RSSHub Source is reached, Stream itself runs `npm install` there** (`src/rsshub-install.ts`) | No |
| npm package `rsshub` | Same as above | Used if someone installed a copy next to us themselves | No |

**RSSHub is intentionally not a dependency of the distribution package**: through
`@jocmp/mercury-parser` it drags in two `github:` dependencies, and npm must spawn git to
install them. A clean Windows machine has no git, so the whole `npm i @streamapp/stream`
fails directly (measured). Making ourselves the root for that install makes `overrides` take
effect (npm completely ignores overrides inside dependencies), so git is no longer needed.
The resolution order, cost, and failure wording all live in the header comment of
`src/rsshub-install.ts`.

- **`--import tsx` is added only for the tier where the worker entry itself is `.ts`**
  (`execArgvForEntry`). In the distribution package the entry is the prebuilt
  `resources/rsshub-worker.mjs` (`scripts/build-server.mjs` builds it separately, and
  `build-cli.mjs` ships it separately — it is the file found by `new Worker(URL)` at runtime,
  and **does not get pulled into the server.mjs bundle**).
- **The catalog (the long tail of all RSSHub routes, ~3900 entries) comes from one cache and is
  refreshed opportunistically during harvest**: `<dataDir>/rsshub-routes.json`. Startup reads
  it (if it cannot be read, it falls back to the checkout's `assets/build/routes.json`; if
  neither exists, only curated routes are available). When the cache is absent or stale
  (7 days), **after one real RSSHub harvest** `RssHubAdapter` opportunistically fetches
  `request('/api/namespace')`, writes it to disk, and swaps it in with
  `Registry.swapCatalog()`. `request('/api/namespace')` returns the same object as
  `routes.json` (`scripts/workflow/build-routes.ts` is exactly what `JSON.stringify`s it), and
  is measured to be more complete (1981 ns / 3861 routes vs 1670 / 3309 in the checkout's
  built artifact). **Why not fetch it at startup**: starting the RSSHub worker costs +168MB RSS
  and 0.65s, and the worker does not exit by itself once started. Users who never touch RSSHub
  Sources should not pay that memory cost. After a harvest, the worker is already warm, so the
  remaining cost is only 67ms plus one write to disk.

**Runtime layer** (user data, SQLite — no YAML/JSON user config). Two files, split on one
criterion: *would losing it hurt, or can it be re-harvested?*

```
data/stream.db   # user-owned, precious, small — the single backup unit
  channels           # views: present, label, stream references, options.slots (on DB open, existing targets table is adopted in place by RENAME)
  streams            # fully-bound units (cadence, global id, reusable; options JSON absorbs
                     #   per-stream toggles like autoDownload — no single-flag side tables)
  providers          # user overrides of derived capability defaults (priority, exclusions)
  liked_track        # liked-songs ledger
  asset, track_asset # audio archive ledger (the one real FK pair — stays in one file)
  download_job       # download queue
  conversions        # conversion artifacts (extract/identify/frames/summary/audio-fp, item-keyed;
                     #   outlive item eviction by design — see Conversions below)
  discovered_channel # search-channel telemetry

data/cache.db    # regenerable, fat, high-churn — never backed up
  items              # normalized items from Stream harvests, keyed by stream_id
                     #   (Provider results are returned to the caller, never stored here)
  seen_items         # harvest dedup fingerprints
```

`streams` and `providers` are twin tables over the shared base columns, each adding its
state-specific columns — the inheritance relationship expressed in storage. `conversions.item_id`
references evictable cache rows, so it carries **no** FK constraint — those records deliberately
outlive their items.

**Conversions**: all conversion artifacts live in the single `conversions` table and are
discriminated by `kind` (`extract | identify | frames | summary | audio-fp`); inside `extract`
(turning content into text), `content.archetype` splits it into the three branches `stt`/`ocr`/
`article` plus direct `inline` fetch. Branch selection lives in `shared/extract/plan.ts` (the
frontend button visibility and backend branch selection use the same code). **There is only one
orchestration path for queueing/deduplication/cancel/resume after restart/timing**
(`src/conversions/runner.ts`): one new conversion = register one converter, **do not create a
new service + store + endpoint family** — the cost of copying a second path has been measured:
the first one later gained delayed rescheduling, a job ledger, and events, and the copied one
had none of them. Per-stage timing is recorded at the runner's stage boundaries, so every kind
gets it for free. The contract is in [API.md](API.md#conversions-convert-to-text--add-speakers--extract-frame-text--summaries).

**Turning content into text is a ladder that grows upward by itself.** `extract` produces only
the base layer (transcription / OCR / web article body / direct fetch); deeper layers
(`identify` for adding speakers, `frames` for extracting screen text from video frames) are
**independent conversions**, automatically scheduled by `ConversionRunner` from the rule tables
in `src/conversions/derive.ts`.

**There are two tables there; do not mix them up** — the check is "does the downstream need to
read the upstream artifact?":

| | Table | When scheduled | Who exists today |
|---|---|---|---|
| **relay** | `CONVERSION_DERIVATIONS` | After the upstream is `done` | extract → `frames` |
| **co-start** | `CONVERSION_COSTARTS` | At **the same moment** the upstream starts | extract ‖ `identify` |

Relay downstreams need the upstream artifact as their check (frame extraction must read the
transcript to know whether extraction is worthwhile), so they must wait. The two co-start tasks
do not use each other as input; they only happen to need the same bytes — waiting is pure waste
(measured: fetching plain text takes 20–140s, speaker diarization takes 200–900s).

| Rule | Check | When it cannot decide |
|---|---|---|
| relay → `frames` | The upstream has a timeline (`segmentsIn`, shared by frontend and backend from `shared/extract/transcript.ts`), and `detail.media` contains video | **allow** (this layer is cheap) |
| co-start ‖ `identify` | This item has transcribable audio/video (`transcribableMedia`, the named backend check) | **do not start** (this layer is expensive) |

**The two directions are intentionally opposite**; do not treat this as inconsistency: the cost
of missing one frame extraction is that the text on that slide never enters the article body,
and nothing anywhere reports it; the cost of starting one extra voiceprint batch is a pile of
records that inevitably become `no_media` plus real container time.

- The `when` in both tables is a **pure check**: the relay table can only receive that
  `ConversionRecord`, while the co-start table can only receive the startup `options` (**at that
  moment there is no upstream record to read**, which is exactly why the signatures differ).
  Neither may touch the store, perform any I/O, or **throw** — if a predicate throws, the
  runner's outer try treats it as "nothing to schedule" and **silently swallows the whole table**.
  `options` is threaded all the way from the HTTP body, so its shape is decided by the caller:
  validate the type before using it.
- Co-start happens **only when a record is actually newly created**. It is not scheduled on a
  deduplication/cache hit; otherwise every click on turning content into text would schedule one
  wasted voiceprint job. `force` is passed through unchanged: when turning content into text is
  rerun, the co-started entry reruns with it.
- Items that truly are not video are handled by the `frames` converter's own fallback (cannot
  obtain a video URL → `no_source`, zero bytes, `done`).
- Relay happens only when the upstream is `done`; if the upstream fails or is canceled, nothing
  is dispatched.
- **`identify` does not understand text**: it produces a named speaker timeline, and "projecting
  labels onto text segments" (`alignTextToClusters`) is done by the converter itself **after**
  the timeline exists. This is not style; it is the premise of co-starting — putting text into it
  would bind it back behind turning content into text. The converter therefore **reads the
  upstream twice**: at startup it reads media clues, and after diarization finishes it reads again
  to get the transcript. Writing this as a single read makes the parallelism pointless (at the
  startup moment the upstream is necessarily not settled yet, so the read is always empty). If
  the upstream truly is not ready yet, there is simply one fewer projection; the timeline is
  still written to the DB and still succeeds.
- Co-starting also has the precondition that **fetching bytes is not paid for twice**: the
  write-through cache writes only after the fetch completes, so when two tasks start together
  the later one will necessarily read empty. The in-flight table (`AudioCache.share`) guarantees
  the same bytes are fetched only once at the same moment. Without it, parallelism is negative
  value.
- When the upstream **really reruns**, lower layers are rescheduled with it (reaching derivation
  means the upstream has a new artifact, and the old lower layer was computed against the old
  artifact). The only case not scheduled is when that (item, kind) already has one entry queued
  or running — that entry is the next layer for this item.
- Each speaker-identification run writes the observed readings into the conversion result
  (`probe`: number of speakers, total seconds with speech, duration per cluster). **It reads the
  diarization timeline, not transcript segments** — the cases with no transcript are exactly
  what this ledger most needs to cover.
- A derivation failure **does not affect the upstream retroactively** — the most expensive part
  (transcription) must be safe as soon as it is written.
- Both rule tables are **required** fields on `ConversionRunnerDeps`: a missing wire presents as
  "nothing happens" (missing co-start means "the serial path still runs, but it never runs in
  parallel", and nothing reports it), so it must explode at typecheck. **Add one row in
  `derive.ts` when adding a layer**; that is the only assembly point.

See `internal design record` for the design.

**Video frame extraction** (`src/media/video-frames.ts` + `src/media/frame-hash.ts`): given an
**addressable input** (a local path or a URL that supports range requests; ffmpeg treats them the
same; **a pipe cannot feed it** — precise `-ss` seeking must be able to jump backward), it
produces a deduplicated sequence of candidate frames (timestamp + perceptual hash). The full
frame is fetched with `frameAt` only when needed.

- Candidate selection uses **direct I-frame extraction**, not scene detection — scene detection
  decodes the whole video, measured 3.7× slower, and more precise frame positions are useless
  downstream: the paid work is one OCR per frame, and the number of frames is determined by "how
  many times the image changed", which is handled by deduplication.
- Deduplication compares dHash with **the previous frame kept** (not the previous frame seen;
  otherwise slowly drifting images would all be discarded).
- Scaling and grayscale are emitted directly by ffmpeg as **17×16** raw grayscale, and **the
  whole path decodes no images and imports no image library**. It does not use the more
  memory-efficient 9×8: measured page-turn signal is only 5 bits and is drowned in 0–1 bits of
  noise (adjusting the threshold cannot save it), while with 17×16 the page-turn signal is 28
  bits and noise is 0–2, leaving a wide enough separation band (see spec §5.3).
- `DEFAULT_MIN_DISTANCE` (10) is pinned to the measured numbers on the 17×16 grid: noise floor
  0–2, page-turn signal 28. The measurement used synthetic material; real material may have a
  higher noise floor.

Frame extraction has **two paths whose costs differ by three orders of magnitude**: probing uses
`sampleFrames` (seek to timestamps and sample, one range request per frame, cost independent of
video length); only after the gate allows it does `planVideoFrames` run (`-skip_frame nokey`
scans the whole file). `mediaDurationS` (`src/media/video-frames.ts`) is the shared duration
probe for the whole repo, and the transcription hot path in `src/media/audio-windows.ts` uses it
too, so **do not maintain a second copy in each place**. The input can be either a local path or
a URL — ffmpeg treats them the same.

- `src/conversions/frames/gate.ts`: whether to extract frames. It only consumes things obtained
  for free from transcription (characters ÷ duration, cue-word density). **No transcript →
  extract**: that precisely suggests the information may all be on screen. **Also extract when
  duration cannot be measured** (`unknown_duration`), and the reason must be honest — do not
  claim "low speech density" just because density cannot be computed. Both of these "extract"
  cases record `charsPerMinute` as `null` in the ledger; only when there is a real transcript,
  real duration, and the computed value is 0 characters/minute is `0` recorded — `null`
  (not measured) and `0` (really nobody spoke) must never be mixed, because these readings will
  be used to set thresholds later, and mixing them contaminates the measurement method.
- `src/conversions/frames/new-text.ts`: how much of the extracted text is new. Each line is
  compared with the transcript at **the same timestamp**; overlaps are discarded (subtitles
  burned into the image naturally match the speech at that moment), and non-overlaps are kept.
  The comparison is by timestamp, not by whole video — whole-video comparison would incorrectly
  kill "the key points on that slide that he only read later".
- The default thresholds in both places **have not yet been measured on real material**; they are
  starting points to validate, not checks.

**The entire shape of the `frames` layer is a stepwise loss-limiting ladder**
(`src/conversions/converters/frames.ts`), and each level leaves behind readings with an
explainable reason (`result.probe`; contract in
[API.md](API.md#conversions-convert-to-text--add-speakers--extract-frame-text--summaries)):

| `probe.stop` | Check | Readings at this level | What was paid |
|---|---|---|---|
| `gate` | `framesGate` decides it is pure speech | `gate` (verdict + characters/minute + cue-word hits) | Zero |
| `no_source` | `resolveVideoSource` returns null | — | Zero bytes |
| `still_picture` | Maximum pairwise hash distance across 8 sparse frames < threshold | `sampled`, `maxDistance` | 8 range requests |
| `no_new_text` | Probe frames select 2–3 images for OCR, and `newTextAt` finds no new text in any of them | + `ocrTried`/`ocrFailed`/`ocrEmpty` | + 3 OCR calls |
| `done` | Full scan → OCR each frame → judge incremental text per frame | + `planned`/`truncated`/`framesKept` | One pass over the full video |

- **The first four levels that decide "do not extract" are all `status: done`.** Marking them as
  `error` makes the notification center report an error and makes the user think something is
  broken, while it is doing exactly the right work. True failures are only `source_failed`
  (fetching the video URL exploded) / `sample_failed` / `plan_failed` (ffmpeg itself exploded),
  and they **must never be mixed into `no_source` / `no_new_text`** — otherwise a real URL/sample
  failure looks exactly like "this item simply has nothing frame-extractable" or "probe ran and
  found nothing" in the ledger.
- **`track: []` is not evidence** (all four loss-limiting levels produce an empty array). The
  boundary between "did not run" and "ran and found nothing" is `ocrTried`.
- **The full scan must happen after the three gates.** `planVideoFrames` is the only step that
  reads the whole file (a two-hour video is several GB), and this layer must **fetch the video
  source again** — the bytes used for transcription contain only the audio track and cannot be
  reused. Reversing the order produces no error at all; it only burns several GB of traffic on
  every video. Therefore the three ffmpeg commands (`sampleFrames`/`planVideoFrames`/`frameAt`)
  are **injected dependencies** on the converter rather than direct imports: this invariant can
  only be pinned by "how many times planVideoFrames was called"; direct imports cannot pin it.
- The video-source path has two legs in `src/media/video-source.ts`, with the same shape —
  **direct link + the headers required by that CDN** (netdisk AList direct link /
  `video.resolve` callsite dispatches by `(provider, vid)` to the package that claimed that
  platform, and the package's resolve member returns a progressive direct link). It is
  **intentionally separated** from the audio-fetching path (`src/transcribe/media.ts`): that path
  only needs media that can feed an audio track (including pure audio), while this path only
  accepts video-kind media with an image signal. **This leg accepts only direct-connect URLs, not
  any package's container endpoint**: when some facility containers' download endpoints error,
  they return 200 + a JSON blob (wrapped in `video/mp4`), and ffmpeg only turns that into
  `Invalid data found`, losing the real reason completely; only the package that understands
  that error envelope can translate it, and ffmpeg making the request itself cannot go through
  that path — so the resolve member's contract is "direct link + headers", and when the work is
  gone / private the member **throws** a `ContentUnavailableError` containing the site's original
  wording. The resolver (`makeVideoResolver`) itself does not throw upward — the executor
  collects the member's error into `InvokeResult.misses` and sets the value to null — so both the
  frame-extraction and transcription legs receive this invocation's result through the fifth
  argument `sink`; if a member failed, the original wording (`memberFailureReason`) is thrown as
  an Error; only decline becomes null (frame extraction) / the generic sentence (transcription).
- Per-frame text recognition uses the **same `parse` capability line** as the OCR branch of
  `extract` (the same "configured or not" check, `parseLadderAvailable` in bootstrap) — split
  checks present as "one button is lit, the other is always 503".
- The frame text track **is not mixed into the article body**: transcription is "who said what",
  while frame text is "what was written on screen". Today it is readable only through
  `GET /api/conversions?kind=frames&expand=result`; the composed read API is the next step.

**Speakers are an independent axis**: `identify` (adding speakers) only runs diarization +
name recognition, and **does not run STT** — so adding names to already-transcribed content does
not pay for whisper again. Transcription is not its prerequisite either (without a transcript it
performs pure diarization only).

**Speaker data has only one storage location: the voiceprint-library timeline**
(`item_diarization`, `src/voiceprint/store.ts`). "Names attached to text" are not stored; they
are a projection computed on read by the read API `src/voiceprint/view.ts` from timeline ×
transcript segments — computation on read is always fresh, so a transcription rerun cannot read
an old snapshot. All renames (enroll, automatic name extraction, deleting a person or revoking a
name) are written only to the timeline, and the projection follows automatically; the `result`
of `identify` stores only probe readings (`probe`). Appearances are also recorded only from the
timeline. Existing copied segments on old items are reverse-applied into the timeline by startup
migration (`src/voiceprint/migrate-segments.ts`, idempotent). **Do not build any new reads or
writes on the `speaker` field of transcript segments** — it is dead historical data, and the
read API overwrites it unconditionally. The convergence record is in
`internal design record`.

The chat-side wiring follows this split: **three tools, separated by "start a task" and "read
results"**:

| Tool | What it does | Waits? |
|---|---|---|
| `extract` | Starts turning content into text and answers "what was said". The returned text **contains no speaker information** (even if diarize is enabled) | Waits, up to 3 minutes |
| `identify_speakers` | Starts adding speakers and answers "who said it", returning a script with names and timestamps | Waits, up to 5 minutes |
| `read_content` | **Read API**: composes the three tracks into one timestamp-ordered script | Does not wait, returns immediately |

**Starting tasks and reading results must be separate.** "Wait for a layer to finish" and
"compose what already exists" differ in latency by two orders of magnitude. Mixing them into one
tool forces a choice: either one read may hang for three minutes, or the layer that is still
running can never be read.

`read_content` (`src/conversions/read-content.ts` + pure function `src/conversions/compose.ts`)
is **the only path by which the frame text track reaches the model side** — without it, that
layer is dead code with no consumer. Two invariants:

- **The model chooses which layers to consume; there is no default** (`include_speakers` /
  `include_screen_text`). Capabilities accumulate layer by layer, and frame text may contain
  dozens of lines; someone asking "what did he say" should not be forced to pay those tokens.
- **Every layer carries `state`; when content is empty, that is the answer**: `absent` (did not
  run) / `running` (running) / `error` (failed) / `empty` (ran and found nothing, **this is a
  valid answer**, and `detail` can explain why) / `ready`. Collapsing four kinds of "empty" into
  one empty value makes the model tell the user "there is no text on screen in this video" based
  on it — while the truth may be that the layer never ran at all.
- Screen text carries the `〔画面〕` ("screen") prefix in the script: if on-screen text and speech
  are mixed together, the model will cite slide titles as exact words someone said.
- The **content** of speakers comes from the voiceprint read API's projection computed on read
  (`McpExtras.speakers` → `view.ts`); this layer's **state** only looks at the identify record's
  own `probe` — when names from the previous run remain on the timeline, a recognition run that
  found nothing must report `empty`, not borrow old names and pretend success.

`speakerScript` (`src/conversions/speaker-script.ts`) handles segment merging and ordinal
names: minute-level segment arrays never enter the chat context. `anonymous` in the name list
must be passed through — unclaimed clusters have placeholder ordinal names such as `说话人 2`
("Speaker 2"), and without marking them the model will cite them as real names. **The ordinal
name policy is consistent with the frontend `useSpeakerMap`** (descending by total speaking
duration).

The `article` branch calls the `article-extract` Provider line — one fetch ladder
(`strategy: sequential`): `article-defuddle` (plain HTTP + Defuddle, no page JS, free, no
cross-border request) comes first, and declines when the article body is too short (< 200
characters, SPA shell); `article-firecrawl` (Firecrawl runs JS in the cloud) is the fallback and
goes cross-border only when the former declines, so static pages never go cross-border. The
degrade check lives inside the member, and the ladder does not make a second judgment outside
(the path is recorded in `ladder`; see
[API.md](API.md#conversions-convert-to-text--add-speakers--extract-frame-text--summaries)). Each inline image in the article
body (`![alt](url)` markup) is downloaded one by one and sent through the `parse` Provider line
(vision model → MinerU fallback; MinerU is the optional container package `@streamapp/mineru`;
when it is not installed, the `ocr-mineru` level is not lit and the ladder stops at the vision
model). The recognition result is annotated back at the end of the line containing the image;
unrecognized images leave a visible `[未识别：<原因>]` ("unrecognized: <reason>") marker and are
not silently skipped. Images are cached per image (`ContentCache`'s `ocr-image` namespace,
key = image URL, 30 days).

**Only these two SQLite files exist** — do not add a third for a new subsystem, and **user config
never goes into YAML/JSON**: Channel / Stream / Provider config lives in `data/stream.db` and
nowhere else. `src/store/import-legacy.ts` only adopts rows out of *retired sqlite files* and
sweeps orphan ones; it reads no YAML/JSON. There is no top-level `manifests/` directory either —
Source manifests live in `packages/<id>/manifests.yaml`, one per plugin.

## Where things live (current code)

| Concept / mechanism | Location |
|---|---|
| Channel / Stream / Provider user config | `data/stream.db` (`src/store/user-store.ts`; adoption of retired sqlite files + orphan sweep: `src/store/import-legacy.ts`) |
| research present(manifest parsing, live list surface, detail surface) | `src/board/run-source.ts`, `src/http/live-routes.ts`, `src/http/research-routes.ts` |
| research frontend(primary live list, secondary run detail, view registry) | `app/src/components/ResearchChannel.tsx`, `app/src/components/ResearchRunDetail.tsx`, `app/src/research/` |
| Source manifests | `packages/<id>/manifests.yaml` |
| Plugin descriptors | `packages/<id>/package.json` (`stream` field) |
| Adapters | `src/adapters/<id>/`, `src/rsshub-adapter.ts` |
| RSSHub itself (where it lives, which copy) | `src/rsshub-client.ts`'s `resolveRsshubPkg` -- see below |
| Browser Recipe schema / runner / packages | `src/replay/`, `packages/<facility>/*.recipe.json` (built in), `<dataDir>/recipes/<@scope__name>/` (user-installed) |
| State graph (recognizing states / dead ends / escape hatches / traces) | `src/replay/state-graph.ts` (types and pure functions), `state-perception{,-dom,-desktop}.ts` (`identify`), `state-machine.ts` (main loop, not wired), `state-classify.ts` (post-failure diagnosis, **the only wired one**), `state-assemble.ts`, `states-builtin.ts` (three CF tiers), `state-trace.ts` |
| Extension CDP transport / shadow tabs | `shared/browser-relay/` (relay itself / wire constants / challenge-response / high-risk gate / element inventory, both sides consume the same copy; old paths such as `src/http/ext-relay.ts` are thin shells), `src/replay/browser-ext*.ts`, `extension/src/lib/driver.ts` |
| Normalizers | `src/content/<id>.ts`, registry in `src/content/normalize.ts` |
| Channel view materialization (/api/channels/:id/items) | `src/http/app.ts` |
| Exclusive (failover) execution | `src/providers/executor.ts` (Provider rows), `src/scheduler.ts` (Stream harvests) |
| Scheduler (harvest loop) | `src/scheduler.ts` |
| Source health ledger | `src/source-health-store.ts` |
| HTTP app + MCP mount | `src/http/app.ts`, `src/http/mcp-mount.ts` |
| MCP tools | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| Frontend | `app/` |
| Event-loop lag flight recorder (**backend** Node process) | `src/loop-lag.ts` (mounted in `src/serve.ts`) |
| Task-boundary attribution (op-track, "who is running" during lag) | `src/op-track.ts` |
| OOM diagnostics flight recorder (**frontend** Chrome tab) | `app/src/lib/diagnostics/`, with toggles/export in `app/src/components/DiagnosticsSettings.tsx` |

## Names & aliases that are still live (read this before renaming anything)

- **Storage shape is `mode: 'feed' | 'collection'` and nothing else** — `scheduler.modeOf()` is the
  sole authority (see Stream → storage shape above). There is no `Stream.kind`, and neither an
  `ordering` flag nor an item-count cap gates collection storage.
  **Nothing writes `options.mode` for you** — there is no boot-time migration, and in practice
  almost every stream leaves it unset and is classified live by `modeOf()` (audio-Channel
  membership, then member manifests). A stored `mode` *shadows* both rules: stamp one and the
  stream stays that way even after joining an audio Channel, so only stamp it when the upstream
  shape genuinely differs from what membership implies.
  `manifest.ordering:'snapshot'` still parses (`src/manifest/loader.ts`) but *only* as a read-alias
  to `mode:'collection'`; it never independently drives behavior. Consumption authority is
  `Channel.present`.
- **The category for netdisk verify/save is `resolve`** -- semantically, live verification/save to the netdisk is "key -> one object".
  Identity lives in `src/providers/system/`; that column in the existing database is dead data (**the read side always takes code**, do not read that column).
- **`strategy` is only `'fanout' | 'exclusive'`** (`src/store/types.ts`). Writing `failover` is rejected directly by the user
  store (`src/store/user-store.test.ts` pins that it throws); that word lives only in prose and in
  the `scheduler.failover.test.ts` filename, and values are always written as `'exclusive'`.
- **"Provider" only refers to stateless capabilities.** Stateful disaster recovery is a Stream with `strategy: exclusive` -- do not
  invent names such as "Resolver"/"Mirror" for it, and do not call the adapter engine a Provider.
- **The entry concept is always called Channel** (code / API / storage: `ChannelRecord`, `/api/channels*`,
  `stream.db.channels`). The three places that are not called Channel are intentional: opaque ids `default-timeline`/
  `default-audio`, and the **resolve model**'s
  `targetType`/`/api/resolve/targets` -- there, "target" means *resolution target*, which is another term.
- **`ChannelRecord.present`** (`timeline|search|audio|video`) is the authoritative field, and the registry is in
  `src/providers/presents.ts` (`GET /api/presents`); for per-Channel `options.slots` callsite overrides, see
  the Provider section above (design in `internal design record`).
  Two aliases remain: HTTP POST/PATCH `/api/channels` accepts `variant` as a write alias (old frontend),
  and `GET /api/channels` returns `kind` as a deprecated read alias. Existing `'mixed'` values are folded into
  `'timeline'` at startup (idempotent, `UserStore` migration).
- **The scheduler only seeds from `stream.db`** (`referencedStreamIds`) -- there is no second subscription source.
- For the two-file storage model, see [Data & File Structures](#data--file-structures-target-state); packages are always
  per-plugin directories (`packages/<id>/{package.json,manifests.yaml}`).
