//! 接管提示的 **macOS 渲染层** + 全局中止热键。策略在 `overlay.rs`（平台无关、可单测），画面
//! 逐项对齐 `overlay_win.rs`：每块屏一圈色相转动的七彩内阴影、顶部两行条（任务文字 + 键帽热键
//! / 当前子步骤）、"已停止"褪灰一秒收起。设计见
//! `docs/superpowers/specs/2026-09-14-desktop-mac-takeover-overlay-design.md`。
//!
//! 三条硬约束，和 Windows 那份同一个意思、不同的写法：
//! 1. **绝不夺焦**：窗口只 `orderFrontRegardless`，从不 `makeKeyAndOrderFront`；`NSApp` 的激活
//!    策略是 accessory（没有 Dock 图标，也不会被当成前台应用）。
//! 2. **点击穿透**：`ignoresMouseEvents = YES`——agent 点屏幕顶部时不能被自己的提示条挡住。
//! 3. **必须在主线程**：AppKit 的窗口只能在主线程建和改，所以 `run_main_loop` 由 `main` 在主线程
//!    调用、永不返回，tokio 那一半搬到别的线程（见 `main.rs`）。热键的 event tap 也挂这条线程的
//!    run loop。
//!
//! 依赖只有 `objc`（消息发送宏）和几个裸 FFI——不引 objc2/cocoa 全家桶，理由同 `macos.rs` 头注。

#![allow(unexpected_cfgs)] // `objc` 的宏里有 cfg(feature = "verify_message")，那是它自己的 feature

use crate::overlay::{split_status, OverlayCmd};
use objc::runtime::{Object, BOOL, NO, YES};
use objc::{class, msg_send, sel, sel_impl};
use objc::{Encode, Encoding};
use std::ffi::c_void;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};

type Id = *mut Object;

/// 热键的唯一说明书。"AI 正在操作你的电脑"那句不在条上——**四边的七彩内阴影就是那句话**。
#[cfg_attr(not(test), allow(dead_code))]
pub const HINT_ACTIVE: &str = "按 Ctrl+Alt+Esc 停止";
pub const HINT_PREFIX: &str = "按";
pub const HINT_KEYS: [&str; 3] = ["Ctrl", "Alt", "Esc"];
pub const HINT_SUFFIX: &str = "停止";
pub const TEXT_STOPPED: &str = "已停止";

// ── 尺寸与颜色（点，不是像素；retina 由 backingScaleFactor 放大）。数值与 overlay_win 同 ──
const CORNER_RADIUS: f64 = 14.0;
const PAD_X: f64 = 16.0;
const PAD_Y: f64 = 11.0;
const LINE_GAP: f64 = 4.0;
const TEXT_GAP: f64 = 14.0;
const BAR_TOP_MARGIN: f64 = 14.0;
const SHADOW_PAD: f64 = 26.0;
const SHADOW_DY: f64 = 8.0;
const SHADOW_ALPHA: f64 = 0.34;
const EDGE_ALPHA: f64 = 0.12;
const BASE_RGB: (f64, f64, f64) = (28.0 / 255.0, 28.0 / 255.0, 30.0 / 255.0);
const BASE_ALPHA: f64 = 0.86;
const KBD_H: f64 = 20.0;
const KBD_MIN_W: f64 = 20.0;
const KBD_PAD_X: f64 = 5.0;
const KBD_GAP: f64 = 4.0;
const KBD_RADIUS: f64 = 4.0;
const KBD_FILL_ALPHA: f64 = 0.10;
const KBD_EDGE_ALPHA: f64 = 0.10;
const FRAME_THICKNESS: f64 = 36.0;
const FRAME_ALPHA: f32 = 0.5;
const FRAME_CYCLE_S: f32 = 9.0;
const FRAME_SATURATION: f32 = 0.82;
const FRAME_STEPS: u32 = 96;
const FRAME_STOPPED_RGB: (f32, f32, f32) = (142.0, 142.0, 147.0);
const STOPPED_LINGER: Duration = Duration::from_millis(1000);
const ANIM_MS: f32 = 220.0;
const SLIDE_PX: f64 = 8.0;
/// 主线程每一轮泵 run loop 的时长（也是空闲时的重绘间隔）。
const TICK: Duration = Duration::from_millis(20);
/// 屏保层：压过菜单栏、Dock 与全屏应用。
const WINDOW_LEVEL: i64 = 1000;
/// NSWindowCollectionBehavior：canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
const COLLECTION_BEHAVIOR: u64 = 1 | 16 | 64 | 256;
/// NSApplicationActivationPolicyAccessory
const ACTIVATION_POLICY_ACCESSORY: i64 = 1;

