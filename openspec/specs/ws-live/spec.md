## Purpose

条目的实时推送：WebSocket 连上先给快照、之后只推增量。

## Requirements

### Requirement: Live item push over WebSocket
The backend SHALL expose a WebSocket endpoint (`/ws`) that pushes newly-persisted items to connected clients as the scheduler ticks, so the inbox updates without polling.

#### Scenario: New item delivered to connected client
- **WHEN** a client is connected to `/ws` and a stream tick persists a new item
- **THEN** the client receives a message carrying that item (with its stream id)

#### Scenario: No duplicate push for deduped items
- **WHEN** a tick yields items already seen (deduped, not newly persisted)
- **THEN** no push is emitted for those items

### Requirement: Snapshot-then-deltas on connect
A client SHALL be able to establish current state by pulling a REST snapshot (`/api/items`) and then applying WS deltas, with reconnect on drop.

#### Scenario: Reconnect resumes delivery
- **WHEN** a client reconnects after a dropped connection
- **THEN** it can re-pull the snapshot and resume receiving live deltas
