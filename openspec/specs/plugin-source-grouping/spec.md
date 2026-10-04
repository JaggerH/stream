## Purpose

来源的分组由插件申报解析器、后端在分页之前算好，前端只按 API 给的元数据渲染——分组逻辑不落进前端。

## Requirements

### Requirement: Plugin declares source grouping resolver
The system SHALL allow a Plugin descriptor to declare source grouping through `sourceGrouping`. The declaration SHALL include whether grouping is enabled and a scoped resolver reference.

#### Scenario: Descriptor enables grouping
- **WHEN** a plugin descriptor declares `sourceGrouping.enabled: true`
- **THEN** the loaded Plugin metadata exposes source grouping as enabled
- **AND** the descriptor includes a resolver reference used by the backend to compute groups

#### Scenario: Descriptor omits grouping
- **WHEN** a plugin descriptor omits `sourceGrouping`
- **THEN** the Plugin source list is treated as ungrouped
- **AND** the frontend does not infer grouping from source counts, facility facets, source ids, or adapter ids

### Requirement: Resolver references are scoped call points
The system SHALL resolve source grouping functions from scoped resolver references. The supported scopes SHALL include `manifest.facility`, `adapter.<function>`, and `plugin.<function>`.

#### Scenario: Generic manifest facility resolver
- **WHEN** a Plugin declares `sourceGrouping.resolver: manifest.facility`
- **THEN** each Source group is read from that Source's `facility` field
- **AND** Sources without `facility` are not assigned to a synthetic product group unless the implementation explicitly marks them ungrouped

#### Scenario: Adapter-scoped resolver
- **WHEN** a Plugin declares `sourceGrouping.resolver: adapter.groupByNamespace`
- **THEN** the backend invokes `groupByNamespace` from that Plugin runtime's adapter grouping functions
- **AND** no global resolver named `rsshubNamespace` is required or exposed

#### Scenario: Missing scoped resolver fails fast
- **WHEN** a Plugin declares an `adapter.<function>` or `plugin.<function>` resolver that its Plugin runtime does not expose
- **THEN** startup or plugin loading fails with an error naming the Plugin id and resolver reference

### Requirement: Grouping is computed by backend before pagination
The system SHALL compute Plugin source groups in the backend from the filtered source set before pagination.

#### Scenario: Search returns matching groups
- **WHEN** a user searches within a grouping-enabled Plugin
- **THEN** the response includes groups computed from search-matching Sources
- **AND** group counts reflect the filtered set before pagination

#### Scenario: Group filter restricts sources
- **WHEN** the frontend requests `/api/plugins/:pluginId/sources?group=<key>`
- **THEN** the response contains only Sources whose resolved group key equals `<key>`
- **AND** pagination applies after the group filter

### Requirement: Frontend renders groups only from API metadata
The frontend SHALL render a Plugin grouping page only when the selected Plugin's source-list response declares grouping enabled.

#### Scenario: Facility facets do not activate grouping
- **WHEN** a Plugin source-list response contains facility facets but no enabled source grouping metadata
- **THEN** `PluginPanel` renders the Source list directly
- **AND** it does not switch to a group page based on facet count

#### Scenario: Enabled grouping shows group page
- **WHEN** a Plugin source-list response declares grouping enabled and returns groups
- **THEN** `PluginPanel` renders the groups as the first-level Plugin source page
- **AND** selecting a group requests Sources filtered by that group key

### Requirement: RSSHub grouping belongs to RSSHub runtime
RSSHub namespace grouping SHALL be implemented as a resolver exposed by the RSSHub Plugin runtime and declared through the RSSHub plugin descriptor.

#### Scenario: RSSHub groups by namespace through adapter call point
- **WHEN** RSSHub declares `sourceGrouping.resolver: adapter.groupByNamespace`
- **THEN** RSSHub routes such as `rsshub:xiaohongshu/user/...` resolve to the `xiaohongshu` group
- **AND** the resolver is not registered as a global built-in strategy

### Requirement: Douyin plugin groups through a Plugin-owned platform resolver
`Douyin_TikTok_Download_API` SHALL group Sources through a Plugin-owned platform resolver rather than by treating adapter ids as product entities or exposing an adapter-scoped grouping call point.

#### Scenario: Douyin plugin uses plugin platform grouping
- **WHEN** `Douyin_TikTok_Download_API` declares `sourceGrouping.resolver: plugin.groupByPlatform`
- **THEN** Sources resolve into platform groups such as `douyin`, `bilibili`, and `tiktok`
- **AND** adapter ids are implementation inputs to that Plugin-owned resolver rather than public grouping call points
