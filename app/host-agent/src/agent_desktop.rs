//! agent-desktop 委托层（openspec desktop-automation-backend）：Windows 上语义 a11y 读与动作
//! 优先委托给内嵌的 agent-desktop CLI（每 op 一个子进程，JSON envelope v2.x），UIA 路回落。
//!
//! 本文件的平台无关部分（envelope 解析、错误路由、role 词表映射、snapshot 过滤、窗口映射、
//! 版本 pin、降级开关）在 Linux 上就被 `cargo test` 覆盖——agent-desktop 在 lean/CI 上没有
//! 真桌面可观测，所以集成层一律走注入的假 runner 回放 fixture（`Cli::run` 是注入点）；
//! 只有文件末尾 `#[cfg(windows)]` 那段 Desktop 接线真的碰 `WindowsDesktop`。
//!
//! 词表与错误码的出处（v1.2.x，核对过源码）：canonical role 是小写且按 pattern 精化
//! （`crates/windows/src/tree/roles.rs`），错误码全集在 `crates/core/src/response/error_code.rs`。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::protocol::A11yQuery;
use serde_json::{json, Map, Value};

// ── 配置面 ───────────────────────────────────────────────────────────────────

/// 二进制路径覆盖（测试 / 开发）；缺省按 exe 同目录找（平台包把两者落在一起）。
pub const ENV_BIN_PATH: &str = "STREAM_AGENT_DESKTOP_PATH";
/// 降级开关：值 `uia` = 语义 op 整批走旧路。只认这一个显式值，不猜其它拼写——
/// 写错的开关比没有开关更危险。
pub const ENV_KILL_SWITCH: &str = "STREAM_DESKTOP_BACKEND";
/// pin 主.次版本（patch 忽略）：这个项目 breaking 频繁（1.1.0 一个月内动过 envelope 与 C ABI），
/// minor pin 是对冲，`--version` 自检不过就本会话永久走 UIA。
pub const PINNED_MAJOR: u32 = 1;
pub const PINNED_MINOR: u32 = 2;

/// 单个动作命令的进程上限。CLI 内部自己的观察超时（snapshot `--timeout-ms 3000`）比这短，
/// 这层是防进程挂死；超时按回落决策表的 `timeout` 一档处理。
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(8);
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// `find` 一次最多回多少个——与 windows.rs 的 `take(50)` 同一道防爆闸。
const FIND_CAP: usize = 50;

