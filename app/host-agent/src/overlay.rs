//! 接管指示条的**策略层**——平台无关、没有任何 IO，所以在没有 Windows 的机器上也能单测。
//! 画窗口那一半在 `overlay_win.rs`（`#[cfg(windows)]`）。
//!
//! 这里回答两个问题：**哪些 op 算"正在接管电脑"**，以及**什么时候点亮、什么时候熄灭**。
//! 判定放在 agent 侧而不是后端：后端崩了、WS 断了，条子也必须能自己灭掉。

/// 会真的往屏幕上发键鼠输入、或把窗口拽到前台的 op —— 这一列亮条子。
/// 和 `protocol.rs` 里过 `guard_actuation` 的那几个（坐标输入）+ `focusApp`（夺前台）同一条线。
pub const LIGHTS_UP: &[&str] = &["focusApp", "click", "moveMouse", "scroll", "type", "press", "clearInput"];

/// 不亮的那一列。`ensureApp`/`invoke`/`setValue` 确实会改变应用状态，但它们**不动指针、不夺焦**
/// （后两个的收件人是元素句柄，锁屏都照常生效），和用户不构成抢夺关系。采集链路日常就在调
/// 这几个，算进来的话条子一天到晚闪，两天后就没人看它了——这个信号必须只有一个含义：
/// **亮 = 你现在别碰鼠标**。
/// `nudge` 归这一列：它确实是一次**真实**输入（`SendInput`），但位移是 0——**不动指针、
/// 不夺焦、不点任何东西**，正好落在上面那句判据里。它的用途只是把挂起的渲染端叫醒，
/// 每轮开头一次；算进 LIGHTS_UP 的话，条子会在"什么都还没做"的时候先亮一下。
/// `status` 也归这一列：它只是往条子上**写一句话**（"现在在做第几步"），不动键鼠。后端每一步
/// 开头都发它，若它能点亮，条子就会在一趟全走 invoke 的 recipe 里亮一整轮——那正是上面那句
/// 判据要禁的。它写的文字由 `OverlayPolicy` 记着，条子真亮起来时才带出去。
pub const QUIET: &[&str] = &[
    "windows", "scopeWindow", "ensureApp", "find", "invoke", "setValue",
    "readSubtree", "screenshot", "findImage", "readText", "readElements", "url", "sleep", "nudge",
    "status",
];

/// 这个 op 算不算"正在接管电脑"。逐个枚举、不按模式放行——认不出的 op 一律当不接管，
/// 由 `every_known_op_has_an_explicit_verdict` 保证不会有认不出的。
pub fn touches_screen(op: &str) -> bool {
    LIGHTS_UP.contains(&op)
}

use std::time::{Duration, Instant};

/// 空闲多久之后熄灭。防抖用：两个动作 op 之间天然有几百毫秒的间隙（要 find、要等 settle），
/// 没有这个窗口，一趟 recipe 会把条子闪成频闪灯。
pub const LINGER: Duration = Duration::from_millis(1500);

/// 一趟 recipe 在跑（后端写着任务文字）时，条子**不按 LINGER 熄**：一趟里动作步和读屏步交错，
/// 读一次屏就是一两秒，按 1.5s 熄的话条子在「打正文 → 回车」之间灭了再亮，人看到的是
/// "说要操作、框没了、隔几秒又说要操作"（活体 2026-09-13）。而在这段间隙里键盘焦点、前台窗口
/// 都还是 recipe 的，人碰一下下一步就点错——"别碰"这个信号在整趟里一直成立。
/// 这一条是它的兜底：任务文字挂着、却这么久没有一个动作，后端多半是卡死了（WS 还活着、
/// finally 没跑到）；条子亮着不撒谎的前提是有人在动，没人动就熄。正常 recipe 里最长的
/// 一次读屏也就几秒，远够不到它。
pub const STATUS_STALL: Duration = Duration::from_secs(120);

