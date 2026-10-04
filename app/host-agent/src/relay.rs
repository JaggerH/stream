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
            SessionEnd::Rejected(e) => format!(
                "relay rejected the handshake ({e}) — token 可能已失效（后端 data 目录被重建过？），\
                 agent 的 token 只在启动时从环境变量读一次，换 token 需要重启工作台"
            ),
            SessionEnd::Disconnected => "disconnected".to_string(),
        }
    }
}

/// 起步 1s：后端 `docker restart` 一般几秒内就回来，第一次重试快一点能少丢一轮采集。
pub const BACKOFF_BASE: Duration = Duration::from_secs(1);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
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
}
