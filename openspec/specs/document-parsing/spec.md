## Purpose

把文档解析成可读正文：后端解析器的解析与降级、忠实解析的不变量、按需取源、点击触发 + 按条目持久缓存、未配置时优雅降级。

## Requirements

### Requirement: MinerU backend resolution
The system SHALL resolve the MinerU backend URL as `config.mineru_url → env MINERU_URL → pluginGatewayUrl('mineru')`, mirroring the whisper-asr/video-service/pansou pattern. The resolved URL's host SHALL determine the reported mode: the local gateway loopback is `local`, any other host is `cloud`. Both tiers run the same MinerU engine; cloud differs only in compute/throughput, not model quality.

#### Scenario: Local by default
- **WHEN** no `mineru_url`/`MINERU_URL` is set and the mineru plugin is configured
- **THEN** the backend resolves to the local gateway (`/_p/mineru`) and the mode is `local`

#### Scenario: Cloud relay when configured
- **WHEN** `mineru_url` is set to a remote relay URL
- **THEN** the backend resolves to that URL and the mode is `cloud`

### Requirement: Faithful parsing invariants
The parsing backend SHALL be a deterministic-first pipeline that preserves source fidelity, not an end-to-end generative model. It MUST honor: (a) for a born-digital PDF, the embedded text layer is extracted directly and a vision model SHALL NOT rewrite text that already exists; (b) tables are recovered via a dedicated table-structure model; (c) formulas are recovered via dedicated recognition; a vision model SHALL be used only for scanned or image-only regions that have no text layer. These invariants hold regardless of which concrete engine implements the backend.

#### Scenario: Born-digital numbers are not fabricated
- **WHEN** a born-digital research/investment PDF containing exact figures is parsed
- **THEN** the figures in the output markdown come from the extracted text layer (verbatim), not from a generative re-reading

#### Scenario: Tables go through structure recovery
- **WHEN** a PDF page contains a table
- **THEN** the table is reconstructed by the dedicated table-structure path and rendered as structured markdown/HTML, not flattened or hallucinated

### Requirement: On-demand source resolution
The system SHALL resolve a parseable item's bytes using existing fetch paths: an item with `image` media via the image/safe-fetch path, and an item carrying a PDF link/enclosure (`application/pdf` content-type or a `.pdf` url) via `safe-fetch`. Stream SHALL send the bytes plus a content-type hint to the MinerU backend `POST /parse`. Items with neither a parseable image nor a PDF link SHALL NOT be parseable.

#### Scenario: Image item parses its image
- **WHEN** an item with image media is parsed
- **THEN** Stream sends the image bytes to MinerU and renders the returned markdown

#### Scenario: PDF link is fetched and parsed
- **WHEN** an item carries a PDF link/enclosure
- **THEN** Stream fetches the PDF bytes via safe-fetch and sends them to MinerU for markdown extraction

#### Scenario: Non-parseable item has no affordance
- **WHEN** an item has neither image media nor a PDF link
- **THEN** the item is not parseable and exposes no parse action

### Requirement: Click-triggered parsing with persistent per-item cache
Parsing SHALL run only on explicit request (never automatically). A result SHALL be persisted per item and reused: a second request for the same item SHALL return the cached markdown without re-invoking the backend. `POST /api/parse` SHALL start (or return the cached result of) a job; `GET /api/parse?item=<id>` SHALL return `running`, `done` (with markdown), or `error`.

#### Scenario: First parse runs and caches
- **WHEN** an item with no cached parse result is parsed
- **THEN** a job runs against the MinerU backend and the resulting markdown is persisted keyed to the item

#### Scenario: Re-open is instant and free
- **WHEN** an item that already has a cached parse result is requested
- **THEN** the cached markdown is returned immediately and the backend is NOT invoked again

#### Scenario: Long job is polled
- **WHEN** parsing is still running
- **THEN** `GET /api/parse?item=<id>` returns status `running` and the caller polls until `done` or `error`

### Requirement: Parse affordance on cards
A parseable item's card SHALL show a "解析" action in its bottom action bar when the mineru plugin is configured. Activating it SHALL trigger parsing and render the markdown in the card's reserved panel (the same panel used for transcripts; collapsed until a result exists or is loading), showing a loading state while running.

#### Scenario: Button shown only for parseable items
- **WHEN** a card represents an item with image media or a PDF link and the mineru plugin is configured
- **THEN** a "解析" button appears in the card's bottom action bar

#### Scenario: Markdown renders in the reserved panel
- **WHEN** parsing completes for a card
- **THEN** the markdown appears in the card's reserved panel (reusing the transcript panel container)

### Requirement: Graceful degradation when unconfigured
When the mineru plugin is not configured or its backend is unreachable, the parsing feature SHALL be hidden/disabled and the rest of Stream SHALL be unaffected.

#### Scenario: Feature hidden without a backend
- **WHEN** no mineru plugin is configured
- **THEN** no parse button is shown and parsing endpoints report the feature unavailable, with no impact on other features
