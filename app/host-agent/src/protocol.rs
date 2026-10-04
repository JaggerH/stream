//! Wire protocol + op dispatch for the host-desktop Engine agent.
//!
//! This mirrors the backend's `DesktopDriver` wire contract (`src/replay/desktop-driver.ts`):
//! each request is `{id, op, args?}`, each reply `{id, result}` or `{id, error}`. The `Desktop`
//! trait is the platform-neutral surface the WS loop drives; a per-OS backend (Windows UIA +
//! enigo) implements it. Everything here is platform-INDEPENDENT and unit-tested with a fake
//! backend, so the protocol layer is verifiable off-Windows.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Wire types (mirror the TS a11y vocabulary) ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// 一张截图 + **它是屏幕上哪一块**。
///
/// 识别层（模板匹配 / 模型）只能在图片自己的坐标系里量出框；要变成可点的屏幕坐标，就得把
/// 窗口的物理原点加回去。所以图和原点必须同一次回来——分两次取，中间窗口挪一下，框就指错了。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Screenshot {
    pub base64: String,
    /// 被截那个窗口的屏幕**物理** rect（抓屏回落时为 None——那张图不是"一个窗口"）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<Rect>,
    /// 该窗口的缩放比（DPI/96）。**只作诊断与缓存键**：进程声明 DPI 感知之后 wire 上一切 rect
    /// 都是物理像素，谁拿它去除坐标谁就在造第三套坐标系。
    pub scale: f64,
}

/// 屏幕上的一段字 + 它在**截图坐标系**里的框（相对窗口左上角、物理像素，同 `find_image`）。
///
/// **按段给框**：段 = PP-OCR det 框出来的一块连续文字（`ocr::OcrLine`），同一行里隔着空白的
/// 「搜索」和「添加朋友」是两段、各自一个框——点它才落在那个按钮上，而不是两个按钮中间的空白处。
/// 上层匹配先全等、不成再包含。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScreenText {
    pub text: String,
    pub rect: Rect,
}

/// 元素表里一条的来源，**同时也是可信度的次序**：a11y > detector > text。
///
/// 为什么要露在 wire 上：三档的性质完全不同——a11y 那档的框是控件自己报的（最准），
/// detector 那档是纯视觉模型猜的"这儿能点"，text 那档只是"这儿写着字"（未必可点）。
/// 调用方失败时要能说清"我点的是哪一档给的框"，否则三种完全不同的失因长得一模一样。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    A11y,
    Detector,
    Text,
}

/// 元素表里的一条：**一块能点的区域 + 它叫什么**，框在**截图坐标系**里（同 `ScreenText`）。
///
/// 和 `ScreenText` 是两张表、两个问题：文字表回答"画面上写了什么"（判据用），元素表回答
/// "哪儿能点、点的是什么"（动作用）。同一个按钮在两张表里的框不一样——文字框只圈住那两个字，
/// 元素框才是整个可点区域；拿文字框去点蓝底蓝字的「发送」会点在按钮内部靠左的位置，边缘的
/// 那些直接点空。合成规则见 `see::synthesize_elements`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Element {
    pub rect: Rect,
    /// 没名字的元素照样入表（一个只有图标的按钮），所以这一格是可选的——**别用空串代替
    /// `None`**：上层按名字匹配时，空串会和"匹配任何东西"的判据擦出静默命中。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: ElementKind,
}

/// `readText` 的结果：认出来的字 + 这张画面是哪个窗口 + 它的缩放比。
///
/// `window` 和 `scale` 与 `texts` **同一次**回来，理由同 `Screenshot`：框是相对图片量出来的，
/// 要变成可点的屏幕坐标就得加回窗口物理原点；分两次取，中间窗口挪一下，框就指错了。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextRead {
    pub texts: Vec<ScreenText>,
    pub window: Rect,
    pub scale: f64,
}

/// `readElements` 的结果。`window`/`scale` 同 `TextRead`，理由一样。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElementsRead {
    pub elements: Vec<Element>,
    pub window: Rect,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppMatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    #[serde(default, rename = "windowClass", skip_serializing_if = "Option::is_none")]
    pub window_class: Option<String>,
    /// 窗口标题，**包含匹配**（不是全等）。真实标题带动态前后缀（`扩展程序 - Google Chrome`、
    /// 带未读数的前缀），全等匹配在活体上几乎必然落空。
    /// 一个进程开多个窗口时这是唯一的消歧维度——没有它，调用方只能靠关掉其他窗口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 一个可寻址的原生窗口。字段刻意选得**足以直接拼出 `app:<process>/<title>` 地址**——
/// 枚举的用途就是"认出目标再动手"，返回一份认不出目标的清单等于没有。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowInfo {
    pub id: String,
    pub process: String,
    pub title: String,
    pub foreground: bool,
    /// 这个 agent 跑在哪个平台上（`win32` / `darwin`）。**由 agent 报，不由后端猜**：后端可能在
    /// WSL 里、agent 在 Windows 上，后端自己的 `process.platform` 就是错的答案。recipe 的落地方式
    /// 按它挑（`desktop-grounding.ts`）。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub platform: String,
    /// 这个窗口所属应用的版本（Windows：exe 的 FileVersion；mac：bundle 的
    /// CFBundleShortVersionString）。读不到就缺席——**不给空串**，缺席与"版本是空"要分得开。
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "appVersion")]
    pub app_version: Option<String>,
}

/// 这个 agent 跑在哪个平台上。编译期常量——agent 的二进制只为一个平台构建。
pub const PLATFORM_NAME: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    ""
};

/// A locate query in the a11y vocabulary. Neutral `role`/`name`; `class_name` is an optional
/// per-platform hint (Windows/Qt widget class).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct A11yQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 名字**包含**这一段就算命中（大小写不敏感）。`name` 是全等且大小写敏感的。
    ///
    /// **列表项这类控件的 name 往往是一整句动态拼出来的**：Telegram 的会话列表项叫
    /// 「频道, 夸克云盘影视资源频道, 已静音, 1908 个新消息, 图片, 名称：…, 已收到, 1:39」
    /// ——未读数、最后一条消息、时间每秒都在变，全等匹配**永远**匹配不上，而失败的样子是
    /// **空结果**（跟"这个元素不存在"一模一样），最容易被误判成"读不到这个界面"。
    /// 稳定的那部分（频道名）拿 `nameContains` 匹配才是对的。
    #[serde(default, rename = "nameContains", skip_serializing_if = "Option::is_none")]
    pub name_contains: Option<String>,
    #[serde(default, rename = "className", skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<A11yQuery>>,
}

