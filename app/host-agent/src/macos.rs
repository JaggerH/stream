//! macOS 桌面后端：a11y 走 `AXUIElement`（ApplicationServices），输入走 enigo，截图走
//! `CGWindowListCreateImage`（按窗口 id 截整窗，不经屏幕——被盖住、在后台照截）。
//!
//! 识别层（PP-OCR `ocr.rs`、模板匹配 `see.rs`、检测器 `see_detect.rs`）是平台无关的，这里只补
//! "取图"那一环和元素表的 a11y 那一档；模型放哪、怎么惰性加载、region 怎么裁与 Windows 共用
//! `see::SeeEngines` 那一份。
//!
//! ## 坐标口径：wire 上一律是**点**（point），不是物理像素
//!
//! Windows 那份 wire 上的 rect 全是物理像素（进程声明了 DPI 感知，UIA / 截图 / SendInput 三处
//! 天然同一套）。mac 上天然同一套的是**点**：AX 的 `AXPosition`/`AXSize`、`CGEvent`（enigo 的
//! click / move）、CGWindowList 的 `kCGWindowBounds` 全是点；Retina 上截图是 2× 的物理像素，
//! 只有它一个不是。所以这里把**截图那一端**换算到点，而不是把其余四处换成物理像素：
//!
//! - 识别（OCR / 检测器）以**物理分辨率**的坐标出框，出门前把框 ÷ scale。OCR 的**检测**在缩到 1×
//!   的图上跑（det 成本按面积走，2× 是 4 倍时间），框乘回物理后**识别从物理像素上裁**（1× 上识别
//!   会掉字，见 `see::SeeEngines::ocr_texts`）；图标检测器仍吃物理图；
//! - `screenshot()` 交出去的图**缩到点分辨率**（宽高 == `window.w/h`），供 `point` 档的视觉模型
//!   与 `find_image` 的模板取材——模板从这张图上抠，所以 `find_image` 也在点分辨率的画面上找；
//! - `read_text` / `read_elements` 的 `region` 是点，进门 × scale 再裁。
//!
//! `scale`（= 截图像素宽 ÷ 窗口点宽，Retina 2.0）只作诊断与缓存键，和 Windows 同一条约定：
//! 谁拿它去除坐标谁就在造第三套坐标系。判据（活体可验）：`see-probe` 打出来的
//! `screenshot.imageW/H == rect.w/h`，且文字框加回 `rect` 原点后落在 AX 报的那个控件框里。
//!
//! ## 三件和 Windows 不一样、会把人带沟里的事（都是 2026-09-07 在真机上撞出来的）
//!
//! 1. **文件选择面板不是独立窗口，是 Chrome 窗口里的一个 `AXSheet`**（`id=open-panel`）。
//!    Windows 那边它是一个独立顶层窗口，所以 recipe 要先 `scopeWindow` 换过去；mac 上
//!    **不能换**——它压根不在 `AXWindows` 里。更坑的是它**也不在窗口的 `AXSheets` 属性里**
//!    （实测那个属性恒为 0），只在 `AXChildren` 里躺着。所以 `find` 必须老老实实走 children
//!    深度遍历，不能走 `AXSheets` 抄近路：抄了就会得出「对话框根本没打开」的结论，而它明明开着。
//!
//! 2. **名字有三个来源，必须都看**：原生控件（地址栏、工具栏按钮）的名字在 `AXDescription`
//!    里，网页/WebUI 元素（「开发者模式」「加载未打包的扩展程序」「选择」）在 `AXTitle` 里，
//!    还有一些只有 `AXValue`。只读其中一个的表现是「这个控件不存在」——和界面语言不对、
//!    Chrome 改版长得一模一样，排查的人无从下手。
//!
//! 3. **`set_value` 必须连焦点一起设**。只写 `AXValue` 不设 `AXFocused`，值确实写进去了
//!    （回读得到），但**紧接着的回车不提交**——面板的「前往文件夹」框卡在原地，而每一步都
//!    "成功"。实测卡了两轮才定位。所以这里的 `set_value` 是「聚焦 + 写值 + 回读确认」三件事，
//!    不是一件。
//!
//! ## 授权
//!
//! 全部 AX 能力都要「辅助功能」（TCC Accessibility）授权，授给的是**起这个进程的那个应用**
//! （从 Terminal 起就是 Terminal，从 ssh 起就是 sshd）。没授权时 AX 调用一律失败，
//! `AXIsProcessTrusted()` 报 false —— 我们在 `windows()` 里就把这一句翻成人话，
//! 而不是让每个动词各自吐一个 `kAXErrorAPIDisabled`。
//!
//! 截图另需「屏幕录制」授权，且**缺了不报错、只给一张空白图**（没有窗口内容，只剩壁纸 / 纯色）
//! ——所以 `capture_window` 先问 `CGPreflightScreenCaptureAccess()`，没有就如实报错；拿到图之后
//! 还再验一次"这张图是不是纯色"，两道闸都过了才交给 OCR。**绝不让下游去啃壁纸**：那会得出
//! 一张像模像样的空文字表。授给的同样是**起这个进程的那个应用**（ssh 起 = `sshd-keygen-wrapper`，
//! 后端起 = 起后端的那个终端 / Stream 自己）。

use std::collections::HashMap;

use accessibility_sys::{
    kAXErrorSuccess, kAXValueTypeCGPoint, kAXValueTypeCGSize, AXError, AXIsProcessTrusted,
    AXUIElementCopyAttributeValue, AXUIElementCreateApplication, AXUIElementPerformAction,
    AXUIElementRef, AXUIElementSetAttributeValue, AXUIElementSetMessagingTimeout, AXValueGetValue,
    AXValueRef,
};
use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};
use enigo::{
    Axis,
    Button::{Left, Middle, Right},
    Coordinate::Abs,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};

use crate::protocol::{
    A11yElement, A11yQuery, Desktop, ReadSpec, Rect, Screenshot, WindowInfo,
};
use crate::see::SeeEngines;

// ── AXUIElement 的 RAII 包装 ────────────────────────────────────────────────
//
// `AXUIElementRef` 是 CFType，拿到手是 +1 引用（Copy/Create 规则），必须自己放。
// 用一个带 Drop 的壳兜住，避免每条错误路径都要记得 CFRelease。

struct AXElem(AXUIElementRef);

impl AXElem {
    /// 接管一个 +1 引用（`AXUIElementCopy*` / `AXUIElementCreate*` 的返回值）。
    unsafe fn from_create(r: AXUIElementRef) -> Option<Self> {
        (!r.is_null()).then(|| AXElem(r))
    }
    fn as_ref(&self) -> AXUIElementRef {
        self.0
    }
}

impl Clone for AXElem {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0 as CFTypeRef) };
        AXElem(self.0)
    }
}

