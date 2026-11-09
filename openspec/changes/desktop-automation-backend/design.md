# desktop-automation-backend 设计

## 1. 形状：组合，不是替换

`AgentDesktopBackend` **持有** `WindowsDesktop`（组合），`impl Desktop for AgentDesktopBackend`；
`main.rs` 的 `type Backend` 换成它。选组合不选包装成 `Box<dyn Desktop>` 的原因：trait 方法是
同步的、无对象安全负担；组合让回落直接是 `self.inner.find(...)`，不经过动态分发。

```rust
pub struct AgentDesktopBackend {
    inner: WindowsDesktop,
    cli: Option<Cli>,                 // 解析 + 版本自检都过了才有；None = 本会话永久 UIA
    snap: Option<SnapshotCtx>,        // 当前 snapshot 上下文
    ad_window: Option<String>,        // scope/focus 的窗口映射到 agent-desktop 的 window id
}
```

## 2. CLI 层：每 op 一进程

- `run(args, timeout)`：`Command::new(path)` + stdout 收集 + 轮询超时（deadline 后 kill）。
  snapshot `--timeout-ms 3000`（其 Chromium settle 参数按需透传）、动作命令 8s、进程级强杀
  15s。超时映射为回落决策表里的「超时」一档。
- envelope 形状（v2.6）：`{"version":"2.6","ok":bool,"command":…,"data":…,"error":{"code","message","disposition":{"delivery","retry"}}}`。
  解析失败/非零退出且无 JSON = 进程失败一档。
- runner 注入：`Cli` 的执行函数是注入点（真实现 spawn 子进程；测试注入假 runner 回放
  fixture JSON）。Windows 真机之外的全部逻辑都能在 Linux 上被 `cargo test` 覆盖。

## 3. 定位与版本自检

- 顺序：`STREAM_AGENT_DESKTOP_PATH` → `current_exe` 同目录 `agent-desktop.exe`。
- 找到后跑 `--version`，输出 `agent-desktop 1.2.0`，解析主.次；pin **主.次 = 1.2**（patch
  忽略）。不符 / 进程起不来 / 权限拒绝 → `cli = None`，本会话永久走 UIA，日志留一行。
  可选能力静默降级，不报错、不影响其它 op。

## 4. snapshot 上下文与窗口映射

- `scope_window` / `focus_window` 透传 inner，并作废 `snap`（旧 ref 全失效，与 inner 的
  `elements.clear()` 同口径）；窗口 id（hwnd）与 agent-desktop `window id` 的映射**惰性**：
  第一次需要 snapshot 时用 `list-windows --app <进程名>` 按 pid + title 对上，对不上 →
  本 op 回落 UIA（原因码 `window-not-found`），映射不作长期缓存（窗口会关）。
- `find`：role/name 精确走 CLI 的 `find` 命令；`nameContains` / `className` / `path` 无
  CLI 等价物 → `snapshot -i --include-bounds` + **本地过滤**（保留 `A11yQuery` 全语义，
  与 windows.rs 一份 matcher 同口径）。命中转 `A11yElement`：ref 用 CLI 的
  `@<snapshot_id>:eN`，rect 从 bounds。这保证 find 命中的 ref 与后续 invoke/setValue 落在
  同一 snapshot 上下文——Stream「每次回放重新定位」的模型不用变。
- 空结果就是空结果：**不回落**。回落会让「这个元素不存在」伪装成「读得到但换了路」，
  drift 分类全部失真。

## 5. op 映射

| Desktop op | agent-desktop 优先 | 说明 |
|---|---|---|
| `find` | `find` / `snapshot -i --include-bounds` + 本地过滤 | 见 §4 |
| `invoke` | `click @ref` | headless 语义路（Invoke → Legacy 降级链） |
| `set_value` | `set-value @ref` | `delivered_verified` = 成功；`delivered_unverified` = 成功 + 标记；`not_delivered` = Err（同 windows.rs 回读纪律：读不回来 = 失败） |
| `read_subtree` | `snapshot`（spec.path 有则 `--root @ref`）+ 本地 field map / dedupe | fields.read 的 value 档与 windows.rs 同口径（读 name） |
| `read_elements`（a11y 档） | `snapshot -i --include-bounds` 转 `ElementsRead` | window / scale 从 inner 侧窗口 rect 补 |
| 其余全部 | — | 原样走 inner：windows / scope / focus / ensureApp / click / moveMouse / scroll / **type（前台闸门一字不动）** / press / nudge / post_input / clearInput / screenshot / findImage / readText / readElements(detector/text 档) / url / sleep / browser.* |

