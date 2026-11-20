# desktop-automation-backend 设计

## 1. 形状：组合，不是替换

`AgentDesktopBackend<D>` **持有**任意 `Desktop` 实现（组合），`impl Desktop for
AgentDesktopBackend<D>`；Windows 传 `WindowsDesktop`（UIA），macOS 传 `MacDesktop`（AX），
`main.rs` 两个桌面平台的 `type Backend` 都换成它。选组合不选包装成 `Box<dyn Desktop>` 的原因：
trait 方法是同步的、无对象安全负担；组合让回落直接是 `self.inner.find(...)`，不经过动态分发。

```rust
pub struct AgentDesktopBackend<D: Desktop> {
    inner: D,                         // WindowsDesktop / MacDesktop
    core: AdCore,                     // CLI 会话状态：snap / 窗口映射 / 回执标记 / 本会话降级
    profile: &'static Profile,        // 平台差异表：role 词表、name 来源、className、read:value、权限策略
}
```

**平台差异全部在 `Profile` 里**，glue 没有 `cfg`。`Profile` 的字段与两套取值：

| 字段 | Windows | macOS |
|---|---|---|
| `to_ad` / `from_ad` | UIA ControlType 词表 ↔ canonical（`option` / `textfield` / `tablist`…） | 中性词 ↔ 上游 macOS canonical（`row` / `radiobutton` / `webarea`…）；原生 `AX` 名不经委托 |
| `report_role` | canonical → Stream 中性词 | canonical → 原生 AX 名（`AXButton` / `AXTextField`…） |
| `name_fields` | `Name` | `Name` → `Description` → `Value`（mac 的三个名字来源） |
| `class_name_query` / `ax_identifier_as_class` | 不可查询 / 恒空 | 可按 `AXIdentifier` 查 / 填 `className` |
| `value_field_reads_value` | 否（`read:value` 读 name） | 是（读 `AXValue`，缺席退主名字） |
| `perm_denied_is_session_wide` | 否（UIPI 逐 op 回落） | 是（TCC 辅助功能授权是进程级的） |
| 回执 native 标记 | `uia` | `ax` |


## 2. CLI 层：每 op 一进程

- `run(args, timeout)`：`Command::new(path)` + stdout 收集 + 轮询超时（deadline 后 kill）。
  snapshot `--timeout-ms 3000`（其 Chromium settle 参数按需透传）、动作命令 8s、进程级强杀
  15s。超时映射为回落决策表里的「超时」一档。
- envelope 形状（v2.6）：`{"version":"2.6","ok":bool,"command":…,"data":…,"error":{"code","message","disposition":{"delivery","retry"}}}`。
  解析失败/非零退出且无 JSON = 进程失败一档。
- runner 注入：`Cli` 的执行函数是注入点（真实现 spawn 子进程；测试注入假 runner 回放
  fixture JSON）。委托 glue 用假 `Desktop` 驱动。两个平台真机之外的全部逻辑都能在 Linux 上
  被 `cargo test` 覆盖。

## 3. 定位与版本自检

- 顺序：`STREAM_AGENT_DESKTOP_PATH` → `current_exe` 同目录 `agent-desktop.exe`（macOS 无
  扩展名，`agent-desktop`）。
- 找到后跑 `--version`，输出 `agent-desktop 1.2.0`，解析主.次；pin **主.次 = 1.2**（patch
  忽略）。不符 / 进程起不来 → `cli = None`，本会话永久走本平台后端，日志留一行。
  可选能力静默降级，不报错、不影响其它 op。
- macOS 的 `PERM_DENIED` **不是**启动自检的一部分（`--version` 不需要辅助功能授权）：它在
  第一次语义 op 时出现，按 §6 的进程级规则整会话降级。

## 4. snapshot 上下文与窗口映射

- `scope_window` / `focus_window` 透传 inner，并作废 `snap`（旧 ref 全失效，与 inner 的
  `elements.clear()` 同口径）；窗口 id（hwnd / mac 窗口 id）与 agent-desktop `window id` 的
  映射**惰性**：第一次需要 snapshot 时用 `list-windows` 的 data（`id` / `pid` / `title`，两个
  平台同一形状）按 pid + title 对上，对不上 → 本 op 回落（原因码 `window-not-found`），
  映射不作长期缓存（窗口会关）。
