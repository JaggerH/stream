//! agent-desktop 委托层（openspec desktop-automation-backend）：桌面语义 a11y 读与动作
//! 优先委托给内嵌的 agent-desktop CLI（每 op 一个子进程，JSON envelope v2.x），本平台自己的
//! 后端回落——Windows 是 `WindowsDesktop`（UIA），macOS 是 `MacDesktop`（AX）。
//!
//! 委托逻辑只有一份：`AgentDesktopBackend<D>` 组合任意 `Desktop` 实现。两个平台的差异全部
//! 收敛在 `Profile` 这一张表里（role 词表、name 来源、className、read:value、权限策略、回执
//! 标记），glue 里没有一处 `cfg`。
//!
//! 平台无关部分（envelope 解析、错误路由、role 词表映射、snapshot 过滤、窗口映射、版本 pin、
//! 降级开关、委托 glue 本身）在 Linux 上就被 `cargo test` 覆盖——agent-desktop 在 lean/CI 上
//! 没有真桌面可观测，所以集成层一律走注入的假 runner 回放 fixture（`Cli::run` 是注入点），
//! glue 用假 `Desktop` 驱动；只有文件末尾的平台接线真的碰 `WindowsDesktop` / `MacDesktop`。
//!
//! 词表与错误码的出处（v1.2.x，核对过源码）：canonical role 是平台表的小写且按 subrole 精化
//! （Windows：`crates/windows/src/tree/roles.rs`；macOS：`crates/macos/src/tree/roles.rs`），
//! 错误码全集在 `crates/core/src/response/error_code.rs`。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::protocol::{A11yQuery, Desktop};
use serde_json::{json, Map, Value};

// ── 配置面 ───────────────────────────────────────────────────────────────────

/// 二进制路径覆盖（测试 / 开发）；缺省按 exe 同目录找（平台包把两者落在一起）。
pub const ENV_BIN_PATH: &str = "STREAM_AGENT_DESKTOP_PATH";
/// 降级开关：`uia`（历史值）或 `native` = 语义 op 整批走本平台后端。只认这两个显式值，
/// 不猜其它拼写——写错的开关比没有开关更危险。
pub const ENV_KILL_SWITCH: &str = "STREAM_DESKTOP_BACKEND";
/// pin 主.次版本（patch 忽略）：这个项目 breaking 频繁（1.1.0 一个月内动过 envelope 与 C ABI），
/// minor pin 是对冲，`--version` 自检不过就本会话永久走本平台后端。
pub const PINNED_MAJOR: u32 = 1;
pub const PINNED_MINOR: u32 = 2;

/// 单个动作命令的进程上限。CLI 内部自己的观察超时（snapshot `--timeout-ms 3000`）比这短，
/// 这层是防进程挂死；超时按回落决策表的 `timeout` 一档处理。
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(8);
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// `find` 一次最多回多少个——与本平台后端同一道防爆闸。
const FIND_CAP: usize = 50;

/// 降级开关注释见 [`ENV_KILL_SWITCH`]。
pub fn kill_switch_on(v: &str) -> bool {
    v.eq_ignore_ascii_case("uia") || v.eq_ignore_ascii_case("native")
}

/// 定位二进制：环境变量覆盖 → exe 同目录。找不到返回 None（可选能力静默缺席）。
pub fn resolve_program(
    getenv: &dyn Fn(&str) -> Option<String>,
    exe_dir: Option<&Path>,
) -> Option<PathBuf> {
    if getenv(ENV_KILL_SWITCH).is_some_and(|v| kill_switch_on(&v)) {
        eprintln!("[agent-desktop] {ENV_KILL_SWITCH} 关闭委托 —— 语义 op 整批走本平台后端");
        return None;
    }
    if let Some(p) = getenv(ENV_BIN_PATH).map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let dir = exe_dir?;
    let file = if cfg!(windows) { "agent-desktop.exe" } else { "agent-desktop" };
    let candidate = dir.join(file);
    candidate.is_file().then_some(candidate)
}

/// `--version` 输出（形如 `agent-desktop 1.2.0`）→ 主.次。解析不出 = None。
pub fn parse_version(stdout: &str) -> Option<(u32, u32)> {
    let tail = stdout.trim().rsplit(' ').next()?.trim();
    let mut it = tail.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

pub fn is_pinned((major, minor): (u32, u32)) -> bool {
    major == PINNED_MAJOR && minor == PINNED_MINOR
}

// ── CLI 进程层 ───────────────────────────────────────────────────────────────

type RunFn = Box<dyn Fn(&Path, &[String], Duration) -> Result<String, String> + Send>;

pub struct Cli {
    pub program: PathBuf,
    run: RunFn,
}

impl Cli {
    pub fn real(program: PathBuf) -> Cli {
        Cli { program, run: Box::new(real_runner) }
    }
    fn run_raw(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        (self.run)(&self.program, &owned, timeout)
    }
}

/// 真执行：spawn + 轮询退出 + 到点强杀。**stdout 的读取必须放在独立线程**——snapshot 的
/// JSON 可以远超管道缓冲（64KB），主线程边等边读会在大输出上死锁。
fn real_runner(program: &Path, args: &[String], timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cli-unavailable: spawn {}: {e}", program.display()))?;
    let mut pipe = child.stdout.take().ok_or("cli-failed: stdout 缺席".to_string())?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        pipe.read_to_end(&mut buf).map(|_| buf).map_err(|e| e.to_string())
    });
    let deadline = Instant::now() + timeout;
    let status: Result<std::process::ExitStatus, String> = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("timeout: agent-desktop 进程超时被强杀".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => break Err(format!("cli-failed: wait: {e}")),
        }
    };
    let out = reader
        .join()
        .map_err(|_| "cli-failed: stdout 读取线程崩溃".to_string())?
        .map_err(|e| format!("cli-failed: {e}"))?;
    match status {
        Err(e) => Err(e),
        Ok(_) => Ok(String::from_utf8_lossy(&out).into_owned()),
    }
}

// ── envelope ────────────────────────────────────────────────────────────────

pub struct Envelope {
    pub ok: bool,
    #[allow(dead_code)]
    pub command: String,
    pub data: Value,
    pub err_code: Option<String>,
    #[allow(dead_code)]
    pub err_message: Option<String>,
    /// `disposition.delivery`：错误与成功回执都可能带（成功路在 `data.disposition`）。
    pub delivery: Option<String>,
}

pub fn parse_envelope(stdout: &str) -> Result<Envelope, String> {
    let v: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("cli-failed: 回执不是 JSON envelope: {e}"))?;
    let ok = v
        .get("ok")
        .and_then(|x| x.as_bool())
        .ok_or("cli-failed: 回执缺 ok 字段".to_string())?;
    let command = v.get("command").and_then(|x| x.as_str()).unwrap_or_default().into();
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let err = v.get("error");
    let err_code = err.and_then(|e| e.get("code")).and_then(|c| c.as_str()).map(str::to_string);
    let err_message = err.and_then(|e| e.get("message")).and_then(|c| c.as_str()).map(str::to_string);
    let delivery = err
        .and_then(|e| e.get("disposition"))
        .or_else(|| data.get("disposition"))
        .and_then(|d| d.get("delivery"))
        .and_then(|d| d.as_str())
        .map(str::to_string);
    Ok(Envelope { ok, command, data, err_code, err_message, delivery })
}

// ── 回落决策表 ──────────────────────────────────────────────────────────────

/// 一个 CLI 错误该往哪走。出处见 openspec design §6：
/// - 回落：动作被拒 / 目标丢了——本平台后端可能还有办法（它多 SelectionItem/Toggle rung
///   这类语义动作，且不经过 CLI 的窗口映射）；
/// - `STALE_REF`：先重取 snapshot 按结构特征重新拿 ref、重试一次，仍败才回落（`stale-retried`）；
/// - 不确定（`Uncertain`）：进程超时 / 中途失败 / 输出解析不了 / 未知错误码——**动作 op 可能
///   已经把输入投到应用上**，回落就是执行第二次（一次点击「发送」变两次）。读 op 没有
///   副作用，照旧回落；
/// - 如实上报：`ELEMENT_NOT_FOUND` 是正常结果（回落会把"这个元素不存在"伪装成"没读到"，
///   drift 分类全部失真）；`ACTION_FAILED` 说明应用没收下，换路同样没用。
#[derive(Debug, Clone, PartialEq)]
pub enum AdFail {
    Fallback(&'static str),
    StaleRef,
    /// 投递状态不明（原因码）：动作 op 绝不回落，读 op 照旧回落。
    Uncertain(&'static str),
    /// 不回落、如实报错（code, message）。
    Report(String, String),
}

pub fn route_for(code: &str) -> AdFail {
    match code {
        "AMBIGUOUS_TARGET" => AdFail::Fallback("ambiguous-target"),
        "POLICY_DENIED" => AdFail::Fallback("policy-denied"),
        "PERM_DENIED" => AdFail::Fallback("perm-denied"),
        "APP_NOT_FOUND" | "WINDOW_NOT_FOUND" | "SNAPSHOT_NOT_FOUND" => AdFail::Fallback("window-not-found"),
        "ACTION_NOT_SUPPORTED" => AdFail::Fallback("action-not-supported"),
        "TIMEOUT" => AdFail::Uncertain("timeout"),
        "STALE_REF" => AdFail::StaleRef,
        "ELEMENT_NOT_FOUND" | "ACTION_FAILED" => AdFail::Report(code.into(), String::new()),
        _ => AdFail::Uncertain("cli-error"),
    }
}

/// 进程层失败的错误串 → 处置档：spawn 失败（程序没起来 = 动作肯定没发生）可回落；
/// 超时与中途失败投递状态不明。
fn runner_fail_reason(err: &str) -> &'static str {
    if err.starts_with("timeout") {
        "timeout"
    } else if err.starts_with("cli-unavailable") {
        "cli-unavailable"
    } else {
        "cli-failed"
    }
}

/// **动作 op**（invoke / setValue，有副作用的）对 `AdFail` 的处置——读 op 不经过这里。
/// 回落只允许「确定没动过应用」的失败：CLI 在动作**前**拒绝的码，与程序没起来（spawn 失败）。
/// 超时 / 中途失败 / 解析不了 / 未知码一律投递未知：调用方先看目标应用的实际状态，
/// 别直接重发。glue 只按这里的输出分派——没有 `Fallback` 变体就碰不到 inner 的动作方法。
#[derive(Debug, Clone, PartialEq)]
pub enum ActionRoute {
    Fallback(&'static str),
    RetryStale,
    DeliveryUnknown(&'static str),
    Report(String, String),
}

pub fn action_route(f: &AdFail) -> ActionRoute {
    match f {
        AdFail::Fallback(reason) => ActionRoute::Fallback(reason),
        AdFail::StaleRef => ActionRoute::RetryStale,
        AdFail::Uncertain(reason) => ActionRoute::DeliveryUnknown(reason),
        AdFail::Report(code, msg) => ActionRoute::Report(code.clone(), msg.clone()),
    }
}

// ── snapshot 树 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AdRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct AdNode {
    pub ref_id: Option<String>,
    pub role: String,
    pub name: Option<String>,
    /// macOS 的 `AXValue`（Windows 的 snapshot 也会带 `value`，只是委托查询里不用它）。
    pub value: Option<String>,
    /// 名字的第二个来源：macOS 的 `AXDescription`。
    pub description: Option<String>,
    /// `native_id.value`，仅 `kind == "ax_identifier"`（mac 的 `AXIdentifier`，即
    /// `MacDesktop` 报的 `className`）。别的 kind（DOM id / AutomationId…）不冒充它。
    pub native_id: Option<String>,
    pub bounds: Option<AdRect>,
    pub children: Vec<AdNode>,
}

pub struct AdSnapshot {
    pub snapshot_id: String,
    pub root: AdNode,
}

fn parse_node(v: &Value) -> AdNode {
    let native_id = v.get("native_id").and_then(|n| {
        (n.get("kind").and_then(|k| k.as_str()) == Some("ax_identifier"))
            .then(|| n.get("value").and_then(|x| x.as_str()).map(str::to_string))
            .flatten()
    });
    AdNode {
        ref_id: v.get("ref_id").and_then(|r| r.as_str()).map(str::to_string),
        role: v.get("role").and_then(|r| r.as_str()).unwrap_or("unknown").into(),
        name: v.get("name").and_then(|n| n.as_str()).map(str::to_string),
        value: v.get("value").and_then(|x| x.as_str()).map(str::to_string),
        description: v.get("description").and_then(|x| x.as_str()).map(str::to_string),
        native_id,
        bounds: v.get("bounds").map(|b| AdRect {
            x: b.get("x").and_then(|x| x.as_f64()).unwrap_or(0.0),
            y: b.get("y").and_then(|y| y.as_f64()).unwrap_or(0.0),
            width: b.get("width").and_then(|w| w.as_f64()).unwrap_or(0.0),
            height: b.get("height").and_then(|h| h.as_f64()).unwrap_or(0.0),
        }),
        children: v
            .get("children")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().map(parse_node).collect())
            .unwrap_or_default(),
    }
}

pub fn parse_snapshot(data: &Value) -> Result<AdSnapshot, String> {
    let snapshot_id = data.get("snapshot_id").and_then(|s| s.as_str()).unwrap_or_default().into();
    let tree = data.get("tree").ok_or("cli-failed: snapshot 回执缺 tree".to_string())?;
    Ok(AdSnapshot { snapshot_id, root: parse_node(tree) })
}

impl AdSnapshot {
    /// ref 必须是快照限定的 `@<snapshot_id>:eN` 形状；tree 里给了裸 ref（tokenless 档）就现场补全。
    pub fn qualify(&self, ref_id: &str) -> String {
        if ref_id.starts_with('@') || self.snapshot_id.is_empty() {
            ref_id.to_string()
        } else {
            format!("@{}:{}", self.snapshot_id, ref_id)
        }
    }

