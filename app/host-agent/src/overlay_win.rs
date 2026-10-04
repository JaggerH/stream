//! 接管指示条的 **Windows 渲染层** + 全局中止热键。策略在 `overlay.rs`（平台无关、可单测），
//! 这里只负责"照做"。
//!
//! 三条硬约束，每条都不是美观问题：
//! 1. **绝不夺焦**（`WS_EX_NOACTIVATE` + `SW_SHOWNOACTIVATE` + `SWP_NOACTIVATE`）：`protocol.rs`
//!    的 `guard_actuation` 判的就是"目标窗口还在不在前台"，条子弹出来抢一次焦，正在跑的这趟
//!    op 会被自己判成 `foreground-lost`。
//! 2. **点击穿透**（`WS_EX_TRANSPARENT`）：条上没有按钮（中止只走热键），一旦它能收点击，
//!    agent 自己要点屏幕顶部时就会被自己的提示条挡住，而那次点击"落在提示条上"是一次
//!    安静的失败。
//! 3. **自己一个线程 + 自己的消息泵**：`RegisterHotKey` 的 `WM_HOTKEY` 投递给注册它的那个
//!    线程，窗口过程也要泵；而 op 是在 tokio 反应器上**阻塞**执行的（见 main.rs 的注释），
//!    共用一个线程会让条子在最需要它的时候（正在打字）卡住不刷新。

use crate::overlay::{split_status, OverlayCmd};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    VK_ESCAPE,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/// 热键的唯一说明书。"AI 正在操作你的电脑"那句不再出现在条上——**四边的七彩内阴影就是那句话**
/// （`Frame`），条子只讲"在干什么 + 怎么停"。
#[cfg_attr(not(test), allow(dead_code))] // 只有测试拿它对账拆开画的三段
pub const HINT_ACTIVE: &str = "按 Ctrl+Alt+Esc 停止";
/// 同一句话拆开画：前缀字 + 每枚键一个键帽（shadcn 的 `KbdGroup`）+ 后缀字。三者拼起来必须
/// 就是 `HINT_ACTIVE`（测试钉着），改文案两处一起改。
pub const HINT_PREFIX: &str = "按";
pub const HINT_KEYS: [&str; 3] = ["Ctrl", "Alt", "Esc"];
pub const HINT_SUFFIX: &str = "停止";
/// 中止后的文案，停留 `STOPPED_LINGER` 再收起。这一档只有一行：动作已经做完了，没有下一步。
pub const TEXT_STOPPED: &str = "已停止";

/// 条子上此刻画的是什么。最多两行竖排：
///
/// ```text
/// 微信发消息 · 发给 文件传输助手   按 [Ctrl][Alt][Esc] 停止   ← 第一行：任务文字换行之前 + 热键说明
/// 点候选里的他 (8/12)                                       ← 第二行：任务文字换行之后
/// ```
///
/// 两行都来自后端的 `status` 文本，拆法是 `overlay::split_status`（没有换行的老文本只占第一行，
/// `None` 时第一行只剩热键说明）。"已停止"只有一行、没有热键说明。
struct Face {
    /// 第一行的文字（任务文字第一段，或"已停止"；正常态没有任务文字时是空串）。
    head: String,
    /// 第一行要不要画热键说明（`HINT_PREFIX`/`HINT_KEYS`/`HINT_SUFFIX`）。
    hint: bool,
    /// 第二行，有才画。
    step: Option<String>,
    /// 这一帧是不是"正在操作"（区别于"已停止"）。构造处赋值一次，别拿 `head` 去反推——
    /// 那是拿文案当状态判据，文案改了这一格会跟着悄悄错。
    active: bool,
}

impl Face {
    fn active(status: Option<&str>) -> Self {
        let (first, second) = split_status(status);
        Self { head: first.unwrap_or_default(), hint: true, step: second, active: true }
    }

    fn stopped() -> Self {
        Self { head: TEXT_STOPPED.to_string(), hint: false, step: None, active: false }
    }

    fn is_active(&self) -> bool {
        self.active
    }
}

/// "已停止"停留多久。够看清一眼、又不至于挡着用户接手。
const STOPPED_LINGER: Duration = Duration::from_millis(1000);
/// `RegisterHotKey` 的 id。同一线程内唯一即可。
const HOTKEY_ID: i32 = 0x5354;

/// 形状是**圆角矩形，固定半径**（Apple 通知横幅那一套：macOS 通知 / iOS banner 都是
/// 12–16pt 的固定圆角，不随高度变），不是两端半圆的胶囊——三行时胶囊的半圆半径会长到
/// 50px，两端吞掉一大截文字区，读起来像药丸不像通知。
const CORNER_RADIUS: i32 = 14;
/// 条的上下内边距（第一行上方 / 最后一行下方各留这么多）。
const PAD_Y: i32 = 11;
/// 两行之间的间距（shadcn 卡片标题→描述 `gap-1`）。
const LINE_GAP: i32 = 4;
/// 键帽（照 shadcn `Kbd`：高 20、最窄 20、左右内边距 5、圆角 4）与它的填充 / 描边不透明度。
const KBD_H: i32 = 20;
const KBD_MIN_W: i32 = 20;
const KBD_PAD_X: i32 = 5;
const KBD_GAP: i32 = 4;
const KBD_RADIUS: i32 = 4;
const KBD_FILL_ALPHA: f32 = 0.10;
const KBD_EDGE_ALPHA: f32 = 0.10;
/// 顶部留白。贴着屏幕上沿会读成"系统的一部分"，浮起来一点才读成"临时压在最上面的东西"。
const BAR_TOP_MARGIN: i32 = 14;
/// 文字区左右内边距、任务文字与热键说明之间的间距。
const PAD_X: i32 = 16;
const TEXT_GAP: i32 = 14;
/// 投影的绘制余量（位图要比条大一圈才装得下影子）、下沉量、最深处的不透明度。
/// 大而淡（Apple 那种"浮在上面"的散射影），不是小而黑的贴边阴影。
const SHADOW_PAD: i32 = 26;
const SHADOW_DY: i32 = 8;
const SHADOW_ALPHA: f32 = 0.34;
/// 一圈 1px 的浅色描边（材质边缘的高光），让深色条压在深色窗口上仍有一条清晰的轮廓。
const EDGE_ALPHA: f32 = 0.12;

