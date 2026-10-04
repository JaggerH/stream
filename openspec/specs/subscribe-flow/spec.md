## Purpose

订阅这件事的统一形状：成员身份去重键、频道范围内的订阅与成员级去重、订阅态由客户端从既有读算出、统一退订带孤儿回收、首采自动命名。

## Requirements

### Requirement: Member-identity dedup key
The system SHALL derive a deterministic `memberKey` for a subscribable source binding as a canonical encoding of `(pluginId, sourceTemplateId, params)` with params sorted by key and values not truncated (a short hash is appended only when the readable form would exceed the id length budget). The same source + params SHALL always yield the same `memberKey`, independent of param insertion order; different params SHALL yield different keys.

#### Scenario: same binding yields the same key
- **WHEN** two radar candidates resolve to the same `(pluginId, sourceTemplateId, params)` regardless of param order
- **THEN** their `memberKey` is identical

#### Scenario: differing params yield different keys
- **WHEN** two candidates share plugin and source template but differ in any param value
- **THEN** their `memberKey` differs

### Requirement: Channel-scoped subscribe
The system SHALL subscribe a chosen candidate by creating a single-member Stream (the member being that source + params) and adding the Stream to the current Channel by reference. A Stream SHALL NOT be created without being attached to a Channel. The Stream is a first-class container with its own id and MAY later hold multiple members; radar subscribe produces a single-member Stream by default.

#### Scenario: candidate subscribed to the current channel
- **WHEN** a user picks a candidate and a current Channel and confirms subscribe
- **THEN** a single-member Stream is created for that source + params and its id is added to the Channel's stream references

### Requirement: Member-level dedup within a Channel
The system SHALL treat a candidate as already subscribed when its `memberKey` is reachable from the current Channel (i.e. present among the members of any Stream the Channel references). Subscribing an already-reachable candidate to the same Channel SHALL be a no-op surfaced as "subscribed" rather than an error.

#### Scenario: duplicate subscribe is a visible no-op
- **WHEN** a user subscribes a candidate whose `memberKey` is already reachable from the current Channel
- **THEN** no duplicate Stream or reference is created and the candidate is shown as already subscribed

### Requirement: Client-computed subscription state from existing reads
The system SHALL compute candidate subscription state on the client from existing resource reads — the URL's candidates (`GET /api/intents`) and the Channels with their referenced Streams' members (`GET /api/channels`) — deriving every `memberKey` client-side and comparing sets. It SHALL NOT introduce an action-style endpoint for this. Reads happen only while the surface is open; switching the current Channel SHALL recompute from already-fetched data with no additional request.

#### Scenario: state computed from existing reads on open
- **WHEN** the subscribe surface opens for a URL
- **THEN** it reads candidates and channels via the existing endpoints and computes each candidate's `memberKey` and subscription state client-side

#### Scenario: switching channel recomputes locally
- **WHEN** the user switches the current Channel in the selector
- **THEN** each candidate's subscribed state is recomputed from the already-fetched data with no additional request

### Requirement: Unified unsubscribe with orphan GC
The system SHALL unsubscribe by removing the Stream's reference from the current Channel. When a Stream drops to zero Channel references, the system SHALL unschedule and delete it. The web and extension surfaces SHALL invoke this same operation.

#### Scenario: unsubscribe drops the ref and GCs an orphan
- **WHEN** the last Channel referencing a Stream removes that reference
- **THEN** the Stream is unscheduled and deleted

#### Scenario: unsubscribe keeps a shared Stream alive
- **WHEN** a Channel removes a Stream reference but another Channel still references it
- **THEN** the reference is removed and the Stream continues to be harvested

### Requirement: Shared subscribe logic across surfaces
The system SHALL implement the subscribe-context fetch, subscribe/unsubscribe calls, and candidate-state computation once and reuse them across the web app and the extension popup, so the two surfaces stay behaviorally identical.

#### Scenario: both surfaces share one implementation
- **WHEN** the subscribe/unsubscribe/state logic changes
- **THEN** a single shared module changes and both the web app and the extension popup pick it up

### Requirement: Auto-name from first harvest
The system SHALL create a subscribed Stream with a placeholder label and, after the first successful harvest, backfill the label from the fetched feed title unless the user has already renamed the Stream.

#### Scenario: label backfilled from feed title
- **WHEN** a newly subscribed Stream completes its first successful harvest and the user has not renamed it
- **THEN** its label is set to the fetched feed title

#### Scenario: user rename is preserved
- **WHEN** the user has renamed the Stream before the first harvest completes
- **THEN** the auto-name backfill does not overwrite the user's label
