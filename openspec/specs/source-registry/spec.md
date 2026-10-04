## Purpose

注册表是 Source 的唯一真相：按 id 精确取、按意图搜出排序候选，搜索后端可替换。

## Requirements

### Requirement: Registry is the single source of truth
The registry SHALL load and validate all manifests from the manifest directory at startup and hold them as the authoritative inventory of available sources.

#### Scenario: Manifests load from directory
- **WHEN** the registry initializes against a directory of valid manifests
- **THEN** every valid manifest is queryable by id and the count matches the directory

#### Scenario: Duplicate id is rejected
- **WHEN** two manifests declare the same `id`
- **THEN** the registry fails initialization with an error identifying the conflicting id

### Requirement: Exact lookup by id
The registry SHALL return a source's full manifest, including its `params_schema`, given its `id`.

#### Scenario: Lookup returns manifest and schema
- **WHEN** a caller looks up a source by a known id
- **THEN** the registry returns its manifest with `params_schema` so the caller can construct a valid invocation

### Requirement: Intent search returns ranked candidates
The registry SHALL answer a free-text intent query by ranking sources over their `description`, `topics`, and `example_queries`, returning the top-k with relevance scores.

#### Scenario: Query returns ranked candidates
- **WHEN** a caller searches with an intent string that matches some sources
- **THEN** the registry returns up to k candidates ordered by relevance, each with its score and call schema

#### Scenario: No match returns empty
- **WHEN** a caller searches with an intent that matches no source
- **THEN** the registry returns an empty result rather than an error

### Requirement: Search backend is replaceable
The registry SHALL expose search behind an interface so the v1 lexical implementation can be replaced (e.g. by an embedding backend) without changing callers.

#### Scenario: Lexical backend satisfies the interface
- **WHEN** the registry is configured with the default lexical search backend
- **THEN** intent search returns ranked results through the same interface a future backend would implement
