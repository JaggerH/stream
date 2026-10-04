## Purpose

桌面发版产物的形状：后端 bundle 自包含且能自跑、按 triple 只打 boot 必需的原生模块、壳与核的版本同步在发版流程里守门、真机跨平台验收。

## Requirements

### Requirement: Release backend bundle is self-contained and self-running
release 构建 SHALL 产出一个自包含的后端 bundle，使桌面 app 在**未安装 node/pnpm/Docker** 的机器上装完即可
运行核心（tier-0）。构建 SHALL 由 `scripts/build-server.mjs` 将 `src/serve.ts` 打成单文件 `server.mjs`
（ESM 格式、`createRequire` banner 以支持 CJS 依赖运行时 `require()`，`better-sqlite3` 与 `playwright-core`
标记为 external 在运行时从 bundle 内的 `node_modules` 解析），并 SHALL 随包携带一份 node 运行时二进制。
release 分支 SHALL 经 `resource_dir()` 内的**绝对路径**调用 bundled node 与 `server.mjs`，不 SHALL 依赖
PATH 中的裸 `node`/`pnpm`。dev 分支不受本要求约束（维持源码热更前提）。

#### Scenario: 干净机器装完即用
- **WHEN** release 包安装到未装 node/pnpm/Docker 的机器并启动
- **THEN** 壳经 `resource_dir()` 绝对路径 spawn bundled node 运行 `server.mjs`，后端 `GET /api/health` 返回
  200，前端可用，全程无需用户预装任何运行时

#### Scenario: 不依赖 PATH
- **WHEN** 目标机器 PATH 中不存在 `node` 或 `pnpm`
- **THEN** release sidecar 仍能通过 bundled 二进制的绝对路径启动，不因 PATH 缺失而 spawn 失败

### Requirement: Only the boot-critical native module is bundled per triple; the rest degrade
tier-0 boot 的**唯一硬原生依赖**是 `better-sqlite3`（存储命脉，bootstrap 加载）。release 构建 SHALL 按当前
构建的 target triple（win-x64 / mac-arm64 / mac-x64 / linux-x64）携带匹配的 `better-sqlite3` 原生 `.node`
（连同 `bindings`/`file-uri-to-path` 运行时依赖），其 ABI MUST 与随包 node 运行时的 `process.versions.modules`
匹配。node 运行时本身 SHALL 按单一构建 target 携带（不做 N 路 fan-out）。

其余原生依赖 SHALL NOT 作为 tier-0 boot 的硬依赖，而是**缺了降级**：`isolated-vm`（compute 步骤）SHALL 改为
**延迟加载**（首次使用时才 `import`），使其缺失时 tier-0 boot 不受影响；`sharp`（封面相似度）已延迟加载；
`playwright-core`/Chromium（采集）属 tier-1，Chromium MUST NOT 打进包（首次采集登录源时按需下载）。任一延迟
依赖缺失时，用到它的能力 SHALL 明确报错，而 SHALL NOT 使核心崩溃或使无关能力不可用。

#### Scenario: better-sqlite3 各平台携带匹配二进制
- **WHEN** 为某一 target triple 出 release 包
- **THEN** 包内 `better-sqlite3` 的 `.node` 是该平台的原生二进制（非其它平台），且能被 bundled node 成功加载

#### Scenario: 缺失延迟依赖不崩 boot、只降级对应能力
- **WHEN** 纯 tier-0 核心装机上未提供 `isolated-vm`（或 `sharp`），用户触发一条需要 compute 步骤的 recipe
- **THEN** 后端照常 boot、feed/inbox/存储/普通 http+html recipe 照常可用；仅该 compute recipe 明确报「需要
  isolated-vm」，不使核心崩溃、不影响其它能力

#### Scenario: Chromium 不在包内
- **WHEN** 安装 release 核心包
- **THEN** 包内不含 Chromium；仅在首次使用采集登录源时按需下载

### Requirement: Shell/core version sync is guarded in the release process
发版流程 SHALL 校验壳 `app/src-tauri/Cargo.toml` 的 `version` 与 core `package.json` 的 `version` 保持同步，
不一致 SHALL 使发版失败。此校验补的是 `SHELL_REQUIRED_CORE = env!("CARGO_PKG_VERSION")` 隐含、但运行时
`is_core_compatible` 无法在发版前强制的同步假设。

#### Scenario: 版本漂移拦截出包
- **WHEN** 发版时 `Cargo.toml` 与 `package.json` 的 version 不一致
- **THEN** 发版脚本 fail，不产出错位版本的包

#### Scenario: 版本一致放行
- **WHEN** 两个 version 一致
- **THEN** 版本校验通过，发版继续

### Requirement: Release bundle is verified on real machines across platforms
本能力 SHALL 以 Win / Mac / Linux **真机**启动验证为准（`/api/health` 200 + webview 渲染），而非仅以
「交叉编译产物形态正确」判定通过。验证 SHALL 覆盖 webview 经 streamapi 同源反代到 8900 的路径，确认不撞
归档 `app-backend-sidecar` D6 记录的 webview 跨域坑。

#### Scenario: 三平台真机跑通
- **WHEN** 在 Windows、macOS、Linux 各自真机安装并启动 release 包
- **THEN** 每个平台 sidecar 启动、`/api/health` 200、webview 经同源 8900 反代成功渲染 UI，无 CORS/PNA 拦截
