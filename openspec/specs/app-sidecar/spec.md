## Purpose

桌面壳以 sidecar 方式带起后端：应用数据目录与配置的归属，以及跨平台的后端入口。

## Requirements

### Requirement: App-data directory and config
The backend SHALL read its port and data directory from the environment/arguments the app provides (not hardcoded `/tmp` or the working directory), placing stores, the single-instance lock, and config under the app-data directory. A non-secret default config SHALL ship with the app and be copied into the app-data directory on first run if none exists; the user-editable config lives there. Secrets SHALL NOT be bundled.

#### Scenario: Stores live in app-data
- **WHEN** the packaged backend starts with an app-data directory
- **THEN** its sqlite stores, lock file, and config resolve under that directory, not `/tmp` or the cwd

#### Scenario: Default config seeded once
- **WHEN** the packaged app runs for the first time and no user config exists in app-data
- **THEN** the bundled default config is copied there, and subsequent runs use the user's copy

### Requirement: Cross-platform backend entry
`src/serve.ts` SHALL run on Windows and macOS as well as Linux: no unconditional Linux-only operations (`/tmp` paths, `pkill`). The single-instance lock SHALL use a cross-platform path; the orphan-chrome reap SHALL run only when a browser is enabled and the platform supports it.

#### Scenario: Starts on Windows
- **WHEN** the backend entry runs under the packaged app on Windows
- **THEN** it starts without invoking `pkill` or `/tmp`-only paths