/// 底色（近黑，接近 Apple 深色材质的 systemGray6）与它的不透明度。
/// 留一点透明是为了让底下"还看得见"——它是提示不是遮罩。
const BASE_RGB: (i32, i32, i32) = (28, 28, 30);
const BASE_ALPHA: f32 = 0.86;
/// 已停止时四边褪成的灰（不是绿：绿会读成"成功了"，而用户按下热键是把事情**打断**了）。
const FRAME_STOPPED_RGB: (i32, i32, i32) = (142, 142, 147);
/// 屏幕四边的七彩内阴影：往里的宽度（96dpi 设计稿）、贴边处的不透明度、色相绕一圈的周期（秒）、
/// 饱和度（1 是纯色霓虹，压一点才是 Apple Intelligence 那种柔光）。
const FRAME_THICKNESS: i32 = 36;
const FRAME_ALPHA: f32 = 0.5;
const FRAME_CYCLE_S: f32 = 9.0;
const FRAME_SATURATION: f32 = 0.82;
/// 一个色相周期分多少步重画（步数 × 周期 = 重画间隔；96 步 ≈ 每 94ms 一帧，肉眼连续，CPU 不烧）。
const FRAME_STEPS: u32 = 96;


/// 进出动画时长。同一条路径进、同一条路径出（淡入 + 下滑 8px / 淡出 + 上收 8px）——
/// 一样东西从哪儿来就该回哪儿去，否则读起来是两个不相干的动作。
const ANIM_MS: f32 = 220.0;
/// 动画期间的重绘间隔（约 60fps）。静止时回到 20ms，别让一条提示条空烧 CPU。
const ANIM_TICK: Duration = Duration::from_millis(16);
const IDLE_TICK: Duration = Duration::from_millis(20);
/// 进出时的位移量。
const SLIDE_PX: f32 = 8.0;

/// 主线程拿着的句柄：往里发指令，从里收热键。
pub struct OverlayHandle {
    cmd_tx: Sender<OverlayCmd>,
    pub hotkey_rx: Receiver<()>,
}

impl OverlayHandle {
    /// 发一条指令给渲染线程。**发不出去不算错**（线程没起来 / 已退出）——指示条是提示，
    /// 不该因为它挂了就把采集也拖下水。
    pub fn send(&self, cmd: OverlayCmd) {
        let _ = self.cmd_tx.send(cmd);
    }

    /// 自上次问起，用户按过中止热键吗。**不阻塞**——会话循环每 20ms 顺手问一次。
    /// 做成方法而不是让调用方直接读 `hotkey_rx`：非 Windows 那份占位类型也实现同一个方法，
    /// 会话循环因此不用给自己套 `#[cfg]`（签名分叉是漏改的温床）。
    pub fn hotkey_pressed(&self) -> bool {
        self.hotkey_rx.try_recv().is_ok()
    }
}

/// 起渲染线程：建窗口、注册热键、泵消息。返回句柄。
pub fn spawn() -> OverlayHandle {
    let (cmd_tx, cmd_rx) = channel::<OverlayCmd>();
    let (hot_tx, hotkey_rx) = channel::<()>();
    std::thread::spawn(move || run(cmd_rx, hot_tx));
    OverlayHandle { cmd_tx, hotkey_rx }
}