    fn walk<'a>(&'a self, nodes: &'a [AdNode], q: &A11yQuery, profile: &Profile, out: &mut Vec<&'a AdNode>) {
        for n in nodes {
            // 没有 ref 的节点没法被后续 op 寻址，不进结果（与 UIA 路"每个命中都有句柄"同口径）。
            if n.ref_id.is_some() && node_matches(n, q, profile) {
                out.push(n);
            }
            self.walk(&n.children, q, profile, out);
        }
    }

    /// `find`：全部命中（不含根节点本身——与本平台后端的 descendants 口径一致），先序遍历。
    pub fn find(&self, q: &A11yQuery, profile: &Profile) -> Vec<&AdNode> {
        let mut out = Vec::new();
        self.walk(&self.root.children, q, profile, &mut out);
        out.truncate(FIND_CAP);
        out
    }

    fn contains_ref(&self, r: &str) -> bool {
        let mut found = false;
        let mut stack = vec![&self.root];
        while let Some(n) = stack.pop() {
            if n.ref_id.as_deref().is_some_and(|x| self.qualify(x) == r) {
                found = true;
                break;
            }
            stack.extend(n.children.iter());
        }
        found
    }

    fn node(&self, r: &str) -> Option<AdNode> {
        let mut stack = vec![&self.root];
        while let Some(n) = stack.pop() {
            if n.ref_id.as_deref().is_some_and(|x| self.qualify(x) == r) {
                return Some(n.clone());
            }
            stack.extend(n.children.iter());
        }
        None
    }
}

/// `find` / `readSubtree` 的一条命中（拥有所有权的轻量拷贝，树本体留在上下文里）。
#[derive(Debug, Clone)]
pub struct AdMatch {
    pub ref_id: String,
    pub role: String,
    /// 按 profile 的 name 来源报出来的主名字。
    pub name: Option<String>,
    pub value: Option<String>,
    pub native_id: Option<String>,
    pub bounds: Option<AdRect>,
}

impl AdSnapshot {
    pub fn matches(&self, q: &A11yQuery, profile: &Profile) -> Vec<AdMatch> {
        self.find(q, profile)
            .into_iter()
            .map(|n| AdMatch {
                ref_id: self.qualify(n.ref_id.as_deref().unwrap_or_default()),
                role: n.role.clone(),
                name: n.primary_name(profile),
                value: n.value.clone(),
                native_id: n.native_id.clone(),
                bounds: n.bounds.clone(),
            })
            .collect()
    }
}

// ── role 词表映射（每个平台一张表）────────────────────────────────────────

/// snapshot 节点里可以满足 `name` 查询的字段，按报给调用方的优先级排列。
///
/// macOS 的名字有三个来源（`AXTitle` / `AXDescription` / `AXValue`），只读一个会把
/// 「这个控件不存在」演成真话（`macos.rs` 头注第 2 条）；Windows 只有 `Name` 一个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameField {
    Name,
    Description,
    Value,
}

/// 委托层与平台后端的差异。**所有分叉都在这张表里**，glue 不写 `cfg`。
pub struct Profile {
    /// 回执 `backend` 里本平台后端的标记（`uia` / `ax`）。
    pub native_tag: &'static str,
    /// 日志里本平台后端的称呼（`UIA` / `AX`）。
    pub native_label: &'static str,
    /// Stream 查询 role → CLI canonical role 候选；None = 这条查询不经委托。
    pub to_ad: fn(&str) -> Option<&'static [&'static str]>,
    /// CLI canonical role → 回落重新定位时的 Stream role（macOS 可以给原生 AX 名，`macos.rs`
    /// 原样透传）；None = 不带 role 过滤（仍要求唯一命中，见 `act_via_native`）。
    pub from_ad: fn(&str) -> Option<&'static str>,
    /// CLI canonical role → 报给调用方的 role；None = 原样报 canonical。
    pub report_role: fn(&str) -> Option<&'static str>,
    /// 哪些 snapshot 字段参与 `name` / `nameContains`。
    pub name_fields: &'static [NameField],
    /// snapshot 的 `native_id`（`ax_identifier`）填 `A11yElement.className`（mac 的 `AXIdentifier`）。
    pub ax_identifier_as_class: bool,
    /// `className` 查询可委托（按 `native_id` 全等过滤）；false = 整条回落本平台后端。
    pub class_name_query: bool,
    /// readSubtree 的 `read:value` 取 snapshot 的 `value`（缺席退主名字）；false = 只取主名字。
    pub value_field_reads_value: bool,
    /// `PERM_DENIED` 是进程级授权缺失（macOS TCC）：本会话语义 op 整批降级。
    pub perm_denied_is_session_wide: bool,
}

pub const WINDOWS_PROFILE: Profile = Profile {
    native_tag: "uia",
    native_label: "UIA",
    to_ad: win_ad_roles,
    from_ad: win_stream_role,
    report_role: win_stream_role,
    name_fields: &[NameField::Name],
    ax_identifier_as_class: false,
    class_name_query: false,
    value_field_reads_value: false,
    perm_denied_is_session_wide: false,
};

/// macOS：role 表按上游 AX → canonical 的精化规则反查（`crates/macos/src/tree/roles.rs`）。
/// 名字三来源、`AXIdentifier` 当 className、`read:value` 读 `AXValue`；授权缺失是进程级的，
/// 整会话降级（不是逐 op 回落）。
pub const MACOS_PROFILE: Profile = Profile {
    native_tag: "ax",
    native_label: "AX",
    to_ad: mac_ad_roles,
    from_ad: mac_stream_role,
    report_role: mac_report_role,
    name_fields: &[NameField::Name, NameField::Description, NameField::Value],
    ax_identifier_as_class: true,
    class_name_query: true,
    value_field_reads_value: true,
    perm_denied_is_session_wide: true,
};

// ── Windows 表 ─────────────────────────────────────────────────────────────

/// Stream 查询词表（UIA ControlType 名）→ agent-desktop canonical role 候选集。
/// 出处是 agent-desktop Windows 精化规则（Button 带 Toggle→switch、带 ExpandCollapse→menubutton、
/// ListItem→option、Edit→textfield、Hyperlink→link、Tab→tablist、TabItem→tab、Text→statictext、
/// DataItem→cell|row、Pane→group|dialog、Document→document|textfield…）。**两边词表差着一层，
/// 不翻译的查询整张空手而归**。None = Stream 侧本来就不认识的 role——交回 UIA 路去报它那份错。
pub fn win_ad_roles(stream_role: &str) -> Option<&'static [&'static str]> {
    Some(match stream_role {
        "Button" => &["button", "switch", "menubutton"],
        "List" => &["list", "listbox"],
        "ListItem" => &["option"],
        "Edit" => &["textfield"],
        "Text" => &["statictext"],
        "Group" => &["group"],
        "Window" => &["window"],
        "DataItem" => &["cell", "row"],
        "Tab" => &["tablist"],
        "TabItem" => &["tab"],
        "Hyperlink" => &["link"],
        // CheckBox→checkbox 是直译；Button 带 Toggle 精化成 switch 的控件（同一枚复选框在
        // agent-desktop 眼里可能是 switch）也在候选里。
        "CheckBox" => &["checkbox", "switch"],
        "ComboBox" => &["combobox"],
        "MenuItem" => &["menuitem"],
        "Document" => &["document", "textfield"],
        "Pane" => &["group", "dialog"],
        "ToolBar" => &["toolbar"],
        "Image" => &["image"],
        "TreeItem" => &["treeitem"],
        // Custom 精化只认得出 GridItem/TableItem 的 cell；裸 unknown 是"没有证据"不是身份，不匹配。
        "Custom" => &["cell"],
        _ => return None,
    })
}

/// 反向：ad role → 报给调用方的 Stream 词表 role；翻不回的原样给（由 glue 兜底）。
/// 用于回落时在 UIA 路按结构特征重新定位（`role_to_control` 必须认得这个名字）。
pub fn win_stream_role(ad_role: &str) -> Option<&'static str> {
    Some(match ad_role {
        "button" | "switch" | "menubutton" => "Button",
        "list" | "listbox" => "List",
        "option" => "ListItem",
        "textfield" => "Edit",
        "statictext" => "Text",
        "group" => "Group",
        "window" => "Window",
        "cell" | "row" => "DataItem",
        "tablist" => "Tab",
        "tab" => "TabItem",
        "link" => "Hyperlink",
        "checkbox" => "CheckBox",
        "combobox" => "ComboBox",
        "menuitem" => "MenuItem",
        "document" => "Document",
        "toolbar" => "ToolBar",
        "image" => "Image",
        "treeitem" => "TreeItem",
        "pane" => "Pane",
        _ => return None,
    })
}

// ── macOS 表 ───────────────────────────────────────────────────────────────

/// Stream 中性词 → agent-desktop macOS canonical role 候选集。
///
/// **只放上游会给 ref 的可寻址控件**：静态文本、容器、窗口这类节点上游不分配 ref
/// （skill：「Only addressable elements get refs. Static text and inert containers do not.」），
/// 委托过去只会把「这个控件存在」读成空结果。这些查询整条回落 `macos.rs`，那边照旧按
/// `AXRole` 精确匹配。
///
/// **原生 AX 名（`AX` 开头）也不经委托**：agent-desktop 的 canonical 词表对若干 AX 角色是
/// 多对一（`AXTextField` / `AXTextArea` / `AXSearchField` / `AXSecureTextField` → `textfield`，
/// `AXWindow` + `AXDialog` subrole → `dialog`），按 canonical 过滤会把查询放宽；保持
/// `macos.rs` 的精确 `AXRole` 匹配。None = 这条查询回落本平台后端。
pub fn mac_ad_roles(stream_role: &str) -> Option<&'static [&'static str]> {
    Some(match stream_role {
        "Button" => &["button"],
        "CheckBox" => &["checkbox"],
        "ComboBox" => &["combobox"],
        "DataItem" => &["cell"],
        "Edit" => &["textfield"],
        "Hyperlink" => &["link"],
        // mac 的列表行是 AXRow；outline 行在 snapshot 里按 subrole 精化成 treeitem，而
        // `macos.rs` 两者都按 AXRow 匹配——两个中性词都得能落到 row 与 treeitem 上。
        "ListItem" | "TreeItem" => &["row", "treeitem"],
        "MenuItem" => &["menuitem"],
        "RadioButton" => &["radiobutton"],
        // mac 的标签页是带 AXTabButton subrole 的 AXRadioButton（`macos.rs` 同口径）。
        "TabItem" => &["radiobutton"],
        _ => return None,
    })
}

