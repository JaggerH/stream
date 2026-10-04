## Purpose

插件状态的聚合端点，以及一块只读的状态面板。

## Requirements

<!-- Pre-existing corruption fixed 2026-07-05, discovered by target-stream-decoupling's
     archive run (comet-archive's leak guard): commit 4544d2a's archive (document-parsing)
     used the old cp-clobber path and overwrote this file with only its own MODIFIED block,
     silently deleting "Read-only plugin status panel" (present since 477f357). Restored
     from git history — the frontend PluginPanel component (app/src/acrylic-app/AcrylicApp.tsx)
     confirms the feature is still live; only the spec had gone missing. -->

### Requirement: Plugin status aggregation endpoint
The system SHALL expose `GET /api/plugins` returning, for each loaded plugin descriptor, its `id`, whether it is `configured` (has a backend or resolvable URL), its `mode` (`local`, `cloud`, or `n/a` for in-process adapters), and its `health` (reachable per the descriptor's health path). Secrets/URLs SHALL NOT be leaked beyond host classification. The aggregation is descriptor-driven, so any service-only backend plugin (e.g. whisper-asr, mineru) appears automatically without endpoint changes.

#### Scenario: Reports mode per plugin
- **WHEN** `GET /api/plugins` is called
- **THEN** each plugin with a backend reports `mode: local` or `mode: cloud` based on its resolved backend host

#### Scenario: Reports health
- **WHEN** a plugin's backend health path responds successfully
- **THEN** that plugin is reported healthy; otherwise it is reported unhealthy/down

#### Scenario: In-process adapters
- **WHEN** a plugin is an in-process adapter with no backend (e.g. xhs)
- **THEN** it is reported with `mode: n/a` and no health probe

#### Scenario: Service-only backend plugins appear automatically
- **WHEN** the mineru (or any new service-only) plugin descriptor is loaded and configured
- **THEN** `GET /api/plugins` includes its row with `{id, configured, mode, health}` with no change to the endpoint

### Requirement: Read-only plugin status panel
The frontend SHALL provide a read-only panel (reachable from the app navigation) listing each plugin with: enabled state, a local-vs-cloud(relay) badge, and a health indicator. The panel SHALL NOT edit configuration.

#### Scenario: Panel lists plugins
- **WHEN** the plugin status panel is opened
- **THEN** it shows one row per plugin with enabled state, local/cloud badge, and health dot

#### Scenario: Panel is read-only
- **WHEN** a user views the panel
- **THEN** there is no control to change a plugin's configuration from the panel