/// 窗口过程只做一件事：销毁时退出消息循环。条子不可交互，其余一律交给 `DefWindowProcW`。
unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// 渲染线程主体。**任何一步失败都只打一行 stderr 就返回**：没有条子的 agent 仍然能干活，
/// 为了一个提示条把采集拖垮是本末倒置。
fn run(cmd_rx: Receiver<OverlayCmd>, hot_tx: Sender<()>) {
    unsafe {
        // per-monitor DPI 感知。不开的话，在 150%/200% 缩放的屏幕上我们按 96dpi 画出来的
        // 位图会被系统整个拉伸，字是糊的——一条糊字的提示条读起来像个来路不明的弹窗，
        // 正好毁掉它要建立的那点信任。
        //
        // `main()` 已经在进程级声明了同一档（那是像素词汇的地基：wire 上一切 rect 都是物理
        // 像素），这一行因此是幂等的。留着它是为了这个线程**不依赖进程级那一行还在**——
        // 画窗口这件事自己要什么坐标系，就在自己这儿说清楚。
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hinst = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[host-agent] 指示条起不来（GetModuleHandle）：{e}");
                return;
            }
        };
        let class_name = w!("StreamOverlayBar");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        // 重复注册（进程内第二次 spawn）返回 0，不是致命错——建窗口那步会告诉我们类在不在。
        RegisterClassW(&wc);
        let hwnd = match CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class_name,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            hinst,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[host-agent] 指示条起不来（CreateWindowEx）：{e}");
                return;
            }
        };

        // 屏幕四边的描边。建不出来只少一圈边，条子照常。
        let mut frame = Frame::create(hinst, class_name);

        // 热键被别人占了（另一个 agent、某个全局工具）只打一行就继续：**没有热键的条子仍然
        // 有价值**（用户至少知道电脑正在被操作），而为此不显示条子是把两件事捆死。
        if let Err(e) = RegisterHotKey(
            hwnd,
            HOTKEY_ID,
            HOT_KEY_MODIFIERS(MOD_CONTROL.0 | MOD_ALT.0 | MOD_NOREPEAT.0),
            VK_ESCAPE.0 as u32,
        ) {
            eprintln!("[host-agent] Ctrl+Alt+Esc 注册不上（被别人占着？）：{e} — 条子照常显示，但没法用热键中止");
        }

        // "已停止"的自动收尾时刻。策略层不管这个：它已经把状态置成"不可见"了，剩下的
        // 停留时间纯粹是渲染层的事。
        let mut stopped_until: Option<Instant> = None;
        // 当前显示的是哪一张脸（第一行 / 副行 / 状态点颜色）。`None` = 收着。
        let mut face: Option<Face> = None;
        // 后端写下的任务文字（`OverlayCmd::Status`）。**和 `face` 分开存**：条子灭了它还在，
        // 下一次 Show 直接带上；只有 `Status(None)` 才清。
        let mut status: Option<String> = None;
        // 进出动画：`Some((起点, 是不是进))`。动画期间每 16ms 重绘一帧。
        let mut anim: Option<(Instant, bool)> = None;
        // 条子此刻是不是已经 show 过（决定这一帧要不要 `SetWindowPos`，见 `paint` 尾注）。
        let mut bar_shown = false;
        loop {
            // 先泵消息：WM_HOTKEY 投的是**线程队列**，不泵就永远收不到。
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_HOTKEY {
                    let _ = hot_tx.send(());
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            loop {
                match cmd_rx.try_recv() {
                    Ok(OverlayCmd::Show) => {
                        stopped_until = None;
                        // 已经在场就只换内容、不重放入场动画：同一个东西没有理由再"到达"一次。
                        if face.is_none() {
                            anim = Some((Instant::now(), true));
                        }
                        face = Some(Face::active(status.as_deref()));
                    }
                    Ok(OverlayCmd::Status(text)) => {
                        status = text;
                        // 正在亮着的正常态当场换两行文字；"已停止"那一档没有任务文字，不碰。
                        if face.as_ref().is_some_and(Face::is_active) {
                            face = Some(Face::active(status.as_deref()));
                        }
                    }
                    Ok(OverlayCmd::Stopped) => {
                        stopped_until = Some(Instant::now() + STOPPED_LINGER);
                        if face.is_none() {
                            anim = Some((Instant::now(), true));
                        }
                        face = Some(Face::stopped());
                    }
                    Ok(OverlayCmd::Hide) => {
                        stopped_until = None;
                        if face.is_some() && !matches!(anim, Some((_, false))) {
                            anim = Some((Instant::now(), false));
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    // 发送端全没了 = 主线程收摊，跟着退。
                    Err(TryRecvError::Disconnected) => {
                        let _ = UnregisterHotKey(hwnd, HOTKEY_ID);
                        if let Some(f) = frame.as_ref() {
                            f.destroy();
                        }
                        let _ = DestroyWindow(hwnd);
                        return;
                    }
                }
            }

            if let Some(t) = stopped_until {
                if Instant::now() >= t {
                    stopped_until = None;
                    if face.is_some() && !matches!(anim, Some((_, false))) {
                        anim = Some((Instant::now(), false));
                    }
                }
            }

            // 这一帧画到什么程度。0 = 完全收起，1 = 完全在场。
            let progress = match anim {
                Some((start, entering)) => {
                    let p = (start.elapsed().as_secs_f32() * 1000.0 / ANIM_MS).clamp(0.0, 1.0);
                    if p >= 1.0 {
                        anim = None;
                        if !entering {
                            // 出场走完才真的隐藏：提前 SW_HIDE 会把动画的最后几帧吃掉。
                            let _ = ShowWindow(hwnd, SW_HIDE);
                            bar_shown = false;
                            if let Some(f) = frame.as_mut() {
                                f.hide();
                            }
                            face = None;
                        }
                    }
                    if entering { p } else { 1.0 - p }
                }
                None => {
                    if face.is_some() { 1.0 } else { 0.0 }
                }
            };

            if let Some(f) = face.as_ref() {
                // 静止态只在内容变化时重绘就够，但每帧重绘一次也只有约 90×600 像素的开销，
                // 换来的是"位置永远跟着当前前台窗口的显示器走"——多显示器下这件事会变。
                // **先画四边、后画条子**，条子在 Z 序里压在四边之上（上边那条和它重叠）。
                if let Some(fr) = frame.as_mut() {
                    fr.paint(f.is_active(), progress);
                }
                paint(hwnd, f, progress, !bar_shown);
                bar_shown = true;
            }

            std::thread::sleep(if anim.is_some() { ANIM_TICK } else { IDLE_TICK });
        }
    }
}

/// 画一帧并显示。`progress` 是进出动画的位置（0 = 收起，1 = 完全在场），同时控制整体
/// 不透明度和上下位移——**进出走同一条路径**（下滑淡入 / 上收淡出）。
///
/// 这里每个字节的 alpha 都得我们自己写：`UpdateLayeredWindow` 的 `AC_SRC_ALPHA` 只认
/// 预乘过的位图，而 GDI 画字**根本不碰 alpha 通道**。所以顺序是固定的：先按几何算出
/// 每个像素的 alpha 存进一个单独的缓冲（`av`）→ 再让 GDI 往同一张位图上画字（它会把
/// alpha 字节写成 0）→ 最后一遍循环拿 `av` 把 RGB 预乘、把 alpha 补回去。
///
/// 失败一律静默返回（画不出来 ≠ 采集出错），所以这里不返回 Result。
unsafe fn paint(hwnd: HWND, face: &Face, progress: f32, first_show: bool) {
    // 位置：正在被操作的那个窗口所在的显示器。取不到就落回主显示器——**不能不显示**，
    // "取不到前台窗口"恰恰常发生在最该提示的时刻（刚要 focusApp、桌面刚锁上）。
    let fg = GetForegroundWindow();
    let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTOPRIMARY);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let work: RECT = if GetMonitorInfoW(mon, &mut mi).as_bool() {
        mi.rcWork
    } else {
        RECT { left: 0, top: 0, right: 1920, bottom: 1080 }
    };
    let work_w = work.right - work.left;

    // 这块屏的缩放比。所有尺寸都从这里过一遍——**常量是按 96dpi 写的设计稿，不是像素数**。
    let dpi = GetDpiForWindow(hwnd);
    let k = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
    let sc = |v: i32| (v as f32 * k).round() as i32;
    let (pad_x, text_gap) = (sc(PAD_X), sc(TEXT_GAP));
    let (shadow_pad, shadow_dy) = (sc(SHADOW_PAD), sc(SHADOW_DY));
    let (radius, pad_y, line_gap) = (sc(CORNER_RADIUS) as f32, sc(PAD_Y), sc(LINE_GAP));
    let (kbd_h, kbd_pad_x, kbd_gap, kbd_min_w) = (sc(KBD_H), sc(KBD_PAD_X), sc(KBD_GAP), sc(KBD_MIN_W));
    let kbd_r = sc(KBD_RADIUS) as f32;

    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(screen_dc);

    // 字体阶梯照 shadcn 的字号表：第一行 14/medium、第二行与热键说明 13/regular、键帽 12/medium。
    // 层级是"字号 + 字重 + 颜色"三样一起给的：只调字号，两行仍然抢眼睛。
    let mk_font = |px: i32, weight: i32| {
        CreateFontW(
            -px, 0, 0, 0, weight, 0, 0, 0,
            DEFAULT_CHARSET.0 as u32,
            OUT_DEFAULT_PRECIS.0 as u32,
            CLIP_DEFAULT_PRECIS.0 as u32,
            CLEARTYPE_QUALITY.0 as u32,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            w!("Segoe UI"),
        )
    };
    let font_head = mk_font(sc(14), FW_MEDIUM.0 as i32);
    let font_sub = mk_font(sc(13), FW_NORMAL.0 as i32);
    let font_kbd = mk_font(sc(12), FW_MEDIUM.0 as i32);
    let fonts = [font_head, font_sub, font_kbd];

    let measure = |dc: HDC, font: HFONT, s: &[u16]| -> SIZE {
        SelectObject(dc, font);
        let mut sz = SIZE::default();
        let _ = GetTextExtentPoint32W(dc, s, &mut sz);
        sz
    };
    let old_font = SelectObject(mem_dc, font_head);

    // 条最宽到显示器工作区减两边留白。文字来自任务，会变长（recipe 名 + 目的 + 步骤 label），
    // 超出就**截断加 …**，而不是让字从两头漏出去。
    let max_bar_w = (work_w - sc(80)).max(sc(220));
    let fit = |dc: HDC, font: HFONT, line: &str, max_w: i32| -> (Vec<u16>, SIZE) {
        let mut w = wide(line);
        let mut sz = measure(dc, font, &w);
        if sz.cx > max_w {
            let full: Vec<char> = line.chars().collect();
            let mut keep = full.len();
            while keep > 0 {
                keep -= 1;
                let cut: String = full[..keep].iter().collect::<String>() + "…";
                w = wide(&cut);
                sz = measure(dc, font, &w);
                if sz.cx <= max_w {
                    break;
                }
            }
        }
        (w, sz)
    };

    // 热键说明：前缀字 + 三枚键帽 + 后缀字（shadcn 的 `Kbd` / `KbdGroup`）。
    let w_prefix = wide(HINT_PREFIX);
    let w_suffix = wide(HINT_SUFFIX);
    let sz_prefix = measure(mem_dc, font_sub, &w_prefix);
    let sz_suffix = measure(mem_dc, font_sub, &w_suffix);
    // 每枚键帽：文字宽 + 左右内边距，最窄不小于 `KBD_MIN_W`（单字母键也得像一枚键）。
    let keys: Vec<(Vec<u16>, SIZE, i32)> = HINT_KEYS
        .iter()
        .map(|kname| {
            let w = wide(kname);
            let sz = measure(mem_dc, font_kbd, &w);
            let bw = (sz.cx + kbd_pad_x * 2).max(kbd_min_w);
            (w, sz, bw)
        })
        .collect();
    let keys_w: i32 = keys.iter().map(|(_, _, bw)| bw).sum::<i32>() + kbd_gap * (keys.len() as i32 - 1).max(0);
    let hint_w = if face.hint { sz_prefix.cx + kbd_gap + keys_w + kbd_gap + sz_suffix.cx } else { 0 };

    // **先量字再定宽**：宽度跟着内容走，不是定死一个数。定死的话「已停止」那三个字会
    // 孤零零飘在一条长条中间，看起来像出了错。
    // 第一行：任务文字（或"已停止"）→ 热键说明。第二行：当前子步骤。
    let head_max_w = max_bar_w - pad_x * 2 - if face.hint { text_gap + hint_w } else { 0 };
    let (w_head, sz_head) = fit(mem_dc, font_head, &face.head, head_max_w.max(sc(40)));
    let head_gap = if face.hint && !face.head.is_empty() { text_gap } else { 0 };
    let line1_w = sz_head.cx + head_gap + hint_w;
    let line1_h = sz_head.cy.max(if face.hint { kbd_h } else { 0 });
    let step = face.step.as_deref().map(|s| fit(mem_dc, font_sub, s, max_bar_w - pad_x * 2));
    let step_w = step.as_ref().map_or(0, |(_, sz)| sz.cx);
    let step_h = step.as_ref().map_or(0, |(_, sz)| sz.cy);

    let content_w = line1_w.max(step_w);
    let bar_w = (content_w + pad_x * 2).min(max_bar_w);
    // 条高 = 上下内边距 + 第一行 +（有第二行就加行距和它的高）。
    let bar_h = pad_y * 2 + line1_h + if step.is_some() { line_gap + step_h } else { 0 };
    // 位图比条大一圈：投影要有地方落。
    let width = bar_w + shadow_pad * 2;
    let height = bar_h + shadow_pad * 2 + shadow_dy;

    // 缓动：ease-out cubic。快起慢落，读起来是"到位"而不是"匀速滑过来"。
    let eased = 1.0 - (1.0 - progress.clamp(0.0, 1.0)).powi(3);
    let x = work.left + (work_w - width) / 2;
    let y = work.top + sc(BAR_TOP_MARGIN) - shadow_pad - (SLIDE_PX * k * (1.0 - eased)) as i32;

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // 负高度 = 自上而下的位图，这样下面按行算下标就是屏幕上的行序。
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = match CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(b) if !bits.is_null() => b,
        _ => {
            SelectObject(mem_dc, old_font);
            for f in fonts {
                let _ = DeleteObject(f);
            }
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return;
        }
    };
    let old_bmp = SelectObject(mem_dc, bmp);

    let px = std::slice::from_raw_parts_mut(bits as *mut u8, (width * height * 4) as usize);
    // 每个像素的最终 alpha 先算在这里。**不能就地写进位图的 alpha 字节**：下面 GDI 画字
    // 会把经过的像素的 alpha 抹成 0，字就跟着一起消失（这是这类分层窗口最经典的一个坑）。
    let mut av = vec![0f32; (width * height) as usize];

    let cap_left = shadow_pad as f32;
    let cap_top = shadow_pad as f32;

    // 键帽的位置（第一行里，任务文字之后）。都在位图坐标里。
    let text_x = shadow_pad + pad_x;
    let line1_y = shadow_pad + pad_y;
    let hint_x = text_x + sz_head.cx + head_gap;
    let kbd_y = line1_y + (line1_h - kbd_h) / 2;
    let mut key_rects: Vec<(i32, i32, i32, i32)> = Vec::new(); // (x, y, w, h)
    if face.hint {
        let mut kx = hint_x + sz_prefix.cx + kbd_gap;
        for (_, _, bw) in &keys {
            key_rects.push((kx, kbd_y, *bw, kbd_h));
            kx += bw + kbd_gap;
        }
    }

    for row in 0..height {
        for col in 0..width {
            let (fx, fy) = (col as f32 + 0.5, row as f32 + 0.5);
            // 条本体：有符号距离 → 1px 抗锯齿的覆盖度。自己算而不是用 GDI 的 RoundRect，
            // 因为 GDI 画出来的像素 alpha 是 0，而这张位图的 alpha 全得我们自己负责。
            let d = rounded_rect_sdf(fx - cap_left, fy - cap_top, bar_w as f32, bar_h as f32, radius);
            let cov = (0.5 - d).clamp(0.0, 1.0);
            // 投影：同一个形状往下挪几像素，按距离平方衰减。它不是装饰——没有影子，
            // 深色条压在深色窗口上会糊成一片，读不出"浮在上面"。
            let sd = rounded_rect_sdf(fx - cap_left, fy - cap_top - shadow_dy as f32, bar_w as f32, bar_h as f32, radius);
            let s = if sd <= 0.0 { 1.0 } else { (1.0 - sd / shadow_pad as f32).max(0.0).powi(2) };

            let base_a = BASE_ALPHA * cov;
            let shadow_a = SHADOW_ALPHA * s * (1.0 - cov);
            let a = (base_a + shadow_a * (1.0 - base_a)) * eased;

            let (mut r, mut g, mut b) = (0.0f32, 0.0f32, 0.0f32); // 影子是纯黑
            if cov > 0.0 {
                r = BASE_RGB.0 as f32;
                g = BASE_RGB.1 as f32;
                b = BASE_RGB.2 as f32;
                // 一圈极淡的描边 = 光打在材质边缘上。少了它，条读起来是一块贴纸；
                // 上沿略亮于下沿（光从上面来）。
                let inside = -d;
                let edge = 1.2 * k;
                if inside < edge {
                    let top_bias = if fy < cap_top + bar_h as f32 * 0.5 { 1.0 } else { 0.55 };
                    let hl = EDGE_ALPHA * top_bias * (1.0 - inside / edge).max(0.0);
                    r += (255.0 - r) * hl;
                    g += (255.0 - g) * hl;
                    b += (255.0 - b) * hl;
                }
                // 键帽：浅一档的填充 + 1px 更浅的描边（shadcn `Kbd` 的 `bg-muted` + 边）。
                for (kx, ky, kw, kh) in &key_rects {
                    let kd = rounded_rect_sdf(fx - *kx as f32, fy - *ky as f32, *kw as f32, *kh as f32, kbd_r);
                    let kc = (0.5 - kd).clamp(0.0, 1.0);
                    if kc > 0.0 {
                        let fill = KBD_FILL_ALPHA * kc;
                        let ring = if -kd < 1.0 * k { KBD_EDGE_ALPHA * kc } else { 0.0 };
                        let m = fill + ring;
                        r += (255.0 - r) * m;
                        g += (255.0 - g) * m;
                        b += (255.0 - b) * m;
                    }
                }
            }
            let i = ((row * width + col) * 4) as usize;
            px[i] = b as u8;
            px[i + 1] = g as u8;
            px[i + 2] = r as u8;
            px[i + 3] = 0;
            av[(row * width + col) as usize] = a;
        }
    }

    // 文字。颜色照 shadcn 深色档：第一行 zinc-200，第二行与热键说明 muted-foreground（zinc-400），
    // 键帽文字 zinc-300。
    SetBkMode(mem_dc, TRANSPARENT);
    SelectObject(mem_dc, font_head);
    SetTextColor(mem_dc, COLORREF(0x00E7_E4E4));
    let _ = TextOutW(mem_dc, text_x, line1_y + (line1_h - sz_head.cy) / 2, &w_head);
    if face.hint {
        SelectObject(mem_dc, font_sub);
        SetTextColor(mem_dc, COLORREF(0x00AA_A1A1));
        let _ = TextOutW(mem_dc, hint_x, line1_y + (line1_h - sz_prefix.cy) / 2, &w_prefix);
        let after_keys = hint_x + sz_prefix.cx + kbd_gap + keys_w + kbd_gap;
        let _ = TextOutW(mem_dc, after_keys, line1_y + (line1_h - sz_suffix.cy) / 2, &w_suffix);
        SelectObject(mem_dc, font_kbd);
        SetTextColor(mem_dc, COLORREF(0x00D4_D4D8));
        for ((w, sz, bw), (kx, ky, _, kh)) in keys.iter().zip(&key_rects) {
            let _ = TextOutW(mem_dc, kx + (bw - sz.cx) / 2, ky + (kh - sz.cy) / 2, w);
        }
    }
    if let Some((w, _)) = step.as_ref() {
        SelectObject(mem_dc, font_sub);
        SetTextColor(mem_dc, COLORREF(0x00AA_A1A1));
        let _ = TextOutW(mem_dc, text_x, line1_y + line1_h + line_gap, w);
    }
    SelectObject(mem_dc, old_font);

    // 最后一遍：把 RGB 预乘、把 alpha 补回去。`AC_SRC_ALPHA` 要的就是预乘位图，
    // 漏了这一步字会发灰、边缘发黑。
    for idx in 0..(width * height) as usize {
        let a = av[idx];
        let i = idx * 4;
        for c in 0..3usize {
            px[i + c] = (px[i + c] as f32 * a) as u8;
        }
        px[i + 3] = (a * 255.0) as u8;
    }

    let mut pt_dst = POINT { x, y };
    let mut size = SIZE { cx: width, cy: height };
    let mut pt_src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let _ = UpdateLayeredWindow(
        hwnd,
        screen_dc,
        Some(&mut pt_dst),
        Some(&mut size),
        mem_dc,
        Some(&mut pt_src),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );
    // 显示 + 置顶都走"不激活"的那一档：夺一次焦就会把正在跑的那个 op 判成 foreground-lost。
    // **只在第一次亮起时调 `SetWindowPos`**：位置和尺寸 `UpdateLayeredWindow` 已经带过去了，
    // 而每帧都 `HWND_TOPMOST` 一次等于每帧把它在置顶窗口之间重新插队——和四边描边（也是
    // 置顶窗口、上边那条和它重叠）互相插队，肉眼看到的就是条子在频闪。
    if first_show {
        let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }

    SelectObject(mem_dc, old_bmp);
    let _ = DeleteObject(bmp);
    for f in fonts {
        let _ = DeleteObject(f);
    }
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
}

