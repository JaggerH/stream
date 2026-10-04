## Purpose

Source adapter 的接口：RSSHub adapter 供给策展路由并留一个裸路由逃生口，sidecar 生命周期由 core 管，查询透传按白名单放行。

## Requirements

### Requirement: Adapter interface
An adapter SHALL implement Plugin-owned machinery for mapping a facility API to raw Stream items. The system SHALL NOT treat adapter ids as product ownership entities. A Source is owned by a Plugin, and adapter functions are invoked as part of that Plugin's runtime. An adapter MAY implement `init(envOverrides)` and `fetch(params, manifest)` for source execution, MAY declare an owned sidecar with managed lifecycle, and MAY expose grouping resolver functions under the owning Plugin runtime.

#### Scenario: Adapter initializes with injected env
- **WHEN** the scheduler initializes Plugin execution machinery with credential env overrides from the resolver
- **THEN** the adapter applies the overrides before any fetch that needs them

#### Scenario: Source execution belongs to Plugin
- **WHEN** a Source owned by a Plugin is invoked
- **THEN** the system treats the owning Plugin as the execution boundary
- **AND** adapter ids are implementation details inside that Plugin runtime

#### Scenario: Adapter with a sidecar has it started before fetch
- **WHEN** Plugin execution uses an adapter that declares a sidecar and one of its sources is about to be fetched for the first time
- **THEN** the system starts the sidecar and confirms its health before the adapter fetches

#### Scenario: Adapter without a sidecar runs unchanged
- **WHEN** Plugin execution uses an adapter with no sidecar
- **THEN** the system invokes the fetch path with no sidecar lifecycle step

#### Scenario: Adapter exposes grouping resolver
- **WHEN** the owning Plugin descriptor declares `sourceGrouping.resolver: adapter.<function>`
- **THEN** the backend resolves `<function>` from the Plugin runtime's adapter grouping functions
- **AND** the adapter function computes display groups without becoming a product grouping entity

### Requirement: RSSHub adapter serves curated routes
The RSSHub adapter SHALL fetch the route bound to a curated manifest and return normalized items the pipeline can convert to StreamItems.

#### Scenario: Curated manifest fetches items
- **WHEN** a curated RSSHub manifest is invoked with valid params
- **THEN** the adapter fetches its route via the RSSHub lib and returns the route's items

### Requirement: Raw-route passthrough escape hatch
The RSSHub adapter SHALL provide a single `rsshub-raw` manifest that accepts a literal route string for ad-hoc fetches. It is reachable by id but carries minimal discovery metadata so it does not pollute intent search.

#### Scenario: Raw route fetches ad-hoc
- **WHEN** `rsshub-raw` is invoked with a literal route param (e.g. `/some/new/route`)
- **THEN** the adapter fetches that route directly

#### Scenario: Raw passthrough is not a primary search result
- **WHEN** an agent runs an intent search
- **THEN** `rsshub-raw` is not returned as a top-ranked candidate ahead of curated sources

### Requirement: Sidecar lifecycle is managed by the core
For an adapter that declares a sidecar, the system SHALL start it before first use, expose a health signal, and shut it down on teardown, sharing the single sidecar process across all fetches for that adapter.

#### Scenario: Sidecar shared across fetches
- **WHEN** multiple sources of the same sidecar-backed adapter are fetched
- **THEN** they reuse one long-lived sidecar process rather than starting one per fetch

#### Scenario: Sidecar shut down on teardown
- **WHEN** the system tears down
- **THEN** each started sidecar is shut down

<!-- unify-harvest-path (2026-07-04): query passthrough is new, orthogonal to the adapter
     interface/sidecar contract above. -->

### Requirement: RSSHub adapter query passthrough is allowlisted
The RSSHub adapter's route resolution SHALL append query parameters for an explicit allowlist
of keys (initially `limit`) when present in fetch params and not already present in the route
template's query string, using `?` or `&` as appropriate. Params outside the allowlist SHALL
NOT be appended to the route (in particular, engine-injected keys such as `url` MUST never leak
into the resolved route).

#### Scenario: limit is appended as a query param
- **WHEN** `resolveRoute` runs for template `/lizhi/user/:id` with params `{ id: '251381', limit: 1000 }`
- **THEN** the resolved route is `/lizhi/user/251381?limit=1000`

#### Scenario: template-declared query is not duplicated
- **WHEN** the route template already contains `?limit=` and params also carry `limit`
- **THEN** the template's query is kept and no second `limit` is appended

#### Scenario: non-allowlisted params never leak
- **WHEN** params contain `{ url: 'https://…', limit: 50 }`
- **THEN** the resolved route contains `limit=50` and no `url` query parameter
