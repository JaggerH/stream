## Purpose

桌面壳前端：与后端无关的 API client、本地后端的托管、玻璃窗口与不透明降级、密钥进操作系统钥匙串。

## Requirements

### Requirement: Backend-agnostic API client
The frontend SHALL talk to a Stream backend only over HTTP/WS at a configured base URL, so the same build works against a local or remote backend with no code change.

#### Scenario: Same UI against local or remote
- **WHEN** the configured base URL points at the local backend, then at a remote backend
- **THEN** the UI functions identically against both (data never flows through Tauri IPC)

### Requirement: Local backend supervision
When set to local, the Tauri shell SHALL start and supervise the backend sidecar bound to the fixed loopback port `127.0.0.1:8900`. It SHALL probe `/api/health` first and reuse an already-healthy backend on that port (e.g. a running compose stack) instead of spawning a duplicate; otherwise it SHALL spawn the sidecar (dev: `tsx watch src/serve.ts`; release: the bundled `server.mjs`), passing the port and app-data directory via env/args. If the supervised sidecar exits unexpectedly, the shell SHALL restart it with bounded backoff. The shell SHALL emit structured logs for the sidecar's lifecycle (spawn / ready / crash / restart / stop).

**Stop-on-close is conditional on the `background-harvest` preference** (see the `background-harvest` capability): when the preference is OFF (default), closing the window exits the app and a shell-spawned sidecar SHALL be terminated (no zombie). When the preference is ON, closing the window SHALL hide the app to the tray and keep the shell alive supervising the sidecar so it continues harvesting; the shell-spawned sidecar SHALL then be terminated only on an explicit quit (tray "退出" / app quit), not on window close. A reused external backend SHALL always be left running regardless of the preference.

#### Scenario: Local backend started on launch
- **WHEN** the app launches in local mode and no healthy backend is on `127.0.0.1:8900`
- **THEN** the shell spawns the sidecar and waits until `/api/health` responds before the UI leaves the connecting state

#### Scenario: Reuse an already-healthy backend
- **WHEN** the app launches and a healthy backend already answers `/api/health` on `127.0.0.1:8900`
- **THEN** the shell reuses it and does not spawn a duplicate

#### Scenario: Crash restart
- **WHEN** the supervised sidecar exits unexpectedly while the app is running
- **THEN** the shell restarts it with bounded backoff and the UI re-aligns once it is healthy again

#### Scenario: Window close terminates the sidecar when preference is off
- **WHEN** the `background-harvest` preference is OFF and the user closes the window
- **THEN** the app exits and a shell-spawned local sidecar is terminated (no zombie); a reused external backend is left running

#### Scenario: Window close keeps the sidecar alive when preference is on
- **WHEN** the `background-harvest` preference is ON and the user closes the window
- **THEN** the app hides to the tray, the shell stays alive supervising the sidecar, and the sidecar keeps harvesting; it is terminated only on an explicit quit

#### Scenario: Explicit quit terminates the supervised sidecar
- **WHEN** the user explicitly quits (tray "退出" or app quit) while the preference is ON
- **THEN** the shell terminates the shell-spawned sidecar (no zombie); a reused external backend is left running

### Requirement: Glass window chrome with opaque fallback
The shell SHALL apply acrylic/vibrancy where supported and fall back to a solid background otherwise (reusing snapick's translucency detection). Only the body/background is translucent; controls remain solid.

#### Scenario: Opaque fallback when unsupported
- **WHEN** the platform/setting does not support translucency
- **THEN** the window paints a solid background instead of a see-through one

### Requirement: Secrets via OS keychain
Credentials (the remote backend token) SHALL be stored via the OS keychain through Tauri, never in webview localStorage.

#### Scenario: Token not in webview storage
- **WHEN** a remote backend token is saved
- **THEN** it is persisted to the OS keychain and not written to webview localStorage
