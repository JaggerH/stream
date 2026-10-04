//! Windows UIA + enigo backend for the host-desktop Engine.
//!
//! This is the `tg_verify.ps1`-proven flow in Rust: locate by role/name/class over UIA, invoke
//! via the native Invoke pattern (handle fast-path), type via enigo, read the result subtree.
//! `find` caches located elements by an opaque `ref` so a later `invoke` (a separate WS
//! round-trip) can act on the same element.
//!
//! NOTE: verified by the Windows build/run (not the Linux `cargo test`, which never compiles this
//! module). The op FLOW is already proven live via the PowerShell stand-in.

use crate::protocol::{self, A11yElement, A11yQuery, Desktop, ReadSpec, Rect, Screenshot};
use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;

use enigo::{
    Axis, Button, Coordinate,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
use uiautomation::controls::ControlType;
use uiautomation::core::{UICacheRequest, UICondition};
use uiautomation::types::{PropertyConditionFlags, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::patterns::{
    UIInvokePattern, UILegacyIAccessiblePattern, UISelectionItemPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::{UIAutomation, UIElement};

/// 把窗口弄到前台要的那几个 Win32 调用。**自己声明而不是引 `windows` crate**:HWND 的类型
/// 必须和 `uiautomation` 用的那份对得上,引进来就把两个 crate 的版本焊死了;这里只用到 8 个
/// 签名极简的函数,`extern "system"` + isize 句柄零依赖、也不锁版本。
mod win32 {
    pub type Hwnd = isize;
    pub const SW_RESTORE: i32 = 9;

    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> Hwnd;
        pub fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        pub fn BringWindowToTop(hwnd: Hwnd) -> i32;
        pub fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        pub fn IsIconic(hwnd: Hwnd) -> i32;
        pub fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        pub fn AttachThreadInput(attach: u32, attach_to: u32, do_attach: i32) -> i32;
        /// 把一条消息**投给指定窗口**再返回，不等它处理。给后台窗口发字符的经典办法：
        /// 收件人是句柄，不走"谁在前台谁接住"那条规则。
        pub fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: usize, lparam: isize) -> i32;
        /// 屏幕坐标 → 该窗口的 client 坐标。鼠标消息的 lParam 要的是 client 坐标（`WM_MOUSEWHEEL`
        /// 例外，要屏幕坐标）。进程是 DPI 感知的，两边都是物理像素，中间没有换算。
        pub fn ScreenToClient(hwnd: Hwnd, pt: *mut Point) -> i32;
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }
    pub const WM_CHAR: u32 = 0x0102;
    // 激活/焦点那一组。真实鼠标点一个非活动窗口时，系统会先经 `DefWindowProc` 的命中测试
    // 送出 `WM_MOUSEACTIVATE` → `WM_NCACTIVATE` / `WM_ACTIVATE` / `WM_SETFOCUS` 再送按键消息；
    // 纯 `PostMessage` 一条都不会发生，所以"投一下点击"和"真点一下"在**焦点**这件事上不等价。
    // 这几个常量给 `focus-spike` 的 A/B 用（见 `focus_spike`）。
    pub const WM_ACTIVATE: u32 = 0x0006;
    pub const WM_SETFOCUS: u32 = 0x0007;
    pub const WM_NCACTIVATE: u32 = 0x0086;
    pub const WM_ACTIVATEAPP: u32 = 0x001C;
    pub const WA_CLICKACTIVE: usize = 2;
    pub const WM_KEYDOWN: u32 = 0x0100;
    pub const WM_KEYUP: u32 = 0x0101;
    pub const WM_MOUSEMOVE: u32 = 0x0200;
    pub const WM_LBUTTONDOWN: u32 = 0x0201;
    pub const WM_LBUTTONUP: u32 = 0x0202;
    pub const WM_RBUTTONDOWN: u32 = 0x0204;
    pub const WM_RBUTTONUP: u32 = 0x0205;
    pub const WM_MBUTTONDOWN: u32 = 0x0207;
    pub const WM_MBUTTONUP: u32 = 0x0208;
    pub const WM_MOUSEWHEEL: u32 = 0x020A;
    pub const MK_LBUTTON: usize = 0x0001;
    pub const MK_RBUTTON: usize = 0x0002;
    pub const MK_MBUTTON: usize = 0x0010;
    pub const VK_RETURN: usize = 0x0D;
    pub const VK_ESCAPE: usize = 0x1B;
    /// 只给 `focus-spike keys` 那组实验用（recipe 的 `press` 步骤只放行 Escape）。
    pub const VK_TAB: usize = 0x09;
    pub const VK_SHIFT: usize = 0x10;
    pub const VK_BACK: usize = 0x08;
    pub const VK_CONTROL: u16 = 0x11;
    pub const VK_A: u16 = 0x41;
    /// 键消息的 lParam：按下 = 重复计数 1；抬起 = 转换态 + 先前态 + 重复计数 1。
    pub const KEYDOWN_LPARAM: isize = 1;
    pub const KEYUP_LPARAM: isize = 0xC000_0001u32 as i32 as isize;
    /// 两个 16 位坐标拼成鼠标消息的 lParam（低半 x、高半 y，负数按 16 位截断）。
    pub fn xy_lparam(x: i32, y: i32) -> isize {
        (((y & 0xFFFF) << 16) | (x & 0xFFFF)) as isize
    }

    // ── 顶层窗口枚举（EnumWindows）─────────────────────────────────────────────
    //
    // **为什么不用 UIA 的 control-view walker**（`windows()` 原来那条路）：它**看不见模态
    // 对话框**。实测 2026-08-30，Chrome 的「加载未打包的扩展程序」弹出的文件夹选择框：
    //
    // ```
    // hwnd=23532696 pid=64656 owner=396088 exstyle=0x10101 fg=True  class=#32770 title=选择扩展程序目录。
    // hwnd=396088   pid=31232 owner=0      exstyle=0x200100 fg=False class=Chrome_WidgetWin_1 title=扩展程序 - Google Chrome
    // ```
    //
    // 它是 Chrome 主窗口的 **owned window**，而且跑在**另一个进程**里（Chrome 把文件对话框
    // 放在 utility 进程）。EnumWindows 看得见它（上面那份就是 EnumWindows 打出来的），
    // UIA walker 一行都不给。连带后果是 `GetForegroundWindow` 指着一个不在枚举表里的窗口，
    // 于是每一行的 `foreground` 都是 false，`cdp_look target:'desktop'` 直报「当前没有前台窗口」。
    //
    // 这不是风格问题：agent 够不到对话框 = 任何"点开一个原生对话框再操作它"的流程整条走不通。
    pub type WndEnumProc = unsafe extern "system" fn(Hwnd, isize) -> i32;

    #[link(name = "user32")]
    extern "system" {
        pub fn EnumWindows(cb: WndEnumProc, lparam: isize) -> i32;
        pub fn IsWindowVisible(hwnd: Hwnd) -> i32;
        pub fn GetWindowTextW(hwnd: Hwnd, buf: *mut u16, max: i32) -> i32;
        pub fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
    }

    /// `DWMWA_CLOAKED`。**必须过这道滤**：EnumWindows 连"可见但被 DWM 隐藏"的窗口也一并给出
    /// （UWP 的常驻幽灵窗口、已切走的虚拟桌面上的窗口），而 UIA 的 control view 本来把它们
    /// 藏着。不滤，`windows()` 会凭空多出一批用户在屏幕上根本找不到的行——而这份清单的下游
    /// (`resolve_window`) 是**歧义即报错**的，多一行幽灵就可能把一次正常的 `focusApp` 变成
    /// `ambiguous-window`。
    pub const DWMWA_CLOAKED: u32 = 14;

    #[link(name = "dwmapi")]
    extern "system" {
        pub fn DwmGetWindowAttribute(hwnd: Hwnd, attr: u32, out: *mut u32, size: u32) -> i32;
    }

    unsafe extern "system" fn collect_visible(hwnd: Hwnd, lparam: isize) -> i32 {
        if IsWindowVisible(hwnd) != 0 {
            let out = &mut *(lparam as *mut Vec<Hwnd>);
            out.push(hwnd);
        }
        1 // 继续枚举
    }

    /// 可见的顶层窗口（未滤标题、未滤 cloaked——那两道在调用方，因为它们是"清单口径"不是
    /// "枚举能力"）。
    pub fn visible_top_level_windows() -> Vec<Hwnd> {
        let mut out: Vec<Hwnd> = Vec::new();
        unsafe { EnumWindows(collect_visible, &mut out as *mut Vec<Hwnd> as isize) };
        out
    }

    /// 窗口标题。取不到/为空回空串——调用方据此跳过（工具窗、隐藏宿主窗口）。
    pub fn window_title(hwnd: Hwnd) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }

    /// DWM 把它藏起来了吗。查询失败一律当"没藏"——**不认识的情况不许把窗口吞掉**，
    /// 少一行的代价（寻址不到）比多一行（清单里多个幽灵）大得多。
    pub fn is_cloaked(hwnd: Hwnd) -> bool {
        let mut cloaked: u32 = 0;
        let hr = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked, 4) };
        hr == 0 && cloaked != 0
    }

    /// 这个窗口的进程 id。
    pub fn pid_of(hwnd: Hwnd) -> u32 {
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentThreadId() -> u32;
    }

    // ── 会话锁没锁（WTS）─────────────────────────────────────────────────────
    //
    // **纯读**：不枚举窗口、不碰前台，所以能放进 `find` 这类只读路径。这正是我们缺的
    // 那个判据——`GetForegroundWindow` + 窗口枚举那条只在"刚抬过前台之后"才准。
    //
    // 两条已证伪的路，别重摸：
    //  1. `OpenInputDesktop` + 读桌面名——本仓库此前记为"恒报 Default"。真正的判据其实是
    //     **调用失败**（锁屏时安全桌面归 Winlogon，普通用户进程拿不到句柄），读名字读的是
    //     回落来的旧句柄。就算修对，它也对权限上下文极其敏感（跑成 SYSTEM 时永远拿得到句柄）。
    //  2. `WTSRegisterSessionNotification` + `WM_WTSSESSION_CHANGE`——事件式，准，但要一个
    //     HWND 和一个消息泵。agent 是控制台程序，为一个布尔值养一条消息循环不划算。
    //
    // 用的是 `WTSSessionInfoEx` 的 `SessionFlags`。已知缺陷：Windows 7 / Server 2008 R2 上
    // LOCK 与 UNLOCK 两个值是**反的**（微软自己记着），Win8+ 才正常——所以下面只认这两个
    // 确定值，其余（含 `WTS_SESSIONSTATE_UNKNOWN`）一律回 `None`，不猜。
    #[link(name = "wtsapi32")]
    extern "system" {
        pub fn WTSQuerySessionInformationW(
            server: isize,
            session_id: u32,
            info_class: i32,
            buffer: *mut *mut u8,
            bytes: *mut u32,
        ) -> i32;
        pub fn WTSFreeMemory(mem: *mut u8);
    }
    pub const WTS_CURRENT_SERVER_HANDLE: isize = 0;
    pub const WTS_CURRENT_SESSION: u32 = 0xFFFF_FFFF;
    /// `WTS_INFO_CLASS::WTSSessionInfoEx`
    pub const WTS_SESSION_INFO_EX: i32 = 25;
    pub const WTS_SESSIONSTATE_LOCK: i32 = 0;
    pub const WTS_SESSIONSTATE_UNLOCK: i32 = 1;

    /// `WTSINFOEXW` 的**头部**——只声明我们要读的那几个字段，后面还有一长串（登录时间、
    /// 字节计数…）不关心。`Level` 之后有 4 字节填充：`WTSINFOEX_LEVEL1_W` 里含
    /// `LARGE_INTEGER`，整个联合体按 8 对齐，所以 `Data` 落在偏移 8。填充写成显式字段，
    /// 别靠"应该会对齐"——布局猜错了读出来的是垃圾，而垃圾恰好等于 0 就是"锁着"。
    #[repr(C)]
    pub struct WtsInfoExHead {
        pub level: u32,
        pub _pad: u32,
        pub session_id: u32,
        pub session_state: i32,
        pub session_flags: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct WinRect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowRect(hwnd: Hwnd, rect: *mut WinRect) -> i32;
        /// 这个窗口所在显示器的 DPI（96 = 100%）。**只用来报 scale 这个诊断字段**——
        /// 进程已声明 Per-Monitor-V2，坐标本身不需要它换算。失败回 0。
        pub fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    }

    /// `GUITHREADINFO` —— **某个线程的输入队列此刻是什么状态**，其中 `hwnd_focus` 就是
    /// Win32 层面的键盘焦点窗口。它是 `focus-probe` 的核心读数：键盘焦点是**每个输入队列一份**
    /// 的，一个线程的窗口不在活动输入队列里时 `hwnd_focus` 恒为 0——那正是"投进去的按键没有
    /// 收件人"的样子。`GetFocus()` 只报调用线程自己的，跨进程读必须走这一个。
    #[repr(C)]
    #[derive(Default)]
    pub struct GuiThreadInfo {
        pub cb_size: u32,
        pub flags: u32,
        pub hwnd_active: Hwnd,
        pub hwnd_focus: Hwnd,
        pub hwnd_capture: Hwnd,
        pub hwnd_menu_owner: Hwnd,
        pub hwnd_move_size: Hwnd,
        pub hwnd_caret: Hwnd,
        pub rc_caret: WinRect,
    }
    #[link(name = "user32")]
    extern "system" {
        /// `thread == 0` → 前台线程。失败回 0（`cb_size` 没填对时必然失败）。
        pub fn GetGUIThreadInfo(thread: u32, gui: *mut GuiThreadInfo) -> i32;
        /// `SM_XVIRTUALSCREEN`=76 `SM_YVIRTUALSCREEN`=77 `SM_CXVIRTUALSCREEN`=78 `SM_CYVIRTUALSCREEN`=79
        pub fn GetSystemMetrics(index: i32) -> i32;
    }
    // ── 零位移的真实输入（叫醒渲染端用）────────────────────────────────────────
    //
    // `SendInput` 发一个 `MOUSEEVENTF_MOVE` 且 `dx=dy=0` 的**相对**移动：它算一次真实输入
    // （重置系统空闲计时器、把挂起的渲染端放出来），但**指针一动不动**。相比"把指针挪到
    // 窗口中心"，代价从"用户正在拖东西时指针跳走"降到零。
    pub const INPUT_MOUSE: u32 = 0;
    pub const MOUSEEVENTF_MOVE: u32 = 0x0001;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct MouseInput {
        pub dx: i32,
        pub dy: i32,
        pub mouse_data: u32,
        pub flags: u32,
        pub time: u32,
        pub extra: usize,
    }
    /// `INPUT`：`DWORD type` + 一个 union。`extra: usize` 把 `MouseInput` 对齐到 8，
    /// `repr(C)` 于是自动在 `kind` 后补 4 字节——和 Win32 的布局一致（x64 上 40 字节）。
    #[repr(C)]
    pub struct Input {
        pub kind: u32,
        pub mi: MouseInput,
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn SendInput(n: u32, inputs: *const Input, size: i32) -> u32;
    }
    pub const INPUT_KEYBOARD: u32 = 1;
    pub const KEYEVENTF_KEYUP: u32 = 0x0002;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct KeybdInput {
        pub vk: u16,
        pub scan: u16,
        pub flags: u32,
        pub time: u32,
        pub extra: usize,
    }
    /// 和 `Input` **必须同尺寸**（Win32 的 `INPUT` 按最大的那个 union 成员定尺寸，即 MOUSEINPUT），
    /// 否则 `SendInput` 会按 `cbSize` 读过头。尾部这几个字节就是补到同尺寸用的，
    /// `send_key_real` 里有一条运行期断言钉着它。
    #[repr(C)]
    pub struct InputKey {
        pub kind: u32,
        pub ki: KeybdInput,
        pub _pad: [u8; 8],
    }
    /// 发一次**真实**按键（`SendInput`，不是投给窗口的消息）。
    ///
    /// 为什么非它不可：投出去的 `WM_KEYDOWN` 在"没有任何可编辑元素持有焦点"的时候会被整份
    /// 丢弃——**连 Tab 都挪不动焦点**（本机 2026-09-08 实测：投 Tab ×3，焦点一直停在 `Document`）。
    /// 而同样一个 Tab 走真实输入就能走焦点环（`Document → 发送 → 最小化 → …`）。
    /// 这条差别是"键盘能不能救纯识别方案"那一问的全部要害。
    pub fn send_key_real(vk: u16) -> bool {
        assert_eq!(std::mem::size_of::<InputKey>(), std::mem::size_of::<Input>(), "INPUT 尺寸对不上，SendInput 会读过头");
        let mk = |flags: u32| InputKey {
            kind: INPUT_KEYBOARD,
            ki: KeybdInput { vk, flags, ..Default::default() },
            _pad: [0; 8],
        };
        // 只有一个 `SendInput` 符号（`INPUT` 是个 union）——键盘那一档按同尺寸的结构体转过去，
        // 别再声明第二个名字：mingw 的导入库里没有那个符号，链接期才炸。
        let size = std::mem::size_of::<InputKey>() as i32;
        let send = |k: &InputKey| unsafe { SendInput(1, (k as *const InputKey).cast::<Input>(), size) };
        let down = send(&mk(0));
        std::thread::sleep(std::time::Duration::from_millis(40));
        let up = send(&mk(KEYEVENTF_KEYUP));
        down == 1 && up == 1
    }

    /// 发一次**真实**组合键（修饰键按住 → 主键按下抬起 → 修饰键抬起）。
    pub fn send_chord_real(modifier: u16, key: u16) -> bool {
        let ev = |vk: u16, up: bool| InputKey {
            kind: INPUT_KEYBOARD,
            ki: KeybdInput { vk, flags: if up { KEYEVENTF_KEYUP } else { 0 }, ..Default::default() },
            _pad: [0; 8],
        };
        let size = std::mem::size_of::<InputKey>() as i32;
        let send = |k: &InputKey| unsafe { SendInput(1, (k as *const InputKey).cast::<Input>(), size) } == 1;
        let mut ok = send(&ev(modifier, false));
        std::thread::sleep(std::time::Duration::from_millis(40));
        ok &= send(&ev(key, false));
        std::thread::sleep(std::time::Duration::from_millis(40));
        ok &= send(&ev(key, true));
        std::thread::sleep(std::time::Duration::from_millis(40));
        ok &= send(&ev(modifier, true));
        ok
    }

    /// 发一次零位移的真实鼠标输入。回 true = 系统收下了。
    pub fn nudge_input() -> bool {
        let ev = Input {
            kind: INPUT_MOUSE,
            mi: MouseInput { flags: MOUSEEVENTF_MOVE, ..Default::default() },
        };
        (unsafe { SendInput(1, &ev, std::mem::size_of::<Input>() as i32) }) == 1
    }

    /// 读一个线程的输入队列状态。`tid = 0` 读前台线程。读不到 → None。
    pub fn gui_thread_info(tid: u32) -> Option<GuiThreadInfo> {
        let mut gti = GuiThreadInfo { cb_size: std::mem::size_of::<GuiThreadInfo>() as u32, ..Default::default() };
        (unsafe { GetGUIThreadInfo(tid, &mut gti) } != 0).then_some(gti)
    }
    /// 这个窗口属于哪个线程。
    pub fn tid_of(hwnd: Hwnd) -> u32 {
        unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) }
    }

    // ── 按窗口句柄截图（PrintWindow）要的那几个 GDI 调用 ─────────────────────────
    //
    // 为什么必须有这条路：抓显示器截的是**屏幕**——目标窗口被遮住/在后台/锁屏时，你截到的是
    // 盖在上面的东西，据此推断"窗口没画"是把两个问题混成了一个（活体 2026-08-02：锁屏壁纸
    // 被当成了"Chrome 没渲染"的证据，其实它什么也证明不了）。`PrintWindow` 直接命令窗口把
    // 自己的内容画进我们的内存位图，`PW_RENDERFULLCONTENT` 连 DWM 合成的窗口（Chrome）也
    // 强制出全帧——窗口在不在屏幕上无关紧要。
    pub const PW_RENDERFULLCONTENT: u32 = 2;
    pub const DIB_RGB_COLORS: u32 = 0;
    pub const BI_RGB: u32 = 0;

    pub type Hdc = isize;
    pub type Hbitmap = isize;
    pub type Hgdiobj = isize;

    #[repr(C)]
    pub struct BitmapInfoHeader {
        pub size: u32,
        pub width: i32,
        pub height: i32,
        pub planes: u16,
        pub bit_count: u16,
        pub compression: u32,
        pub size_image: u32,
        pub x_ppm: i32,
        pub y_ppm: i32,
        pub clr_used: u32,
        pub clr_important: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowDC(hwnd: Hwnd) -> Hdc;
        pub fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
        pub fn PrintWindow(hwnd: Hwnd, hdc: Hdc, flags: u32) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        pub fn CreateCompatibleBitmap(hdc: Hdc, w: i32, h: i32) -> Hbitmap;
        pub fn SelectObject(hdc: Hdc, obj: Hgdiobj) -> Hgdiobj;
        pub fn DeleteObject(obj: Hgdiobj) -> i32;
        pub fn DeleteDC(hdc: Hdc) -> i32;
        pub fn GetDIBits(
            hdc: Hdc,
            bmp: Hbitmap,
            start: u32,
            lines: u32,
            bits: *mut u8,
            info: *mut BitmapInfoHeader,
            usage: u32,
        ) -> i32;
    }

    /// `UIElement` 的原生窗口句柄 → 原始 isize。
    ///
    /// `uiautomation::Handle` 内包着 `windows` crate 的 `HWND`,而直接 import 那个类型会把本
    /// crate 和 uiautomation 的 `windows` 版本焊死(它现在同时存在 0.56/0.57 两份)。`Handle`
    /// 的 `Debug` 是稳定的 `Handle(0x{:X})`,从那里取十六进制位模式是**不引入版本耦合**的取法。
    pub fn hwnd_of(el: &uiautomation::UIElement) -> Hwnd {
        let Ok(h) = el.get_native_window_handle() else { return 0 };
        let s = format!("{h:?}");
        // 只认 "Handle(0x....)" 这一种形状——匹配不上就返回 0(调用方据此走"验证不了"分支),
        // 而不是去 filter 十六进制字符:"Handle" 里的 a/d/e 本身就是合法十六进制,那样会拼出
        // 一个看着合理的假句柄。
        let Some(hex) = s.strip_prefix("Handle(0x").and_then(|r| r.strip_suffix(')')) else {
            return 0;
        };
        Hwnd::from_str_radix(hex, 16).unwrap_or(0)
    }
}