/// 后端发来的任务文字怎么落到条子的两行：`第一行\n第二行`，按**第一个**换行拆。
/// 没有换行的老文本（别的调用方）只占第一行；`None` 两行都空——条子只剩热键说明。
/// 空行不占位（一行空白读起来像掉了字），再多的换行并进第二行而不是丢掉。
/// 放在这一层而不是 `overlay_win.rs`：那份只在 Windows 编，在开发机上跑不到它的测试。
pub fn split_status(text: Option<&str>) -> (Option<String>, Option<String>) {
    let line = |s: &str| {
        let s = s.trim();
        if s.is_empty() { None } else { Some(s.to_string()) }
    };
    match text {
        None => (None, None),
        Some(t) => match t.split_once('\n') {
            Some((second, third)) => (line(second), line(&third.replace('\n', " "))),
            None => (line(t), None),
        },
    }
}

/// 策略吐给渲染层的指令。**只在状态真的变化时吐**——渲染层收到什么就照做，不需要自己去重。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayCmd {
    /// 亮起：四边七彩内阴影 + 条子（任务文字 + "按 Ctrl+Alt+Esc 停止"）
    Show,
    /// 收起
    Hide,
    /// 换成"已停止"（热键按下），由渲染层停留 `STOPPED_LINGER` 后自行收起
    Stopped,
    /// 换条子两行的任务文字（`微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)`，
    /// 拆法见 `split_status`）；`None` = 清掉。
    /// **和亮灭无关**：收着的时候也照记，下一次 Show 直接带上——文字先于第一个动作到
    /// （每步开头就发），而条子要到第一个动作才亮；卡死兜底熄掉之后再动也还是同一趟。
    Status(Option<String>),
}

/// 条子该不该亮的状态机。没有 IO、没有时钟——`now` 一律由调用方传进来，所以可测。
pub struct OverlayPolicy {
    visible: bool,
    /// 最近一次**动作** op 的时刻（读不算）。`None` = 没亮着。
    last_action: Option<Instant>,
    /// 后端最近一次 `status` 写下的任务文字。归属见 `OverlayCmd::Status`。
    status: Option<String>,
}