impl Drop for AXElem {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

// ── 属性读写的小工具 ────────────────────────────────────────────────────────

fn cfstr(s: &str) -> CFString {
    CFString::new(s)
}

/// 读一个属性，拿到 +1 的 `CFTypeRef`；属性不存在 / 读失败一律 `None`。
///
/// **「读不到」不当错误**：a11y 树上绝大多数节点没有绝大多数属性，把它当错误会让每一次
/// 遍历都被淹没在噪声里。真正的故障（没授权）在 `windows()` 那一处集中翻译。
unsafe fn copy_attr(el: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
    let key = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
    (err == kAXErrorSuccess && !out.is_null()).then_some(out)
}

/// 读一个字符串属性。空串按「没有」处理——空名字在匹配里没有意义，留着只会让
/// 「三个来源都看」退化成「第一个来源是空的就不看后面了」。
///
/// **必须先验类型再转，不能直接 `as CFStringRef`。** 同一个属性名在不同控件上是不同类型的：
/// `AXValue` 在文本框上是 CFString，在 `AXCheckBox` / `AXHeading` 上是 **CFBoolean / CFNumber**。
/// 硬转的后果不是拿到一个怪字符串，而是**整个进程当场死掉**——CFString 的方法被发给一个
/// NSNumber，Objective-C 抛 `unrecognized selector`，而那是个 ObjC 异常，Rust 的
/// panic hook 拦不住它，agent 直接消失。活体撞到过（2026-09-07）：recipe 走到第 1 步 `find`
/// 地址栏，遍历到某个 AXCheckBox 就整条中继断了，后端只看到「host agent not connected」——
/// **真因离现场很远**。Swift 那边的 `as? String` 天然安全，照抄过来就会漏掉这一步。
fn str_attr(el: AXUIElementRef, name: &str) -> Option<String> {
    unsafe {
        let v = copy_attr(el, name)?;
        if CFGetTypeID(v) != CFString::type_id() {
            CFRelease(v);
            return None;
        }
        let s = CFString::wrap_under_create_rule(v as CFStringRef).to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// 同 `str_attr`：先验类型。`AXMain`/`AXFrontmost` 在某些元素上可能压根不是布尔。
fn bool_attr(el: AXUIElementRef, name: &str) -> Option<bool> {
    unsafe {
        let v = copy_attr(el, name)?;
        if CFGetTypeID(v) != CFBoolean::type_id() {
            CFRelease(v);
            return None;
        }
        Some(CFBoolean::wrap_under_create_rule(v as _).into())
    }
}

/// 一个元素的子节点。
fn children(el: AXUIElementRef) -> Vec<AXElem> {
    unsafe {
        let Some(v) = copy_attr(el, "AXChildren") else {
            return vec![];
        };
        let arr = v as CFArrayRef;
        let n = CFArrayGetCount(arr);
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let item = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
            if !item.is_null() {
                CFRetain(item as CFTypeRef);
                if let Some(e) = AXElem::from_create(item) {
                    out.push(e);
                }
            }
        }
        CFRelease(v);
        out
    }
}

/// 元素的屏幕 rect（AX 的坐标系已经是左上原点的全局点坐标，和 `CGEvent` 一致，不用翻转）。
fn rect_of(el: AXUIElementRef) -> Rect {
    let mut pos = CGPoint { x: 0.0, y: 0.0 };
    let mut size = CGSize { width: 0.0, height: 0.0 };
    unsafe {
        if let Some(v) = copy_attr(el, "AXPosition") {
            AXValueGetValue(v as AXValueRef, kAXValueTypeCGPoint, &mut pos as *mut _ as *mut _);
            CFRelease(v);
        }
        if let Some(v) = copy_attr(el, "AXSize") {
            AXValueGetValue(v as AXValueRef, kAXValueTypeCGSize, &mut size as *mut _ as *mut _);
            CFRelease(v);
        }
    }
    Rect {
        x: pos.x as i32,
        y: pos.y as i32,
        w: size.width as i32,
        h: size.height as i32,
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

fn ax_err(what: &str, err: AXError) -> String {
    format!("{what} 失败（AXError {err}）")
}

/// 一个元素**所有**可能充当「名字」的字符串。
///
/// 顺序即优先级，但匹配时三个都要试（见文件头注第 2 条）：原生控件在 `AXDescription`、
/// WebUI 元素在 `AXTitle`、还有些只有 `AXValue`。
fn names_of(el: AXUIElementRef) -> Vec<String> {
    ["AXTitle", "AXDescription", "AXValue"]
        .iter()
        .filter_map(|a| str_attr(el, a))
        .collect()
}

/// 报给上层的那个 name：取第一个非空的，和 `names_of` 同一优先级。
fn primary_name(el: AXUIElementRef) -> String {
    names_of(el).into_iter().next().unwrap_or_default()
}

// ── role 映射 ──────────────────────────────────────────────────────────────

/// 中性 role（Windows/UIA 那套词）→ macOS 的 `AXRole`。
///
/// **两条规矩，缺一不可**：
/// - **`AX` 开头的原样透传**。mac 的控件表就是照真机 dump 出来的 `AXCheckBox`/`AXSheet`
///   这种原生名字写的（见 `src/browser/chrome-ext-page.ts` 的 macOS 那半张表），
///   硬要它们先翻译成中性词再翻回来，只是多一道会漂移的转换。
/// - **认不出的一律报错**，绝不当没写。理由同 `windows.rs` 的 `role_to_control`：
///   过滤条件静默失效比没有过滤更危险——查询照样返回一批看着对的元素，第一名可能是
///   完全不同的控件，而 `invoke` 会把它直接执行掉。
fn role_to_ax(role: &str) -> Result<String, String> {
    if role.starts_with("AX") {
        return Ok(role.to_string());
    }
    Ok(match role {
        "Button" => "AXButton",
        "Text" => "AXStaticText",
        "Edit" => "AXTextField",
        "CheckBox" => "AXCheckBox",
        "RadioButton" => "AXRadioButton",
        "ComboBox" => "AXComboBox",
        "List" => "AXList",
        // mac 的列表行是 AXRow（Outline/Table 都是），不是 UIA 那个 ListItem。
        "ListItem" | "TreeItem" => "AXRow",
        "DataItem" => "AXCell",
        "Group" | "Pane" => "AXGroup",
        "Window" => "AXWindow",
        "Tab" => "AXTabGroup",
        // mac 的标签页是带 AXTabButton subrole 的 AXRadioButton（实测 Chrome 的标签条）。
        "TabItem" => "AXRadioButton",
        "Hyperlink" => "AXLink",
        "MenuItem" => "AXMenuItem",
        "ToolBar" => "AXToolbar",
        "Image" => "AXImage",
        "Document" => "AXWebArea",
        other => {
            return Err(format!(
                "unknown role '{other}'——认不出的 role 不能当没写（那会让过滤静默失效、错误元素顶上来）。\
                 mac 上也可以直接写原生 AX 名（如 AXCheckBox / AXSheet），会原样透传。"
            ))
        }
    }
    .to_string())
}

// ── 后端本体 ───────────────────────────────────────────────────────────────

pub struct MacDesktop {
    enigo: Enigo,
    /// `find` 命中的元素，按不透明 ref 存着，给 `invoke`/`setValue` 用。
    elements: HashMap<String, AXElem>,
    next_ref: u64,
    /// `focus_window` 确立过的目标窗口 id。
    focus_target: Option<String>,
    /// `find`/`read` 此刻限定到的窗口 id。
    scope_target: Option<String>,
    /// 已经发出去的窗口 id ↔ 它对应的那个 AX 元素。
    ///
    /// **窗口 id 必须绑在元素身份上，不能绑在「它在 `AXWindows` 里排第几」上。**
    /// macOS 的 `AXWindows` 是**按 z 序**排的：把一个窗口抬到前台，它就跳到下标 0，
    /// 别的窗口跟着后移。于是 `focus_window` 记下的 `pid/1` 在下一次回读时指的已经是另一个
    /// 窗口了——`guard_actuation` 比 `focus_target` 和当前前台，比出不相等，报
    /// `foreground-lost`。活体撞到过（2026-09-07）：整条 recipe 死在第 2 步打字，
    /// 报的是「打字过程中目标窗口丢了前台」，而**前台一直是对的**，漂的是编号。
    windows_seen: Vec<(String, AXElem)>,
    next_window: u64,
    /// 识别层的两个引擎（PP-OCR + 图标检测器），惰性加载、与 Windows 共用一份（`see::SeeEngines`）。
    see: SeeEngines,
    /// 每个进程**上一次报出来的**控件树条数（`None` = 上次超预算作废）。只用于日志限流，
    /// 让日志只在**结果变了**的时候出声（同 Windows 那份）。
    a11y_last_report: HashMap<String, Option<usize>>,
}

impl Default for MacDesktop {
    fn default() -> Self {
        MacDesktop {
            enigo: Enigo::new(&Settings::default()).expect("enigo init"),
            elements: HashMap::new(),
            next_ref: 0,
            focus_target: None,
            scope_target: None,
            windows_seen: Vec::new(),
            next_window: 0,
            see: SeeEngines::default(),
            a11y_last_report: HashMap::new(),
        }
    }
}

/// 两个 `AXUIElementRef` 指的是不是同一个窗口。
///
/// AX 元素的 `CFEqual` 比的是"它代表哪个东西"（进程 + 元素身份），不是指针地址——所以
/// 两次分别取回来的同一个窗口比得出相等。窗口身份**只能这么比**，见 `MacDesktop::id_for`。
fn same_element(a: &AXElem, b: &AXElem) -> bool {
    unsafe { core_foundation::base::CFEqual(a.as_ref() as CFTypeRef, b.as_ref() as CFTypeRef) != 0 }
}

/// 一个窗口元素属于哪个进程。
fn pid_of(el: &AXElem) -> Option<i32> {
    let mut pid: i32 = 0;
    let err = unsafe { accessibility_sys::AXUIElementGetPid(el.as_ref(), &mut pid) };
    (err == kAXErrorSuccess).then_some(pid)
}

/// 某个进程的 AX 应用元素。设一个消息超时，免得对着一个卡住的应用把整条中继拖死。
fn app_element(pid: i32) -> Option<AXElem> {
    unsafe {
        let el = AXUIElementCreateApplication(pid);
        let e = AXElem::from_create(el)?;
        AXUIElementSetMessagingTimeout(e.as_ref(), 2.0);
        Some(e)
    }
}

/// 让一个应用把**网页内容**也暴露进 a11y 树。
///
/// **不打开它，Chrome 的树里只有浏览器外壳**——工具栏、地址栏、标签条都在，而
/// `chrome://extensions` 页面里的每一个控件（「开发者模式」「加载未打包的扩展程序」「选择」）
/// 一个都不在。这是 Chromium 的按需策略：网页 a11y 很贵，没有客户端要就不建。
///
/// 失败得极其误导：前四步——找 Chrome 窗口、往地址栏写、回车、认出扩展页窗口——**全都过**，
/// 因为它们碰的都是外壳；然后卡在「等页面里的开关出现」上，报出来的是
/// 「可能是这台机器的界面语言不在候选表里」。语言没问题，是**树里压根没有网页那一半**。
/// 活体撞到过（2026-09-07），排查方向被这句话带偏了一轮。
///
/// 两个键都设：Chromium 认 `AXEnhancedUserInterface`，Electron 那一系认
/// `AXManualAccessibility`。设错的那个会被忽略，不会报错，所以两个都发比先判断它是谁便宜。
fn enable_web_a11y(pid: i32) {
    let Some(app) = app_element(pid) else { return };
    unsafe {
        let t = CFBoolean::true_value();
        for key in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
            AXUIElementSetAttributeValue(
                app.as_ref(),
                cfstr(key).as_concrete_TypeRef(),
                t.as_CFTypeRef(),
            );
        }
    }
}

fn app_windows(pid: i32) -> Vec<AXElem> {
    let Some(app) = app_element(pid) else {
        return vec![];
    };
    unsafe {
        let Some(v) = copy_attr(app.as_ref(), "AXWindows") else {
            return vec![];
        };
        let arr = v as CFArrayRef;
        let n = CFArrayGetCount(arr);
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let item = CFArrayGetValueAtIndex(arr, i) as AXUIElementRef;
            if !item.is_null() {
                CFRetain(item as CFTypeRef);
                if let Some(e) = AXElem::from_create(item) {
                    out.push(e);
                }
            }
        }
        CFRelease(v);
        out
    }
}

/// 进程所属 `.app` 的 `CFBundleShortVersionString`（用户看到的那个版本号，如 `4.0.6`，
/// 不是 `CFBundleVersion` 那个构建号）。路径来自 sysinfo 的 exe；沿路径往上找 `.app` 目录，
/// 用 CFBundle 读 Info.plist。不是 bundle（命令行程序）就缺席——**不给空串**。
///
/// **取最外层那个 `.app`，不是最里层。** `.app` 会套 `.app`：主程序的 `Contents/Frameworks/`
/// 或 `Contents/XPCServices/` 里常住着 helper bundle（Chrome 的
/// `Google Chrome.app/Contents/Frameworks/…/Google Chrome Helper.app`）。helper 的版本
/// 号是它自己的，不是用户认得的那个应用版本——而 `ancestors()` 是从 exe 往上走，先撞到的
/// 恰恰是最里层那个。所以这里扫完全部祖先再取最后一个命中。
fn bundle_version(sys: &sysinfo::System, pid: i32) -> Option<String> {
    use core_foundation::bundle::CFBundle;
    use core_foundation::url::CFURL;
    let exe = sys.process(sysinfo::Pid::from_u32(pid as u32))?.exe()?.to_path_buf();
    let app = exe
        .ancestors()
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .last()?;
    let url = CFURL::from_path(app, true)?;
    let bundle = CFBundle::new(url)?;
    let v = bundle
        .info_dictionary()
        .find(&cfstr("CFBundleShortVersionString"))?
        .downcast::<CFString>()?
        .to_string();
    (!v.is_empty()).then_some(v)
}

/// 屏上有窗口的那些进程（pid → 进程名）。
///
/// 用 `CGWindowListCopyWindowInfo` 拿 pid + owner 名，而**不是**拿窗口标题：标题
/// （`kCGWindowName`）要「屏幕录制」授权，没授权时是空串且不报错。标题一律走 AX 读。
fn gui_processes() -> Vec<(i32, String)> {
    use core_foundation::dictionary::CFDictionaryRef;
    use core_foundation::number::CFNumber;

    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;

    let mut seen: Vec<(i32, String)> = Vec::new();
    unsafe {
        let arr = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if arr.is_null() {
            return seen;
        }
        let n = CFArrayGetCount(arr);
        for i in 0..n {
            let d = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
            if d.is_null() {
                continue;
            }
            // 同 `str_attr`：**先验类型再转**。这两个键的类型是文档写死的，但硬转一旦碰上
            // 别的类型就是 ObjC 异常直接杀进程（不是 panic，拦不住），代价和收益完全不成比例。
            let pid = dict_get(d, "kCGWindowOwnerPID")
                .and_then(|v| {
                    if CFGetTypeID(v) != CFNumber::type_id() {
                        CFRelease(v);
                        return None;
                    }
                    CFNumber::wrap_under_create_rule(v as _).to_i64()
                })
                .map(|v| v as i32);
            let name = dict_get(d, "kCGWindowOwnerName").and_then(|v| {
                if CFGetTypeID(v) != CFString::type_id() {
                    CFRelease(v);
                    return None;
                }
                Some(CFString::wrap_under_create_rule(v as CFStringRef).to_string())
            });
            if let (Some(pid), Some(name)) = (pid, name) {
                if !seen.iter().any(|(p, _)| *p == pid) {
                    seen.push((pid, name));
                }
            }
        }
        CFRelease(arr as CFTypeRef);
    }
    seen
}

/// 从 CFDictionary 取一项，回 **+1** 的引用（调用方 wrap_under_create_rule 接管）。
unsafe fn dict_get(
    d: core_foundation::dictionary::CFDictionaryRef,
    key: &str,
) -> Option<CFTypeRef> {
    use core_foundation::dictionary::CFDictionaryGetValueIfPresent;
    let k = cfstr(key);
    let mut out: *const std::ffi::c_void = std::ptr::null();
    let found = CFDictionaryGetValueIfPresent(d, k.as_concrete_TypeRef() as _, &mut out);
    if found == 0 || out.is_null() {
        return None;
    }
    CFRetain(out as CFTypeRef);
    Some(out as CFTypeRef)
}

impl MacDesktop {
    /// `find` 的搜索根：此刻限定到的那个窗口。
    ///
    /// **没限定就报错，不去整个桌面上搜。** 桌面级搜索在 Windows 那边撞过真事（别的窗口的
    /// 元素漏进结果），mac 上还更贵（要遍历每个应用的整棵树）。recipe 一律先 `scopeWindow`。
    fn scope_root(&self) -> Result<AXElem, String> {
        let id = self.scope_target.as_deref().ok_or(
            "no-scope: 还没限定搜索范围，先 scopeWindow / focusApp——不限定就是在整个桌面上搜，\
             别的窗口的元素会漏进结果",
        )?;
        self.window_by_id(id)
    }

    /// 这个窗口元素的 id：见过就还它原来那个，没见过就发一个新的。
    ///
    /// 「见过」按 `CFEqual` 判（`same_element`），不按下标——下标会随 z 序变。
    fn id_for(&mut self, el: &AXElem) -> String {
        if let Some((id, _)) = self.windows_seen.iter().find(|(_, e)| same_element(e, el)) {
            return id.clone();
        }
        let id = format!("win-{}", self.next_window);
        self.next_window += 1;
        self.windows_seen.push((id.clone(), el.clone()));
        // 长命 agent 上这张表只增不减；关掉的窗口留在表里只是一个再也匹配不上的条目，
        // 不影响正确性。给一个上限纯粹是防它无界增长（一趟 recipe 顶多碰几个窗口）。
        if self.windows_seen.len() > 256 {
            self.windows_seen.drain(0..128);
        }
        id
    }

    fn window_by_id(&self, id: &str) -> Result<AXElem, String> {
        self.windows_seen
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, e)| e.clone())
            .ok_or_else(|| format!("unknown window id: {id}——先调 windows 列一遍"))
    }