- `read_elements` 的 `icons` 档（纯视觉检测）与 `a11y:false` 申报原样保留：agent-desktop
  没有任何视觉层，QQ NT 这类不暴露树的应用仍走 see/OCR。
- `screenshot` 留在 windows.rs（PrintWindow → xcap 链的 DPI / 坐标系已验过，CLI 截图无
  增量收益）。
- `clearInput` 留键盘路（trait 无 ref 参数、op 面不动）；语义清空 = `setValue` 空串
  （agent-desktop 的 `set-value ""` 与其 `clear` 等价）。

## 6. 回落决策表

先决：`session_locked() == Some(true)` → 直接 UIA（锁屏场景，真机实测为准）；`cli == None`、
降级开关、窗口映射失败 → UIA。

| CLI 错误码 | 处置 | 原因码（回执/日志） |
|---|---|---|
| `AMBIGUOUS_TARGET` | 回落 | `ambiguous-target` |
| `POLICY_DENIED` | 回落 | `policy-denied` |
| `PERM_DENIED` | 回落 | `perm-denied` |
| `APP_NOT_FOUND` / `WINDOW_NOT_FOUND` / `SNAPSHOT_NOT_FOUND` | 回落 | `window-not-found` |
| `ACTION_NOT_SUPPORTED` | 回落 | `action-not-supported`（旧 UIA invoke 梯子多 SelectionItem / Toggle rung） |
| `TIMEOUT` / 进程失败 | 回落 | `timeout` / `cli-failed` |
| `STALE_REF` | 重取 snapshot 一次再试；仍败回落 | `stale-retried` |
| `ELEMENT_NOT_FOUND` | **不回落**，如实报 | — |
| `ACTION_FAILED` | **不回落**，如实报 | — |
| 其余（`INTERNAL` 等） | 回落 | `cli-error` |

## 7. 回执与留痕

- `Desktop` trait 加默认方法 `backend_tag(&mut self) -> Option<(Backend, Option<Reason>)>`
  （缺省 `None`，其它后端零改动、wire 兼容）。`settle` 读它，输出加
  `"backend": "agent-desktop"|"uia"` 与 `"fallback": "<原因码>"`（没回落就没有这个键）。
- host-agent 本地日志：每次回落（与每次 CLI 调用）记一行 `op、原因码、耗时`。真机验收的
  一致率 / 回落率统计靠它。

## 8. 降级开关

`STREAM_DESKTOP_BACKEND`：值 `uia`（大小写不敏感）= 整批回旧路；缺省或其它值 = agent-desktop
优先。只认一个显式值，不猜其它拼写——写错的开关比没有开关更危险。

## 9. 分发

- release-desktop Windows job：下载 `agent-desktop-v<pin>-x86_64-pc-windows-msvc.tar.gz`
  与 `checksums.txt`（CRLF，`tr -d '\r'` 后核验，仓库里 release-desktop.yml 已有同款先例），
  解出 `agent-desktop.exe` 落 `capabilities/desktop/platforms/desktop-win32-x64/bin/`；
  平台包 `package.json` 的 `files` 白名单加 `bin/agent-desktop.exe`。
- `THIRD-PARTY-NOTICE` 加 agent-desktop 条目（Apache-2.0，上游无独立 NOTICE 文件，按
  §4(d) 保留 LICENSE 与归属；仓库内 PP-OCRv5 条目是同款先例）。

## 10. 测试策略

**Linux（CI + 本地）可验**：CLI 层解析 / 超时 / 错误映射、回落决策表（含 stale-retried 与
两个不回落码）、版本 pin 解析、降级开关、二进制定位顺序、窗口映射（fixture）、
find 本地过滤（nameContains / className / path）、readSubtree 组装、disposition 三态映射、
`backend_tag` 与 settle 回执形状。集成测试用注入 runner 回放 fixture；另有一个 `#[ignore]`
的真 CLI 冒烟（`--version` + `status`），有二进制的机器手动开跑。

**Windows 真机（另行组织，不在本 change 的机器上）**：不抢前台点击、set-value 回读真伪
（自绘应用应如实报 `ACTION_FAILED`）、headless `type` 应 `POLICY_DENIED`、headless `press`
失败关闭、scroll、锁屏行为、双胞胎控件 `AMBIGUOUS_TARGET`、Electron/Chromium settle、
UIPI；单 op 启动开销 p95 < 500ms（超了换 batch / 常驻会话再量）；2-3 条现有桌面 recipe
双路对跑（含一条 PostMessage 路），一致率与回落率按 §7 的日志统计。
