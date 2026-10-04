## Purpose

跨平台的写操作（关注/取关）：adapter 接口、HTTP 端点，以及浏览器 sidecar 的复用。

## Requirements

### Requirement: Adapter follow/unfollow interface

The Adapter interface SHALL expose optional `follow(userId)` and `unfollow(userId)` methods. Adapters that do not support write actions simply omit these methods.

#### Scenario: Supported platform

- **WHEN** an adapter implements `follow` (e.g., xhs, douyin)
- **THEN** calling `adapter.follow(userId)` executes the platform's follow action using the existing authenticated session

#### Scenario: Unsupported platform

- **WHEN** an adapter does not implement `follow`
- **THEN** the system falls back to generating a deep-link to the platform's native app

### Requirement: HTTP follow endpoint

The system SHALL expose `POST /api/action/follow` behind Bearer authentication, accepting `platform` and `user_id` in the request body.

#### Scenario: Successful follow

- **WHEN** a Bearer-authenticated request is made with `{"platform": "xhs", "user_id": "5f3a2b1c"}`
- **THEN** the system routes to the xhs adapter's `follow` method and returns `200 {"ok": true}`

#### Scenario: Platform not found

- **WHEN** a request is made with an unknown platform name
- **THEN** the system returns `404 {"error": "platform not supported"}`

#### Scenario: Follow not supported

- **WHEN** a request is made with a known platform whose adapter lacks `follow`
- **THEN** the system returns `501 {"error": "follow not supported for this platform"}`

#### Scenario: Unauthenticated

- **WHEN** a request is made without a valid Bearer token
- **THEN** the system returns `401`

### Requirement: Browser sidecar reuse

Platform follow/unfollow actions SHALL reuse the existing browser sidecar's authenticated session rather than establishing a separate connection.

#### Scenario: Session reuse

- **WHEN** the xhs adapter's `follow` method is called
- **THEN** the action is executed through the already-running Playwright browser context that was started by the sidecar for read operations
