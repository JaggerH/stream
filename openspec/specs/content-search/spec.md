## Purpose

现搜（不读库）的统一面：搜索宇宙由注册表驱动，每个源同形地读，聚合时失败互相隔离、结果交错返回。

## Requirements

### Requirement: Registry-driven content-search universe
The cross-platform content search SHALL derive its set of participating sources from the user's configured search-role bindings of content kind — `searchSourcesByKind(flowStore, { kind: 'content' })` — not from a hardcoded list of platforms. A source that is a content-kind searchable source and has an enabled content search binding SHALL participate; disabling its binding SHALL exclude it. Adding a new content-kind searchable source SHALL enroll it automatically, with no change to any hardcoded source list.

#### Scenario: Only enabled content-kind bindings participate
- **WHEN** content search runs and a content source's search binding is disabled
- **THEN** that source is not queried, and the remaining enabled content sources still return results

#### Scenario: A new content source enrolls automatically
- **WHEN** a new content-kind searchable source is registered and enabled for search
- **THEN** content search includes it without any edit to a hardcoded source map

### Requirement: Uniform per-source search read
For each participating source, content search SHALL execute the source's search through the standard presenter read `scheduler.readPresented(source_id, { mode: 'search', keyword, count })`, with no per-source bespoke item mapping. The result fidelity and item shape are owned by the source's manifest/presenter, not by the content-search aggregator.

#### Scenario: Source executes via the standard search read
- **WHEN** content search queries a participating source
- **THEN** it calls `readPresented` with `mode: 'search'` and the query keyword, and uses the presented items directly

### Requirement: Failure-isolated, interleaved aggregation
Content search SHALL query its sources concurrently and tolerate partial failure: a source that throws or stalls SHALL be logged and contribute no items, while the other sources' results are still returned. The returned items SHALL be a round-robin interleave across the responding sources (no single source monopolizes the head of the list).

#### Scenario: One failing source does not blank the result
- **WHEN** one participating source throws during a content search
- **THEN** its failure is logged and the results from the other sources are still returned

### Requirement: Registry-derived fallback when unseeded
When no content-kind search bindings are seeded, content search SHALL fall back to every content-kind searchable manifest in the registry — `registry.all()` filtered by `capabilities.includes('search')` and `flowKind(id) === 'content'` — rather than a frozen list of platforms. Once the user has configured content search bindings, the binding gate narrows the universe to those.

#### Scenario: Out-of-box fallback covers all content-kind searchable sources
- **WHEN** content search runs and the user has not seeded any content search binding
- **THEN** it queries the registry's content-kind searchable manifests (not a hardcoded subset)
