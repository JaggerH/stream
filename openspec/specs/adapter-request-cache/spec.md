## Purpose

给 adapter 的物理请求加一层带 TTL 的进程内缓存，让同一轮取数不重复打上游。

## Requirements

### Requirement: Physical fetch cache

The system SHALL cache adapter fetch results at the planner's physical fetch layer, keyed on merged physical params (not logical flow params). All adapters benefit automatically with zero adapter interface changes.

#### Scenario: Cache hit

- **WHEN** a physical fetch request is made and a valid cache entry exists for the same `(adapterId, manifestId, physicalParams)` key
- **THEN** the cached items are returned immediately with zero upstream requests

#### Scenario: Cache miss with no in-flight request

- **WHEN** a physical fetch request is made and no cache entry exists and no other request is in-flight for the same key
- **THEN** the adapter fetch is executed, the result is stored in cache with the configured TTL, and the items are returned

#### Scenario: Cache miss with in-flight request (lock)

- **WHEN** a physical fetch request is made and no cache entry exists but another request for the same key is already in-flight
- **THEN** the system polls every 2 seconds up to 60 seconds for the in-flight request to complete, then returns the cached result
- **AND** if the in-flight request does not complete within 60 seconds, an error is thrown

### Requirement: Cache TTL from manifest

The system SHALL derive cache TTL from the source manifest's `cadence_hint_seconds`, bounded to a minimum of 300 seconds and a maximum of 86400 seconds.

#### Scenario: Default TTL

- **WHEN** a manifest declares `cadence_hint_seconds: 3600`
- **THEN** cache entries for that source expire after 3600 seconds

#### Scenario: Floor TTL

- **WHEN** a manifest declares `cadence_hint_seconds: 60`
- **THEN** cache entries for that source expire after 300 seconds (floor applied)

#### Scenario: Ceiling TTL

- **WHEN** a manifest declares `cadence_hint_seconds: 100000`
- **THEN** cache entries for that source expire after 86400 seconds (ceiling applied)

### Requirement: In-memory storage

The system SHALL store cached items in an in-memory LRU map with per-entry TTL timestamps, requiring no external dependencies.

#### Scenario: Memory-only operation

- **WHEN** the Stream process restarts
- **THEN** the cache is empty (no persistence across restarts)
