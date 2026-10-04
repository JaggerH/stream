## Purpose

关掉窗口之后是否继续采集，由用户显式选择：托盘常驻、可见性与终止控制，并在真正会疼的那一刻把开关摆到用户面前。

## Requirements

### Requirement: Opt-in keep-harvesting-after-close toggle
The shell SHALL expose a global, persisted preference — default **OFF** — worded around the outcome ("关闭窗口后继续更新频道"), that governs whether closing the window stops the backend or keeps it harvesting in the background. The preference SHALL default OFF so existing behavior (close terminates the sidecar) is unchanged until the user opts in.

#### Scenario: Default off preserves current behavior
- **WHEN** a user who has never touched the preference closes the window
- **THEN** the shell terminates the local sidecar as before (no background process is left running)

#### Scenario: Turning it on is a one-time authorization
- **WHEN** the user enables the preference
- **THEN** it persists across restarts and, on first enable, a one-time explanation is shown ("Stream 会在你关窗后继续带着你的登录态在后台采集,托盘随时可看可退")

### Requirement: Close-to-tray when enabled
When the preference is ON, closing the window SHALL hide the app to a tray icon instead of exiting, keeping the shell alive to supervise the running sidecar; the backend SHALL continue harvesting on its cadence. When the preference is OFF, closing the window SHALL exit and terminate a shell-spawned sidecar (unchanged).

#### Scenario: Enabled close hides to tray and keeps harvesting
- **WHEN** the preference is ON and the user closes the window
- **THEN** the window hides to a tray icon, the shell stays alive, and the supervised sidecar keeps harvesting on cadence

#### Scenario: Disabled close still exits
- **WHEN** the preference is OFF and the user closes the window
- **THEN** the app exits and a shell-spawned sidecar is terminated (no background process remains)

### Requirement: Tray visibility and kill control
While the app is in the tray (preference ON), a tray icon SHALL be the always-visible evidence that harvesting continues, showing recency ("上次采集 X 分钟前") and offering a menu with at least: open the window, harvest once now, and quit (which terminates the sidecar). Quitting from the tray SHALL be the explicit way to stop the background backend.

#### Scenario: Tray shows running state
- **WHEN** the app is hidden to the tray and harvesting in the background
- **THEN** the tray tooltip/menu reflects that it is running and shows the last-harvest recency

#### Scenario: Quit from tray terminates the backend
- **WHEN** the user selects "退出" from the tray menu
- **THEN** the shell terminates the supervised sidecar and fully exits (no background process remains)

### Requirement: Pain-moment surfacing of the toggle
The preference SHALL be surfaced at the moment of felt need rather than only buried in settings: when the user closes the window while the preference is OFF and at least one timeline Stream (scheduled source) exists, the shell SHALL offer the choice once ("要在后台继续更新吗?" → 后台继续 / 这次就退出 / 别再问). Choosing 后台继续 SHALL enable the persisted preference; 别再问 SHALL keep it OFF without prompting again. This SHALL NOT ask on every close.

#### Scenario: Prompt appears once at the pain moment
- **WHEN** the preference is OFF, timeline Streams exist, and the user closes the window for the first time in this state
- **THEN** the shell shows the one-time choice;选 后台继续 enables the preference and hides to tray, 选 这次就退出 exits this time, 选 别再问 exits and suppresses future prompts

#### Scenario: No repeated nagging
- **WHEN** the user has chosen 别再问 (or already enabled the preference)
- **THEN** closing the window does not show the prompt again