- `find`：**统一走 `snapshot -i --include-bounds` + 本地过滤**（保留 `A11yQuery` 全语义，与
  windows.rs / macos.rs 的 matcher 同口径）。CLI 的 `find` 命令不用于此路：它的结果（`LocatorMatchData`）
  不带 bounds，而 `A11yElement` 必须带 rect——为补 rect 再发进程得不偿失。命中转 `A11yElement`：
  ref 用 CLI 的 `@<snapshot_id>:eN`，rect 从 bounds。这保证 find 命中的 ref 与后续 invoke/setValue
  落在同一 snapshot 上下文——Stream「每次回放重新定位」的模型不用变。
- role 词表差一层，本地翻译，两个平台各一张表：Stream 的查询 role 是中性词（`Button` /
  `ListItem` / `Edit`…），agent-desktop 的 canonical role 是平台表的小写且按 pattern/subrole
  精化。Windows 的映射出处是 `crates/windows/src/tree/roles.rs`；macOS 的见 §11。`path` 条件
  两边都不实现（本平台后端的条件同样忽略它），保持同口径。`className` 只有 macOS 能委托
  （snapshot 的 `native_id.kind == ax_identifier` 就是 `AXIdentifier`）；Windows 的 snapshot
  没有这个字段，带它的查询整条回落 UIA。
- 空结果就是空结果：**不回落**。回落会让「这个元素不存在」伪装成「读得到但换了路」，
  drift 分类全部失真。

## 5. op 映射

| Desktop op | agent-desktop 优先 | 说明 |
|---|---|---|
| `find` | `find` / `snapshot -i --include-bounds` + 本地过滤 | 见 §4 |
| `invoke` | `click @ref` | headless 语义路（Invoke → Legacy 降级链） |
| `set_value` | `set-value @ref` | `delivered_verified` = 成功；`delivered_unverified` = 成功 + 标记；`not_delivered` = Err（同 windows.rs 回读纪律：读不回来 = 失败） |
| `read_subtree` | `snapshot`（spec.path 有则 `--root @ref`）+ 本地 field map / dedupe | `fields.read` 的 `name` 档读主名字；`value` 档按平台（Windows 读 name，macOS 读 `AXValue`、缺席退主名字） |
| `read_elements`（a11y 档） | 第一批**不换**，整条走本平台后端 | 三档（a11y / detector / text）共享**同一次截屏**，只换 a11y 那一档要重构整条管线；且 agent-desktop 的 a11y 档与 Stream 同源，无保真度差异。真机量完启动开销后再评估是否换 |
| 其余全部 | — | 原样走 inner：windows / scope / focus / ensureApp / click / moveMouse / scroll / **type（前台闸门一字不动）** / press / nudge / post_input / clearInput / screenshot / findImage / readText / readElements(全部三档) / url / sleep / browser.*；trait 的默认方法（`nudge_input` / `ocr_engine_info` / `ensure_app` / `browser_*`）**必须转发**给 inner，不能被缺省实现盖掉 |

- `read_elements` 的 `icons` 档（纯视觉检测）与 `a11y:false` 申报原样保留：agent-desktop
  没有任何视觉层，QQ NT 这类不暴露树的应用仍走 see/OCR。
- `screenshot` 留在 windows.rs（PrintWindow → xcap 链的 DPI / 坐标系已验过，CLI 截图无
  增量收益）。
- `clearInput` 留键盘路（trait 无 ref 参数、op 面不动）；语义清空 = `setValue` 空串
  （agent-desktop 的 `set-value ""` 与其 `clear` 等价）。

## 6. 回落决策表

先决：`session_locked() == Some(true)` → 直接走本平台后端（锁屏场景，真机实测为准）；`cli == None`、
降级开关、窗口映射失败 → 本平台后端。

**回落只允许「确定没动过应用」的失败**——动作 op（invoke / setValue，有副作用）与读 op
（find / readSubtree）在此分野：

| 失败 | 读 op | 动作 op |
|---|---|---|
| `AMBIGUOUS_TARGET` / `POLICY_DENIED` / `PERM_DENIED` / 窗口类 NOT_FOUND / `ACTION_NOT_SUPPORTED`（动作前拒绝） | 回落 | 回落 |
| spawn 失败（程序没起来 = 动作没发生） | 回落 `cli-unavailable` | 回落 `cli-unavailable` |
| `STALE_REF`（ref 失效 = 确定未执行） | 重取 snapshot 一次，仍败回落（`stale-retried`） | 同左 |
| `TIMEOUT` / 进程中途失败 / 回执解析不了 / 未知码 | 回落（`timeout` / `cli-failed` / `cli-error`） | **投递未知**：`delivery-unknown` 如实上抛，绝不回落、绝不重发 |
| `ELEMENT_NOT_FOUND` / `ACTION_FAILED` | 如实报（空结果/应用没收下），不回落 | 同左 |