impl Default for OverlayPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl OverlayPolicy {
    pub fn new() -> Self {
        Self { visible: false, last_action: None, status: None }
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    /// 后端发来 `status`。同一句话重复发不吐指令（每一步开头都会发，重绘一次是白费）；
    /// 变了就吐，**不管亮没亮**——渲染层要在下一次 Show 时拿得到它。
    pub fn on_status(&mut self, text: Option<String>) -> Option<OverlayCmd> {
        if self.status == text {
            return None;
        }
        self.status = text.clone();
        Some(OverlayCmd::Status(text))
    }

    /// 会话收尾共用的那一下：文字若在场就清掉（并让渲染层也忘掉它）。下一个会话是另一趟，
    /// 带着上一趟的"第 8 步"亮起来就是撒谎。
    fn clear_status(&mut self) -> Option<OverlayCmd> {
        self.status.take().map(|_| OverlayCmd::Status(None))
    }

    /// 一个 op 要执行了。返回 `Some(cmd)` 只在状态变化那一刻。
    pub fn on_op(&mut self, op: &str, now: Instant) -> Option<OverlayCmd> {
        if !touches_screen(op) {
            return None;
        }
        self.last_action = Some(now);
        if self.visible {
            return None; // 整趟不闪
        }
        self.visible = true;
        Some(OverlayCmd::Show)
    }

    /// 定时喂进来的心跳：够安静了就熄。"够安静"分两档：没有任务文字（零散的 op，比如
    /// 对话里直接 `cdp_act`）按 `LINGER`；任务文字挂着（一趟 recipe 在跑）按 `STATUS_STALL`
    /// ——后端跑完会清掉文字（runner 的 finally），清掉之后下一次心跳就按 LINGER 熄。
    pub fn tick(&mut self, now: Instant) -> Option<OverlayCmd> {
        let last = self.last_action?;
        let quiet_for = if self.status.is_some() { STATUS_STALL } else { LINGER };
        if !self.visible || now.duration_since(last) <= quiet_for {
            return None;
        }
        self.visible = false;
        self.last_action = None;
        Some(OverlayCmd::Hide)
    }

    /// 热键按下。没亮着就不发 Stopped——凭空冒出一个"已停止"会让人以为刚才发生过什么。
    /// 任务文字则不论亮没亮都清：后端收到 abort 会把整趟 unwind，那句"第 8 步"已经不成立。
    /// 回一串而不是一条，因为这里可能同时有两件事要告诉渲染层（清字 + 变脸）。
    pub fn on_abort(&mut self) -> Vec<OverlayCmd> {
        let mut out: Vec<OverlayCmd> = self.clear_status().into_iter().collect();
        if self.visible {
            self.visible = false;
            self.last_action = None;
            out.push(OverlayCmd::Stopped);
        }
        out
    }

    /// WS 会话结束（断连 / 重连前）。立刻熄，不等 LINGER：后端都不在了，还亮着就是撒谎。
    /// 任务文字同理一起清。
    pub fn on_session_end(&mut self) -> Vec<OverlayCmd> {
        let mut out: Vec<OverlayCmd> = self.clear_status().into_iter().collect();
        if self.visible {
            self.visible = false;
            self.last_action = None;
            out.push(OverlayCmd::Hide);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    /// 会往屏幕上发键鼠输入 / 夺前台的那几个 op —— 这一列亮条子。
    #[test]
    fn screen_touching_ops_are_exactly_the_actuation_set() {
        for op in ["focusApp", "click", "moveMouse", "scroll", "type"] {
            assert!(touches_screen(op), "{op} 该亮条子");
        }
    }

    /// 读、以及"不动指针也不夺焦"的那几个（invoke/setValue 的收件人是元素句柄，
    /// ensureApp 只让进程活着）——一律不亮。采集链路日常就在调它们，亮了就是噪音。
    #[test]
    fn reads_and_handle_addressed_ops_never_light_it_up() {
        for op in [
            "windows", "scopeWindow", "find", "readSubtree", "screenshot", "url", "sleep",
            "ensureApp", "invoke", "setValue",
        ] {
            assert!(!touches_screen(op), "{op} 不该亮条子");
        }
    }

    /// 第一个坐标 op 点亮；同一趟里后续 op 不再重复发 Show（重复 Show 会让窗口闪）。
    #[test]
    fn the_first_actuation_lights_it_and_the_rest_do_not_reshow() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        assert_eq!(p.on_op("find", t), None, "读不亮");
        assert_eq!(p.on_op("click", t), Some(OverlayCmd::Show));
        assert_eq!(p.on_op("type", t + Duration::from_millis(50)), None, "整趟不闪");
        assert!(p.visible());
    }

    /// 空闲超过 LINGER 才熄——不到点不熄，否则两个 op 之间的正常间隙就会闪一下。
    #[test]
    fn it_hides_only_after_linger_of_silence() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_op("click", t);
        assert_eq!(p.tick(t + LINGER - Duration::from_millis(1)), None, "还没到点不许熄");
        assert_eq!(p.tick(t + LINGER + Duration::from_millis(1)), Some(OverlayCmd::Hide));
        assert!(!p.visible());
        assert_eq!(p.tick(t + LINGER * 3), None, "熄过之后不重复发 Hide");
    }

    /// 期间又来了一个动作 op → 重新计时，不该在旧的截止点熄掉。
    #[test]
    fn a_later_action_pushes_the_deadline_out() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_op("click", t);
        p.on_op("scroll", t + Duration::from_millis(1000));
        assert_eq!(p.tick(t + LINGER + Duration::from_millis(1)), None, "被后一个动作续上了");
        assert_eq!(
            p.tick(t + Duration::from_millis(1000) + LINGER + Duration::from_millis(1)),
            Some(OverlayCmd::Hide)
        );
    }