// ── 几何类型（给 objc 消息用，编码字符串得和 AppKit 的一致）──
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NSPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NSSize {
    w: f64,
    h: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NSRect {
    origin: NSPoint,
    size: NSSize,
}
unsafe impl Encode for NSPoint {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGPoint=dd}") }
    }
}
unsafe impl Encode for NSSize {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGSize=dd}") }
    }
}
unsafe impl Encode for NSRect {
    fn encode() -> Encoding {
        unsafe { Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
    }
}
fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect {
        origin: NSPoint { x, y },
        size: NSSize { w, h },
    }
}

#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSFontAttributeName: Id;
    static NSForegroundColorAttributeName: Id;
    static NSDeviceRGBColorSpace: Id;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        mask: u64,
        callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        user: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    static kCFRunLoopDefaultMode: *const c_void;
    fn CFMachPortCreateRunLoopSource(
        alloc: *const c_void,
        port: *mut c_void,
        order: isize,
    ) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: bool) -> i32;
}

/// 主线程拿着的句柄：往里发指令，从里收热键。和 `overlay_win::OverlayHandle` 同名同方法。
pub struct OverlayHandle {
    cmd_tx: Sender<OverlayCmd>,
    pub hotkey_rx: Receiver<()>,
}

impl OverlayHandle {
    pub fn send(&self, cmd: OverlayCmd) {
        let _ = self.cmd_tx.send(cmd);
    }
    pub fn hotkey_pressed(&self) -> bool {
        self.hotkey_rx.try_recv().is_ok()
    }
}

/// 渲染层那一半：由 `main` 在主线程上 `run` 起来，永不返回（`deadline` 只给 demo 用）。
pub struct OverlayLoop {
    cmd_rx: Receiver<OverlayCmd>,
    hot_tx: Sender<()>,
}

/// 建一对：句柄给会话循环（任意线程），`OverlayLoop` 必须在主线程 `run`。
pub fn spawn() -> (OverlayHandle, OverlayLoop) {
    let (cmd_tx, cmd_rx) = channel::<OverlayCmd>();
    let (hot_tx, hotkey_rx) = channel::<()>();
    (
        OverlayHandle { cmd_tx, hotkey_rx },
        OverlayLoop { cmd_rx, hot_tx },
    )
}

/// 条子上此刻画的是什么（同 `overlay_win::Face`）。
struct Face {
    head: String,
    hint: bool,
    step: Option<String>,
    active: bool,
}

impl Face {
    fn active(status: Option<&str>) -> Self {
        let (first, second) = split_status(status);
        Self {
            head: first.unwrap_or_default(),
            hint: true,
            step: second,
            active: true,
        }
    }
    fn stopped() -> Self {
        Self {
            head: TEXT_STOPPED.to_string(),
            hint: false,
            step: None,
            active: false,
        }
    }
}

// ── CGEventTap 热键 ──

const KCG_SESSION_EVENT_TAP: u32 = 1;
const KCG_HEAD_INSERT: u32 = 0;
const KCG_TAP_LISTEN_ONLY: u32 = 1;
const KCG_EVENT_KEY_DOWN: u32 = 10;
const KCG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const KCG_EVENT_TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
const FLAG_SHIFT: u64 = 1 << 17;
const FLAG_CONTROL: u64 = 1 << 18;
const FLAG_ALTERNATE: u64 = 1 << 19;
const FLAG_COMMAND: u64 = 1 << 20;
const KEYCODE_ESCAPE: i64 = 53;

struct TapState {
    tap: *mut c_void,
    hot_tx: Sender<()>,
}