/// 反向：canonical role → 回落重新定位用的 role 名（`MacDesktop::role_to_ax` 认得中性词，
/// `AX` 开头的原生名原样透传）。**只给回得去、且回得准的**：多对一的 canonical（textfield
/// 来自四种 AX 角色、dialog 来自 AXWindow+subrole）返回 None，重新定位退化成只按名字找，
/// 仍然要求唯一命中——不拿一个猜出来的 role 去放宽。
pub fn mac_stream_role(ad_role: &str) -> Option<&'static str> {
    Some(match ad_role {
        "button" => "Button",
        "checkbox" => "CheckBox",
        "combobox" => "ComboBox",
        "cell" => "DataItem",
        "link" => "Hyperlink",
        "menuitem" => "MenuItem",
        "radiobutton" => "RadioButton",
        "row" => "ListItem",
        "treeitem" => "TreeItem",
        _ => return None,
    })
}

/// 报给调用方的 role：canonical → 原生 AX 名（与本平台后端 `find` 的 `AXRole` 口径一致）。
/// 在多对一的 canonical 上给**代表性**的那个 AX 角色；翻不回的按 canonical 报。
pub fn mac_report_role(ad_role: &str) -> Option<&'static str> {
    Some(match ad_role {
        "button" => "AXButton",
        "checkbox" => "AXCheckBox",
        "combobox" => "AXComboBox",
        "cell" => "AXCell",
        "link" => "AXLink",
        "menuitem" => "AXMenuItem",
        "radiobutton" => "AXRadioButton",
        "row" => "AXRow",
        "treeitem" => "AXOutlineRow",
        "textfield" => "AXTextField",
        _ => return None,
    })
}

// ── 匹配 ───────────────────────────────────────────────────────────────────

impl AdNode {
    /// 按 profile 决定哪些字段算「名字」，依次给出非空的。
    pub fn name_values<'a>(&'a self, profile: &Profile) -> impl Iterator<Item = &'a str> + 'a {
        profile.name_fields.iter().filter_map(move |f| match f {
            NameField::Name => self.name.as_deref(),
            NameField::Description => self.description.as_deref(),
            NameField::Value => self.value.as_deref(),
        })
    }

    /// 报给调用方的主名字：按 profile 的优先级取第一个非空。
    pub fn primary_name(&self, profile: &Profile) -> Option<String> {
        self.name_values(profile).find(|v| !v.is_empty()).map(str::to_string)
    }
}

/// 与本平台后端同口径：role（候选集）/ name（全等、区分大小写）/ nameContains（子串、
/// 忽略大小写）/ className（只有 profile 支持时按 `native_id` 全等比）。`path` 两边都不实现
/// （本平台后端的条件同样忽略它）。
pub fn node_matches(node: &AdNode, q: &A11yQuery, profile: &Profile) -> bool {
    if let Some(role) = &q.role {
        let Some(cands) = (profile.to_ad)(role) else { return false };
        if !cands.iter().any(|c| node.role.eq_ignore_ascii_case(c)) {
            return false;
        }
    }
    if let Some(name) = &q.name {
        if !node.name_values(profile).any(|v| v == name) {
            return false;
        }
    }
    if let Some(nc) = &q.name_contains {
        let needle = nc.to_lowercase();
        if !node.name_values(profile).any(|v| v.to_lowercase().contains(&needle)) {
            return false;
        }
    }
    if let Some(cls) = &q.class_name {
        if !profile.class_name_query || node.native_id.as_deref() != Some(cls.as_str()) {
            return false;
        }
    }
    true
}

// ── 窗口映射 ────────────────────────────────────────────────────────────────

/// 在 `list-windows` 的 data（数组 `[{id, title, app_name, pid, …}]`）里认出 scope 到的那个窗口。
/// 只认 pid 唯一命中；同 pid 多窗再用标题**包含**挑出唯一一个，仍不唯一就 None——
/// 与 `resolve_window` 同一条纪律：不猜。
pub fn map_window(pid: u32, title: &str, data: &Value) -> Option<String> {
    let arr = data.as_array()?;
    let by_pid: Vec<&Value> = arr
        .iter()
        .filter(|w| w.get("pid").and_then(|p| p.as_u64()) == Some(pid as u64))
        .collect();
    let hit = match by_pid.len() {
        1 => by_pid[0],
        0 => return None,
        _ => {
            if title.is_empty() {
                return None;
            }
            let by_title: Vec<&&Value> = by_pid
                .iter()
                .filter(|w| w.get("title").and_then(|t| t.as_str()).map(|t| t.contains(title)).unwrap_or(false))
                .collect();
            let n = by_title.len();
            if n != 1 {
                return None;
            }
            by_title[0]
        }
    };
    hit.get("id").and_then(|i| i.as_str()).map(str::to_string).filter(|s| !s.is_empty())
}

// ── AdCore：CLI 会话状态（snapshot 上下文 / 窗口映射 / 回执标记）────────────

pub struct AdCore {
    profile: &'static Profile,
    cli: Option<Cli>,
    snap: Option<AdSnapshot>,
    /// scope 到的窗口映射：`（Stream 窗口 id → agent-desktop window id）`。scope/focus 一变就作废。
    mapped: Option<(String, String)>,
    /// 交给 `settle` 的一次性执行路标记。
    route: Option<(String, Option<String>)>,
    /// 本会话永久降级的原因（目前只有 macOS 的 `perm-denied`）。Some = `usable()` 恒 false。
    disabled: Option<&'static str>,
}

impl AdCore {
    /// 启动自检：定位 → `--version` → pin（主.次）。任何一步不过 = `cli` 缺席，本会话永久走
    /// 本平台后端并留一行日志——可选能力静默降级，不影响其它 op。
    pub fn open(getenv: &dyn Fn(&str) -> Option<String>, exe_dir: Option<&Path>, profile: &'static Profile) -> AdCore {
        let none = || AdCore { profile, cli: None, snap: None, mapped: None, route: None, disabled: None };
        let Some(program) = resolve_program(getenv, exe_dir) else { return none() };
        let cli = Cli::real(program);
        match cli.run_raw(&["--version"], ACTION_TIMEOUT) {
            Ok(out) => match parse_version(&out) {
                Some(v) if is_pinned(v) => AdCore { profile, cli: Some(cli), snap: None, mapped: None, route: None, disabled: None },
                Some((major, minor)) => {
                    eprintln!(
                        "[agent-desktop] 版本 {major}.{minor}.x 不在 pin（{PINNED_MAJOR}.{PINNED_MINOR}.x）——本会话走 {}",
                        profile.native_label
                    );
                    none()
                }
                None => {
                    eprintln!("[agent-desktop] --version 输出解析不出——本会话走 {}", profile.native_label);
                    none()
                }
            },
            Err(e) => {
                eprintln!("[agent-desktop] 版本自检失败（{e}）——本会话走 {}", profile.native_label);
                none()
            }
        }
    }

    #[cfg(test)]
    pub fn with_cli(cli: Cli, profile: &'static Profile) -> AdCore {
        AdCore { profile, cli: Some(cli), snap: None, mapped: None, route: None, disabled: None }
    }

    #[cfg(test)]
    pub fn absent(profile: &'static Profile) -> AdCore {
        AdCore { profile, cli: None, snap: None, mapped: None, route: None, disabled: None }
    }

    pub fn usable(&self) -> bool {
        self.cli.is_some() && self.disabled.is_none()
    }

    /// 不可用的原因：本会话已降级就是降级原因，否则是 CLI 缺席。
    pub fn unavailable_reason(&self) -> &'static str {
        self.disabled.unwrap_or("cli-unavailable")
    }

    /// scope/focus 变了：snapshot、窗口映射、ref 全作废（与 inner 的 `elements.clear()` 同口径）。
    pub fn invalidate(&mut self) {
        self.snap = None;
        self.mapped = None;
        self.route = None;
    }

    pub fn mark(&mut self, backend: &str, fallback: Option<&str>) {
        self.route = Some((backend.into(), fallback.map(str::to_string)));
    }

    /// 一次性：读走即清，只描述紧挨着的前一次动作。
    pub fn take_route(&mut self) -> Option<(String, Option<String>)> {
        self.route.take()
    }

    /// 一次动作**没走委托**时把上一枚标记作废——否则 `settle` 会把上一条 find / read 的
    /// 执行路算到这次坐标 / 键盘动作头上。回执必须描述紧挨着的那一次动作。
    pub fn clear_route(&mut self) {
        self.route = None;
    }

    /// 这个 ref 是不是 CLI 空间里的（当前 snapshot 上下文认得）。不是 = 本平台后端的 ref，照旧走 inner。
    pub fn owns_ref(&self, r: &str) -> bool {
        self.snap.as_ref().is_some_and(|s| s.contains_ref(r))
    }

    pub fn node(&self, r: &str) -> Option<AdNode> {
        self.snap.as_ref()?.node(r)
    }

    pub fn matches(&self, q: &A11yQuery) -> Vec<AdMatch> {
        self.snap.as_ref().map(|s| s.matches(q, self.profile)).unwrap_or_default()
    }

    fn run(&mut self, args: &[&str], timeout: Duration) -> Result<Envelope, AdFail> {
        if self.disabled.is_some() {
            return Err(AdFail::Fallback(self.unavailable_reason()));
        }
        let Some(cli) = &self.cli else { return Err(AdFail::Fallback("cli-unavailable")) };
        let out = match cli.run_raw(args, timeout) {
            Ok(o) => o,
            // spawn 失败 = 程序没起来 = 动作肯定没发生（可回落）；超时 / 中途失败投递状态不明。
            Err(e) => {
                return Err(match runner_fail_reason(&e) {
                    "cli-unavailable" => AdFail::Fallback("cli-unavailable"),
                    other => AdFail::Uncertain(other),
                })
            }
        };
        // 进程跑了但回执解析不了：投递状态不明（它可能已经做完了事）。
        let env = parse_envelope(&out).map_err(|_| AdFail::Uncertain("cli-failed"))?;
        if !env.ok {
            let code = env.err_code.clone().unwrap_or_default();
            // macOS 的辅助功能授权是**进程级**的：一条 PERM_DENIED 之后每条 AX 调用都会同样
            // 失败，逐 op 回落只是把一个确定的事实重复问 CLI。留一次痕，本会话整批走 AX，
            // 不弹窗、不报错（可选能力静默降级）。
            if code == "PERM_DENIED" && self.profile.perm_denied_is_session_wide {
                self.disabled = Some("perm-denied");
                self.snap = None;
                self.mapped = None;
                eprintln!(
                    "[agent-desktop] PERM_DENIED：没有「辅助功能」授权——本会话语义 op 走 {} 路（不弹窗、不报错）。去系统设置把启动它的应用打开后重启 agent。",
                    self.profile.native_label
                );
            }
            return Err(match route_for(&code) {
                AdFail::Fallback(reason) => AdFail::Fallback(reason),
                AdFail::StaleRef => AdFail::StaleRef,
                AdFail::Uncertain(reason) => AdFail::Uncertain(reason),
                AdFail::Report(_, _) => AdFail::Report(code, env.err_message.unwrap_or_default()),
            });
        }
        Ok(env)
    }

    /// 对 scope 到的窗口取 snapshot（fresh——`find` 是重新定位步骤，每次都真取）。
    pub fn refresh_snapshot(&mut self, window_id: &str) -> Result<(), AdFail> {
        let env = self.run(
            &[
                "snapshot",
                "--window-id",
                window_id,
                "-i",
                "--include-bounds",
                "--timeout-ms",
                "3000",
            ],
            SNAPSHOT_TIMEOUT,
        )?;
        self.snap = Some(parse_snapshot(&env.data).map_err(|_| AdFail::Fallback("cli-failed"))?);
        Ok(())
    }

    /// scope 窗口 → agent-desktop window id（惰性映射，scope 不变就复用）。
    pub fn ensure_window(&mut self, scope: &str, pid: u32, title: &str) -> Result<String, AdFail> {
        if let Some((s, w)) = &self.mapped {
            if s == scope {
                return Ok(w.clone());
            }
        }
        let env = self.run(&["list-windows"], ACTION_TIMEOUT)?;
        match map_window(pid, title, &env.data) {
            Some(w) => {
                self.mapped = Some((scope.into(), w.clone()));
                Ok(w)
            }
            None => Err(AdFail::Fallback("window-not-found")),
        }
    }

    /// 按 role + name 在**当前** snapshot 里重新定位（STALE_REF 重试用）。
    pub fn relocated_ref(&self, role: Option<&str>, name: Option<&str>) -> Option<String> {
        let q = A11yQuery {
            role: role.map(str::to_string),
            name: name.map(str::to_string),
            name_contains: None,
            class_name: None,
            path: None,
        };
        self.matches(&q).into_iter().next().map(|m| m.ref_id)
    }

    pub fn click(&mut self, ref_id: &str) -> Result<(), AdFail> {
        self.run(&["click", ref_id], ACTION_TIMEOUT).map(|_| ())
    }

    /// 成功 = 应用收下了（delivered_verified / delivered_unverified 都算，后者留痕）；
    /// `not_delivered` 按决策表如实上报——应用没收下，换本平台后端同样没收下。
    pub fn set_value(&mut self, ref_id: &str, text: &str) -> Result<(), AdFail> {
        let env = self.run(&["set-value", "--", ref_id, text], ACTION_TIMEOUT)?;
        if env.delivery.as_deref() == Some("not_delivered") {
            return Err(AdFail::Report(
                "ACTION_FAILED".into(),
                "set-value: 应用没把值收下（delivery=not_delivered）——退回键盘路要由调用方决定".into(),
            ));
        }
        Ok(())
    }
}

