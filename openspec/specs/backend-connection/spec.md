## Purpose

前端壳怎么找到并连上后端：端点发现、经 Rust 的跨源传输、自动对齐与重连、可配置的后端 URL。

## Requirements

### Requirement: Backend endpoint discovery
桌面前端在 Tauri 本地态下的后端由**壳监管的 sidecar** 提供，绑定固定端口 `http://127.0.0.1:8900`——壳先以 `GET /api/health` 探测该端口，健康则复用、否则 spawn sidecar（见 frontend-shell「Local backend supervision」）。前端不再自行 spawn 后端，但也不假设后端总是外部已运行的。发现阶梯 SHALL 保留用于另外两种情形：**用户配置了远程后端 URL**（优先，若健康则连它、不碰本地 sidecar）；**非 Tauri 同源部署**（前端由后端/边缘同源托管，基址为空、相对访问，不做端口探测）。每个候选以 `GET /api/health` 返回 200 作为健康门控；都不健康时前端进入"后端未运行"引导态、不静默失败。

用户显式配置的远程后端 override 一旦生效，SHALL 在本机 sidecar 的整个生命周期内保持优先——本机 sidecar 崩溃、重启或首次就绪 SHALL NOT 覆盖用户设定的上游指向，只有用户主动清空 override 才交还本地默认。壳侧上游状态 SHALL 区分「用户显式设定」与「监管器就绪/复用设定」两种来源，监管器路径写入上游前 SHALL 先判定用户 override 是否在场，在场则跳过覆盖。

#### Scenario: 已配置远程 URL 优先
- **WHEN** 用户设置了远程后端 URL 且该 URL 健康
- **THEN** 前端连接该远程 URL，不启动或探测本地 sidecar

#### Scenario: 远程 override 在 sidecar 重启后仍优先
- **WHEN** 用户已显式设定远程后端 override，随后本机被监管的 sidecar 崩溃并自动重启、探到就绪
- **THEN** 壳侧上游保持指向用户设定的远程后端，就绪分支不将其覆盖回本地 8900，前端无声切换不发生

#### Scenario: 本地态由壳监管 sidecar 于 8900
- **WHEN** 未配置远程 URL，Tauri 本地态
- **THEN** 后端来自壳监管、绑定 `127.0.0.1:8900` 的 sidecar（壳探健康→复用，否则 spawn），前端连它

#### Scenario: 都不健康进入引导态
- **WHEN** 本地 sidecar 未就绪且无健康的已配置后端
- **THEN** 前端进入"后端未运行"引导态并自动重连，不静默失败

#### Scenario: 同源 web 部署
- **WHEN** 前端不在 Tauri 中运行且未配置 URL（前端由后端/边缘同源托管）
- **THEN** 基址为空（相对），直接同源访问，不做端口探测

#### Scenario: 清空 override 交还本地默认
- **WHEN** 用户主动清空远程后端 override
- **THEN** 壳侧上游回落到本机 sidecar（8900）默认，监管器恢复对上游的正常置位

### Requirement: Cross-origin transport via Rust
在 Tauri 中，前端到后端的所有 HTTP（REST 与媒体子资源：`<img>/<video>/<audio>` src、下载链接）SHALL 经由一个 Rust 侧反向代理自定义协议发出，实时通道（WebSocket）SHALL 经由 Rust 侧 WebSocket 插件发出，从而绕开 webview 的 CORS / Private Network Access / mixed-content 限制。webview 自身只与应用内自定义协议及插件通信，绝不直接跨域访问后端 origin。非 Tauri（同源）环境 SHALL 使用原生 fetch 与原生 WebSocket。

#### Scenario: REST 与媒体经反向代理
- **WHEN** 在 Tauri 中前端发起 API 请求或加载后端媒体（图片/视频/音频/下载）
- **THEN** 请求经自定义协议由 Rust 反向代理（含 method、body、Range、流式）到当前上游后端并回传，webview 视之为同源，不触发 CORS/PNA/mixed-content

#### Scenario: 实时通道经插件
- **WHEN** 在 Tauri 中前端订阅实时更新
- **THEN** WebSocket 由 Rust 侧插件连接真实的后端 `ws://…/ws`，不经 webview 网络栈

#### Scenario: 同源使用原生传输
- **WHEN** 前端在浏览器/同源部署中运行
- **THEN** REST 用原生 fetch、实时用原生 WebSocket，行为与现状一致

### Requirement: Auto-align and reconnect
前端 SHALL 维护连接状态（探测中 / 已连接 / 断开），并在后端首次可用或恢复时自动对齐——无需重启应用。当 REST 请求持续失败或 WebSocket 断开时 SHALL 转入断开态并在后台重跑发现阶梯；命中健康后端后 SHALL 自动重新加载数据并重连实时通道。SHALL 提供手动重连入口。

#### Scenario: 后端起来后自动对齐
- **WHEN** 应用以引导态启动（无后端），用户随后启动后端
- **THEN** 后台重探命中健康后端，前端自动连接并加载数据，无需重启应用

#### Scenario: 后端中途挂掉后自动重连
- **WHEN** 已连接状态下后端不可用（请求失败/WS 断）
- **THEN** 前端转入断开态、后台重探，后端恢复后自动重连并恢复实时更新

### Requirement: Configurable backend URL
前端 SHALL 暴露一个可编辑、可持久化的后端 URL 设置项，覆盖发现默认。留空 SHALL 表示使用发现默认候选。修改该设置 SHALL 触发重新探测。

#### Scenario: 配置远程后端
- **WHEN** 用户在设置中填入一个远程后端 URL 并保存
- **THEN** 前端重新探测并连接该远程后端，REST/媒体经反代、WS 经插件均可用

#### Scenario: 清空回落默认
- **WHEN** 用户清空后端 URL 设置
- **THEN** 前端回落到本地默认候选发现
