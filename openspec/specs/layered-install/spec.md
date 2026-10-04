## Purpose

分层安装：core 是底座、壳与持久化是加装项；core 不依赖用户自备运行时，共享 core 靠一个指针发现，壳启动时守版本偏移。

## Requirements

### Requirement: Core is the base install; shell and persistence are add-ons
The distribution SHALL be layered: a **core base** (node backend + MCP, one code version) is the always-present unit and is independently installable on its own (= 纯 MCP 模式). The desktop shell and any background-persistence are **add-ons** layered on top, each installable and removable without touching the core. Installing an add-on SHALL NOT lay down a second copy of the core; it SHALL point at the shared core.

#### Scenario: Core-only install serves MCP without the shell
- **WHEN** only the core base is installed (no shell)
- **THEN** the stdio MCP works against that core (read tools over disk, write tools degrade per the decouple-one contract) with no desktop app present

#### Scenario: Supplementary install adds the shell against the same core
- **WHEN** a user with a core-only install later installs the desktop shell
- **THEN** the shell points at the already-installed core (does not embed its own), and the core install is otherwise unchanged (真加层)

### Requirement: Core self-runs without a user-provided runtime
The core base SHALL be runnable without assuming the user has a node/pnpm toolchain installed — it SHALL carry or fetch its own runtime (aligned with the desktop-distribution on-demand-download stance; the core's base install is a trigger point for that download).

#### Scenario: Core runs on a machine without node
- **WHEN** the core base is installed on a machine that has no node/pnpm on PATH
- **THEN** the core still starts (via a bundled or on-demand-fetched runtime), it does not fail with "node not found"

### Requirement: Shared-core discovery via a pointer
The core base SHALL record its location and version in a well-known pointer (under `~/.stream/core/`). The shell and any persistence add-on SHALL read that pointer to discover the shared core rather than guessing a path or bundling their own copy.

#### Scenario: Shell discovers the core from the pointer
- **WHEN** the shell starts and a core base is installed
- **THEN** the shell reads the pointer, resolves the core's path and version, and spawns-or-reuses that core

### Requirement: Version-skew guard at shell startup
The shell SHALL carry the core version it requires and compare it against the discovered core's version at startup. On a compatible version the shell SHALL spawn/reuse the core; on an incompatible version the shell SHALL refuse to run against it and prompt to refresh the core (same release channel), rather than silently driving a mismatched core.

#### Scenario: Compatible core is used
- **WHEN** the discovered core version satisfies the shell's required version
- **THEN** the shell proceeds to spawn/reuse it normally

#### Scenario: Incompatible core is refused, not silently driven
- **WHEN** the discovered core version is incompatible with the shell's requirement
- **THEN** the shell does not drive the mismatched core and prompts the user to refresh the core to a compatible version
