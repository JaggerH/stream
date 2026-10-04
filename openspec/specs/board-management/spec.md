## Purpose

看板是与 Channel 平级的顶层用户数据：每个 cell 都是 schema 支撑的配置行，看板变量驱动依赖它的查询。

## Requirements

### Requirement: Board is top-level user data alongside Channel
The system SHALL persist Boards as top-level user data — each Board carrying a label, a variable list, and a grid of cells `{ layout, query binding + params, panel id, options }` — with CRUD persistence and API shape following the existing Channel pattern. A Board SHALL NOT be a Present; the Present registry is unchanged.

#### Scenario: User creates a board and it persists
- **WHEN** a user creates a board, adds a cell, and reloads the app
- **THEN** the board, its layout, and every cell's query and panel configuration are restored

### Requirement: Every cell is a schema-backed configuration row
The system SHALL treat each cell's configuration as a schemastery-validated row — query params validated against the query row's schema, panel options against the panel's schema — with editing forms generated from those schemas so a board is assembled entirely without writing code.

#### Scenario: Cell configuration is edited through generated forms
- **WHEN** a user edits a cell and picks a panel type
- **THEN** the options form is generated from that panel's schema and invalid input is rejected at the form and at write time by the same schema

### Requirement: Board variables drive dependent cell queries
The system SHALL support board-level variables — each variable a dropdown whose option list comes from one data query (first column of the first frame) — SHALL substitute `$name` references inside cell query params with the variable's current value, and SHALL re-run exactly the cells referencing a variable when its value changes.

#### Scenario: Changing a variable refreshes referencing cells
- **WHEN** a board variable `run` changes value
- **THEN** every cell whose query params reference `$run` re-queries with the new value and non-referencing cells do not re-query

#### Scenario: Variable query failure disables the variable without killing cells
- **WHEN** the variable's option query fails
- **THEN** the dropdown is disabled with an error indication and referencing cells show a waiting state instead of stale silent data

### Requirement: Boards page lists, renders, and edits boards
The system SHALL provide the boards surface — a board list, a grid-rendered board detail view, and editing (add/remove cells, drag layout, per-cell configuration forms) — with the DSH workbench shell (the Stream main region contributed by `dsh-plugin-stream-ui`) as its primary entry: a boards entry in the shell sidebar's Stream section, and board views rendered in the Stream main region. The legacy `app/` boards page remains as the fallback surface when the workbench is not running. Board run deep links (`/boards/run-detail?run=<id>`) SHALL resolve inside the DSH shell to the corresponding board with the variable initialized.

#### Scenario: Board renders as a grid of mounted panels
- **WHEN** a user opens a board's detail view
- **THEN** each cell is rendered at its layout position with its query executed and its panel mounted

#### Scenario: Boards are reachable from the DSH shell sidebar
- **WHEN** the DSH workbench is running and the user opens the shell sidebar's Stream section
- **THEN** a boards entry is present and opens the board list in the Stream main region

#### Scenario: Run deep link opens inside the DSH shell
- **WHEN** a feed item's run deep link is followed while the workbench is running
- **THEN** the run detail board opens in the Stream main region with the run variable set to the linked id
