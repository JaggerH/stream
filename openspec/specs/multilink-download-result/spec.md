## Purpose

多链接下载结果的共享形状：一份原始描述加一组带类型的链接，且不改变既有单链接源的行为。

## Requirements

### Requirement: A multilink result carries raw description and a set of typed links
The system SHALL represent a download search result as a single item carrying the raw description text and a
set of typed links, without the backend classifying which link is which quality/episode. Each link MAY carry
an optional `desc` pairing it with its own description; the pairing of links to descriptions is left to a
downstream parsing tool (not part of this change).

#### Scenario: btbtla result is flat with content and multiple typed links
- **WHEN** btbtla is searched through `resource-search`
- **THEN** each result is a flat item whose `content` is the raw description, whose `links[]` are that resource's typed links (magnet/quark/…), and whose each link `desc` is its download row's raw title — with no ShowSeason grouping and no eager multi-season fan-out

#### Scenario: A link pairs with its description when the source provides it
- **WHEN** a source can pair each link with a description (as btbtla's rows do)
- **THEN** each `links[]` entry carries a `desc` for that link

### Requirement: The shared multilink shape does not change existing pansou behavior
The system SHALL keep pansou's extraction behavior unchanged under the shared shape: pansou emits one item per
message carrying `content` and all its links, and the new `desc` field is simply absent (empty) on pansou links.

#### Scenario: pansou links carry an empty desc and content is preserved
- **WHEN** pansou returns a message with multiple links
- **THEN** the result is one item with the preserved `content` and all links, each link's `desc` empty, and no other behavior change
