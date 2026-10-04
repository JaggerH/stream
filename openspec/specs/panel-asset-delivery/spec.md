## Purpose

内置面板的前端资产由 Stream 后端下发，看板宿主在挂载 cell 之前先把它们装好。

## Requirements

### Requirement: Builtin panel assets are served by the Stream backend
The system SHALL build the builtin panel custom elements into a standalone asset bundle (no host-framework dependency) and SHALL serve it from a Stream backend static route, so any browser surface can load panel implementations at runtime without bundling them.

#### Scenario: Panel bundle is fetchable
- **WHEN** a client requests the panel asset route
- **THEN** it receives the JavaScript bundle that defines every builtin panel custom element

### Requirement: The DSH surface loads panel assets before mounting cells
The system SHALL load the panel asset bundle in the DSH shell at runtime and SHALL complete `customElements.define` for a panel's element before any board cell using that panel is mounted.

#### Scenario: Cells render after assets load
- **WHEN** a board view opens in the DSH shell and the panel bundle finishes loading
- **THEN** cells mount their custom elements and render frames

#### Scenario: Asset load failure degrades to cell error cards
- **WHEN** the panel asset bundle fails to load
- **THEN** cells referencing those panels show an error card naming the load failure, other surfaces remain functional, and nothing crashes the shell
