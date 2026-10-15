## ADDED Requirements

### Requirement: The owned channel is the local device's egress

The owned outbound channel SHALL be the implementation `fetchFor` uses when the run's device is `local`. Requests whose run resolves to any other device SHALL NOT reach the owned channel under any failure; there SHALL be no code path from a non-local device's fetch to `ownedFetch`. The SSRF guard on the owned channel SHALL keep its current semantics.

#### Scenario: a device failure does not fall through to the owned channel
- **WHEN** a run bound to a remote device issues a request and that device is offline
- **THEN** the request fails with `device-offline` and `ownedFetch` is never called
