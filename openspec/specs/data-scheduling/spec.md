## Purpose

采集调度：Stream 的定义、经去重进 item store 的定时管线、扇出跨源去重、调度器是唯一常驻的采集引擎、首采回填与开机补跑。

## Requirements

### Requirement: Stream definition
A Stream SHALL be defined in user config with an `id`, a `label`, one or more member Sources with per-member `params`, and a `strategy` of `fanout` (default) or `exclusive`. Under `fanout` the scheduler fetches every member each cycle and merges their items. Under `exclusive` the scheduler treats members as an ordered ladder and harvests from the first healthy Source only (see the `source-failover` capability). An absent `strategy` SHALL be treated as `fanout`.

#### Scenario: Single-source stream
- **WHEN** a Stream references one Source with params
- **THEN** the scheduler resolves it to that Source's adapter invocation

#### Scenario: Multi-source fanout
- **WHEN** a Stream references multiple Sources and `strategy` is absent or `fanout`
- **THEN** the scheduler invokes each Source and merges their items into the one Stream

#### Scenario: Exclusive stream harvests one rung
- **WHEN** a Stream declares `strategy: exclusive` and references multiple ordered Sources
- **THEN** the scheduler harvests from the first Source whose health state is healthy and does not fetch the rest

### Requirement: Scheduled pipeline through dedup into the item store
The scheduler SHALL run each Stream at its cadence, flowing results through the existing dedup store and item store (plus optional markdown vault) unchanged.

#### Scenario: First tick writes new items
- **WHEN** a Stream ticks for the first time
- **THEN** fetched items are deduped and new ones are persisted under the Stream's id

#### Scenario: Repeat tick writes nothing new
- **WHEN** a Stream ticks again with no new upstream items
- **THEN** all items are recognized as seen and nothing new is persisted

### Requirement: Fanout dedups across sources
When a Stream fans out, items SHALL be deduped in the shared store so the same item surfaced by two Sources is persisted once.

#### Scenario: Same item from two sources written once
- **WHEN** two Sources in one Stream return an item with the same dedup key
- **THEN** the item is persisted exactly once

<!-- unify-harvest-path (2026-07-04): three requirements below authoritative-ize data
     scheduling per docs/ARCHITECTURE.md Data Scheduling — the Scheduler as sole standing
     harvest engine, opt-in backfill/incremental limit policy, and Provider-ladder snapshot
     creation (the standing-subscription replacement). -->

### Requirement: The Scheduler is the only standing harvest engine
Every data acquisition SHALL be initiated by exactly one of the three scheduling triggers
defined in `docs/ARCHITECTURE.md` Data Scheduling: T1 `tick(stream)` (time-driven, Scheduler),
T2 `invoke(provider, key)` (call-driven, Provider executor, results never persisted as feed
items), T3 `enqueue(job)` (call-driven long-running, dedicated ledgers). No other code path
SHALL run a standing harvest loop.

#### Scenario: No second harvest loop survives boot
- **WHEN** the serve process boots
- **THEN** the Scheduler's cadence loop is the only periodic acquisition driver registered
  (no subscription-harvester interval exists)

#### Scenario: Standing acquisition is expressed as a Stream
- **WHEN** a user wants a resolution goal (e.g. a podcast key) acquired periodically
- **THEN** it is expressed as an exclusive Stream referenced by a timeline Channel and harvested
  by the Scheduler — not by any parallel subscription mechanism

