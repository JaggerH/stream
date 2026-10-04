## Purpose

把一个 URL 判到候选源上（雷达）：原生源同样参与，解析面是增量叠加的、不替换既有路径。

## Requirements

### Requirement: URL classification into candidate sources
The system SHALL resolve a pasted URL into the set of Stream sources — spanning both the RSSHub catalog and native plugin sources — that can ingest it, extracting each source's params, and SHALL return all matches ranked (native before catalog, then by path specificity) rather than a single guess.

#### Scenario: URL with a path param resolves to its source
- **WHEN** a user submits `https://www.xiaohongshu.com/user/profile/5ff00abc`
- **THEN** the result includes a match whose source is the xhs user route with params `{ user_id: "5ff00abc", category: "notes" }` (the `category` filled from the radar rule's target template)

#### Scenario: hash-routed URL with a query param resolves
- **WHEN** a user submits `https://music.163.com/#/song?id=1824045033`
- **THEN** the system folds the `#/` SPA hash into path + query and returns a match with params `{ id: "1824045033" }`

#### Scenario: one URL yields multiple candidates
- **WHEN** a URL is claimed by more than one source (e.g. a site page mapped by two RSSHub routes, or an RSSHub route plus a native adapter)
- **THEN** the result lists every matching source as a distinct candidate for the user to pick

#### Scenario: unmatched URL falls back
- **WHEN** a URL matches no radar rule
- **THEN** the result contains no matches and a fallback of `generic-url` (for an http(s) URL) or `unknown` (for non-URL input)

### Requirement: Native sources participate in radar
The system SHALL let a non-RSSHub (native plugin) source declare radar patterns on its manifest, and SHALL surface it as a candidate for URLs it claims, alongside any RSSHub route that also matches.

#### Scenario: a native DTDL source is a candidate
- **WHEN** a user submits a douyin user-profile URL
- **THEN** the native `douyin-user` source appears among the candidates with its `sec_user_id` param extracted from the URL

### Requirement: Additive resolution surface
The system SHALL leave the existing target-type classifier (`IntentResolver` / `DEFAULT_RULES`) and its consumers (`GET /api/resolutions`, the `resolve_target` MCP tool) behaving unchanged, so radar is additive.

#### Scenario: failover-engine path is unaffected
- **WHEN** `GET /api/resolutions` is called with an `input` it previously classified
- **THEN** it still derives the same `targetType` + `key` and runs the failover engine exactly as before