extern "C" fn tap_callback(
    _proxy: *mut c_void,
    kind: u32,
    event: *mut c_void,
    user: *mut c_void,
) -> *mut c_void {
    let st = unsafe { &*(user as *const TapState) };
    // 系统会在回调太慢时把 tap 关掉；listen-only 的 tap 也会。收到就重新打开，否则热键静默失效。
    if kind == KCG_EVENT_TAP_DISABLED_BY_TIMEOUT || kind == KCG_EVENT_TAP_DISABLED_BY_USER {
        unsafe { CGEventTapEnable(st.tap, true) };
        return event;
    }
    if kind == KCG_EVENT_KEY_DOWN {
        let code = unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) };
        let flags = unsafe { CGEventGetFlags(event) };
        let mods = flags & (FLAG_SHIFT | FLAG_CONTROL | FLAG_ALTERNATE | FLAG_COMMAND);
        if code == KEYCODE_ESCAPE && mods == FLAG_CONTROL | FLAG_ALTERNATE {
            let _ = st.hot_tx.send(());
        }
    }
    event
}

/// 挂热键 tap 到当前线程的 run loop。失败只打一行——没有热键的提示仍然有价值。
/// 返回的 `Box` 必须活到进程结束（回调拿着裸指针）。
unsafe fn install_hotkey(hot_tx: Sender<()>) -> Option<Box<TapState>> {
    let mut st = Box::new(TapState {
        tap: std::ptr::null_mut(),
        hot_tx,
    });
    let user = &mut *st as *mut TapState as *mut c_void;
    let tap = CGEventTapCreate(
        KCG_SESSION_EVENT_TAP,
        KCG_HEAD_INSERT,
        KCG_TAP_LISTEN_ONLY,
        1u64 << KCG_EVENT_KEY_DOWN,
        tap_callback,
        user,
    );
    if tap.is_null() {
        eprintln!("[host-agent] Ctrl+Alt+Esc 注册不上（没给「辅助功能」/「输入监控」权限？）— 提示照常显示，但没法用热键中止");
        return None;
    }
    st.tap = tap;
    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);
    Some(st)
}

// ── AppKit 小工具 ──

unsafe fn nsstring(s: &str) -> Id {
    let c = std::ffi::CString::new(s).unwrap_or_default();
    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
}

unsafe fn color(r: f64, g: f64, b: f64, a: f64) -> Id {
    msg_send![class!(NSColor), colorWithSRGBRed: r green: g blue: b alpha: a]
}

/// 一扇透明、点击穿透、置顶、不夺焦的窗口，内容是一个 NSImageView。
unsafe fn make_window() -> Id {
    let win: Id = msg_send![class!(NSWindow), alloc];
    // styleMask 0 = borderless；backing 2 = buffered
    let win: Id = msg_send![win, initWithContentRect: rect(0.0, 0.0, 1.0, 1.0) styleMask: 0u64 backing: 2u64 defer: NO];
    let _: () = msg_send![win, setReleasedWhenClosed: NO];
    let _: () = msg_send![win, setLevel: WINDOW_LEVEL];
    let _: () = msg_send![win, setOpaque: NO];
    let clear: Id = msg_send![class!(NSColor), clearColor];
    let _: () = msg_send![win, setBackgroundColor: clear];
    let _: () = msg_send![win, setHasShadow: NO];
    let _: () = msg_send![win, setIgnoresMouseEvents: YES];
    let _: () = msg_send![win, setCollectionBehavior: COLLECTION_BEHAVIOR];
    let view: Id = msg_send![class!(NSImageView), alloc];
    let view: Id = msg_send![view, initWithFrame: rect(0.0, 0.0, 1.0, 1.0)];
    // NSImageScaleNone：图和窗口一样大，别让它再缩放一次。
    let _: () = msg_send![view, setImageScaling: 2u64];
    let _: () = msg_send![win, setContentView: view];
    win
}

/// 把一张图放进窗口并摆到 `frame`（AppKit 坐标：原点在主屏左下）。`show` 只在第一次亮起时 `orderFrontRegardless`。
unsafe fn present(win: Id, image: Id, frame: NSRect, show: bool) {
    let _: () = msg_send![win, setFrame: frame display: YES];
    let view: Id = msg_send![win, contentView];
    let _: () = msg_send![view, setFrame: rect(0.0, 0.0, frame.size.w, frame.size.h)];
    let _: () = msg_send![view, setImage: image];
    if show {
        let _: () = msg_send![win, orderFrontRegardless];
    }
}