/// 屏幕四边的七彩内阴影：四条贴着显示器**整个**边缘（不是工作区——任务栏也在"被操作"的范围里）的
/// 分层窗口，色相沿着屏幕一圈连续变化（以屏幕中心为圆心的锥形渐变）并缓慢转动，从外沿往里柔和
/// 消失。和 Claude in Chrome 接管浏览器时那一圈彩色高亮同一个意思：不看条子的人也能一眼知道
/// "整块屏此刻不是我的"；已停止时褪成灰。
///
/// 四条窗口而不是一张整屏位图：整屏 ARGB 每帧 30MB 往显卡送，四条各几十像素宽只有一两 MB。
/// 颜色沿边一维、不透明度往里一维，像素只是两者相乘，一帧几毫秒。
struct Frame {
    hinst: windows::Win32::Foundation::HMODULE,
    class_name: PCWSTR,
    /// **每块显示器一组**四条窗口——被操作的是整台电脑，不只是前台窗口那块屏。
    mons: Vec<MonFrame>,
    epoch: Instant,
}

/// 一块显示器上的那四条。
struct MonFrame {
    rc: RECT,
    dpi: u32,
    hwnds: [HWND; 4],
    /// 上一帧的（进度、状态、相位），没变就不重画。`None` = 还没 show 过。
    last: Option<(u8, bool, u32)>,
}