/// `readSubtree` 的行组装：`fields.read` 的 `value` 档由 profile 决定读 snapshot 的 `value`
/// 还是主名字（Windows 的 provider 只有 name 可读；mac 的 `AXValue` 才是那个值）。
pub fn read_rows(items: &[AdMatch], spec: &crate::protocol::ReadSpec, profile: &Profile) -> Vec<Map<String, Value>> {
    items
        .iter()
        .map(|item| {
            let mut row = Map::new();
            for (field, fs) in &spec.fields {
                let value = match fs.read.as_str() {
                    "name" => item.name.clone().unwrap_or_default(),
                    "value" if profile.value_field_reads_value => item
                        .value
                        .clone()
                        .filter(|v| !v.is_empty())
                        .or_else(|| item.name.clone())
                        .unwrap_or_default(),
                    // Windows / read:value：与主名字同口径（读 name——windows.rs 注释里写着 follow-up）
                    "value" => item.name.clone().unwrap_or_default(),
                    _ => String::new(),
                };
                row.insert(field.clone(), json!(value));
            }
            row
        })
        .collect()
}

// ── 委托 glue：组合任意 Desktop ────────────────────────────────────────────

pub struct AgentDesktopBackend<D: Desktop> {
    inner: D,
    core: AdCore,
    profile: &'static Profile,
}

/// 动作回落 = 用结构特征在本平台后端重新定位再执行。ad ref（`@…:eN`）对 native 前端没有意义，
/// 直接把 ref 递给 inner 只会得到 "unknown element ref"。恰好唯一命中才执行；
/// 零个或多个命中都如实报错——与 `resolve_window` 的歧义纪律同一条。
fn relocate_query(node: &AdNode, profile: &Profile) -> A11yQuery {
    A11yQuery {
        role: (profile.from_ad)(&node.role).map(str::to_string),
        name: node.primary_name(profile),
        name_contains: None,
        class_name: None,
        path: None,
    }
}

impl<D: Desktop> AgentDesktopBackend<D> {
    pub(crate) fn new(inner: D, core: AdCore, profile: &'static Profile) -> Self {
        Self { inner, core, profile }
    }

    /// 回落的公共段：标本平台后端 + 原因、留一行日志（真机的回落率统计靠它），然后执行 native 路。
    fn route_to_native(&mut self, op: &str, reason: &str, elapsed: std::time::Duration) {
        eprintln!(
            "[agent-desktop] op={op} path={} fallback={reason} elapsed={}ms",
            self.profile.native_tag,
            elapsed.as_millis()
        );
        self.core.mark(self.profile.native_tag, Some(reason));
    }

    fn native_read(&mut self, reason: &'static str, spec: &crate::protocol::ReadSpec, t0: Instant) -> Result<Vec<Map<String, Value>>, String> {
        let r = self.inner.read_subtree(spec);
        self.route_to_native("readSubtree", reason, t0.elapsed());
        r
    }

    fn scope_pid_title(&mut self, scope: &str) -> Option<(u32, String)> {
        self.inner.windows().ok()?.into_iter().find(|w| w.id == scope).map(|w| (w.pid.unwrap_or(0), w.title))
    }

    fn locked(&mut self) -> bool {
        self.inner.session_locked() == Some(true)
    }

    /// 查询本身能不能交给 CLI：`className` 只有 profile 支持时才可委托；role 必须在这张平台的
    /// 委托词表里（上游不分 ref 的角色、原生 AX 名都在这里被挡回本平台后端）。
    fn query_delegatable(&self, q: &A11yQuery) -> bool {
        if q.class_name.is_some() && !self.profile.class_name_query {
            return false;
        }
        q.role.as_deref().is_none_or(|r| (self.profile.to_ad)(r).is_some())
    }

    /// `find` 整条（gates → 窗口映射 → fresh snapshot → 本地过滤 → 转 A11yElement）。
    /// 空结果就是空结果，不回落。
    fn ad_find(&mut self, q: &A11yQuery) -> Option<Result<Vec<crate::protocol::A11yElement>, AdFail>> {
        if !self.core.usable() {
            return None;
        }
        let Some(scope) = self.inner.scope_target() else { return Some(Err(AdFail::Fallback("no-scope"))) };
        let Some((pid, title)) = self.scope_pid_title(&scope) else {
            return Some(Err(AdFail::Fallback("window-not-found")));
        };
        let wid = match self.core.ensure_window(&scope, pid, &title) {
            Ok(w) => w,
            Err(e) => return Some(Err(e)),
        };
        if let Err(e) = self.core.refresh_snapshot(&wid) {
            return Some(Err(e));
        }
        let profile = self.profile;
        let matches = self.core.matches(q);
        Some(Ok(matches
            .into_iter()
            .map(|m| crate::protocol::A11yElement {
                el_ref: m.ref_id,
                role: (profile.report_role)(&m.role).unwrap_or(&m.role).to_string(),
                name: m.name.unwrap_or_default(),
                class_name: if profile.ax_identifier_as_class { m.native_id.unwrap_or_default() } else { String::new() },
                rect: match m.bounds {
                    Some(b) => crate::protocol::Rect { x: b.x as i32, y: b.y as i32, w: b.width as i32, h: b.height as i32 },
                    None => crate::protocol::Rect { x: 0, y: 0, w: 0, h: 0 },
                },
            })
            .collect()))
    }

    fn find_via_native(&mut self, reason: &'static str, q: &A11yQuery, t0: Instant) -> Result<Vec<crate::protocol::A11yElement>, String> {
        let r = self.inner.find(q);
        self.route_to_native("find", reason, t0.elapsed());
        r
    }

    /// invoke / setValue 的回落：重新定位 + 恰一命中才执行。
    fn act_via_native(
        &mut self,
        op: &str,
        reason: &'static str,
        node: &AdNode,
        t0: Instant,
        run: impl FnOnce(&mut D, &A11yQuery, &str) -> Result<(), String>,
    ) -> Result<(), String> {
        let q = relocate_query(node, self.profile);
        let hits = self.inner.find(&q)?;
        let err = match hits.len() {
            1 => {
                self.route_to_native(op, reason, t0.elapsed());
                return run(&mut self.inner, &q, &hits[0].el_ref);
            }
            0 => format!(
                "fallback({reason}): {op} 在本平台后端重新定位 0 命中（role={}，name={}）——不改任选",
                node.role,
                node.primary_name(self.profile).unwrap_or_default()
            ),
            n => format!(
                "fallback({reason}): {op} 在本平台后端重新定位 {n} 个命中——拒绝任选（歧义纪律同 resolve_window）"
            ),
        };
        Err(err)
    }

    /// 投递未知：动作可能已经落在应用上——绝不回落、绝不重发，如实上抛给 runner 分类
    /// （`delivery-unknown`，重放引擎对它不自动重试）。标记照记：动作走的是 CLI，没有回落。
    fn delivery_unknown(reason: &str) -> String {
        format!(
            "delivery-unknown: agent-desktop {reason}（fallback=none）——动作可能已投递到目标应用，\
             先看它的实际状态再决定要不要重试，别直接重发"
        )
    }

    /// STALE_REF 重试的公共段：重取 snapshot → 按结构特征重新拿 ref。
    fn retry_after_stale(&mut self, scope: &str, pid: u32, title: &str, node: &AdNode) -> Option<String> {
        let wid = self.core.ensure_window(scope, pid, title).ok()?;
        self.core.refresh_snapshot(&wid).ok()?;
        let q = relocate_query(node, self.profile);
        self.core.relocated_ref(q.role.as_deref(), q.name.as_deref())
    }
}

impl<D: Desktop> Desktop for AgentDesktopBackend<D> {
    fn windows(&mut self) -> Result<Vec<crate::protocol::WindowInfo>, String> {
        self.inner.windows()
    }
    fn focus_window(&mut self, id: &str) -> Result<bool, String> {
        let r = self.inner.focus_window(id);
        self.core.invalidate(); // 焦点/范围一变，snapshot 与映射全作废
        r
    }
    fn scope_window(&mut self, id: &str) -> Result<(), String> {
        let r = self.inner.scope_window(id);
        self.core.invalidate();
        r
    }
    fn focus_target(&mut self) -> Option<String> {
        self.inner.focus_target()
    }
    fn scope_target(&mut self) -> Option<String> {
        self.inner.scope_target()
    }
    fn foreground_window_id(&mut self) -> Result<String, String> {
        self.inner.foreground_window_id()
    }
    fn session_locked(&mut self) -> Option<bool> {
        self.inner.session_locked()
    }

    fn find(&mut self, q: &A11yQuery) -> Result<Vec<crate::protocol::A11yElement>, String> {
        let t0 = Instant::now();
        if let Err(e) = q.validate() {
            return Err(e);
        }
        if !self.query_delegatable(q) {
            return self.find_via_native("query-unsupported", q, t0);
        }
        if self.locked() {
            return self.find_via_native("session-locked", q, t0);
        }
        match self.ad_find(q) {
            None => {
                let reason = self.core.unavailable_reason();
                self.find_via_native(reason, q, t0)
            }
            Some(Ok(els)) => {
                self.core.mark("agent-desktop", None);
                eprintln!("[agent-desktop] op=find path=agent-desktop elapsed={}ms hits={}", t0.elapsed().as_millis(), els.len());
                Ok(els)
            }
            Some(Err(AdFail::Fallback(reason))) => self.find_via_native(reason, q, t0),
            // 读 op 没有副作用：超时 / 中途失败 / 未知码照旧回落（与动作 op 的分野在 action_route）
            Some(Err(AdFail::Uncertain(reason))) => self.find_via_native(reason, q, t0),
            Some(Err(AdFail::StaleRef)) => self.find_via_native("stale-retried", q, t0),
            Some(Err(AdFail::Report(code, msg))) => Err(format!("{code}: {msg}")),
        }
    }

