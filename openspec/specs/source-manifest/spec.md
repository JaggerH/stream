## Purpose

Source 清单里的类型分类，以及 facility 作为通用的分组输入。

## Requirements

### Requirement: Source type classification
A manifest MAY declare a `type` of `post`, `conversation`, `email`, or `calendar`. When omitted it SHALL default to `post`. The type classifies the flow for grouping/state purposes and is orthogonal to `capabilities` (which describe what actions are possible).

#### Scenario: Type defaults to post
- **WHEN** a manifest omits `type`
- **THEN** the loaded manifest has `type` = `post`

#### Scenario: Declared type is preserved
- **WHEN** a manifest declares `type: conversation`
- **THEN** the loaded manifest exposes `type` = `conversation`

#### Scenario: Unknown type is rejected
- **WHEN** a manifest declares a `type` not in the allowed set
- **THEN** the loader rejects it with an error naming the field

### Requirement: Facility is generic grouping input
A Source manifest MAY declare `facility` as a generic external-facility label. The field SHALL be usable by the generic `manifest.facility` grouping resolver, but it SHALL NOT by itself activate grouping for a Plugin.

#### Scenario: Facility does not enable grouping by itself
- **WHEN** a Source manifest declares `facility`
- **THEN** the field is available to backend catalog and grouping logic
- **AND** the frontend does not show Plugin source groups unless the owning Plugin declares source grouping enabled

#### Scenario: Manifest facility resolver reads facility
- **WHEN** the owning Plugin declares `sourceGrouping.resolver: manifest.facility`
- **THEN** each Source's group key and label come from that Source manifest's `facility`
