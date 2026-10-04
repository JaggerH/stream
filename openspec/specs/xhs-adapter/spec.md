## Purpose

小红书的原生 adapter：内容经带登录态的采集 sidecar 取得，sidecar 有明确生命周期，viewer 侧 cookie 接线，配一份策展清单与一键连接。

## Requirements

### Requirement: Native Xiaohongshu adapter
The system SHALL provide a native `xhs` adapter that fetches Xiaohongshu content over its web API and returns normalized items the pipeline can convert to StreamItems, without routing through RSSHub.

#### Scenario: Manifest routes to the xhs adapter
- **WHEN** a manifest declares `adapter: xhs` and is invoked with valid params
- **THEN** the registry routes the invocation to the xhs adapter and the adapter returns the source's items

#### Scenario: Fetch surface
- **WHEN** the xhs adapter is invoked for a homefeed or user-notes source
- **THEN** it harvests the corresponding Xiaohongshu web feed and returns that feed's notes as normalized items

### Requirement: Content via a logged-in harvesting sidecar
The xhs adapter SHALL own a sidecar that is one long-lived headless browser page logged in with the viewer cookie; it SHALL obtain notes by driving the Xiaohongshu feed page and capturing the feed's own XHR JSON responses, rather than reconstructing the `x-s` request signature. (Design decision D2 "shape B": the spike proved a bare reimplemented signer is insufficient, so harvesting the page's self-signed requests is the chosen robust path.)

#### Scenario: Harvest with the page self-signing
- **WHEN** the adapter fetches a homefeed or user-notes source
- **THEN** the sidecar navigates the feed page, scrolls to provoke the feed XHR, and captures the JSON the page itself issued — without the adapter reconstructing any signature

#### Scenario: Signature rotation is absorbed
- **WHEN** Xiaohongshu rotates the signing algorithm while the sidecar is running
- **THEN** harvesting keeps working without code changes, because the page produces its own validly-signed requests rather than a reimplementation

### Requirement: Harvesting sidecar lifecycle
The harvesting sidecar SHALL be a single long-lived process reused across fetches, started before first fetch and health-gated, and SHALL self-heal a page that died between fetches by reopening it on the next start.

#### Scenario: One shared sidecar across fetches
- **WHEN** multiple xhs sources are fetched
- **THEN** they reuse one logged-in browser page rather than launching one per fetch

#### Scenario: Dead page recovers on the next tick
- **WHEN** the sidecar's page has crashed or closed between fetches
- **THEN** the next start reopens a live page so the source recovers instead of staying wedged

### Requirement: Viewer cookie wiring
The xhs adapter and its sidecar SHALL use the viewer's Xiaohongshu login cookie (`a1`/`web_session`) resolved for domain `xiaohongshu.com`, so that homefeed returns the viewer's personalized recommendations.

#### Scenario: Personalized homefeed
- **WHEN** the viewer's `xiaohongshu.com` cookie is available and an `xhs-homefeed` source is fetched
- **THEN** the adapter returns the viewer's personalized recommendation notes

#### Scenario: Login required surfaces an actionable error
- **WHEN** no valid `xiaohongshu.com` login cookie is available
- **THEN** the source fails with a clear "Xiaohongshu login required" error rather than returning a silent empty feed or crashing

### Requirement: Curated xhs manifests and one-tap connect
The system SHALL provide curated xhs manifests including a homefeed (推荐) source and a user-notes source, each naming the `xhs` presenter, and SHALL provide a connect path that subscribes the viewer's personalized homefeed as a merged channel using the viewer's own cookie.

#### Scenario: Connect subscribes the viewer's homefeed
- **WHEN** the viewer triggers xhs connect and a `xiaohongshu.com` cookie is present
- **THEN** a merged homefeed channel is subscribed for that viewer

#### Scenario: Soft failure on a harvest error
- **WHEN** navigation or harvest fails for a tick (timeout, non-JSON response, anti-bot)
- **THEN** that source's tick fails in isolation (logged) and does not crash other streams or mark the feed permanently dead