/// 一张 `w×h` 点、按 `scale` 出像素的位图（预乘 RGBA、alpha 在后）。返回 (rep, 像素指针, 每行字节数)。
unsafe fn make_bitmap(w: f64, h: f64, scale: f64) -> (Id, *mut u8, usize) {
    let pw = (w * scale).round() as i64;
    let ph = (h * scale).round() as i64;
    let rep: Id = msg_send![class!(NSBitmapImageRep), alloc];
    let rep: Id = msg_send![rep,
        initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>()
        pixelsWide: pw
        pixelsHigh: ph
        bitsPerSample: 8i64
        samplesPerPixel: 4i64
        hasAlpha: YES
        isPlanar: NO
        colorSpaceName: NSDeviceRGBColorSpace
        bitmapFormat: 0u64
        bytesPerRow: 0i64
        bitsPerPixel: 0i64];
    let _: () = msg_send![rep, setSize: NSSize { w, h }];
    let data: *mut u8 = msg_send![rep, bitmapData];
    let stride: i64 = msg_send![rep, bytesPerRow];
    (rep, data, stride as usize)
}

unsafe fn image_from_rep(rep: Id, w: f64, h: f64) -> Id {
    let img: Id = msg_send![class!(NSImage), alloc];
    let img: Id = msg_send![img, initWithSize: NSSize { w, h }];
    let _: () = msg_send![img, addRepresentation: rep];
    img
}

unsafe fn font(size: f64, weight: f64) -> Id {
    msg_send![class!(NSFont), systemFontOfSize: size weight: weight]
}

/// 带字体和颜色的 NSAttributedString。
unsafe fn attributed(text: &str, font: Id, color: Id) -> Id {
    let attrs: Id = msg_send![class!(NSMutableDictionary), dictionaryWithCapacity: 2u64];
    let _: () = msg_send![attrs, setObject: font forKey: NSFontAttributeName];
    let _: () = msg_send![attrs, setObject: color forKey: NSForegroundColorAttributeName];
    let s: Id = msg_send![class!(NSAttributedString), alloc];
    msg_send![s, initWithString: nsstring(text) attributes: attrs]
}

unsafe fn text_size(s: Id) -> NSSize {
    msg_send![s, size]
}

/// 超宽就末尾截断加 …（同 Windows 那份）。
unsafe fn fit(text: &str, font: Id, color: Id, max_w: f64) -> (Id, NSSize) {
    let mut s = attributed(text, font, color);
    let mut sz = text_size(s);
    if sz.w > max_w {
        let full: Vec<char> = text.chars().collect();
        let mut keep = full.len();
        while keep > 0 {
            keep -= 1;
            let cut: String = full[..keep].iter().collect::<String>() + "…";
            s = attributed(&cut, font, color);
            sz = text_size(s);
            if sz.w <= max_w {
                break;
            }
        }
    }
    (s, sz)
}

unsafe fn rounded(r: NSRect, radius: f64) -> Id {
    msg_send![class!(NSBezierPath), bezierPathWithRoundedRect: r xRadius: radius yRadius: radius]
}

