## Purpose

把最近的条目作为读模型持久化，并支持合并查询与按流查询。

## Requirements

### Requirement: Persist recent items as a read model
The scheduler SHALL persist each newly-written StreamItem into a queryable item store (in addition to the vault and dedup store). The store is a bounded, rebuildable read model — not the corpus source of truth.

#### Scenario: Tick persists items to the store
- **WHEN** a stream tick writes N new items to the vault
- **THEN** those N items are also queryable from the item store for that stream

#### Scenario: Store is capped per stream
- **WHEN** a stream accumulates more than the per-stream cap
- **THEN** the oldest items are evicted so the store stays bounded

### Requirement: Query recent items merged and per stream
The store SHALL return recent items newest-first, either merged across all streams or filtered to one stream, with a limit.

#### Scenario: Merged query is newest-first across streams
- **WHEN** the store is queried without a stream filter
- **THEN** it returns the most recent items across all streams, newest first, up to the limit

#### Scenario: Per-stream query filters
- **WHEN** the store is queried with a stream id
- **THEN** it returns only that stream's items, newest first

#### Scenario: Empty store returns empty, not error
- **WHEN** the store has no items for a query
- **THEN** it returns an empty list
