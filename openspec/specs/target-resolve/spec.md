## Purpose

一次性的 resolve 是临时的：解析结果不落库、不产生编排副作用。

## Requirements

<!-- First main-spec snapshot of this capability (unify-harvest-path, 2026-07-04). Its base
     previously existed only as an unarchived delta (target-resolve-model change) that never
     landed in openspec/specs/; that delta's standing-subscription requirement and its
     subscribe/list_subscriptions/unsubscribe HTTP+MCP parity clause are REMOVED by this
     change (see internal change record
     for the removal rationale) and are not restated here — there is nothing prior to carry
     forward for them. Only the surviving one-shot resolve requirement is recorded. -->

### Requirement: One-shot resolve is ephemeral
The system SHALL expose a one-shot `resolve(target-type, key)` (and `resolve(input)`) that
returns the resolved result without persisting, for agent/MCP use and human preview. It SHALL
use the same engine and health ledger as scheduled Stream harvests. `resolve`, `resolve_intent`,
and `list_sources` SHALL be exposed equivalently over HTTP and MCP; no standing-subscription
verbs are part of this surface.

#### Scenario: Agent resolves once without subscribing
- **WHEN** an agent calls `resolve(netease-track, 123)`
- **THEN** the failover ladder runs and the result is returned, with nothing written to the inbox

#### Scenario: Same one-shot verb over both transports
- **WHEN** `resolve` is invoked via MCP and via `GET /api/resolutions?type=…&key=…`
- **THEN** both run the same engine and return an equivalent result