    fn invoke(&mut self, el_ref: &str) -> Result<(), String> {
        let t0 = Instant::now();
        // 本平台后端的 ref（find 走了回落）照旧走 inner，不标——老行为一字不动。
        if !self.core.owns_ref(el_ref) {
            self.core.clear_route();
            return self.inner.invoke(el_ref);
        }
        if self.locked() {
            let node = self.core.node(el_ref).ok_or("unknown element ref")?;
            return self.act_via_native("invoke", "session-locked", &node, t0, |d, _, r| d.invoke(r));
        }
        if !self.core.usable() {
            let node = self.core.node(el_ref).ok_or("unknown element ref")?;
            let reason = self.core.unavailable_reason();
            return self.act_via_native("invoke", reason, &node, t0, |d, _, r| d.invoke(r));
        }
        let Some(node) = self.core.node(el_ref) else { return self.inner.invoke(el_ref) };
        let Some(scope) = self.inner.scope_target() else { return Err("no-scope: invoke 之前先 scopeWindow / focusApp".into()) };
        let Some((pid, title)) = self.scope_pid_title(&scope) else { return Err("no-window-match: scope 到的窗口不在清单里（关掉了？）".into()) };
        let mut ref_id = el_ref.to_string();
        let mut retried = false;
        loop {
            let r = self.core.click(&ref_id);
            // 动作 op 的分派只走 action_route：Fallback 变体之外碰不到 inner——
            // 超时/中途失败/未知码在这里绝无第二次执行。
            match r {
                Ok(()) => {
                    self.core.mark("agent-desktop", None);
                    eprintln!("[agent-desktop] op=invoke path=agent-desktop elapsed={}ms", t0.elapsed().as_millis());
                    return Ok(());
                }
                Err(AdFail::StaleRef) if !retried => {
                    retried = true;
                    match self.retry_after_stale(&scope, pid, &title, &node) {
                        Some(next) => ref_id = next,
                        None => return self.act_via_native("invoke", "stale-retried", &node, t0, |d, _, r| d.invoke(r)),
                    }
                }
                Err(f) => match action_route(&f) {
                    ActionRoute::RetryStale => return self.act_via_native("invoke", "stale-retried", &node, t0, |d, _, r| d.invoke(r)),
                    ActionRoute::Fallback(reason) => return self.act_via_native("invoke", reason, &node, t0, |d, _, r| d.invoke(r)),
                    ActionRoute::DeliveryUnknown(reason) => {
                        eprintln!("[agent-desktop] op=invoke path=agent-desktop delivery-unknown={} elapsed={}ms", reason, t0.elapsed().as_millis());
                        return Err(Self::delivery_unknown(reason));
                    }
                    ActionRoute::Report(code, msg) => return Err(format!("{code}: {msg}")),
                },
            }
        }
    }

    fn set_value(&mut self, el_ref: &str, text: &str) -> Result<(), String> {
        let t0 = Instant::now();
        if !self.core.owns_ref(el_ref) {
            self.core.clear_route();
            return self.inner.set_value(el_ref, text);
        }
        if self.locked() {
            let node = self.core.node(el_ref).ok_or("unknown element ref")?;
            return self.act_via_native("setValue", "session-locked", &node, t0, |d, _, r| d.set_value(r, text));
        }
        if !self.core.usable() {
            let node = self.core.node(el_ref).ok_or("unknown element ref")?;
            let reason = self.core.unavailable_reason();
            return self.act_via_native("setValue", reason, &node, t0, |d, _, r| d.set_value(r, text));
        }
        let Some(node) = self.core.node(el_ref) else { return self.inner.set_value(el_ref, text) };
        let Some(scope) = self.inner.scope_target() else { return Err("no-scope: setValue 之前先 scopeWindow / focusApp".into()) };
        let Some((pid, title)) = self.scope_pid_title(&scope) else { return Err("no-window-match: scope 到的窗口不在清单里（关掉了？）".into()) };
        let mut ref_id = el_ref.to_string();
        let mut retried = false;
        loop {
            let r = self.core.set_value(&ref_id, text);
            // 动作 op 同 invoke：只走 action_route，投递未知绝不第二次执行。
            match r {
                Ok(()) => {
                    self.core.mark("agent-desktop", None);
                    eprintln!("[agent-desktop] op=setValue path=agent-desktop elapsed={}ms", t0.elapsed().as_millis());
                    return Ok(());
                }
                Err(AdFail::StaleRef) if !retried => {
                    retried = true;
                    match self.retry_after_stale(&scope, pid, &title, &node) {
                        Some(next) => ref_id = next,
                        None => return self.act_via_native("setValue", "stale-retried", &node, t0, |d, _, r| d.set_value(r, text)),
                    }
                }
                Err(f) => match action_route(&f) {
                    ActionRoute::RetryStale => return self.act_via_native("setValue", "stale-retried", &node, t0, |d, _, r| d.set_value(r, text)),
                    ActionRoute::Fallback(reason) => return self.act_via_native("setValue", reason, &node, t0, |d, _, r| d.set_value(r, text)),
                    ActionRoute::DeliveryUnknown(reason) => {
                        eprintln!("[agent-desktop] op=setValue path=agent-desktop delivery-unknown={} elapsed={}ms", reason, t0.elapsed().as_millis());
                        return Err(Self::delivery_unknown(reason));
                    }
                    ActionRoute::Report(code, msg) => return Err(format!("{code}: {msg}")),
                },
            }
        }
    }

    fn read_subtree(&mut self, spec: &crate::protocol::ReadSpec) -> Result<Vec<Map<String, Value>>, String> {
        let t0 = Instant::now();
        if !self.query_delegatable(&spec.item_query) {
            return self.native_read("query-unsupported", spec, t0);
        }
        if self.locked() {
            return self.native_read("session-locked", spec, t0);
        }
        if !self.core.usable() {
            let reason = self.core.unavailable_reason();
            return self.native_read(reason, spec, t0);
        }
        let Some(scope) = self.inner.scope_target() else { return self.native_read("no-scope", spec, t0) };
        let Some((pid, title)) = self.scope_pid_title(&scope) else { return self.native_read("window-not-found", spec, t0) };
        let Ok(wid) = self.core.ensure_window(&scope, pid, &title) else { return self.native_read("window-not-found", spec, t0) };
        match self.core.refresh_snapshot(&wid) {
            Ok(()) => {}
            Err(AdFail::Report(code, msg)) => return Err(format!("{code}: {msg}")),
            Err(AdFail::StaleRef) => return self.native_read("stale-retried", spec, t0),
            Err(AdFail::Fallback(reason)) => return self.native_read(reason, spec, t0),
            // 读 op 没有副作用：超时 / 中途失败 / 未知码照旧回落
            Err(AdFail::Uncertain(reason)) => return self.native_read(reason, spec, t0),
        }
        let items = self.core.matches(&spec.item_query);
        let rows = read_rows(&items, spec, self.profile);
        self.core.mark("agent-desktop", None);
        eprintln!("[agent-desktop] op=readSubtree path=agent-desktop elapsed={}ms rows={}", t0.elapsed().as_millis(), rows.len());
        Ok(rows)
    }

    fn backend_tag(&mut self) -> Option<(String, Option<String>)> {
        self.core.take_route()
    }

    // 以下全部原样走 inner：坐标 / 键盘 / 消息 / 视觉 / 窗口枚举 / browser / launch，
    // 以及默认方法（有平台实现的那几个必须转发，否则 Windows 的零位移叫醒与两平台的
    // OCR 信息会被 trait 的缺省实现盖掉）。type 的前台闸门语义在 dispatch 层，这里不碰。
    fn ensure_app(&mut self, spec: &crate::launch::LaunchSpec) -> Result<crate::launch::EnsureOutcome, String> {
        self.inner.ensure_app(spec)
    }
    fn browser_profiles(&mut self, spec: &crate::browser::ProfilesSpec) -> Result<crate::browser::Profiles, String> {
        self.inner.browser_profiles(spec)
    }
    fn browser_claim(&mut self, spec: &crate::browser::ClaimSpec) -> Result<crate::browser::ClaimOutcome, String> {
        self.inner.browser_claim(spec)
    }
    fn nudge_input(&mut self) -> Result<(), String> {
        self.core.clear_route();
        self.inner.nudge_input()
    }
    fn ocr_engine_info(&mut self) -> Result<crate::ocr::EngineInfo, String> {
        self.inner.ocr_engine_info()
    }
    fn click(&mut self, rect: &crate::protocol::Rect, button: &str) -> Result<(), String> {
        self.core.clear_route();
        self.inner.click(rect, button)
    }
    fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String> {
        self.core.clear_route();
        self.inner.move_mouse(x, y)
    }
    fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String> {
        self.core.clear_route();
        self.inner.scroll(dir, amount)
    }
    fn type_text(&mut self, text: &str) -> Result<(), String> {
        self.core.clear_route();
        self.inner.type_text(text)
    }
    fn press(&mut self, key: &str) -> Result<(), String> {
        self.core.clear_route();
        self.inner.press(key)
    }
    fn clear_input(&mut self) -> Result<(), String> {
        // 留键盘路（trait 无 ref 参数；语义清空 = 对找到的元素 setValue 空串）
        self.core.clear_route();
        self.inner.clear_input()
    }
    fn post_input(&mut self, hwnd: &str, input: &crate::protocol::PostedInput) -> Result<(), String> {
        self.core.clear_route();
        self.inner.post_input(hwnd, input)
    }
    fn screenshot(&mut self) -> Result<Option<crate::protocol::Screenshot>, String> {
        self.inner.screenshot()
    }
    fn find_image(&mut self, template_png: &[u8], region: Option<&crate::protocol::Rect>) -> Result<Option<(crate::protocol::Rect, f64)>, String> {
        self.inner.find_image(template_png, region)
    }
    fn read_text(&mut self, region: Option<&crate::protocol::Rect>) -> Result<crate::protocol::TextRead, String> {
        self.inner.read_text(region)
    }
    fn read_elements(&mut self, region: Option<&crate::protocol::Rect>, icons: bool, a11y: bool) -> Result<crate::protocol::ElementsRead, String> {
        // 三档共享同一次截屏，第一批整条走 inner（见 openspec design §5）
        self.inner.read_elements(region, icons, a11y)
    }
    fn url(&mut self) -> Result<String, String> {
        self.inner.url()
    }
    fn sleep(&mut self, ms: u64) -> Result<(), String> {
        self.inner.sleep(ms)
    }
}

// ── 平台接线 ────────────────────────────────────────────────────────────────

#[cfg(any(windows, target_os = "macos"))]
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

#[cfg(windows)]
mod platform_windows {
    use super::*;
    use crate::windows::WindowsDesktop;

    impl AgentDesktopBackend<WindowsDesktop> {
        pub fn windows() -> Self {
            let dir = super::exe_dir();
            let core = AdCore::open(&|k| std::env::var(k).ok(), dir.as_deref(), &WINDOWS_PROFILE);
            Self::new(WindowsDesktop::default(), core, &WINDOWS_PROFILE)
        }
    }

    impl Default for AgentDesktopBackend<WindowsDesktop> {
        fn default() -> Self {
            Self::windows()
        }
    }
}

#[cfg(target_os = "macos")]
mod platform_macos {
    use super::*;
    use crate::macos::MacDesktop;

    impl AgentDesktopBackend<MacDesktop> {
        pub fn macos() -> Self {
            let dir = super::exe_dir();
            let core = AdCore::open(&|k| std::env::var(k).ok(), dir.as_deref(), &MACOS_PROFILE);
            Self::new(MacDesktop::default(), core, &MACOS_PROFILE)
        }
    }

    impl Default for AgentDesktopBackend<MacDesktop> {
        fn default() -> Self {
            Self::macos()
        }
    }
}

