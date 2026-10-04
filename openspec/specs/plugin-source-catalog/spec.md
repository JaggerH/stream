## Purpose

插件与 Source 的目录面：插件即能力包、每个 Source 恰好归属一个插件、列表轻量而详情带配置与文档、分类是切面不是归属。

## Requirements

### Requirement: Plugin catalog lists capability packages

The system SHALL expose a Plugin catalog for `/channels` and future entry points. Each Plugin summary SHALL include a stable id, display name, operational status, launch mode, broad capabilities, and source count.

#### Scenario: Plugin list shows installed capability packages

- **WHEN** the frontend requests the Plugin catalog
- **THEN** the response includes Plugin summaries such as `rsshub`, `pansou`, and `Douyin_TikTok_Download_API`
- **AND** each summary includes `sourceCount` and `status`
- **AND** the frontend does not derive this list by grouping source ids or adapter ids

### Requirement: Sources belong to exactly one Plugin

The system SHALL expose Sources as Plugin-owned entries. Every Source summary and detail SHALL include `pluginId`, and the frontend SHALL use `pluginId` ownership from the API instead of inferring ownership from source id prefixes.

#### Scenario: RSSHub routes are Sources owned by the RSSHub Plugin

- **WHEN** the frontend requests Sources for Plugin `rsshub`
- **THEN** the response includes RSSHub route-backed Sources
- **AND** each Source has `pluginId: "rsshub"`
- **AND** Sources such as `rsshub:bilibili/...` and `rsshub:1x/...` appear under the same Plugin

### Requirement: Source list returns lightweight summaries
The Plugin Source list API SHALL return lightweight Source summaries suitable for scanning, searching, filtering, and grouping. It SHALL NOT return heavy docs markdown, full params schemas, or examples for every Source. When the owning Plugin declares source grouping, the response SHALL include grouping metadata and group counts computed by the backend.

#### Scenario: Source list avoids heavy detail payload

- **WHEN** the frontend requests Sources for a Plugin
- **THEN** each Source item includes id, title, description, categories, capabilities, auth, badges, and param counts
- **AND** the response omits full docs markdown and full params schema

#### Scenario: Source list includes explicit grouping metadata
- **WHEN** the frontend requests Sources for a grouping-enabled Plugin
- **THEN** the response includes the Plugin's source grouping metadata
- **AND** the response includes group entries with key, label, and count

### Requirement: Source detail returns configuration and documentation

The system SHALL expose Source detail on demand. Source detail SHALL include all summary fields plus params schema, docs, examples, and credential requirements when available.

#### Scenario: Opening a Source loads detailed router/source information

- **WHEN** the user opens a Source from the list
- **THEN** the frontend requests that Source detail
- **AND** the response includes params schema and documentation needed to configure it

### Requirement: Categories are Source facets, not ownership

Categories SHALL be used only for filtering, grouping, and display inside a Plugin Source list. Categories SHALL NOT determine Plugin ownership.

#### Scenario: Source list includes category facets

- **WHEN** the frontend requests Sources for a Plugin
- **THEN** the response may include category facets with counts
- **AND** grouping by category does not move a Source outside its owning Plugin

### Requirement: Adapter is implementation metadata
The system MAY expose `adapterId` on Source summaries/details for debugging or backend routing transparency, but UI ownership and source grouping SHALL NOT depend on adapter inference.

#### Scenario: Frontend does not group by adapter

- **WHEN** a Source includes `adapterId`
- **THEN** the frontend may display or ignore it
- **BUT** Plugin membership is determined only by `pluginId`
- **AND** Plugin source grouping is determined only by the Plugin's declared `sourceGrouping` resolver

### Requirement: Catalog derives cookie auth from route data

When ingesting an RSSHub catalog route, the catalog SHALL derive a cookie `AuthSpec` from the route's own declared data instead of a namespace allowlist:
- the env var name from the route's `features.requireConfig[].name`,
- the cookie domain from the apex host of the namespace's aggregated `radar.source` patterns.

A route without a config requirement SHALL remain `auth: none`. Derivation SHALL never throw; when no domain can be derived, the route SHALL fall back to `auth: none` rather than failing the catalog build.

#### Scenario: Simple cookie route derives an env-inject auth
- **WHEN** a route declares `requireConfig: [{ name: 'XUEQIU_COOKIES' }]` and its namespace's radar includes `xueqiu.com/u/:id`
- **THEN** its manifest gets `auth: { type:'cookie', domain:'xueqiu.com', inject:{ kind:'env', name:'XUEQIU_COOKIES' } }`

#### Scenario: Domain comes from namespace-aggregated radar
- **WHEN** the route that declares `requireConfig` has `radar: null` but another route in the same namespace declares a `radar.source` for that site
- **THEN** the domain is still derived from the namespace's aggregated radar sources

#### Scenario: Wildcard config name derives a transform-inject auth
- **WHEN** a route declares `requireConfig: [{ name: 'BILIBILI_COOKIE_*' }]`
- **THEN** its manifest gets `auth.inject = { kind:'transform', ref:'bilibili' }` rather than a static env name

#### Scenario: Public route stays auth-none
- **WHEN** a route declares no `requireConfig`
- **THEN** its manifest is `auth: { type:'none' }`

#### Scenario: No derivable domain does not break the build
- **WHEN** a route declares `requireConfig` but no radar source exists anywhere in its namespace
- **THEN** the catalog build completes and the route falls back to `auth: none` (no throw)