动作 op 的分派抽成平台无关纯函数 `action_route()`——回落只从 `Fallback` 变体出来，glue 没有
该变体就碰不到 inner 的动作方法（类型上封死「超时后再执行一次」）。`delivery-unknown` 的
处置纪律与 `foreground-lost-midway` 同构（先看目标应用实际状态，别直接重发），在
desktop-failure.ts 注册为独立失败档，重放引擎对它不自动重试、不换候选、设值不退键盘——
退键盘那条路只属于「确定没写进」的失败。

**回落是「重新定位再动作」，不是 ref 换路。** ad ref（`@<snapshot_id>:eN`）与本平台后端的 ref
（进程内元素句柄）是两个空间：find 由 CLI 服务时，invoke/setValue 拿到的是 ad ref，native 路
认不得它。所以回落时后端用该元素的**结构特征**（role 反查回 Stream 词表 + name）在 native 路
重新定位，恰好唯一命中才执行；零个或多个命中都如实报错，绝不任选——与 `resolve_window` 的
歧义纪律同一条。macOS 上反查表只对「回得去、且回得准」的 canonical 给 role：多对一的
（`textfield` 来自四种 AX 角色）返回 None，重新定位退化成只按名字找，仍要求唯一命中——
不拿一个猜出来的 role 去放宽。

**`PERM_DENIED` 在 macOS 上是进程级的。** 辅助功能授权（TCC）按启动 agent 的应用算，缺了
之后每条 AX 调用都会同样失败。第一次收到 `PERM_DENIED` 时：本 op 照表回落 `macos.rs`
（原因码 `perm-denied`），并把委托层本会话置为不可用——后续 op 直接走 `macos.rs`、不再起
CLI 进程，回执原因码仍是 `perm-denied`。只留一行日志，**不弹窗、不报错**（可选能力静默降级；
授权后重启 agent 即恢复委托）。Windows 的 `PERM_DENIED`（UIPI，某个管理员窗口）不受影响，
仍逐 op 回落。

## 7. 回执与留痕

- `Desktop` trait 加默认方法 `backend_tag(&mut self) -> Option<(Backend, Option<Reason>)>`
  （缺省 `None`，其它后端零改动、wire 兼容）。`settle` 读它，输出加
  `"backend": "agent-desktop"|"uia"|"ax"` 与 `"fallback": "<原因码>"`（没回落就没有这个键）。
  native 标记按平台：Windows `uia`、macOS `ax`——回执说的是「这次实际走了哪条路」。
  标记是**一次性**的，并且**只描述紧挨着的那次动作**：走 AX / 坐标 / 键盘的动作会先清掉
  上一条 find / read 留下的标记，免得回落率统计把读路径的标记算到动作头上。
- host-agent 本地日志：每次回落（与每次 CLI 调用）记一行 `op、原因码、耗时`。真机验收的
  一致率 / 回落率统计靠它。

## 8. 降级开关

`STREAM_DESKTOP_BACKEND`：值 `uia`（历史名）或 `native`（大小写不敏感）= 整批回本平台后端；
缺省或其它值 = agent-desktop 优先。只认这两个显式值，不猜其它拼写——写错的开关比没有开关
更危险。

## 9. 分发

- release-desktop Windows job：下载 `agent-desktop-v<pin>-x86_64-pc-windows-msvc.tar.gz`
  与 `checksums.txt`（CRLF，`tr -d '\r'` 后核验，仓库里 release-desktop.yml 已有同款先例），
  解出 `agent-desktop.exe` 落 `capabilities/desktop/platforms/desktop-win32-x64/bin/`；
  平台包 `package.json` 的 `files` 白名单加 `bin/agent-desktop.exe`。
- release-desktop macOS job（arm64 / x64 两档）：下载对应 target 的
  `agent-desktop-v<pin>-<target>.tar.gz` 与 `checksums.txt`，核验后解出 `agent-desktop`
  解出 `agent-desktop` 与它的剪贴板 helper `agent-desktop-macos-helper`（上游 macOS 包固定
  两件）落 `capabilities/desktop/platforms/desktop-darwin-{arm64,x64}/bin/`（无扩展名，补执行位），
  两个平台包的 `files` 白名单加这两个文件。mac runner 用系统自带的
  `shasum -a 256 -c`（吃同一种清单格式）。