/// 画条子：返回 (image, 宽, 高)，尺寸以点计。坐标在这里按"上为 0"算，落笔时翻转。
unsafe fn paint_bar(face: &Face, scale: f64, max_bar_w: f64, eased: f64) -> (Id, f64, f64) {
    let font_head = font(14.0, 0.23); // NSFontWeightMedium
    let font_sub = font(13.0, 0.0); // Regular
    let font_kbd = font(12.0, 0.23);
    let c_head = color(0.894, 0.894, 0.906, 1.0); // zinc-200
    let c_sub = color(0.631, 0.631, 0.667, 1.0); // zinc-400
    let c_kbd = color(0.831, 0.831, 0.847, 1.0); // zinc-300

    // 热键说明：前缀字 + 三枚键帽 + 后缀字。
    let prefix = attributed(HINT_PREFIX, font_sub, c_sub);
    let suffix = attributed(HINT_SUFFIX, font_sub, c_sub);
    let sz_prefix = text_size(prefix);
    let sz_suffix = text_size(suffix);
    let keys: Vec<(Id, NSSize, f64)> = HINT_KEYS
        .iter()
        .map(|k| {
            let s = attributed(k, font_kbd, c_kbd);
            let sz = text_size(s);
            (s, sz, (sz.w + KBD_PAD_X * 2.0).max(KBD_MIN_W))
        })
        .collect();
    let keys_w: f64 =
        keys.iter().map(|(_, _, bw)| bw).sum::<f64>() + KBD_GAP * (keys.len() as f64 - 1.0);
    let hint_w = if face.hint {
        sz_prefix.w + KBD_GAP + keys_w + KBD_GAP + sz_suffix.w
    } else {
        0.0
    };

    let head_max_w = max_bar_w - PAD_X * 2.0 - if face.hint { TEXT_GAP + hint_w } else { 0.0 };
    let (head, sz_head) = fit(&face.head, font_head, c_head, head_max_w.max(40.0));
    let head_gap = if face.hint && !face.head.is_empty() {
        TEXT_GAP
    } else {
        0.0
    };
    let line1_w = sz_head.w + head_gap + hint_w;
    let line1_h = sz_head.h.max(if face.hint { KBD_H } else { 0.0 });
    let step = face
        .step
        .as_deref()
        .map(|s| fit(s, font_sub, c_sub, max_bar_w - PAD_X * 2.0));
    let step_w = step.as_ref().map_or(0.0, |(_, sz)| sz.w);
    let step_h = step.as_ref().map_or(0.0, |(_, sz)| sz.h);

    let bar_w = (line1_w.max(step_w) + PAD_X * 2.0).min(max_bar_w).ceil();
    let bar_h = (PAD_Y * 2.0
        + line1_h
        + if step.is_some() {
            LINE_GAP + step_h
        } else {
            0.0
        })
    .ceil();
    let width = bar_w + SHADOW_PAD * 2.0;
    let height = bar_h + SHADOW_PAD * 2.0 + SHADOW_DY;

    let (rep, _, _) = make_bitmap(width, height, scale);
    let ctx: Id = msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
    let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
    let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: ctx];
    // 不用再 `CGContextScaleCTM`：rep 的 `size`（点）和像素数不同时，AppKit 建出来的上下文已经
    // 把点→像素的缩放放进 CTM 了；再乘一次就是 retina 上字大一倍、上半截被裁掉（实测 2026-09-14）。
    // 翻转：AppKit 位图原点在左下，下面全按"上为 0"写，y 落笔时换算。
    let fy = |top: f64, h: f64| height - top - h;

    // 整体不透明度随进出动画：AppKit 没有整层 alpha，这里把每种颜色的 alpha 乘上 eased。
    let bar_rect = rect(SHADOW_PAD, fy(SHADOW_PAD, bar_h), bar_w, bar_h);
    // 投影：NSShadow 在填充时一起画。
    let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
    let shadow: Id = msg_send![class!(NSShadow), alloc];
    let shadow: Id = msg_send![shadow, init];
    let _: () = msg_send![shadow, setShadowOffset: NSSize { w: 0.0, h: -SHADOW_DY }];
    let _: () = msg_send![shadow, setShadowBlurRadius: SHADOW_PAD * 0.7];
    let _: () = msg_send![shadow, setShadowColor: color(0.0, 0.0, 0.0, SHADOW_ALPHA * eased)];
    let _: () = msg_send![shadow, set];
    let _: () = msg_send![
        color(BASE_RGB.0, BASE_RGB.1, BASE_RGB.2, BASE_ALPHA * eased),
        setFill
    ];
    let _: () = msg_send![rounded(bar_rect, CORNER_RADIUS), fill];
    let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
    // 一圈极淡的描边（材质边缘的高光）。
    let inset = rect(
        bar_rect.origin.x + 0.5,
        bar_rect.origin.y + 0.5,
        bar_w - 1.0,
        bar_h - 1.0,
    );
    let edge = rounded(inset, CORNER_RADIUS - 0.5);
    let _: () = msg_send![edge, setLineWidth: 1.0f64];
    let _: () = msg_send![color(1.0, 1.0, 1.0, EDGE_ALPHA * eased), setStroke];
    let _: () = msg_send![edge, stroke];

    // 文字与键帽。
    let text_x = SHADOW_PAD + PAD_X;
    let line1_top = SHADOW_PAD + PAD_Y;
    let _: () = msg_send![head, drawAtPoint: NSPoint { x: text_x, y: fy(line1_top + (line1_h - sz_head.h) / 2.0, sz_head.h) }];
    if face.hint {
        let hint_x = text_x + sz_head.w + head_gap;
        let _: () = msg_send![prefix, drawAtPoint: NSPoint { x: hint_x, y: fy(line1_top + (line1_h - sz_prefix.h) / 2.0, sz_prefix.h) }];
        let mut kx = hint_x + sz_prefix.w + KBD_GAP;
        let kbd_top = line1_top + (line1_h - KBD_H) / 2.0;
        for (s, sz, bw) in &keys {
            let kr = rect(kx, fy(kbd_top, KBD_H), *bw, KBD_H);
            let _: () = msg_send![color(1.0, 1.0, 1.0, KBD_FILL_ALPHA * eased), setFill];
            let _: () = msg_send![rounded(kr, KBD_RADIUS), fill];
            let ki = rect(kr.origin.x + 0.5, kr.origin.y + 0.5, bw - 1.0, KBD_H - 1.0);
            let kp = rounded(ki, KBD_RADIUS - 0.5);
            let _: () = msg_send![kp, setLineWidth: 1.0f64];
            let _: () = msg_send![color(1.0, 1.0, 1.0, KBD_EDGE_ALPHA * eased), setStroke];
            let _: () = msg_send![kp, stroke];
            let _: () = msg_send![*s, drawAtPoint: NSPoint { x: kx + (bw - sz.w) / 2.0, y: fy(kbd_top + (KBD_H - sz.h) / 2.0, sz.h) }];
            kx += bw + KBD_GAP;
        }
        let after = hint_x + sz_prefix.w + KBD_GAP + keys_w + KBD_GAP;
        let _: () = msg_send![suffix, drawAtPoint: NSPoint { x: after, y: fy(line1_top + (line1_h - sz_suffix.h) / 2.0, sz_suffix.h) }];
    }
    if let Some((s, sz)) = step.as_ref() {
        let _: () = msg_send![*s, drawAtPoint: NSPoint { x: text_x, y: fy(line1_top + line1_h + LINE_GAP, sz.h) }];
    }
    let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
    (image_from_rep(rep, width, height), width, height)
}