    fn to_element(&mut self, el: AXElem) -> A11yElement {
        let el_ref = format!("el-{}", self.next_ref);
        self.next_ref += 1;
        let r = el.as_ref();
        let out = A11yElement {
            el_ref: el_ref.clone(),
            role: str_attr(r, "AXRole").unwrap_or_default(),
            name: primary_name(r),
            // mac 没有 Windows 那种 className；这一格给 `AXIdentifier`——它是应用自己写死的
            // 稳定标识（`OKButton` / `PathTextField` / `open-panel`），**不随界面语言变**，
            // 正是控件表最想要的那个维度。
            class_name: str_attr(r, "AXIdentifier").unwrap_or_default(),
            rect: rect_of(r),
        };
        self.elements.insert(el_ref, el);
        out
    }

    /// 深度遍历 scope 根下的整棵树收集命中。
    ///
    /// **必须走 `AXChildren`**：文件选择面板是窗口的一个 `AXSheet` 子节点，而窗口的
    /// `AXSheets` 属性对它恒报 0（实测），走属性抄近路就会漏掉整个对话框。
    fn collect(&self, root: &AXElem, q: &A11yQuery, want_role: Option<&str>, out: &mut Vec<AXElem>) {
        fn walk(
            el: &AXElem,
            q: &A11yQuery,
            want_role: Option<&str>,
            depth: usize,
            out: &mut Vec<AXElem>,
        ) {
            if out.len() >= 50 || depth > 40 {
                return;
            }
            let r = el.as_ref();
            let role_ok = want_role.is_none_or(|w| str_attr(r, "AXRole").as_deref() == Some(w));
            let ident_ok = q
                .class_name
                .as_deref()
                .is_none_or(|c| str_attr(r, "AXIdentifier").as_deref() == Some(c));
            let name_ok = match (q.name.as_deref(), q.name_contains.as_deref()) {
                (None, None) => true,
                // 全等、大小写敏感（与 Windows 后端同口径）。
                (Some(n), _) => names_of(r).iter().any(|c| c == n),
                // 包含、大小写不敏感——列表项的 name 常是一整句动态拼出来的。
                (None, Some(n)) => {
                    let needle = n.to_lowercase();
                    names_of(r).iter().any(|c| c.to_lowercase().contains(&needle))
                }
            };
            if role_ok && ident_ok && name_ok {
                out.push(el.clone());
            }
            for c in children(r) {
                walk(&c, q, want_role, depth + 1, out);
            }
        }
        walk(root, q, want_role, 0, out);
    }
}

