//! 重连策略 —— 「agent 的生命周期不跟着一条 WebSocket 走」。
//!
//! **为什么必须有它**：agent 是被**养它的那个 node 进程**（Stream 后端自己，
//! `src/host-agent/mount.ts`）spawn 一次的常驻 sidecar，那一侧只在启动时拉它一次。
//! 早先的实现里 `connect_async` 只调一次、失败就 `exit(1)`，会话循环一结束进程就退——于是
//! 后端每 `docker restart` 一次，agent 的 WS 断掉、进程退出，**再也没人拉起它**。活体撞到过：
//! 连续几次后端重启之后 hostRelay 永久 disconnected，Chrome 关着时整条「host-agent 唤起
//! Chrome」的链路瘫痪，采集只能跳过。后端重启是开发期的日常，agent 必须自己熬过去。
//!
//! 退避语义照抄扩展侧（`extension/src/lib/driver.ts` 的 WS 重连）：起步 1s、每次翻倍、
//! 上限 30s、**连上即复位**。两端一致，排错时不用记两套数。
//!
//! 这里只有纯策略（"这次结束之后等多久"），没有任何 IO，所以在没有后端的机器上也能单测。

use std::time::Duration;

/// 一次会话是怎么结束的。**注意它是"返回值"不是"退出码"**：每一条都回到监督循环，
/// 没有任何一条会终结进程。
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEnd {
    /// 连都没连上（后端没起来 / 端口不通 / 网关在重启）。
    ConnectFailed(String),
    /// 握手被拒（401/403）——中继认为 token 不对。
    ///
    /// **为什么它也重试**：token 是后端首启生成后**持久化**的（`src/http/ext-token.ts`，
    /// 落在 data 目录、重启稳定），所以后端重启途中的 401 多半只是"还没起完"，退避重试
    /// 就会自愈。真的是 token 变了（data 目录被清掉重新生成）我们也无能为力——agent 的
    /// token 来自启动时的环境变量，进程内拿不到新的，只有壳重启才换得掉。那种情况下
    /// 重试也不伤人（上限 30s 一次），但日志必须把这个可能性说出来，否则排错的人会
    /// 盯着一条"连不上"看半天。
    Rejected(String),
    /// 连上过、跑过一会儿，然后断了（后端重启、网络抖动、对端主动关）。
    Disconnected,
    /// 配对设备的 token 被主实例作废了：握手 401，或连接被以 4003 关闭（`host-relay.ts` 的
    /// `attachHostRelay`；后端内部故障回的是 503 / 1011，不会落到这里）。**不重试**——拿同一个
    /// token 再连一万次也还是 401；监督循环在这里返回，交给设备模式去作废保存的配对、重新配对。
    Revoked(String),
    /// 配对设备的握手被拒，但不是撤销（403 等）。和 `Rejected` 一样退避重试，只是日志要说对：
    /// 设备模式的 token 来自配对、不来自环境变量，也没有"工作台"可重启——该看的是主实例那边。
    DeviceRefused(String),
}

impl SessionEnd {
    /// 这次会话到底连上过没有。连上过 = 目标是活的，退避该复位。
    fn was_connected(&self) -> bool {
        matches!(self, SessionEnd::Disconnected)
    }

    /// 日志里的一句人话。
    pub fn reason(&self) -> String {
        match self {
            SessionEnd::ConnectFailed(e) => format!("connect failed: {e}"),
            SessionEnd::DeviceRefused(e) => format!(
                "主实例拒绝了这台设备的连接（{e}）——不是撤销，保存的配对不动、照常重试；\
                 到主实例上看日志和设备列表，确认这台设备还在、主实例接受它"
            ),
            SessionEnd::Rejected(e) => format!(
                "relay rejected the handshake ({e}) — token 可能已失效（后端 data 目录被重建过？），\
                 agent 的 token 只在启动时从环境变量读一次，换 token 需要重启工作台"
            ),
            SessionEnd::Disconnected => "disconnected".to_string(),
            SessionEnd::Revoked(e) => format!(
                "主实例撤销了这台设备（{e}）——保存的配对作废，需要在主实例上生成新配对码，设进 STREAM_PAIRING_CODE 后重启"
            ),
        }
    }
}

/// 墙钟跳变：两次采样之间前进得比 `limit` 还多。进程被冻住过（虚拟机挂起、合盖、SIGSTOP）
/// 就是这个样子——醒来时定时器补跑，而 socket 多半已经半开（服务端可能早判死了，FIN 还没到）。
/// 判据是纯函数，单测不用真把进程冻住。时钟往回走（NTP 校时）不算跳变。
pub fn wall_jump(last: std::time::SystemTime, now: std::time::SystemTime, limit: Duration) -> bool {
    now.duration_since(last).is_ok_and(|d| d > limit)
}