### Requirement: First-harvest backfill with incremental follow-up
A Stream MAY declare `options.harvest`, and the scheduler SHALL then inject `limit` into each
member Source's effective params at the policy layer of the parameter-composition pipeline
(below member bindings, above source-config). `options.harvest` is
`{ backfillLimit?, incrementalLimit? }`:
`backfillLimit` when the Stream has never persisted an item (durable dedup count for the
Stream's id is zero), else `incrementalLimit`. A `limit` explicitly bound in the member's own
params SHALL take precedence over the injected value. Streams without `options.harvest` SHALL
be harvested with unchanged behavior. A failed first harvest (nothing persisted) SHALL leave
the Stream in the never-harvested state, so the next tick retries the backfill.

#### Scenario: First harvest backfills the archive
- **WHEN** a Stream with `options.harvest = { backfillLimit: 1000, incrementalLimit: 50 }`
  ticks for the first time (no items ever persisted under its id)
- **THEN** the member Source is fetched with `limit = 1000`

#### Scenario: Subsequent harvests are incremental
- **WHEN** the same Stream ticks again after items have been persisted
- **THEN** the member Source is fetched with `limit = 50`

#### Scenario: Explicit member binding wins over policy
- **WHEN** a member Source's own bound params already contain `limit: 200`
- **THEN** the harvest uses `limit = 200` regardless of `options.harvest`

#### Scenario: Opt-out streams are untouched
- **WHEN** a Stream declares no `options.harvest`
- **THEN** no `limit` is injected and effective params are exactly the member's own params

#### Scenario: Failed first harvest retries backfill
- **WHEN** the first tick errors (or persists nothing) and the Stream ticks again
- **THEN** the fetch again uses `backfillLimit`

### Requirement: Stream creation from a Provider ladder
The system SHALL provide a creation path that snapshots a resolve-variant Provider row's
expanded members into a new `strategy: 'exclusive'` Stream: each member's `$input` param holes
are filled with the given key at creation time, producing fully bound member params; the
Stream is attached to a timeline Channel per the entry-point rule. The snapshot SHALL NOT
auto-update when the Provider row later changes.

#### Scenario: Podcast subscription snapshots the ladder
- **WHEN** a Stream is created from the `podcast-feed` row with key `251381`
- **THEN** the Stream's members are the row's expanded catalog Sources in ladder order, each
  with `params.id = '251381'`, and the Stream harvests via the scheduler's exclusive strategy

#### Scenario: Later row changes do not mutate existing Streams
- **WHEN** the Provider row gains a new member after the Stream was created
- **THEN** the existing Stream's members are unchanged

### Requirement: Startup catch-up for overdue streams
The scheduler SHALL persist a per-Stream `lastHarvestAt` (last successful harvest time) and consult it at `start()`. For each Stream, if `now - lastHarvestAt >= cadence` (the Stream is overdue, including the case where the backend was down past a full cycle), the scheduler SHALL harvest it promptly on startup — retaining a small jitter to avoid a startup thundering herd — instead of waiting the normal `[0.5,1)×cadence` first-fire delay. A Stream that is not overdue SHALL keep the existing jittered first-fire behavior. This makes "开窗即新鲜" hold after the backend has been down (session-level persistence catching up), without changing steady-state cadence behavior.

#### Scenario: Overdue stream catches up on start
- **WHEN** the backend starts and a Stream's `lastHarvestAt` is older than its `cadence`
- **THEN** that Stream is harvested promptly on startup (with small jitter), not after a fresh `[0.5,1)×cadence` wait

#### Scenario: Not-overdue stream keeps jittered first fire
- **WHEN** the backend starts and a Stream was harvested more recently than its `cadence`
- **THEN** that Stream's first fire uses the existing `[0.5,1)×cadence` jittered delay

#### Scenario: lastHarvestAt advances on successful harvest
- **WHEN** a Stream completes a harvest that persists (or confirms up-to-date) its items
- **THEN** its persisted `lastHarvestAt` advances so a subsequent restart does not needlessly re-catch-up

#### Scenario: Missing lastHarvestAt does not force a mass catch-up
- **WHEN** an existing store has Streams with no recorded `lastHarvestAt` (upgrade case)
- **THEN** those Streams keep the normal jittered first fire (treated as not-overdue), avoiding a one-time all-Streams harvest burst on upgrade