impl Desktop for MacDesktop {
    /// 列顶层窗口。范围 = 屏上有窗口的那些进程（`CGWindowListCopyWindowInfo` 给 pid），
    /// 标题与前台标志走 AX 读（标题不能走 CGWindowList，见 `gui_processes`）。
    fn windows(&mut self) -> Result<Vec<WindowInfo>, String> {
        // 没授权时下面每一步都会空手而归，表现是「一个窗口都没有」——那和「桌面上真的没窗口」
        // 长得一模一样。在这里一次性翻成人话，别让它伪装成空结果。
        if !unsafe { AXIsProcessTrusted() } {
            return Err(
                "accessibility-denied: 这个进程没有「辅助功能」授权，AX 一个字都读不到。\
                 去「系统设置 → 隐私与安全性 → 辅助功能」把**启动它的那个应用**（终端 / Stream）\
                 打开；授权是按启动者算的，不是按这个二进制算的。"
                    .to_string(),
            );
        }
        // 一次快照给所有进程用：`new_all()` 要扫 /proc 级别的全表，按窗口调一次就太贵了。
        let sys = sysinfo::System::new_all();
        let mut out = Vec::new();
        for (pid, process) in gui_processes() {
            // 版本按 pid 算一次，不是按窗口算一次——同一个应用的每个窗口版本当然一样。
            let ver = bundle_version(&sys, pid);
            let frontmost = app_element(pid)
                .and_then(|a| bool_attr(a.as_ref(), "AXFrontmost"))
                .unwrap_or(false);
            for w in app_windows(pid) {
                let mut title = str_attr(w.as_ref(), "AXTitle").unwrap_or_default();
                // 没标题的窗口既不是用户认得出的目标，也没法用 `AppMatch.title` 消歧——
                // 和 Windows 后端同一条滤。**例外：无标题的对话框 / 浮层**（`AXSubrole` 是
                // AXDialog / AXFloatingWindow / AXSheet）——它们正是"随主窗活着的弹层"：微信 mac 版的
                // 搜索候选就是一个无标题 AXDialog（活体 2026-09-13：pos (315,90) 368×498，紧贴搜索框
                // 下方；CG 层 3）。滤掉它，recipe 就永远 scope 不到候选，只能"在主窗左栏找"然后停。
                // 给它一个**合成标题** `<无标题 AXDialog>`，recipe 的 `window.match.title` 照字面写这一串；
                // 同一进程同时有两个这样的窗口时 `resolve_window` 会以 ambiguous-window 拒——响亮，不猜。
                if title.is_empty() {
                    let subrole = str_attr(w.as_ref(), "AXSubrole").unwrap_or_default();
                    if !matches!(subrole.as_str(), "AXDialog" | "AXFloatingWindow" | "AXSheet") {
                        continue;
                    }
                    title = format!("<无标题 {subrole}>");
                }
                // 「前台」= 这个应用是最前面那个，且这个窗口是它的主窗口。两个都要，
                // 否则一个应用的每个窗口都会自称在前台。
                let is_main = bool_attr(w.as_ref(), "AXMain").unwrap_or(false);
                let id = self.id_for(&w);
                // 同一个窗口在 `AXWindows` 里出现多次（微信 mac 版：同一个主窗口列了 4 遍，四个元素
                // `CFEqual`、标题都是「微信」）。不去重的话，`resolve_window` 会以 ambiguous-window
                // 拒掉一个其实唯一的目标——活体 2026-09-12：「4 个窗口都匹配……候选：微信×4」。
                // 按 id 去重就够：id 本来就是按 `CFEqual` 发的。
                if out.iter().any(|x: &WindowInfo| x.id == id) {
                    continue;
                }
                out.push(WindowInfo {
                    id,
                    process: process.clone(),
                    title,
                    foreground: frontmost && is_main,
                    platform: crate::protocol::PLATFORM_NAME.into(),
                    app_version: ver.clone(),
                });
            }
        }
        Ok(out)
    }

