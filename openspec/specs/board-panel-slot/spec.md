## Purpose

包通过 `stream.panels` 槽位申报面板，挂载契约是自定义元素；cell 级失败降级成一张错误卡，不拖垮整块看板。

## Requirements

### Requirement: Packages declare panels through a stream.panels slot
The system SHALL let a package declare panels in a `stream.panels` slot, each entry carrying a globally unique panel id, a label, a schemastery options schema, and a custom element tag name. A duplicate panel id SHALL be rejected at load time (hard rejection, no override).

#### Scenario: Panel declaration registers a renderable panel type
- **WHEN** a package declares `stream.panels` with id `timeseries` and a custom element tag
- **THEN** the panel type is registered and selectable wherever a board cell chooses its panel

#### Scenario: Colliding panel id is rejected
- **WHEN** two packages declare the same panel id
- **THEN** the second registration is rejected at load time with an explicit error

### Requirement: Panel mounting contract is a custom element
The system SHALL mount a panel by creating its declared custom element and feeding it `{ frames, options, theme }`, and SHALL update the element when data, options, or theme change. Panels SHALL NOT depend on the host frontend framework across the package trust boundary.

#### Scenario: Panel receives frames and renders
- **WHEN** a board cell's query resolves to `DataFrame[]`
- **THEN** the host passes the frames with validated options and current theme into the cell's custom element, which renders them

#### Scenario: Data refresh updates the mounted panel in place
- **WHEN** the cell's query re-resolves with new frames
- **THEN** the existing element instance is updated without a full remount

### Requirement: Five builtin panels ship on the same contract
The system SHALL ship builtin panels — timeseries, heatmap, scatter, table, and backtest curve — packaged with the host frontend but registered and mounted through the same `stream.panels` contract as any package panel.

#### Scenario: Builtin panel mounts like a package panel
- **WHEN** a board cell selects the builtin `table` panel
- **THEN** it is mounted as a custom element with `{ frames, options, theme }`, indistinguishable from a package-contributed panel in the mounting path

### Requirement: Cell-level failures degrade to an error card
The system SHALL render an error card in place of a cell — stating which stage failed — when the cell's panel type is unregistered, its options fail schema validation, or its query fails, and SHALL keep all other cells rendering normally.

#### Scenario: Missing panel type does not break the board
- **WHEN** a cell references a panel id that is not registered
- **THEN** that cell shows an error card naming the missing panel and every other cell renders normally
