## Purpose

同一件事有多个源时的顺次梯子：有序降级选源、健康账、硬失败与软失败分类、再探恢复、浏览器是最后一档，并有一份 doctor 报告。

## Requirements

### Requirement: Ordered failover source selection
When a named stream declares `strategy: failover`, the scheduler SHALL walk the stream's `sources` in declared order and harvest from the first source whose health `state` is `healthy`, skipping sources that are `degraded` or `dead`. It SHALL NOT fetch lower-ranked sources when a higher-ranked healthy source succeeds.

#### Scenario: Primary healthy — only primary fetched
- **WHEN** a failover stream ticks and its first source is `healthy`
- **THEN** only the first source is fetched and lower-ranked sources are not invoked

#### Scenario: Primary degraded — falls to next
- **WHEN** a failover stream ticks and its first source is `degraded` or `dead` while the second is `healthy`
- **THEN** the scheduler harvests from the second source

#### Scenario: All non-healthy — last rung used
- **WHEN** every source above the last is `degraded` or `dead`
- **THEN** the scheduler harvests from the last source in order

### Requirement: Source health ledger
The system SHALL maintain a persisted health ledger keyed by `source_id` that records, for each real upstream fetch, the outcome and derived health. Each entry SHALL track `lifetimeItemCount`, `consecutiveEmpty`, and `state` (one of `healthy`, `degraded`, `dead`). The ledger SHALL be the single source of truth consumed by both failover selection and the `doctor` report.

#### Scenario: Successful fetch keeps healthy
- **WHEN** a source fetch returns one or more items
- **THEN** its `consecutiveEmpty` resets to 0, `lifetimeItemCount` increases, and `state` is `healthy`

#### Scenario: Ledger survives restart
- **WHEN** the process restarts after recording health
- **THEN** the prior per-source `state` and counters are reloaded from disk

### Requirement: Hard vs soft failure classification
The ledger SHALL classify a fetch that throws as a hard failure and a fetch that returns an empty list as a soft failure. A hard failure SHALL strike the source toward `dead`. A soft failure SHALL count toward degradation only when the source has produced items before (`lifetimeItemCount > 0`) and `consecutiveEmpty` reaches the configured threshold K; otherwise the source remains `healthy`.

#### Scenario: Hard failure strikes immediately
- **WHEN** `adapter.fetch` throws for a source
- **THEN** the source is marked failing and is eligible to be skipped by failover on the next tick

#### Scenario: Empty on a quiet source stays healthy
- **WHEN** a source with `lifetimeItemCount = 0` returns an empty list
- **THEN** its `state` remains `healthy`

#### Scenario: Sustained empty on a productive source degrades it
- **WHEN** a source with `lifetimeItemCount > 0` returns empty for K consecutive ticks
- **THEN** its `state` becomes `degraded`

### Requirement: Re-probe recovery
While a failover stream is serving from a non-primary source, the scheduler SHALL re-probe the highest-ranked non-healthy source every M cadences and, on a successful fetch, promote it back to `healthy` so selection returns to it.

#### Scenario: Re-probe restores the primary
- **WHEN** a `dead` primary source returns items during a re-probe
- **THEN** its `state` becomes `healthy` and the next tick harvests from it again

#### Scenario: Manual re-probe
- **WHEN** an operator runs `pnpm stream doctor --reprobe <source>`
- **THEN** the named source is fetched immediately and its `state` updated from the result

### Requirement: Browser last-rung routing
The system SHALL provide a `browser` adapter usable as a source's adapter, intended as the universal last rung in a failover ladder. Only `degraded` or `dead` higher rungs SHALL cause the browser source to be reached, and harvested items SHALL pass through the shared `DedupStore` so only new items are written.

#### Scenario: Browser reached only after cheaper rungs fail
- **WHEN** all non-browser sources in a failover stream are `degraded` or `dead`
- **THEN** the browser source is harvested

#### Scenario: Browser results deduped
- **WHEN** the browser source returns items already seen from an earlier rung
- **THEN** those items are written to the vault exactly once

### Requirement: Doctor health report
The system SHALL provide a `pnpm stream doctor` command that reads the health ledger and prints, per source, the currently active rung, the health `state` with its reason (e.g. consecutive-empty count), and a missing-credential prescription when an `auth: cookie` domain cannot be resolved.

#### Scenario: Report shows degraded reason
- **WHEN** `doctor` runs and a source is `degraded` from sustained emptiness
- **THEN** the output shows that source's state and the consecutive-empty count

#### Scenario: Report prescribes missing credential
- **WHEN** a source's `auth: cookie` domain does not resolve in the credential resolver
- **THEN** the output flags it and prescribes logging in to that domain in the browser