    /// 读 op 不续命：条子只表达"正在动你的鼠标键盘"，读不该把它撑着。
    #[test]
    fn reads_do_not_extend_the_deadline() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_op("click", t);
        p.on_op("readSubtree", t + Duration::from_millis(1000));
        assert_eq!(p.tick(t + LINGER + Duration::from_millis(1)), Some(OverlayCmd::Hide));
    }

    /// WS 会话断了 → 立刻熄，不等 LINGER。后端都没了，条子亮着就是撒谎。
    #[test]
    fn losing_the_session_hides_it_immediately() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_op("click", t);
        assert_eq!(p.on_session_end(), vec![OverlayCmd::Hide]);
        assert_eq!(p.on_session_end(), vec![], "已经熄了就不重复");
    }

    /// 热键中止 → 先变成"已停止"，由调用方定时收尾；没亮着的时候按热键什么都不发生。
    #[test]
    fn the_hotkey_switches_it_to_stopped_only_when_it_was_visible() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        assert_eq!(p.on_abort(), vec![], "没在接管的时候按热键，不该凭空冒出一个条子");
        p.on_op("click", t);
        assert_eq!(p.on_abort(), vec![OverlayCmd::Stopped]);
    }

    // ── 任务文字（`status` op）────────────────────────────────────────────────

    /// `status` 归 QUIET：它只写字，**绝不点亮**。后端每一步开头都发它，能点亮的话一趟全走
    /// invoke 的 recipe 也会亮一整轮。
    #[test]
    fn status_writes_text_but_never_lights_the_bar() {
        assert!(QUIET.contains(&"status"));
        assert!(!touches_screen("status"));
        let mut p = OverlayPolicy::new();
        assert_eq!(p.on_op("status", t0()), None);
        let text = "微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)";
        assert_eq!(p.on_status(Some(text.into())), Some(OverlayCmd::Status(Some(text.into()))));
        assert!(!p.visible(), "写字不算接管");
        assert_eq!(p.status(), Some(text));
    }

    /// 同一句话重复发不吐指令；变了才吐——收着的时候也照吐，渲染层要在下一次 Show 拿得到。
    #[test]
    fn status_emits_only_on_change_regardless_of_visibility() {
        let mut p = OverlayPolicy::new();
        assert!(p.on_status(Some("a".into())).is_some());
        assert_eq!(p.on_status(Some("a".into())), None, "同一句话不重发");
        assert_eq!(p.on_status(Some("b".into())), Some(OverlayCmd::Status(Some("b".into()))));
        assert_eq!(p.on_status(None), Some(OverlayCmd::Status(None)));
        assert_eq!(p.on_status(None), None, "已经空了就不重复清");
    }

    /// 任务文字挂着 = 一趟 recipe 在跑：读屏那几秒**不熄**（活体 2026-09-13：「打正文 → 回车」
    /// 之间 3.5s 全是读屏，按 LINGER 熄就成了"框没了、隔几秒又说要操作"）。后端清掉文字之后
    /// 才按 LINGER 熄——清字那一下不直接 Hide，交给下一次心跳，路径只有一条。
    #[test]
    fn a_running_recipe_keeps_it_lit_through_long_reads_until_the_status_is_cleared() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_status(Some("微信发消息 · 发给 文件传输助手\n打正文 (13/15)".into()));
        p.on_op("type", t);
        p.on_op("readText", t + Duration::from_millis(500));
        assert_eq!(p.tick(t + LINGER + Duration::from_millis(1)), None, "recipe 还在跑，读屏不算安静");
        assert_eq!(p.tick(t + Duration::from_secs(10)), None, "十秒的读屏 / 等界面照样不熄");
        assert!(p.visible());
        // 后端跑完：清字 → 下一次心跳按 LINGER 熄（最后一个动作早过了 1.5s）。
        assert_eq!(p.on_status(None), Some(OverlayCmd::Status(None)));
        assert_eq!(p.tick(t + Duration::from_secs(10) + Duration::from_millis(10)), Some(OverlayCmd::Hide));
        assert!(!p.visible());
    }

    /// 兜底：文字挂着、却 `STATUS_STALL` 这么久一个动作都没有 → 熄。后端卡死（WS 活着、
    /// finally 没跑到）时条子不能永远亮着；而 Hide **不清**文字——那是会话收尾的事。
    #[test]
    fn a_stalled_recipe_hides_after_status_stall_but_keeps_the_text() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_status(Some("step 3".into()));
        p.on_op("click", t);
        assert_eq!(p.tick(t + STATUS_STALL - Duration::from_millis(1)), None);
        assert_eq!(p.tick(t + STATUS_STALL + Duration::from_millis(1)), Some(OverlayCmd::Hide));
        assert_eq!(p.status(), Some("step 3"), "Hide 不该把任务文字带走");
        assert_eq!(p.on_status(Some("step 3".into())), None, "渲染层还记着，不用重发");
    }

    /// 会话结束 / 热键中止都要把文字清掉，并且**告诉渲染层**（发 `Status(None)`）——
    /// 下一个会话带着上一趟的"第 8 步"亮起来就是撒谎。文字没在场时不多发那一条。
    #[test]
    fn session_end_and_abort_clear_the_status_and_tell_the_renderer() {
        let mut p = OverlayPolicy::new();
        let t = t0();
        p.on_status(Some("step 3".into()));
        p.on_op("click", t);
        assert_eq!(p.on_session_end(), vec![OverlayCmd::Status(None), OverlayCmd::Hide]);
        assert_eq!(p.status(), None);

        let mut p = OverlayPolicy::new();
        p.on_status(Some("step 3".into()));
        p.on_op("click", t);
        assert_eq!(p.on_abort(), vec![OverlayCmd::Status(None), OverlayCmd::Stopped]);

        // 没亮着、但文字在场：只清字，不凭空 Stopped。
        let mut p = OverlayPolicy::new();
        p.on_status(Some("step 3".into()));
        assert_eq!(p.on_abort(), vec![OverlayCmd::Status(None)]);
    }

    // ── 任务文字怎么拆成两行 ──────────────────────────────────────────

    /// 后端发来的是 `第一行\n第二行`：按第一个换行拆成两行。
    #[test]
    fn split_status_breaks_two_line_text_at_the_newline() {
        assert_eq!(
            split_status(Some("微信发消息 · 发给 文件传输助手\n点候选里的他 (8/12)")),
            (Some("微信发消息 · 发给 文件传输助手".into()), Some("点候选里的他 (8/12)".into()))
        );
    }

    /// 没有换行的老文本（别的调用方）只占第一行，第二行空着。
    #[test]
    fn split_status_keeps_legacy_single_line_text_on_line_two_only() {
        assert_eq!(
            split_status(Some("wechat-send · 点候选里的他 (8/12)")),
            (Some("wechat-send · 点候选里的他 (8/12)".into()), None)
        );
    }

    /// 没有任务文字就两行都空——条子只剩第一行。
    #[test]
    fn split_status_of_none_is_empty() {
        assert_eq!(split_status(None), (None, None));
    }

    /// 空行不占位（`"\n第二行"` 不该画出一行空白），多余的换行并进第二行而不是丢掉。
    #[test]
    fn split_status_drops_blank_lines_and_folds_extra_newlines_into_line_three() {
        assert_eq!(split_status(Some("")), (None, None));
        assert_eq!(split_status(Some("\n第三行")), (None, Some("第三行".into())));
        assert_eq!(split_status(Some("第二行\n  ")), (Some("第二行".into()), None));
        assert_eq!(split_status(Some("a\nb\nc")), (Some("a".into()), Some("b c".into())));
    }

    /// 加了新 op 忘了归类 —— 这条会红。名单和 `dispatch` 的 match 同吃 `OP_NAMES`。
    #[test]
    fn every_known_op_has_an_explicit_verdict() {
        for op in crate::protocol::OP_NAMES {
            assert!(
                LIGHTS_UP.contains(op) || QUIET.contains(op),
                "op `{op}` 在 overlay 这里没有归属：它到底算不算接管？加进 LIGHTS_UP 或 QUIET，别让它默默走 false"
            );
        }
        assert_eq!(
            LIGHTS_UP.len() + QUIET.len(),
            crate::protocol::OP_NAMES.len(),
            "两张名单加起来必须正好是 dispatch 认得的全集（多出来的是拼错的 op 名）"
        );
    }
}
