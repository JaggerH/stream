## Purpose

频道页的能力面：从 binding 列出主 Stream、暴露来源与流的元数据、冷启动种子内联可见、按来源添加并按能力开门、元源的搜索范围编辑。

## Requirements

### Requirement: /channels lists both main Streams from bindings

`/channels` SHALL render two sections — **TIMELINE** and **SEARCH** — each listing its role's bindings (from `/api/bindings`), replacing the old `NamedStream`-only list. Each row SHALL show the flow label and role-appropriate metadata (timeline: cadence; search: kind/seed/meta badges) and a remove control.

#### Scenario: Search bindings are visible
- **WHEN** the user opens `/channels` with seeded search flows present
- **THEN** the SEARCH section lists those search-role bindings (e.g. nyaa, btbtla, pansou), which were previously invisible

#### Scenario: Timeline bindings are visible
- **WHEN** the user has timeline subscriptions
- **THEN** the TIMELINE section lists them with their cadence

### Requirement: Source/flow metadata exposure

The flow/binding API responses SHALL include derived `kind` (`download` | `content`), `meta` (whether the source declares `fan_out`, plus its dimension), and `capabilities` for each source/flow, so the frontend renders badges and gates actions without client-side guessing. `kind` SHALL be `download` when the source has a registered magnet/netdisk extractor (closed set) and `content` otherwise.

#### Scenario: Download source carries kind=download and meta when fan_out present
- **WHEN** the API returns the pansou search flow
- **THEN** its response carries `kind: "download"` and `meta` indicating a `channels` fan-out dimension

#### Scenario: A non-extractor source is content
- **WHEN** the API returns a search source with no magnet/netdisk extractor
- **THEN** its `kind` is `content`

### Requirement: Cold-start seeds visible inline

Seed flows (`origin=seed`) SHALL appear inline in their Stream section marked with a `默认` badge; there SHALL NOT be a separate defaults view. This answers "what are the default channels" by simply opening the Stream.

#### Scenario: Default search channels are marked
- **WHEN** the user opens `/channels`
- **THEN** seeded search flows show a `默认` badge in the SEARCH section

### Requirement: Source-centric add with capability gating

Adding a channel SHALL be Source-centric: the user browses/searches sources, opens one, and chooses which Stream(s) to add it to. The Stream options SHALL be gated by the source's `capabilities` (an unsupported role is disabled). Adding SHALL perform `create_flow` then `promote(role)`.

#### Scenario: Unsupported role is disabled
- **WHEN** the user opens a source whose capabilities are `[search]` only
- **THEN** the "add to Timeline" option is disabled and only "add to Search" is selectable

#### Scenario: Add creates a flow and binding
- **WHEN** the user adds a source to Search
- **THEN** a flow is created and a search binding is promoted, and the source appears in the SEARCH section

### Requirement: Meta-source search-range editor

A meta-source row (source with `fan_out`) SHALL be expandable into a search-range editor that curates the fan-out dimension list (pansou: TG channels) from three candidate sources — default pool, discovered pool, and manual entry — plus collapsed scalar config. The editor SHALL edit the flow's config params via `PATCH /api/flows/:id`. The editor SHALL display that the selected set is sent as ONE merged request (no per-channel dispatch). A flat source (no `fan_out`) SHALL NOT be expandable.

#### Scenario: Adding a channel edits the flow params, not request count
- **WHEN** the user adds a TG channel in the pansou range editor
- **THEN** the channel is appended to the flow's `channels` param via PATCH, and the editor still indicates a single merged request

#### Scenario: Flat source has no range editor
- **WHEN** the user views a flat search source (e.g. nyaa)
- **THEN** it is not expandable and shows no range editor

### Requirement: PATCH flow endpoint

The system SHALL expose `PATCH /api/flows/:id` to update a flow's `params` and/or `label`, backed by `FlowService.updateFlow`. It SHALL 404 an unknown flow and validate the body.

#### Scenario: Update a flow's params
- **WHEN** `PATCH /api/flows/:id` is called with new `params`
- **THEN** the flow's stored params are replaced and the updated flow is returned

#### Scenario: Unknown flow
- **WHEN** `PATCH /api/flows/:id` targets a non-existent id
- **THEN** the response is 404

### Requirement: Timeline frontend migrated to bindings

The TIMELINE section and its add path SHALL be driven by the flow/binding model: timeline rows come from timeline bindings, and subscribing a source performs `create_flow` + `promote(timeline)` (replacing the legacy `NamedStream` subscribe call).

#### Scenario: Subscribe via the flow model
- **WHEN** the user adds a source to Timeline with a cadence
- **THEN** a flow is created and a timeline binding (with that cadence) is promoted, and it appears in the TIMELINE section

### Requirement: Content sources in Search (Phase B)

Content-search sources (e.g. xhs/bilibili search) SHALL be seeded as `kind=content` search bindings so they appear in the SEARCH section, and `contentSearch()` SHALL derive its sources from those bindings so that enabling/removing a content binding in `/channels` takes real effect. (Phase B; Phase A renders only download search sources.)

#### Scenario: Content search source appears and is honored
- **WHEN** content sources are seeded as search bindings and the user disables one
- **THEN** it shows in the SEARCH section with a `内容` badge and is excluded from content search results