// ── 测试（平台无关核心 + 委托 glue，Linux 上跑）──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{A11yElement, Desktop, ReadSpec, Rect, Screenshot, TextRead, ElementsRead, WindowInfo};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// 假 runner：按收到的 argv 回放 canned 输出；argv 全部存起来供断言。
    fn fake_cli(script: Vec<(Vec<String>, String)>) -> (Cli, Arc<Mutex<Vec<Vec<String>>>>) {
        let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let cli = Cli {
            program: PathBuf::from("fake-agent-desktop"),
            run: Box::new(move |_program, args, _timeout| {
                calls2.lock().unwrap().push(args.to_vec());
                for (pat, out) in &script {
                    if pat.len() == args.len() && pat.iter().zip(args).all(|(p, a)| a == p) {
                        return Ok(out.clone());
                    }
                }
                Err("cli-failed: 没有匹配的脚本行".into())
            }),
        };
        (cli, calls)
    }

    fn snapshot_envelope() -> String {
        // envelope 2.6 形状：data.tree = AccessibilityNode，data.snapshot_id；
        // role 用 agent-desktop 的 canonical 小写词表，refs 是快照限定的 @<snapshot_id>:eN。
        json!({
            "version": "2.6", "ok": true, "command": "snapshot",
            "data": {
                "snapshot_id": "s8f3k2p9",
                "tree": { "role": "window", "name": "Telegram", "children": [
                    { "role": "group", "name": "chat list", "ref_id": "@s8f3k2p9:e5", "children": [
                        { "ref_id": "@s8f3k2p9:e1", "role": "option", "name": "频道, 夸克云盘影视资源频道, 已静音, 1908 个新消息",
                          "bounds": {"x": 100.0, "y": 200.5, "width": 300.0, "height": 40.0} },
                        { "ref_id": "@s8f3k2p9:e2", "role": "option", "name": "朋友", "bounds": {"x": 100, "y": 250, "width": 300, "height": 40} }
                    ]},
                    { "ref_id": "@s8f3k2p9:e3", "role": "textfield", "name": "Message", "value": "hello",
                      "native_id": {"kind": "ax_identifier", "value": "compose"}, "bounds": {"x": 100, "y": 700, "width": 900, "height": 30} },
                    { "ref_id": "@s8f3k2p9:e4", "role": "button", "name": "Send",
                      "description": "发送消息", "native_id": {"kind": "ax_identifier", "value": "send-btn"},
                      "bounds": {"x": 1050, "y": 700, "width": 60, "height": 30} },
                    { "role": "statictext", "name": "没有 ref 的节点不进结果" }
                ]}
            }
        }).to_string()
    }

    fn windows_envelope() -> String {
        json!({"version": "2.6", "ok": true, "command": "list-windows", "data": [
            {"id": "w-ad-1", "title": "Telegram (A)", "app_name": "telegram", "pid": 111},
            {"id": "w-ad-2", "title": "Telegram (B)", "app_name": "telegram", "pid": 111},
            {"id": "w-ad-3", "title": "记事本", "app_name": "notepad", "pid": 222}
        ]}).to_string()
    }

    fn error_envelope(code: &str, delivery: &str) -> String {
        json!({
            "version": "2.6", "ok": false, "command": "set-value",
            "error": {"code": code, "message": "boom", "disposition": {"delivery": delivery, "retry": "safe"}}
        }).to_string()
    }

    fn ok_envelope(command: &str, data: Value) -> String {
        json!({"version": "2.6", "ok": true, "command": command, "data": data}).to_string()
    }

    fn query(role: Option<&str>, name: Option<&str>, nc: Option<&str>) -> A11yQuery {
        A11yQuery { role: role.map(str::to_string), name: name.map(str::to_string), name_contains: nc.map(str::to_string), class_name: None, path: None }
    }

    /// 假本平台后端：记录被调到的 op；`find` 回一条固定命中，供回落的「唯一命中」通过。
    struct FakeDesktop {
        calls: Arc<Mutex<Vec<String>>>,
        scope: Option<String>,
        hits: Vec<A11yElement>,
    }

    impl FakeDesktop {
        fn new() -> (Self, Arc<Mutex<Vec<String>>>) {
            let calls = Arc::new(Mutex::new(Vec::new()));
            (
                FakeDesktop { calls: calls.clone(), scope: Some("900".into()), hits: Vec::new() },
                calls,
            )
        }

        fn with_hit() -> (Self, Arc<Mutex<Vec<String>>>) {
            let (mut d, calls) = Self::new();
            d.hits = vec![A11yElement {
                el_ref: "el-1".into(),
                role: "AXButton".into(),
                name: "Send".into(),
                class_name: String::new(),
                rect: Rect { x: 1, y: 2, w: 3, h: 4 },
            }];
            (d, calls)
        }

        fn record(&self, s: &str) {
            self.calls.lock().unwrap().push(s.to_string());
        }
    }

    impl Desktop for FakeDesktop {
        fn windows(&mut self) -> Result<Vec<WindowInfo>, String> {
            Ok(vec![WindowInfo { id: "900".into(), process: "Telegram".into(), title: "Telegram (A)".into(), pid: Some(111), ..Default::default() }])
        }
        fn focus_window(&mut self, _: &str) -> Result<bool, String> { Ok(true) }
        fn scope_window(&mut self, id: &str) -> Result<(), String> { self.scope = Some(id.to_string()); Ok(()) }
        fn focus_target(&mut self) -> Option<String> { None }
        fn scope_target(&mut self) -> Option<String> { self.scope.clone() }
        fn foreground_window_id(&mut self) -> Result<String, String> { Ok("other".into()) }
        fn find(&mut self, _: &A11yQuery) -> Result<Vec<A11yElement>, String> {
            self.record("find");
            Ok(self.hits.clone())
        }
        fn invoke(&mut self, _: &str) -> Result<(), String> { self.record("invoke"); Ok(()) }
        fn set_value(&mut self, _: &str, _: &str) -> Result<(), String> { self.record("setValue"); Ok(()) }
        fn click(&mut self, _: &Rect, _: &str) -> Result<(), String> { self.record("click"); Ok(()) }
        fn move_mouse(&mut self, _: i32, _: i32) -> Result<(), String> { Ok(()) }
        fn scroll(&mut self, _: &str, _: i32) -> Result<(), String> { Ok(()) }
        fn type_text(&mut self, _: &str) -> Result<(), String> { Ok(()) }
        fn press(&mut self, _: &str) -> Result<(), String> { Ok(()) }
        fn clear_input(&mut self) -> Result<(), String> { Ok(()) }
        fn read_subtree(&mut self, _: &ReadSpec) -> Result<Vec<Map<String, Value>>, String> {
            self.record("readSubtree");
            Ok(Vec::new())
        }
        fn nudge_input(&mut self) -> Result<(), String> { self.record("nudge"); Ok(()) }
        fn ocr_engine_info(&mut self) -> Result<crate::ocr::EngineInfo, String> {
            self.record("ocr");
            Ok(crate::ocr::EngineInfo {
                name: "fake",
                version: "0".into(),
                threads: 1,
                lib: PathBuf::from("/fake/lib"),
            })
        }
        fn screenshot(&mut self) -> Result<Option<Screenshot>, String> { Ok(None) }
        fn find_image(&mut self, _: &[u8], _: Option<&Rect>) -> Result<Option<(Rect, f64)>, String> { Ok(None) }
        fn read_text(&mut self, _: Option<&Rect>) -> Result<TextRead, String> {
            Ok(TextRead { texts: Vec::new(), window: Rect { x: 0, y: 0, w: 0, h: 0 }, scale: 1.0 })
        }
        fn read_elements(&mut self, _: Option<&Rect>, _: bool, _: bool) -> Result<ElementsRead, String> {
            Ok(ElementsRead { elements: Vec::new(), window: Rect { x: 0, y: 0, w: 0, h: 0 }, scale: 1.0 })
        }
        fn url(&mut self) -> Result<String, String> { Ok("app:test/Telegram (A)".into()) }
        fn sleep(&mut self, _: u64) -> Result<(), String> { Ok(()) }
    }

    fn backend_with(inner: FakeDesktop, cli: Option<Cli>, profile: &'static Profile) -> AgentDesktopBackend<FakeDesktop> {
        let core = match cli {
            Some(c) => AdCore::with_cli(c, profile),
            None => AdCore::absent(profile),
        };
        AgentDesktopBackend::new(inner, core, profile)
    }

    fn find_script() -> Vec<(Vec<String>, String)> {
        vec![
            (vec!["list-windows".into()], windows_envelope()),
            (
                vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()],
                snapshot_envelope(),
            ),
        ]
    }

    #[test]
    fn version_pin_matches_only_the_pinned_minor() {
        assert_eq!(parse_version("agent-desktop 1.2.0"), Some((1, 2)));
        assert!(is_pinned(parse_version("agent-desktop 1.2.7").unwrap()));
        assert!(!is_pinned(parse_version("agent-desktop 1.3.0").unwrap()), "minor 越过 pin 要拒");
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn resolve_program_prefers_the_env_override_and_honors_the_kill_switch() {
        let dir = std::env::temp_dir();
        let no_env = |_: &str| -> Option<String> { None };
        let kill = |k: &str| (k == ENV_KILL_SWITCH).then(|| "uia".to_string());
        let neutral = |k: &str| (k == ENV_KILL_SWITCH).then(|| "native".to_string());
        // 开关整批回旧路：exe 同目录真有二进制也不用（这一步在 temp_dir 上找不到真二进制，
        // 两层断言都成立——找不到=None）。
        assert_eq!(resolve_program(&kill, Some(&dir)), None);
        assert_eq!(resolve_program(&neutral, Some(&dir)), None, "平台中性的开关值同样整批关闭委托");
        // 缺席 = None（可选能力静默缺席）
        assert_eq!(resolve_program(&no_env, Some(&std::path::Path::new("/nonexistent-agent-desktop"))), None);
    }

    #[test]
    fn every_refused_code_routes_where_the_table_says() {
        assert_eq!(route_for("AMBIGUOUS_TARGET"), AdFail::Fallback("ambiguous-target"));
        assert_eq!(route_for("POLICY_DENIED"), AdFail::Fallback("policy-denied"));
        assert_eq!(route_for("PERM_DENIED"), AdFail::Fallback("perm-denied"));
        assert_eq!(route_for("WINDOW_NOT_FOUND"), AdFail::Fallback("window-not-found"));
        assert_eq!(route_for("SNAPSHOT_NOT_FOUND"), AdFail::Fallback("window-not-found"));
        assert_eq!(route_for("APP_NOT_FOUND"), AdFail::Fallback("window-not-found"));
        assert_eq!(route_for("ACTION_NOT_SUPPORTED"), AdFail::Fallback("action-not-supported"));
        // 超时/未知码投递状态不明：动作 op 绝不回落（见 action_route），读 op 照旧回落
        assert_eq!(route_for("TIMEOUT"), AdFail::Uncertain("timeout"));
        assert_eq!(route_for("INTERNAL"), AdFail::Uncertain("cli-error"));
        assert_eq!(route_for("STALE_REF"), AdFail::StaleRef);
        // 这两个绝不回落：空结果与"应用没收下"换路也一样
        assert!(matches!(route_for("ELEMENT_NOT_FOUND"), AdFail::Report(..)));
        assert!(matches!(route_for("ACTION_FAILED"), AdFail::Report(..)));
    }

    #[test]
    fn action_route_never_falls_back_on_uncertain_delivery() {
        // 动作 op 的分派表：回落只允许"确定没动过应用"的失败
        assert_eq!(action_route(&AdFail::Fallback("ambiguous-target")), ActionRoute::Fallback("ambiguous-target"));
        assert_eq!(action_route(&AdFail::Fallback("cli-unavailable")), ActionRoute::Fallback("cli-unavailable"));
        assert_eq!(action_route(&AdFail::StaleRef), ActionRoute::RetryStale);
        assert_eq!(action_route(&AdFail::Uncertain("timeout")), ActionRoute::DeliveryUnknown("timeout"));
        assert_eq!(action_route(&AdFail::Uncertain("cli-failed")), ActionRoute::DeliveryUnknown("cli-failed"));
        assert_eq!(action_route(&AdFail::Uncertain("cli-error")), ActionRoute::DeliveryUnknown("cli-error"));
        assert!(matches!(action_route(&AdFail::Report("X".into(), "y".into())), ActionRoute::Report(..)));
    }

    #[test]
    fn runner_failures_split_spawn_from_midway() {
        // spawn 失败 = 程序没起来 = 动作肯定没发生 → 可回落；其余投递状态不明
        assert_eq!(runner_fail_reason("cli-unavailable: spawn x: 2 (No such file)"), "cli-unavailable");
        assert_eq!(runner_fail_reason("timeout: agent-desktop 进程超时被强杀"), "timeout");
        assert_eq!(runner_fail_reason("cli-failed: wait: ..."), "cli-failed");
    }

    /// 恒定失败的 runner：模拟进程层错误（spawn 失败 / 超时 / 中途崩溃）。
    fn failing_cli(err: &'static str) -> Cli {
        Cli { program: PathBuf::from("fake-agent-desktop"), run: Box::new(move |_p, _a, _t| Err(err.to_string())) }
    }

    #[test]
    fn spawn_failure_falls_back_but_timeout_stays_uncertain() {
        // 程序没起来 = 动作肯定没发生 → 可回落
        let mut core = AdCore::with_cli(failing_cli("cli-unavailable: spawn ad: No such file"), &WINDOWS_PROFILE);
        assert_eq!(core.click("@s1:e1"), Err(AdFail::Fallback("cli-unavailable")));
        // 超时 / 中途失败：投递状态不明，动作 op 绝不回落
        let mut core = AdCore::with_cli(failing_cli("timeout: agent-desktop 进程超时被强杀"), &WINDOWS_PROFILE);
        assert_eq!(core.click("@s1:e1"), Err(AdFail::Uncertain("timeout")));
        let mut core = AdCore::with_cli(failing_cli("cli-failed: wait: interrupted"), &WINDOWS_PROFILE);
        assert_eq!(core.click("@s1:e1"), Err(AdFail::Uncertain("cli-failed")));
    }

    #[test]
    fn envelope_parses_success_error_and_delivery_from_both_slots() {
        let ok = parse_envelope(&snapshot_envelope()).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.command, "snapshot");
        let err = parse_envelope(&error_envelope("STALE_REF", "not_delivered")).unwrap();
        assert!(!err.ok);
        assert_eq!(err.err_code.as_deref(), Some("STALE_REF"));
        assert_eq!(err.delivery.as_deref(), Some("not_delivered"));
        // 成功路的 disposition 在 data 里（value_write 的回读结论）
        let ok_delivery = parse_envelope(&ok_envelope("set-value", json!({"disposition": {"delivery": "delivered_verified"}}))).unwrap();
        assert_eq!(ok_delivery.delivery.as_deref(), Some("delivered_verified"));
        assert!(parse_envelope("not json at all").is_err());
    }

    #[test]
    fn snapshot_find_keeps_every_query_semantic() {
        let snap = parse_snapshot(&parse_envelope(&snapshot_envelope()).unwrap().data).unwrap();
        // name 全等、区分大小写
        assert_eq!(snap.matches(&query(Some("Button"), Some("Send"), None), &WINDOWS_PROFILE).len(), 1);
        assert_eq!(snap.matches(&query(Some("Button"), Some("send"), None), &WINDOWS_PROFILE).len(), 0, "全等区分大小写");
        // nameContains：子串、忽略大小写——动态长名的列表项靠它
        assert_eq!(snap.matches(&query(Some("ListItem"), Some("夸克"), None), &WINDOWS_PROFILE).len(), 0, "Stream 词表的 ListItem 翻成 option");
        let hits = snap.matches(&query(Some("ListItem"), None, Some("夸克云盘")), &WINDOWS_PROFILE);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].ref_id, "@s8f3k2p9:e1");
        // role 候选集：Edit → textfield；Pane → group|dialog
        assert_eq!(snap.matches(&query(Some("Edit"), Some("Message"), None), &WINDOWS_PROFILE).len(), 1);
        assert_eq!(snap.matches(&query(Some("Pane"), Some("chat list"), None), &WINDOWS_PROFILE).len(), 1);
        // ref 缺席的节点不进结果
        assert_eq!(snap.matches(&query(None, Some("没有 ref 的节点不进结果"), None), &WINDOWS_PROFILE).len(), 0);
        // 根节点本身不算命中（Descendants 口径）
        assert_eq!(snap.matches(&query(Some("Window"), Some("Telegram"), None), &WINDOWS_PROFILE).len(), 0);
    }

    #[test]
    fn maps_the_scoped_window_by_pid_then_title() {
        let data = parse_envelope(&windows_envelope()).unwrap().data;
        // pid 唯一命中
        assert_eq!(map_window(222, "记事本", &data).as_deref(), Some("w-ad-3"));
        // 同 pid 两窗：标题包含挑出唯一一个
        assert_eq!(map_window(111, "Telegram (B)", &data).as_deref(), Some("w-ad-2"));
        // 同 pid、标题不够分：不猜
        assert_eq!(map_window(111, "Telegram", &data), None);
        assert_eq!(map_window(999, "x", &data), None);
    }

    #[test]
    fn open_degrades_silently_when_version_or_binary_is_missing() {
        // 找不到二进制 = 可选能力静默缺席
        let core = AdCore::open(&|k| (k == ENV_BIN_PATH).then(|| "/nonexistent-agent-desktop/ad".to_string()), None, &WINDOWS_PROFILE);
        assert!(!core.usable());
    }

    #[test]
    fn snapshot_find_click_and_set_value_round_trip_through_the_cli() {
        let (cli, calls) = fake_cli(vec![
            (vec!["list-windows".into()], windows_envelope()),
            (vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()], snapshot_envelope()),
            (vec!["click".into(), "@s8f3k2p9:e4".into()], ok_envelope("click", json!({"disposition": {"delivery": "delivered_verified"}}))),
            (
                vec!["set-value".into(), "--".into(), "@s8f3k2p9:e3".into(), "hello".into()],
                ok_envelope("set-value", json!({"disposition": {"delivery": "delivered_unverified"}})),
            ),
        ]);
        let mut core = AdCore::with_cli(cli, &WINDOWS_PROFILE);
        assert!(core.usable());
        let wid = core.ensure_window("900", 111, "Telegram (A)").unwrap();
        assert_eq!(wid, "w-ad-1");
        core.refresh_snapshot(&wid).unwrap();
        assert_eq!(core.matches(&query(Some("Button"), Some("Send"), None)).len(), 1);
        assert!(core.owns_ref("@s8f3k2p9:e4"));
        assert!(!core.owns_ref("el-7"), "UIA ref 空间不属于这里");
        core.click("@s8f3k2p9:e4").unwrap();
        core.set_value("@s8f3k2p9:e3", "hello").unwrap();
        // 窗口映射只问一次 list-windows：scope 不变就复用
        assert_eq!(core.ensure_window("900", 111, "Telegram (A)").unwrap(), "w-ad-1");
        assert_eq!(calls.lock().unwrap().len(), 4);
    }

    #[test]
    fn not_delivered_reports_instead_of_faking_success() {
        let (cli, _calls) = fake_cli(vec![(
            vec!["set-value".into(), "--".into(), "@s1:e1".into(), "x".into()],
            ok_envelope("set-value", json!({"disposition": {"delivery": "not_delivered"}})),
        )]);
        let mut core = AdCore::with_cli(cli, &WINDOWS_PROFILE);
        let err = core.set_value("@s1:e1", "x").unwrap_err();
        assert!(matches!(err, AdFail::Report(..)), "应用没收下要如实报，不许谎报成功");
    }

    #[test]
    fn stale_ref_and_refusals_route_through_the_table_on_actions() {
        let (cli, _) = fake_cli(vec![
            (vec!["click".into(), "@s1:e1".into()], error_envelope("STALE_REF", "not_delivered")),
            (vec!["click".into(), "@s1:e2".into()], error_envelope("AMBIGUOUS_TARGET", "not_delivered")),
        ]);
        let mut core = AdCore::with_cli(cli, &WINDOWS_PROFILE);
        assert_eq!(core.click("@s1:e1"), Err(AdFail::StaleRef));
        assert_eq!(core.click("@s1:e2"), Err(AdFail::Fallback("ambiguous-target")));
    }

    #[test]
    fn snapshot_timeout_maps_to_the_timeout_fallback_reason() {
        let (cli, _) = fake_cli(vec![]); // 空脚本 = 进程层失败
        let mut core = AdCore::with_cli(cli, &WINDOWS_PROFILE);
        // 读 op 的回落决策在 glue（find 对 Uncertain 照旧回落）；核心层只保证映射正确
        let err = core.refresh_snapshot("w1").unwrap_err();
        assert_eq!(err, AdFail::Uncertain("cli-failed"));
    }

    #[test]
    fn role_tables_round_trip_for_the_hot_semantic_loop() {
        for (stream, ad) in [
            ("Button", "button"), ("ListItem", "option"), ("Edit", "textfield"),
            ("Hyperlink", "link"), ("CheckBox", "checkbox"), ("TabItem", "tab"),
        ] {
            assert!(win_ad_roles(stream).unwrap().contains(&ad), "{stream} 必须认得 {ad}");
        }
        assert_eq!(win_stream_role("option"), Some("ListItem"));
        assert_eq!(win_stream_role("textfield"), Some("Edit"));
        assert_eq!(win_stream_role("unknown"), None, "翻不回的原样给，不给假 role");
    }

    #[test]
    fn read_rows_mirror_the_uia_field_semantics() {
        use crate::protocol::FieldSpec;
        let spec = crate::protocol::ReadSpec {
            item_query: query(None, None, None),
            fields: [
                ("title".to_string(), FieldSpec { from: None, read: "name".to_string() }),
                ("value_field".to_string(), FieldSpec { from: None, read: "value".to_string() }),
            ].into_iter().collect(),
            dedupe_by: "title".to_string(),
        };
        let items = vec![AdMatch {
            ref_id: "@s1:e1".into(),
            role: "option".into(),
            name: Some("第一行".into()),
            value: Some("值".into()),
            native_id: None,
            bounds: None,
        }];
        let rows = read_rows(&items, &spec, &WINDOWS_PROFILE);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], json!("第一行"));
        // value 档与 windows.rs 同口径（读 name，follow-up）
        assert_eq!(rows[0]["value_field"], json!("第一行"));
    }

    // ── macOS：role 表 / 多名字来源 / className / read:value ─────────────────────

    #[test]
    fn mac_roles_cover_the_addressable_controls_and_nothing_else() {
        for (stream, ad) in [
            ("Button", "button"),
            ("CheckBox", "checkbox"),
            ("ComboBox", "combobox"),
            ("DataItem", "cell"),
            ("Edit", "textfield"),
            ("Hyperlink", "link"),
            ("ListItem", "row"),
            ("ListItem", "treeitem"),
            ("MenuItem", "menuitem"),
            ("RadioButton", "radiobutton"),
            ("TabItem", "radiobutton"),
            ("TreeItem", "row"),
        ] {
            assert!(mac_ad_roles(stream).unwrap().contains(&ad), "{stream} 必须认得 {ad}");
        }
        // 上游不给静态文本 / 容器 / 窗口分配 ref——委托只会把「存在」读成空结果。
        for inert in ["Text", "Group", "Pane", "Window", "List", "Tab", "ToolBar", "Image", "Document", "Custom"] {
            assert_eq!(mac_ad_roles(inert), None, "{inert} 不该经委托（回落 AX 路）");
        }
        // 原生 AX 名不经委托：canonical 词表对它们是 多对一，按 canonical 过滤会放宽查询。
        for native in ["AXButton", "AXTextField", "AXRow", "AXWindow", "AXSheet"] {
            assert_eq!(mac_ad_roles(native), None, "{native} 保持 macos.rs 的精确 AXRole 匹配");
        }
    }

    #[test]
    fn mac_reverse_tables_only_claim_what_they_can_locate() {
        assert_eq!(mac_stream_role("button"), Some("Button"));
        assert_eq!(mac_stream_role("row"), Some("ListItem"));
        assert_eq!(mac_stream_role("treeitem"), Some("TreeItem"));
        assert_eq!(mac_stream_role("radiobutton"), Some("RadioButton"));
        // 多对一的不猜（textfield 来自四种 AX 角色）：重新定位退化成只按名字，仍要求唯一命中
        assert_eq!(mac_stream_role("textfield"), None);
        assert_eq!(mac_stream_role("dialog"), None);
        // 报给调用方的 role 是原生 AX 名，与 macos.rs 的 AXRole 口径一致
        assert_eq!(mac_report_role("button"), Some("AXButton"));
        assert_eq!(mac_report_role("textfield"), Some("AXTextField"));
        assert_eq!(mac_report_role("treeitem"), Some("AXOutlineRow"));
        assert_eq!(mac_report_role("unknown"), None);
    }

    #[test]
    fn mac_name_queries_see_title_description_and_value() {
        let snap = parse_snapshot(&parse_envelope(&snapshot_envelope()).unwrap().data).unwrap();
        // 「发送消息」只在 AXDescription 里；首页来源只读 name 的窗口路找不到它
        assert_eq!(snap.matches(&query(Some("Button"), Some("发送消息"), None), &MACOS_PROFILE).len(), 1);
        assert_eq!(snap.matches(&query(Some("Button"), Some("发送消息"), None), &WINDOWS_PROFILE).len(), 0);
        // AXValue 也算一个名字来源（输入框的当前值）
        assert_eq!(snap.matches(&query(Some("Edit"), Some("hello"), None), &MACOS_PROFILE).len(), 1);
        // 主名字仍按 名字 → 描述 → 值 的优先级
        let hit = &snap.matches(&query(Some("Button"), Some("Send"), None), &MACOS_PROFILE)[0];
        assert_eq!(hit.name.as_deref(), Some("Send"));
        // 上游不分配 ref 的静态文本即使命中也不进结果（与 UIA 路"每个命中都有句柄"同口径）
        assert_eq!(snap.matches(&query(None, Some("没有 ref 的节点不进结果"), None), &MACOS_PROFILE).len(), 0);
    }

    #[test]
    fn mac_class_name_query_uses_the_ax_identifier() {
        let snap = parse_snapshot(&parse_envelope(&snapshot_envelope()).unwrap().data).unwrap();
        let mut q = query(Some("Button"), None, None);
        q.class_name = Some("send-btn".into());
        let hits = snap.matches(&q, &MACOS_PROFILE);
        assert_eq!(hits.len(), 1, "AXIdentifier 是 mac 的 className");
        assert_eq!(hits[0].native_id.as_deref(), Some("send-btn"));
        // Windows 的 snapshot 没有这个字段：同样的查询在那边不可委托（由 glue 整条回落）
        assert_eq!(snap.matches(&q, &WINDOWS_PROFILE).len(), 0);
    }

    #[test]
    fn mac_read_value_uses_ax_value_and_falls_back_to_the_name() {
        use crate::protocol::FieldSpec;
        let spec = crate::protocol::ReadSpec {
            item_query: query(None, None, None),
            fields: [("value_field".to_string(), FieldSpec { from: None, read: "value".to_string() })].into_iter().collect(),
            dedupe_by: "value_field".to_string(),
        };
        let items = vec![
            AdMatch {
                ref_id: "@s1:e1".into(),
                role: "textfield".into(),
                name: Some("Message".into()),
                value: Some("hello".into()),
                native_id: None,
                bounds: None,
            },
            AdMatch {
                ref_id: "@s1:e2".into(),
                role: "button".into(),
                name: Some("Send".into()),
                value: None,
                native_id: None,
                bounds: None,
            },
        ];
        let mac = read_rows(&items, &spec, &MACOS_PROFILE);
        assert_eq!(mac[0]["value_field"], json!("hello"));
        assert_eq!(mac[1]["value_field"], json!("Send"), "没有 AXValue 就退回主名字");
        let win = read_rows(&items, &spec, &WINDOWS_PROFILE);
        assert_eq!(win[0]["value_field"], json!("Message"), "Windows 的口径不变（读 name）");
    }

    // ── 委托 glue：真走假 Desktop ────────────────────────────────────────────

    #[test]
    fn mac_find_delegates_and_reports_native_ax_roles() {
        let (cli, _calls) = fake_cli(find_script());
        let (inner, inner_calls) = FakeDesktop::new();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        let els = backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert_eq!(els.len(), 1);
        assert_eq!(els[0].role, "AXButton", "报给调用方的是原生 AX 名");
        assert_eq!(els[0].class_name, "send-btn", "AXIdentifier 落 className");
        assert!(inner_calls.lock().unwrap().is_empty(), "委托成功时不碰本平台后端");
        assert_eq!(backend.backend_tag(), Some(("agent-desktop".into(), None)));
    }

    #[test]
    fn mac_unsupported_queries_fall_back_to_the_ax_backend() {
        let (cli, calls) = fake_cli(find_script());
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        // 原生 AX 名（精确 AXRole 匹配留在 macos.rs）
        backend.find(&query(Some("AXRow"), None, None)).unwrap();
        // 上游不分 ref 的静态文本
        backend.find(&query(Some("Text"), None, None)).unwrap();
        // className 查询在 mac 可委托；但 role 不认识的整条回落
        assert_eq!(inner_calls.lock().unwrap().as_slice(), ["find", "find"]);
        assert_eq!(calls.lock().unwrap().len(), 0, "两条都不该起 CLI 进程");
        assert_eq!(backend.backend_tag(), Some(("ax".into(), Some("query-unsupported".into()))));
    }

    #[test]
    fn mac_class_name_query_is_delegated_instead_of_falling_back() {
        let (cli, _calls) = fake_cli(find_script());
        let (inner, inner_calls) = FakeDesktop::new();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        let mut q = query(Some("Button"), None, None);
        q.class_name = Some("send-btn".into());
        let els = backend.find(&q).unwrap();
        assert_eq!(els.len(), 1);
        assert!(inner_calls.lock().unwrap().is_empty());
        assert_eq!(backend.backend_tag(), Some(("agent-desktop".into(), None)));
    }

    #[test]
    fn mac_permission_denied_degrades_the_whole_session_once() {
        let (cli, calls) = fake_cli(vec![
            (vec!["list-windows".into()], windows_envelope()),
            (
                vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()],
                error_envelope("PERM_DENIED", "not_delivered"),
            ),
        ]);
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        // 第一次：CLI 报 PERM_DENIED，本 op 回落 AX 并留痕；本会话从此不碰 CLI
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert_eq!(backend.backend_tag(), Some(("ax".into(), Some("perm-denied".into()))));
        let after_first = calls.lock().unwrap().len();
        // 第二次：不再起 CLI 进程（list-windows 都不会再问），原因码仍是 perm-denied
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert_eq!(calls.lock().unwrap().len(), after_first, "授权缺失后本会话不该再起 CLI");
        assert_eq!(backend.backend_tag(), Some(("ax".into(), Some("perm-denied".into()))));
        assert_eq!(inner_calls.lock().unwrap().as_slice(), ["find", "find"]);
    }

    #[test]
    fn windows_permission_denied_stays_a_per_op_fallback() {
        // Windows 的 PERM_DENIED 是 UIPI（某个管理员窗口），不是进程级授权缺失：
        // 逐 op 回落，下一次 op 仍该问 CLI。
        let (cli, calls) = fake_cli(vec![
            (vec!["list-windows".into()], windows_envelope()),
            (
                vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()],
                error_envelope("PERM_DENIED", "not_delivered"),
            ),
        ]);
        let (inner, _inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &WINDOWS_PROFILE);
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert_eq!(backend.backend_tag(), Some(("uia".into(), Some("perm-denied".into()))));
        let after_first = calls.lock().unwrap().len();
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert!(calls.lock().unwrap().len() > after_first, "Windows 不整会话降级");
    }

    #[test]
    fn action_fallback_relocates_by_structure_and_requires_one_hit() {
        // find 走委托拿到 ad ref，invoke 被 CLI 以 POLICY_DENIED 拒 → AX 路按 role+name 重新定位。
        let (cli, _) = fake_cli(vec![
            (vec!["list-windows".into()], windows_envelope()),
            (
                vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()],
                snapshot_envelope(),
            ),
            (vec!["click".into(), "@s8f3k2p9:e4".into()], error_envelope("POLICY_DENIED", "not_delivered")),
        ]);
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        backend.invoke("@s8f3k2p9:e4").unwrap();
        assert_eq!(backend.backend_tag(), Some(("ax".into(), Some("policy-denied".into()))));
        let calls = inner_calls.lock().unwrap().clone();
        assert!(calls.contains(&"invoke".to_string()), "唯一命中必须真的执行动作");
    }

    #[test]
    fn action_fallback_refuses_ambiguous_relocation() {
        let (cli, _) = fake_cli(vec![
            (vec!["list-windows".into()], windows_envelope()),
            (
                vec!["snapshot".into(), "--window-id".into(), "w-ad-1".into(), "-i".into(), "--include-bounds".into(), "--timeout-ms".into(), "3000".into()],
                snapshot_envelope(),
            ),
            (vec!["click".into(), "@s8f3k2p9:e4".into()], error_envelope("AMBIGUOUS_TARGET", "not_delivered")),
        ]);
        let (mut inner, _calls) = FakeDesktop::new();
        // 两个同结构命中：拒绝任选
        inner.hits = vec![
            A11yElement { el_ref: "el-1".into(), role: "AXButton".into(), name: "Send".into(), class_name: String::new(), rect: Rect { x: 0, y: 0, w: 0, h: 0 } },
            A11yElement { el_ref: "el-2".into(), role: "AXButton".into(), name: "Send".into(), class_name: String::new(), rect: Rect { x: 0, y: 0, w: 0, h: 0 } },
        ];
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        let err = backend.invoke("@s8f3k2p9:e4").unwrap_err();
        assert!(err.contains("拒绝任选"), "歧义必须响亮：{err}");
    }

    #[test]
    fn native_actions_do_not_inherit_a_previous_find_route() {
        // 回执的 backend/fallback 只描述紧挨着的那次动作：find 走委托留下的标记不能被后面的
        // AX 动作或坐标动作捡走（否则回落率统计会凭空多出一批）。
        let (cli, _) = fake_cli(find_script());
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &MACOS_PROFILE);
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        backend.invoke("el-1").unwrap(); // 本平台后端的 ref：不走委托
        assert_eq!(backend.backend_tag(), None, "invoke 走 AX 时不该带上一条 find 的标记");
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        backend.click(&Rect { x: 1, y: 2, w: 3, h: 4 }, "left").unwrap();
        assert_eq!(backend.backend_tag(), None, "坐标动作同样不带标记");
        assert!(inner_calls.lock().unwrap().contains(&"invoke".to_string()));
    }

    #[test]
    fn windows_class_name_query_falls_back_to_uia() {
        // Windows 的 snapshot 没有 className 字段：带它的查询整条回落，不拿 name 去凑。
        let (cli, calls) = fake_cli(find_script());
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, Some(cli), &WINDOWS_PROFILE);
        let mut q = query(Some("Button"), None, None);
        q.class_name = Some("send-btn".into());
        backend.find(&q).unwrap();
        assert_eq!(inner_calls.lock().unwrap().as_slice(), ["find"]);
        assert_eq!(calls.lock().unwrap().len(), 0);
        assert_eq!(backend.backend_tag(), Some(("uia".into(), Some("query-unsupported".into()))));
    }

    #[test]
    fn default_methods_forward_to_the_inner_backend() {
        // 委托层不能把平台后端的默认方法吃掉（Windows 的零位移叫醒、两平台的 OCR 信息）。
        let (inner, inner_calls) = FakeDesktop::new();
        let mut backend = backend_with(inner, None, &WINDOWS_PROFILE);
        backend.nudge_input().unwrap();
        let info = backend.ocr_engine_info().unwrap();
        assert_eq!(info.name, "fake");
        assert_eq!(inner_calls.lock().unwrap().as_slice(), ["nudge", "ocr"]);
    }

    #[test]
    fn cli_absent_reports_the_degradation_reason() {
        let (inner, inner_calls) = FakeDesktop::with_hit();
        let mut backend = backend_with(inner, None, &MACOS_PROFILE);
        backend.find(&query(Some("Button"), Some("Send"), None)).unwrap();
        assert_eq!(backend.backend_tag(), Some(("ax".into(), Some("cli-unavailable".into()))));
        assert_eq!(inner_calls.lock().unwrap().as_slice(), ["find"]);
    }
}

#[cfg(test)]
mod smoke {
    use super::*;

    /// 真 CLI 冒烟（`cargo test -- --ignored`，要有 agent-desktop 二进制 + AT-SPI/会话）：
    /// `--version` 解析得出 pin、`status` 回 envelope 且 ok。只验进程层与 envelope 形状，
    /// 不做任何读树/动作——那要真桌面，归各平台真机清单。
    #[test]
    #[ignore = "真机冒烟：设 STREAM_AGENT_DESKTOP_PATH 后 cargo test -- --ignored"]
    fn real_cli_answers_version_and_status() {
        let program = std::env::var(ENV_BIN_PATH).map(PathBuf::from).expect("设 STREAM_AGENT_DESKTOP_PATH 指向真二进制");
        let cli = Cli::real(program);
        let version = cli.run_raw(&["--version"], ACTION_TIMEOUT).expect("--version 要能跑");
        assert!(is_pinned(parse_version(&version).expect("版本要解析得出")), "版本在 pin 之内");
        let status = cli.run_raw(&["status"], ACTION_TIMEOUT).expect("status 要能跑");
        assert!(parse_envelope(&status).expect("status 回 envelope").ok);
    }
}