pub struct WindowsDesktop {
    auto: UIAutomation,
    enigo: Enigo,
    /// located elements by opaque ref — populated on `find`, consumed by `invoke`
    elements: HashMap<String, UIElement>,
    next_ref: u64,
    /// the target app window (set by `focus_app`); find/read scope to it — NOT the whole desktop,
    /// or ListItems from foreign windows leak into results (a real runtime bug this caught).
    app_root: Option<UIElement>,
    /// 我们通过 `focus_window` 确立过的目标窗口（hwnd 十进制字符串）。坐标输入前拿它和
    /// 当前前台比对——没有它就等于对着屏幕盲按。
    focus_target: Option<String>,
    /// `app_root` 对应的窗口 id（hwnd 十进制字符串）。`app_root` 本身是个 UIElement，问不出
    /// 我们当初是按哪个 hwnd 限定的；而空结果要不要打「可能没读到」那面旗，正取决于**这个
    /// 窗口**在不在前台（见 `protocol::empty_may_be_unbuilt`）。
    scope_target: Option<String>,
    /// 识别层的两个引擎（PP-OCR + 图标检测器），惰性加载、两个平台共用（`see::SeeEngines`）。
    /// 模型或运行时库缺席就报错，没有第二条路（spec 2026-09-14 §1）。
    see: crate::see::SeeEngines,
    /// 每个进程**上一次报出来的**控件树条数（`None` = 上次超预算作废）。**只用于日志限流**，
    /// 不参与任何判断——枚举本身每次都真做（见 `interactive_elements` 开头那段）。
    /// 存在的理由是让日志只在**结果变了**的时候出声：「0 → 329」才是信号，一行刷一万遍不是。
    a11y_last_report: HashMap<String, Option<usize>>,
}

impl Default for WindowsDesktop {
    fn default() -> Self {
        Self {
            auto: UIAutomation::new().expect("UIAutomation init"),
            enigo: Enigo::new(&Settings::default()).expect("enigo init"),
            elements: HashMap::new(),
            next_ref: 1,
            app_root: None,
            focus_target: None,
            scope_target: None,
            see: crate::see::SeeEngines::default(),
            a11y_last_report: HashMap::new(),
        }
    }
}

// `log_see_failure` / `see_detector_path` / `ocr_models_dir` / `crop_to_region` 与 `see_probe`
// 都住 `see.rs`（两个平台后端共用，见那边那一节的头注）。

/// a11y 那一档只取**可交互**角色。
///
/// 不取 `Text`/`Group`/`Pane` 这些：元素表回答的是"哪儿能点"，把纯装饰的容器算进来，
/// 上层"同档多命中就拒绝"的判据会被一堆套在一起的 Pane 打成永远歧义——而那个失败长得像
/// "找不到目标"。写不写得中由 `synthesize_elements` 的文字那一档兜底（落单即入表）。
const INTERACTIVE_ROLES: &[&str] =
    &["Button", "ListItem", "Edit", "MenuItem", "Hyperlink", "CheckBox", "TabItem"];

/// 单个角色一次最多收多少个。纯防爆（一个长列表能有上千行），不是语义的一部分。
const MAX_A11Y_PER_ROLE: usize = 200;

/// 枚举整棵控件树的时间预算。超了就把这一轮的结果整份丢掉（**只丢这一轮**，见
/// `interactive_elements`）。
///
/// 这个数当初是照"客户端爬树"那份成本定的：微信一次 `readElements` 22.5 秒、其中 21.5 秒
/// 是七个角色的遍历、返回 0 个控件。查询换成 provider 侧的 `FindAllBuildCache` 之后那份成本
/// 塌了一个数量级——本机 2026-09-07 实测：**Chrome 329 个控件 0.6s**（换之前是超预算 1.4s、
/// 结果作废）、**QQ 空树 48ms**（换之前 105–118ms）。
///
/// 所以这道闸现在挡的是**一个还没见过的病态应用**，不再是常态。1.2s 留着不动：它在实测里
/// 离两边都很远（最慢的真树 0.6s、最快的空树 0.05s），调它没有依据。
///
/// **预算只在角色之间检查**，一次 `find_all_build_cache` 下去就收不回来——所以实际会超到
/// "一个角色的成本"。
///
/// **注意这不影响四段梯子的第一段**：那一段是按名字直接 `find`，走的是另一条路，
/// 有控件树的应用照样在那儿就命中了。这里管的只有"枚举整屏元素"这一件事。
const A11Y_BUDGET_MS: u128 = 1200;

/// Map a neutral role string to a UIA ControlType. Unknown → None (query ignores control type).
/// role 名 → UIA ControlType。**认不出的 role 是错误，不是"没有过滤"**：老实现返回 `None`
/// 时调用方静默丢掉 role 条件，于是 `{role:"TabItem",name:"扩展程序"}` 把工具栏上一个同名
/// Button 也捞了回来——第一名的错误命中会被 click 直接执行（活体 2026-08-02 撞到）。
fn role_to_control(role: &str) -> Result<ControlType, String> {
    Ok(match role {
        "Button" => ControlType::Button,
        "List" => ControlType::List,
        "ListItem" => ControlType::ListItem,
        "Edit" => ControlType::Edit,
        "Text" => ControlType::Text,
        "Group" => ControlType::Group,
        "Window" => ControlType::Window,
        "DataItem" => ControlType::DataItem,
        "Tab" => ControlType::Tab,
        "TabItem" => ControlType::TabItem,
        "Hyperlink" => ControlType::Hyperlink,
        "CheckBox" => ControlType::CheckBox,
        "ComboBox" => ControlType::ComboBox,
        "MenuItem" => ControlType::MenuItem,
        "Document" => ControlType::Document,
        "Pane" => ControlType::Pane,
        "ToolBar" => ControlType::ToolBar,
        "Image" => ControlType::Image,
        "TreeItem" => ControlType::TreeItem,
        "Custom" => ControlType::Custom,
        other => {
            return Err(format!(
                "unknown role '{other}'——认不出的 role 不能当没写（那会让过滤静默失效、错误元素顶上来）"
            ))
        }
    })
}

fn control_to_role(ct: ControlType) -> String {
    format!("{ct:?}")
}

/// 这一份查询要 provider **一次性带回来**的属性。
///
/// **它和下面每一处 `get_cached_*` 是一对**：这里少列一个，那一处就静默退化成默认值
/// （名字变空串、框变 0×0）——不报错，只是元素表里多出一批"没名字、点不到"的条目。
/// 想多读一个属性，就先往这张表里加一行。
const CACHED_PROPERTIES: &[UIProperty] = &[
    UIProperty::Name,
    UIProperty::BoundingRectangle,
    UIProperty::ControlType,
    UIProperty::ClassName,
];

impl WindowsDesktop {
    /// 把一条 `A11yQuery` 翻成 UIA 的**条件对象**——交给 provider 在它自己的进程里评估。
    /// 一个条件都没有就是"全要"（`create_true_condition`）。
    fn condition(&self, q: &A11yQuery) -> Result<UICondition, String> {
        let err = |e: uiautomation::Error| e.to_string();
        let mut parts: Vec<UICondition> = Vec::new();
        if let Some(role) = q.role.as_deref() {
            let ct = role_to_control(role)?;
            parts.push(
                self.auto
                    .create_property_condition(UIProperty::ControlType, Variant::from(ct as i32), None)
                    .map_err(err)?,
            );
        }
        if let Some(name) = q.name.as_deref() {
            // 全等、区分大小写——和老 matcher 的 `.name()` 同语义。
            parts.push(self.auto.create_property_condition(UIProperty::Name, Variant::from(name), None).map_err(err)?);
        }
        if let Some(name) = q.name_contains.as_deref() {
            // 子串 + 忽略大小写（`PropertyConditionFlags::All` = IgnoreCase | MatchSubstring），
            // 和老 matcher 的 `.contains_name()` 同语义。**这一档由 UIA 自己实现**，不是我们
            // 拉回字符串再比——那正是要甩掉的那次跨进程往返。
            parts.push(
                self.auto
                    .create_property_condition(UIProperty::Name, Variant::from(name), Some(PropertyConditionFlags::All))
                    .map_err(err)?,
            );
        }
        if let Some(cls) = q.class_name.as_deref() {
            parts.push(
                self.auto.create_property_condition(UIProperty::ClassName, Variant::from(cls), None).map_err(err)?,
            );
        }
        let mut it = parts.into_iter();
        let Some(first) = it.next() else { return self.auto.create_true_condition().map_err(err) };
        it.try_fold(first, |acc, c| self.auto.create_and_condition(acc, c).map_err(err))
    }

    /// 一次往返把 `CACHED_PROPERTIES` 全带回来的请求。
    ///
    /// `tree_filter` 显式钉成 **control view**：老的 matcher 默认就是 `UIMatcherMode::Control`，
    /// 不钉住的话换成 raw view 会把一堆装饰性节点也算进来，表现是元素表凭空胖了一圈。
    /// `element_mode` 保持默认的 **Full**（不是 `None`）——`find` 那条路要把元素存进
    /// `self.elements` 供之后 `invoke` 用，cache-only 的代理调不了 pattern。
    ///
    /// **`tree_scope` 一定要留在默认的 `Element`，别设成 `Descendants`。** 配合
    /// `FindAllBuildCache` 时它必须是 `Element`，否则整条查询回 `E_INVALIDARG`——而那个错误
    /// 在 `interactive_elements` 里被 `let Ok(Ok(..)) else { continue }` 吃掉，表现是**每个角色
    /// 都"没找到"、元素表凭空变空**，一个字都不报。真踩过一次（2026-09-07：explorer 上
    /// 可交互控件从 5 个变 0 个，只有对照实验才看得出来）。这里要的本来也只是"这些元素自己的
    /// 那几个属性"，不是它们的整棵子树。
    fn cache_request(&self) -> Result<UICacheRequest, String> {
        let err = |e: uiautomation::Error| e.to_string();
        let req = self.auto.create_cache_request().map_err(err)?;
        req.set_tree_filter(self.auto.get_control_view_condition().map_err(err)?).map_err(err)?;
        for p in CACHED_PROPERTIES {
            req.add_property(*p).map_err(err)?;
        }
        Ok(req)
    }