/// 文字的 alpha 随进出动画：AppKit 的 attributed 文字 alpha 已经在颜色里，这里没法整层乘，
/// 所以进出动画期间文字会比底色早一点全亮——220ms，肉眼分不出。

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

/// 一块屏的四条。
struct ScreenFrame {
    frame: NSRect,
    scale: f64,
    wins: [Id; 4],
    last: Option<(u8, bool, u32)>,
}

/// 四边七彩内阴影，逐像素写位图（公式同 `overlay_win::Frame::paint_monitor`）。
unsafe fn paint_frame(sf: &mut ScreenFrame, active: bool, eased: f32, phase: u32) {
    let key = ((eased * 255.0) as u8, active, phase);
    if sf.last == Some(key) {
        return;
    }
    let first_show = sf.last.is_none();
    sf.last = Some(key);
    let scale = sf.scale;
    let t_pt = FRAME_THICKNESS;
    let (w_pt, h_pt) = (sf.frame.size.w, sf.frame.size.h);
    let t = (t_pt * scale).round() as i64;
    let (w, h) = ((w_pt * scale).round() as i64, (h_pt * scale).round() as i64);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let hue0 = phase as f32 / FRAME_STEPS as f32;
    let profile: Vec<f32> = (0..t)
        .map(|d| (1.0 - d as f32 / t as f32).powf(1.8) * FRAME_ALPHA * eased)
        .collect();
    let color_at = |x: f32, y: f32| -> (f32, f32, f32) {
        if !active {
            return FRAME_STOPPED_RGB;
        }
        let ang = (y - cy).atan2(x - cx) / std::f32::consts::TAU;
        hsv_to_rgb((ang + hue0).rem_euclid(1.0), FRAME_SATURATION, 1.0)
    };
    // (x, y, w, h, 外沿) —— 以屏幕左上为原点、像素计；side: 0 上 1 下 2 左 3 右
    let strips = [
        (0, 0, w, t, 0),
        (0, h - t, w, t, 1),
        (0, t, t, (h - 2 * t).max(0), 2),
        (w - t, t, t, (h - 2 * t).max(0), 3),
    ];
    for (win, (x, y, sw, sh, side)) in sf.wins.iter().zip(strips) {
        if sw <= 0 || sh <= 0 {
            continue;
        }
        let (pw, ph) = (sw as f64 / scale, sh as f64 / scale);
        let (rep, data, stride) = make_bitmap(pw, ph, scale);
        let horizontal = side < 2;
        let along = if horizontal { sw } else { sh };
        let colors: Vec<(f32, f32, f32)> = (0..along)
            .map(|i| {
                let (lx, ly) = if horizontal {
                    (i as f32, y as f32 + if side == 0 { 0.0 } else { t as f32 })
                } else {
                    (
                        x as f32 + if side == 2 { 0.0 } else { t as f32 },
                        (y + i) as f32,
                    )
                };
                color_at(lx, ly)
            })
            .collect();
        for row in 0..sh {
            let line = data.add(row as usize * stride);
            for col in 0..sw {
                let dist = match side {
                    0 => row,
                    1 => sh - 1 - row,
                    2 => col,
                    _ => sw - 1 - col,
                };
                let mut a = profile[(dist as usize).min(profile.len() - 1)];
                if horizontal {
                    let side_d = col.min(sw - 1 - col);
                    if side_d < t {
                        a = a.max(profile[side_d as usize]);
                    }
                }
                let c = colors[if horizontal { col } else { row } as usize];
                let p = line.add(col as usize * 4);
                *p = (c.0 * a) as u8;
                *p.add(1) = (c.1 * a) as u8;
                *p.add(2) = (c.2 * a) as u8;
                *p.add(3) = (a * 255.0) as u8;
            }
        }
        let img = image_from_rep(rep, pw, ph);
        // 屏幕左上原点 → AppKit 左下原点。
        let fx = sf.frame.origin.x + x as f64 / scale;
        let fy = sf.frame.origin.y + sf.frame.size.h - (y as f64 / scale) - ph;
        present(*win, img, rect(fx, fy, pw, ph), first_show);
    }
}

