## Purpose

控制台面板管什么：后端连接、登录态就绪、来源/清单管理、把 MCP 装进某个 agent、Provider 调用点绑定与引用安全的删除。

## Requirements

### Requirement: Backend connection management
The control panel SHALL let the user choose local or remote backend and, for remote, enter a base URL + bearer token; the choice persists.

#### Scenario: Switch to a remote backend
- **WHEN** the user enters a remote URL + token and applies
- **THEN** the app connects to that backend and subsequent data comes from it

### Requirement: Login-state readiness
The control panel SHALL show login-state readiness — which cookie domains are currently held and when that snapshot was last taken — sourced from `/api/status`. It SHALL NOT offer configuration for it: the backend pulls login state out of the user's own browser through the companion extension, so there is nothing for the user to fill in.

#### Scenario: Readiness reflects the cookie snapshot
- **WHEN** the user opens the control panel
- **THEN** it shows which domains have cookies and how old the snapshot is

#### Scenario: Never pulled reads as "not yet", not as failure
- **WHEN** the backend has never pulled cookies (no browser has connected yet)
- **THEN** readiness shows an empty domain list with no timestamp, and does not report an error

### Requirement: Source/manifest management
The control panel SHALL list available sources (from the registry) and the user's subscribed streams, and allow subscribing/unsubscribing.

#### Scenario: Subscribe from the panel
- **WHEN** the user picks a source and subscribes
- **THEN** a named stream is created via the API and appears in the rail

### Requirement: Install MCP into an agent
The control panel SHALL provide a one-click action that registers this backend's MCP server into the user's agent configuration.

#### Scenario: Install MCP action
- **WHEN** the user clicks "install MCP"
- **THEN** the MCP server entry is written into the agent config so agents can drive the flows

### Requirement: Provider callsite binding management
The control panel SHALL let a user create a compatible Provider and bind it to a declared callsite. It SHALL
distinguish a Provider's ordered Source members from a dispatch callsite's ordered Provider routes.

#### Scenario: Bind a newly created Provider
- **WHEN** a user creates a metadata Provider and selects it for the video metadata callsite
- **THEN** the control panel saves the binding and shows the Provider as referenced by that callsite

### Requirement: Reference-aware Provider deletion
The control panel SHALL show which callsites reference a Provider and SHALL prevent a deletion action while
references exist, directing the user to replace or clear the bindings first.

#### Scenario: Delete action is blocked by a callsite
- **WHEN** a user opens a Provider referenced by `video.detail.metadata`
- **THEN** the control panel names that callsite and does not offer a destructive delete confirmation