    /// 一条查询 → **所有**命中（`root` 的全部后代）。未知 role 直接报错（`Err(String)`）；
    /// 查询本身没找到仍归"空结果"（内层 `Err`）。
    ///
    /// **这里走的是 provider 侧的 `FindAllBuildCache`，不是 crate 的 `create_matcher()`。**
    /// 两者差着一个数量级，而且差在原理上：
    ///
    /// - matcher 是**客户端手工爬树**——`TreeWalker` 一个节点一个节点地要子节点/兄弟节点，
    ///   每爬到一个就把 name / control type / classname **拉回本进程**再比对。每一次读都是
    ///   一趟跨进程 COM。它还默认 `timeout: 3000` 重试：没找到就整棵树重扫，每 100ms 一轮，
    ///   直到 3 秒耗尽——于是**每一次"这儿没有这个控件"都恰好要价 3 秒**，而"没有"在自绘 /
    ///   后台 Electron 窗口上是常态。那个 21.5 秒的传说就是七个角色各空转 3 秒。
    /// - `FindAllBuildCache` 把条件交给 provider 在**应用自己的进程里**评估，再按
    ///   `CACHED_PROPERTIES` 把属性一次性打包回来。**一次往返**，之后 `get_cached_*` 不再过界。
    ///
    /// 用 DOM 打比方：以前是放着 `querySelectorAll` 不用、自己递归 `childNodes` 且每读一个
    /// 属性发一次 IPC；现在是把选择器交给引擎，连要的 attribute 一起要回来。
    ///
    /// 一处语义差别，记在这儿免得以后当成 bug 查：老实现有 `depth(40)` 的深度上限，
    /// `TreeScope::Descendants` 没有上限。四十层以下的控件从此也会被收进来——真实界面里
    /// 够不到这个深度，而 `MAX_A11Y_PER_ROLE` 那道防爆闸照旧管着条数。
    fn find_all(&self, root: &UIElement, q: &A11yQuery) -> Result<Result<Vec<UIElement>, uiautomation::Error>, String> {
        q.validate()?;
        let cond = self.condition(q)?;
        let cache = self.cache_request()?;
        Ok(root.find_all_build_cache(TreeScope::Descendants, &cond, &cache))
    }

    fn to_element(&mut self, el: UIElement) -> A11yElement {
        let el_ref = format!("el-{}", self.next_ref);
        self.next_ref += 1;
        // **一律读缓存**（`get_cached_*`）：这几个属性在 `find_all` 那一次往返里已经带回来了，
        // 再走 live 的 `get_*` 等于每个元素每个属性各补一趟跨进程调用——五十个元素就是两百趟，
        // 而它不会报错，只会慢。要读的属性必须先进 `CACHED_PROPERTIES`。
        let rect = el.get_cached_bounding_rectangle().unwrap_or_default();
        let out = A11yElement {
            el_ref: el_ref.clone(),
            role: el.get_cached_control_type().map(control_to_role).unwrap_or_default(),
            name: el.get_cached_name().unwrap_or_default(),
            class_name: el.get_cached_classname().unwrap_or_default(),
            rect: Rect {
                x: rect.get_left(),
                y: rect.get_top(),
                w: rect.get_right() - rect.get_left(),
                h: rect.get_bottom() - rect.get_top(),
            },
        };
        self.elements.insert(el_ref, el);
        out
    }

    /// 按 hwnd 认出那个窗口的 UIA 元素。**直接 `element_from_handle`，不走 walker**——
    /// walker 那条路只能认出它自己枚举得到的窗口，而它看不见模态对话框（见 `win32` 里
    /// EnumWindows 那段实测）。口径仍然一致：`windows()` 现在也按 hwnd 枚举，凡是列出来的
    /// 都能在这里拿到元素。
    fn window_by_hwnd(&self, hwnd: win32::Hwnd) -> Result<UIElement, String> {
        self.auto
            .element_from_handle(uiautomation::types::Handle::from(hwnd))
            .map_err(|e| format!("no-window-match: 窗口 {hwnd} 拿不到（已关闭？）：{e}"))
    }

    /// Where find/read search: the target app window if focused, else the whole desktop.
    fn scope_root(&self) -> uiautomation::Result<UIElement> {
        match &self.app_root {
            Some(w) => Ok(w.clone()),
            None => self.auto.get_root_element(),
        }
    }

    /// 此刻被限定的那个窗口的 hwnd。`readText`/`readElements`/`findImage` 共用——没有目标
    /// 窗口就直接拒，理由见 `find_image` 的头注（回落抓屏会让框指向另一套坐标系）。
    fn target_hwnd(&self) -> Result<win32::Hwnd, String> {
        self.app_root
            .as_ref()
            .map(win32::hwnd_of)
            .filter(|h| *h != 0)
            .ok_or_else(|| "no-scope: 还没确立目标窗口，先 scopeWindow / focusApp".to_string())
    }

    /// 认出这一块图上的字。**只有 PP-OCR 这一条路**，与 mac 同形：模型或运行时库缺席，
    /// `SeeEngines::ocr` 的错误（`ocr-missing:` / `ort-missing:`）原样上报，绝不回空数组
    /// （系统自带的 OCR 不是退路——它对中文按单字切、小字全错，recipe 照跑而 `see` 全不中，
    /// 没有一处会喊；见 `ocr.rs` 头注与 spec 2026-09-14 §1）。
    ///
    /// `cropped`：这张图是不是窗口里裁出来的一块（给了 `region`）。裁块不做 det 前的小图放大
    /// （见 `OcrEngine::read_opts`）——字和整窗一样大，放大只是把检测的面积白拉大几倍。
    /// `scale`：`dpi_scale(hwnd)`，200% DPI 的机器上检测在 1× 上跑、识别吃物理像素、同一帧不重认
    /// （`SeeEngines::ocr_texts`）。
    fn ocr_texts(&mut self, img: &image::RgbImage, scale: f64, cropped: bool) -> Result<Vec<protocol::ScreenText>, String> {
        self.see.ocr()?;
        self.see.ocr_texts(img, scale, cropped)
    }

    fn detector_rects(&self, img: &image::RgbImage) -> Vec<Rect> {
        self.see.detector_rects(img)
    }

