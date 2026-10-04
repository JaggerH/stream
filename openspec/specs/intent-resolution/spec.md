## Purpose

把一段用户输入判成一个 Target 加一组候选；类型判不明时落到通用兜底。

## Requirements

### Requirement: Classify an input into a Target plus candidates
The system SHALL provide `resolveIntent(input)` that classifies a pasted URL/identifier into `{target-type, key}` and returns the candidate Sources (the derived ladder) that can resolve it. Classification MAY be AI-assisted for disambiguation.

#### Scenario: A platform URL classifies into a typed Target
- **WHEN** the user pastes a xiaohongshu author URL
- **THEN** `resolveIntent` returns `{target-type: xhs-author, key: <id>}` and the ordered sources that provide `xhs-author`

#### Scenario: Candidates reflect current source health
- **WHEN** `resolveIntent` returns candidates for a target-type whose primary source is dead
- **THEN** the candidate list shows the primary as dead/standby and a healthy source as active

### Requirement: Generic fallback when the type is ambiguous
When an input does not match a known target-type, the system SHALL classify it as `generic-url` (served by the `browser` last-rung source) rather than failing, and SHALL let the user confirm or override the detected target-type before a Stream/Channel is created from it.

#### Scenario: Unknown input falls back to generic-url
- **WHEN** the user pastes a URL matching no specific target-type
- **THEN** `resolveIntent` returns `{target-type: generic-url, key: <url>}` with the browser source as the resolver

#### Scenario: User overrides a misdetected type
- **WHEN** the detected target-type is wrong
- **THEN** the user can pick the correct target-type before the Stream/Channel is created