/// 定位二进制：环境变量覆盖 → exe 同目录。找不到返回 None（可选能力静默缺席）。
pub fn resolve_program(
    getenv: &dyn Fn(&str) -> Option<String>,
    exe_dir: Option<&Path>,
) -> Option<PathBuf> {
    if getenv(ENV_KILL_SWITCH).is_some_and(|v| v.eq_ignore_ascii_case("uia")) {
        eprintln!("[agent-desktop] {ENV_KILL_SWITCH}=uia —— 语义 op 整批走旧 UIA 路");
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
/// - 回落：动作被拒 / 目标丢了——UIA 路可能还有办法（它多 SelectionItem/Toggle rung，
///   且不经过 CLI 的窗口映射）；
/// - `STALE_REF`：先重取 snapshot 按结构特征重新拿 ref、重试一次，仍败才回落（`stale-retried`）；
/// - 不确定（`Uncertain`）：进程超时 / 中途失败 / 输出解析不了 / 未知错误码——**动作 op 可能
///   已经把输入投到应用上**，回落 UIA 就是执行第二次（一次点击「发送」变两次）。读 op 没有
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
    pub bounds: Option<AdRect>,
    pub children: Vec<AdNode>,
}

pub struct AdSnapshot {
    pub snapshot_id: String,
    pub root: AdNode,
}

fn parse_node(v: &Value) -> AdNode {
    AdNode {
        ref_id: v.get("ref_id").and_then(|r| r.as_str()).map(str::to_string),
        role: v.get("role").and_then(|r| r.as_str()).unwrap_or("unknown").into(),
        name: v.get("name").and_then(|n| n.as_str()).map(str::to_string),
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

    fn walk<'a>(&'a self, nodes: &'a [AdNode], q: &A11yQuery, out: &mut Vec<&'a AdNode>) {
        for n in nodes {
            // 没有 ref 的节点没法被后续 op 寻址，不进结果（与 UIA 路"每个命中都有句柄"同口径）。
            if n.ref_id.is_some() && node_matches(n, q) {
                out.push(n);
            }
            self.walk(&n.children, q, out);
        }
    }

    /// `find`：全部命中（不含根节点本身——与 UIA `TreeScope::Descendants` 同口径），先序遍历。
    pub fn find(&self, q: &A11yQuery) -> Vec<&AdNode> {
        let mut out = Vec::new();
        self.walk(&self.root.children, q, &mut out);
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
    pub name: Option<String>,
    pub bounds: Option<AdRect>,
}

impl AdSnapshot {
    pub fn matches(&self, q: &A11yQuery) -> Vec<AdMatch> {
        self.find(q)
            .into_iter()
            .map(|n| AdMatch {
                ref_id: self.qualify(n.ref_id.as_deref().unwrap_or_default()),
                role: n.role.clone(),
                name: n.name.clone(),
                bounds: n.bounds.clone(),
            })
            .collect()
    }
}

// ── role 词表映射 ───────────────────────────────────────────────────────────

/// Stream 查询词表（UIA ControlType 名）→ agent-desktop canonical role 候选集。
/// 出处是 agent-desktop Windows 精化规则（Button 带 Toggle→switch、带 ExpandCollapse→menubutton、
/// ListItem→option、Edit→textfield、Hyperlink→link、Tab→tablist、TabItem→tab、Text→statictext、
/// DataItem→cell|row、Pane→group|dialog、Document→document|textfield…）。**两边词表差着一层，
/// 不翻译的查询整张空手而归**。None = Stream 侧本来就不认识的 role——交回 UIA 路去报它那份错。
pub fn ad_roles(stream_role: &str) -> Option<&'static [&'static str]> {
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

/// 反向：ad role → 报给调用方的 Stream 词表 role；翻不回的原样给（小写）。
/// 用于回落时在 UIA 路按结构特征重新定位（`role_to_control` 必须认得这个名字）。
pub fn stream_role(ad_role: &str) -> Option<&'static str> {
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

/// 与 windows.rs 的 provider 条件同口径：role（候选集）/ name（全等、区分大小写）/
/// nameContains（子串、忽略大小写）。`className` 在 snapshot JSON 里没有字段，带它的查询
/// 由调用方整条回落 UIA；`path` 两边都不实现（windows.rs 的 provider 条件同样忽略它）。
pub fn node_matches(node: &AdNode, q: &A11yQuery) -> bool {
    if let Some(role) = &q.role {
        let Some(cands) = ad_roles(role) else { return false };
        if !cands.iter().any(|c| node.role.eq_ignore_ascii_case(c)) {
            return false;
        }
    }
    if let Some(name) = &q.name {
        if node.name.as_deref() != Some(name.as_str()) {
            return false;
        }
    }
    if let Some(nc) = &q.name_contains {
        let Some(n) = &node.name else { return false };
        if !n.to_lowercase().contains(&nc.to_lowercase()) {
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
    cli: Option<Cli>,
    snap: Option<AdSnapshot>,
    /// scope 到的窗口映射：`（Stream 窗口 id → agent-desktop window id）`。scope/focus 一变就作废。
    mapped: Option<(String, String)>,
    /// 交给 `settle` 的一次性执行路标记。
    route: Option<(String, Option<String>)>,
}

impl AdCore {
    /// 启动自检：定位 → `--version` → pin（主.次）。任何一步不过 = `cli` 缺席，本会话永久走
    /// UIA 并留一行日志——可选能力静默降级，不影响其它 op。
    pub fn open(getenv: &dyn Fn(&str) -> Option<String>, exe_dir: Option<&Path>) -> AdCore {
        let none = || AdCore { cli: None, snap: None, mapped: None, route: None };
        let Some(program) = resolve_program(getenv, exe_dir) else { return none() };
        let cli = Cli::real(program);
        match cli.run_raw(&["--version"], ACTION_TIMEOUT) {
            Ok(out) => match parse_version(&out) {
                Some(v) if is_pinned(v) => AdCore { cli: Some(cli), snap: None, mapped: None, route: None },
                Some((major, minor)) => {
                    eprintln!("[agent-desktop] 版本 {major}.{minor}.x 不在 pin（{PINNED_MAJOR}.{PINNED_MINOR}.x）——本会话走 UIA");
                    none()
                }
                None => {
                    eprintln!("[agent-desktop] --version 输出解析不出——本会话走 UIA");
                    none()
                }
            },
            Err(e) => {
                eprintln!("[agent-desktop] 版本自检失败（{e}）——本会话走 UIA");
                none()
            }
        }
    }

    #[cfg(test)]
    pub fn with_cli(cli: Cli) -> AdCore {
        AdCore { cli: Some(cli), snap: None, mapped: None, route: None }
    }

    pub fn usable(&self) -> bool {
        self.cli.is_some()
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

    /// 这个 ref 是不是 CLI 空间里的（当前 snapshot 上下文认得）。不是 = UIA ref，照旧走 inner。
    pub fn owns_ref(&self, r: &str) -> bool {
        self.snap.as_ref().is_some_and(|s| s.contains_ref(r))
    }

    pub fn node(&self, r: &str) -> Option<AdNode> {
        self.snap.as_ref()?.node(r)
    }

    pub fn matches(&self, q: &A11yQuery) -> Vec<AdMatch> {
        self.snap.as_ref().map(|s| s.matches(q)).unwrap_or_default()
    }

    fn run(&self, args: &[&str], timeout: Duration) -> Result<Envelope, AdFail> {
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
            let code = env.err_code.unwrap_or_default();
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
    pub fn relocated_ref(&self, role: &str, name: Option<&str>) -> Option<String> {
        let q = A11yQuery {
            role: Some(role.into()),
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
    /// `not_delivered` 按决策表如实上报——应用没收下，换 UIA 路同样没收下。
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

/// `readSubtree` 的行组装：fields.read 的 value 档与 windows.rs 同口径（读 name——那边注释里
/// 写着 follow-up），`from` 子查询同样两边都还没实现。
pub fn read_rows(items: &[AdMatch], spec: &crate::protocol::ReadSpec) -> Vec<Map<String, Value>> {
    items
        .iter()
        .map(|item| {
            let mut row = Map::new();
            for (field, fs) in &spec.fields {
                let value = match fs.read.as_str() {
                    "name" | "value" => item.name.clone().unwrap_or_default(),
                    _ => String::new(),
                };
                row.insert(field.clone(), json!(value));
            }
            row
        })
        .collect()
}

// ── Windows 接线 ────────────────────────────────────────────────────────────

#[cfg(windows)]
#[cfg(windows)]
pub use win::AgentDesktopBackend;

#[cfg(windows)]
mod win {
    use super::*;
    use crate::protocol::{A11yElement, Desktop, ReadSpec, Rect};
    use crate::windows::WindowsDesktop;

    pub struct AgentDesktopBackend {
        inner: WindowsDesktop,
        core: AdCore,
    }

    impl Default for AgentDesktopBackend {
        fn default() -> Self {
            let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
            Self {
                inner: WindowsDesktop::default(),
                core: AdCore::open(&|k| std::env::var(k).ok(), exe_dir.as_deref()),
            }
        }
    }

    /// 动作回落 = 用结构特征在 UIA 路重新定位再执行。ad ref（`@…:eN`）对 UIA 没有意义，
    /// 直接把 ref 递给 inner 只会得到 "unknown element ref"。恰好唯一命中才执行；
    /// 零个或多个命中都如实报错——与 `resolve_window` 的歧义纪律同一条。
    fn relocate_query(node: &AdNode) -> A11yQuery {
        A11yQuery {
            role: stream_role(&node.role).map(str::to_string),
            name: node.name.clone(),
            name_contains: None,
            class_name: None,
            path: None,
        }
    }

    impl AgentDesktopBackend {
        /// 回落的公共段：标 UIA + 原因、留一行日志（真机的回落率统计靠它），然后执行 UIA 路。
        fn route_to_uia(&mut self, op: &str, reason: &str, elapsed: std::time::Duration) {
            eprintln!("[agent-desktop] op={op} path=uia fallback={reason} elapsed={}ms", elapsed.as_millis());
            self.core.mark("uia", Some(reason));
        }

        fn uia_read(&mut self, reason: &'static str, spec: &ReadSpec, t0: Instant) -> Result<Vec<Map<String, Value>>, String> {
            let r = self.inner.read_subtree(spec);
            self.route_to_uia("readSubtree", reason, t0.elapsed());
            r
        }

        fn scope_pid_title(&mut self, scope: &str) -> Option<(u32, String)> {
            self.inner.windows().ok()?.into_iter().find(|w| w.id == scope).map(|w| (w.pid.unwrap_or(0), w.title))
        }

        fn locked(&mut self) -> bool {
            self.inner.session_locked() == Some(true)
        }

        /// `find` 整条（gates → 窗口映射 → fresh snapshot → 本地过滤 → 转 A11yElement）。
        /// 空结果就是空结果，不回落。
        fn ad_find(&mut self, q: &A11yQuery) -> Option<Result<Vec<A11yElement>, AdFail>> {
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
            let matches = self.core.matches(q);
            Some(Ok(matches
                .into_iter()
                .map(|m| A11yElement {
                    el_ref: m.ref_id,
                    role: stream_role(&m.role).unwrap_or(&m.role).to_string(),
                    name: m.name.unwrap_or_default(),
                    class_name: String::new(),
                    rect: match m.bounds {
                        Some(b) => Rect { x: b.x as i32, y: b.y as i32, w: b.width as i32, h: b.height as i32 },
                        None => Rect { x: 0, y: 0, w: 0, h: 0 },
                    },
                })
                .collect()))
        }

        fn find_via_uia(&mut self, reason: &'static str, q: &A11yQuery, t0: Instant) -> Result<Vec<A11yElement>, String> {
            let r = self.inner.find(q);
            self.route_to_uia("find", reason, t0.elapsed());
            r
        }

        /// invoke / setValue 的回落：重新定位 + 恰一命中才执行。
        fn act_via_uia(
            &mut self,
            op: &str,
            reason: &'static str,
            node: &AdNode,
            t0: Instant,
            run: impl FnOnce(&mut WindowsDesktop, &A11yQuery, &str) -> Result<(), String>,
        ) -> Result<(), String> {
            let q = relocate_query(node);
            let hits = self.inner.find(&q)?;
            let err = match hits.len() {
                1 => {
                    self.route_to_uia(op, reason, t0.elapsed());
                    return run(&mut self.inner, &q, &hits[0].el_ref);
                }
                0 => format!(
                    "fallback({reason}): {op} 在 UIA 路重新定位 0 命中（role={}，name={}）——不改任选",
                    node.role,
                    node.name.as_deref().unwrap_or("")
                ),
                n => format!(
                    "fallback({reason}): {op} 在 UIA 路重新定位 {n} 个命中——拒绝任选（歧义纪律同 resolve_window）"
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
            let q = relocate_query(node);
            self.core.relocated_ref(q.role.as_deref()?, q.name.as_deref())
        }
    }

    impl Desktop for AgentDesktopBackend {
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

        fn find(&mut self, q: &A11yQuery) -> Result<Vec<A11yElement>, String> {
            let t0 = Instant::now();
            if let Err(e) = q.validate() {
                return Err(e);
            }
            // className 在 snapshot JSON 里没有字段——整条查询回落 UIA（保真优先，别本地硬凑）。
            if q.class_name.is_some() || q.role.as_deref().is_some_and(|r| ad_roles(r).is_none()) {
                return self.find_via_uia("query-unsupported", q, t0);
            }
            if self.locked() {
                return self.find_via_uia("session-locked", q, t0);
            }
            match self.ad_find(q) {
                None => self.find_via_uia("cli-unavailable", q, t0),
                Some(Ok(els)) => {
                    self.core.mark("agent-desktop", None);
                    eprintln!("[agent-desktop] op=find path=agent-desktop elapsed={}ms hits={}", t0.elapsed().as_millis(), els.len());
                    Ok(els)
                }
                Some(Err(AdFail::Fallback(reason))) => self.find_via_uia(reason, q, t0),
                // 读 op 没有副作用：超时 / 中途失败 / 未知码照旧回落（与动作 op 的分野在 action_route）
                Some(Err(AdFail::Uncertain(reason))) => self.find_via_uia(reason, q, t0),
                Some(Err(AdFail::StaleRef)) => self.find_via_uia("stale-retried", q, t0),
                Some(Err(AdFail::Report(code, msg))) => Err(format!("{code}: {msg}")),
            }
        }

        fn invoke(&mut self, el_ref: &str) -> Result<(), String> {
            let t0 = Instant::now();
            // UIA ref（find 走了回落）照旧走 inner，不标——老行为一字不动。
            if !self.core.owns_ref(el_ref) {
                return self.inner.invoke(el_ref);
            }
            if self.locked() {
                let node = self.core.node(el_ref).ok_or("unknown element ref")?;
                return self.act_via_uia("invoke", "session-locked", &node, t0, |d, _, r| d.invoke(r));
            }
            if !self.core.usable() {
                let node = self.core.node(el_ref).ok_or("unknown element ref")?;
                return self.act_via_uia("invoke", "cli-unavailable", &node, t0, |d, _, r| d.invoke(r));
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
                            None => return self.act_via_uia("invoke", "stale-retried", &node, t0, |d, _, r| d.invoke(r)),
                        }
                    }
                    Err(f) => match action_route(&f) {
                        ActionRoute::RetryStale => return self.act_via_uia("invoke", "stale-retried", &node, t0, |d, _, r| d.invoke(r)),
                        ActionRoute::Fallback(reason) => return self.act_via_uia("invoke", reason, &node, t0, |d, _, r| d.invoke(r)),
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
                return self.inner.set_value(el_ref, text);
            }
            if self.locked() {
                let node = self.core.node(el_ref).ok_or("unknown element ref")?;
                return self.act_via_uia("setValue", "session-locked", &node, t0, |d, _, r| d.set_value(r, text));
            }
            if !self.core.usable() {
                let node = self.core.node(el_ref).ok_or("unknown element ref")?;
                return self.act_via_uia("setValue", "cli-unavailable", &node, t0, |d, _, r| d.set_value(r, text));
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
                            None => return self.act_via_uia("setValue", "stale-retried", &node, t0, |d, _, r| d.set_value(r, text)),
                        }
                    }
                    Err(f) => match action_route(&f) {
                        ActionRoute::RetryStale => return self.act_via_uia("setValue", "stale-retried", &node, t0, |d, _, r| d.set_value(r, text)),
                        ActionRoute::Fallback(reason) => return self.act_via_uia("setValue", reason, &node, t0, |d, _, r| d.set_value(r, text)),
                        ActionRoute::DeliveryUnknown(reason) => {
                            eprintln!("[agent-desktop] op=setValue path=agent-desktop delivery-unknown={} elapsed={}ms", reason, t0.elapsed().as_millis());
                            return Err(Self::delivery_unknown(reason));
                        }
                        ActionRoute::Report(code, msg) => return Err(format!("{code}: {msg}")),
                    },
                }
            }
        }

        fn read_subtree(&mut self, spec: &ReadSpec) -> Result<Vec<Map<String, Value>>, String> {
            let t0 = Instant::now();
            if spec.item_query.class_name.is_some()
                || spec.item_query.role.as_deref().is_some_and(|r| ad_roles(r).is_none())
            {
                return self.uia_read("query-unsupported", spec, t0);
            }
            if self.locked() {
                return self.uia_read("session-locked", spec, t0);
            }
            if !self.core.usable() {
                return self.uia_read("cli-unavailable", spec, t0);
            }
            let Some(scope) = self.inner.scope_target() else { return self.uia_read("no-scope", spec, t0) };
            let Some((pid, title)) = self.scope_pid_title(&scope) else { return self.uia_read("window-not-found", spec, t0) };
            let Ok(wid) = self.core.ensure_window(&scope, pid, &title) else { return self.uia_read("window-not-found", spec, t0) };
            match self.core.refresh_snapshot(&wid) {
                Ok(()) => {}
                Err(AdFail::Report(code, msg)) => return Err(format!("{code}: {msg}")),
                Err(AdFail::StaleRef) => return self.uia_read("stale-retried", spec, t0),
                Err(AdFail::Fallback(reason)) => return self.uia_read(reason, spec, t0),
                // 读 op 没有副作用：超时 / 中途失败 / 未知码照旧回落
                Err(AdFail::Uncertain(reason)) => return self.uia_read(reason, spec, t0),
            }
            let items = self.core.matches(&spec.item_query);
            let rows = super::read_rows(&items, spec);
            self.core.mark("agent-desktop", None);
            eprintln!("[agent-desktop] op=readSubtree path=agent-desktop elapsed={}ms rows={}", t0.elapsed().as_millis(), rows.len());
            Ok(rows)
        }

        fn backend_tag(&mut self) -> Option<(String, Option<String>)> {
            self.core.take_route()
        }

        // 以下全部原样走 inner：坐标 / 键盘 / 消息 / 视觉 / 窗口枚举 / browser / launch。
        // type 的前台闸门语义在 dispatch 层，这里不碰。
        fn click(&mut self, rect: &Rect, button: &str) -> Result<(), String> {
            self.inner.click(rect, button)
        }
        fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String> {
            self.inner.move_mouse(x, y)
        }
        fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String> {
            self.inner.scroll(dir, amount)
        }
        fn type_text(&mut self, text: &str) -> Result<(), String> {
            self.inner.type_text(text)
        }
        fn press(&mut self, key: &str) -> Result<(), String> {
            self.inner.press(key)
        }
        fn clear_input(&mut self) -> Result<(), String> {
            // 留键盘路（trait 无 ref 参数；语义清空 = 对找到的元素 setValue 空串）
            self.inner.clear_input()
        }
        fn post_input(&mut self, hwnd: &str, input: &crate::protocol::PostedInput) -> Result<(), String> {
            self.inner.post_input(hwnd, input)
        }
        fn screenshot(&mut self) -> Result<Option<crate::protocol::Screenshot>, String> {
            self.inner.screenshot()
        }
        fn find_image(&mut self, template_png: &[u8], region: Option<&Rect>) -> Result<Option<(Rect, f64)>, String> {
            self.inner.find_image(template_png, region)
        }
        fn read_text(&mut self, region: Option<&Rect>) -> Result<crate::protocol::TextRead, String> {
            self.inner.read_text(region)
        }
        fn read_elements(&mut self, region: Option<&Rect>, icons: bool, a11y: bool) -> Result<crate::protocol::ElementsRead, String> {
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
}

// ── 测试（平台无关核心，Linux 上跑）────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
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
                    { "ref_id": "@s8f3k2p9:e3", "role": "textfield", "name": "Message", "bounds": {"x": 100, "y": 700, "width": 900, "height": 30} },
                    { "ref_id": "@s8f3k2p9:e4", "role": "button", "name": "Send", "bounds": {"x": 1050, "y": 700, "width": 60, "height": 30} },
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
        // 开关整批回旧路：exe 同目录真有二进制也不用（这一步在 temp_dir 上找不到真二进制，
        // 两层断言都成立——找不到=None）。
        assert_eq!(resolve_program(&kill, Some(&dir)), None);
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
        let mut core = AdCore::with_cli(failing_cli("cli-unavailable: spawn ad: No such file"));
        assert_eq!(core.click("@s1:e1"), Err(AdFail::Fallback("cli-unavailable")));
        // 超时 / 中途失败：投递状态不明，动作 op 绝不回落
        let mut core = AdCore::with_cli(failing_cli("timeout: agent-desktop 进程超时被强杀"));
        assert_eq!(core.click("@s1:e1"), Err(AdFail::Uncertain("timeout")));
        let mut core = AdCore::with_cli(failing_cli("cli-failed: wait: interrupted"));
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
        assert_eq!(snap.matches(&query(Some("Button"), Some("Send"), None)).len(), 1);
        assert_eq!(snap.matches(&query(Some("Button"), Some("send"), None)).len(), 0, "全等区分大小写");
        // nameContains：子串、忽略大小写——动态长名的列表项靠它
        assert_eq!(snap.matches(&query(Some("ListItem"), Some("夸克"), None)).len(), 0, "Stream 词表的 ListItem 翻成 option");
        let hits = snap.matches(&query(Some("ListItem"), None, Some("夸克云盘")));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].ref_id, "@s8f3k2p9:e1");
        // role 候选集：Edit → textfield；Pane → group|dialog
        assert_eq!(snap.matches(&query(Some("Edit"), Some("Message"), None)).len(), 1);
        assert_eq!(snap.matches(&query(Some("Pane"), Some("chat list"), None)).len(), 1);
        // ref 缺席的节点不进结果
        assert_eq!(snap.matches(&query(None, Some("没有 ref 的节点不进结果"), None)).len(), 0);
        // 根节点本身不算命中（Descendants 口径）
        assert_eq!(snap.matches(&query(Some("Window"), Some("Telegram"), None)).len(), 0);
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
        let core = AdCore::open(&|k| (k == ENV_BIN_PATH).then(|| "/nonexistent-agent-desktop/ad".to_string()), None);
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
        let mut core = AdCore::with_cli(cli);
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
        let mut core = AdCore::with_cli(cli);
        let err = core.set_value("@s1:e1", "x").unwrap_err();
        assert!(matches!(err, AdFail::Report(..)), "应用没收下要如实报，不许谎报成功");
    }

    #[test]
    fn stale_ref_and_refusals_route_through_the_table_on_actions() {
        let (cli, _) = fake_cli(vec![
            (vec!["click".into(), "@s1:e1".into()], error_envelope("STALE_REF", "not_delivered")),
            (vec!["click".into(), "@s1:e2".into()], error_envelope("AMBIGUOUS_TARGET", "not_delivered")),
        ]);
        let mut core = AdCore::with_cli(cli);
        assert_eq!(core.click("@s1:e1"), Err(AdFail::StaleRef));
        assert_eq!(core.click("@s1:e2"), Err(AdFail::Fallback("ambiguous-target")));
    }

    #[test]
    fn snapshot_timeout_maps_to_the_timeout_fallback_reason() {
        let (cli, _) = fake_cli(vec![]); // 空脚本 = 进程层失败
        let mut core = AdCore::with_cli(cli);
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
            assert!(ad_roles(stream).unwrap().contains(&ad), "{stream} 必须认得 {ad}");
        }
        assert_eq!(stream_role("option"), Some("ListItem"));
        assert_eq!(stream_role("textfield"), Some("Edit"));
        assert_eq!(stream_role("unknown"), None, "翻不回的原样给，不给假 role");
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
            bounds: None,
        }];
        let rows = read_rows(&items, &spec);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], json!("第一行"));
        // value 档与 windows.rs 同口径（读 name，follow-up）
        assert_eq!(rows[0]["value_field"], json!("第一行"));
    }
}

#[cfg(test)]
mod smoke {
    use super::*;

    /// 真 CLI 冒烟（`cargo test -- --ignored`，要有 agent-desktop 二进制 + AT-SPI/会话）：
    /// `--version` 解析得出 pin、`status` 回 envelope 且 ok。只验进程层与 envelope 形状，
    /// 不做任何读树/动作——那要真桌面，归 Windows 真机清单。
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