    /// 把窗口抬到前台，**并回读验证**（同 Windows 后端：返回的是「它现在真在前台吗」，
    /// 不是「我调用过了吗」）。
    fn focus_window(&mut self, id: &str) -> Result<bool, String> {
        let win = self.window_by_id(id)?;
        let pid = pid_of(&win).ok_or_else(|| format!("问不出窗口 {id} 属于哪个进程"))?;
        enable_web_a11y(pid); // 同 scope_window：focus 也确立搜索范围
        unsafe {
            // ① 应用整体提到最前。这是 mac 上「抢屏」的正路（等价于 NSApp activate），
            //    不需要 Windows 那套 AttachThreadInput 绕前台锁的把戏。
            if let Some(app) = app_element(pid) {
                let t = CFBoolean::true_value();
                AXUIElementSetAttributeValue(
                    app.as_ref(),
                    cfstr("AXFrontmost").as_concrete_TypeRef(),
                    t.as_CFTypeRef(),
                );
            }
            // ② 再把这个窗口设成主窗口 + 有焦点——应用在前台不等于**这一个**窗口在前面。
            let t = CFBoolean::true_value();
            AXUIElementSetAttributeValue(
                win.as_ref(),
                cfstr("AXMain").as_concrete_TypeRef(),
                t.as_CFTypeRef(),
            );
            AXUIElementPerformAction(win.as_ref(), cfstr("AXRaise").as_concrete_TypeRef());
        }
        self.scope_target = Some(id.to_string());
        // 换了范围，旧 ref 全作废（同 Windows 后端：ref 不跨窗口存活）。
        self.elements.clear();

        // ③ 回读验证。窗口管理器切前台不是同步的，给它几百毫秒轮询；到点还不是就如实 false，
        //    让调用方停手，而不是对着别人的窗口乱点。
        for _ in 0..10 {
            if self.foreground_window_id().ok().as_deref() == Some(id) {
                self.focus_target = Some(id.to_string());
                return Ok(true);
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        Ok(false)
    }

    /// 只限定搜索范围，**不碰焦点**——看一眼不该把用户的窗口拽到前面来。
    fn scope_window(&mut self, id: &str) -> Result<(), String> {
        let win = self.window_by_id(id)?; // 先确认它真在，别把一个不存在的 id 记下来
        // 限定到谁，就把谁的网页 a11y 打开——否则 `find` 只看得见浏览器外壳。见
        // `enable_web_a11y` 的头注（那个坑的失败信息指向完全错误的方向）。
        if let Some(pid) = pid_of(&win) {
            enable_web_a11y(pid);
        }
        self.scope_target = Some(id.to_string());
        self.elements.clear();
        Ok(())
    }

    fn focus_target(&mut self) -> Option<String> {
        self.focus_target.clone()
    }

    fn scope_target(&mut self) -> Option<String> {
        self.scope_target.clone()
    }

    /// 此刻真正持有前台的窗口——问系统（哪个应用 `AXFrontmost`、它的主窗口是哪个），
    /// 不问被控应用。
    fn foreground_window_id(&mut self) -> Result<String, String> {
        for (pid, _) in gui_processes() {
            let front = app_element(pid)
                .and_then(|a| bool_attr(a.as_ref(), "AXFrontmost"))
                .unwrap_or(false);
            if !front {
                continue;
            }
            for w in app_windows(pid) {
                if bool_attr(w.as_ref(), "AXMain").unwrap_or(false) {
                    // 走同一张身份表，所以和 `focus_window` 记下的那个 id 比得起来。
                    return Ok(self.id_for(&w));
                }
            }
        }
        Err("查不出此刻哪个窗口在前台".to_string())
    }

    fn find(&mut self, q: &A11yQuery) -> Result<Vec<A11yElement>, String> {
        q.validate()?;
        let want_role = match q.role.as_deref() {
            Some(r) => Some(role_to_ax(r)?),
            None => None,
        };
        let root = self.scope_root()?;
        let mut hits = Vec::new();
        self.collect(&root, q, want_role.as_deref(), &mut hits);
        Ok(hits.into_iter().map(|e| self.to_element(e)).collect())
    }

    /// 触发元素自带的动作。按序降级并把每一层的失败都列出来——和 Windows 后端同一个态度：
    /// 全失败才报错，且报出来的话要指得动方向。
    fn invoke(&mut self, el_ref: &str) -> Result<(), String> {
        let el = self
            .elements
            .get(el_ref)
            .ok_or_else(|| format!("unknown element ref: {el_ref}"))?;
        let mut tried = Vec::new();
        // AXPress 是 mac 上的通用「按一下」，网页元素和原生控件都吃（实测：WebUI 的
        // 「开发者模式」开关、「加载未打包的扩展程序」、面板的「选择」，以及菜单项）。
        // AXConfirm 收输入框里的回车语义，AXOpen 收列表/文件项。
        for action in ["AXPress", "AXConfirm", "AXOpen"] {
            let err = unsafe {
                AXUIElementPerformAction(el.as_ref(), cfstr(action).as_concrete_TypeRef())
            };
            if err == kAXErrorSuccess {
                return Ok(());
            }
            tried.push(format!("{action}: AXError {err}"));
        }
        Err(format!("invoke failed on every action — {}", tried.join("; ")))
    }

    /// 把文字写进元素本身（不经键盘）。
    ///
    /// **三件事，一件都不能少**（见文件头注第 3 条）：
    /// 1. 先 `AXFocused = true`——只写值不聚焦，值进去了但**紧接着的回车不提交**；
    /// 2. 再写 `AXValue`；
    /// 3. **回读确认**。报了 `Success` 不算数——自绘 / 网页控件可能收下调用却不改内容，
    ///    那种「写进去了」的谎会让下游一路建立在假前提上。读不回来就如实报失败，
    ///    让调用方退回键盘那条路。
    fn set_value(&mut self, el_ref: &str, text: &str) -> Result<(), String> {
        let el = self
            .elements
            .get(el_ref)
            .ok_or_else(|| format!("unknown element ref: {el_ref}"))?;
        unsafe {
            let t = CFBoolean::true_value();
            AXUIElementSetAttributeValue(
                el.as_ref(),
                cfstr("AXFocused").as_concrete_TypeRef(),
                t.as_CFTypeRef(),
            );
            let v = cfstr(text);
            let err = AXUIElementSetAttributeValue(
                el.as_ref(),
                cfstr("AXValue").as_concrete_TypeRef(),
                v.as_CFTypeRef(),
            );
            if err != kAXErrorSuccess {
                return Err(ax_err("setValue", err));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        match str_attr(el.as_ref(), "AXValue") {
            Some(back) if back == text => Ok(()),
            Some(back) => Err(format!(
                "setValue 报成功但回读是 {back:?}——应用没收下，改走键盘"
            )),
            None => Err("setValue 报成功但读不回值——应用没收下，改走键盘".to_string()),
        }
    }

    fn click(&mut self, rect: &Rect, button: &str) -> Result<(), String> {
        let b = match button {
            "left" => Left,
            "right" => Right,
            "middle" => Middle,
            other => return Err(format!("click: 不认识的键 {other}")),
        };
        let (x, y) = (rect.x + rect.w / 2, rect.y + rect.h / 2);
        // 滑过去再按（见 `glide.rs` 头注；到位后的停顿也归它，比原来的 40ms 长）。
        // 读不到当前位置就从目标出发 = 退化成瞬移。
        let from = self.enigo.location().unwrap_or((x, y));
        let enigo = &mut self.enigo;
        crate::glide::glide_to(from, (x, y), |px, py| enigo.move_mouse(px, py, Abs).map_err(|e| e.to_string()))?;
        self.enigo.button(b, Click).map_err(|e| e.to_string())
    }

    fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String> {
        self.enigo.move_mouse(x, y, Abs).map_err(|e| e.to_string())
    }

    fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String> {
        let lines = (amount / 40).max(1);
        let signed = if dir == "up" { -lines } else { lines };
        self.enigo.scroll(signed, Axis::Vertical).map_err(|e| e.to_string())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        // 末尾的 \n 是提交（回车），和浏览器那边 type 的语义一致。
        let (body, submit) = match text.strip_suffix('\n') {
            Some(b) => (b, true),
            None => (text, false),
        };
        if !body.is_empty() {
            self.enigo.text(body).map_err(|e| e.to_string())?;
        }
        if submit {
            self.enigo.key(Key::Return, Press).map_err(|e| e.to_string())?;
            self.enigo.key(Key::Return, Release).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 只认没有字符的那几个键。不认识的一律报错——静默吞掉会让上层把「弹窗没关掉」
    /// 当成关掉了，后面每一步都建立在那个假前提上。
    fn press(&mut self, key: &str) -> Result<(), String> {
        let k = match key {
            "Escape" => Key::Escape,
            "Enter" => Key::Return,
            other => return Err(format!("press: 不认识的键 {other}（今天只有 Escape / Enter）")),
        };
        self.enigo.key(k, Click).map_err(|e| e.to_string())
    }

    /// 同 Windows 那份，修饰键换成 Cmd；Cmd 在出错路径上也要松开。
    fn clear_input(&mut self) -> Result<(), String> {
        self.enigo.key(Key::Meta, Press).map_err(|e| e.to_string())?;
        // 虚拟键码 kVK_ANSI_A = 0x00，理由同 Windows 那份：Unicode 字符事件不带键码，Cmd+A 收不到。
        let picked = self.enigo.key(Key::Other(0x00), Click).map_err(|e| e.to_string());
        let released = self.enigo.key(Key::Meta, Release).map_err(|e| e.to_string());
        picked?;
        released?;
        self.enigo.key(Key::Backspace, Click).map_err(|e| e.to_string())
    }

    /// 截目标窗口本身（`capture_window`）；没有目标窗口就落回截主屏（`window: None`）。
    /// 交出去的图**缩到点分辨率**，宽高 == `window.w/h`——口径见文件头注。
    fn screenshot(&mut self) -> Result<Option<Screenshot>, String> {
        use base64::Engine as _;
        let encode = |img: &image::RgbImage| -> Result<String, String> {
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
            Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
        };
        if self.scope_target.is_some() {
            let cap = self.capture_window()?;
            let img = cap.to_points();
            return Ok(Some(Screenshot { base64: encode(&img)?, window: Some(cap.window), scale: cap.scale }));
        }
        // 回落：截主屏。这条路截的是一整块屏，不是"一个窗口"——`window` 只能是 None。
        let (img, bounds) = cg::capture_main_display()?;
        let scale = if bounds.w > 0 { img.width() as f64 / bounds.w as f64 } else { 1.0 };
        let img = if scale > 1.01 {
            image::imageops::resize(&img, bounds.w as u32, bounds.h as u32, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        Ok(Some(Screenshot { base64: encode(&img)?, window: None, scale }))
    }

    /// 批量读：`itemQuery` 命中的每个元素出一行，字段按 `read` 取（`name` / `value`）。
    /// 走 `collect` 那一份匹配逻辑，别另拼 matcher（Windows 那边为此栽过：两份实现漂移
    /// 没有任何东西会喊）。
    fn read_subtree(
        &mut self,
        spec: &ReadSpec,
    ) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
        spec.item_query.validate()?;
        let want_role = match spec.item_query.role.as_deref() {
            Some(r) => Some(role_to_ax(r)?),
            None => None,
        };
        let root = self.scope_root()?;
        let mut items = Vec::new();
        self.collect(&root, &spec.item_query, want_role.as_deref(), &mut items);
        let mut rows = Vec::new();
        for item in items {
            let r = item.as_ref();
            let mut row = serde_json::Map::new();
            for (field, fs) in &spec.fields {
                let value = match fs.read.as_str() {
                    "name" => primary_name(r),
                    "value" => str_attr(r, "AXValue").unwrap_or_else(|| primary_name(r)),
                    _ => String::new(),
                };
                row.insert(field.clone(), serde_json::Value::String(value));
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// 在目标窗口此刻的画面上找模板。画面先缩到**点分辨率**——模板是从 `screenshot()` 那张
    /// （点分辨率的）图上抠的，两边尺度必须一致，NCC 对尺寸差是零容忍的（错一档就掉分）。
    /// 框出门是点、相对窗口左上角，同 `screenshot`。
    fn find_image(&mut self, template_png: &[u8], region: Option<&Rect>) -> Result<Option<(Rect, f64)>, String> {
        let cap = self.capture_window()?;
        let img = cap.to_points();
        let (crop, (ox, oy)) = crate::see::crop_to_region(&img, region)?;
        let hay = image::DynamicImage::ImageRgb8(crop.into_owned()).to_luma8();
        let needle = image::load_from_memory(template_png)
            .map_err(|e| format!("bad-template: 模板不是可解码的图片：{e}"))?
            .to_luma8();
        Ok(crate::see::find_image(&hay, &needle).map(|(mut r, s)| {
            r.x += ox;
            r.y += oy;
            (r, s)
        }))
    }

    /// 引擎信息（是否已加载、加载自哪个运行时库路径）——见 `ocr.rs::EngineInfo`。
    fn ocr_engine_info(&mut self) -> Result<crate::ocr::EngineInfo, String> {
        self.see.ocr().map(|e| e.info().clone())
    }

    /// 读目标窗口此刻画面上的字。识别在物理分辨率上跑，框出门 ÷ scale 成点（见文件头注）。
    /// `region`（点）进门 × scale 再裁——裁剪必须在识别**之前**发生，理由同 Windows 那份。
    fn read_text(&mut self, region: Option<&Rect>) -> Result<crate::protocol::TextRead, String> {
        let t0 = std::time::Instant::now();
        let cap = self.capture_window()?;
        let t_cap = t0.elapsed();
        let region_px = region.map(|r| cap.to_physical(r));
        let (crop, (ox, oy)) = crate::see::crop_to_region(&cap.image, region_px.as_ref())?;
        let t1 = std::time::Instant::now();
        let mut texts = self.ocr_texts(&crop, cap.scale, region.is_some())?;
        // `ocr@det1x`/`ocr@phys` 标这次检测跑在哪个尺度上——A/B（`STREAM_OCR_PHYSICAL`）就靠它在日志里分得开。
        eprintln!(
            "[see-read] text crop={}x{} capture={}ms ocr={}ms lines={} scale={} {}",
            crop.width(), crop.height(), t_cap.as_millis(), t1.elapsed().as_millis(), texts.len(), cap.scale,
            crate::see::ocr_mode_label(cap.scale)
        );
        for t in &mut texts {
            t.rect.x += ox;
            t.rect.y += oy;
            t.rect = cap.to_point_rect(&t.rect);
        }
        Ok(crate::protocol::TextRead { texts, window: cap.window, scale: cap.scale })
    }

    /// 元素表：a11y（AX 树里的可交互控件）+ 检测器（`icons` 才跑）+ OCR 文字三档缝在一起
    /// （`see::synthesize_elements`）。**只截这一次**，三档同一张画面；坐标口径与 `read_text` 一致。
    /// `a11y == false`（recipe 申报 `app.a11y:false`）整档不跑，日志 `a11y=0ms(off)`——同 Windows 那份。
    fn read_elements(
        &mut self,
        region: Option<&Rect>,
        icons: bool,
        a11y: bool,
    ) -> Result<crate::protocol::ElementsRead, String> {
        let t0 = std::time::Instant::now();
        let cap = self.capture_window()?;
        let t_cap = t0.elapsed();
        let region_px = region.map(|r| cap.to_physical(r));
        let (crop, (ox, oy)) = crate::see::crop_to_region(&cap.image, region_px.as_ref())?;
        let t1 = std::time::Instant::now();
        // 文字与检测器都以物理分辨率出框（文字在 1× 上认、框已乘回物理），先合成再统一换成点——
        // 三档必须同一套坐标才合得起来，所以 a11y 那一档（天然是点）反过来 × scale 进物理坐标参与合成。
        let texts = self.ocr_texts(&crop, cap.scale, region.is_some())?;
        let t_ocr = t1.elapsed();
        let t2 = std::time::Instant::now();
        let detector = if icons { self.see.detector_rects(&crop) } else { Vec::new() };
        let t_det = t2.elapsed();
        let t3 = std::time::Instant::now();
        let (cw, ch) = (crop.width() as i32, crop.height() as i32);
        let process = cap.process.clone();
        let a11y_els: Vec<crate::protocol::Element> = if a11y {
            self.interactive_elements(&cap.window, &process)
                .into_iter()
                .map(|mut e| {
                    let px = cap.to_physical(&e.rect);
                    e.rect = Rect { x: px.x - ox, y: px.y - oy, w: px.w, h: px.h };
                    e
                })
                .filter(|e| e.rect.x < cw && e.rect.y < ch && e.rect.x + e.rect.w > 0 && e.rect.y + e.rect.h > 0)
                .collect()
        } else {
            Vec::new()
        };
        eprintln!(
            "[see-read] elements crop={}x{} capture={}ms ocr={}ms detector={}ms({}) a11y={}ms{} lines={} scale={} {}",
            crop.width(), crop.height(), t_cap.as_millis(), t_ocr.as_millis(), t_det.as_millis(),
            if icons { "on" } else { "off" },
            if a11y { t3.elapsed().as_millis() } else { 0 }, if a11y { "" } else { "(off)" },
            texts.len(), cap.scale, crate::see::ocr_mode_label(cap.scale)
        );
        let mut elements = crate::see::synthesize_elements(a11y_els, detector, &texts);
        for e in &mut elements {
            e.rect.x += ox;
            e.rect.y += oy;
            e.rect = cap.to_point_rect(&e.rect);
        }
        Ok(crate::protocol::ElementsRead { elements, window: cap.window, scale: cap.scale })
    }

    /// 键盘焦点此刻在哪：`<前台进程名>#<焦点元素的 AXRole>`，与 Windows 那份 `process#class`
    /// 同形（mac 没有 className，AXRole 是最接近的那一格）。问的是系统级元素，不问被控应用。
    fn url(&mut self) -> Result<String, String> {
        unsafe {
            let sys = AXElem::from_create(accessibility_sys::AXUIElementCreateSystemWide())
                .ok_or("AXUIElementCreateSystemWide 失败")?;
            let app = copy_attr(sys.as_ref(), "AXFocusedApplication")
                .and_then(|v| AXElem::from_create(v as AXUIElementRef))
                .ok_or("查不出焦点应用（AXFocusedApplication 为空）")?;
            let pid = pid_of(&app).unwrap_or(0);
            let process = gui_processes()
                .into_iter()
                .find(|(p, _)| *p == pid)
                .map(|(_, n)| n)
                .unwrap_or_default();
            let role = copy_attr(app.as_ref(), "AXFocusedUIElement")
                .and_then(|v| AXElem::from_create(v as AXUIElementRef))
                .and_then(|el| str_attr(el.as_ref(), "AXRole"))
                .unwrap_or_default();
            Ok(format!("{process}#{role}"))
        }
    }

    fn sleep(&mut self, ms: u64) -> Result<(), String> {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        Ok(())
    }
}

/// mac 后端**没有**的那几件事（今天 trait 上的每个动词都有实现；剩下的是 trait 默认实现
/// 里那些 Windows 专属的路）：`nudge_input`（零位移真实输入，走 `move_mouse` 兜）、`post_input`
/// （`PostMessage` 投消息，mac 没有对应物，recipe 写 `input:"message"` 会被 trait 默认实现拒）、
/// `session_locked`（mac 上没找到纯读的锁屏判据，报 `None` = 没验到，绝不当"没锁"）。
///
/// 为什么把这份清单留在这儿：一个继承来的默认空实现会让能力**安静地退化成一个像模像样的
/// 空答案**——上层读到空数组就以为「这一屏没有文字」，然后一直找不到目标。宁可吵，不可静。
/// 往 trait 加动词时来这里对一遍：mac 是真做了、还是落在默认实现上。
#[allow(dead_code)]
const MAC_NOT_IMPLEMENTED: &[&str] = &["nudgeInput", "postInput", "sessionLocked"];

// ── 截图：CGWindowList ──────────────────────────────────────────────────────

/// 一次截窗的产物：**物理分辨率**的图 + 窗口的**点** rect + 两者之比。
///
/// 图和 rect 同一次取（rect 就是拿去找窗口 id 的那一份），不让调用方再读一次——窗口在两次读
/// 之间挪一下，"图的宽高 == window.w/h × scale" 这条判据就永远对不上，而两边单看都正常。
struct WindowCapture {
    image: image::RgbImage,
    window: Rect,
    scale: f64,
    process: String,
}

impl WindowCapture {
    /// 点 → 物理像素（进门用：region）。
    fn to_physical(&self, r: &Rect) -> Rect {
        let s = self.scale;
        Rect {
            x: (r.x as f64 * s).round() as i32,
            y: (r.y as f64 * s).round() as i32,
            w: (r.w as f64 * s).round() as i32,
            h: (r.h as f64 * s).round() as i32,
        }
    }
    /// 物理像素 → 点（出门用：识别出来的框）。
    fn to_point_rect(&self, r: &Rect) -> Rect {
        let s = self.scale;
        Rect {
            x: (r.x as f64 / s).round() as i32,
            y: (r.y as f64 / s).round() as i32,
            w: (r.w as f64 / s).round().max(1.0) as i32,
            h: (r.h as f64 / s).round().max(1.0) as i32,
        }
    }
    /// 整张图缩到点分辨率（宽高 == window.w/h）。scale 为 1 时原样交出。
    fn to_points(&self) -> image::RgbImage {
        if (self.scale - 1.0).abs() < 0.01 {
            return self.image.clone();
        }
        image::imageops::resize(
            &self.image,
            self.window.w.max(1) as u32,
            self.window.h.max(1) as u32,
            image::imageops::FilterType::Triangle,
        )
    }
}

impl MacDesktop {
    /// 截此刻限定到的那个窗口。没有目标窗口就直接拒——回落抓屏会让框指向另一套坐标系
    /// （相对屏幕而不是相对窗口），而调用方照样加窗口原点，加出来的位置指向别处。
    fn capture_window(&self) -> Result<WindowCapture, String> {
        let win = self.scope_root()?;
        let pid = pid_of(&win).ok_or("问不出目标窗口属于哪个进程")?;
        let ax_rect = rect_of(win.as_ref());
        let (wid, rect) = if ax_rect.w > 0 && ax_rect.h > 0 {
            let wid = cg::window_number_for(pid, &ax_rect).ok_or_else(|| {
                format!("no-capture: CGWindowList 里找不到 pid {pid}、rect {ax_rect:?} 的窗口（最小化 / 在别的 Space 里？）")
            })?;
            (wid, ax_rect)
        } else {
            // **锁屏下 AX 被截断**（活体 2026-09-12，macOS 14.6）：每个窗口的 `AXTitle` 塌成应用名、
            // `AXPosition`/`AXSize` 全是 0——和 Windows 的"锁屏不挡 UIA 读"正相反。CGWindowList 的
            // 边界不受影响，所以这个进程只有一个普通窗口时还能截；多个就没法知道 scope 到的是哪个，
            // 如实报歧义，不猜。
            match cg::windows_of(pid).as_slice() {
                [(wid, rect)] => (*wid, rect.clone()),
                [] => return Err(format!("no-capture: 目标窗口的 AX rect 是 {ax_rect:?}，CGWindowList 里 pid {pid} 也没有普通窗口（已关闭 / 最小化？）")),
                many => {
                    return Err(format!(
                        "ambiguous-window: 目标窗口的 AX rect 是 {ax_rect:?}（锁屏下 AX 读不到位置与标题），而 pid {pid} 有 {} 个窗口，分不清 scope 到的是哪个；解锁后再读",
                        many.len()
                    ))
                }
            }
        };
        let image = cg::capture_window_image(wid)?;
        let scale = image.width() as f64 / rect.w as f64;
        let process = gui_processes().into_iter().find(|(p, _)| *p == pid).map(|(_, n)| n).unwrap_or_default();
        Ok(WindowCapture { image, window: rect, scale, process })
    }

    /// 认出这一块图上的字。**只有 PP-OCR 这一条路**，与 Windows 同形：模型或运行时库缺席，
    /// `SeeEngines::ocr` 的错误（`ocr-missing:` / `ort-missing:`，文本里已有缺的文件与目录）
    /// 原样上报，绝不回空数组。
    /// `scale` = `cap.scale`：Retina 上检测在 1× 上跑、识别吃物理像素、同一帧不重认（`SeeEngines::ocr_texts`），
    /// 交回来的框仍是物理坐标，出门 ÷ scale 那一步不变。
    fn ocr_texts(&mut self, img: &image::RgbImage, scale: f64, cropped: bool) -> Result<Vec<crate::protocol::ScreenText>, String> {
        self.see.ocr()?;
        self.see.ocr_texts(img, scale, cropped)
    }

    /// a11y 那一档：整棵 scope 树走一遍，收可交互角色。框换成**相对窗口左上角的点**。
    ///
    /// 一次遍历收所有角色（不像 Windows 那样逐角色查——AX 没有 provider 侧的批量查询，
    /// 逐角色就是把整棵树走七遍）。超预算整份丢掉、不交半份，理由同 Windows 那份。
    fn interactive_elements(&mut self, window: &Rect, process: &str) -> Vec<crate::protocol::Element> {
        let Ok(root) = self.scope_root() else { return Vec::new() };
        let started = std::time::Instant::now();
        let mut out = Vec::new();
        let over_budget = walk_interactive(&root, window, 0, &started, &mut out);
        let count = if over_budget { None } else { Some(out.len()) };
        if self.a11y_last_report.get(process) != Some(&count) {
            self.a11y_last_report.insert(process.to_string(), count);
            match count {
                None => eprintln!(
                    "[stream-desktop] {process} 的控件树枚举超预算，这一轮结果作废（{}ms）",
                    started.elapsed().as_millis()
                ),
                Some(n) => eprintln!(
                    "[stream-desktop] {process} 的控件树枚举出 {n} 个可交互控件（{}ms）",
                    started.elapsed().as_millis()
                ),
            }
        }
        if over_budget {
            return Vec::new();
        }
        out
    }
}

/// a11y 那一档只取**可交互**角色（对应 Windows 的 `INTERACTIVE_ROLES`，换成 AX 的名字）。
/// 不取 `AXStaticText` / `AXGroup`：元素表回答的是"哪儿能点"，容器算进来会让"同档多命中就拒绝"
/// 的判据被一堆套在一起的 Group 打成永远歧义。
const AX_INTERACTIVE_ROLES: &[&str] = &[
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXLink",
    "AXMenuItem", "AXRow", "AXPopUpButton", "AXComboBox", "AXMenuButton",
];
const AX_MAX_ELEMENTS: usize = 600;
const AX_BUDGET_MS: u128 = 1200;

/// 返回 true = 超预算。
fn walk_interactive(
    el: &AXElem,
    window: &Rect,
    depth: usize,
    started: &std::time::Instant,
    out: &mut Vec<crate::protocol::Element>,
) -> bool {
    if depth > 40 || out.len() >= AX_MAX_ELEMENTS {
        return false;
    }
    if started.elapsed().as_millis() > AX_BUDGET_MS {
        return true;
    }
    let r = el.as_ref();
    if let Some(role) = str_attr(r, "AXRole") {
        if AX_INTERACTIVE_ROLES.contains(&role.as_str()) {
            let abs = rect_of(r);
            let rect = Rect { x: abs.x - window.x, y: abs.y - window.y, w: abs.w, h: abs.h };
            if rect.w > 0 && rect.h > 0 {
                let name = primary_name(r);
                out.push(crate::protocol::Element {
                    rect,
                    // 空名字报成 `None` 而不是空串：上层按名字包含匹配时，空串会和任何查询擦出静默命中。
                    name: (!name.trim().is_empty()).then_some(name),
                    kind: crate::protocol::ElementKind::A11y,
                });
            }
        }
    }
    for c in children(r) {
        if walk_interactive(&c, window, depth + 1, started, out) {
            return true;
        }
    }
    false
}

/// CoreGraphics 那几条裸 FFI。不引 `core-graphics` crate：这里只要六七个函数，为它拖进一整个
/// 绑定不划算（理由同 a11y 走 `accessibility-sys`）。
mod cg {
    use super::{dict_get, CGPoint, CGSize, Rect};
    use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation::base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionaryRef;
    use core_foundation::number::CFNumber;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }

    type CGImageRef = *mut c_void;
    type CGContextRef = *mut c_void;
    type CGColorSpaceRef = *mut c_void;

    // CGWindowListOption
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const INCLUDING_WINDOW: u32 = 1 << 3;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    // CGWindowImageOption
    const BOUNDS_IGNORE_FRAMING: u32 = 1 << 0; // 不带阴影——图的宽高才等于窗口 rect × scale
    const BEST_RESOLUTION: u32 = 1 << 3; // Retina 上出 2×：识别在物理分辨率上跑
    // CGBitmapInfo：RGBA、每分量 8 位、alpha 在末尾（premultiplied，窗口本就不透明，无损）
    const ALPHA_PREMULTIPLIED_LAST: u32 = 1;

    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
        fn CGWindowListCreateImage(rect: CGRect, option: u32, window_id: u32, image_option: u32) -> CGImageRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGImageGetWidth(img: CGImageRef) -> usize;
        fn CGImageGetHeight(img: CGImageRef) -> usize;
        fn CGImageRelease(img: CGImageRef);
        fn CGColorSpaceCreateDeviceRGB() -> CGColorSpaceRef;
        fn CGColorSpaceRelease(space: CGColorSpaceRef);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: CGColorSpaceRef,
            bitmap_info: u32,
        ) -> CGContextRef;
        fn CGContextDrawImage(ctx: CGContextRef, rect: CGRect, image: CGImageRef);
        fn CGContextRelease(ctx: CGContextRef);
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateImage(display: u32) -> CGImageRef;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    /// `CGRectNull`：让 `CGWindowListCreateImage` 用窗口自己的边界。
    fn rect_null() -> CGRect {
        CGRect { origin: CGPoint { x: f64::INFINITY, y: f64::INFINITY }, size: CGSize { width: 0.0, height: 0.0 } }
    }

    /// 找这个进程里、边界和 AX 报的 rect 重合的那个窗口的 `kCGWindowNumber`。
    ///
    /// **按 pid + 边界配，不用私有 API `_AXUIElementGetWindow`**：那个符号一旦在某个系统版本上消失，
    /// 整个二进制在 dyld 阶段就起不来——而它是要装到用户机器上的东西。`kCGWindowBounds` 不要
    /// 「屏幕录制」授权，和 AX 的 `AXPosition`/`AXSize` 同一套（点、左上原点），配得上。
    /// 只认 layer 0（普通窗口）与 layer 3（浮层：无标题 AXDialog 弹层住在这一层，见 `windows()`），
    /// 排除菜单栏 / Dock。
    pub fn window_number_for(pid: i32, ax_rect: &Rect) -> Option<u32> {
        let mut best: Option<(u32, f64)> = None;
        for (wid, cand) in windows_of(pid) {
            let score = iou(&cand, ax_rect);
            if score > 0.9 && best.map_or(true, |(_, s)| score > s) {
                best = Some((wid, score));
            }
        }
        best.map(|(w, _)| w)
    }

    /// 这个进程在屏上的普通窗口（layer 0）与浮层（layer 3）：`(kCGWindowNumber, 点 bounds)`，按 z 序
    /// （前面的在前）。layer 3 是 NSPopover / 无标题 AXDialog 那一档（微信搜索候选）；调用方都按
    /// pid + 边界 IoU 再配一次，多认这一层不会让别的东西混进来。菜单栏（24/25）、Dock（20）仍排除。
    pub fn windows_of(pid: i32) -> Vec<(u32, Rect)> {
        let mut out = Vec::new();
        unsafe {
            let arr = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
            if arr.is_null() {
                return out;
            }
            let n = CFArrayGetCount(arr);
            for i in 0..n {
                let d = CFArrayGetValueAtIndex(arr, i) as CFDictionaryRef;
                if d.is_null() {
                    continue;
                }
                if num(d, "kCGWindowOwnerPID") != Some(pid as i64) {
                    continue;
                }
                if !matches!(num(d, "kCGWindowLayer").unwrap_or(0), 0 | 3) {
                    continue;
                }
                let Some(wid) = num(d, "kCGWindowNumber") else { continue };
                let Some(b) = dict_get(d, "kCGWindowBounds") else { continue };
                let mut r = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: 0.0, height: 0.0 } };
                let ok = CGRectMakeWithDictionaryRepresentation(b as CFDictionaryRef, &mut r);
                CFRelease(b);
                if !ok {
                    continue;
                }
                let cand = Rect {
                    x: r.origin.x as i32,
                    y: r.origin.y as i32,
                    w: r.size.width as i32,
                    h: r.size.height as i32,
                };
                if cand.w > 0 && cand.h > 0 {
                    out.push((wid as u32, cand));
                }
            }
            CFRelease(arr as CFTypeRef);
        }
        out
    }

    fn iou(a: &Rect, b: &Rect) -> f64 {
        let ix = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
        let iy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
        if ix <= 0 || iy <= 0 {
            return 0.0;
        }
        let inter = ix as f64 * iy as f64;
        let union = (a.w as f64 * a.h as f64) + (b.w as f64 * b.h as f64) - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }

    unsafe fn num(d: CFDictionaryRef, key: &str) -> Option<i64> {
        let v = dict_get(d, key)?;
        if CFGetTypeID(v) != CFNumber::type_id() {
            CFRelease(v);
            return None;
        }
        CFNumber::wrap_under_create_rule(v as _).to_i64()
    }

    /// 截一个窗口（按 id）→ 物理分辨率的 RGB 图。两道闸：先问授权，再验图不是纯色。
    pub fn capture_window_image(wid: u32) -> Result<image::RgbImage, String> {
        preflight()?;
        let img = unsafe {
            CGWindowListCreateImage(rect_null(), INCLUDING_WINDOW, wid, BOUNDS_IGNORE_FRAMING | BEST_RESOLUTION)
        };
        let rgb = cgimage_to_rgb(img).ok_or_else(|| format!("no-capture: CGWindowListCreateImage(窗口 {wid}) 回了空图"))?;
        reject_blank(&rgb)?;
        Ok(rgb)
    }

    /// 截主屏 → 图 + 主屏的点 bounds。
    pub fn capture_main_display() -> Result<(image::RgbImage, Rect), String> {
        preflight()?;
        let (img, bounds) = unsafe {
            let id = CGMainDisplayID();
            (CGDisplayCreateImage(id), CGDisplayBounds(id))
        };
        let rgb = cgimage_to_rgb(img).ok_or("no-capture: CGDisplayCreateImage 回了空图")?;
        reject_blank(&rgb)?;
        Ok((
            rgb,
            Rect { x: bounds.origin.x as i32, y: bounds.origin.y as i32, w: bounds.size.width as i32, h: bounds.size.height as i32 },
        ))
    }

    fn preflight() -> Result<(), String> {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return Ok(());
        }
        Err("screen-recording-denied: 这个进程没有「屏幕录制」授权，CGWindowList 只会给一张没有窗口内容的图（不报错）。去「系统设置 → 隐私与安全性 → 屏幕录制」把**启动它的那个应用**打开（ssh 起 = sshd-keygen-wrapper，后端起 = 起后端的终端 / Stream）；授权是按启动者算的，不是按这个二进制算的。"
            .to_string())
    }

    /// 授权缺席时 CGWindowList **不报错**，只是图里没有窗口内容（纯色 / 壁纸）。preflight 已经挡了
    /// 一档，这里再挡一档——两条判据来源不同（一个问 TCC、一个看像素），谁漏了另一个兜。
    /// 抽样看颜色种数：真实窗口哪怕是一张空白文档也有边框 / 标题栏 / 文字，颜色种数远超 2。
    fn reject_blank(img: &image::RgbImage) -> Result<(), String> {
        let (w, h) = img.dimensions();
        if w == 0 || h == 0 {
            return Err("no-capture: 截出来的图是 0×0".to_string());
        }
        let mut seen = std::collections::HashSet::new();
        let step = ((w * h / 4096).max(1)) as usize;
        for (i, px) in img.pixels().enumerate() {
            if i % step == 0 {
                seen.insert(px.0);
                if seen.len() > 2 {
                    return Ok(());
                }
            }
        }
        Err(format!(
            "blank-capture: 截出来的 {w}×{h} 图只有 {} 种颜色——多半是没有「屏幕录制」授权（CGWindowList 缺权限不报错只给空图），或屏幕锁着 / 显示器睡着（活体 2026-09-12：锁屏下整张图纯色），或窗口在别的 Space / 被最小化。不把这张图交给 OCR。",
            seen.len()
        ))
    }

    /// 把 CGImage 画进一块自己开的 RGBA 位图再转 RGB。**不直接读 CGImage 的数据**：它的
    /// 字节序 / alpha 位置 / 行距随来源变（Intel 与 Apple Silicon 都不一样），画一遍到已知格式
    /// 才是唯一不用猜的路。接管并释放传进来的 `img`。
    fn cgimage_to_rgb(img: CGImageRef) -> Option<image::RgbImage> {
        if img.is_null() {
            return None;
        }
        unsafe {
            let (w, h) = (CGImageGetWidth(img), CGImageGetHeight(img));
            if w == 0 || h == 0 {
                CGImageRelease(img);
                return None;
            }
            let mut buf = vec![0u8; w * h * 4];
            let space = CGColorSpaceCreateDeviceRGB();
            let ctx = CGBitmapContextCreate(buf.as_mut_ptr() as *mut c_void, w, h, 8, w * 4, space, ALPHA_PREMULTIPLIED_LAST);
            if !ctx.is_null() {
                CGContextDrawImage(
                    ctx,
                    CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w as f64, height: h as f64 } },
                    img,
                );
                CGContextRelease(ctx);
            }
            CGColorSpaceRelease(space);
            CGImageRelease(img);
            if ctx.is_null() {
                return None;
            }
            let mut rgb = image::RgbImage::new(w as u32, h as u32);
            for (i, px) in rgb.pixels_mut().enumerate() {
                let o = i * 4;
                *px = image::Rgb([buf[o], buf[o + 1], buf[o + 2]]);
            }
            Some(rgb)
        }
    }
}