impl OverlayLoop {
    /// 主线程主体，永不返回（除非给了 `deadline`，demo 用）。任何一步失败只打一行 stderr。
    pub fn run(self, deadline: Option<Instant>) {
        unsafe { self.run_inner(deadline) }
    }

    unsafe fn run_inner(self, deadline: Option<Instant>) {
        let app: Id = msg_send![class!(NSApplication), sharedApplication];
        let _: BOOL = msg_send![app, setActivationPolicy: ACTIVATION_POLICY_ACCESSORY];
        let _: () = msg_send![app, finishLaunching];
        let _tap = install_hotkey(self.hot_tx.clone());

        let bar = make_window();
        let mut screens: Vec<ScreenFrame> = Vec::new();
        let epoch = Instant::now();
        let mut face: Option<Face> = None;
        let mut status: Option<String> = None;
        let mut anim: Option<(Instant, bool)> = None;
        let mut stopped_until: Option<Instant> = None;
        let mut bar_shown = false;

        loop {
            // 泵 run loop：热键 tap 的回调、窗口服务器的回执都从这里走。
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, TICK.as_secs_f64(), true);
            if deadline.is_some_and(|d| Instant::now() >= d) {
                return;
            }
            loop {
                match self.cmd_rx.try_recv() {
                    Ok(OverlayCmd::Show) => {
                        stopped_until = None;
                        if face.is_none() {
                            anim = Some((Instant::now(), true));
                        }
                        face = Some(Face::active(status.as_deref()));
                    }
                    Ok(OverlayCmd::Status(text)) => {
                        status = text;
                        if face.as_ref().is_some_and(|f| f.active) {
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
                    Err(TryRecvError::Disconnected) => return,
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
            let progress = match anim {
                Some((start, entering)) => {
                    let p = (start.elapsed().as_secs_f32() * 1000.0 / ANIM_MS).clamp(0.0, 1.0);
                    if p >= 1.0 {
                        anim = None;
                        if !entering {
                            let _: () = msg_send![bar, orderOut: std::ptr::null::<Object>()];
                            bar_shown = false;
                            for s in screens.iter_mut() {
                                for w in s.wins {
                                    let _: () = msg_send![w, orderOut: std::ptr::null::<Object>()];
                                }
                                s.last = None;
                            }
                            face = None;
                        }
                    }
                    if entering {
                        p
                    } else {
                        1.0 - p
                    }
                }
                None => {
                    if face.is_some() {
                        1.0
                    } else {
                        0.0
                    }
                }
            };

            let Some(f) = face.as_ref() else { continue };
            let eased = 1.0 - (1.0 - progress.clamp(0.0, 1.0)).powi(3);

            // 四边：每块屏一组。屏幕布局变了整组重建。
            sync_screens(&mut screens);
            let phase = if f.active {
                ((epoch.elapsed().as_secs_f32() / FRAME_CYCLE_S).fract() * FRAME_STEPS as f32)
                    as u32
            } else {
                0
            };
            for s in screens.iter_mut() {
                paint_frame(s, f.active, eased, phase);
            }

            // 条子：主屏（有键窗口的那块）visibleFrame 顶部居中。
            let main: Id = msg_send![class!(NSScreen), mainScreen];
            if main.is_null() {
                continue;
            }
            let vis: NSRect = msg_send![main, visibleFrame];
            let scale: f64 = msg_send![main, backingScaleFactor];
            let max_bar_w = (vis.size.w - 80.0).max(220.0);
            let (img, w, h) = paint_bar(f, scale, max_bar_w, eased as f64);
            let x = vis.origin.x + (vis.size.w - w) / 2.0;
            let top = vis.origin.y + vis.size.h - BAR_TOP_MARGIN
                + SHADOW_PAD
                + SLIDE_PX * (1.0 - eased as f64);
            present(
                bar,
                img,
                rect(x.round(), (top - h).round(), w, h),
                !bar_shown,
            );
            bar_shown = true;
        }
    }
}

/// 枚举 NSScreen；和上次不一样就把四条窗口整组重建。
unsafe fn sync_screens(screens: &mut Vec<ScreenFrame>) {
    let arr: Id = msg_send![class!(NSScreen), screens];
    let n: u64 = msg_send![arr, count];
    let mut found: Vec<(NSRect, f64)> = Vec::new();
    for i in 0..n {
        let s: Id = msg_send![arr, objectAtIndex: i];
        let fr: NSRect = msg_send![s, frame];
        let sc: f64 = msg_send![s, backingScaleFactor];
        found.push((fr, sc));
    }
    let same = found.len() == screens.len()
        && found.iter().zip(screens.iter()).all(|((fr, sc), s)| {
            fr.origin.x == s.frame.origin.x
                && fr.origin.y == s.frame.origin.y
                && fr.size.w == s.frame.size.w
                && fr.size.h == s.frame.size.h
                && *sc == s.scale
        });
    if same {
        return;
    }
    for s in screens.iter() {
        for w in s.wins {
            let _: () = msg_send![w, orderOut: std::ptr::null::<Object>()];
            let _: () = msg_send![w, close];
        }
    }
    *screens = found
        .into_iter()
        .map(|(frame, scale)| ScreenFrame {
            frame,
            scale,
            wins: [make_window(), make_window(), make_window(), make_window()],
            last: None,
        })
        .collect();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_pieces_compose_the_hint_sentence() {
        assert_eq!(
            format!("{} {} {}", HINT_PREFIX, HINT_KEYS.join("+"), HINT_SUFFIX),
            HINT_ACTIVE
        );
    }
}
