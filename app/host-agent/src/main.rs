//! Stream host-desktop Engine agent.
//!
//! A thin sidecar that connects to the backend's `/api/host` WebSocket and executes the
//! host-desktop Engine ops (a11y locate/read + input) on THIS machine. The backend holds all
//! recipe logic; this agent is a pure executor (mirrors the ext-cdp extension). The op flow was
//! proven live via the PowerShell stand-in (`tg_verify.ps1`) — this is that flow in Rust.
//!
//! 它还兼一份**第二职业**（`--native-messaging`，见 `nativemsg.rs`）：被 Chrome 用 stdio 拉起，
//! 把本机 `data/ext-relay-token` 交给我们那个扩展。两件事共用同一个可执行文件，因为它们要的
//! 是同一样东西——"这是本用户机器上的一个本地进程"这件事本身。
//!
//! Env:
//!   STREAM_HOST_URL    ws URL of the relay (default ws://127.0.0.1:8900/api/host — the backend
//!                      binds this itself; there is no proxy)
//!   STREAM_HOST_TOKEN  the shared relay token (same secret as /api/ext). **可以不给**——缺了就
//!                      从 data 目录自己读（见 `datadir.rs`）。
//!   STREAM_DATA_DIR    Stream 的 data 目录；不给就靠 config.yaml / 可执行文件位置推。

mod datadir;
mod glide;
mod launch;
#[cfg(target_os = "macos")]
mod macos;
mod nativemsg;
mod ocr;
mod ocr_bench;
mod overlay;
#[cfg(target_os = "macos")]
mod overlay_mac;
#[cfg(windows)]
mod overlay_win;
mod procs;
mod protocol;
mod register;
mod relay;
mod see;
mod see_detect;
#[cfg(windows)]
mod windows;

use futures_util::{SinkExt, StreamExt};
use relay::{SessionEnd, Supervisor};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const PROTOCOL: &str = "host-relay.v1";

/// 指示条渲染层的句柄类型。**两个平台同一个名字**，所以 `run_session` / `supervise` 的签名
/// 不用套 `#[cfg]`——签名分叉是漏改的温床。
#[cfg(windows)]
type OverlayHandleLike = overlay_win::OverlayHandle;
#[cfg(target_os = "macos")]
type OverlayHandleLike = overlay_mac::OverlayHandle;
/// 其余平台没有渲染层。用一个**不可构造**的类型占位：`Option` 永远是 `None`，
/// 所有调用点都被优化掉，而调用处的代码一行都不用变。
#[cfg(all(not(windows), not(target_os = "macos")))]
pub enum OverlayHandleLike {}
#[cfg(all(not(windows), not(target_os = "macos")))]
impl OverlayHandleLike {
    pub fn send(&self, _cmd: overlay::OverlayCmd) {}
    pub fn hotkey_pressed(&self) -> bool {
        false
    }
}

/// The active Desktop backend for this OS.
///
/// **三档，不是两档**：Windows（UIA）、macOS（AX）、其余（占位）。分档写在这一处，
/// 别让 `NotSupported` 继续挂在 `not(windows)` 上——那样 mac 会同时匹配到两个 `type Backend`。
/// 提示那一层（`OverlayHandleLike`）也是三档（Windows / mac 各有渲染层，其余占位），
/// 但它和后端分档是两件独立的事，别并到一起。
#[cfg(windows)]
type Backend = windows::WindowsDesktop;
#[cfg(target_os = "macos")]
type Backend = macos::MacDesktop;
#[cfg(all(not(windows), not(target_os = "macos")))]
type Backend = NotSupported;

