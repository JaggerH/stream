## 计划 1：Windows 构建健康（先于功能）

- [x] 1. `Session.forwarder` 与 `run_session` 的转发分支加平台门（linux-only 模块被无门引用，
      Windows target 编译 4×E0433）；`ForwarderLike` 占位别名与 `FetcherLike` 同款
- [x] 2. 重连退避测试对齐 `BACKOFF_BASE` 现行值（250ms 起 / 30s 封顶，与 cdp-binding 同值）
- [x] 3. 常规 test 流程加 Windows target 交叉 `cargo check`（不链接、不需要 mingw）

## 计划 2：AgentDesktopBackend

- [x] 4. CLI 层：envelope 解析、runner 注入、超时强杀、`--version` 解析与 pin（主.次 = 1.2）
- [x] 5. 定位（exe 同目录 → `STREAM_AGENT_DESKTOP_PATH`）、版本自检失败永久 UIA、降级开关
- [x] 6. 回落决策表（纯函数 + 单测，含 stale-retried 与两个不回落码）
- [x] 7. snapshot 上下文与窗口映射（惰性 list-windows 按 pid+title）
- [x] 8. `find`（精确走 CLI、nameContains/class/path 本地过滤，保全 A11yQuery 语义）
- [x] 9. `invoke` / `set_value`（disposition 三态映射；`not_delivered` 如实报错）
- [x] 10. `read_subtree` / `read_elements`（a11y 档）本地组装
- [x] 11. `backend_tag` 默认方法 + settle 回执 `backend` / `fallback` 字段 + 逐条日志
- [x] 12. `main.rs` 接线（cfg(windows) Backend 换名）；交叉 `cargo check` 绿

## 计划 3：分发与留痕

- [x] 13. release-desktop Windows job 下载并核验 agent-desktop Release 包，落
      `platforms/desktop-win32-x64/bin/agent-desktop.exe`；`files` 白名单加行
- [x] 14. `THIRD-PARTY-NOTICE` 加 agent-desktop（Apache-2.0）条目

## 计划 4：Windows 真机验收（另行组织）

- [ ] 15. 不抢前台点击：目标在后台、焦点保持，`disposition.delivery` 为 delivered_*
- [ ] 16. set-value：ValuePattern 控件 `delivered_verified`；自绘应用（Telegram 输入框）
      如实报 `ACTION_FAILED`
- [ ] 17. headless `type` 报 `POLICY_DENIED`；`--headed` 仅用户在场时验证
- [ ] 18. headless `press`：目标不在前台失败关闭；在前台 delivered
- [ ] 19. headless `scroll`：有 ScrollPattern 的控件生效；无 pattern 明确报错
- [ ] 20. 锁屏：`snapshot` / `click` / `set-value` 实测（文档说不支持，以实测为准；
        被拒即锁屏场景整段走 UIA 路，验证回落日志）
- [ ] 21. 双胞胎控件：`AMBIGUOUS_TARGET` → 回落 UIA，回执 `fallback` 可见
- [ ] 22. Electron/Chromium：snapshot settle 提示、`--timeout-ms` 透传
- [ ] 23. UIPI：管理员权限窗口 `PERM_DENIED` → 回落路径如实报错
- [ ] 24. 单 op 启动开销：`status` / `snapshot` 冷启动 p95 < 500ms（超了换 batch / 常驻再量）
- [ ] 25. 2-3 条现有桌面 recipe 双路对跑（含一条 PostMessage 路），一致率与回落率按回落日志统计

## 计划 5：macOS 委托（本 change 的第二平台）

- [x] 26. 委托层泛化：`AgentDesktopBackend<D>` 组合任意 `Desktop`；平台差异收敛为 `Profile`
      （role 表、name 来源、className、read:value、权限策略、回执 native 标记）
- [x] 27. macOS role 表与反向表（只放上游会给 ref 的角色；原生 AX 名不经委托）+ 单测
- [x] 28. macOS 的 name 三来源 / `AXIdentifier` 当 className / `read:value` 读 `AXValue` + 单测
- [x] 29. `PERM_DENIED` 在 macOS 整会话降级（本 op 回落 + 本会话不再起 CLI + 一行日志，
      不弹窗不报错）；Windows 保持逐 op 回落 + 两个方向的单测
- [x] 30. 回落重新定位在 macOS 按 profile 反查 role（多对一的不猜，退化成按名字 + 唯一命中）
- [x] 31. `main.rs` 的 macOS `Backend` 换成委托层；trait 默认方法（`nudge_input` /
      `ocr_engine_info` / `ensure_app` / `browser_*`）转发给 inner
- [x] 32. release-desktop macOS job 下载 arm64 / x64 的 agent-desktop 包、核 checksums、
      落 `bin/agent-desktop` 与 `bin/agent-desktop-macos-helper`；两个 darwin 平台包
      `files` 白名单加行；prepack 闸 `DESKTOP_PLATFORM_FILES` 同步（一并补上 Windows
      漏掉的 `bin/agent-desktop.exe`）
- [x] 33. `THIRD-PARTY-NOTICE` 的 agent-desktop 条目补平台说明
- [x] 34. 常规 test 流程加 macOS target 的交叉 `cargo check`（不链接）
- [ ] 35. macOS 真机验收（另行组织，清单见 design §12）：授权与缺授权降级、不抢前台点击、
      set-value 回读、role 映射对比、回落与歧义、锁屏、文件选择面板、启动开销、双路对跑
- [ ] 36. 后续（非本批）：不带 role 的 `readSubtree` 在委托路径只返回可寻址节点（上游 ref
      规则），若真机上缺口明显，让读路径不要求 ref（`find` 仍必须要求）
- [x] 37. 修基线非 Linux 构建：`run_session` 的 `device::OP_HTTP_FETCH` 补 `cfg(target_os =
      "linux")`（`mod device` 的门同一条）——基线 33e9af3 的 Windows 交叉 check 本来就是
      红的（E0433），macOS 闸也会被同一处挡住；Linux 行为不变