/// 墙钟一次前进这么多就当作「被冻住过」。正常运行时 20ms 的心跳不可能间隔这么久；
/// 真被冻住（沙箱挂起按分钟算）时它一定命中。
pub const WALL_JUMP_LIMIT: Duration = Duration::from_secs(5);

/// 起步 250ms：后端 `docker restart` 一般几秒内就回来，第一次重试快一点能少丢一轮采集。
/// 醒来重连也走这条路——挂起恢复时每多等 1s 都是界面上多转一秒的圈（与 cdp-bind 同值）。
pub const BACKOFF_BASE: Duration = Duration::from_millis(250);
/// 上限 30s：后端长时间不在（用户根本没起）时不要空转刷日志，30s 一次足够快地自愈。
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// 监督循环的状态：只有"下次等多久"和"已经排过多少次重连"。
pub struct Supervisor {
    base: Duration,
    max: Duration,
    current: Duration,
    scheduled: u32,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::with(BACKOFF_BASE, BACKOFF_MAX)
    }
}

impl Supervisor {
    /// 自定义步长——给测试用，免得单测真的睡 1s 起步的那串退避。
    pub fn with(base: Duration, max: Duration) -> Self {
        Self { base, max, current: base, scheduled: 0 }
    }

    /// 至今排过几次重连。日志和测试用（"它到底有没有在重试"）。
    pub fn scheduled(&self) -> u32 {
        self.scheduled
    }

    /// 一次会话结束后：下一次连接前该等多久。
    ///
    /// 连上过就先把退避复位（对端是活的，没有理由继续拉长间隔），再照常返回当前值并翻倍——
    /// 与 ext-cdp 的 open→`backoff = 1000` / close→`setTimeout(backoff)` 后翻倍完全同构。
    pub fn after(&mut self, end: &SessionEnd) -> Duration {
        if end.was_connected() {
            self.current = self.base;
        }
        let delay = self.current;
        self.current = std::cmp::min(self.current * 2, self.max);
        self.scheduled += 1;
        delay
    }
}

/// The `hello` the v2 relay requires as the first frame: which device this is and which ops it
/// implements. The backend decides "unsupported" from `ops` before sending anything, so this list
/// must be what `dispatch` actually handles.
pub fn hello_frame(device_id: &str, platform: &str, name: &str, version: &str, ops: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "type": "hello",
        "deviceId": device_id,
        "platform": platform,
        "name": name,
        "agentVersion": version,
        "ops": ops,
    })
}

/// The ops this build can actually perform: every dispatched op, minus those a platform lacks
/// (`nudge` is only implemented on Windows; elsewhere the trait default returns an error).
pub fn declared_ops() -> Vec<&'static str> {
    crate::protocol::OP_NAMES
        .iter()
        .copied()
        .filter(|op| !(cfg!(not(windows)) && *op == "nudge"))
        .collect()
}