/// `EnumDisplayMonitors` 的回调：把每块显示器的（矩形、DPI）收进 `LPARAM` 指着的 Vec。
unsafe extern "system" fn collect_monitor(mon: HMONITOR, _dc: HDC, _rc: *mut RECT, data: LPARAM) -> windows::Win32::Foundation::BOOL {
    let out = &mut *(data.0 as *mut Vec<(RECT, u32)>);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetMonitorInfoW(mon, &mut mi).as_bool() {
        let (mut dx, mut dy) = (96u32, 96u32);
        if GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy).is_err() {
            dx = 96;
        }
        out.push((mi.rcMonitor, dx));
    }
    true.into()
}

impl Frame {
    fn create(hinst: windows::Win32::Foundation::HMODULE, class_name: PCWSTR) -> Option<Self> {
        Some(Self { hinst, class_name, mons: Vec::new(), epoch: Instant::now() })
    }

    unsafe fn make_strips(&self) -> Option<[HWND; 4]> {
        let mut hwnds = [HWND::default(); 4];
        for h in hwnds.iter_mut() {
            *h = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                self.class_name,
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                self.hinst,
                None,
            )
            .ok()?;
        }
        Some(hwnds)
    }

    unsafe fn hide(&mut self) {
        for m in self.mons.iter_mut() {
            for h in m.hwnds {
                let _ = ShowWindow(h, SW_HIDE);
            }
            m.last = None;
        }
    }

    unsafe fn destroy(&self) {
        for m in &self.mons {
            for h in m.hwnds {
                let _ = DestroyWindow(h);
            }
        }
    }

    /// 显示器布局变了（插拔、改缩放）就整组重建；没变就沿用。
    unsafe fn sync_monitors(&mut self) {
        let mut found: Vec<(RECT, u32)> = Vec::new();
        let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut found as *mut _ as isize));
        let same = found.len() == self.mons.len()
            && found.iter().zip(&self.mons).all(|((rc, dpi), m)| {
                rc.left == m.rc.left && rc.top == m.rc.top && rc.right == m.rc.right && rc.bottom == m.rc.bottom && *dpi == m.dpi
            });
        if same {
            return;
        }
        self.destroy();
        self.mons = found
            .into_iter()
            .filter_map(|(rc, dpi)| self.make_strips().map(|hwnds| MonFrame { rc, dpi, hwnds, last: None }))
            .collect();
    }

    /// 每块显示器画一圈。`progress` 同条子的进出动画。
    unsafe fn paint(&mut self, active: bool, progress: f32) {
        self.sync_monitors();
        let eased = 1.0 - (1.0 - progress.clamp(0.0, 1.0)).powi(3);
        // 色相转动的相位，量化成 `FRAME_STEPS` 步——静止的灰边（已停止）不转，也就不重画。
        let phase = if active {
            ((self.epoch.elapsed().as_secs_f32() / FRAME_CYCLE_S).fract() * FRAME_STEPS as f32) as u32
        } else {
            0
        };
        let key = ((eased * 255.0) as u8, active, phase);
        for i in 0..self.mons.len() {
            if self.mons[i].last == Some(key) {
                continue;
            }
            let first_show = self.mons[i].last.is_none();
            self.mons[i].last = Some(key);
            let (rc, dpi, hwnds) = (self.mons[i].rc, self.mons[i].dpi, self.mons[i].hwnds);
            Self::paint_monitor(rc, dpi, &hwnds, active, eased, phase, first_show);
        }
    }

    unsafe fn paint_monitor(rc: RECT, dpi: u32, hwnds: &[HWND; 4], active: bool, eased: f32, phase: u32, first_show: bool) {
        let k = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
        let t = ((FRAME_THICKNESS as f32 * k).round() as i32).max(2);
        let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
        let hue0 = phase as f32 / FRAME_STEPS as f32;
        // 往里的不透明度剖面：贴边最深，平滑衰减到 0（内阴影，不是一条实线）。
        let profile: Vec<f32> = (0..t).map(|d| (1.0 - d as f32 / t as f32).powf(1.8) * FRAME_ALPHA * eased).collect();
        // 某个屏幕坐标（相对显示器左上）的颜色：色相 = 到屏幕中心的方位角 + 转动相位。
        let color_at = |x: f32, y: f32| -> (f32, f32, f32) {
            if !active {
                return (FRAME_STOPPED_RGB.0 as f32, FRAME_STOPPED_RGB.1 as f32, FRAME_STOPPED_RGB.2 as f32);
            }
            let ang = (y - cy).atan2(x - cx) / std::f32::consts::TAU;
            hsv_to_rgb((ang + hue0).rem_euclid(1.0), FRAME_SATURATION, 1.0)
        };
        // 四条：上、下横贯全宽；左、右夹在上下之间。角上（上下条的两端）取两个方向剖面的较大者，
        // 和左右条接上时才没有一道折缝。
        // (x, y, w, h, 哪一边是外沿: 0 上 1 下 2 左 3 右)
        let strips = [
            (rc.left, rc.top, w, t, 0),
            (rc.left, rc.bottom - t, w, t, 1),
            (rc.left, rc.top + t, t, (h - 2 * t).max(0), 2),
            (rc.right - t, rc.top + t, t, (h - 2 * t).max(0), 3),
        ];
        let screen_dc = GetDC(None);
        for (hwnd, (x, y, sw, sh, side)) in hwnds.iter().zip(strips) {
            if sw <= 0 || sh <= 0 {
                let _ = ShowWindow(*hwnd, SW_HIDE);
                continue;
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: sw,
                    biHeight: -sh,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bmp = match CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(b) if !bits.is_null() => b,
                _ => {
                    let _ = DeleteDC(mem_dc);
                    continue;
                }
            };
            let old = SelectObject(mem_dc, bmp);
            let px = std::slice::from_raw_parts_mut(bits as *mut u8, (sw * sh * 4) as usize);
            let horizontal = side < 2;
            // 沿边那一维的颜色，一维算一次。
            let along = if horizontal { sw } else { sh };
            let colors: Vec<(f32, f32, f32)> = (0..along)
                .map(|i| {
                    let (lx, ly) = if horizontal {
                        (i as f32, (y - rc.top) as f32 + if side == 0 { 0.0 } else { t as f32 })
                    } else {
                        ((x - rc.left) as f32 + if side == 2 { 0.0 } else { t as f32 }, (y - rc.top + i) as f32)
                    };
                    color_at(lx, ly)
                })
                .collect();
            for row in 0..sh {
                for col in 0..sw {
                    let dist = match side {
                        0 => row,
                        1 => sh - 1 - row,
                        2 => col,
                        _ => sw - 1 - col,
                    };
                    let mut a = profile[(dist as usize).min(profile.len() - 1)];
                    if horizontal {
                        // 两端的角：横向也算一个剖面，取大者，和左右条的剖面接平。
                        let side_d = col.min(sw - 1 - col);
                        if side_d < t {
                            a = a.max(profile[side_d as usize]);
                        }
                    }
                    let c = colors[if horizontal { col } else { row } as usize];
                    let i = ((row * sw + col) * 4) as usize;
                    px[i] = (c.2 * a) as u8;
                    px[i + 1] = (c.1 * a) as u8;
                    px[i + 2] = (c.0 * a) as u8;
                    px[i + 3] = (a * 255.0) as u8;
                }
            }
            let mut pt_dst = POINT { x, y };
            let mut size = SIZE { cx: sw, cy: sh };
            let mut pt_src = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            let _ = UpdateLayeredWindow(
                *hwnd,
                screen_dc,
                Some(&mut pt_dst),
                Some(&mut size),
                mem_dc,
                Some(&mut pt_src),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            // 同条子：只在第一次亮起时 show + 置顶，之后只换像素（理由见 `paint` 尾注）。
            if first_show {
                let _ = SetWindowPos(*hwnd, HWND_TOPMOST, x, y, sw, sh, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                let _ = ShowWindow(*hwnd, SW_SHOWNOACTIVATE);
            }
            SelectObject(mem_dc, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem_dc);
        }
        ReleaseDC(None, screen_dc);
    }
}

/// HSV → RGB（0–255 浮点）。`h` 0–1 绕一圈。
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    let (r, g, b) = match (i as i32).rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    (r * 255.0, g * 255.0, b * 255.0)
}

/// 圆角矩形的有符号距离场：负 = 在里面，正 = 在外面，单位是像素。给抗锯齿和投影共用一份，
/// 两者因此天然对齐（各写一份的话，影子的形状会和本体差一点，看起来像重影）。
///
/// 半径 `r` 固定，不随高度变（`CORNER_RADIUS`）；矩形比 2r 还小时半径退到一半边长。
fn rounded_rect_sdf(x: f32, y: f32, w: f32, h: f32, r: f32) -> f32 {
    let r = r.min(w / 2.0).min(h / 2.0);
    let (hx, hy) = (w / 2.0 - r, h / 2.0 - r);
    let (px, py) = ((x - w / 2.0).abs() - hx, (y - h / 2.0).abs() - hy);
    let outside = (px.max(0.0).powi(2) + py.max(0.0).powi(2)).sqrt();
    outside + px.max(py).min(0.0) - r
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 键帽拆法必须和整句文案一致——文案改了一处没改另一处，画出来的和文档里写的就不是一句话。
    #[test]
    fn hint_pieces_compose_the_hint_sentence() {
        assert_eq!(format!("{} {} {}", HINT_PREFIX, HINT_KEYS.join("+"), HINT_SUFFIX), HINT_ACTIVE);
    }
}