- 平台包的出货清单有两处：`package.json#files` 与 prepack 闸
  （`scripts/assert-npm-artifact.mjs` 的 `DESKTOP_PLATFORM_FILES`，逐文件精确名单）。**两处
  必须同时改**，只改一处 = publish 当场红（闸的名单和 manifest 不一致）。Windows 的
  `bin/agent-desktop.exe` 在上一批只进了 manifest、没进闸的名单，这次一并补上。
- `THIRD-PARTY-NOTICE` 的 agent-desktop 条目补平台说明（Windows 与 macOS 平台包都内嵌；
  Apache-2.0，上游无独立 NOTICE 文件，按 §4(d) 保留 LICENSE 与归属；仓库内 PP-OCRv5 条目
  是同款先例）。

## 10. 测试策略

**Linux（CI + 本地）可验**：CLI 层解析 / 超时 / 错误映射、回落决策表（含 stale-retried 与
两个不回落码）、版本 pin 解析、降级开关、二进制定位顺序、窗口映射（fixture）、
find 本地过滤（nameContains / className / path）、readSubtree 组装、disposition 三态映射、
`backend_tag` 与 settle 回执形状。委托 glue 用假 `Desktop` + 假 runner 驱动，覆盖两个平台的
`Profile`：Windows 的 role 表、macOS 的 role 表与多名字来源 / `AXIdentifier` / `read:value`、
回落重新定位（唯一命中 / 0 命中 / 歧义拒绝）、`PERM_DENIED` 在 macOS 整会话降级而在 Windows
逐 op 回落、默认方法转发。另有一个 `#[ignore]` 的真 CLI 冒烟（`--version` + `status`），
有二进制的机器手动开跑。

**Windows 真机（另行组织，不在本 change 的机器上）**：不抢前台点击、set-value 回读真伪
（自绘应用应如实报 `ACTION_FAILED`）、headless `type` 应 `POLICY_DENIED`、headless `press`
失败关闭、scroll、锁屏行为、双胞胎控件 `AMBIGUOUS_TARGET`、Electron/Chromium settle、
UIPI；单 op 启动开销 p95 < 500ms（超了换 batch / 常驻会话再量）；2-3 条现有桌面 recipe
双路对跑（含一条 PostMessage 路），一致率与回落率按 §7 的日志统计。

**macOS 真机（另行组织，见 §12）**：授权与缺授权降级、不抢前台点击、set-value 回读、
role 映射与 macos.rs 结果集对比、回落与歧义、锁屏、菜单/面板、启动开销、双路对跑。

## 11. macOS 委托面

上游 macOS 的 canonical role 表（`crates/macos/src/tree/roles.rs`）与 Windows 不是一套。
Stream 的中性词 → canonical 只有一张小表，**只放上游会给 ref 的可寻址控件**：

| Stream 查询 role | canonical 候选 | 备注 |
|---|---|---|
| `Button` | `button` | `AXButton`（含 close/minimize/zoom 等 subrole） |
| `CheckBox` | `checkbox` | `AXCheckBox` |
| `ComboBox` | `combobox` | `AXComboBox` / `AXPopUpButton` |
| `RadioButton` | `radiobutton` | `AXRadioButton` |
| `Edit` | `textfield` | 上游把 `AXTextField` / `AXTextArea` / `AXSearchField` / `AXSecureTextField` 都归到这里 |
| `Hyperlink` | `link` | `AXLink` |
| `ListItem` / `TreeItem` | `row` / `treeitem` | `AXRow`；outline 行按 subrole 精化成 `treeitem`，`macos.rs` 两者都按 `AXRow` 匹配 |
| `MenuItem` | `menuitem` | `AXMenuItem` / `AXMenuBarItem` |
| `TabItem` | `radiobutton` | mac 的标签页是带 `AXTabButton` subrole 的 `AXRadioButton`（与 `macos.rs` 同口径） |
| `DataItem` | `cell` | `AXCell` |

**不经委托（整条回落 `macos.rs`）：**

- 上游不分配 ref 的角色：`Text`（`statictext`）、`Group` / `Pane`（`group`）、`Window`、
  `List`、`Tab`、`ToolBar`、`Image`、`Document`、`Custom`。上游的规则是「Only addressable
  elements get refs. Static text and inert containers do not.」——委托过去只会把「控件存在」
  读成空结果，比回落更坏。
- 原生 `AX` 名（`AXButton` / `AXSheet`…）：canonical 词表对若干 AX 角色是多对一
  （`AXTextField`/`AXTextArea`/`AXSearchField`/`AXSecureTextField` → `textfield`；
  `AXWindow` + `AXDialog` subrole → `dialog`），按 canonical 过滤会把查询放宽。`macos.rs`
  对原生名是精确 `AXRole` 匹配，这条保真优先。

