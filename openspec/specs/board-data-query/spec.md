## Purpose

看板的取数契约：列式 DataFrame 是唯一面向面板的数据形状，查询是带 schema 申报的 Provider 行，私有执行上下文绝不经查询泄漏。

## Requirements

### Requirement: Columnar DataFrame is the single panel-facing data contract
The system SHALL define a columnar DataFrame type — a list of typed fields (`number` | `string` | `time` | `bool`), each carrying an equal-length value array, `time` values expressed as epoch milliseconds — and SHALL use `DataFrame[]` as the only result shape a data query returns to panels.

#### Scenario: A query returns multiple frames
- **WHEN** a data query resolves one series per symbol
- **THEN** it returns one DataFrame per symbol in a single `DataFrame[]` result, each frame optionally named

#### Scenario: Malformed frame is rejected loudly
- **WHEN** a query produces a frame with unequal field lengths or a value that does not match its declared field type
- **THEN** the query layer rejects the result and surfaces it as a query failure — it is never silently passed to a panel

### Requirement: Data queries are Provider rows under a data category
The system SHALL support Provider rows of category `data`, each row being one query capability that takes JSON params and resolves to `DataFrame[]`, reusing the existing Provider contribution and fixed/dispatch binding semantics unchanged.

#### Scenario: A package contributes a data query row
- **WHEN** a package declares a Provider row of category `data`
- **THEN** the row is registered through the existing Provider contribution path and is bindable wherever a data query is referenced

#### Scenario: Query failure propagates as an error result
- **WHEN** a bound data query row throws or times out during execution
- **THEN** the caller receives a failure result carrying the error cause, not an empty success

### Requirement: Data query params are declared by schema
The system SHALL require each data query row to declare its params with a schemastery schema, SHALL validate params against that schema before execution, and SHALL reject non-conforming params without invoking the row.

#### Scenario: Invalid params never reach the query
- **WHEN** a caller submits params that fail the row's schema validation
- **THEN** the execution is rejected with a validation error and the query implementation is not invoked

### Requirement: Private execution context never leaks through data queries
The system SHALL resolve secrets and runtime source configuration outside query params, and SHALL keep them out of params, cache keys, diagnostics, and stored results.

#### Scenario: Secrets stay out of the query surface
- **WHEN** a data query row executes against a source that requires an API key
- **THEN** the key is resolved from the private settings overlay and appears nowhere in params, diagnostics, or results