/// 既没有 UIA 也没有 AX 的那些平台（Linux 的 AT-SPI 后端以后按自己的 cfg 插进来）。
/// 每个 op 都报错——**装得上、一动就报错**是这里唯一诚实的形状。
#[cfg(all(not(windows), not(target_os = "macos")))]
#[derive(Default)]
struct NotSupported;
#[cfg(all(not(windows), not(target_os = "macos")))]
impl protocol::Desktop for NotSupported {
    fn windows(&mut self) -> Result<Vec<protocol::WindowInfo>, String> { Err(unsupported()) }
    fn scope_window(&mut self, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn focus_window(&mut self, _: &str) -> Result<bool, String> { Err(unsupported()) }
    fn focus_target(&mut self) -> Option<String> { None }
    fn scope_target(&mut self) -> Option<String> { None }
    fn foreground_window_id(&mut self) -> Result<String, String> { Err(unsupported()) }
    fn find(&mut self, _: &protocol::A11yQuery) -> Result<Vec<protocol::A11yElement>, String> { Err(unsupported()) }
    fn invoke(&mut self, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn set_value(&mut self, _: &str, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn click(&mut self, _: &protocol::Rect, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn move_mouse(&mut self, _: i32, _: i32) -> Result<(), String> { Err(unsupported()) }
    fn scroll(&mut self, _: &str, _: i32) -> Result<(), String> { Err(unsupported()) }
    fn type_text(&mut self, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn press(&mut self, _: &str) -> Result<(), String> { Err(unsupported()) }
    fn clear_input(&mut self) -> Result<(), String> { Err(unsupported()) }
    fn read_subtree(&mut self, _: &protocol::ReadSpec) -> Result<Vec<serde_json::Map<String, Value>>, String> { Err(unsupported()) }
    fn screenshot(&mut self) -> Result<Option<protocol::Screenshot>, String> { Err(unsupported()) }
    fn find_image(&mut self, _: &[u8], _: Option<&protocol::Rect>) -> Result<Option<(protocol::Rect, f64)>, String> { Err(unsupported()) }
    fn read_text(&mut self, _: Option<&protocol::Rect>) -> Result<protocol::TextRead, String> { Err(unsupported()) }
    fn read_elements(&mut self, _: Option<&protocol::Rect>, _: bool, _: bool) -> Result<protocol::ElementsRead, String> { Err(unsupported()) }
    fn url(&mut self) -> Result<String, String> { Err(unsupported()) }
    fn sleep(&mut self, ms: u64) -> Result<(), String> { std::thread::sleep(std::time::Duration::from_millis(ms)); Ok(()) }
}
#[cfg(all(not(windows), not(target_os = "macos")))]
fn unsupported() -> String {
    "host agent: a11y backend 目前只有 Windows(UIA) 与 macOS(AX) 两份，这个平台还没有".to_string()
}

/// `stream-desktop verify` — a direct WindowsDesktop smoke against live Telegram (no WS/backend),
/// the Rust twin of `tg_verify.ps1`. Runtime-proves the UIA + enigo backend.
#[cfg(windows)]
fn run_verify() {
    use protocol::{A11yQuery, Desktop, FieldSpec, ReadSpec};
    use serde_json::json;
    let mut d = windows::WindowsDesktop::default();
    // 全程走 dispatch，而不是直接调后端方法——verify 的意义是证明**生产走的那条路**能用，
    // 绕过闸门去调底层等于验了一条没人跑的路径。锁屏/前台丢失会在这里如实炸出来。
    //
    // 这条路和 telegram-search recipe 现在跑的完全一样：**scopeWindow 而不是 focusApp**，
    // 点击走 invoke、打字走 setValue，全程不抢屏。判据是最后那行前后台对照——前台没变过，
    // 才算"后台采集"这件事真的成立（`2026-08-04-desktop-background-typing-design.md`）。
    println!("windows: {:?}", protocol::dispatch(&mut d, "windows", &serde_json::Value::Null));
    // **量的是前台窗口，不是 `url()`。** `url()` 报的是 UIA 键盘焦点元素——点开搜索框以后它
    // 当然会落在 Telegram 的输入框上，那正是 invoke 该干的事，拿它当"抢没抢屏"的判据必然
    // 恒判有罪（2026-08-04 第一版 verify 就这么误报过一次）。真正的判据是 Z 序上的前台窗口。
    let fg = |d: &mut windows::WindowsDesktop| -> String {
        d.windows()
            .unwrap_or_default()
            .into_iter()
            .find(|w| w.foreground)
            .map(|w| format!("{} 「{}」", w.process, w.title))
            .unwrap_or_else(|| "<none>".into())
    };
    // **先把前台摆成"不是 Telegram"**，否则这次测量什么也证不了：Telegram 本来就在前台时，
    // "跑完它还在前台"和"某一步把它抢上来了"两种情况的读数一模一样。测量之前先造出差异，
    // 是这个判据能不能用的前提（2026-08-04 第二次跑就栽在没有这一步上，结论只能作废）。
    if let Some(other) = d.windows().unwrap_or_default().into_iter().find(|w| {
        !w.process.eq_ignore_ascii_case("Telegram.exe") && !w.title.is_empty() && w.title != "Program Manager"
    }) {
        println!("precondition: 把 {} 「{}」 摆到前台", other.process, other.title);
        let _ = d.focus_window(&other.id);
        d.sleep(600).ok();
    }
    let fg_before = fg(&mut d);
    println!("foreground window BEFORE: {fg_before}");
    if fg_before.starts_with("Telegram.exe") {
        println!("!! 前提没摆成（前台还是 Telegram），这一轮的抢屏判据作废");
    }
    println!(
        "scopeWindow: {:?}",
        protocol::dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "Telegram.exe" } }))
    );
    let btn = d.find(&A11yQuery { role: Some("Button".into()), name: Some("搜索消息".into()), name_contains: None, class_name: None, path: None });
    match &btn {
        Ok(els) if !els.is_empty() => {
            let e = &els[0];
            println!("find search button: role={} name={} class={}", e.role, e.name, e.class_name);
            let el_ref = e.el_ref.clone();
            println!("  ↳ foreground after find (还没动手): {}", fg(&mut d));
            let r = protocol::dispatch(&mut d, "invoke", &json!({ "ref": el_ref }));
            println!("invoke: {r:?}");
        }
        other => println!("find search button: {other:?}"),
    }
    println!("  ↳ foreground after invoke: {}", fg(&mut d));
    d.sleep(900).ok();
    // 打字的快车道：写进输入框，不经键盘、不需要前台。
    //
    // **必须指到里层 `Ui::InputField::Inner`**：这个搜索框在 a11y 树里是「外层容器 + 里层文本域」
    // 两层，容器不存文字、写进去回读永远是空。按坐标/顺序挑必然挑中容器——2026-08-04 就是这么
    // 把「Telegram 不支持 SetValue」判反的（见 spec）。
    let edit = d.find(&A11yQuery { role: Some("Edit".into()), name: Some("搜索".into()), name_contains: None, class_name: Some("class Ui::InputField::Inner".into()), path: None });
    match &edit {
        Ok(els) if !els.is_empty() => {
            let e = &els[0];
            println!("find search box: role={} name={} class={}", e.role, e.name, e.class_name);
            println!(
                "setValue '4K': {:?}",
                protocol::dispatch(&mut d, "setValue", &json!({ "ref": e.el_ref, "text": "4K" }))
            );
        }
        other => println!("find search box: {other:?}"),
    }
    println!("  ↳ foreground after setValue: {}", fg(&mut d));
    d.sleep(1500).ok();
    let mut fields = std::collections::BTreeMap::new();
    fields.insert("text".to_string(), FieldSpec { from: None, read: "name".into() });
    let spec = ReadSpec { item_query: A11yQuery { role: Some("ListItem".into()), name: None, name_contains: None, class_name: None, path: None }, fields, dedupe_by: "text".into() };
    match d.read_subtree(&spec) {
        Ok(rows) => {
            println!("read {} ListItems:", rows.len());
            for x in rows.iter().take(5) {
                if let Some(t) = x.get("text").and_then(|v| v.as_str()) {
                    let s: String = t.replace('\n', " / ").chars().take(45).collect();
                    println!("  {s}");
                }
            }
        }
        Err(e) => println!("read err: {e}"),
    }
    // 判据：整轮跑完，前台还是开跑前那个窗口。变了 = 某一步偷偷抢了屏，这条链路就没成立。
    let fg_after = fg(&mut d);
    println!("foreground window AFTER:  {fg_after}");
    println!("(keyboard focus now: {})", d.url().unwrap_or_else(|e| format!("<err {e}>")));
    // 锁屏时谁都取不到前台，"没抢屏"和"抢不到屏"读数一样——这种时候必须拒绝判决，不能给
    // 一个看着像结论的读数（2026-08-04 连着两轮栽在这上面，其中一轮还据此写进了文档）。
    let locked = |s: &str| s.contains("LockApp.exe") || s.contains("LogonUI.exe") || s == "<none>";
    println!(
        "verdict: {}",
        if locked(&fg_before) || locked(&fg_after) {
            "桌面锁着——抢屏判据作废，解锁后重跑。（写值/搜索/读取这三样锁屏下照常，那部分算数）"
        } else if fg_before == fg_after {
            "前台没变过——整轮没抢屏 ✅"
        } else {
            "前台被换掉了——有一步抢了屏 ❌"
        }
    );
}
#[cfg(not(windows))]
fn run_verify() {
    eprintln!("verify requires the Windows a11y backend");
}

/// Native messaging：**这条路必须先于其它一切分支**，而且不能用 tokio。
///
/// Chrome 拉起我们时给的 argv 是它自己塞的（origin + `--parent-window=`），我们没有机会
/// 在清单里带自己的 flag——所以模式判定只能靠认那两样（`nativemsg::is_native_messaging`）。
/// 之后 **stdout 上除了 wire 帧不许有任何字节**，日志一律 stderr。
fn run_native_messaging(args: &[String]) {
    if let Some(id) = nativemsg::calling_extension_id(args) {
        eprintln!("[host-agent] native messaging: called by chrome-extension://{id}");
    }
    let fs = datadir::RealFs;
    let env = datadir::Env::from_process();
    // 把解析出来的 data 目录印到 stderr：native messaging 下这是唯一能看的诊断——
    // "token 读不到"的九成原因是 Chrome 的 cwd 让我们落到了一个错的目录。
    match datadir::resolve_data_dir(&fs, &env) {
        Some(d) => eprintln!("[host-agent] data dir: {}", d.display()),
        None => eprintln!("[host-agent] 没找到 data 目录（设 STREAM_DATA_DIR 或让 config.yaml 可见）"),
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut r = stdin.lock();
    let mut w = stdout.lock();
    if let Err(e) = nativemsg::serve(&mut r, &mut w, &fs, &env) {
        eprintln!("[host-agent] native messaging ended: {e}");
    }
}

fn run_register(args: &[String], unregister: bool) -> i32 {
    let ids = std::env::var("STREAM_EXTENSION_ID").ok();
    let name = std::env::var("STREAM_NM_HOST_NAME").ok();
    let opts = match register::parse_opts(args, ids.as_deref(), name.as_deref()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[host-agent] {e}");
            return 2;
        }
    };
    let result = if unregister { register::unregister(&opts) } else { register::register(&opts) };
    match result {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            0
        }
        Err(e) => {
            eprintln!("[host-agent] {e}");
            2
        }
    }
}