/// This machine's hello. The device id is the host name, so it is stable across agent restarts and
/// a reconnect is recognised as the same device (its session lease carries over).
pub fn local_hello() -> serde_json::Value {
    let host = sysinfo::System::host_name()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        _ => "windows",
    };
    hello_frame(
        &format!("desktop:{}", host.to_lowercase()),
        platform,
        &host,
        env!("CARGO_PKG_VERSION"),
        &declared_ops(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// 墙钟跳变：进程被冻住过才判真；正常 20ms 的节拍、时钟往回校都不算。
    #[test]
    fn wall_clock_jump_is_detected_only_when_time_leapt_forward() {
        let t0 = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let after = |secs: u64| t0 + Duration::from_secs(secs);
        assert!(wall_jump(t0, after(10), WALL_JUMP_LIMIT), "冻住 10s 要判出来");
        assert!(!wall_jump(t0, after(1), WALL_JUMP_LIMIT), "正常的 20ms 节拍不能误判");
        assert!(!wall_jump(after(10), t0, WALL_JUMP_LIMIT), "时钟往回走（校时）不算跳变");
    }

    /// 连不上要按 1→2→4…翻倍，且封顶——否则后端长时间不在时要么空转刷屏，要么等到天荒地老。
    #[test]
    fn connect_failures_back_off_exponentially_up_to_the_cap() {
        let mut s = Supervisor::with(ms(100), ms(800));
        let fail = SessionEnd::ConnectFailed("refused".into());
        let seq: Vec<u64> = (0..6).map(|_| s.after(&fail).as_millis() as u64).collect();
        assert_eq!(seq, vec![100, 200, 400, 800, 800, 800]);
        assert_eq!(s.scheduled(), 6, "每一次都排了重连，一次都没有放弃");
    }

    /// 连上过再断 = 对端是活的，退避必须复位；否则后端重启几次之后，下一次重连要等半分钟，
    /// 而这半分钟里的采集全部落空。
    #[test]
    fn a_successful_session_resets_the_backoff() {
        let mut s = Supervisor::with(ms(100), ms(800));
        let fail = SessionEnd::ConnectFailed("refused".into());
        for _ in 0..4 {
            s.after(&fail);
        }
        assert_eq!(s.after(&SessionEnd::Disconnected), ms(100), "连上过就该回到起步值");
        assert_eq!(s.after(&fail), ms(200), "复位之后照常重新翻倍");
    }

    /// 401 不是死刑：后端重启途中先起 HTTP 再挂中继，这半秒里的握手会被拒。它和连不上走
    /// 同一条退避，只是日志要把"token 可能真的变了"说出来。
    #[test]
    fn a_rejected_handshake_still_retries() {
        let mut s = Supervisor::with(ms(100), ms(800));
        let rejected = SessionEnd::Rejected("401".into());
        assert_eq!(s.after(&rejected), ms(100));
        assert_eq!(s.after(&rejected), ms(200));
        assert!(rejected.reason().contains("重启工作台"), "日志要给出可操作的下一步");
    }

    /// 撤销不是"连不上"：监督循环据此停下来交给设备模式去重新配对，日志要说出下一步。
    #[test]
    fn a_revoked_session_says_what_to_do() {
        let r = SessionEnd::Revoked("HTTP 401".into());
        assert!(r.reason().contains("撤销"));
        assert!(r.reason().contains("STREAM_PAIRING_CODE"));
    }

    /// 设备模式下握手被拒：token 不是环境变量给的、也没有"工作台"可重启——要说主实例那边的事。
    #[test]
    fn a_refused_device_says_to_look_at_the_main_instance() {
        let r = SessionEnd::DeviceRefused("HTTP 403".into());
        assert!(r.reason().contains("主实例拒绝了这台设备的连接"), "{}", r.reason());
        assert!(r.reason().contains("设备列表") && r.reason().contains("日志"), "{}", r.reason());
        assert!(!r.reason().contains("工作台"), "{}", r.reason());
        let mut s = Supervisor::with(ms(100), ms(800));
        assert_eq!(s.after(&r), ms(100));
        assert_eq!(s.after(&r), ms(200), "照常退避重试，不复位");
    }

    /// 生产默认值就是扩展侧那套（1s 起、30s 封顶）——两端一致，排错不用记两套数。
    #[test]
    fn production_defaults_match_the_extension_side() {
        let mut s = Supervisor::default();
        assert_eq!(s.after(&SessionEnd::ConnectFailed("x".into())), Duration::from_secs(1));
        for _ in 0..10 {
            s.after(&SessionEnd::ConnectFailed("x".into()));
        }
        assert_eq!(s.after(&SessionEnd::ConnectFailed("x".into())), Duration::from_secs(30));
    }

    /// The hello is the backend's only source for "which device is this and what can it do". Field
    /// names cross a process boundary with no compiler checking them, so they are pinned here.
    #[test]
    fn hello_frame_has_the_wire_shape_the_backend_parses() {
        let v = hello_frame("desktop:pc", "windows", "PC", "0.1.0", &["click", "find"]);
        assert_eq!(v["type"], "hello");
        assert_eq!(v["deviceId"], "desktop:pc");
        assert_eq!(v["platform"], "windows");
        assert_eq!(v["name"], "PC");
        assert_eq!(v["agentVersion"], "0.1.0");
        assert_eq!(v["ops"], serde_json::json!(["click", "find"]));
    }

    /// The local hello declares every op this binary dispatches, under a stable device id.
    #[test]
    fn local_hello_declares_all_ops_and_a_desktop_id() {
        let v = local_hello();
        let ops: Vec<String> = v["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_str().unwrap().to_string())
            .collect();
        assert_eq!(ops, declared_ops());
        assert!(ops.iter().all(|o| crate::protocol::OP_NAMES.contains(&o.as_str())));
        if cfg!(windows) {
            assert_eq!(ops.len(), crate::protocol::OP_NAMES.len());
        }
        assert!(v["deviceId"].as_str().unwrap().starts_with("desktop:"));
        assert!(matches!(v["platform"].as_str().unwrap(), "windows" | "macos"));
    }
}