impl A11yQuery {
    /// `name` 与 `nameContains` 只能给一个。
    ///
    /// 两个都给的话，两条判据会 AND 在一起，能同时满足的只有全等那一个——等于 `nameContains`
    /// 被静默吞掉。宁可当场报错：**过滤条件静默失效比没有过滤更危险**，查询照常返回一批
    /// 看起来对的元素，第一名可能是完全不同的控件，而 `click` 会把它直接执行掉。
    /// （同一条理由见 `role_to_control` 对未知 role 的处理。）
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_some() && self.name_contains.is_some() {
            return Err("a11y query: name 与 nameContains 只能给一个（前者全等、后者包含）".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yElement {
    #[serde(rename = "ref")]
    pub el_ref: String,
    pub role: String,
    pub name: String,
    #[serde(rename = "className")]
    pub class_name: String,
    pub rect: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<A11yQuery>,
    pub read: String, // "name" | "value"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadSpec {
    #[serde(rename = "itemQuery")]
    pub item_query: A11yQuery,
    pub fields: std::collections::BTreeMap<String, FieldSpec>,
    #[serde(rename = "dedupeBy")]
    pub dedupe_by: String,
}

/// 一次要**投给窗口**的输入（见 `Desktop::post_input`）。和坐标 op 一一对应，只是收件人不同。
#[derive(Debug, Clone, PartialEq)]
pub enum PostedInput {
    /// 在 `rect` 中心点一下（屏幕物理坐标）。`button` 同 `click`：left / right / middle。
    Click { rect: Rect, button: String },
    /// 逐字投 `WM_CHAR`；`\n` 投成回车键。
    Text(String),
    /// 单个无字符键：Escape / Enter。
    Key(String),
    /// 清空焦点输入框（`clearInput` 的投消息版）：投 Ctrl 按下 → A 按下 → `WM_CHAR 0x01`
    /// → A 松开 → Ctrl 松开 → Backspace。投消息拿不到修饰键状态（应用查 `GetKeyState` 会看到
    /// Ctrl 没按），所以**靠 `WM_CHAR 0x01`**：Edit / RichEdit / Qt 一类控件把控制字符 0x01
    /// 当 Ctrl+A 处理——这是投消息路上唯一能表达"全选"的办法，认不认由目标应用定，所以
    /// recipe 的下一步 `expect` 必须能看出草稿有没有真被清掉。
    Clear,
    /// 滚轮：`amount` 与 `scroll` 同单位，实现按 120 一格换成 `WM_MOUSEWHEEL`。
    Scroll { dir: String, amount: i32 },
}

/// 坐标 op 的 `deliver` 参数：没给 = 走屏幕（enigo，先过前台闸门）；`"message"` = 投给窗口。
/// 认不出的值报错，别静默当成默认——一份写错了 `deliver` 的 recipe 会在半夜抢屏。
fn deliver_by_message(args: &Value) -> Result<bool, String> {
    match args.get("deliver").and_then(|v| v.as_str()) {
        None => Ok(false),
        Some("message") => Ok(true),
        Some(other) => Err(format!("unknown deliver: {other}（只认 message）")),
    }
}

/// 投递的收件窗口 = 此刻 scope 到的那个（`scopeWindow`/`focusApp` 都会确立它）。没有就拒绝：
/// 消息必须有 hwnd，"投给谁"猜不得。
fn post_to_scoped<D: Desktop>(d: &mut D, input: PostedInput) -> Result<(), String> {
    let hwnd = d
        .scope_target()
        .ok_or("no-scope: 消息投递要有收件窗口，先 scopeWindow / focusApp")?;
    d.post_input(&hwnd, &input)
}

/// The platform-neutral desktop surface. The WS loop calls these; a per-OS backend implements
/// them. All methods are sync (UIA/enigo are sync); the loop runs dispatch on a blocking task.
pub trait Desktop {
    /// 枚举可寻址窗口。**窗口的消歧、歧义报错、目标解析全在 `dispatch` 那层做**（平台无关、
    /// 可单测）；每个 OS 后端只要老实报出它看得见的窗口即可。
    fn windows(&mut self) -> Result<Vec<WindowInfo>, String>;
    /// 把某个窗口抬到前台（会绕前台锁）。成功后该窗口即"已确立的目标"。
    fn focus_window(&mut self, id: &str) -> Result<bool, String>;
    /// 只把 find/read 的**搜索范围**限定到某个窗口，**不碰焦点、不动 Z 序**。
    ///
    /// 读和动手是两件事：`cdp_look` 看一眼不该把用户的窗口拽到前面来。而范围又不能不限——
    /// 不限就是在整个桌面上搜，别的窗口的元素会漏进结果（代码里记着这是真撞过的 bug）。
    fn scope_window(&mut self, id: &str) -> Result<(), String>;
    /// 我们通过 `focus_window` 确立过的目标窗口；从未确立过时 `None`。
    fn focus_target(&mut self) -> Option<String>;
    /// `find`/`readSubtree` 此刻被限定到的那个窗口（`scope_window`/`focus_window` 都会确立它）；
    /// 从没限定过（= 在整个桌面上搜）时 `None`。
    ///
    /// 存在的理由只有一个：空结果要不要打上「可能没读到」那面旗，取决于**被限定的那个窗口**
    /// 在不在前台——见 `empty_may_be_unbuilt`。
    fn scope_target(&mut self) -> Option<String>;
    /// 此刻**真正**持有前台的窗口 id（问操作系统，不问被控应用）。
    fn foreground_window_id(&mut self) -> Result<String, String>;
    /// 会话此刻锁没锁——**纯读**：不枚举窗口、不抬前台、不碰焦点。
    ///
    /// 三态，`None` = 查不出来（非 Windows 后端、或 WTS 查询失败）。**`None` 绝不能当成
    /// "没锁"**：这一格是"没验到"，不是"验过了"。
    ///
    /// 为什么不复用 `foreground_blocker`：那个只在**刚尝试过抬前台之后**才准（见它的头注），
    /// 纯读路径上恒为 false。
    fn session_locked(&mut self) -> Option<bool> {
        None
    }
    /// 确保目标进程活着——**不碰窗口**（Z 序、焦点、最小化状态一律不动）。
    ///
    /// 和上面的 `focus_app` 是两件事，别混：`focus_app` 的职责是**抢屏**（它为此专门写了
    /// `AttachThreadInput` 去绕前台锁）；这里的语义只是"让它在跑"。定时采集需要的是后者——
    /// 半夜把用户的窗口拽到前面来，正是这次改造要消灭的东西。
    ///
    /// 默认实现是平台无关的（sysinfo 枚举 + `Command::spawn`），所以每个 OS 后端都不用重写它。
    fn ensure_app(&mut self, spec: &crate::launch::LaunchSpec) -> Result<crate::launch::EnsureOutcome, String> {
        crate::launch::ensure_running(spec, &mut crate::launch::RealWorld)
    }
    fn find(&mut self, q: &A11yQuery) -> Result<Vec<A11yElement>, String>;
    fn invoke(&mut self, el_ref: &str) -> Result<(), String>;
    /// 把一段文字**写进某个元素**（UIA ValuePattern 一类），不经键盘。
    ///
    /// 和 `type_text` 是两件事，区别就是这条链路存在的理由：键盘输入投给"此刻的焦点窗口"，
    /// 所以必须先抢屏；这里的收件人是元素句柄本身，因此**不需要前台**（同 `invoke`）。
    /// 一份 recipe 里若只剩打字这一步需要前台，换成它就能整轮不碰用户的屏幕。
    ///
    /// 不是所有控件都认：自绘应用的 UIA provider 可能根本不给 Value pattern，或者给了却不触发
    /// 它自己的 text-changed 处理器。所以调用方必须准备好退回键盘那条路，**并留痕**。
    fn set_value(&mut self, el_ref: &str, text: &str) -> Result<(), String>;
    fn click(&mut self, rect: &Rect, button: &str) -> Result<(), String>;
    fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String>;
    /// 发一次**零位移**的真实输入，把挂起的渲染端叫醒——指针一动不动。
    ///
    /// 为什么需要它：`PostMessage` 不是"用户输入"，不重置系统空闲计时器、也不让 Chromium
    /// 把窗口从 occluded 里放出来；机器一闲下来（不必锁屏）渲染端就挂起，此后投进去的
    /// 点击与按键**整份被静默丢弃**而 `PostMessage` 照样返回成功。叫醒只能靠真实输入。
    ///
    /// 和 `move_mouse` 的区别就是这条存在的全部理由：**它不挪用户的指针**（`SendInput` 发
    /// `MOUSEEVENTF_MOVE` 且 `dx=dy=0`）。用户正在拖文件或拖选文字时，指针跳走是会出事的。
    /// 本机 2026-09-08 对照：确认睡着（`Document` 读回 0）之后发一次零位移 → 668ms 树回来、
    /// 随后点击 **4/4**；而挪到窗口中心那一版是 **3/4**（第一轮仍落在空档里）。
    ///
    /// 默认实现报"这个平台没有"：只有 Windows 后端真的实现它，别的平台照旧走 `move_mouse`。
    fn nudge_input(&mut self) -> Result<(), String> {
        Err("nudge: 这个平台还没有零位移叫醒".to_string())
    }
    fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String>;
    fn type_text(&mut self, text: &str) -> Result<(), String>;
    /// 按一个**没有字符**的键（今天只有 `Escape` / `Enter`）。
    ///
    /// 和 `type_text` 分开，是因为它们的用途不同：打字是往输入框里塞内容，按键是关掉一个挡路的
    /// 弹窗、或者提交。不认识的键名必须报错，别静默吞掉——一次"以为按了 Escape、其实什么都
    /// 没发生"会让上层把没关掉的弹窗当成关掉了。
    fn press(&mut self, key: &str) -> Result<(), String>;
    /// **清空此刻有焦点的输入框**：全选 + 删除（Windows `Ctrl+A` / mac `Cmd+A`，再 Backspace）。
    ///
    /// 它是一个**语义化**的 op，不是"按组合键"的通道：recipe 只说"把输入框清掉"，哪个修饰键
    /// 归平台后端。不把组合键开成通用能力的理由和 `press` 只认三个键是同一条——`Ctrl+A` 一放行，
    /// `Ctrl+W` / `Alt+F4` 就在同一条路上。存在的理由：上一轮 abort 之后正文还躺在输入框里
    /// （微信会把它存成草稿），下一轮的正文会接在后面一起发出去（活体 2026-09-12）。
    /// 收件人是"此刻有焦点的那个东西"，所以和 `press` 一样过前台闸门。
    fn clear_input(&mut self) -> Result<(), String>;
    /// 把一次输入**投给某个窗口**（`PostMessage` 到它的 hwnd），不经屏幕、不经焦点。
    ///
    /// 这是坐标输入的第三条路，和 `invoke`/`set_value` 同一类：**有收件人**（窗口句柄），所以不过
    /// 前台闸门、锁屏照常生效——本机 2026-09-07 锁着屏对微信 4.x 全程验过：点搜索框、打中文、
    /// 回车打开会话、候选弹层照常出来。代价是**逐应用的兼容性**：走自己合成器的 Electron 多半
    /// 不理会投进来的消息，而且失败得安静（什么都不发生）。所以它是 recipe 显式选的
    /// （`input:"message"`），不是自动退路；点没点中由每一步的 `expect` 判。
    ///
    /// `rect` 是**屏幕物理坐标**（同 `click`），实现自己换成该窗口的 client 坐标。
    fn post_input(&mut self, hwnd: &str, input: &PostedInput) -> Result<(), String> {
        let _ = (hwnd, input);
        Err("post_input: unsupported on this backend".into())
    }
    fn read_subtree(&mut self, spec: &ReadSpec) -> Result<Vec<serde_json::Map<String, Value>>, String>;
    /// 一张 base64 JPEG + 它对应的窗口物理 rect；None = 这个后端不支持截图。
    fn screenshot(&mut self) -> Result<Option<Screenshot>, String>;
    /// 在目标窗口此刻的画面上找一张 PNG 模板，回「框 + 分数」；None = 画面里没有它。
    ///
    /// 框的坐标系**和 `screenshot` 那张图一致**（相对窗口左上角、物理像素），不是屏幕坐标——
    /// 要点它得由调用方加回 `Screenshot::window` 的原点。两边同一个约定，识别层才不用知道
    /// 窗口在屏幕哪儿。
    /// `region`：只在窗口画面的这一块里找（截图坐标），回的框仍是整窗截图坐标。没给 = 整窗。
    /// 模板匹配是逐像素扫的，整窗 1146×811 一次 2s（活体 2026-09-12）——recipe 明明给了 region，
    /// 扫整窗是白付三四倍。
    fn find_image(&mut self, template_png: &[u8], region: Option<&Rect>) -> Result<Option<(Rect, f64)>, String>;
    /// 读目标窗口此刻画面上的**字**（文字表，判据用）。
    ///
    /// `region` 是**截图坐标系**里的一块（相对窗口左上角、物理像素），`None` = 整窗。
    /// 它不是"取回来之后再筛一遍"的过滤器，而是**先裁图再识别**：整窗一次 PP-OCR 是
    /// 1.06–3.43 秒（`ocr.rs` 的实测表），每一步判据都付这个价这条路就不能用。所以后端必须
    /// 把它下推到裁剪，回来的框再加回 region 原点——出门的坐标系永远是整窗那一套。
    ///
    /// 识别不出任何字和"识别不了"是两回事：引擎不在场必须报错，不许回空数组
    /// （空数组会被上层读成"这一屏没有文字"，然后安静地一直找不到目标）。
    fn read_text(&mut self, region: Option<&Rect>) -> Result<TextRead, String>;
    /// `read_text` 跑的是哪一份识别引擎（名字 / 运行时版本 / 线程数 / 真加载到的库）。
    /// 惰性加载与 `read_text` 同一个引擎实例；缺库 / 缺模型时 `Err` 就是 `read_text` 会报的那一份
    /// （`ocr-missing:` / `ort-missing:`）。只给 `see-probe` 回执用，别拿它当"能不能识别"的判据——
    /// 那要真读一次。没有识别层的后端报错。（唯一的调用方 `see_probe` 只在两个桌面平台上编，
    /// Linux 的协议层测试构建里它没人用。）
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    fn ocr_engine_info(&mut self) -> Result<crate::ocr::EngineInfo, String> {
        Err("ocr-missing: 这个后端没有识别层".to_string())
    }
    /// 读目标窗口此刻画面上的**元素表**（哪儿能点、点的是什么，动作用）。
    ///
    /// `region` 同 `read_text`。`icons` 才跑那个纯视觉检测器——它是这条 op 里第二贵的一步，
    /// 而多数动作靠 a11y + 文字就够；默认不跑，要图标按钮的调用方自己显式要。
    /// `a11y == false` 跳过控件树枚举：它是 recipe 作者的**申报**（`app.a11y:false`，"这个应用
    /// 没有控件树"），不是运行时的猜测——缺省 true，日志里 `a11y=0ms(off)` 留痕。
    fn read_elements(&mut self, region: Option<&Rect>, icons: bool, a11y: bool) -> Result<ElementsRead, String>;
    /// foreground window id (app#class), from the OS window manager — never the controlled app.
    fn url(&mut self) -> Result<String, String>;
    fn sleep(&mut self, ms: u64) -> Result<(), String>;
}

// ── Dispatch: (op, args) → a Desktop call → a JSON result ────────────────────

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a Value, String> {
    args.get(key).ok_or_else(|| format!("missing arg: {key}"))
}
fn parse<T: for<'de> Deserialize<'de>>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
fn s(v: &Value, key: &str) -> Result<String, String> {
    arg(v, key)?.as_str().map(|s| s.to_string()).ok_or_else(|| format!("arg {key} must be a string"))
}
fn i(v: &Value, key: &str) -> Result<i64, String> {
    arg(v, key)?.as_i64().ok_or_else(|| format!("arg {key} must be a number"))
}

/// 按 `AppMatch` 解析出唯一目标窗口。**歧义不擅自决定**——两个窗口都像的时候任选一个，
/// 等于把"点错了"变成一个安静的 50% 概率事件。
fn resolve_window<D: Desktop>(d: &mut D, m: &AppMatch) -> Result<WindowInfo, String> {
    let lower = |s: &str| s.to_lowercase();
    let hits: Vec<WindowInfo> = d
        .windows()?
        .into_iter()
        .filter(|w| m.process.as_ref().is_none_or(|p| lower(&w.process) == lower(p)))
        .filter(|w| m.title.as_ref().is_none_or(|t| w.title.contains(t.as_str())))
        .collect();
    match hits.len() {
        0 => Err(format!("no-window-match: 没有窗口匹配 {m:?}")),
        1 => Ok(hits.into_iter().next().expect("len==1")),
        _ => Err(format!(
            "ambiguous-window: {} 个窗口都匹配，请用 title 指名一个；候选：{}",
            hits.len(),
            hits.iter().map(|w| format!("「{}」", w.title)).collect::<Vec<_>>().join("、")
        )),
    }
}

/// 前台被谁占着——**只用来解释失败，不当闸门**。
///
/// 锁屏界面（`LockApp.exe` / `LogonUI.exe`）持有前台时，谁都别想把窗口抬上来。认出这一点
/// 是为了把「别的窗口压着，让用户切过去」和「屏幕锁着，去解锁」分开——两句话指向完全相反
/// 的下一步。
///
/// **为什么不做成闸门**（2026-08-01 实测推翻了原设计）：
/// - 锁屏时 UIA `invoke` **照常能点**（活体：锁着屏把 bilibili 画中画开了又关）。禁掉它等于
///   用户一锁屏、定时桌面采集就全停——而"人不在时后台干活"正是这条链路的主要用途。
/// - 而且原来那两个锁屏判据都不可靠：`OpenInputDesktop` 查桌面名**恒为 `Default`**（8 次采样，
///   锁着屏也从没说过"锁了"，等于不存在）；`LogonUI.exe` 在不在**时有时无**。闸门每次生效
///   全看后者当天心情。
///
/// 真正该防的那条路（坐标输入）由下面的前台校验天然挡住：锁屏时没有任何应用窗口拿得到前台。
/// 只在「刚尝试过抬前台」之后调它（`guard_actuation` 的前台不符分支、`focusApp` 抬不起来
/// 之后）——纯读路径上"谁占着前台"不是一个要回答的问题。
///
/// 它靠 `windows()` 里那行 `foreground:true` 认锁屏，所以 **`windows()` 必须保证前台窗口在表里**
/// （Windows 后端在枚举之后专门补这一行，见 `WindowsDesktop::windows`）。锁屏界面本来是漏的：
/// `EnumWindows` 枚举不到它、DWM 又把它标成 cloaked，活体两次撞到（2026-08-28 win-test、
/// 2026-09-07 本机）——`focusApp` 抬不起来时整张表没有前台行，这里回 `None`，锁屏被报成
/// 「看不出是谁占着」。别再依赖"抬前台的动作会让锁屏窗口变得可枚举"这种说法：2026-09-07 实测
/// 抬过之后照样枚举不到。
///
/// **也别反过来把它改成吃 `session_locked()`（WTS 会话状态，纯读也准）——算过了，不划算。**
/// 它这条限制今天没有任何行为后果，而且是**结构性保证**的：坐标输入的唯一入口是 TS 侧的
/// `requireForeground`（`src/mcp/desktop-surface.ts`），它一定先 `focusApp`，抬不起来才走到
/// 这里。而 `session_locked()` 会回 `None`（非 Windows / 查询失败），那时仍得退回这条枚举
/// 路——所以收敛下来是**多一个分支，不是少一个**。唯一残留是一个窄race：`focusApp` 成功
/// 之后、坐标 op 之前才被锁屏，`guard_actuation` 会报成 `foreground-lost` 而不是
/// `desktop-locked`。分类不精确，但输入照样一个都没发出去——不值得为它加一条路。
fn foreground_blocker<D: Desktop>(d: &mut D) -> Option<String> {
    let fg = d.windows().ok()?.into_iter().find(|w| w.foreground)?;
    let p = fg.process.to_ascii_lowercase();
    (p == "lockapp.exe" || p == "logonui.exe").then(|| {
        "desktop-locked: 桌面已锁屏——抬不起前台，坐标输入没有可确认的收件人，因此拒绝（读不受影响）".to_string()
    })
}

/// 任何**坐标级输入**之前必过的闸门：必须有一个已确立、且此刻确实在前台的目标窗口。
///
/// 为什么必须有：浏览器的点击有明确收件人（某个 tab），桌面的点击是投给**屏幕坐标**的
/// ——谁在上面谁收下。没有它，"点到了别人的窗口"是一次安静的成功。
///
/// **为什么 `invoke` 不过这道闸**：它有明确收件人——一个由 `find` 命中产生的元素句柄，
/// 动作直接投给那个元素，不算坐标、不受遮挡影响，也就不存在"点到别人窗口"这回事。
/// 而坐标输入没有收件人，只有"屏幕上那个位置"。两条路本质不同，押在同一道闸下的后果是
/// 用户一锁屏、定时桌面采集就整体停摆（锁屏时 UIA invoke 照常生效，活体验过）。
fn guard_actuation<D: Desktop>(d: &mut D) -> Result<(), String> {
    let target = d
        .focus_target()
        .ok_or("no-foreground-target: 还没确立目标窗口，先 focusApp——坐标输入是投给屏幕的，没有收件人")?;
    let fg = d.foreground_window_id()?;
    if fg != target {
        if let Some(locked) = foreground_blocker(d) {
            return Err(locked);
        }
        return Err(format!("foreground-lost: 目标窗口 {target} 已不在前台（现在是 {fg}），拒绝发出输入"));
    }
    Ok(())
}

/// 打字**之后**再确权一次——`guard_actuation` 只管得住"发出去之前"。
///
/// 为什么单独一道：坐标级 op 里只有 `type` 有**时长**（逐字符发送几十毫秒），期间前台可能
/// 被抢走，后半截就打进了别人的窗口。真机上的常客是 `ensureHarvestBrowser` 的 `ensureApp`
/// ——那个 op 立刻返回，Chrome 的窗口几秒后才出现并夺焦；桌面通道的会话租约堵不住它
/// （抢屏发生在租约之外的时间点）。没有这道回读，agent 会一声不吭地回 ok。
///
/// **必须和 `foreground-lost` 分成两档**：那一档说的是"一个输入都没发出去，直接重试即可"，
/// 这一档说的是"可能已经发了一半"——照前者的下一步去重试，就会把同一条消息发两遍。
/// 调用方看到 `foreground-lost-midway` 的正确动作是先去看目标应用的实际状态。
///
/// 只给 `type` 加，`click`/`scroll`/`moveMouse` 不加：它们是瞬时事件，发出去那一刻前台就是
/// 刚查过的那个，没有"打到一半"这回事；给它们加事后回读，只会把无关的前台变化（用户自己
/// 切了个窗口）误报成失败。
fn guard_typing_landed<D: Desktop>(d: &mut D) -> Result<(), String> {
    let Some(target) = d.focus_target() else { return Ok(()) };
    let fg = d.foreground_window_id()?;
    if fg == target {
        return Ok(());
    }
    Err(format!(
        "foreground-lost-midway: 打字过程中目标窗口 {target} 丢了前台（现在是 {fg}）——\
         这次输入**可能只发出去了一部分**，先去看目标应用的实际状态再决定要不要重试，别直接重发"
    ))
}

/// 动作**之后**回读，并如实报出这次走的是哪条路。
///
/// `via` 永远有：`"invoke"` = 元素句柄直达（不经屏幕坐标、不需要前台、锁屏也生效），
/// `"coords"` = 投给屏幕坐标（必须前台确权）。**这个分支原来是隐形的**——同一个 `cdp_act`
/// click，底下"有 ref 走 invoke / 没 ref 走坐标"由调用方看不见的条件决定，而锁屏时行不行
/// 恰恰取决于它。让它显形，调用方才能解释自己拿到的结果。
///
/// `confirmed` 仍是三态：给了 `expect` 才有（true/false），没给就**没有这个字段**——
/// "没验"和"验过且通过"必须分得开，谎报 confirmed:true 比不报更坏。
fn settle<D: Desktop>(d: &mut D, args: &Value, via: &str) -> Result<Value, String> {
    let Some(q) = args.get("expect") else { return Ok(json!({ "via": via })) };
    let hit = !d.find(&parse::<A11yQuery>(q)?)?.is_empty();
    Ok(json!({ "via": via, "confirmed": hit }))
}

/// 「这次空结果**可能是没读到，而不是没有**」——判据只有一条，写成具名函数好让它被搜到、
/// 被钉住（内联的 `if` 两样都做不到）。
///
/// **成因是应用侧的，不是锁屏、也不一定是前台。** 有些应用（QQ NT 这种 Electron）根本不把
/// a11y 树暴露出来，查询返回空数组、不报错，长得就像"这个界面上什么都没有"。
///
/// **别把锁屏当解释**——UIA 在锁屏下照常工作。同一时刻、同样"不在前台"的实测（本机
/// 2026-09-07，屏幕锁着）：`chrome.exe` 读到 **238 个**控件（连页面内容节点都在），
/// `explorer.exe` 读到 4 个，而 `QQ.exe` 只有 8 个满窗大小、无名的 `Pane`——那是 Chromium 的
/// 窗口骨架，渲染层的树压根没建。**"先解锁再读"这条建议曾经写在这儿，是错的**，它把一次
/// 应用侧的缺席归给了会话状态，照做只会白等。
///
/// 这个行为我们改不了，能改的是别让"没读到"和"没有"长得一模一样。
///
/// 三个条件缺一不可，多一个都会变成"狼来了"：
/// - **有命中**就没有歧义。
/// - **没限定过窗口**（在整个桌面上搜）就不猜是谁的树没建——指名一个错的比不说更坏。
/// - 被限定的那个窗口**就在前台**时树该建好了，空就是真的空。
///
/// 返回的是一句人话（`Some` = 挂旗），不是错误：`find` 读空是后台采集的常态（找不到登录墙
/// = 没被墙住），做成错误等于把所有不抢屏的 recipe 一刀切死。
fn empty_may_be_unbuilt<D: Desktop>(d: &mut D, hits: usize) -> Option<String> {
    if hits > 0 {
        return None;
    }
    let scoped = d.scope_target()?;
    let fg = d.foreground_window_id().ok()?;
    if fg == scoped {
        return None;
    }
    // 锁屏时前台恒不是任何应用窗口，于是每次后台读空都会走到这儿。旗照挂——这个空确实
    // 不可采信——但下一步必须换：`focus` 在锁屏下抬不起前台，照默认那句做会撞 desktop-locked。
    // 查不出锁没锁（None）就给默认那句，**不猜**。
    Some(if d.session_locked() == Some(true) {
        format!(
            "a11y-unbuilt: 0 命中，而搜索范围限定的窗口 {scoped} 不在前台（此刻会话锁屏，所以前台\
             恒不是任何应用窗口）。**锁屏本身不挡 UIA**——同一状态下别的应用照样读得到整棵树。\
             所以这个空多半是这个应用没把 a11y 树暴露出来。判法：同一时刻拿 chrome.exe 或 \
             explorer.exe 读一次，那边有树就说明不是锁屏/前台的问题，是这个应用自己的事。\
             别去 focus——锁屏下那一步会被 desktop-locked 拒，而且它多半也治不了这个空。"
        )
    } else {
        format!(
            "a11y-unbuilt: 0 命中，而搜索范围限定的窗口 {scoped} 此刻不在前台（前台是 {fg}）——\
             有些应用的 a11y 树是懒建的，后台窗口读到的空**可能是没读到，不是没有**。要确认就先 \
             focus 那个窗口再读；同一时刻读一下别的应用，也能分清这是普遍现象还是它自己的事。"
        )
    })
}

/// `ensureApp` 之后等新窗口出现的轮询窗口：25 × 400ms = 10s。Chrome 冷启动到第一个窗口
/// 通常 1–3s，10s 只是给磁盘慢的机器留余量；到点没出现就不带 `window` 字段（**不猜**）。
const WINDOW_POLL_ROUNDS: u32 = 25;
const WINDOW_POLL_INTERVAL_MS: u64 = 400;

/// 一个窗口是不是属于目标进程。`WindowInfo.process` 在 Windows 上是 `chrome.exe`、
/// 在 Linux 上是 `chrome`，而 `target_stem` 统一给出小写去后缀的形式——两边对齐再比。
fn belongs_to(w: &WindowInfo, stem: &str) -> bool {
    let p = w.process.to_lowercase();
    p.strip_suffix(".exe").unwrap_or(&p) == stem
}

/// 「新出现的、属于目标进程的」窗口。`before` 是启动前的 id 快照。
fn fresh_windows(before: &[String], wins: &[WindowInfo], stem: &str) -> Vec<WindowInfo> {
    wins.iter()
        .filter(|w| belongs_to(w, stem) && !before.iter().any(|id| id == &w.id))
        .cloned()
        .collect()
}

/// 恰好一个才给答案——零个或多个都是 `None`。**不猜**：这个回执的用途是让
/// "打开 → 拿到窗口 → find/invoke"成为一条不断的链，指错一个窗口比不给更坏。
fn only<T: Clone>(v: &[T]) -> Option<T> {
    (v.len() == 1).then(|| v[0].clone())
}

/// 启动之后把窗口等出来。
///
/// 刚 spawn（`started`）：轮询等**新**窗口冒出来——Chrome 建进程是毫秒级的，画窗口不是，
/// 不等就必然空手而归。冒出两个以上就当场放弃（分不清哪个是目标，再等也不会变清楚）。
/// 本来就在跑：没有"新"窗口可言，直接看该进程此刻有没有唯一可寻址窗口。
fn settled_window<D: Desktop>(d: &mut D, before: &[String], stem: &str, started: bool) -> Option<WindowInfo> {
    if !started {
        let wins = d.windows().ok()?;
        return only(&wins.iter().filter(|w| belongs_to(w, stem)).cloned().collect::<Vec<_>>());
    }
    for round in 0..WINDOW_POLL_ROUNDS {
        if round > 0 {
            d.sleep(WINDOW_POLL_INTERVAL_MS).ok()?;
        }
        let fresh = fresh_windows(before, &d.windows().ok()?, stem);
        if !fresh.is_empty() {
            return only(&fresh);
        }
    }
    None
}

/// Route one op to the backend and shape its JSON result. `args` is `Value::Null` when absent.
/// `dispatch` 认得的全部 op 名。**它是一份要被别处消费的名单**（overlay 靠它做枚举完整性
/// 检查），所以不能只活在下面那个 `match` 的字面量里：加一个 op 只改 match 的话，
/// overlay 那边会默默把它当成"不接管"，而"少亮一次"是静默的——没人会喊。
pub const OP_NAMES: &[&str] = &[
    "windows", "scopeWindow", "focusApp", "ensureApp", "find", "invoke", "setValue",
    "click", "moveMouse", "scroll", "type", "press", "readSubtree", "screenshot", "findImage",
    "readText", "readElements", "url", "sleep", "nudge", "status", "clearInput",
];

/// `status` op 的参数：`{ text }`，`null` = 清掉。收件人是指示条不是桌面，所以它在
/// `main.rs` 的会话循环里、进 `dispatch` 之前就被拦下；这里只负责把 wire 形状解出来。
pub fn status_arg(args: &Value) -> Option<String> {
    args.get("text").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

/// `region` 参数：给了就解析成截图坐标系里的一块，没给（或给了 null）= 整窗。
///
/// **认不出的值必须报错**，别静默当成整窗：一份写错了 region 的 recipe 会安静地退回整窗，
/// 于是"每一步都慢两秒"变成一个没有任何人会喊的性能事故（而那正是 region 存在的理由）。
fn region_arg(args: &Value) -> Result<Option<Rect>, String> {
    match args.get("region") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(parse(v)?)),
    }
}

pub fn dispatch<D: Desktop>(d: &mut D, op: &str, args: &Value) -> Result<Value, String> {
    match op {
        "windows" => serde_json::to_value(d.windows()?).map_err(|e| e.to_string()),
        // 只限定搜索范围,不抢焦点——看一眼不该把用户的窗口拽到前面来
        "scopeWindow" => {
            let w = resolve_window(d, &parse::<AppMatch>(arg(args, "match")?)?)?;
            d.scope_window(&w.id)?;
            Ok(json!({ "window": w }))
        }
        "focusApp" => {
            let w = resolve_window(d, &parse::<AppMatch>(arg(args, "match")?)?)?;
            let ok = d.focus_window(&w.id)?;
            // 抬不上来就说清是谁挡着——锁屏和"别的窗口压着"要分开，两者的下一步相反
            if !ok {
                if let Some(locked) = foreground_blocker(d) {
                    return Err(locked);
                }
            }
            Ok(json!({ "ok": ok, "window": w }))
        }
        // 整个 args 就是 LaunchSpec，字段全可选；无 args 时用默认（= 用户自己那个 Chrome）。
        //
        // 回执里除了「进程活着吗」还带上**开出了哪个窗口**（拿得准的时候）：
        // 「打开 → 拿到窗口 → find/invoke」要成为一条不断的链，每一步都有判据。只报 pid 的话
        // 下一步只能猜标题——而窗口标题带动态前后缀，猜出来的那个 `app:<process>/<title>`
        // 地址十有八九指不中。
        "ensureApp" => {
            let spec: crate::launch::LaunchSpec =
                if args.is_null() { Default::default() } else { parse(args)? };
            let stem = crate::launch::target_stem(&spec);
            // 启动**之前**拍快照：分不清"新开的"和"本来就在的"，回执就没有意义。
            let before: Vec<String> = d.windows().unwrap_or_default().into_iter().map(|w| w.id).collect();
            let out = d.ensure_app(&spec)?;
            let mut v = serde_json::to_value(&out).map_err(|e| e.to_string())?;
            if out.running {
                if let Some(w) = settled_window(d, &before, &stem, out.started) {
                    v["window"] = serde_json::to_value(w).map_err(|e| e.to_string())?;
                }
            }
            Ok(v)
        }
        // 回的是 `{elements}`（**不是裸数组**）：空结果要能带一面「可能没读到」的旗，
        // 而 JSON 数组挂不住字段。旗用「有没有 `unbuilt` 这个键」承载——和 `confirmed` 的
        // 三态同一个纪律：「没验到」必须和「验过了、结果是空」分得开。
        "find" => {
            let els = d.find(&parse::<A11yQuery>(arg(args, "query")?)?)?;
            let unbuilt = empty_may_be_unbuilt(d, els.len());
            let mut v = json!({ "elements": serde_json::to_value(els).map_err(|e| e.to_string())? });
            if let Some(msg) = unbuilt {
                v["unbuilt"] = json!(msg);
            }
            Ok(v)
        }
        // **不过前台闸门**：invoke 的收件人是元素句柄本身，不是屏幕上的某个位置。
        // 见 `guard_actuation` 的注释。
        "invoke" => {
            d.invoke(&s(args, "ref")?)?;
            settle(d, args, "invoke")
        }
        // 同样**不过前台闸门**：收件人是元素句柄。见 `Desktop::set_value`。
        "setValue" => {
            d.set_value(&s(args, "ref")?, &s(args, "text")?)?;
            settle(d, args, "value")
        }
        // 四个坐标 op 各有两条路：默认投给屏幕（enigo，必过前台闸门）；`deliver:"message"` 投给
        // scope 到的窗口（`PostMessage`，有收件人所以**不过闸门**，同 invoke）。见 `Desktop::post_input`。
        "click" => {
            let rect: Rect = parse(arg(args, "rect")?)?;
            let button = args.get("button").and_then(|v| v.as_str()).unwrap_or("left").to_string();
            if deliver_by_message(args)? {
                post_to_scoped(d, PostedInput::Click { rect, button })?;
                return settle(d, args, "message");
            }
            guard_actuation(d)?;
            d.click(&rect, &button)?;
            settle(d, args, "coords")
        }
        // **唯一不过前台闸门的坐标 op，因为它不是 actuation。** 闸门的前提是"坐标输入没有
        // 收件人，谁在那个位置谁收下"——而移动光标**不对任何窗口做事**：它不按、不打字、
        // 不滚，落在别人窗口上最多是一个 hover。把它押在同一道闸下，等于让"这台机器还醒着吗"
        // 这件事没有任何办法表达。
        //
        // 而这件事是硬需求：`PostMessage` 不是"用户输入"，不重置系统空闲计时器、不唤显示器、
        // 也不让 Chromium 把窗口从 occluded 里放出来。机器一闲下来（**不必锁屏**），渲染端
        // 挂起，投进去的点击与按键整份被静默丢弃而 `PostMessage` 照样返回成功。本机
        // 2026-09-08 实测（QQ）：睡着时 `focus-spike plain` 0/6、控件树 0 个；先发一下真实
        // 鼠标移动再点 3/4；机器醒着时 8/8。唯一能叫醒它的就是一次**真实**输入。
        //
        // 覆盖率由 `every_coordinate_op_is_gated` 钉着：那份名单里少一个就是留了一条不确权的
        // 输入通道，所以这条例外在测试里是**显式列名**的，不是靠"忘了加"实现的。
        // 不过前台闸门，理由同 `moveMouse` 且更强：它连指针都不动，什么都没 actuate。
        "nudge" => {
            d.nudge_input()?;
            Ok(json!({}))
        }
        // 到得了这里说明调用方没走会话循环（`verify` 之类直接调 dispatch）：没有指示条可写，
        // 照样回 `{}`——它是提示，不该因为没地方显示就把整趟 recipe 炸掉。
        "status" => {
            let _ = status_arg(args);
            Ok(json!({}))
        }
        "moveMouse" => {
            d.move_mouse(i(args, "x")? as i32, i(args, "y")? as i32)?;
            settle(d, args, "coords")
        }
        "scroll" => {
            let (dir, amount) = (s(args, "dir")?, i(args, "amount")? as i32);
            if deliver_by_message(args)? {
                post_to_scoped(d, PostedInput::Scroll { dir, amount })?;
                return settle(d, args, "message");
            }
            guard_actuation(d)?;
            d.scroll(&dir, amount)?;
            settle(d, args, "coords")
        }
        "type" => {
            let text = s(args, "text")?;
            if deliver_by_message(args)? {
                // 不做 `guard_typing_landed`：那道回读问的是"前台还在不在"，而消息路根本不经前台。
                post_to_scoped(d, PostedInput::Text(text))?;
                return settle(d, args, "message");
            }
            guard_actuation(d)?;
            d.type_text(&text)?;
            guard_typing_landed(d)?;
            settle(d, args, "coords")
        }
        // 和 `type` 同一道闸：键盘事件投给"此刻的焦点窗口"，没有元素级收件人。
        "press" => {
            let key = s(args, "key")?;
            if deliver_by_message(args)? {
                post_to_scoped(d, PostedInput::Key(key))?;
                return settle(d, args, "message");
            }
            guard_actuation(d)?;
            d.press(&key)?;
            settle(d, args, "coords")
        }
        // 两条路：抢屏走真实组合键；投消息走 `PostedInput::Clear`（`WM_CHAR 0x01` 表达全选，
        // 见那条变体的头注——认不认由目标应用定，靠 recipe 下一步的 expect 兜）。
        "clearInput" => {
            if deliver_by_message(args)? {
                post_to_scoped(d, PostedInput::Clear)?;
                return settle(d, args, "message");
            }
            guard_actuation(d)?;
            d.clear_input()?;
            settle(d, args, "coords")
        }
        "readSubtree" => {
            let rows = d.read_subtree(&parse::<ReadSpec>(arg(args, "spec")?)?)?;
            serde_json::to_value(rows).map_err(|e| e.to_string())
        }
        "screenshot" => Ok(match d.screenshot()? {
            Some(shot) => serde_json::to_value(shot).map_err(|e| e.to_string())?,
            None => json!({}),
        }),
        // 没找到回 `{}`（空对象），不是报错：画面里暂时没有那个东西是**正常结果**，
        // 上层要靠它来轮询等待。回 error 会让"还没出现"和"模板解不开"混成一类。
        "findImage" => {
            use base64::Engine as _;
            let png = base64::engine::general_purpose::STANDARD
                .decode(s(args, "template")?)
                .map_err(|e| e.to_string())?;
            Ok(match d.find_image(&png, region_arg(args)?.as_ref())? {
                Some((rect, score)) => json!({ "rect": rect, "score": score }),
                None => json!({}),
            })
        }
        // 两张表分成两条 op，不是一条 op 两个 want：它们的**成本和消费者都不一样**（判据每步
        // 都查文字表，动作只在真要点的时候查元素表），合成一条就等于每次都按最贵的那半付钱。
        "readText" => {
            let r = d.read_text(region_arg(args)?.as_ref())?;
            Ok(json!({
                "texts": serde_json::to_value(r.texts).map_err(|e| e.to_string())?,
                "window": r.window,
                "scale": r.scale,
            }))
        }
        "readElements" => {
            let icons = args.get("icons").and_then(|v| v.as_bool()).unwrap_or(false);
            // 缺省 **true**，方向与 `icons` 相反：`false` 是 recipe 的申报（见 `Desktop::read_elements`），
            // 缺席被当成关就是所有有控件树的应用静默失去 a11y 那一档。
            let a11y = args.get("a11y").and_then(|v| v.as_bool()).unwrap_or(true);
            let r = d.read_elements(region_arg(args)?.as_ref(), icons, a11y)?;
            Ok(json!({
                "elements": serde_json::to_value(r.elements).map_err(|e| e.to_string())?,
                "window": r.window,
                "scale": r.scale,
            }))
        }
        "url" => Ok(json!(d.url()?)),
        "sleep" => {
            d.sleep(i(args, "ms")? as u64)?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown op: {op}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── wire 形状：`platform` / `appVersion` 怎么出现在 JSON 里 ────────────────────
    //
    // 这两格是给后端挑 recipe 落地方式用的，而**跨进程的字段名与"缺席长什么样"没有编译器
    // 管**：`rename` 写错、`skip_serializing_if` 掉了，Rust 这边照编照跑，只有 TS 那侧
    // 读到 undefined——而"读不到版本"和"这个应用没版本资源"长得一模一样。所以钉在这里。

    #[test]
    fn a_window_without_platform_or_version_omits_both_keys() {
        let w = WindowInfo { id: "w0".into(), process: "chrome.exe".into(), title: "标签页".into(), foreground: true, platform: String::new(), app_version: None };
        let j = serde_json::to_value(&w).unwrap();
        // 缺席就是"键不在"，不是空串、也不是 null——消费方只需要认一种缺席。
        assert!(j.get("platform").is_none(), "空 platform 不该出现在 wire 上: {j}");
        assert!(j.get("appVersion").is_none(), "没读到版本就不该有这个键: {j}");
        assert_eq!(j["id"], "w0", "其余字段照常");
    }

    #[test]
    fn platform_and_version_go_out_under_their_wire_names() {
        let w = WindowInfo { id: "w0".into(), process: "WeChat".into(), title: "微信".into(), foreground: true, platform: "win32".into(), app_version: Some("4.0.6".into()) };
        let j = serde_json::to_value(&w).unwrap();
        assert_eq!(j["platform"], "win32");
        // **camelCase**：TS 那侧读的是 `appVersion`，不是 `app_version`。
        assert_eq!(j["appVersion"], "4.0.6");
        assert!(j.get("app_version").is_none(), "蛇形名不该同时出现: {j}");
    }

    #[test]
    fn the_wire_names_round_trip_back_in() {
        // agent → 后端是单向的，但 `WindowInfo` 也被 Deserialize，反过来得认同一套名字。
        let j = serde_json::json!({ "id": "w1", "process": "WeChat", "title": "微信", "foreground": false, "platform": "darwin", "appVersion": "4.0.6" });
        let w: WindowInfo = serde_json::from_value(j).unwrap();
        assert_eq!(w.platform, "darwin");
        assert_eq!(w.app_version.as_deref(), Some("4.0.6"));
    }

    #[test]
    fn an_old_agents_payload_still_parses() {
        // 没升级的 agent 两格都不报——必须解得出来，且缺席要是 `None` / 空串，不是报错。
        let j = serde_json::json!({ "id": "w1", "process": "WeChat", "title": "微信", "foreground": false });
        let w: WindowInfo = serde_json::from_value(j).unwrap();
        assert_eq!(w.platform, "");
        assert_eq!(w.app_version, None);
    }

    /// A fake backend that records calls and answers canned results — proves the dispatch
    /// routes ops and shapes replies, with no OS dependency.
    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        wins: Vec<WindowInfo>,
        /// 已确立的目标窗口 id（`focusApp` 成功后写上）
        focused: Option<String>,
        /// find/read 被限定到的窗口 id（`scopeWindow` / `focusApp` 都会写上）
        scoped: Option<String>,
        /// 此刻**真正**在前台的窗口 id。默认与 `focused` 一致；测"前台被抢走"时改它。
        foreground: String,
        find_hits: bool,
        /// `ensure_app` 之后才"开出来"的窗口——第 `pending_after` 次 sleep 起才出现在 `windows()` 里。
        pending: Vec<WindowInfo>,
        pending_after: u32,
        dwells: u32,
        /// true = 进程本来就在跑（`ensure_app` 回 `started:false`，没 spawn 过）。
        ensure_already_running: bool,
        /// 会话锁没锁。默认 `None` = 查不出来——**默认档就是"不知道"**，这样忘了设的测试
        /// 走的是保守分支，而不是悄悄断言"没锁"。
        session_locked: Option<bool>,
        /// `find_image` 的答案：`None` = 画面里没有它（回 `{}` 那一档）。
        image_hit: Option<(Rect, f64)>,
        /// 打字**打到一半**前台被抢走：`type_text` 一被调用就把前台改成这个 id。
        /// 真机上的对应物是 `ensureApp` 拉起的 Chrome 几秒后才夺焦（见 `guard_typing_landed`）。
        steal_foreground_on_type: Option<String>,
    }

    /// `region` 记进 `calls` 的形状：`full` = 没给（整窗）。**必须记下来**——"下推了裁剪"和
    /// "整窗跑完再筛"回的结果一模一样，只有耗时不同，而耗时不出现在断言里。
    fn region_tag(region: Option<&Rect>) -> String {
        region.map_or("full".to_string(), |r| format!("{},{},{},{}", r.x, r.y, r.w, r.h))
    }

    /// 四个会改变 UI 状态的 op + 它们的最小参数。**做完确认**（expect）必须逐个覆盖到。
    fn actuation_ops() -> Vec<(&'static str, Value)> {
        vec![
            ("click", json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })),
            ("type", json!({ "text": "4K" })),
            ("scroll", json!({ "dir": "down", "amount": 300 })),
            ("press", json!({ "key": "Escape" })),
            ("invoke", json!({ "ref": "r1" })),
            ("setValue", json!({ "ref": "r1", "text": "4K" })),
        ]
    }

    /// **坐标级**输入——投给屏幕、没有收件人，所以前台闸门必须逐个覆盖到（漏一个就是留一条
    /// 不确权的输入通道）。`invoke` 不在这里：它的收件人是元素句柄，见 `guard_actuation`。
    fn coord_ops() -> Vec<(&'static str, Value)> {
        vec![
            ("click", json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })),
            ("type", json!({ "text": "4K" })),
            ("scroll", json!({ "dir": "down", "amount": 300 })),
            ("moveMouse", json!({ "x": 5, "y": 6 })),
            ("press", json!({ "key": "Escape" })),
        ]
    }

    impl Fake {
        fn with_windows(spec: &[(&str, &str)]) -> Self {
            Fake {
                wins: spec
                    .iter()
                    .enumerate()
                    .map(|(i, (p, t))| WindowInfo {
                        id: format!("w{i}"),
                        process: (*p).into(),
                        title: (*t).into(),
                        foreground: i == 0,
                        platform: "win32".into(),
                        app_version: None,
                    })
                    .collect(),
                find_hits: true,
                ..Default::default()
            }
        }
    }

    /// 一个"万事俱备"的 fake：窗口在、目标已确立、前台没被抢、桌面没锁。
    /// 用它测做完确认，免得每个用例重复摆四遍前提。
    fn ready_fake() -> Fake {
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        d.focused = Some("w0".into());
        d.foreground = "w0".into();
        d
    }

    impl Desktop for Fake {
        fn windows(&mut self) -> Result<Vec<WindowInfo>, String> {
            let mut out = self.wins.clone();
            if self.dwells >= self.pending_after {
                out.extend(self.pending.iter().cloned());
            }
            Ok(out)
        }
        fn focus_window(&mut self, id: &str) -> Result<bool, String> {
            self.focused = Some(id.to_string());
            self.scoped = Some(id.to_string());
            self.foreground = id.to_string();
            Ok(true)
        }
        fn scope_window(&mut self, id: &str) -> Result<(), String> {
            self.calls.push(format!("scope:{id}"));
            self.scoped = Some(id.to_string());
            Ok(())
        }
        fn focus_target(&mut self) -> Option<String> {
            self.focused.clone()
        }
        fn scope_target(&mut self) -> Option<String> {
            self.scoped.clone()
        }
        fn foreground_window_id(&mut self) -> Result<String, String> {
            Ok(self.foreground.clone())
        }
        fn session_locked(&mut self) -> Option<bool> {
            self.session_locked
        }
        fn find(&mut self, q: &A11yQuery) -> Result<Vec<A11yElement>, String> {
            self.calls.push(format!("find:{:?}", q.name));
            if !self.find_hits {
                return Ok(vec![]);
            }
            Ok(vec![A11yElement {
                el_ref: "r1".into(),
                role: "Button".into(),
                name: q.name.clone().unwrap_or_default(),
                class_name: "Ui::IconButton".into(),
                rect: Rect { x: 1, y: 2, w: 3, h: 4 },
            }])
        }
        fn invoke(&mut self, r: &str) -> Result<(), String> {
            self.calls.push(format!("invoke:{r}"));
            Ok(())
        }
        fn set_value(&mut self, r: &str, text: &str) -> Result<(), String> {
            self.calls.push(format!("setValue:{r}={text}"));
            Ok(())
        }
        fn click(&mut self, _r: &Rect, b: &str) -> Result<(), String> {
            self.calls.push(format!("click:{b}"));
            Ok(())
        }
        fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String> {
            self.calls.push(format!("move:{x},{y}"));
            Ok(())
        }
        fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String> {
            self.calls.push(format!("scroll:{dir},{amount}"));
            Ok(())
        }
        fn type_text(&mut self, t: &str) -> Result<(), String> {
            self.calls.push(format!("type:{t}"));
            if let Some(thief) = self.steal_foreground_on_type.clone() {
                self.foreground = thief;
            }
            Ok(())
        }
        fn read_subtree(&mut self, _spec: &ReadSpec) -> Result<Vec<serde_json::Map<String, Value>>, String> {
            self.calls.push("read".into());
            let mut m = serde_json::Map::new();
            m.insert("text".into(), json!("hello"));
            Ok(vec![m])
        }
        fn press(&mut self, key: &str) -> Result<(), String> {
            self.calls.push(format!("press:{key}"));
            Ok(())
        }
        fn clear_input(&mut self) -> Result<(), String> {
            self.calls.push("clearInput".into());
            Ok(())
        }
        fn post_input(&mut self, hwnd: &str, input: &PostedInput) -> Result<(), String> {
            self.calls.push(format!("post:{hwnd}:{input:?}"));
            Ok(())
        }
        fn screenshot(&mut self) -> Result<Option<Screenshot>, String> {
            Ok(Some(Screenshot {
                base64: "Zm9v".into(),
                window: Some(Rect { x: 1, y: 2, w: 3, h: 4 }),
                scale: 2.0,
            }))
        }
        fn find_image(&mut self, template_png: &[u8], region: Option<&Rect>) -> Result<Option<(Rect, f64)>, String> {
            self.calls.push(format!("findImage:{}B:{}", template_png.len(), region_tag(region)));
            Ok(self.image_hit.clone())
        }
        fn read_text(&mut self, region: Option<&Rect>) -> Result<TextRead, String> {
            self.calls.push(format!("readText:{}", region_tag(region)));
            Ok(TextRead {
                texts: vec![ScreenText { text: "搜索".into(), rect: Rect { x: 1, y: 2, w: 3, h: 4 } }],
                window: Rect { x: 0, y: 0, w: 100, h: 50 },
                scale: 1.5,
            })
        }
        fn read_elements(&mut self, region: Option<&Rect>, icons: bool, a11y: bool) -> Result<ElementsRead, String> {
            self.calls.push(format!("readElements:{}:icons={icons}:a11y={a11y}", region_tag(region)));
            Ok(ElementsRead {
                elements: vec![Element {
                    rect: Rect { x: 10, y: 20, w: 30, h: 40 },
                    name: Some("发送".into()),
                    kind: ElementKind::Detector,
                }],
                window: Rect { x: 0, y: 0, w: 100, h: 50 },
                scale: 1.5,
            })
        }
        fn url(&mut self) -> Result<String, String> {
            Ok("Telegram.exe#MainWindow".into())
        }
        fn sleep(&mut self, ms: u64) -> Result<(), String> {
            self.calls.push(format!("sleep:{ms}"));
            self.dwells += 1;
            Ok(())
        }
        /// 覆盖默认实现——单测**绝不能真的去 spawn 一个浏览器**。启动逻辑本身在
        /// `launch.rs` 里对着假世界单测；这里只验 dispatch 的解参和回包形状。
        fn ensure_app(
            &mut self,
            spec: &crate::launch::LaunchSpec,
        ) -> Result<crate::launch::EnsureOutcome, String> {
            self.calls.push(format!("ensure:{:?}", spec.profile_directory));
            Ok(crate::launch::EnsureOutcome {
                running: true,
                started: !self.ensure_already_running,
                pid: Some(7),
                process: crate::launch::target_stem(spec),
            })
        }
    }

    #[test]
    fn find_routes_and_returns_elements() {
        let mut d = ready_fake();
        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button", "name": "搜索消息" } })).unwrap();
        assert_eq!(out["elements"][0]["ref"], "r1");
        assert_eq!(out["elements"][0]["name"], "搜索消息");
        assert_eq!(out["elements"][0]["className"], "Ui::IconButton");
        // 有命中就没有歧义——不该挂那面旗
        assert!(out.get("unbuilt").is_none(), "有命中还报 unbuilt：{out}");
    }

    /// **本 change 的承重条**：空结果 + 目标窗口不在前台 = "可能没读到"，不是"没有"。
    /// Chromium/Electron 的 a11y 树是懒建的（QQ.exe 实测 2026-08-27：后台读恒空、不报错，
    /// 提到前台才长出来）。两者今天长得一模一样，调用方只能反推——所以必须挂一面看得见的旗。
    #[test]
    fn empty_find_on_a_background_window_is_flagged_as_maybe_unbuilt() {
        let mut d = Fake::with_windows(&[("explorer.exe", "任务栏"), ("QQ.exe", "QQ")]);
        d.find_hits = false;
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "QQ.exe" } })).unwrap();
        d.foreground = "w0".into(); // 前台是 explorer，QQ 在后台

        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button" } })).unwrap();
        assert_eq!(out["elements"], json!([]));
        let flag = out["unbuilt"].as_str().expect("空 + 后台 必须带 unbuilt");
        assert!(flag.starts_with("a11y-unbuilt:"), "要有可分辨的前缀：{flag}");
        assert!(flag.contains("w1"), "要说清是哪个窗口没读到：{flag}");
    }

    /// 目标窗口就在前台 → 树该建好了，空就是真的空。这里挂旗等于狼来了。
    #[test]
    fn empty_find_on_the_foreground_window_is_not_flagged() {
        let mut d = Fake::with_windows(&[("QQ.exe", "QQ")]);
        d.find_hits = false;
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "QQ.exe" } })).unwrap();
        d.foreground = "w0".into();

        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button" } })).unwrap();
        assert_eq!(out["elements"], json!([]));
        assert!(out.get("unbuilt").is_none(), "前台窗口读空是真的空：{out}");
    }

    /// 没限定过范围（在整个桌面上搜）就**不猜**是谁的树没建——指名一个错的比不说更坏。
    #[test]
    fn empty_find_without_a_scoped_window_is_not_flagged() {
        let mut d = Fake::with_windows(&[("explorer.exe", "任务栏")]);
        d.find_hits = false;
        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button" } })).unwrap();
        assert_eq!(out["elements"], json!([]));
        assert!(out.get("unbuilt").is_none(), "没 scope 就不该指名：{out}");
    }

    /// 锁屏时旗照挂（这个空确实不可采信），但**给的下一步既不能是 focus、也不能是解锁**：
    /// `focus` 在锁屏下抬不起前台，会撞 `desktop-locked`；而"解锁"是**错的因果**——UIA 在锁屏
    /// 下照常工作（本机 2026-09-07 屏幕锁着时 `chrome.exe` 读到 238 个控件，`QQ.exe` 只有 8 个
    /// 无名 `Pane`）。执行不了的指引很坏，**做得到却治不了病**的指引更坏：照着解锁一次、发现
    /// 还是空，才会开始怀疑这句话本身，而那时已经赔进去一次人工。所以下一步得是**能分辨的
    /// 那个动作**——同一时刻读另一个应用。
    ///
    /// 判据走 `session_locked()`（WTS 会话状态，纯读），不是 `foreground_blocker`——后者
    /// 在纯读路径上恒为 false，实测见它的头注。
    #[test]
    fn a_locked_session_points_at_a_discriminating_read_not_at_unlocking() {
        let mut d = Fake::with_windows(&[("explorer.exe", "任务栏"), ("QQ.exe", "QQ")]);
        d.find_hits = false;
        d.session_locked = Some(true);
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "QQ.exe" } })).unwrap();
        d.foreground = "w0".into();

        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button" } })).unwrap();
        let flag = out["unbuilt"].as_str().expect("锁屏下这个空同样不可采信，旗照挂");
        assert!(flag.starts_with("a11y-unbuilt:"), "前缀不变，调用方按前缀分辨：{flag}");
        assert!(flag.contains("锁屏"), "得说清此刻会话是锁着的（这解释了前台为什么不是它）：{flag}");
        assert!(flag.contains("锁屏本身不挡 UIA"), "不许把锁屏说成原因：{flag}");
        assert!(
            flag.contains("chrome.exe") || flag.contains("explorer.exe"),
            "下一步得是「同一时刻读另一个应用」这个能分辨的动作：{flag}"
        );
        assert!(!flag.contains("先 focus"), "锁屏下 focus 做不到，别把它当下一步：{flag}");
        assert!(!flag.contains("先解锁"), "解锁治不了应用侧没暴露树，别把它当下一步：{flag}");
    }

    /// 查不出锁没锁（`None`）就**照常给默认那句**，不猜。把"没验到"讲成"没锁"是这条链路上
    /// 最贵的那类错误——它会让一个执行不了的下一步看起来是经过判断的。
    #[test]
    fn an_unknown_lock_state_falls_back_to_the_plain_message() {
        let mut d = Fake::with_windows(&[("explorer.exe", "任务栏"), ("QQ.exe", "QQ")]);
        d.find_hits = false;
        assert_eq!(d.session_locked, None, "默认档必须是「不知道」");
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "QQ.exe" } })).unwrap();
        d.foreground = "w0".into();

        let out = dispatch(&mut d, "find", &json!({ "query": { "role": "Button" } })).unwrap();
        let flag = out["unbuilt"].as_str().expect("旗照挂");
        assert!(flag.contains("先 focus"), "不知道锁没锁就给默认那句：{flag}");
        assert!(!flag.contains("锁屏"), "没验到就别提锁屏：{flag}");
    }


    #[test]
    fn invoke_click_type_scroll_move_sleep_route() {
        let mut d = ready_fake();
        dispatch(&mut d, "invoke", &json!({ "ref": "r1" })).unwrap();
        dispatch(&mut d, "click", &json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 }, "button": "left" })).unwrap();
        dispatch(&mut d, "type", &json!({ "text": "4K" })).unwrap();
        dispatch(&mut d, "scroll", &json!({ "dir": "down", "amount": 300 })).unwrap();
        dispatch(&mut d, "moveMouse", &json!({ "x": 5, "y": 6 })).unwrap();
        dispatch(&mut d, "sleep", &json!({ "ms": 400 })).unwrap();
        assert_eq!(d.calls, vec!["invoke:r1", "click:left", "type:4K", "scroll:down,300", "move:5,6", "sleep:400"]);
    }

    #[test]
    fn readsubtree_and_url_shape() {
        let mut d = Fake::default();
        let rows = dispatch(&mut d, "readSubtree", &json!({
            "spec": { "itemQuery": { "role": "ListItem" }, "fields": { "text": { "read": "name" } }, "dedupeBy": "text" }
        })).unwrap();
        assert_eq!(rows[0]["text"], "hello");
        // screenshot 的回包形状归 `screenshot_carries_window_and_scale` 管——两处各断言一份
        // 会漂移，而漂移的那一处会先被人当成真相。
        assert_eq!(dispatch(&mut d, "url", &Value::Null).unwrap(), json!("Telegram.exe#MainWindow"));
    }

    /// 静默失效的过滤条件比没有过滤更危险：查询照常返回一批看起来对的元素，第一名可能是完全
    /// 不同的控件，而 click 会把它直接执行掉。所以两个 name 判据同时给 = 当场报错，不退化。
    #[test]
    fn name_and_name_contains_are_mutually_exclusive() {
        let both = A11yQuery {
            name: Some("确定".into()),
            name_contains: Some("确".into()),
            ..Default::default()
        };
        assert!(both.validate().is_err());
        assert!(A11yQuery { name: Some("确定".into()), ..Default::default() }.validate().is_ok());
        assert!(A11yQuery { name_contains: Some("确".into()), ..Default::default() }.validate().is_ok());
        assert!(A11yQuery::default().validate().is_ok());
    }

    #[test]
    fn ensure_app_routes_with_and_without_args() {
        let mut d = Fake::default();
        let out = dispatch(
            &mut d,
            "ensureApp",
            &json!({ "profileDirectory": "Profile 1", "process": "chrome.exe" }),
        )
        .unwrap();
        assert_eq!(out["running"], true);
        assert_eq!(out["started"], true);
        assert_eq!(out["pid"], 7);
        assert_eq!(out["process"], "chrome");
        // 无 args 也得能跑：默认就是"用户自己那个 Chrome"。
        let bare = dispatch(&mut d, "ensureApp", &Value::Null).unwrap();
        assert_eq!(bare["process"], "chrome");
        let ensures: Vec<&String> = d.calls.iter().filter(|c| c.starts_with("ensure:")).collect();
        assert_eq!(ensures, vec!["ensure:Some(\"Profile 1\")", "ensure:None"]);
        // 没有窗口开出来就**不带** window 字段——"我不知道"必须和"是这个"分得开
        assert_eq!(out.get("window"), None);
    }

    // ── ensureApp 的窗口回执：「打开 → 拿到窗口 → find/invoke」要是一条不断的链 ─────
    //
    // 只报 pid 的话下一步只能猜标题，而窗口标题带动态前后缀，猜出来的 `app:<process>/<title>`
    // 地址十有八九指不中。

    #[test]
    fn ensure_app_waits_for_the_window_it_opened() {
        let mut d = Fake::with_windows(&[("Obsidian.exe", "笔记")]); // 无关窗口，启动前就在
        d.pending = vec![WindowInfo {
            id: "new1".into(),
            process: "chrome.exe".into(),
            title: "新标签页 - Google Chrome".into(),
            foreground: true,
            platform: "win32".into(),
            app_version: None,
        }];
        d.pending_after = 3; // 建进程是毫秒级的，画窗口不是——不等就必然空手而归
        let out = dispatch(&mut d, "ensureApp", &json!({ "process": "chrome.exe" })).unwrap();
        assert_eq!(out["window"]["id"], "new1");
        assert_eq!(out["window"]["title"], "新标签页 - Google Chrome");
        assert!(d.calls.iter().any(|c| c == "sleep:400"), "该等就得等");
    }

    #[test]
    fn ensure_app_ignores_windows_that_were_already_there() {
        // 启动前就开着的同进程窗口不是"这次开出来的"——快照必须在 ensure 之前拍
        let mut d = Fake::with_windows(&[("chrome.exe", "老窗口")]);
        let out = dispatch(&mut d, "ensureApp", &json!({ "process": "chrome.exe" })).unwrap();
        assert_eq!(out.get("window"), None, "老窗口不能冒充新开的");
    }

    #[test]
    fn ensure_app_refuses_to_guess_between_two_new_windows() {
        let mut d = Fake::default();
        for (i, t) in ["窗口A", "窗口B"].iter().enumerate() {
            d.pending.push(WindowInfo {
                id: format!("n{i}"),
                process: "chrome.exe".into(),
                title: (*t).into(),
                foreground: false,
                platform: "win32".into(),
                app_version: None,
            });
        }
        d.pending_after = 1;
        let out = dispatch(&mut d, "ensureApp", &json!({ "process": "chrome.exe" })).unwrap();
        assert_eq!(out.get("window"), None, "两个都像就别猜——指错一个比不给更坏");
    }

    #[test]
    fn already_running_reports_its_sole_window_without_waiting() {
        let mut d = Fake::with_windows(&[("chrome.exe", "唯一的窗口")]);
        d.ensure_already_running = true;
        let out = dispatch(&mut d, "ensureApp", &json!({ "process": "chrome.exe" })).unwrap();
        assert_eq!(out["started"], json!(false));
        assert_eq!(out["window"]["title"], "唯一的窗口");
        assert!(!d.calls.iter().any(|c| c.starts_with("sleep:")), "本来就在跑就没什么可等的");
    }

    #[test]
    fn already_running_with_several_windows_stays_silent() {
        let mut d = Fake::with_windows(&[("chrome.exe", "扩展程序"), ("chrome.exe", "新标签页")]);
        d.ensure_already_running = true;
        let out = dispatch(&mut d, "ensureApp", &json!({ "process": "chrome.exe" })).unwrap();
        assert_eq!(out.get("window"), None);
    }

    #[test]
    fn focus_and_unknown_op() {
        let mut d = Fake::with_windows(&[("Telegram.exe", "Telegram")]);
        assert_eq!(dispatch(&mut d, "focusApp", &json!({ "match": { "process": "Telegram.exe" } })).unwrap()["ok"], json!(true));
        assert!(dispatch(&mut d, "nope", &Value::Null).is_err());
    }

    // ── 窗口消歧：进程不够，多窗口时必须能按标题指名 ────────────────────────────
    //
    // 一个进程开着多个窗口是常态（浏览器尤其）。缺这一维时调用方只能靠关掉其他窗口来消歧，
    // 那既有破坏性又不可自动化（2026-08-01 实测：Chrome 同时有账户选择器 + 主窗口，
    // 只有 process/windowClass 完全指不出目标）。

    #[test]
    fn focus_picks_window_by_title_substring() {
        let mut d = Fake::with_windows(&[("chrome.exe", "扩展程序 - Google Chrome"), ("chrome.exe", "新标签页 - Google Chrome")]);
        let out = dispatch(&mut d, "focusApp", &json!({ "match": { "process": "chrome.exe", "title": "扩展程序" } })).unwrap();
        assert_eq!(out["ok"], json!(true));
        // 标题是包含匹配：真实窗口标题带动态前后缀，全等匹配在活体上几乎必然落空
        assert_eq!(d.focused.as_deref(), Some("w0"));
    }

    #[test]
    fn ambiguous_match_lists_candidates_and_refuses() {
        let mut d = Fake::with_windows(&[("chrome.exe", "扩展程序"), ("chrome.exe", "新标签页")]);
        let err = dispatch(&mut d, "focusApp", &json!({ "match": { "process": "chrome.exe" } })).unwrap_err();
        assert!(err.starts_with("ambiguous-window:"), "{err}");
        // 候选必须报出来——不然调用方连"该补什么标题"都不知道
        assert!(err.contains("扩展程序") && err.contains("新标签页"), "{err}");
        assert_eq!(d.focused, None, "歧义时绝不能任选一个去 focus");
    }

    #[test]
    fn no_match_is_its_own_error() {
        let mut d = Fake::with_windows(&[("chrome.exe", "新标签页")]);
        let err = dispatch(&mut d, "focusApp", &json!({ "match": { "process": "telegram.exe" } })).unwrap_err();
        assert!(err.starts_with("no-window-match:"), "{err}");
    }

    #[test]
    fn scope_window_does_not_steal_focus() {
        // 看一眼不该把用户的窗口拽到前面来——scopeWindow 只限定搜索范围
        let mut d = Fake::with_windows(&[("chrome.exe", "扩展程序")]);
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "chrome.exe" } })).unwrap();
        assert_eq!(d.calls, vec!["scope:w0"]);
        assert_eq!(d.focused, None, "读操作绝不能确立焦点目标");
    }

    #[test]
    fn windows_op_lists_addressable_windows() {
        let mut d = Fake::with_windows(&[("chrome.exe", "扩展程序"), ("Telegram.exe", "Telegram")]);
        let out = dispatch(&mut d, "windows", &Value::Null).unwrap();
        // 枚举的用途是"认出目标再动手"——返回的字段必须足以直接拼出 app:<process>/<title>
        assert_eq!(out[0]["process"], "chrome.exe");
        assert_eq!(out[0]["title"], "扩展程序");
        assert_eq!(out[1]["process"], "Telegram.exe");
    }

    // ── 动作闸门：只有一道，且**只管坐标输入**——必须有一个此刻确实在前台的目标窗口 ──
    //
    // **原来还有一道锁屏闸门，实测之后删了**（2026-08-01）：锁着屏 UIA `invoke` 照常能点
    // （活体把 bilibili 画中画开了又关），禁掉它等于用户一锁屏、定时桌面采集就全停。
    // 而且那两个锁屏判据都不可靠：`OpenInputDesktop` 查桌面名 8 次采样恒为 `Default`
    //（锁着也没说过"锁了"），`LogonUI.exe` 在不在时有时无。
    //
    // 锁屏降级成**诊断**：拦住坐标输入的是前台校验，谁占着前台决定这句话怎么说。

    // ── deliver:"message"：投给窗口，不过前台闸门 ──────────────────────────────

    /// 锁着屏、目标从没抬到过前台，四个坐标 op 带 `deliver:"message"` 照样投出去；收件人是 scope
    /// 到的那个窗口。这正是"锁屏也能后台干活"对没有控件树的应用成立的唯一一条路。
    #[test]
    fn message_delivery_skips_the_foreground_gate_and_posts_to_the_scoped_window() {
        let mut d = Fake::with_windows(&[("LockApp.exe", "锁屏"), ("Weixin.exe", "微信")]);
        d.foreground = "w0".into();
        d.session_locked = Some(true);
        dispatch(&mut d, "scopeWindow", &json!({ "match": { "process": "Weixin.exe" } })).unwrap();
        for (op, mut args) in coord_ops() {
            if op == "moveMouse" {
                continue; // 光标位置没有"投给窗口"的语义
            }
            args["deliver"] = json!("message");
            let out = dispatch(&mut d, op, &args).unwrap_or_else(|e| panic!("{op}: {e}"));
            assert_eq!(out["via"], json!("message"), "{op}");
        }
        let posted: Vec<_> = d.calls.iter().filter(|c| c.starts_with("post:w1:")).collect();
        assert_eq!(posted.len(), 4, "{:?}", d.calls);
        assert!(d.calls.iter().any(|c| c.starts_with("post:w1:Text(")), "{:?}", d.calls);
        // 一次都没走屏幕那条路
        assert!(!d.calls.iter().any(|c| c.starts_with("click:") || c.starts_with("type:") || c.starts_with("press:") || c.starts_with("scroll:")), "{:?}", d.calls);
    }

    /// 没 scope 到任何窗口就没有收件人——拒绝，别投给"当前前台"那种猜出来的目标。
    #[test]
    fn message_delivery_without_a_scoped_window_is_refused() {
        let mut d = Fake::with_windows(&[("Weixin.exe", "微信")]);
        let err = dispatch(&mut d, "type", &json!({ "text": "hi", "deliver": "message" })).unwrap_err();
        assert!(err.starts_with("no-scope:"), "{err}");
        assert!(d.calls.is_empty(), "{:?}", d.calls);
    }

    /// 写错的 `deliver` 值必须报错，不能静默退回屏幕路（那等于半夜抢屏）。
    #[test]
    fn unknown_deliver_value_is_an_error_not_a_silent_fallback() {
        let mut d = ready_fake();
        let err = dispatch(&mut d, "type", &json!({ "text": "hi", "deliver": "postmessage" })).unwrap_err();
        assert!(err.contains("unknown deliver"), "{err}");
        assert!(d.calls.is_empty(), "{:?}", d.calls);
    }

    #[test]
    fn lock_screen_is_named_as_the_blocker_not_guessed_at() {
        let mut d = Fake::with_windows(&[("LockApp.exe", "Windows 默认锁屏界面"), ("chrome.exe", "x")]);
        d.wins[0].foreground = true;
        d.focused = Some("w1".into()); // 目标是 chrome，前台却在锁屏界面手里
        d.foreground = "w0".into();
        let err = dispatch(&mut d, "click", &json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })).unwrap_err();
        assert!(err.starts_with("desktop-locked:"), "{err}");
        assert!(d.calls.is_empty(), "拒绝的同时一个输入都不该发出");
    }

    #[test]
    fn ordinary_window_stealing_foreground_is_not_called_a_lock() {
        // 反面：普通窗口抢了前台就说 foreground-lost，别一律甩"锁屏"——
        // 这两句话指向完全相反的下一步（"切过去" vs "去解锁"）。
        let mut d = Fake::with_windows(&[("Obsidian.exe", "笔记"), ("chrome.exe", "x")]);
        d.wins[0].foreground = true;
        d.focused = Some("w1".into());
        d.foreground = "w0".into();
        let err = dispatch(&mut d, "click", &json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })).unwrap_err();
        assert!(err.starts_with("foreground-lost:"), "{err}");
    }

    #[test]
    fn actuation_without_established_target_is_refused() {
        // 坐标输入是投给屏幕的，谁在上面谁收——没确立过目标就点，等于对着别人的窗口乱按
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        let err = dispatch(&mut d, "click", &json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })).unwrap_err();
        assert!(err.starts_with("no-foreground-target:"), "{err}");
        assert!(d.calls.is_empty());
    }

    // ── 打字有时长，闸门只在开头查一次是不够的 ───────────────────────────────────────
    //
    // `guard_actuation` 在**发出之前**确权，挡住的是"一个字都没发"。但 `type_text` 是一段
    // 持续几十毫秒的动作（逐字符），期间前台可能被抢走——真机上的常客是
    // `ensureHarvestBrowser` 的 `ensureApp`：那个 op 立刻返回，Chrome 的窗口几秒后才出现
    // 并夺焦。此时这半条消息已经打进别人的窗口，而 agent 一声不吭地回 ok。
    //
    // 「一个都没发」和「可能发了一半」的下一步是相反的：前者直接重试，后者必须先去看目标
    // 应用的实际状态（重试会把消息发两遍）。所以它们不能共用 `foreground-lost` 这一档。

    #[test]
    fn typing_that_loses_the_foreground_midway_is_reported_not_swallowed() {
        let mut d = ready_fake();
        d.steal_foreground_on_type = Some("w-thief".into());

        let err = dispatch(&mut d, "type", &json!({ "text": "hello" })).unwrap_err();
        assert!(
            err.starts_with("foreground-lost-midway:"),
            "打到一半丢前台必须自成一档（和一个字都没发的 foreground-lost 分开）：{err}"
        );
        assert!(err.contains("w-thief"), "要说清被谁抢走了：{err}");
        assert!(
            d.calls.iter().any(|c| c == "type:hello"),
            "这一档的前提就是字已经发出去了——不许假装没发：{:?}",
            d.calls
        );
    }

    #[test]
    fn typing_that_keeps_the_foreground_reports_nothing_extra() {
        let mut d = ready_fake();
        let out = dispatch(&mut d, "type", &json!({ "text": "hello" })).unwrap();
        assert_eq!(out["via"], "coords");
        assert!(out.get("midway").is_none(), "没被抢就不该有任何多余的旗：{out}");
    }

    /// 逐个回答"这一处该不该也吃它"：click/scroll/moveMouse 是**瞬时**事件，发出去那一刻
    /// 前台就是刚查过的那个，没有"打到一半"这回事；给它们加事后回读只会把无关的前台变化
    /// （用户自己切了个窗口）误报成失败。`type` 是唯一有时长的坐标 op。
    #[test]
    fn instantaneous_coord_ops_do_not_get_the_midway_check() {
        for (op, args) in coord_ops().into_iter().filter(|(op, _)| *op != "type") {
            let mut d = ready_fake();
            d.steal_foreground_on_type = Some("w-thief".into()); // 对这些 op 不起作用
            dispatch(&mut d, op, &args).unwrap_or_else(|e| panic!("{op} 不该因为事后前台变化失败：{e}"));
        }
    }

    #[test]
    fn every_coordinate_op_is_gated() {
        // 逐个覆盖：漏一个就是留了一条不确权的输入通道。
        // **例外只有 `moveMouse` 一个，而且是在这里显式列名的**——它不 actuate 任何东西
        // （不按、不打字、不滚），闸门那句"谁在那个位置谁收下"对它不成立；理由全文见
        // dispatch 里它那一格。列在这里是为了让"放行"永远是一个有人写下的决定，而不是
        // 某次改动漏加闸门的副产品。
        for (op, args) in coord_ops().into_iter().filter(|(op, _)| *op != "moveMouse") {
            let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
            let err = dispatch(&mut d, op, &args).unwrap_err();
            assert!(err.starts_with("no-foreground-target:"), "{op}: {err}");
            assert!(d.calls.is_empty(), "{op} 被拒时不该发出任何输入");
        }
    }

    #[test]
    fn move_mouse_is_the_one_ungated_coord_op() {
        // 没确立过目标窗口也照发——这正是它存在的意义：把渲染端叫醒这件事发生在
        // "还没有任何目标"的时刻。它同时必须仍然出现在 `coord_ops()` 里，好让上面那条
        // 覆盖测试的过滤器有东西可过滤（名单里悄悄少一个 = 例外变成了漏网）。
        assert!(coord_ops().iter().any(|(op, _)| *op == "moveMouse"), "moveMouse 必须留在坐标 op 名单里");
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        dispatch(&mut d, "moveMouse", &json!({ "x": 5, "y": 6 })).unwrap();
        assert_eq!(d.calls, vec!["move:5,6"]);
    }

    // ── invoke 不过前台闸门：它的收件人是元素句柄，不是屏幕上的某个位置 ──────────────
    //
    // 押在同一道闸下的后果是用户一锁屏、定时桌面采集就整体停摆——而锁屏时 UIA invoke
    // 照常生效（2026-08-01 活体：锁着屏把 bilibili 画中画开了又关）。

    #[test]
    fn invoke_works_with_no_established_target() {
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        let out = dispatch(&mut d, "invoke", &json!({ "ref": "r1" })).unwrap();
        assert_eq!(d.calls, vec!["invoke:r1"]);
        assert_eq!(out["via"], "invoke");
    }

    #[test]
    fn invoke_works_while_the_desktop_is_locked() {
        let mut d = Fake::with_windows(&[("LockApp.exe", "Windows 默认锁屏界面"), ("chrome.exe", "x")]);
        d.wins[0].foreground = true;
        d.focused = Some("w1".into()); // 目标是 chrome，前台却在锁屏界面手里
        d.foreground = "w0".into();
        // 同一个 fake 下 click 被拒（见 lock_screen_is_named_as_the_blocker_not_guessed_at），
        // invoke 照常——这个不对称正是分开两条路的全部理由
        let out = dispatch(&mut d, "invoke", &json!({ "ref": "r1" })).unwrap();
        assert_eq!(d.calls, vec!["invoke:r1"]);
        assert_eq!(out["via"], "invoke");
    }

    // ── setValue 和 invoke 同类：收件人是元素句柄，不是屏幕上的某个位置 ─────────────
    //
    // 它存在的全部理由就是这个不对称：键盘 `type` 必须抢屏（投给焦点窗口），而把同一段文字
    // 经 ValuePattern 写进元素则不必——定时采集因此能整轮不碰用户的屏幕。

    #[test]
    fn set_value_works_with_no_established_target() {
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        let out = dispatch(&mut d, "setValue", &json!({ "ref": "r1", "text": "4K" })).unwrap();
        assert_eq!(d.calls, vec!["setValue:r1=4K"]);
        assert_eq!(out["via"], "value");
    }

    #[test]
    fn set_value_works_while_the_desktop_is_locked() {
        let mut d = Fake::with_windows(&[("LockApp.exe", "Windows 默认锁屏界面"), ("chrome.exe", "x")]);
        d.wins[0].foreground = true;
        d.focused = Some("w1".into());
        d.foreground = "w0".into();
        // 同一个 fake 下键盘 type 被拒（every_coordinate_op_is_gated 覆盖），setValue 照常
        let out = dispatch(&mut d, "setValue", &json!({ "ref": "r1", "text": "4K" })).unwrap();
        assert_eq!(d.calls, vec!["setValue:r1=4K"]);
        assert_eq!(out["via"], "value");
    }

    // ── via：走的哪条路必须说出来 ─────────────────────────────────────────────────
    //
    // 同一个 `cdp_act` click，底下"有 ref 走 invoke / 没 ref 走坐标"原来是个隐形分支，
    // 而锁屏时行不行恰恰取决于它。不报出来，调用方解释不了自己拿到的结果。

    #[test]
    fn via_names_the_path_each_op_took() {
        for (op, args) in coord_ops() {
            let mut d = ready_fake();
            let out = dispatch(&mut d, op, &args).unwrap();
            assert_eq!(out["via"], "coords", "{op} 是坐标路");
        }
        let mut d = ready_fake();
        assert_eq!(dispatch(&mut d, "invoke", &json!({ "ref": "r1" })).unwrap()["via"], "invoke");
    }

    #[test]
    fn via_rides_along_with_the_confirmation_verdict() {
        // 两件事各自独立：via 说走了哪条路，confirmed 说效果验没验、兑没兑现
        let mut d = ready_fake();
        d.find_hits = false;
        let out = dispatch(&mut d, "invoke", &json!({ "ref": "r1", "expect": { "name": "没有的东西" } })).unwrap();
        assert_eq!(out["via"], "invoke");
        assert_eq!(out["confirmed"], json!(false));
    }

    #[test]
    fn foreground_lost_between_focus_and_act_is_refused() {
        let mut d = Fake::with_windows(&[("chrome.exe", "x")]);
        d.focused = Some("w0".into());
        d.foreground = "someone-else".into(); // 别的进程把前台抢走了
        let err = dispatch(&mut d, "click", &json!({ "rect": { "x": 1, "y": 2, "w": 3, "h": 4 } })).unwrap_err();
        assert!(err.starts_with("foreground-lost:"), "{err}");
        assert!(d.calls.is_empty(), "抢不到前台就不该发出输入");
    }

    // ── 做完确认：动作发出 ≠ 效果达成 ──────────────────────────────────────────

    #[test]
    fn expect_hit_reports_confirmed() {
        let mut d = ready_fake();
        let out = dispatch(&mut d, "click", &json!({
            "rect": { "x": 1, "y": 2, "w": 3, "h": 4 },
            "expect": { "role": "Text", "name": "已保存" }
        })).unwrap();
        assert_eq!(out["confirmed"], json!(true));
        assert!(d.calls.contains(&"click:left".to_string()));
    }

    #[test]
    fn expect_miss_reports_unconfirmed_not_failure() {
        // 关键区分：动作**确实发出去了**，只是预期没兑现。它不是错误（不该 throw），
        // 但也绝不能报成笼统的成功——调用方要能据此判断"点没点中"。
        let mut d = ready_fake();
        d.find_hits = false;
        let out = dispatch(&mut d, "click", &json!({
            "rect": { "x": 1, "y": 2, "w": 3, "h": 4 },
            "expect": { "role": "Text", "name": "不会出现的东西" }
        })).unwrap();
        assert_eq!(out["confirmed"], json!(false));
        assert!(d.calls.contains(&"click:left".to_string()), "动作本身仍要发出");
    }

    #[test]
    fn no_expect_reports_neither_confirmed_nor_denied() {
        // 没给 expect 就是"没验"，不该谎报 confirmed:true
        let mut d = ready_fake();
        let out = dispatch(&mut d, "type", &json!({ "text": "4K" })).unwrap();
        assert_eq!(out.get("confirmed"), None);
    }

    #[test]
    fn expect_covers_type_scroll_and_invoke_too() {
        for (op, mut args) in actuation_ops() {
            let mut d = ready_fake();
            args["expect"] = json!({ "role": "Text", "name": "ok" });
            let out = dispatch(&mut d, op, &args).unwrap();
            assert_eq!(out["confirmed"], json!(true), "{op} 少了做完确认");
        }
    }

    /// 截图必须自带**它是哪一块像素**：识别层在图上量出一个框之后，要把它加回窗口物理原点
    /// 才能变成可点的屏幕坐标。少了 `window`，那个框只能相对图片自己，谁也不知道它在屏幕哪儿。
    #[test]
    fn screenshot_carries_window_and_scale() {
        let mut d = Fake::default();
        let out = dispatch(&mut d, "screenshot", &Value::Null).unwrap();
        assert_eq!(
            out,
            json!({ "base64": "Zm9v", "window": { "x": 1, "y": 2, "w": 3, "h": 4 }, "scale": 2.0 })
        );
    }

    /// `press` 是键盘输入——投给"此刻的焦点窗口"，没有收件人，所以必须和 `type` 走同一道
    /// 前台闸门。漏掉的话就是留了一条不确权的输入通道（一次 Escape 可能关掉用户自己的对话框）。
    #[test]
    fn press_goes_through_actuation_guard() {
        let mut d = Fake::default();
        d.focused = None; // 还没确立前台目标
        let err = dispatch(&mut d, "press", &json!({ "key": "Escape" })).unwrap_err();
        assert!(err.starts_with("no-foreground-target"), "{err}");
    }

    #[test]
    fn op_names_include_press() {
        assert!(OP_NAMES.contains(&"press"));
    }

    /// 闸门过了就真的按下去，并照常回 `via`（坐标路）。
    #[test]
    fn press_reaches_the_backend_and_reports_coords_path() {
        let mut d = ready_fake();
        let out = dispatch(&mut d, "press", &json!({ "key": "Escape" })).unwrap();
        assert_eq!(out["via"], "coords");
        assert!(d.calls.contains(&"press:Escape".to_string()), "{:?}", d.calls);
    }

    /// 一张真的、能被 `image` 解开的 PNG——测的是"base64 解出来的字节原样到了后端"，
    /// 拿一串随便编的 base64 会让这一步只验到长度。
    fn tiny_png() -> Vec<u8> {
        let img = image::GrayImage::from_fn(4, 3, |x, y| image::Luma([(x * 60 + y * 20) as u8]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageLuma8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn find_image_routes_the_template_and_shapes_the_reply() {
        use base64::Engine as _;
        let png = tiny_png();
        let args = json!({ "template": base64::engine::general_purpose::STANDARD.encode(&png) });

        let mut d = Fake { image_hit: Some((Rect { x: 12, y: 34, w: 16, h: 12 }, 0.97)), ..Default::default() };
        let out = dispatch(&mut d, "findImage", &args).unwrap();
        assert_eq!(out, json!({ "rect": { "x": 12, "y": 34, "w": 16, "h": 12 }, "score": 0.97 }));
        // 模板必须是**解码后的字节**：直接把 base64 字符串递下去，后端会拿到一段解不开的东西
        assert!(d.calls.iter().any(|c| c.starts_with(&format!("findImage:{}B:", png.len()))), "{:?}", d.calls);
        // `region` 原样下推（和 readText 同一套解析），没给就是整窗
        let mut scoped = Fake::default();
        let with_region = json!({ "template": args["template"], "region": { "x": 1, "y": 2, "w": 30, "h": 40 } });
        dispatch(&mut scoped, "findImage", &with_region).unwrap();
        assert!(scoped.calls.iter().any(|c| c.ends_with(&region_tag(Some(&Rect { x: 1, y: 2, w: 30, h: 40 })))), "{:?}", scoped.calls);

        // 没找到 = `{}`，不是错误：上层靠它轮询等一个还没出现的东西
        let mut miss = Fake::default();
        assert_eq!(dispatch(&mut miss, "findImage", &args).unwrap(), json!({}));
    }

    // ── readText / readElements：两张表 ────────────────────────────────────────────
    //
    // 拆成两条 op 的理由在 `Desktop::read_text` 的头注：成本和消费者都不一样。这几条测试
    // 钉住的是 wire 上看得见的那部分——回包形状、region 有没有真的传下去。

    #[test]
    fn read_text_shapes_reply() {
        let mut d = Fake::default();
        let out = dispatch(&mut d, "readText", &Value::Null).unwrap();
        assert_eq!(out["texts"][0]["text"], "搜索");
        assert_eq!(out["texts"][0]["rect"], json!({ "x": 1, "y": 2, "w": 3, "h": 4 }));
        assert_eq!(out["window"], json!({ "x": 0, "y": 0, "w": 100, "h": 50 }));
        assert_eq!(out["scale"], 1.5);
        assert_eq!(d.calls, vec!["readText:full"], "没给 region = 整窗");
    }

    /// **region 必须原样落到后端**。它不是可有可无的优化：整窗一次 PP-OCR 是 1–3.4 秒，
    /// 而"在 dispatch 层收下 region、却让后端整窗跑一遍再筛"回的结果一模一样——只是每一步
    /// 都慢两秒，没有任何一处会喊。
    #[test]
    fn read_ops_push_the_region_down_to_the_backend() {
        let region = json!({ "x": 0, "y": 0, "w": 1946, "h": 125 });
        let mut d = Fake::default();
        dispatch(&mut d, "readText", &json!({ "region": region })).unwrap();
        dispatch(&mut d, "readElements", &json!({ "region": region })).unwrap();
        assert_eq!(d.calls, vec!["readText:0,0,1946,125", "readElements:0,0,1946,125:icons=false:a11y=true"]);
    }

    /// 认不出的 region 当场报错，别静默退回整窗——那会把一个性能事故变成没人会喊的事。
    #[test]
    fn a_malformed_region_is_an_error_not_a_silent_full_window_read() {
        let mut d = Fake::default();
        assert!(dispatch(&mut d, "readText", &json!({ "region": "整个窗口" })).is_err());
        assert!(d.calls.is_empty(), "解不开 region 就不该让后端白读一遍：{:?}", d.calls);
    }

    /// 元素表原样出到 wire 上，含 `kind`（哪一档给的框）。`kind` 是**失败时唯一能分辨
    /// a11y / 检测器 / 文字三种失因的东西**，削掉它三种错就长得一模一样。
    #[test]
    fn read_elements_shapes_reply() {
        let mut d = Fake::default();
        let out = dispatch(&mut d, "readElements", &json!({ "icons": true })).unwrap();
        assert_eq!(
            out["elements"],
            json!([{ "rect": { "x": 10, "y": 20, "w": 30, "h": 40 }, "name": "发送", "kind": "detector" }])
        );
        assert_eq!(out["window"], json!({ "x": 0, "y": 0, "w": 100, "h": 50 }));
        assert_eq!(d.calls, vec!["readElements:full:icons=true:a11y=true"]);
    }

    /// `icons` 默认是 false：检测器是这条 op 里第二贵的一步，默认跑等于每个只要 a11y 的
    /// 调用方都替它付钱。
    #[test]
    fn read_elements_does_not_run_the_detector_unless_asked() {
        let mut d = Fake::default();
        dispatch(&mut d, "readElements", &Value::Null).unwrap();
        assert_eq!(d.calls, vec!["readElements:full:icons=false:a11y=true"]);
    }

    /// `a11y:false` 是 recipe 作者的申报（"这个应用没有控件树"），要原样落到后端——后端靠它
    /// 跳过控件树枚举。缺省 `true`：不给就是今天的行为；这里绝不能像 `icons` 那样默认关，
    /// 关了之后所有有控件树的应用会静默失去 a11y 那一档，而每一步照样"成功"。
    #[test]
    fn read_elements_passes_the_a11y_declaration_down_and_defaults_to_on() {
        let mut d = Fake::default();
        dispatch(&mut d, "readElements", &json!({ "a11y": false })).unwrap();
        dispatch(&mut d, "readElements", &json!({ "a11y": true })).unwrap();
        dispatch(&mut d, "readElements", &json!({ "icons": true })).unwrap();
        assert_eq!(
            d.calls,
            vec![
                "readElements:full:icons=false:a11y=false",
                "readElements:full:icons=false:a11y=true",
                "readElements:full:icons=true:a11y=true",
            ]
        );
    }

    /// 两条读 op 都是纯读——不动指针、不夺焦，归 `QUIET`（同 `findImage`）。
    #[test]
    fn the_read_ops_are_known_quiet_ops() {
        for op in ["readText", "readElements"] {
            assert!(OP_NAMES.contains(&op), "{op}");
            assert!(crate::overlay::QUIET.contains(&op), "{op}");
            assert!(!crate::overlay::touches_screen(op), "{op}");
        }
    }

    /// `findImage` 是纯读——不动指针、不夺焦，所以归 `QUIET`（条子亮 = 你现在别碰鼠标，
    /// 一次找图就闪一下的话这个信号会被用户学会忽略）。
    #[test]
    fn find_image_is_a_known_quiet_op() {
        assert!(OP_NAMES.contains(&"findImage"));
        assert!(crate::overlay::QUIET.contains(&"findImage"));
        assert!(!crate::overlay::touches_screen("findImage"));
    }
}