#[tokio::main]
async fn main() {
    // **必须是第一件事**（任何窗口、任何 UIA 对象创建之前——DPI 感知一旦有东西依赖它就锁死了）。
    //
    // 进程级 Per-Monitor-V2 之后，GetWindowRect / UIA BoundingRectangle / PrintWindow 位图
    // 统一为**物理像素**，wire 上再没有第二套坐标系。不声明时的代价是静默的：系统按逻辑尺寸
    // 报窗口大小、按物理尺寸画内容，于是 150% 缩放下的截图只有左上角四分之一，而那张图看起来
    // 完全正常——识别层在上面量出的框全是错的，却没有任何一处会喊。
    #[cfg(windows)]
    unsafe {
        let _ = ::windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
            ::windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        );
    }

    let args: Vec<String> = std::env::args().skip(1).collect();

    // 顺序有讲究：native messaging 判在最前面，因为 Chrome 塞进来的 argv 里没有我们的 flag，
    // 任何"按 argv[1] 分派"的分支都会先把它误判成别的模式。
    if nativemsg::is_native_messaging(&args) {
        run_native_messaging(&args);
        return;
    }
    if args.iter().any(|a| a == "--register") {
        std::process::exit(run_register(&args, false));
    }
    if args.iter().any(|a| a == "--unregister") {
        std::process::exit(run_register(&args, true));
    }

    if std::env::args().nth(1).as_deref() == Some("verify") {
        run_verify();
        return;
    }
    // 窗口本身没法单测（要真的 HWND、真的显示器）。这条子命令是它唯一的验收面：
    // 亮 5 秒、按热键立刻变"已停止"再消失。人眼确认五件事：位置对、点得穿（在条子上
    // 点一下，底下的窗口要收到）、没夺焦（前台窗口标题不变）、热键有效、副句带着任务文字。
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("overlay-demo") {
        // mac 的渲染层必须占着主线程（AppKit），所以发指令的那一半挪到子线程。
        let (h, lp) = overlay_mac::spawn();
        let secs = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(5u64);
        std::thread::spawn(move || {
            h.send(overlay::OverlayCmd::Status(Some("微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)".into())));
            h.send(overlay::OverlayCmd::Show);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
            while std::time::Instant::now() < deadline {
                if h.hotkey_pressed() {
                    println!("hotkey pressed");
                    h.send(overlay::OverlayCmd::Stopped);
                    std::thread::sleep(std::time::Duration::from_millis(1400));
                    std::process::exit(0);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            h.send(overlay::OverlayCmd::Hide);
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(0);
        });
        lp.run(Some(std::time::Instant::now() + std::time::Duration::from_secs(secs + 3)));
        return;
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("overlay-demo") {
        let h = overlay_win::spawn();
        // 带一段两行任务文字，人眼顺便验：条子两行分别是「recipe 显示名 · 目的 + 热键」和「当前子步骤」，四边七彩描边每块屏都有。
        h.send(overlay::OverlayCmd::Status(Some("微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)".into())));
        h.send(overlay::OverlayCmd::Show);
        // 第二个参数是停留秒数（缺省 5）：看设计稿时给个几百秒让它常驻，按热键随时收。
        let secs = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(5u64);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if h.hotkey_pressed() {
                println!("hotkey pressed");
                h.send(overlay::OverlayCmd::Stopped);
                std::thread::sleep(std::time::Duration::from_millis(1200));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        h.send(overlay::OverlayCmd::Hide);
        std::thread::sleep(std::time::Duration::from_millis(200));
        return;
    }
    // 识别层的排错面：对一个窗口跑一次文字表 + 元素表，不经后端、不抢前台（见 `see::see_probe`）。
    // 两个有截图的平台都接（Windows / mac）；它是识别层唯一不经后端的独立验法，mac 没有它就没法
    // 离线验读屏。
    #[cfg(any(windows, target_os = "macos"))]
    if std::env::args().nth(1).as_deref() == Some("see-probe") {
        let process = std::env::args().nth(2).unwrap_or_else(|| {
            eprintln!("用法：stream-desktop see-probe <进程名，如 Weixin.exe / WeChat> [窗口标题子串] [--save <图片路径>]");
            std::process::exit(2);
        });
        // `--save` 把这一次的截图原样落盘（攒离线图集用，见 `see::see_probe`）。标题那一位可以写 `-` 占位。
        let save = args.iter().position(|a| a == "--save").and_then(|i| args.get(i + 1)).map(std::path::PathBuf::from);
        let title = std::env::args().nth(3).filter(|t| t != "-" && t != "--save");
        see::see_probe::<Backend>(&process, title.as_deref(), save.as_deref());
        return;
    }
    // 识别层的**台架**：吃盘上的一组图，量冷/热/缓存三档耗时并把认出来的文字打成 JSON。
    // 和 `see-probe` 的分工：那个量活体窗口（每次画面都不同，比不起来），这个量固定图集，
    // 所以跨平台、跨月份的数字才是可比的。**三个平台都接**——Linux 上没有截图和 a11y，
    // 但 OCR 那一段是纯算术，台架在哪儿都能跑（也正因如此它能进 CI）。
    if std::env::args().nth(1).as_deref() == Some("ocr-bench") {
        ocr_bench::main(&args[1..]);
        return;
    }
    // 焦点的排错面：键盘焦点此刻落在哪（Win32 层 + 应用内层），只读、不抢前台（见 `windows::focus_probe`）。
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("focus-probe") {
        let process = std::env::args().nth(2).unwrap_or_else(|| {
            eprintln!("用法：stream-desktop focus-probe <进程名，如 QQ.exe> [窗口标题子串] [采样次数] [间隔ms]");
            std::process::exit(2);
        });
        // 标题这一位可以写 `-` 占位，好让后面两位不用连着标题一起给。
        let title = std::env::args().nth(3).filter(|t| t != "-");
        let samples = std::env::args().nth(4).and_then(|s| s.parse().ok()).unwrap_or(1);
        let interval = std::env::args().nth(5).and_then(|s| s.parse().ok()).unwrap_or(400);
        windows::focus_probe(&process, title.as_deref(), samples, interval);
        return;
    }
    // 「投一下点击到底给不给焦点」的 A/B（见 `windows::focus_spike`）。
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("focus-spike") {
        let variant = std::env::args().nth(2).unwrap_or_else(|| "plain".into());
        let repeats = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(5);
        let process = std::env::args().nth(4).unwrap_or_else(|| "QQ.exe".into());
        windows::focus_spike(&variant, repeats, &process);
        return;
    }
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("spike-typing") {
        windows::spike_typing(&std::env::args().nth(2).unwrap_or_else(|| "凡人修仙传".into()));
        return;
    }
    // 父进程死了就跟着退。父进程 = **养它的那个 node 进程**（Stream 后端自己，
    // `src/host-agent/mount.ts`）——它持有 agent 的生命周期。
    //
    // **为什么不能只靠父进程的收尾代码**：那段只在优雅退出时跑；强杀 / 崩溃走不到，agent 就变成
    // 孤儿——活体撞到过：干掉父进程之后 agent 还在，下次启动就是两个 agent 抢同一条中继。
    // stdin 的读端在我们手上、写端在父进程手上，父进程一没，操作系统就关掉写端，这里读到
    // EOF —— 这是父死检测最省事也最跨平台的一招。
    //
    // 用**显式开关**而不是"猜 stdin 是不是管道"：手动起（`nohup ... > log`，stdin 是 /dev/null）
    // 会立刻 EOF，猜法会让 agent 一启动就自退。只有真的被父进程 spawn 时才由它带上这个变量。
    if std::env::var("STREAM_HOST_PARENT_WATCH").is_ok() {
        std::thread::spawn(|| {
            use std::io::Read;
            let mut buf = [0u8; 64];
            loop {
                match std::io::stdin().read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF 或读错 = 父进程没了
                    Ok(_) => {}              // 父进程写了点什么，继续等
                }
            }
            eprintln!("[host-agent] parent gone — exiting");
            std::process::exit(0);
        });
    }

    let url = std::env::var("STREAM_HOST_URL").unwrap_or_else(|_| "ws://127.0.0.1:8900/api/host".into());
    // token 不再必须由人喂进环境变量：`STREAM_HOST_TOKEN` 优先，缺了就自己去 data 目录读
    // （`datadir.rs` 的候选顺序）。从 WSL 手起时那段 `WSLENV=... STREAM_HOST_TOKEN=$(< …)`
    // 因此变成可选的。
    let token = match datadir::read_token(&datadir::RealFs, &datadir::Env::from_process()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[host-agent] 拿不到 relay token（中继会拒握手）：{e}");
            String::new()
        }
    };
    // URL 语法错是配置错，不是"后端还没起"——重试一万次也还是那个错。只有这一条在启动时
    // 就判死，其余一切失败都交给监督循环。
    if let Err(e) = url.as_str().into_client_request() {
        eprintln!("[host-agent] bad STREAM_HOST_URL ({url}): {e}");
        std::process::exit(2);
    }

    // 渲染层跟着 agent 的整个寿命走，不随单次会话生灭：`RegisterHotKey` 和窗口类都是
    // 线程级的资源，后端每重启一次就重建一遍纯属找事。
    #[cfg(windows)]
    let overlay_handle = Some(overlay_win::spawn());
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let overlay_handle: Option<OverlayHandleLike> = None;
    // mac：AppKit 只认主线程，渲染层占住它；监督循环搬到自己的线程 + 自己的 tokio 运行时。
    // 进程的出口没变（父进程没了 → `exit(0)`，见上面那条 stdin 线程）。
    #[cfg(target_os = "macos")]
    {
        let (handle, lp) = overlay_mac::spawn();
        let url = url.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            // 后端（AX 句柄）不是 Send，在这条线程里建。
            let mut backend = Backend::default();
            let mut supervisor = Supervisor::default();
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
            rt.block_on(supervise(&url, &token, &mut backend, &mut supervisor, Some(&handle)));
        });
        lp.run(None);
        return;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut backend = Backend::default();
        let mut supervisor = Supervisor::default();
        supervise(&url, &token, &mut backend, &mut supervisor, overlay_handle.as_ref()).await;
    }
}