**报给调用方的 role**：canonical → 原生 AX 名（`button` → `AXButton`、`textfield` →
`AXTextField`、`treeitem` → `AXOutlineRow`…），与 `macos.rs` 的 `A11yElement.role` 口径一致；
多对一的 canonical 给代表性的那个 AX 角色。

**名字与其它字段**：`name` / `nameContains` 对 `name` / `description` / `value` 三个字段都成立
（`macos.rs` 的 `names_of` 同口径）；主名字按 `name` → `description` → `value` 取第一个非空。
`className` 查询按 snapshot 的 `native_id`（`kind == ax_identifier`，即 `AXIdentifier`）全等
过滤，结果把这个值填进 `className`。`readSubtree` 的 `read:value` 读 `AXValue`，缺席退主名字。

**权限**：见 §6。macOS 的辅助功能授权缺失（`PERM_DENIED`）= 本会话整批走 `macos.rs` 并留痕，
不弹窗、不报错。

**已知边界：委托读只覆盖上游分配 ref 的节点。** `find` / `readSubtree` 走
`snapshot -i`，而上游只给可寻址节点分配 ref（静态文本与惰性容器没有）。所以：

- 带 role 的查询按 §11 的表逐条决定委托 / 回落——上游不分 ref 的角色整条回落，
  `find` 的结果集与 AX 路同口径。
- **不带 role 的 `readSubtree`** 委托后只返回可寻址节点，可能比 AX 路少掉静态文本 / 容器行。
  这是上游的 ref 规则，不是过滤 bug；第一批接受（与 Windows 同一取舍），后续若要补齐，
  应让读路径不要求 ref（`find` 仍必须要求——拿不到 ref 的命中没法 invoke）。

## 12. macOS 真机验收清单（另行组织，不在本 change 的机器上）

1. 授权：`agent-desktop permissions` 报 granted；未授权时 host agent 日志恰好一行
   `PERM_DENIED`、本会话语义 op 全部走 AX、无弹窗无报错；授权后重启 agent 恢复委托。
2. 不抢前台：目标窗口在后台、用户窗口持前台，`invoke` / `setValue` 经 CLI 完成，动作回执
   `backend` 为 `agent-desktop`，前台不变（`AXFrontmost` / frontmost app 不变）。
3. `setValue` 回读：`AXTextField` 写入并回读一致；`AXTextArea` / `AXSecureTextField` 的
   `delivered_verified` / `delivered_unverified` 与真实结果一致；应用没收下时如实报错。
4. role 映射：`Button` / `Edit` / `CheckBox` / `RadioButton` / `ListItem` / `TabItem` /
   `DataItem` 的委托结果集与 `macos.rs` 同一时刻的结果集对比一致；`Text` / `Group` /
   `Window` / 原生 `AX*` 查询全部回落（日志 `fallback=query-unsupported`）。
5. 回落：双胞胎控件 `AMBIGUOUS_TARGET` → AX 路唯一命中才执行，回执 `backend=ax` +
   `fallback`；0 命中 / 多命中如实报错；`ELEMENT_NOT_FOUND` 不回落；动作超时报
   `delivery-unknown` 且不重发。
6. 锁屏：锁屏下 `find` / `readSubtree` / `invoke` 的 CLI 与 AX 两路行为（mac 没有纯读的锁屏
   判据，`session_locked()` 恒 `None`，不预判）；不可读时按回落表走。
7. 文件选择面板：Chrome 的 `AXSheet` 在窗口树内（不是独立窗口）——委托 snapshot 能否读到
   sheet / surface，`scopeWindow` 不换窗口。
8. 菜单与菜单栏：headless 点击菜单项（`AXPress`）不抢前台；`--surface menubar` 的 surface
   与 Stream 的窗口 scope 模型如何对齐（不在本 change 的 op 面里，只记录）。
9. Chromium / Electron：委托 snapshot 是否触发上游的 web accessibility 开关；与 `macos.rs`
   的 AX 树节点数 / 关键控件对比。
10. 启动开销：单 op 一进程的 p50 / p95（`status` / `snapshot`）；超 500ms 再评估常驻会话。
11. 分发：干净装机 `bin/agent-desktop` 存在、`--version` 在 pin 内、checksums 通过；
    arm64 与 x64 各一台；`STREAM_DESKTOP_BACKEND=native` 时不启动 CLI。
12. 双路对跑：2-3 条现有 mac 桌面 recipe（含一条视觉/OCR 路）对比一致率与回落率。