    /// a11y 那一档：从**现有的 UIA 查询**（`find_all`）里逐个可交互角色收一遍。
    ///
    /// 框从屏幕物理坐标换成**截图坐标**（减掉窗口原点），和另外两档同一套坐标系——
    /// 不换的话 `synthesize_elements` 的 IoU 会拿两套坐标去比，结果是三档永远合不到一起，
    /// 而那个失败是安静的（元素表照样有内容，只是重复且没名字）。
    ///
    /// **不走 `find`**：那条路会把每个元素登记进 `self.elements` 换一个可 invoke 的 ref，
    /// 而元素表一次就是几百个、每步都读一遍——登记等于让那张表无上限地涨。元素表给的是
    /// 坐标框（点它走 click），不是句柄。
    ///
    /// 查询失败一律当"这一档没有"（空），不报错：自绘应用（微信、QQ）大片界面本来就不在
    /// UIA 树里，那是这条路的常态，不是错误。
    fn interactive_elements(&mut self, window: &Rect, process: &str) -> Vec<protocol::Element> {
        // **每次都问，不记黑名单。** 这里曾经有一个 `a11y_hopeless` 集合：某个进程问下来空
        // （或超预算）就把它记下，此后 agent 活着的整段时间再也不问。它治的是"问一次要 3.5 秒"，
        // 而那个成本已经不存在了（provider 侧查询：空树 48ms）。
        //
        // 记它的代价反而是实打实的：**判据是临时状态，结论却是永久的**。"这个应用现在没有
        // 可交互控件"随时会变——窗口激活、应用把 a11y 打开、用户开了一个新界面。一旦记下，
        // 后来真长出来的树我们再也看不见，而且**一个字都不会报**。今天就撞上了：QQ 在后台被
        // 记进去之后，"QQ 有没有控件树"这一问在那个 agent 进程里就再也没有第二次机会。
        //
        // 用一次 48ms 换掉这个永久性的错，是划算的。
        //
        // **recipe 的 `app.a11y:false` 不是这个黑名单换了个地方。** 它是作者申报的一个不变事实
        // （微信 4.x 整个窗口只有一个自绘 Pane，与前后台无关），由 `read_elements` 的 `a11y`
        // 入参在**调用方**决定跳不跳；这里从不自己下"以后不问了"的结论。
        let Ok(root) = self.scope_root() else { return Vec::new() };
        let started = std::time::Instant::now();
        let mut out = Vec::new();
        let mut over_budget = false;
        for role in INTERACTIVE_ROLES {
            if started.elapsed().as_millis() > A11Y_BUDGET_MS {
                over_budget = true;
                break;
            }
            let q = A11yQuery { role: Some((*role).to_string()), ..Default::default() };
            let found = match self.find_all(&root, &q) {
                Ok(Ok(v)) => v,
                // 内层 Err = 这个角色一个都没有。常态，不吭声。
                Ok(Err(_)) => continue,
                // 外层 Err = **查询本身建不起来**（条件或缓存请求不合法）。必须出声：它的表现
                // 和"这个应用压根没有控件树"一模一样——一个配置错误会伪装成一个平台事实。
                Err(e) => {
                    eprintln!("[stream-desktop] {process} 的 {role} 查询建不起来：{e}");
                    continue;
                }
            };
            for el in found.into_iter().take(MAX_A11Y_PER_ROLE) {
                // 缓存读，理由同 `to_element`——这里一次能出几百个元素，live 读的代价乘以条数。
                let Ok(r) = el.get_cached_bounding_rectangle() else { continue };
                let rect = Rect {
                    x: r.get_left() - window.x,
                    y: r.get_top() - window.y,
                    w: r.get_right() - r.get_left(),
                    h: r.get_bottom() - r.get_top(),
                };
                if rect.w <= 0 || rect.h <= 0 {
                    continue;
                }
                let name = el.get_cached_name().unwrap_or_default();
                out.push(protocol::Element {
                    rect,
                    // 空名字要报成 `None` 而不是空串：上层按名字匹配时，空串会和"包含匹配"
                    // 擦出静默命中（任何查询都包含空串）。
                    name: (!name.trim().is_empty()).then_some(name),
                    kind: protocol::ElementKind::A11y,
                });
            }
        }
        // **超预算就整份丢掉，不交半份**：半份元素表和完整的那份长得一模一样，只是少了几个
        // 目标——而"少了的那个恰好是这一步要点的"表现成"找不到"，没有任何一处会说是因为超时。
        let count = if over_budget { None } else { Some(out.len()) };
        // **只在结果变了的时候打印。** 不再有黑名单之后这条路每步都走，照实打会把同一行刷满
        // 整份日志、把别的线索埋掉；而真正要看见的恰恰是**变化**——"0 → 329" 正是"这个应用
        // 的树长出来了"，也是今天唯一还没验的那一问。成功那一档也报（此前只有失败才打印，
        // 于是"这一档多少钱"只在它已经坏掉时才看得见，而判断贵不贵要的是它正常工作时的数）。
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

impl Desktop for WindowsDesktop {
    /// 把目标窗口弄到前台,**并回读验证**。
    ///
    /// 返回值是「它现在真的在前台吗」,不是「我调用过了吗」。这个区别是踩出来的:老实现
    /// `let _ = win.set_focus(); Ok(true)` 恒返回 true,而 UIA 的 `set_focus()` 既不还原
    /// 最小化窗口、也翻不过 Windows 的**前台锁**——2026-07-25 活体里它对着一个最小化的 Chrome
    /// 报了 true,后续所有 OS 点击**落在了桌面和终端上**,而浏览器侧 DOM 还在回报「对话框在」
    /// (更早一次留下的残留),于是一个根本没发生的实验被当真分析了二十分钟。
    ///
    /// 前台是 OS 输入的**前提**(click 打到光标底下那个窗口、type 打到焦点窗口),所以这里宁可
    /// 如实返回 false 让调用方停下,也不能给一个哄人的 true。
    fn focus_window(&mut self, id: &str) -> Result<bool, String> {
        let hwnd: win32::Hwnd = id.parse().map_err(|_| format!("bad window id: {id}"))?;
        let win = self.window_by_hwnd(hwnd)?;

        if hwnd != 0 {
            unsafe {
                // ① 最小化的窗口先还原——SetForegroundWindow 对最小化窗口不还原,只会闪一下。
                if win32::IsIconic(hwnd) != 0 {
                    win32::ShowWindow(hwnd, win32::SW_RESTORE);
                }
                // ② 前台锁:后台进程直接 SetForegroundWindow 会被系统**悄悄拒绝**(返回 0,不报错)。
                //    把自己的输入队列挂到当前前台窗口那条线程上,系统就把这次调用当"前台进程自己
                //    让出的",于是放行。用完必须解挂,否则两条线程的输入队列一直粘着。
                let fg = win32::GetForegroundWindow();
                let fg_thread = win32::GetWindowThreadProcessId(fg, std::ptr::null_mut());
                let me = win32::GetCurrentThreadId();
                let attached = fg_thread != 0 && fg_thread != me
                    && win32::AttachThreadInput(me, fg_thread, 1) != 0;
                win32::SetForegroundWindow(hwnd);
                win32::BringWindowToTop(hwnd);
                if attached {
                    win32::AttachThreadInput(me, fg_thread, 0);
                }
            }
        }
        let _ = win.set_focus(); // UIA 侧的焦点(给键盘输入用),失败不致命

        self.app_root = Some(win);
        self.scope_target = Some(hwnd.to_string()); // 焦点也限定范围——两处必须同写，漏一处旗就不准
        // Drop element refs located under the previous window: they're stale after a refocus, and
        // clearing here bounds the cache (a recipe = focus → find → invoke, so refs never outlive
        // their run) instead of letting `find` grow it unbounded across a long-lived agent.
        self.elements.clear();

        // ③ 回读验证。窗口管理器切前台不是同步的(动画/焦点转移),给它几百毫秒轮询;
        //    到点还不是目标就如实 false——调用方据此停手,而不是对着别人的窗口乱点。
        if hwnd == 0 {
            return Ok(false); // 拿不到 HWND(非原生窗口),无法验证 → 不谎报
        }
        for _ in 0..10 {
            if unsafe { win32::GetForegroundWindow() } == hwnd {
                self.focus_target = Some(hwnd.to_string());
                return Ok(true);
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        Ok(false)
    }

    /// 列顶层窗口。**枚举走 Win32 `EnumWindows`，不走 UIA walker**——判据不变（可见、有标题），
    /// 变的只是"谁来枚举"：UIA 的 control-view walker 看不见模态对话框（Chrome 的文件夹选择框
    /// 就是一例，实测见 `win32` 里 EnumWindows 那段），而 agent 够不到对话框就意味着任何
    /// "弹出原生对话框再操作它"的流程整条走不通。
    ///
    /// 三道滤，缺一不可：可见（EnumWindows 自己那步）、**没被 DWM 藏起来**（幽灵窗口）、
    /// 标题非空（工具窗、隐藏宿主窗口——既不是用户认得出的目标，也不该出现在"认出目标再动手"
    /// 的清单里）。列出来的都能 `window_by_hwnd` 拿到元素，所以 `focus_window`/`scope_window`
    /// 的口径和这里一致。
    fn windows(&mut self) -> Result<Vec<protocol::WindowInfo>, String> {
        let fg = unsafe { win32::GetForegroundWindow() };
        let me = std::process::id();
        let listed: Vec<(win32::Hwnd, String)> = win32::visible_top_level_windows()
            .into_iter()
            // **先滤掉 agent 自己的窗口，再取标题**（接管提示条和四边描边就是这里的顶层窗口）。
            // 顺序是要害：`GetWindowTextW` 对**本进程**的窗口不是直接读，而是向窗口所属线程
            // 发 `WM_GETTEXT` 并等它应答——提示条那条线程在跑动画循环，每问一次都得等它画完
            // 一帧。活体 2026-09-29：提示条亮起之前 `windows()` 39ms，亮起之后每次 240–260ms，
            // 而 `focusApp` / `scopeWindow` 都要先调它，一趟 wechat-send 白等两三秒。
            // 它们也从来不是目标：没有哪份 recipe 会去操作 agent 自己的提示条。
            .filter(|&hwnd| win32::pid_of(hwnd) != me)
            .filter_map(|hwnd| {
                let title = win32::window_title(hwnd);
                (!title.is_empty() && !win32::is_cloaked(hwnd)).then_some((hwnd, title))
            })
            .collect();
        // 只问这张表里（加前台那个）窗口的进程——见 `procs.rs` 头注：整机快照要 60–380ms。
        let mut pids: Vec<u32> = listed.iter().map(|(h, _)| win32::pid_of(*h)).collect();
        if fg != 0 {
            pids.push(win32::pid_of(fg));
        }
        pids.sort_unstable();
        pids.dedup();
        let sys = crate::procs::snapshot(&pids, true);
        let process_of = |hwnd: win32::Hwnd| {
            sys.process(sysinfo::Pid::from_u32(win32::pid_of(hwnd)))
                .map(|p| p.name().to_string_lossy().to_string())
                .unwrap_or_default()
        };
        // 应用版本：exe 的 VS_FIXEDFILEINFO。读不到（无版本资源、路径拿不到）就缺席。
        // **按 pid 缓存**：`file_version` 要读盘（`GetFileVersionInfoW`），而一个应用开十几个
        // 窗口是常态——不缓存就把同一个 exe 的版本资源读十几遍。缓存只活在这一次调用里，
        // 应用升级后下一次 `windows()` 自然拿到新的。
        let mut ver_cache: HashMap<u32, Option<String>> = HashMap::new();
        let mut version_of = |hwnd: win32::Hwnd| -> Option<String> {
            let pid = win32::pid_of(hwnd);
            if let Some(v) = ver_cache.get(&pid) {
                return v.clone();
            }
            let v = sys
                .process(sysinfo::Pid::from_u32(pid))
                .and_then(|p| p.exe())
                .and_then(|exe| file_version(exe));
            ver_cache.insert(pid, v.clone());
            v
        };
        let mut out = Vec::new();
        for (hwnd, title) in listed {
            out.push(protocol::WindowInfo {
                id: hwnd.to_string(),
                process: process_of(hwnd),
                title,
                foreground: hwnd == fg,
                platform: protocol::PLATFORM_NAME.into(),
                app_version: version_of(hwnd),
            });
        }
        // **前台那个窗口必须在表里**，哪怕上面三道滤把它筛掉了。锁屏界面（LockApp.exe）就是
        // 这么漏掉的：它 `IsWindowVisible`、有标题，却 **不在 `EnumWindows` 的结果里**、而且
        // DWM 标成 cloaked(2 = shell)——活体 2026-09-07（本机，200% 缩放）三项同时成立。于是
        // 整张表没有一行 `foreground:true`，`protocol::foreground_blocker` 找不到锁屏，抬前台
        // 失败被报成「看不出是谁占着」，而不是 `desktop-locked`——两句话的下一步相反（解锁 vs
        // 等别的窗口让开）。「谁占着前台」是问操作系统的，不归"清单口径"那三道滤管。
        if fg != 0 && !out.iter().any(|w| w.id == fg.to_string()) {
            out.push(protocol::WindowInfo {
                id: fg.to_string(),
                process: process_of(fg),
                title: win32::window_title(fg),
                foreground: true,
                platform: protocol::PLATFORM_NAME.into(),
                app_version: version_of(fg),
            });
        }
        Ok(out)
    }

    /// 只限定读取范围，**不碰焦点**。`focus_window` 里那套抢前台的动作（还原最小化、
    /// AttachThreadInput 绕前台锁、回读验证）这里一个都不做——看一眼不该改变屏幕。
    fn scope_window(&mut self, id: &str) -> Result<(), String> {
        let hwnd: win32::Hwnd = id.parse().map_err(|_| format!("bad window id: {id}"))?;
        let win = self.window_by_hwnd(hwnd)?;
        self.app_root = Some(win);
        self.scope_target = Some(hwnd.to_string());
        self.elements.clear(); // 换了范围，旧 ref 全作废
        Ok(())
    }

    fn focus_target(&mut self) -> Option<String> {
        self.focus_target.clone()
    }

    fn scope_target(&mut self) -> Option<String> {
        self.scope_target.clone()
    }

    fn foreground_window_id(&mut self) -> Result<String, String> {
        Ok(unsafe { win32::GetForegroundWindow() }.to_string())
    }

    /// 见 trait 上的三态约定与 `win32` 里那段"两条已证伪的路"。
    /// 任何一步不如预期都回 `None`——查不出来就说查不出来。
    fn session_locked(&mut self) -> Option<bool> {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut bytes: u32 = 0;
        let ok = unsafe {
            win32::WTSQuerySessionInformationW(
                win32::WTS_CURRENT_SERVER_HANDLE,
                win32::WTS_CURRENT_SESSION,
                win32::WTS_SESSION_INFO_EX,
                &mut buf,
                &mut bytes,
            )
        };
        if ok == 0 || buf.is_null() {
            return None;
        }
        let head = unsafe { &*(buf as *const win32::WtsInfoExHead) };
        // `Level` 必须是 1，否则 `Data` 里躺的不是我们声明的那个布局——不认就走人，
        // 别按错的布局去读一个"看起来很像答案"的整数。
        let flags = (bytes as usize >= std::mem::size_of::<win32::WtsInfoExHead>() && head.level == 1)
            .then_some(head.session_flags);
        unsafe { win32::WTSFreeMemory(buf) };
        match flags? {
            win32::WTS_SESSIONSTATE_LOCK => Some(true),
            win32::WTS_SESSIONSTATE_UNLOCK => Some(false),
            _ => None, // WTS_SESSIONSTATE_UNKNOWN 及其它：没验到
        }
    }

    fn find(&mut self, q: &A11yQuery) -> Result<Vec<A11yElement>, String> {
        let root = self.scope_root().map_err(|e| e.to_string())?;
        let found = match self.find_all(&root, q)? {
            Ok(v) => v,
            Err(_) => return Ok(vec![]), // 没找到 → 空（runner 当作 drift/缺失）
        };
        // 上限只是防爆（一次 look 不该拖回几千个节点），不是语义的一部分。
        Ok(found.into_iter().take(50).map(|el| self.to_element(el)).collect())
    }

    /// 「触发这个元素自带的动作」——**不是只有 Invoke 一种 pattern**。
    ///
    /// UIA 按控件种类分家：按钮是 Invoke，标签页/列表项是 SelectionItem（select），开关是
    /// Toggle，其余老控件走 LegacyIAccessible 的默认动作。老实现只试 Invoke，于是"点一下
    /// Chrome 的某个标签页"这么基本的事直接失败——而且错误经 Win32 格式化后是
    /// `操作成功完成。`（ERROR_SUCCESS 的文本），比失败本身更误导（活体 2026-08-02）。
    /// 这里按序降级，全失败才报错，且把每一层的失败都列出来。
    fn invoke(&mut self, el_ref: &str) -> Result<(), String> {
        let el = self.elements.get(el_ref).ok_or_else(|| format!("unknown element ref: {el_ref}"))?;
        let mut tried = Vec::new();

        match el.get_pattern::<UIInvokePattern>() {
            Ok(p) => match p.invoke() {
                Ok(()) => return Ok(()),
                Err(e) => tried.push(format!("Invoke: {e}")),
            },
            Err(e) => tried.push(format!("Invoke(unavailable): {e}")),
        }
        match el.get_pattern::<UISelectionItemPattern>() {
            Ok(p) => match p.select() {
                Ok(()) => return Ok(()),
                Err(e) => tried.push(format!("SelectionItem: {e}")),
            },
            Err(e) => tried.push(format!("SelectionItem(unavailable): {e}")),
        }
        match el.get_pattern::<UITogglePattern>() {
            Ok(p) => match p.toggle() {
                Ok(()) => return Ok(()),
                Err(e) => tried.push(format!("Toggle: {e}")),
            },
            Err(e) => tried.push(format!("Toggle(unavailable): {e}")),
        }
        match el.get_pattern::<UILegacyIAccessiblePattern>() {
            Ok(p) => match p.do_default_action() {
                Ok(()) => return Ok(()),
                Err(e) => tried.push(format!("LegacyDefaultAction: {e}")),
            },
            Err(e) => tried.push(format!("LegacyDefaultAction(unavailable): {e}")),
        }
        Err(format!("invoke failed on every pattern — {}", tried.join("; ")))
    }

    /// 把文字写进元素本身（不经键盘、不需要前台）。梯子同 `invoke`：Value 是正路，
    /// LegacyIAccessible 收那些只实现了老接口的控件；两层都不认就如实报错，让调用方退回键盘。
    ///
    /// **每一级都必须回读确认，`S_OK` 不算数。** 自绘应用（Telegram 就是）会暴露 Value pattern、
    /// 让 `SetValue` 返回成功，**而输入框里什么也没有**——它有自己的输入处理，根本不理会这条路。
    /// 于是"写进去了"变成一个谎，下游读到的是上一屏的残留，每一步都"成功"。活体实测：
    /// Telegram 的 `Ui::InputField` 两级都这样（2026-08-04，截图为证——框是空的）。
    ///
    /// 所以**读不回来 = 失败**，不是"大概行了"。宁可如实说不成、让调用方退回键盘，也不能给一个
    /// 哄人的成功——后者制造的是静默失真，比报错贵得多。
    fn set_value(&mut self, el_ref: &str, text: &str) -> Result<(), String> {
        let el = self.elements.get(el_ref).ok_or_else(|| format!("unknown element ref: {el_ref}"))?;
        let mut tried = Vec::new();

        // 回读用 Value pattern（Legacy 也有 get_value，但两边读的是同一个值，取得到就够）。
        let readback = |el: &UIElement| -> Option<String> {
            el.get_pattern::<UIValuePattern>()
                .ok()
                .and_then(|p| p.get_value().ok())
                .or_else(|| el.get_pattern::<UILegacyIAccessiblePattern>().ok().and_then(|p| p.get_value().ok()))
        };
        let confirm = |el: &UIElement, rung: &str, tried: &mut Vec<String>| -> bool {
            match readback(el) {
                Some(back) if back == text => true,
                Some(back) => {
                    tried.push(format!("{rung}(报成功但回读是 {back:?}——应用没收下)"));
                    false
                }
                None => {
                    tried.push(format!("{rung}(报成功但读不回来——无法确认，按没写进去算)"));
                    false
                }
            }
        };

        match el.get_pattern::<UIValuePattern>() {
            Ok(p) => match p.set_value(text) {
                Ok(()) if confirm(el, "Value", &mut tried) => return Ok(()),
                Ok(()) => {}
                Err(e) => tried.push(format!("Value: {e}")),
            },
            Err(e) => tried.push(format!("Value(unavailable): {e}")),
        }
        match el.get_pattern::<UILegacyIAccessiblePattern>() {
            Ok(p) => match p.set_value(text) {
                Ok(()) if confirm(el, "LegacySetValue", &mut tried) => return Ok(()),
                Ok(()) => {}
                Err(e) => tried.push(format!("LegacySetValue: {e}")),
            },
            Err(e) => tried.push(format!("LegacySetValue(unavailable): {e}")),
        }
        Err(format!("setValue failed on every pattern — {}", tried.join("; ")))
    }

    fn click(&mut self, rect: &Rect, button: &str) -> Result<(), String> {
        let (cx, cy) = (rect.x + rect.w / 2, rect.y + rect.h / 2);
        // 滑过去再按（见 `glide.rs` 头注）。读不到当前位置就从目标出发 = 退化成瞬移。
        let from = self.enigo.location().unwrap_or((cx, cy));
        let enigo = &mut self.enigo;
        crate::glide::glide_to(from, (cx, cy), |x, y| enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string()))?;
        let b = match button {
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => Button::Left,
        };
        self.enigo.button(b, Click).map_err(|e| e.to_string())
    }

    /// 见 trait 头注。`SendInput` 收下才算数——回 0 是被系统拒了（锁屏那一档就是）。
    fn nudge_input(&mut self) -> Result<(), String> {
        if win32::nudge_input() {
            Ok(())
        } else {
            Err("nudge-refused: SendInput 被系统拒绝（锁屏 / 更高完整性级别的窗口在前台）".to_string())
        }
    }

    fn move_mouse(&mut self, x: i32, y: i32) -> Result<(), String> {
        self.enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())
    }

    fn scroll(&mut self, dir: &str, amount: i32) -> Result<(), String> {
        // enigo scroll unit is "lines"; the wire `amount` is px-ish, so scale down.
        let lines = (amount / 40).max(1);
        let signed = if dir == "up" { -lines } else { lines };
        self.enigo.scroll(signed, Axis::Vertical).map_err(|e| e.to_string())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        // A trailing \n submits (Enter), matching the browser type semantics.
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

    /// 只认没有字符的那几个键。**不认识的键名一律报错**：静默吞掉会让上层把"弹窗没关掉"
    /// 当成关掉了，而它下一步的每个判断都建立在那个假前提上。
    fn press(&mut self, key: &str) -> Result<(), String> {
        let k = match key {
            "Escape" => Key::Escape,
            "Enter" => Key::Return,
            "Tab" => Key::Tab,
            other => return Err(format!("press: 不认识的键 {other}（今天只有 Escape / Enter / Tab）")),
        };
        self.enigo.key(k, Click).map_err(|e| e.to_string())
    }

    /// 见 trait 头注。Ctrl 按住 → `a` 点一下 → Ctrl 松开 → Backspace。**Ctrl 必须在
    /// 出错路径上也松开**：`?` 一路抛出去会把 Ctrl 留在按下状态，用户接下来敲什么都带着 Ctrl。
    ///
    /// `a` 必须走**虚拟键**（`Key::Other(0x41)` = `VK_A`），不能走 `Key::Unicode('a')`：后者是
    /// `KEYEVENTF_UNICODE`，只产生 `WM_CHAR`、不带 VK 码，应用的加速键表（Ctrl+A = 全选）根本
    /// 收不到——活体 2026-09-12 第一版就是这么写的，Ctrl 按着、字符 a 投进去、什么都没选中，
    /// 草稿原样留着和新正文一起发了出去。
    fn clear_input(&mut self) -> Result<(), String> {
        self.enigo.key(Key::Control, Press).map_err(|e| e.to_string())?;
        let picked = self.enigo.key(Key::Other(0x41), Click).map_err(|e| e.to_string());
        let released = self.enigo.key(Key::Control, Release).map_err(|e| e.to_string());
        picked?;
        released?;
        self.enigo.key(Key::Backspace, Click).map_err(|e| e.to_string())
    }

    fn read_subtree(&mut self, spec: &ReadSpec) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
        let root = self.scope_root().map_err(|e| e.to_string())?;
        // find the items (all descendants matching itemQuery), scoped to the target app window.
        // **走 `find_all` 那一份匹配逻辑，别在这里另拼一个 matcher**：这里原本只认 role/className，
        // 于是 itemQuery 里的 name/nameContains 被**静默忽略**——`find` 认得的查询，`readSubtree`
        // 认不得，而两边都不报错。活体撞到的样子是：itemQuery 写了 `nameContains:{q}` 想只读搜索
        // 命中那几条，回来的却是列表里的全部，一眼看去像"搜索没生效"。两份实现漂移了没有任何
        // 东西会喊，所以只留一份。
        // 内层 Err = matcher 等到超时也没匹配上，这在这里是**空结果**、不是故障（与 `find` 同口径）。
        // 当成错误上抛的话，"这次没搜到" 会伪装成 `find element time out` 这种像是坏了的报错，
        // 而 runner 本来会把空结果说成 `no items read` 的 drift——后者才指得对方向。
        let items = self.find_all(&root, &spec.item_query)?.unwrap_or_default();

        let mut rows = Vec::new();
        for item in items {
            let mut row = serde_json::Map::new();
            for (field, fs) in &spec.fields {
                // read from the item itself (from-query support is a follow-up)
                let value = match fs.read.as_str() {
                    "name" => item.get_name().unwrap_or_default(),
                    "value" => item.get_name().unwrap_or_default(), // ValuePattern read: follow-up
                    _ => String::new(),
                };
                row.insert(field.clone(), serde_json::Value::String(value));
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// 见 trait 头注。消息序列是本机（微信 4.x、锁屏、200%）量出来的**最小集**：不需要
    /// `WM_MOUSEACTIVATE` / `WM_ACTIVATE` / `WM_SETFOCUS`，纯 `PostMessage` 就够；**收件人必须是顶层
    /// 主窗口**——投给它里面那个自绘子窗口（`MMUIRenderSubWindowHW`）一个字都进不去，这是同一天
    /// 第一次失败的全部原因。所以这里投的是 scope 到的那个顶层 hwnd，不往子窗口找。
    fn post_input(&mut self, hwnd: &str, input: &protocol::PostedInput) -> Result<(), String> {
        use protocol::PostedInput as In;
        let hwnd: win32::Hwnd = hwnd.parse().map_err(|_| format!("bad window id: {hwnd}"))?;
        let post = |msg: u32, w: usize, l: isize| -> Result<(), String> {
            match unsafe { win32::PostMessageW(hwnd, msg, w, l) } {
                0 => Err(format!("post-failed: PostMessage({msg:#06x}) 投给窗口 {hwnd} 失败（窗口关了？）")),
                _ => Ok(()),
            }
        };
        let pause = |ms: u64| std::thread::sleep(std::time::Duration::from_millis(ms));
        let key = |vk: usize| -> Result<(), String> {
            post(win32::WM_KEYDOWN, vk, win32::KEYDOWN_LPARAM)?;
            pause(30);
            post(win32::WM_KEYUP, vk, win32::KEYUP_LPARAM)
        };
        match input {
            In::Clear => {
                // 见 `PostedInput::Clear`：修饰键状态投不进去，靠 `WM_CHAR 0x01`（Ctrl+A 的控制字符）
                // 表达全选；键序列照真实敲击的顺序投，让只看 KEYDOWN 的控件也有机会认出来。
                post(win32::WM_KEYDOWN, win32::VK_CONTROL as usize, win32::KEYDOWN_LPARAM)?;
                pause(30);
                post(win32::WM_KEYDOWN, win32::VK_A as usize, win32::KEYDOWN_LPARAM)?;
                post(win32::WM_CHAR, 0x01, win32::KEYDOWN_LPARAM)?;
                pause(30);
                post(win32::WM_KEYUP, win32::VK_A as usize, win32::KEYUP_LPARAM)?;
                post(win32::WM_KEYUP, win32::VK_CONTROL as usize, win32::KEYUP_LPARAM)?;
                pause(60);
                key(win32::VK_BACK)
            }
            In::Click { rect, button } => {
                let mut pt = win32::Point { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
                if unsafe { win32::ScreenToClient(hwnd, &mut pt) } == 0 {
                    return Err(format!("post-failed: 窗口 {hwnd} 的 ScreenToClient 失败（窗口关了？）"));
                }
                let lp = win32::xy_lparam(pt.x, pt.y);
                let (down, up, mk) = match button.as_str() {
                    "right" => (win32::WM_RBUTTONDOWN, win32::WM_RBUTTONUP, win32::MK_RBUTTON),
                    "middle" => (win32::WM_MBUTTONDOWN, win32::WM_MBUTTONUP, win32::MK_MBUTTON),
                    _ => (win32::WM_LBUTTONDOWN, win32::WM_LBUTTONUP, win32::MK_LBUTTON),
                };
                // **先悬停、再按下**：微信搜索候选弹层里的行，`WM_MOUSEMOVE` 之后 80ms 就按下会被
                // 当成"点在外面"——弹层关掉、什么都没选（本机 2026-09-07 两次）；停 400ms 再按、
                // 按住 120ms 再抬，同一行一次就中。主窗口对快慢都不挑，所以统一按慢的来。
                post(win32::WM_MOUSEMOVE, 0, lp)?;
                pause(350);
                post(down, mk, lp)?;
                pause(120);
                post(up, 0, lp)
            }
            In::Text(text) => {
                for unit in text.encode_utf16() {
                    if unit == u16::from(b'\n') {
                        key(win32::VK_RETURN)?;
                    } else {
                        post(win32::WM_CHAR, unit as usize, win32::KEYDOWN_LPARAM)?;
                    }
                    pause(20);
                }
                Ok(())
            }
            In::Key(name) => key(match name.as_str() {
                "Escape" => win32::VK_ESCAPE,
                "Enter" => win32::VK_RETURN,
                // Tab 挪焦点：空输入框在识别层没有靶子可指时唯一的办法（QQ 活体 2026-09-08）。
                "Tab" => win32::VK_TAB,
                other => return Err(format!("unknown key: {other}（只认 Escape / Enter / Tab）")),
            }),
            In::Scroll { dir, amount } => {
                // `WM_MOUSEWHEEL` 的 lParam 要**屏幕**坐标：投到窗口中心。
                let mut r = win32::WinRect::default();
                if unsafe { win32::GetWindowRect(hwnd, &mut r) } == 0 {
                    return Err(format!("post-failed: 窗口 {hwnd} 的 GetWindowRect 失败（窗口关了？）"));
                }
                let lp = win32::xy_lparam((r.left + r.right) / 2, (r.top + r.bottom) / 2);
                let notches = (amount / 120).max(1);
                let delta: i32 = if dir == "up" { 120 * notches } else { -120 * notches };
                let wparam = ((delta as i16 as u16 as usize) << 16) as usize;
                post(win32::WM_MOUSEWHEEL, wparam, lp)
            }
        }
    }

    fn screenshot(&mut self) -> Result<Option<Screenshot>, String> {
        use base64::Engine as _;
        // ① 首选：**按窗口句柄截目标窗口本身**（PrintWindow + PW_RENDERFULLCONTENT）。
        //    窗口被遮住、在后台、锁屏都照截——它命令窗口把内容画进我们的位图，不经过屏幕。
        //    这也让截图第一次成为"目标窗口此刻长什么样"的证据，而不是"屏幕上盖着什么"。
        if let Some(hwnd) = self.app_root.as_ref().map(win32::hwnd_of).filter(|h| *h != 0) {
            if let Some((img, rect)) = capture_window(hwnd) {
                let mut buf = std::io::Cursor::new(Vec::new());
                img.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
                // 图和它的物理原点必须同一次回来：识别层量出的框是相对图片的，加回这个原点
                // 才成为可点的屏幕坐标。rect 就是 `capture_window` 开位图用的那一份，所以
                // 「走了 PrintWindow 却没有 window」在这条路上构造上不可能发生。
                return Ok(Some(Screenshot {
                    base64: base64::engine::general_purpose::STANDARD.encode(buf.into_inner()),
                    window: Some(rect),
                    scale: dpi_scale(hwnd),
                }));
            }
            // PrintWindow 失败（极少数不配合的窗口）→ 落回抓屏，别空手而归
        }
        // ② 回落：**截目标窗口所在的那块屏**,不是"枚举顺序里的第一块"。
        //
        // 老代码是 `Monitor::all()?.into_iter().next()`,变量还叫 `primary`——那个名字是错的
        // 自我暗示:枚举顺序既不保证是主显示器,更不保证是目标所在那块。双屏实测(2026-07-26)
        // 它拍到的是另一块屏:于是 `GetForegroundWindow()` 和 UIA 都说 Chrome 在前台,截图里
        // 却是终端,三方证据互相矛盾,把「前台没切过去」这个误判坐实了三次。
        //
        // 取点顺序:正在驱动的那个窗口(app_root)→ 当前前台窗口 → 都没有就回落第一块屏。
        let target = self
            .app_root
            .as_ref()
            .map(win32::hwnd_of)
            .filter(|h| *h != 0)
            .unwrap_or_else(|| unsafe { win32::GetForegroundWindow() });
        let center = (target != 0)
            .then(|| {
                let mut r = win32::WinRect::default();
                (unsafe { win32::GetWindowRect(target, &mut r) } != 0)
                    .then(|| ((r.left + r.right) / 2, (r.top + r.bottom) / 2))
            })
            .flatten();
        let monitor = match center {
            Some((cx, cy)) => xcap::Monitor::from_point(cx, cy)
                .or_else(|_| {
                    xcap::Monitor::all()
                        .and_then(|ms| ms.into_iter().next().ok_or_else(|| {
                            xcap::XCapError::new("no monitor")
                        }))
                })
                .map_err(|e| e.to_string())?,
            None => {
                let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
                let Some(first) = monitors.into_iter().next() else { return Ok(None) };
                first
            }
        };
        let img = monitor.capture_image().map_err(|e| e.to_string())?;
        // xcap 给的是 RGBA8，而 JPEG 没有 alpha 通道——直接 write_to(Jpeg) 会在运行时报
        // 「The encoder or decoder for Jpeg does not support the color type `Rgba8`」，
        // 于是 screenshot 这个 op 恒失败（活体撞到，2026-07-25）。先丢掉 alpha 再编码。
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut buf = std::io::Cursor::new(Vec::new());
        rgb.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        // 这条路截的是**一整块屏**，不是"一个窗口"——`window` 只能是 None。谎报一个窗口 rect
        // 会让识别层把整屏坐标当成窗口内坐标去加原点，加出来的位置指向别处。
        Ok(Some(Screenshot {
            base64: base64::engine::general_purpose::STANDARD.encode(buf.into_inner()),
            window: None,
            scale: 1.0,
        }))
    }

    /// 在**目标窗口自己的画面**上找模板。走 `capture_window` 而不是抓屏：找图要的是"这个窗口
    /// 长什么样"，被别的窗口盖住时抓屏找到的可能是盖在上面那个东西的像素。
    ///
    /// 所以没有目标窗口就直接拒——回落抓屏会让返回的框指向另一套坐标系（相对屏幕而不是
    /// 相对窗口），而调用方拿它加窗口原点，加出来的位置指向别处，且两边单看都正常。
    ///
    /// **模板必须不透明**：转灰度时 alpha 被丢掉，透明区会按它底下的颜色（通常是黑）参与匹配，
    /// 分数无故下降——抠图时把背景连着抠进去，别留镂空。
    fn find_image(&mut self, template_png: &[u8], region: Option<&Rect>) -> Result<Option<(Rect, f64)>, String> {
        let hwnd = self.target_hwnd()?;
        let (img, _rect) = capture_window(hwnd)
            .ok_or_else(|| format!("no-capture: 窗口 {hwnd} 截不出来（PrintWindow 失败）"))?;
        // 同 `read_text`：先按 region 裁、再找，框出门前加回原点。
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

    /// 读目标窗口此刻画面上的字（文字表）。和 `find_image` 同一条取图路（`capture_window`），
    /// 所以框的坐标系也一致：**相对窗口左上角、物理像素**，要点它由调用方加回 `window` 的原点。
    ///
    /// 没有目标窗口就直接拒，理由同 `find_image`：回落抓屏会让框指向另一套坐标系，而调用方
    /// 照样加原点——加出来的位置指向别处，两边单看都正常。
    ///
    /// `region` 在**识别之前**就把图裁掉（`crop_to_region`），框出门前再加回 region 原点。
    /// 这是这条路能用的前提，不是优化：整窗约 0.8s（Windows）/ 0.9s（mac），数字在
    /// `docs/research/ocr-engine-benchmark.md` §2。
    fn read_text(&mut self, region: Option<&Rect>) -> Result<protocol::TextRead, String> {
        let hwnd = self.target_hwnd()?;
        let scale = dpi_scale(hwnd);
        let t0 = std::time::Instant::now();
        // `window` 用**开位图那一次**读到的 rect：图和原点必须同源，否则"图的宽高 == window.w/h"
        // 这条活体判据会在窗口挪动时莫名对不上（见 `capture_window` 头注）。
        let (img, window) = capture_window(hwnd)
            .ok_or_else(|| format!("no-capture: 窗口 {hwnd} 截不出来（PrintWindow 失败）"))?;
        let t_cap = t0.elapsed();
        let (crop, (ox, oy)) = crate::see::crop_to_region(&img, region)?;
        let t1 = std::time::Instant::now();
        let mut texts = self.ocr_texts(&crop, scale, region.is_some())?;
        // 分段耗时进 stderr（后端把它转成 `[stream-desktop] WARN host-agent stderr`）：一轮 recipe
        // 十几次读屏、每次 2–8s，不拆开就只能猜是截图慢还是识别慢。`ocr@det1x`/`ocr@phys` 标这次
        // 检测跑在哪个尺度上——A/B（`STREAM_OCR_PHYSICAL`）就靠它在日志里分得开。
        eprintln!(
            "[see-read] text crop={}x{} capture={}ms ocr={}ms lines={} scale={} {}",
            crop.width(), crop.height(), t_cap.as_millis(), t1.elapsed().as_millis(), texts.len(), scale,
            crate::see::ocr_mode_label(scale)
        );
        for t in &mut texts {
            t.rect.x += ox;
            t.rect.y += oy;
        }
        Ok(protocol::TextRead { texts, window, scale })
    }

    /// 读目标窗口此刻画面上的元素表（哪儿能点、点的是什么）。
    ///
    /// 三档来源缝在一起（`see::synthesize_elements`）：a11y（准，但自绘应用大片界面不在树里）、
    /// 检测器（知道有控件、不知道是什么，`icons` 才跑）、OCR 文字（知道写着什么）。
    /// 坐标系与 `read_text` 完全一致，`region` 也是同一套下推。
    ///
    /// **文字这一档是必跑的**，哪怕调用方只想要 a11y：没有它，元素表里绝大多数条目没有名字，
    /// 而上层是按名字匹配的——一张没名字的表和一张空表对调用方是一回事。
    ///
    /// `a11y == false` 是 recipe 作者申报的"这个应用没有控件树"（`app.a11y:false`），这一档
    /// 整个不跑（微信每步省 80–90ms）；日志 `a11y=0ms(off)`，与 `detector=0ms(off)` 同形——
    /// 退路要在日志里留痕。它和 `interactive_elements` 拒绝的黑名单不是一回事，见那里的头注。
    fn read_elements(
        &mut self,
        region: Option<&Rect>,
        icons: bool,
        a11y: bool,
    ) -> Result<protocol::ElementsRead, String> {
        let hwnd = self.target_hwnd()?;
        let scale = dpi_scale(hwnd);
        // **只截这一次**：三档都从同一张画面上认，截两次等于让几组框来自两个时刻的画面
        // （中间窗口滚一下，它们就互相对不上了）。
        let t0 = std::time::Instant::now();
        let (img, window) = capture_window(hwnd)
            .ok_or_else(|| format!("no-capture: 窗口 {hwnd} 截不出来（PrintWindow 失败）"))?;
        let t_cap = t0.elapsed();
        let (crop, (ox, oy)) = crate::see::crop_to_region(&img, region)?;
        let t1 = std::time::Instant::now();
        let texts = self.ocr_texts(&crop, scale, region.is_some())?;
        let t_ocr = t1.elapsed();
        let t2 = std::time::Instant::now();
        let detector = if icons { self.detector_rects(&crop) } else { Vec::new() };
        let t_det = t2.elapsed();
        let t3 = std::time::Instant::now();
        // a11y 的框来自 UIA（屏幕坐标 → 截图坐标由 `interactive_elements` 换），这里再挪进
        // 裁剪坐标系，并丢掉落在这一块之外的——三档必须同一套坐标才合得起来。
        let (cw, ch) = (crop.width() as i32, crop.height() as i32);
        let process = process_image(win32::pid_of(hwnd) as i32).unwrap_or_default();
        let a11y_els: Vec<protocol::Element> = if a11y {
            self.interactive_elements(&window, &process)
                .into_iter()
                .map(|mut e| {
                    e.rect.x -= ox;
                    e.rect.y -= oy;
                    e
                })
                .filter(|e| e.rect.x < cw && e.rect.y < ch && e.rect.x + e.rect.w > 0 && e.rect.y + e.rect.h > 0)
                .collect()
        } else {
            Vec::new()
        };
        // 同 `read_text` 那行：一次读屏拆成截图 / OCR / 检测器 / 控件树四段报出来。
        eprintln!(
            "[see-read] elements crop={}x{} capture={}ms ocr={}ms detector={}ms({}) a11y={}ms{} lines={} scale={} {}",
            crop.width(), crop.height(), t_cap.as_millis(), t_ocr.as_millis(), t_det.as_millis(),
            if icons { "on" } else { "off" },
            if a11y { t3.elapsed().as_millis() } else { 0 }, if a11y { "" } else { "(off)" },
            texts.len(), scale, crate::see::ocr_mode_label(scale)
        );
        let mut elements = crate::see::synthesize_elements(a11y_els, detector, &texts);
        for e in &mut elements {
            e.rect.x += ox;
            e.rect.y += oy;
        }
        Ok(protocol::ElementsRead { elements, window, scale })
    }

    fn url(&mut self) -> Result<String, String> {
        let focused = self.auto.get_focused_element().map_err(|e| e.to_string())?;
        let cls = focused.get_classname().unwrap_or_default();
        let pid = focused.get_process_id().unwrap_or(0);
        Ok(format!("{}#{}", process_image(pid).unwrap_or_default(), cls))
    }

    fn sleep(&mut self, ms: u64) -> Result<(), String> {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        Ok(())
    }
}

/// `PrintWindow` 一个窗口 → RGB 图 **+ 这张图对应的屏幕物理 rect**。失败（尺寸为零、GDI 任一步
/// 拿不到、窗口拒绝自绘）返回 None，让调用方落回抓屏——**宁可给一张"盖着别的东西"的屏，
/// 也别报一张全黑说是窗口**。
///
/// rect 和图**同一次 `GetWindowRect` 读出来**，不让调用方再读一次：活体判据是
/// 「图的宽高 == `window.w/h`」，两次读之间窗口挪一下或改个大小，这个判据就永远对不上，
/// 而两边单看都正常。同源之后它成了构造上的恒真。
fn capture_window(hwnd: win32::Hwnd) -> Option<(image::RgbImage, Rect)> {
    unsafe {
        let mut r = win32::WinRect::default();
        if win32::GetWindowRect(hwnd, &mut r) == 0 {
            return None;
        }
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 {
            return None;
        }
        let wdc = win32::GetWindowDC(hwnd);
        if wdc == 0 {
            return None;
        }
        let mdc = win32::CreateCompatibleDC(wdc);
        let bmp = win32::CreateCompatibleBitmap(wdc, w, h);
        let done = (|| -> Option<Vec<u8>> {
            if mdc == 0 || bmp == 0 {
                return None;
            }
            win32::SelectObject(mdc, bmp);
            if win32::PrintWindow(hwnd, mdc, win32::PW_RENDERFULLCONTENT) == 0 {
                return None;
            }
            let mut info = win32::BitmapInfoHeader {
                size: std::mem::size_of::<win32::BitmapInfoHeader>() as u32,
                width: w,
                height: -h, // 负高 = top-down，行序和图像坐标一致
                planes: 1,
                bit_count: 32,
                compression: win32::BI_RGB,
                size_image: 0,
                x_ppm: 0,
                y_ppm: 0,
                clr_used: 0,
                clr_important: 0,
            };
            let mut bits = vec![0u8; (w as usize) * (h as usize) * 4];
            (win32::GetDIBits(mdc, bmp, 0, h as u32, bits.as_mut_ptr(), &mut info, win32::DIB_RGB_COLORS) == h)
                .then_some(bits)
        })();
        // GDI 句柄不清就是泄漏——成败都收
        if bmp != 0 {
            win32::DeleteObject(bmp);
        }
        if mdc != 0 {
            win32::DeleteDC(mdc);
        }
        win32::ReleaseDC(hwnd, wdc);

        let bgra = done?;
        let mut rgb = image::RgbImage::new(w as u32, h as u32);
        for (i, px) in rgb.pixels_mut().enumerate() {
            let o = i * 4;
            *px = image::Rgb([bgra[o + 2], bgra[o + 1], bgra[o]]); // BGRA → RGB
        }
        Some((rgb, Rect { x: r.left, y: r.top, w, h }))
    }
}

/// 这个窗口的缩放比（DPI/96）。查不出来（回 0）就报 1.0——它只是诊断字段，不参与坐标换算。
fn dpi_scale(hwnd: win32::Hwnd) -> f64 {
    match unsafe { win32::GetDpiForWindow(hwnd) } {
        0 => 1.0,
        dpi => dpi as f64 / 96.0,
    }
}

/// Process image name for a pid (the "process" side of the foreground id).
/// 只问这一个 pid——`readElements` 每次都走这里，整机快照会给每次读屏白加 200ms（`procs.rs`）。
fn process_image(pid: i32) -> Option<String> {
    crate::procs::name_of(pid as u32)
}

/// `stream-desktop focus-probe <进程> [标题子串] [采样次数] [间隔ms]` ——
/// **键盘焦点此刻落在哪**，只读、不抢前台、不动 Z 序。
///
/// 它存在的理由：`deliver:'message'` 那条路把按键 `PostMessage` 给顶层窗口，而按键有没有
/// 收件人取决于**两层焦点**，两层都读不出来就只能赌：
///
/// - **Win32 层**（`GUITHREADINFO.hwnd_focus`）：键盘焦点是每个输入队列一份的。目标窗口的
///   线程不在活动输入队列里时 `hwnd_focus == 0`，投进去的 `WM_CHAR` 没有收件人。
/// - **应用内层**（UIA `GetFocusedElement`）：Electron/Chromium 的顶层窗口只有一个 HWND，
///   框里的焦点归 Blink 管——同一个 `hwnd_focus` 底下，焦点可能在搜索框、在会话列表、
///   也可能哪儿都不在。这一层只有 UIA 能报。
///
/// 一行一次采样，跟着 `[desktop-op]` 的时间戳对账就能回答"哪一步之后焦点丢的"。
pub fn focus_probe(process: &str, title: Option<&str>, samples: u32, interval_ms: u64) {
    use protocol::Desktop;
    let mut d = WindowsDesktop::default();
    let wins = d.windows().unwrap_or_default();
    let Some(w) = wins
        .iter()
        .filter(|w| w.process.eq_ignore_ascii_case(process))
        .find(|w| title.map_or(true, |t| w.title.contains(t)))
    else {
        eprintln!(
            "no-window-match: 没有 {process}{} 的窗口；现有：{:?}",
            title.map(|t| format!("/{t}")).unwrap_or_default(),
            wins.iter().map(|w| format!("{}/{}", w.process, w.title)).collect::<Vec<_>>()
        );
        std::process::exit(2);
    };
    let hwnd: win32::Hwnd = w.id.parse().unwrap_or(0);
    let tid = win32::tid_of(hwnd);
    let win_id = w.id.clone();
    // `STREAM_FOCUS_PROBE_FOREGROUND=1` → 先把它抬到前台再读。**默认不抬**：读一眼不该把用户的
    // 窗口拽到前面来。留这个开关只为回答一个问题——"这个应用的控件树是不是只在它活动时才建"，
    // 而那一问除了真把它抬上来没有别的问法。
    if std::env::var("STREAM_FOCUS_PROBE_FOREGROUND").is_ok() {
        let before = d.windows().unwrap_or_default().into_iter().find(|w| w.foreground).map(|w| format!("{} 「{}」", w.process, w.title));
        println!("抬到前台：{:?}（原前台 {}）", d.focus_window(&win_id), before.unwrap_or_else(|| "<none>".into()));
        std::thread::sleep(std::time::Duration::from_millis(900));
    }
    // 把范围限到这个窗口——下面那一问（"**这个窗口的树里**谁持有焦点"）要从它的根往下找。
    if let Err(e) = d.scope_window(&win_id) {
        println!("scopeWindow 失败：{e}（窗口内那一问会缺席）");
    }
    // 控件树里到底有什么——`interactive_elements` 只报条数，这里把 `Edit` 单拎出来问，
    // 因为"有没有一个可指的输入框"决定这条链路能不能不赌焦点。
    for role in ["Edit", "Document", "Text"] {
        let q = A11yQuery { role: Some(role.to_string()), ..Default::default() };
        match d.app_root.as_ref().map(|r| d.find_all(r, &q)) {
            Some(Ok(Ok(els))) => println!(
                "role={role}: {} 个{}",
                els.len(),
                els.iter()
                    .take(6)
                    .map(|e| {
                        // **框必须一起报**：一个无名的 `Edit` 光看名字说明不了它是搜索框还是消息
                        // 输入框，而这两者决定这条链路能不能不赌焦点。位置是唯一分得开它俩的东西。
                        let r = e.get_cached_bounding_rectangle().unwrap_or_default();
                        format!(
                            " 「{}」@({},{} {}x{})",
                            e.get_cached_name().unwrap_or_default().chars().take(20).collect::<String>(),
                            r.get_left(),
                            r.get_top(),
                            r.get_right() - r.get_left(),
                            r.get_bottom() - r.get_top()
                        )
                    })
                    .collect::<String>()
            ),
            Some(Ok(Err(_))) => println!("role={role}: 0 个"),
            Some(Err(e)) => println!("role={role}: 查询建不起来 {e}"),
            None => println!("role={role}: <没 scope 到窗口>"),
        }
    }
    println!("target: {} 「{}」 hwnd={hwnd} tid={tid}", w.process, w.title);
    // **窗口此刻摆在哪、可不可见、是不是最小化**——这三样决定 Chromium 会不会把自己判成
    // occluded；判成了就把渲染端挂起，投进来的鼠标消息一律不再路由到页面里，而 `PostMessage`
    // 照样返回成功。这一档失败**完全静默**，不打出来就只能猜。
    {
        let mut r = win32::WinRect::default();
        let ok = unsafe { win32::GetWindowRect(hwnd, &mut r) } != 0;
        let vx = unsafe { win32::GetSystemMetrics(76) };
        let vy = unsafe { win32::GetSystemMetrics(77) };
        let vw = unsafe { win32::GetSystemMetrics(78) };
        let vh = unsafe { win32::GetSystemMetrics(79) };
        println!(
            "窗口 rect={} visible={} iconic={} | 虚拟桌面 x={vx} y={vy} w={vw} h={vh}",
            if ok { format!("({},{})-({},{})", r.left, r.top, r.right, r.bottom) } else { "<读不到>".into() },
            unsafe { win32::IsWindowVisible(hwnd) },
            unsafe { win32::IsIconic(hwnd) },
        );
    }
    // 锁屏是**什么时候**开始的：`LockApp.exe` 的启动时刻就是锁屏那一刻。有了它，"某一轮
    // 是不是跑在锁屏里"变成一条可对账的事实，而不用回忆当时人在不在机器前。
    {
        let sys = sysinfo::System::new_all();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        for p in sys.processes().values().filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case("LockApp.exe")) {
            let t = p.start_time();
            println!("LockApp.exe pid={} 启动于 unix {t}（{} 秒前 = 锁屏时刻）", p.pid(), now.saturating_sub(t));
        }
        println!("现在 unix {now}");
    }
    println!("列：t=经过毫秒 fg=前台窗口 tgt{{active,focus,capture}}=目标线程的输入队列 uia=应用内焦点元素");
    let t0 = std::time::Instant::now();
    for i in 0..samples.max(1) {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }
        let fg = unsafe { win32::GetForegroundWindow() };
        let fg_desc = if fg == hwnd {
            "<target>".to_string()
        } else {
            format!("{}#{fg}", process_image(win32::pid_of(fg) as i32).unwrap_or_else(|| "?".into()))
        };
        // 目标线程自己的输入队列。**不是前台线程的**：这里要回答的正是"目标在不在活动队列里"。
        let g = win32::gui_thread_info(tid);
        let show = |h: win32::Hwnd| if h == 0 { "0".to_string() } else if h == hwnd { "<target>".to_string() } else { h.to_string() };
        let tgt = match &g {
            Some(g) => format!("active={} focus={} capture={}", show(g.hwnd_active), show(g.hwnd_focus), show(g.hwnd_capture)),
            None => "<GetGUIThreadInfo 失败>".to_string(),
        };
        // 应用内层。**报的是元素而不是句柄**：Electron 一个 HWND 底下有整棵 DOM，句柄分不开。
        let uia = match d.auto.get_focused_element() {
            Ok(el) => {
                let pid = el.get_process_id().unwrap_or(0);
                let name: String = el.get_name().unwrap_or_default().replace('\n', " ").chars().take(30).collect();
                format!(
                    "{}#{} role={} name=「{name}」{}",
                    process_image(pid).unwrap_or_else(|| "?".into()),
                    el.get_classname().unwrap_or_default(),
                    el.get_control_type().map(control_to_role).unwrap_or_default(),
                    if pid as u32 == win32::pid_of(hwnd) { "" } else { " ← 不是目标进程" }
                )
            }
            Err(e) => format!("<err {e}>"),
        };
        // **应用内层的第二问，也是真正想问的那一问**：在**这个窗口自己的树里**，谁持有键盘焦点。
        // `get_focused_element` 报的是**全局**焦点——目标在后台时它指着前台那个应用，答不了
        // "QQ 里面焦点落在哪个控件上"。这里走 provider 侧的属性条件（`HasKeyboardFocus`），
        // 一次往返、属性一起带回。
        //
        // **读回空不等于工具坏了**，也**不要读成"因为它不在前台/锁着屏"**——那个因果是错的：
        // 同一时刻、同样不在前台、同样是 Chromium，`chrome.exe` 读出 238 个控件（连页面内容
        // 节点都在），`QQ.exe` 只有 8 个满窗大小、无名的 Pane，也就是**窗口骨架，渲染层的树
        // 压根没建**（本机 2026-09-07 锁屏实测）。所以这里读回空是**这个应用自己不暴露树**，
        // 那本身就是结论——也正是这条链路上"焦点在哪"无处可读、只能赌的原因。
        let in_app = match d.app_root.as_ref() {
            None => "<没 scope 到窗口>".to_string(),
            Some(root) => {
                let q = || -> Result<Vec<UIElement>, String> {
                    let cond = d
                        .auto
                        .create_property_condition(UIProperty::HasKeyboardFocus, Variant::from(true), None)
                        .map_err(|e| e.to_string())?;
                    let cache = d.cache_request()?;
                    root.find_all_build_cache(TreeScope::Descendants, &cond, &cache).map_err(|e| e.to_string())
                };
                match q() {
                    Err(e) => format!("<err {e}>"),
                    Ok(els) if els.is_empty() => "<树里没有任何控件持有焦点>".to_string(),
                    Ok(els) => els
                        .iter()
                        .map(|e| {
                            format!(
                                "{}「{}」",
                                e.get_cached_control_type().map(control_to_role).unwrap_or_default(),
                                e.get_cached_name().unwrap_or_default().chars().take(24).collect::<String>()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" + "),
                }
            }
        };
        println!("t={:>6}ms fg={fg_desc} tgt{{{tgt}}} uia={uia}\n         窗口内焦点={in_app}", t0.elapsed().as_millis());
    }
}

/// `stream-desktop focus-spike <变体> [轮数]` —— **「投一下点击」到底给不给键盘焦点**，
/// 一轮一行、只打进 QQ 的搜索框、跑完自己按 Escape 复位，不发任何消息。
///
/// 为什么要有它：同一件事经 recipe 跑一轮要 15 秒（每一步都在 OCR），而这里要量的是一个
/// 二值结果的**分布**——十轮才有意义。这条路绕开后端与中继，一轮 4 秒。
///
/// 判据是**看得见的效果**，不是"我发出去了"：打完字之后搜索框里 placeholder「搜索」还在
/// = 字没进去（焦点没拿到）；变成了打进去的那几个字 = 拿到了。焦点本身在 Electron 上读不出来
/// （UIA 对 QQ 一个可交互控件都不给），所以只能这么量。
#[cfg(windows)]
pub fn focus_spike(variant: &str, repeats: u32, process: &str) {
    use protocol::{Desktop, PostedInput, Rect};
    const QUERY: &str = "我的手机";
    let mut d = WindowsDesktop::default();
    let Some(w) = d.windows().unwrap_or_default().into_iter().find(|w| w.process.eq_ignore_ascii_case(process)) else {
        eprintln!("{process} 没开");
        std::process::exit(2);
    };
    let hwnd_str = w.id.clone();
    let hwnd: win32::Hwnd = hwnd_str.parse().unwrap_or(0);
    let _ = d.scope_window(&hwnd_str);
    println!("variant={variant} hwnd={hwnd} 窗口=「{}」", w.title);
    let mut landed = 0u32;
    let mut skipped = 0u32;
    for i in 1..=repeats {
        // **叫醒必须发生在读屏和复位之前。** 睡着时投出去的 Escape 也是不落地的，于是"上一轮
        // 残留的字还在搜索框里"这件事在睡着态下**自己解不开**——四轮全 skip，一次都没量到。
        // （这本身就是那条教训的又一次：一个"没复位干净"的读数，其实是"这一轮什么都投不进去"。）
        if variant == "wake" || variant == "wake0" {
            let tree = |d: &mut WindowsDesktop| -> usize {
                let q = A11yQuery { role: Some("Document".into()), ..Default::default() };
                d.app_root.as_ref().and_then(|r| d.find_all(r, &q).ok()).and_then(|r| r.ok()).map_or(0, |v| v.len())
            };
            let asleep = tree(&mut d);
            if variant == "wake0" {
                println!("   叫醒前 Document={asleep}；发一次零位移真实输入：{}", win32::nudge_input());
            } else {
                // 有位移的那一版：先拿窗口 rect 才能算中心，这里单独读一次。
                let w = d.read_text(None).ok().map(|t| t.window).unwrap_or(Rect { x: 0, y: 0, w: 0, h: 0 });
                println!("   叫醒前 Document={asleep}；真实鼠标移到窗口中心：{:?}", d.move_mouse(w.x + w.w / 2, w.y + w.h / 2));
            }
            let t = std::time::Instant::now();
            let mut woke = 0;
            while t.elapsed().as_millis() < 6000 {
                woke = tree(&mut d);
                if woke > 0 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            println!("   叫醒后 Document={woke}（等了 {}ms）", t.elapsed().as_millis());
        }
        // 顶上那一条（12% 高）里的文字表——placeholder 与打进去的字都在这儿。
        let top = |d: &mut WindowsDesktop| -> Option<protocol::TextRead> {
            let r = Rect { x: 0, y: 0, w: 0, h: 0 };
            let _ = r;
            d.read_text(None).ok()
        };
        let Some(before) = top(&mut d) else {
            println!("#{i} <readText 失败>");
            continue;
        };
        let band = (before.window.h as f64 * 0.12) as i32;
        // 只有"往搜索框里打字"那几个变体需要 placeholder 当起点；rowclick / poke 各有各的靶子。
        // `wake` / `wake0` 叫醒之后也要点搜索框、也拿 placeholder 当判据，所以同样需要它。
        // **少列这两个的后果是静默的**：`ph` 会退化成一个全 0 的框，于是"点搜索框"变成点窗口
        // 左上角，而那一轮照样会打印一个看着正常的结论。
        let needs_placeholder = matches!(variant, "plain" | "activate" | "dbl" | "wake" | "wake0" | "open" | "keys" | "keysr" | "keysb" | "clearbox");
        let ph = before
            .texts
            .iter()
            // **包含匹配，不是全等。** 同一个 placeholder，锁屏时 OCR 切成「Q」+「搜索」两段，
            // 解锁后（渲染变清楚）合成一段「Q.搜索」——全等匹配当场全军覆没（本机 2026-09-08：
            // 解锁后头八轮全是 skip，判据挂在分段方式上而不是挂在"框里写着什么"上）。
            .find(|t| t.text.contains("搜索") && t.rect.y < band)
            .cloned()
            .unwrap_or(protocol::ScreenText { text: String::new(), rect: Rect { x: 0, y: 0, w: 0, h: 0 } });
        let ph = (!needs_placeholder || !ph.text.is_empty()).then_some(ph);
        let Some(ph) = ph else {
            println!("#{i} skip：搜索框里不是 placeholder（上一轮没复位干净），先 Escape");
            let _ = d.post_input(&hwnd_str, &PostedInput::Key("Escape".into()));
            std::thread::sleep(std::time::Duration::from_millis(1200));
            skipped += 1;
            continue;
        };
        // 文字表的 rect 相对窗口左上角；`PostedInput::Click` 要屏幕物理坐标。
        let target = Rect { x: ph.rect.x + before.window.x, y: ph.rect.y + before.window.y, w: ph.rect.w, h: ph.rect.h };
        // **把这一下到底会落在窗口里的哪个点打出来**：窗口 rect 含不可见的调整边框时，
        // 「窗口相对坐标」和 client 坐标差着那一圈，而差出来的点看着一样合理。
        if needs_placeholder {
            let mut pt = win32::Point { x: target.x + target.w / 2, y: target.y + target.h / 2 };
            unsafe { win32::ScreenToClient(hwnd, &mut pt) };
            println!(
                "   点：窗口内({},{}) → 屏幕({},{}) → client({},{})",
                ph.rect.x + ph.rect.w / 2, ph.rect.y + ph.rect.h / 2, target.x + target.w / 2, target.y + target.h / 2, pt.x, pt.y
            );
        }
        let click = |d: &mut WindowsDesktop| {
            let _ = d.post_input(&hwnd_str, &PostedInput::Click { rect: target.clone(), button: "left".into() });
        };
        let post = |msg: u32, wp: usize, lp: isize| unsafe { win32::PostMessageW(hwnd, msg, wp, lp) };
        match variant {
            // 现状：只投 MOUSEMOVE / DOWN / UP。
            "plain" => click(&mut d),
            // 补上真实点击会带来的那一组激活/焦点消息，再点。
            "activate" => {
                post(win32::WM_NCACTIVATE, 1, 0);
                post(win32::WM_ACTIVATEAPP, 1, 0);
                post(win32::WM_ACTIVATE, win32::WA_CLICKACTIVE, 0);
                post(win32::WM_SETFOCUS, 0, 0);
                std::thread::sleep(std::time::Duration::from_millis(200));
                click(&mut d);
            }
            // 点两下：第一下若只用来"激活窗口"（很多壳会吃掉它），第二下才真正落到控件上。
            "dbl" => {
                click(&mut d);
                std::thread::sleep(std::time::Duration::from_millis(250));
                click(&mut d);
            }
            // **「点击到底落没落地」的独立判据**：搜索框拿没拿到焦点在画面上看不出来，
            // 所以拿一个**看得出来的**点击去问同一个问题——点左栏第二条会话，右侧标题该换人。
            // 换了 = 投出去的点击是有效的，问题只在焦点；没换 = 点击本身就没到。
            "rowclick" => {
                let title_of = |t: &protocol::TextRead| -> String {
                    t.texts.iter().find(|x| x.rect.y < band && x.rect.x > 300 && x.rect.x < 700).map(|x| x.text.clone()).unwrap_or_default()
                };
                let t0 = title_of(&before);
                // 左栏的会话名：x 在 110..280、y 在窗口 20%–80% 的那些段，取第三条（躲开当前会话）。
                let rows: Vec<_> = before
                    .texts
                    .iter()
                    .filter(|x| x.rect.x > 110 && x.rect.x < 280 && x.rect.y > before.window.h / 5 && x.rect.y < before.window.h * 4 / 5)
                    .collect();
                let Some(row) = rows.get(2) else {
                    println!("#{i} skip：左栏找不到可点的会话行");
                    skipped += 1;
                    continue;
                };
                println!("   点会话行「{}」；点前右侧标题「{t0}」", row.text);
                let r = Rect { x: row.rect.x + before.window.x, y: row.rect.y + before.window.y, w: row.rect.w, h: row.rect.h };
                let _ = d.post_input(&hwnd_str, &PostedInput::Click { rect: r, button: "left".into() });
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let t1 = d.read_text(None).ok().map(|t| title_of(&t)).unwrap_or_default();
                println!("#{i} 点后右侧标题「{t1}」→ {}", if t1 != t0 && !t1.is_empty() { "点击落地了 ✅" } else { "标题没变 ❌" });
                if t1 != t0 && !t1.is_empty() {
                    landed += 1;
                }
                continue;
            }
            // **对照组**：拿一个 label 当靶子点一下，报画面文字集合的差集。用来问"这台机器
            // 此刻投出去的点击到底能不能落地"——换个**原生**应用（任务管理器）来问，就能把
            // "锁屏下投递整体失效" 和 "Chromium 这一类被 occlusion 挂起了" 分开。
            "poke" => {
                let label = std::env::args().nth(5).unwrap_or_default();
                let Some(t) = before.texts.iter().find(|x| x.text == label) else {
                    println!("#{i} skip：画面上没有「{label}」这一段");
                    skipped += 1;
                    continue;
                };
                let r = Rect { x: t.rect.x + before.window.x, y: t.rect.y + before.window.y, w: t.rect.w, h: t.rect.h };
                println!("   点「{label}」窗口内({},{})", t.rect.x + t.rect.w / 2, t.rect.y + t.rect.h / 2);
                let _ = d.post_input(&hwnd_str, &PostedInput::Click { rect: r, button: "left".into() });
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let after = d.read_text(None).ok();
                let old: std::collections::HashSet<String> = before.texts.iter().map(|x| x.text.clone()).collect();
                let new: std::collections::HashSet<String> = after.map(|t| t.texts.iter().map(|x| x.text.clone()).collect()).unwrap_or_default();
                let added: Vec<_> = new.difference(&old).take(8).cloned().collect();
                let gone: Vec<_> = old.difference(&new).take(8).cloned().collect();
                println!("#{i} 新出现 {} 段 {added:?} / 消失 {} 段 {gone:?}", new.difference(&old).count(), old.difference(&new).count());
                if !added.is_empty() {
                    landed += 1;
                }
                continue;
            }
            // **叫醒渲染端再点。** `PostMessage` 不是"用户输入"：它不重置系统的空闲计时器、
            // 不唤显示器，也不让 Chromium 把自己从 occluded 里放出来。`move_mouse` 走的是
            // enigo 合成的**真实**输入（`SendInput`），那一条会。这一格量的就是"醒了之后
            // 同一下点击落不落地"。
            // 叫醒已经在循环开头做过了（那时候才来得及救"睡着导致复位不掉"那一档），
            // 这两格剩下的就是同一下点击——两条变体的唯一差别只在叫醒原语。
            "wake" | "wake0" => click(&mut d),
            // **走识别层把搜索打开，然后停在那儿不复位**——好让调用方从容去读控件树，
            // 回答"搜索结果行到底进不进 a11y 树"。这一问必须让界面**保持**在搜索态，
            // 而其它变体跑完都会 Escape 复位，读到的就永远是复位后的树。
            "open" => {
                click(&mut d);
                std::thread::sleep(std::time::Duration::from_millis(800));
                let _ = d.post_input(&hwnd_str, &PostedInput::Text(QUERY.into()));
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let after = d.read_text(None).ok();
                let ph = after.as_ref().map_or(false, |t| t.texts.iter().any(|x| x.text.contains("搜索") && x.rect.y < band));
                println!("#{i} 搜索态：placeholder还在={ph}（false = 名字进去了、结果应该出来了）");
                println!("   **不复位**，界面停在这儿，去读控件树吧");
                landed += if ph { 0 } else { 1 };
                continue;
            }
            // **键盘能不能把焦点送进消息输入框**——纯识别路最后一格的唯一翻盘可能。
            // 全程只用识别层定位（点搜索框、点会话行都按 OCR 出来的框），**一个控件树查询都不用**，
            // 否则又是一次污染。控件树只用来**读**焦点（读不改变被测方案）。
            //
            // 判据两条，都在报告里打出来：
            //   ① 窗口内 `HasKeyboardFocus` 落在谁身上（`Edit` = 成了）；
            //   ② 打一个探针字符之后整窗 OCR 能不能读到它——**空输入框一旦有字就可见**，
            //      这把"焦点在哪"这个不可判定的前置条件换成了一个可判定的后置条件。
            "keys" | "keysr" | "keysb" => {
                let tabs: u32 = std::env::args().nth(5).and_then(|s| s.parse().ok()).unwrap_or(0);
                let focus_of = |d: &mut WindowsDesktop| -> String {
                    let Some(root) = d.app_root.as_ref() else { return "<没 scope>".into() };
                    let Ok(cond) = d.auto.create_property_condition(UIProperty::HasKeyboardFocus, Variant::from(true), None) else {
                        return "<条件建不起来>".into();
                    };
                    let Ok(cache) = d.cache_request() else { return "<cache 建不起来>".into() };
                    match root.find_all_build_cache(TreeScope::Descendants, &cond, &cache) {
                        Ok(els) if els.is_empty() => "<没有控件持有焦点>".into(),
                        Ok(els) => els
                            .iter()
                            .map(|e| {
                                format!(
                                    "{}「{}」",
                                    e.get_cached_control_type().map(control_to_role).unwrap_or_default(),
                                    e.get_cached_name().unwrap_or_default().chars().take(18).collect::<String>()
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(" + "),
                        Err(e) => format!("<err {e}>"),
                    }
                };
                // ① 识别层开搜索 + 打名字
                click(&mut d);
                std::thread::sleep(std::time::Duration::from_millis(800));
                let _ = d.post_input(&hwnd_str, &PostedInput::Text(QUERY.into()));
                std::thread::sleep(std::time::Duration::from_millis(2200));
                // ② 识别层点会话行：左栏里含联系人名、**y 最小**的那一段就是真行
                //    （兜底行「进入全网搜索…」恒在它下面，本机实测 94 vs 167）。
                let Some(t) = d.read_text(None).ok() else {
                    println!("#{i} readText 失败");
                    continue;
                };
                let mut rows: Vec<_> = t.texts.iter().filter(|x| x.text.contains(QUERY) && x.rect.x > 100 && x.rect.x < 300 && x.rect.y > band).collect();
                rows.sort_by_key(|x| x.rect.y);
                let Some(row) = rows.first() else {
                    println!("#{i} 左栏没找到会话行（搜索没打开？）");
                    continue;
                };
                println!("   点会话行「{}」@({},{})", row.text, row.rect.x, row.rect.y);
                let r = Rect { x: row.rect.x + t.window.x, y: row.rect.y + t.window.y, w: row.rect.w, h: row.rect.h };
                let _ = d.post_input(&hwnd_str, &PostedInput::Click { rect: r, button: "left".into() });
                std::thread::sleep(std::time::Duration::from_millis(1800));
                println!("   点完会话行，窗口内焦点 = {}", focus_of(&mut d));
                // ③ 走焦点环。`keys` = 投给窗口的 Tab；`keysr` = 真实 Tab（`SendInput`）。
                //
                // **真实输入必须先把窗口抬到前台**：`SendInput` 和坐标点击一样**没有收件人**——
                // 它发给"此刻系统焦点在的那个窗口"。不抬前台就发，键会打进当时在前台的东西
                // （我第一次跑这条实验时它们多半进了我自己的终端），而读数看起来只是"焦点没动"。
                let real = variant == "keysr";
                // `keysb` = 从另一头走（Shift+Tab）。环两头的稳定性通常不一样：反向若只要一两步
                // 就到输入框，那比正向那个 6 稳得多——魔法数越小，越不容易被界面改动打乱。
                let back = variant == "keysb";
                if real && tabs > 0 {
                    println!("   真实输入要收件人：先把 QQ 抬到前台 → {:?}", d.focus_window(&hwnd_str));
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    let fg = d.windows().unwrap_or_default().into_iter().find(|w| w.foreground).map(|w| w.process).unwrap_or_default();
                    println!("   此刻前台 = {fg}（不是 QQ.exe 的话这一轮的读数作废）");
                }
                let mut reached = false;
                for k in 1..=tabs {
                    let ok = if real {
                        win32::send_key_real(win32::VK_TAB as u16)
                    } else {
                        unsafe {
                            // `back` 档投 Shift+Tab：修饰键也走消息队列——线程**取到**这条键消息时
                            // 系统才更新它的按键状态，所以顺序必须是 Shift↓ → Tab↓ → Tab↑ → Shift↑。
                            if back {
                                win32::PostMessageW(hwnd, win32::WM_KEYDOWN, win32::VK_SHIFT, win32::KEYDOWN_LPARAM);
                                std::thread::sleep(std::time::Duration::from_millis(30));
                            }
                            win32::PostMessageW(hwnd, win32::WM_KEYDOWN, win32::VK_TAB, win32::KEYDOWN_LPARAM);
                            std::thread::sleep(std::time::Duration::from_millis(30));
                            let r = win32::PostMessageW(hwnd, win32::WM_KEYUP, win32::VK_TAB, win32::KEYUP_LPARAM) != 0;
                            if back {
                                std::thread::sleep(std::time::Duration::from_millis(30));
                                win32::PostMessageW(hwnd, win32::WM_KEYUP, win32::VK_SHIFT, win32::KEYUP_LPARAM);
                            }
                            r
                        }
                    };
                    if !ok {
                        println!("   Tab×{k}：发不出去（真实输入被拒 / 窗口没了）");
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(450));
                    let f = focus_of(&mut d);
                    println!("   Tab×{k} → {f}");
                    if f.starts_with("Edit") {
                        println!("   ↑ **走到消息输入框了**（第 {k} 次 Tab）");
                        reached = true;
                        break;
                    }
                }
                if tabs > 0 && !reached {
                    println!("   走完 {tabs} 次 Tab 没碰到 Edit");
                }
                // ④ 后置判据：打一个探针字符，看它在不在屏上（空框有字就可见）
                // **判据只认前两个字母，不认整串**：OCR 把 `Zx9` 读成过 `Zxg`（9→g），于是
                // "字明明进了输入框"被判成"没落地"——我自己挑的探针字形把自己的判据坑了。
                // 探针要选 OCR 不会犹豫的字形，判据也别押在整串全等上。
                const PROBE: &str = "Zx9";
                const PROBE_KEY: &str = "Zx";
                let _ = d.post_input(&hwnd_str, &PostedInput::Text(PROBE.into()));
                std::thread::sleep(std::time::Duration::from_millis(2500));
                // 打完再读一次焦点：**"焦点在 Edit 上"和"字进得去"是两件事**，
                // 上一版把它们当成一件，于是拿到一个自相矛盾的读数（焦点在 Edit、字却没进去）。
                println!("   打完探针之后焦点 = {}", focus_of(&mut d));
                let wh = before.window.h;
                let seen = d.read_text(None).ok().map(|t| {
                    t.texts
                        .iter()
                        .filter(|x| x.text.contains(PROBE_KEY))
                        .map(|x| (x.rect.x, x.rect.y, x.rect.x > 300 && x.rect.y > wh * 6 / 10))
                        .collect::<Vec<_>>()
                });
                // **落在哪儿必须报出来，不能只报"落地了"**：焦点环里既有消息输入框、也有顶上的
                // 搜索框，探针进了搜索框同样"可见"——只按"看得见"判，会把一次跑错地方读成成功
                // （上一版就是这么误报的）。消息输入框在右下：x>300 且 y>0.6*h。
                let inbox = |r: &Rect| r.x > 300 && r.y > before.window.h * 6 / 10;
                match seen.as_deref() {
                    Some([]) | None => println!("#{i} tabs={tabs}：探针「{PROBE}」**整窗找不到** → 按键没落地 ❌"),
                    Some(hits) => {
                        let good = hits.iter().any(|h| h.2);
                        let where_ = hits.iter().map(|h| format!("({},{})", h.0, h.1)).collect::<Vec<_>>();
                        println!(
                            "#{i} tabs={tabs}：探针「{PROBE}」出现在 {where_:?} → {}",
                            if good { "**落进消息输入框** ✅" } else { "落地了，但**不在消息输入框**（多半是顶上的搜索框）⚠️" }
                        );
                        if good {
                            landed += 1;
                        }
                    }
                }
                let _ = inbox;
                let _ = d.post_input(&hwnd_str, &PostedInput::Key("Escape".into()));
                std::thread::sleep(std::time::Duration::from_millis(1200));
                continue;
            }
            // 清掉输入框里的残留（实验探针）：Tab 走到 Edit，然后投一串退格。
            // **不点、不发送**——只删字。
            "clearbox" => {
                let focus_is_edit = |d: &mut WindowsDesktop| -> bool {
                    let Some(root) = d.app_root.as_ref() else { return false };
                    let Ok(cond) = d.auto.create_property_condition(UIProperty::HasKeyboardFocus, Variant::from(true), None) else { return false };
                    let Ok(cache) = d.cache_request() else { return false };
                    root.find_all_build_cache(TreeScope::Descendants, &cond, &cache)
                        .map(|els| els.iter().any(|e| e.get_cached_control_type().map(control_to_role).unwrap_or_default() == "Edit"))
                        .unwrap_or(false)
                };
                for k in 1..=10 {
                    if focus_is_edit(&mut d) {
                        println!("   焦点已在 Edit 上（第 {} 次 Tab 之后）", k - 1);
                        break;
                    }
                    unsafe {
                        win32::PostMessageW(hwnd, win32::WM_KEYDOWN, win32::VK_TAB, win32::KEYDOWN_LPARAM);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        win32::PostMessageW(hwnd, win32::WM_KEYUP, win32::VK_TAB, win32::KEYUP_LPARAM);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
                // **退格要走 `WM_KEYDOWN VK_BACK`，不是 `WM_CHAR 0x08`**：Chromium 不把
                // 后者当成删除（实测投 60 个 `\u{8}` 一个字都没删掉）。
                // **投出去的退格删不掉**（`WM_CHAR 0x08` 和 `WM_KEYDOWN VK_BACK` 都试过，
                // 连投 60 次、跑 6 轮，一个字都没少）。所以清理走**真实**输入——它要收件人，
                // 先抬前台。这条差别本身也是个读数：Tab 投出去能走焦点环，退格投出去却不生效。
                println!("   抬前台（真实退格要收件人）→ {:?}", d.focus_window(&hwnd_str));
                std::thread::sleep(std::time::Duration::from_millis(700));
                // 先 Ctrl+A 全选再删：**光标停在开头时退格是空操作**——这正是前面几轮
                // "删不掉"的原因（不是按键没到，是按了个没效果的键）。
                win32::send_chord_real(win32::VK_CONTROL, win32::VK_A);
                std::thread::sleep(std::time::Duration::from_millis(400));
                for _ in 0..3 {
                    win32::send_key_real(win32::VK_BACK as u16);
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let left = d
                    .read_text(None)
                    .ok()
                    .map(|t| t.texts.iter().filter(|x| x.rect.x > 300 && x.rect.y > before.window.h * 6 / 10 && x.text != "发送").map(|x| x.text.clone()).collect::<Vec<_>>())
                    .unwrap_or_default();
                println!("#{i} 清完之后输入框区域剩下：{left:?}（空 = 干净）");
                continue;
            }
            other => {
                eprintln!("未知变体 {other}（plain / activate / dbl / rowclick / poke / wake / wake0 / open / keys / keysr / keysb / clearbox）");
                std::process::exit(2);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
        let _ = d.post_input(&hwnd_str, &PostedInput::Text(QUERY.into()));
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let after = d.read_text(None).ok();
        let (still_ph, typed) = match &after {
            Some(t) => (
                t.texts.iter().any(|x| x.text.contains("搜索") && x.rect.y < band),
                // **x 要卡住**：右侧会话标题此刻正是「我的手机」，也落在顶栏里——不卡的话
                // 这一格恒为真，等于没有判据（第一轮 8/8 全是这么误报的）。
                t.texts.iter().any(|x| x.rect.y < band && x.rect.x < 300 && x.text.contains(QUERY)),
            ),
            None => (false, false),
        };
        let ok = typed && !still_ph;
        if ok {
            landed += 1;
        }
        println!("#{i} {} (placeholder还在={still_ph} 顶栏出现查询词={typed})", if ok { "落进搜索框 ✅" } else { "没落进去 ❌" });
        let _ = d.post_input(&hwnd_str, &PostedInput::Key("Escape".into()));
        std::thread::sleep(std::time::Duration::from_millis(1200));
    }
    println!("== variant={variant}: {landed}/{} 落进搜索框（skip {skipped}）", repeats - skipped);
}

// ── SPIKE（临时）：给后台窗口打字，到底有没有一条路 ───────────────────────────────
//
// 起因：telegram-search 必须抢屏才能用。点击那半边早就走元素句柄了（不需要前台），卡在打字：
// 键盘输入没有收件人，系统只送给前台窗口。所以问题是「有没有一条有收件人的打字路」。
// 这里把候选一次跑完，每条都用同一套判据量，免得凭印象下结论（已经凭印象判错过一次）。

/// 一条候选路跑完之后的读数。**三个都要看**：写进去了吗、应用反应了吗、屏被抢了吗。
#[derive(Debug)]
pub struct SpikeReading {
    pub variant: &'static str,
    /// 目标框自己回读出来的值（None = 读不回来）
    pub readback: Option<String>,
    /// 读到的条目里有几条含查询词——应用**反应了**才会有（写进去但没触发搜索也是失败）
    pub hits: usize,
    pub total: usize,
    /// **锁屏时这一格没有意义**：谁都取不到前台，"没抢屏"和"抢不到屏"读数一样。
    /// 所以它是三态——`None` = 这轮没量准，解锁后重跑（别拿它当"没抢屏"用）。
    pub foreground_changed: Option<bool>,
    pub note: String,
}

pub fn spike_typing(query: &str) {
    let mut d = WindowsDesktop::default();
    for variant in [
        "find-only",
        "set-focus-only",
        "postmessage-no-focus",
        "listitem-invoke-then-post",
        "inner-setvalue",
        "postmessage-wm-char",
    ] {
        println!("\n══════ {variant} ══════");
        let r = spike_one(&mut d, variant, query);
        println!("→ {r:?}");
    }
}

fn spike_one(d: &mut WindowsDesktop, variant: &'static str, query: &str) -> SpikeReading {
    use protocol::Desktop;
    let fg = |d: &mut WindowsDesktop| -> String {
        d.windows().unwrap_or_default().into_iter().find(|w| w.foreground).map(|w| w.process).unwrap_or_default()
    };
    let mut note = String::new();

    // 前提：前台先摆成"不是 Telegram"，否则抢没抢屏读不出差异
    if let Some(other) = d.windows().unwrap_or_default().into_iter().find(|w| {
        !w.process.eq_ignore_ascii_case("Telegram.exe") && !w.title.is_empty() && w.title != "Program Manager"
    }) {
        let _ = d.focus_window(&other.id);
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
    let before = fg(d);
    println!("前台 BEFORE: {before}");

    let win = match d.windows().unwrap_or_default().into_iter().find(|w| w.process.eq_ignore_ascii_case("Telegram.exe")) {
        Some(w) => w,
        None => return SpikeReading { variant, readback: None, hits: 0, total: 0, foreground_changed: None, note: "Telegram 没开".into() },
    };
    let _ = d.scope_window(&win.id);

    let els = d
        .find(&protocol::A11yQuery { role: Some("Edit".into()), name: Some("搜索".into()), name_contains: None, class_name: None, path: None })
        .unwrap_or_default();
    for e in &els {
        println!("  候选: class={} x={} w={}", e.class_name, e.rect.x, e.rect.w);
    }
    // 外层容器 vs 里层真正的文本框——**这一格正是上一轮漏掉的**
    let pick = match variant {
        "outer-setvalue" => els.iter().find(|e| !e.class_name.contains("Inner")),
        _ if false => None,
        _ => els.iter().find(|e| e.class_name.contains("Inner")).or_else(|| els.first()),
    };
    let Some(target) = pick else {
        return SpikeReading { variant, readback: None, hits: 0, total: 0, foreground_changed: None, note: "没有可选的输入框".into() };
    };
    println!("  选中: class={} x={}", target.class_name, target.rect.x);
    let el = d.elements.get(&target.el_ref).cloned().expect("just found");

    // 先清空：上一轮的残留会让"这次写进去了吗"读不准（postmessage 那轮就把值追加成了两遍）。
    // **但清空本身就是一次 UIA 写**，对"不碰它就不抢屏"那几条是污染，所以那几条跳过。
    if !matches!(variant, "find-only" | "set-focus-only" | "postmessage-no-focus" | "listitem-invoke-then-post") {
    if let Ok(p) = el.get_pattern::<UIValuePattern>() {
        let _ = p.set_value("");
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    }
    let baseline = el.get_pattern::<UIValuePattern>().ok().and_then(|p| p.get_value().ok());
    println!("  写之前回读: {baseline:?}");

    match variant {
        // 只找，不动手——基线：确认"读"这一侧确实不抢屏
        "find-only" => note = "只 find，没动手".into(),
        // 只给元素焦点，不写任何东西——把"抢屏"这件事从"写入"里拆出来单独归因
        "set-focus-only" => note = format!("set_focus → {:?}", el.set_focus()),
        // 不碰焦点、直接把字符投给窗口。**这是唯一一条一个 UIA 写操作都不做的路**——
        // 前提是应用内部焦点已经在输入框上（上一步留下的）。它成不成，决定"后台打字"到底
        // 有没有出路。
        "postmessage-no-focus" => {
            let hwnd: win32::Hwnd = win.id.parse().unwrap_or(0);
            let mut posted = 0;
            for ch in query.encode_utf16() {
                if unsafe { win32::PostMessageW(hwnd, win32::WM_CHAR, ch as usize, 1) } != 0 {
                    posted += 1;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            note = format!("不碰焦点，投出 {posted} 个字符给 hwnd={hwnd}");
        }
        // 真实 recipe 的最后一步是 invoke 一条搜索结果（让主列表跳过去）——它很可能把应用
        // 内部焦点从搜索框带走。带走了的话，下一轮就没法"不碰焦点直接投字符"，那条路也就
        // 只能用一次。这一格量的就是它。
        "listitem-invoke-then-post" => {
            let items = d
                .find(&protocol::A11yQuery { role: Some("ListItem".into()), name: None, name_contains: None, class_name: None, path: None })
                .unwrap_or_default();
            if let Some(it) = items.first() {
                let r = d.invoke(&it.el_ref);
                note = format!("invoke 一条 ListItem → {r:?}; ");
                std::thread::sleep(std::time::Duration::from_millis(1200));
                println!("  ↳ invoke 之后前台: {}", fg(d));
            }
            let hwnd: win32::Hwnd = win.id.parse().unwrap_or(0);
            let mut posted = 0;
            for ch in query.encode_utf16() {
                if unsafe { win32::PostMessageW(hwnd, win32::WM_CHAR, ch as usize, 1) } != 0 {
                    posted += 1;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            note.push_str(&format!("再不碰焦点投出 {posted} 个字符"));
        }
        "outer-setvalue" | "inner-setvalue" => {
            let r = d.set_value(&target.el_ref, query);
            note = format!("setValue → {r:?}");
        }
        "focus-then-setvalue" => {
            let f = el.set_focus();
            note = format!("set_focus → {f:?}; ");
            std::thread::sleep(std::time::Duration::from_millis(400));
            let r = d.set_value(&target.el_ref, query);
            note.push_str(&format!("setValue → {r:?}"));
        }
        "postmessage-wm-char" => {
            // 先把应用内部的焦点给这个框（**不是**把窗口推到前台），再把字符逐个投给窗口句柄。
            let f = el.set_focus();
            std::thread::sleep(std::time::Duration::from_millis(400));
            let mut hwnd = win32::hwnd_of(&el);
            if hwnd == 0 {
                hwnd = win.id.parse().unwrap_or(0);
                note.push_str("元素没有自己的窗口句柄，投给顶层窗口；");
            }
            note.push_str(&format!("set_focus → {f:?}; hwnd={hwnd}; "));
            let mut posted = 0;
            for ch in query.encode_utf16() {
                let ok = unsafe { win32::PostMessageW(hwnd, win32::WM_CHAR, ch as usize, 1) };
                if ok != 0 {
                    posted += 1;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            note.push_str(&format!("投出 {posted}/{} 个字符", query.encode_utf16().count()));
        }
        _ => {}
    }

    std::thread::sleep(std::time::Duration::from_millis(2000));
    let readback = el.get_pattern::<UIValuePattern>().ok().and_then(|p| p.get_value().ok());

    let mut fields = std::collections::BTreeMap::new();
    fields.insert("text".to_string(), protocol::FieldSpec { from: None, read: "name".into() });
    let spec = protocol::ReadSpec {
        item_query: protocol::A11yQuery { role: Some("ListItem".into()), name: None, name_contains: None, class_name: None, path: None },
        fields,
        dedupe_by: "text".into(),
    };
    let rows = d.read_subtree(&spec).unwrap_or_default();
    let hits = rows.iter().filter(|x| x.get("text").and_then(|v| v.as_str()).is_some_and(|t| t.contains(query))).count();
    for x in rows.iter().filter(|x| x.get("text").and_then(|v| v.as_str()).is_some_and(|t| t.contains(query))).take(3) {
        if let Some(t) = x.get("text").and_then(|v| v.as_str()) {
            let s: String = t.replace('\n', " / ").chars().take(70).collect();
            println!("  命中样本: {s}");
        }
    }
    let after = fg(d);
    println!("前台 AFTER:  {after}");
    let locked = |s: &str| s.contains("LockApp") || s.contains("LogonUI") || s.is_empty();
    let foreground_changed = if locked(&before) || locked(&after) { None } else { Some(before != after) };

    SpikeReading { variant, readback, hits, total: rows.len(), foreground_changed, note }
}

/// exe 的文件版本 `a.b.c.d`（`GetFileVersionInfoW` + `VerQueryValueW("\\")`）。
/// 读不到（没有版本资源、路径够不着）就 `None`——**不给空串**，缺席与"版本是空"要分得开。
fn file_version(path: &std::path::Path) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), 0, size, buf.as_mut_ptr() as *mut _).ok()?;
        let mut info: *mut VS_FIXEDFILEINFO = std::ptr::null_mut();
        let mut len = 0u32;
        let root: Vec<u16> = "\\".encode_utf16().chain(std::iter::once(0)).collect();
        let ok = VerQueryValueW(
            buf.as_ptr() as *const _,
            PCWSTR(root.as_ptr()),
            &mut info as *mut _ as *mut _,
            &mut len,
        );
        // `len` 是 `VerQueryValueW` 报的可读字节数。不核它就可能读到结构体尾巴之外去——
        // 版本资源是磁盘上的数据，格式不是我们能保证的。
        if !ok.as_bool() || info.is_null() || (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
            return None;
        }
        // **`read_unaligned` 而不是 `&*info`**：`info` 指进一个 `Vec<u8>` 的中间，只按 1 字节
        // 对齐，而 `VS_FIXEDFILEINFO` 要 4。造一个未对齐的引用是 UB（哪怕 x86 上恰好读得出来）。
        let i = std::ptr::read_unaligned(info);
        // 这个魔数是 `VS_FIXEDFILEINFO` 自报家门的签名。对不上说明 `VerQueryValueW` 交回来的
        // 不是我们以为的那个结构，后面那四段数字就是垃圾——宁可缺席，别报一个编出来的版本号。
        if i.dwSignature != 0xFEEF_04BD {
            return None;
        }
        Some(format!(
            "{}.{}.{}.{}",
            i.dwFileVersionMS >> 16,
            i.dwFileVersionMS & 0xffff,
            i.dwFileVersionLS >> 16,
            i.dwFileVersionLS & 0xffff
        ))
    }
}