/// 监督循环：连 → 跑会话 → 退避 → 再连，**永不返回**。
///
/// 这个函数存在的全部理由，是让 agent 的寿命不再等于一条 WebSocket 的寿命。进程只有两条
/// 出路：父进程（持有它的那个 DSH 引擎进程）没了（stdin EOF，见 `main`），或者被杀。中继断了从来不是其中之一
/// ——后端 restart 是开发期的日常，agent 得自己熬过去。退避语义见 `relay.rs`。
async fn supervise<D: protocol::Desktop>(
    url: &str,
    token: &str,
    backend: &mut D,
    supervisor: &mut Supervisor,
    overlay: Option<&OverlayHandleLike>,
) {
    loop {
        let end = run_session(url, token, backend, overlay).await;
        let delay = supervisor.after(&end);
        eprintln!(
            "[host-agent] {} — reconnecting in {:.1}s (attempt #{})",
            end.reason(),
            delay.as_secs_f32(),
            supervisor.scheduled(),
        );
        tokio::time::sleep(delay).await;
    }
}

/// 一次完整会话：握手 → 收发 op → 断开。**每一条路径都是 `return`，没有一条 `exit`**
/// ——要不要活下去是 [`supervise`] 的判断，不是这里的。
///
/// `overlay` 缺席（非 Windows / 渲染层没起来）时整条指示条逻辑空转，会话本身不受影响。
async fn run_session<D: protocol::Desktop>(
    url: &str,
    token: &str,
    backend: &mut D,
    overlay: Option<&OverlayHandleLike>,
) -> SessionEnd {
    let mut req = match url.into_client_request() {
        Ok(r) => r,
        Err(e) => return SessionEnd::ConnectFailed(format!("bad url: {e}")),
    };
    // The relay's verifyHostUpgrade expects [host-relay.v1, <token>] in Sec-WebSocket-Protocol;
    // the token rides the header, never the URL (so it never lands in an access log).
    let proto = match format!("{PROTOCOL}, {token}").parse() {
        Ok(v) => v,
        Err(e) => return SessionEnd::ConnectFailed(format!("bad token header: {e}")),
    };
    req.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, proto);

    let (ws, _resp) = match tokio_tungstenite::connect_async(req).await {
        Ok(v) => v,
        // 握手被中继当场拒掉（401/403）和"连不上"是两种病，日志要分得开：前者是 token 的事，
        // 后者是后端在不在的事。两者都重试（理由见 SessionEnd::Rejected 的注释）。
        Err(WsError::Http(resp)) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
            return SessionEnd::Rejected(format!("HTTP {}", resp.status()));
        }
        Err(e) => return SessionEnd::ConnectFailed(e.to_string()),
    };
    eprintln!("[host-agent] connected");
    let (mut tx, mut rx) = ws.split();

    let mut policy = overlay::OverlayPolicy::new();
    // 20ms 的心跳，兼两件事：**收热键**（渲染层那头是同步 channel，跨线程送过来）和
    // **到点熄灭**。不为它引 `tokio::sync::mpsc` 去改造渲染层——那边是个 Win32 消息泵线程，
    // 本来就得自己轮询，换成异步 channel 只是把轮询挪个地方。
    let mut hot = tokio::time::interval(std::time::Duration::from_millis(20));
    loop {
        let msg = tokio::select! {
            m = rx.next() => match m {
                Some(m) => m,
                None => break,
            },
            _ = hot.tick() => {
                if let Some(o) = overlay {
                    // 热键：只发一帧 `{"type":"abort"}` 就够了，**不需要在 agent 侧维持"已中止"
                    // 的状态**。op 在物理连接上严格串行，后端收到 abort 会把挂起的那个 op 和
                    // 排队的一并拒掉，整趟 recipe 随之 unwind——后续 op 根本不会再发过来。此刻
                    // 正在阻塞执行的那个 UIA 调用打断不了（enigo/UIA 是同步的），它跑完发回来的
                    // reply 对应一个后端已经丢掉的 id，`handleMessage` 认不出就忽略，没有副作用。
                    if o.hotkey_pressed() {
                        for cmd in policy.on_abort() {
                            o.send(cmd);
                        }
                        let frame = json!({ "type": "abort", "reason": "user-hotkey" });
                        if tx.send(Message::Text(frame.to_string())).await.is_err() {
                            break;
                        }
                        eprintln!("[host-agent] 用户按下中止热键 — 已通知后端");
                    }
                    if let Some(cmd) = policy.tick(std::time::Instant::now()) {
                        o.send(cmd);
                    }
                }
                continue;
            }
        };
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        let req: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let args = req.get("args").cloned().unwrap_or(Value::Null);

        // `status` 的收件人是指示条，不是桌面：在这里拦下、不进 dispatch。没有渲染层
        // （非 Windows）也照样回 `{}`——它是提示，缺席不该让后端那一步失败。
        if op == "status" {
            if let Some(o) = overlay {
                if let Some(cmd) = policy.on_status(protocol::status_arg(&args)) {
                    o.send(cmd);
                }
            }
            let reply = json!({ "id": id, "result": {} });
            if tx.send(Message::Text(reply.to_string())).await.is_err() {
                break;
            }
            continue;
        }

        // 先亮再动手：条子的意义是"你现在别碰鼠标"，动完了才亮等于没亮。
        if let Some(o) = overlay {
            if let Some(cmd) = policy.on_op(&op, std::time::Instant::now()) {
                o.send(cmd);
            }
        }

        // UIA / enigo are blocking and run INLINE here (not spawn_blocking): a single connection
        // to a single machine is inherently sequential, and UIElement/Enigo are !Send so they
        // can't cross a spawn_blocking boundary anyway. Ops are short (< the 20s WS keepalive), so
        // blocking the reactor for one op is fine; a genuinely long op would need a dedicated
        // blocking thread + a Send-safe channel — not warranted yet.
        let reply = match protocol::dispatch(backend, &op, &args) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        if tx.send(Message::Text(reply.to_string())).await.is_err() {
            break;
        }
        if let Some(o) = overlay {
            if let Some(cmd) = policy.tick(std::time::Instant::now()) {
                o.send(cmd);
            }
        }
    }
    // 断连立刻熄（连同任务文字）——后端都不在了还亮着就是撒谎。
    if let Some(o) = overlay {
        for cmd in policy.on_session_end() {
            o.send(cmd);
        }
    }
    SessionEnd::Disconnected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    /// 借一个端口再放掉：之后连它必然 ECONNREFUSED（= 后端没起来的样子），且不碰真网络。
    async fn dead_addr() -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("ws://{addr}/api/host")
    }

    /// 连不上时**返回**而不是 `exit(1)`。这条是整个修复的根：旧实现在这里退进程，于是
    /// 后端一重启 agent 就永久消失。
    #[tokio::test]
    async fn a_refused_connection_comes_back_as_a_value_not_an_exit() {
        let mut backend = Backend::default();
        let end = run_session(&dead_addr().await, "token", &mut backend, None).await;
        assert!(matches!(end, SessionEnd::ConnectFailed(_)), "得到的是 {end:?}");
    }

    /// 后端一直不在时，监督循环要一直按退避重试——不退出、也不空转。
    #[tokio::test]
    async fn the_loop_keeps_retrying_while_the_backend_is_down() {
        let url = dead_addr().await;
        let mut backend = Backend::default();
        let mut sup = Supervisor::with(Duration::from_millis(20), Duration::from_millis(60));
        let outcome = tokio::time::timeout(
            Duration::from_millis(400),
            supervise(&url, "token", &mut backend, &mut sup, None),
        )
        .await;
        assert!(outcome.is_err(), "监督循环不许自己结束");
        assert!(sup.scheduled() >= 3, "只重试了 {} 次", sup.scheduled());
    }

    /// 后端重启的样子：握手成功、连上、对端立刻挂断。agent 必须自己再连回来——活体里
    /// 缺的就是这一步（`docker restart` 之后 hostRelay 永久 disconnected）。
    #[tokio::test]
    async fn it_reconnects_after_the_relay_drops_the_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut accepted = 0u32;
            while accepted < 2 {
                let Ok((stream, _)) = listener.accept().await else { break };
                // 像真中继一样回选子协议，然后立刻放掉 —— 客户端确实"连上过"再被断开。
                let echo = |_r: &Request, mut resp: Response| {
                    resp.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, PROTOCOL.parse().unwrap());
                    Ok(resp)
                };
                if tokio_tungstenite::accept_hdr_async(stream, echo).await.is_ok() {
                    accepted += 1;
                }
            }
            accepted
        });

        let url = format!("ws://{addr}/api/host");
        let mut backend = Backend::default();
        let mut sup = Supervisor::with(Duration::from_millis(20), Duration::from_millis(60));
        let accepted = tokio::select! {
            _ = supervise(&url, "token", &mut backend, &mut sup, None) => unreachable!("监督循环不许返回"),
            n = server => n.unwrap(),
            _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("断开之后没有重连回来"),
        };
        assert_eq!(accepted, 2, "第一条连接被挂断后必须自己再连一次");
    }
}
