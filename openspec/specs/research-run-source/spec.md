## Purpose

研究线的 run 从 artifacts 目录被采集成一个源，数据可按 frame 查询，并有一块 run 详情看板承接原来的运行浏览器。

## Requirements

### Requirement: Research runs are harvested from the artifacts directory
The system SHALL provide a source that watches a configured research artifacts directory (cockpit_sdk on-disk format, read-only) and SHALL emit one feed item per new run, carrying the run's name, tags, and key metrics, deep-linking to the run's board view.

#### Scenario: New run becomes a feed item
- **WHEN** research code finishes a run and its artifacts land in the watched directory
- **THEN** the next harvest emits a feed item with the run name, tags, and summary metrics, and its link opens the run detail board

#### Scenario: Already-harvested runs are not re-emitted
- **WHEN** a harvest runs over a directory containing only previously seen runs
- **THEN** no duplicate items are produced

### Requirement: Run data is queryable as frames
The system SHALL provide builtin data query rows over the artifacts directory — run list, run metrics, and run timeseries — each returning `DataFrame[]` parsed from the stored artifact files.

#### Scenario: Run list query feeds a board variable
- **WHEN** a board variable's option query is the run list row
- **THEN** it returns a frame whose first column is run ids, newest first

#### Scenario: Unparseable artifact surfaces as a query failure
- **WHEN** an artifact file does not match the expected cockpit_sdk format
- **THEN** the query fails with a parse error naming the file — it never returns a fabricated empty success

### Requirement: A run detail board covers the migrated run browser
The system SHALL ship a run detail board — variable = run id (options from the run list query), cells using the builtin panels over run metric and timeseries queries — sufficient to replace the standalone Cockpit run browser for viewing a run's metrics and charts.

#### Scenario: Switching runs updates every chart
- **WHEN** a user picks a different run in the board's run variable
- **THEN** all cells re-query and render that run's metrics and series
