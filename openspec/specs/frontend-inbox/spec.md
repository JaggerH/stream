## Purpose

收件箱前端：All-Latest 合并视图是默认、按类型三栏钻取、条目实时更新、详情按源的能力渲染。

## Requirements

### Requirement: All-Latest merged view as default
On open, the inbox SHALL show a merged, newest-first timeline across all streams.

#### Scenario: Default view is merged latest
- **WHEN** the app opens and a backend is connected
- **THEN** the main view shows recent items merged across all streams, newest first

### Requirement: Three-pane drill-in grouped by type
The UI SHALL provide a streams rail (grouped by source `type`), an item list for the selection, and a detail pane; selecting a stream filters the list to it.

#### Scenario: Selecting a stream filters the list
- **WHEN** the user selects a stream in the rail
- **THEN** the item list shows only that stream's items

#### Scenario: Rail groups by type
- **WHEN** streams of different types exist
- **THEN** the rail groups them under their type (post / conversation / email)

### Requirement: Live updates
New items pushed over WS SHALL appear in the current view without a manual refresh.

#### Scenario: New item appears live
- **WHEN** a new item arrives over WS while the All-Latest view is open
- **THEN** it appears at the top of the timeline without reload

### Requirement: Capability-driven detail
The detail pane SHALL render affordances from the source's `capabilities`. In v1 (timeline-only) it is a read-only reader; a `reply` capability would add a composer (deferred).

#### Scenario: Read-only reader for timeline sources
- **WHEN** the selected item belongs to a timeline-only source
- **THEN** the detail pane shows the content with no reply composer
