//! `ensureApp` —— 「让进程活着」，**不是**「让窗口到前面来」。
//!
//! 定时采集收敛到用户自己的 Chrome 之后，代价是"浏览器关着就采不了"。已定的语义是：
//! 以「用户的浏览器活着」为前提；不活着就唤醒它；唤不醒就跳过这一轮，不报错
//! （`docs/superpowers/specs/2026-07-28-xhs-harvest-on-user-chrome-design.md` §7）。
//!
//! **绝不能拿 `focus_app` 来做这件事。** 它 `SetForegroundWindow` + `BringWindowToTop`，
//! 还专门写了 `AttachThreadInput` 去绕过 Windows 的前台锁——**它的职责就是抢屏**。整个
//! 「采集搬到用户 Chrome」的价值就在于我们不再需要抢用户的屏幕；混用会把一次后台采集
//! 变成一次抢屏。本模块**不碰任何窗口**：不改 Z 序、不改焦点、不还原最小化窗口，只回答
//! 「这个进程在不在」并在不在时把它拉起来。
//!
//! 平台无关：进程枚举走 sysinfo（跨平台），启动走 `std::process::Command`。世界的两个
//! 副作用（枚举 / spawn）收在 `ProcessWorld` 后面，于是决策逻辑在 Linux 上也能单测。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 「确保它在跑」的入参。全部可选——默认就是"用户自己那个 Chrome"。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LaunchSpec {
    /// 可执行文件路径。省略时按平台的常见安装位置找 Chrome。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
    /// Chrome 的 `--profile-directory`（如 `Default` / `Profile 1`）。
    ///
    /// **是它、不是 `--user-data-dir`**：本方案的全部价值就是复用用户那个已登录、
    /// 已装扩展的 profile。`--user-data-dir` 会另开一份**空**的 user data——没有登录态、
    /// 没有 ext-cdp 扩展，等于把刚搬过来的东西又搬走。`--profile-directory` 选的是同一份
    /// user data 里的哪个 profile，登录态和扩展都还在。
    #[serde(default, rename = "profileDirectory", skip_serializing_if = "Option::is_none")]
    pub profile_directory: Option<String>,
    /// 附加命令行参数。省略时用 [`DEFAULT_ARGS`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// 判"在不在跑"用的进程名（不带扩展名也行）。省略时从 `exe` 推，再省略就是 `chrome`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    /// 即使进程已经在跑也再启动一次。
    ///
    /// **为什么需要它**：「进程活着」不等于「能用」。新版 Chrome 关掉窗口后会常驻托盘——进程在、
    /// 一个窗口都没有、扩展的 service worker 也睡着了。这时默认的 ensure 语义（在跑就什么都不做）
    /// 是对的却没用：没有任何东西去叫醒它。再 spawn 一次，Chrome 会把这次调用交给已经在跑的那个
    /// 实例并开一个窗口，SW 随之醒来。
    ///
    /// 只在**调用方已经确认它不答话**时才该传 true（我们等过中继、超时了）。无条件传等于每轮采集
    /// 都弹一个窗口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// 结果如实描述**现在**的状态，不是"我调用过了吗"。
///
/// 这条是 `focus_app` 的注释里那个教训的同源：老的 `focus_app` 恒返回 true，害得一次根本
/// 没发生的实验被当真分析了二十分钟。所以 `running` 是回读出来的——spawn 之后轮询确认进程
/// 真的出现了才置 true；到点没出现就如实 false，让调度侧跳过这一轮。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnsureOutcome {
    /// 现在这个进程活着吗（本来就活着，或我们刚拉起来并确认到了）。
    pub running: bool,
    /// 这次调用有没有真的 spawn 过。false = 本来就在跑，我们什么都没做。
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// 实际用来匹配的进程名，便于排错时看清我们在找谁。
    pub process: String,
}

/// 默认启动参数：**不开窗**。
///
/// 验收标准里写死了「host-agent 拉起它、采集完成、**没有窗口跳到前台**」。`--no-startup-window`
/// 是 Chrome 官方给"为了托管后台应用而启动浏览器"用的开关：profile 照常加载、扩展照常跑，
/// 只是不开首页窗口。调用方可以用 `args` 整体覆盖（活体验证若发现该档下 profile 不加载，
/// 后端传 `args: []` 即可退回普通启动，不用改 agent）。
pub const DEFAULT_ARGS: &[&str] = &["--no-startup-window"];

/// spawn 之后等进程出现的轮询窗口：15 × 200ms = 3s。Chrome 冷启动建进程是毫秒级的，
/// 3s 只是给磁盘慢的机器留余量；到点没出现就认定唤不醒。
const POLL_ROUNDS: u32 = 15;
const POLL_INTERVAL_MS: u64 = 200;

/// 把 `ensure_running` 需要的三件副作用抽出来：枚举进程、找可执行文件、启动它。
/// 真实实现是 [`RealWorld`]；测试注入假的，于是决策逻辑（要不要 spawn、什么时候放弃）
/// 在没有 Chrome 的 Linux CI 上也能验证，而且单测**永远不会真的拉起一个浏览器**。
pub trait ProcessWorld {
    /// 进程名（不带扩展名，大小写不敏感）匹配到的第一个 pid。
    fn pid_of(&mut self, stem: &str) -> Option<u32>;
    fn locate_exe(&mut self, spec: &LaunchSpec) -> Result<PathBuf, String> {
        resolve_exe(spec, &|k| std::env::var(k).ok())
    }
    fn spawn(&mut self, exe: &Path, args: &[String]) -> Result<(), String>;
    fn dwell(&mut self, ms: u64);
}

/// 目标进程名：显式 `process` > 从 `exe` 的文件名推 > `chrome`。一律去掉 `.exe` 后缀并小写，
/// 因为 sysinfo 在 Windows 上给的是 `chrome.exe`、在 Linux 上给的是 `chrome`。
pub fn target_stem(spec: &LaunchSpec) -> String {
    let raw = spec
        .process
        .clone()
        .or_else(|| {
            // 手工切 `/` 和 `\` 两种分隔符，**不用 `Path::file_name`**：`Path` 的分隔符规则跟着
            // 编译目标走，而这个字符串是后端（跑在 Linux 容器里）通过 wire 传下来的 Windows
            // 路径。在 Linux 上 `Path::file_name(r"C:\X\chrome.exe")` 会把整串原样还回来，
            // 于是进程名成了 `c:\x\chrome`，永远匹配不上任何进程。
            spec.exe
                .as_deref()
                .map(|e| e.rsplit(['/', '\\']).next().unwrap_or(e).to_string())
        })
        .unwrap_or_else(|| "chrome".to_string());
    let lower = raw.to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// 最终命令行：`args`（缺省 [`DEFAULT_ARGS`]）+ `--profile-directory=<name>`。
pub fn build_args(spec: &LaunchSpec) -> Vec<String> {
    let mut out: Vec<String> = match (&spec.args, &spec.exe) {
        (Some(a), _) => a.clone(),
        // 默认参数属于**默认目标**。[`DEFAULT_ARGS`] 是 Chrome 专属的（`--no-startup-window`），
        // 只在"我们自己去找 Chrome"那条路上成立；调用方一旦指名了别的可执行文件，继承它就是错的
        // ——喂给 Telegram 这类应用，轻则被当成待打开的文件名，重则拒绝启动。
        (None, Some(_)) => Vec::new(),
        (None, None) => DEFAULT_ARGS.iter().map(|s| s.to_string()).collect(),
    };
    if let Some(p) = spec.profile_directory.as_deref() {
        out.push(format!("--profile-directory={p}"));
    }
    out
}

/// Chrome 的常见安装位置。env 通过参数注入，所以这份清单本身是可单测的纯函数。
pub fn chrome_candidates(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        const SUFFIX: &str = r"Google\Chrome\Application\chrome.exe";
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = env(key) {
                out.push(PathBuf::from(base).join(SUFFIX));
            }
        }
    } else if cfg!(target_os = "macos") {
        // **要的是 .app 里面那个真二进制，不是 `open -a`**：`open` 立刻返回、拉起的是它自己的
        // 子进程，回读确认（`ensure_running` 轮询进程名）会扑空，而 `--profile-directory`
        // 这类参数也得再套一层 `--args` 才传得进去。直接 exec 二进制两样都省了。
        //
        // 顺带把进程名也定对了：`target_stem` 从这个路径推出的是 `google chrome`，正是 sysinfo
        // 在 macOS 上报的名字（小写后）。**少了这条候选，默认 stem 会退成 `chrome`**，于是
        // 「Chrome 在不在跑」恒答"不在"——表现是每一轮采集都再拉一次，而不是报错。
        for p in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            out.push(PathBuf::from(p));
        }
    } else {
        for p in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ] {
            out.push(PathBuf::from(p));
        }
    }
    out
}

/// 定位可执行文件。显式 `exe` 原样采信（裸文件名交给 PATH 解析）；否则挑第一个存在的候选。
pub fn resolve_exe(spec: &LaunchSpec, env: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    if let Some(exe) = spec.exe.as_deref() {
        let p = PathBuf::from(exe);
        // 带路径分隔符 = 用户指了具体位置，不存在就是配错了，如实报错；裸文件名放行给
        // Command 走 PATH（此时我们无从判断存不存在，别假装能判断）。
        if p.components().count() > 1 && !p.exists() {
            return Err(format!("executable not found: {exe}"));
        }
        return Ok(p);
    }
    chrome_candidates(env)
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "chrome executable not found — pass `exe` explicitly".to_string())
}

/// 在跑就什么都不做；不在跑就启动并**回读确认**。
///
/// 判据故意只到"有没有这个名字的进程"这一层，不去解析命令行里的 `--profile-directory`：
/// 用户在浏览器内切换 profile 时，多个 profile 共用同一个 browser 进程、命令行里根本没有那个
/// 标志，按标志判会得出"没在跑"，于是我们对着一个开着的 Chrome 再 spawn 一次——Chrome 会把它
/// 转给已有进程并**弹出一个窗口**，正好违反"不抢屏"。宁可保守：只要有 Chrome 活着就不动手。
/// 代价是"Chrome 开着但目标 profile 没加载"这种情况我们唤不醒它，那一轮按既定语义跳过。
pub fn ensure_running<W: ProcessWorld>(spec: &LaunchSpec, world: &mut W) -> Result<EnsureOutcome, String> {
    let stem = target_stem(spec);
    if !spec.force.unwrap_or(false) {
        if let Some(pid) = world.pid_of(&stem) {
            return Ok(EnsureOutcome { running: true, started: false, pid: Some(pid), process: stem });
        }
    }

    let exe = world.locate_exe(spec)?;
    let args = build_args(spec);
    world.spawn(&exe, &args)?;

    for _ in 0..POLL_ROUNDS {
        world.dwell(POLL_INTERVAL_MS);
        if let Some(pid) = world.pid_of(&stem) {
            return Ok(EnsureOutcome { running: true, started: true, pid: Some(pid), process: stem });
        }
    }
    // 启动过了但进程没出现——如实 false。调用方据此跳过这一轮，而不是对着一个不存在的
    // 浏览器排队发 CDP 命令。
    Ok(EnsureOutcome { running: false, started: true, pid: None, process: stem })
}

/// 真实副作用：sysinfo 枚举 + `std::process::Command` 启动。
pub struct RealWorld;

impl ProcessWorld for RealWorld {
    fn pid_of(&mut self, stem: &str) -> Option<u32> {
        let sys = crate::procs::names_only();
        sys.processes()
            .values()
            .find(|p| {
                let pn = p.name().to_string_lossy().to_lowercase();
                pn.strip_suffix(".exe").unwrap_or(&pn) == stem
            })
            .map(|p| p.pid().as_u32())
    }

    fn spawn(&mut self, exe: &Path, args: &[String]) -> Result<(), String> {
        use std::process::{Command, Stdio};
        // 三个流全部接 null：agent 自己是个长命 sidecar，不能被浏览器的 stderr 灌满管道
        // 反过来把浏览器堵住；也不 wait 子进程——我们要的是"它自己活下去"，不是"它归我管"。
        Command::new(exe)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_child| ())
            .map_err(|e| format!("spawn {} failed: {e}", exe.display()))
    }

    fn dwell(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个假世界：进程在第 `appears_after` 次 dwell 之后才出现（0 = 一开始就在）。
    struct FakeWorld {
        alive: bool,
        appears_after: u32,
        dwells: u32,
        spawns: Vec<(PathBuf, Vec<String>)>,
    }
    impl FakeWorld {
        fn absent(appears_after: u32) -> Self {
            Self { alive: false, appears_after, dwells: 0, spawns: Vec::new() }
        }
        fn present() -> Self {
            Self { alive: true, appears_after: 0, dwells: 0, spawns: Vec::new() }
        }
    }
    impl ProcessWorld for FakeWorld {
        fn pid_of(&mut self, _stem: &str) -> Option<u32> {
            if self.alive || (!self.spawns.is_empty() && self.dwells >= self.appears_after) {
                Some(4242)
            } else {
                None
            }
        }
        fn locate_exe(&mut self, _spec: &LaunchSpec) -> Result<PathBuf, String> {
            Ok(PathBuf::from("/fake/chrome"))
        }
        fn spawn(&mut self, exe: &Path, args: &[String]) -> Result<(), String> {
            self.spawns.push((exe.to_path_buf(), args.to_vec()));
            Ok(())
        }
        fn dwell(&mut self, _ms: u64) {
            self.dwells += 1;
        }
    }

    /// 「进程活着」不等于「能用」：托盘里的 Chrome 进程在、没窗口、扩展的 SW 也睡着。默认语义
    /// （在跑就什么都不做）此时正确却没用——没有任何东西去叫醒它。force 是给"已经确认它不答话"
    /// 的调用方用的最后一招。
    #[test]
    fn force_spawns_even_when_already_running() {
        let mut w = FakeWorld::present();
        let spec = LaunchSpec { force: Some(true), ..Default::default() };
        let out = ensure_running(&spec, &mut w).unwrap();
        assert!(out.started, "force 必须真的 spawn，否则叫不醒睡着的 SW");
        assert_eq!(w.spawns.len(), 1);
        assert!(out.running);
    }

    #[test]
    fn already_running_is_a_no_op() {
        let mut w = FakeWorld::present();
        let out = ensure_running(&LaunchSpec::default(), &mut w).unwrap();
        assert_eq!(out, EnsureOutcome { running: true, started: false, pid: Some(4242), process: "chrome".into() });
        assert!(w.spawns.is_empty(), "在跑就不该 spawn");
        assert_eq!(w.dwells, 0, "在跑就不该等");
    }

    #[test]
    fn absent_process_is_started_and_confirmed() {
        let mut w = FakeWorld::absent(2);
        let spec = LaunchSpec { profile_directory: Some("Profile 1".into()), ..Default::default() };
        let out = ensure_running(&spec, &mut w).unwrap();
        assert!(out.running && out.started);
        assert_eq!(out.pid, Some(4242));
        assert_eq!(w.spawns.len(), 1);
        assert_eq!(w.spawns[0].1, vec!["--no-startup-window", "--profile-directory=Profile 1"]);
    }

    #[test]
    fn never_appearing_process_reports_false_instead_of_lying() {
        let mut w = FakeWorld::absent(u32::MAX);
        let out = ensure_running(&LaunchSpec::default(), &mut w).unwrap();
        assert_eq!(out.running, false, "唤不醒要如实说，调度侧据此跳过这一轮");
        assert_eq!(out.started, true);
        assert_eq!(out.pid, None);
        assert_eq!(w.dwells, POLL_ROUNDS);
    }

    #[test]
    fn caller_args_replace_the_default_but_profile_still_rides() {
        let spec = LaunchSpec {
            args: Some(vec!["--restore-last-session".into()]),
            profile_directory: Some("Default".into()),
            ..Default::default()
        };
        assert_eq!(build_args(&spec), vec!["--restore-last-session", "--profile-directory=Default"]);
    }

    /// 默认参数属于**默认目标**：`DEFAULT_ARGS` 是 Chrome 专属的开关，一旦调用方指名了别的
    /// 可执行文件就不该被继承——喂给 Telegram 这类应用，轻则被当成待打开的文件名、重则拒绝启动。
    #[test]
    fn a_named_exe_does_not_inherit_chromes_default_args() {
        let spec = LaunchSpec { exe: Some(r"C:\T\Telegram.exe".into()), ..Default::default() };
        assert!(build_args(&spec).is_empty());
        // 没指名 exe = 目标就是 Chrome，默认照旧
        assert_eq!(build_args(&LaunchSpec::default()), DEFAULT_ARGS.to_vec());
    }

    #[test]
    fn stem_comes_from_process_then_exe_then_chrome() {
        assert_eq!(target_stem(&LaunchSpec::default()), "chrome");
        assert_eq!(
            target_stem(&LaunchSpec { exe: Some(r"C:\X\msedge.EXE".into()), ..Default::default() }),
            "msedge"
        );
        assert_eq!(
            target_stem(&LaunchSpec {
                exe: Some(r"C:\X\chrome.exe".into()),
                process: Some("Brave.exe".into()),
                ..Default::default()
            }),
            "brave"
        );
    }

    #[test]
    fn explicit_missing_path_errors_but_bare_name_defers_to_path_lookup() {
        let env = |_: &str| None;
        let spec = LaunchSpec { exe: Some("/nope/nothing/chrome".into()), ..Default::default() };
        assert!(resolve_exe(&spec, &env).is_err());
        let bare = LaunchSpec { exe: Some("chrome".into()), ..Default::default() };
        assert_eq!(resolve_exe(&bare, &env).unwrap(), PathBuf::from("chrome"));
    }

    #[test]
    fn no_candidate_found_is_an_actionable_error() {
        // 非 Windows 的候选是绝对路径清单；env 给不给都一样，这里只要求错误信息可操作。
        let spec = LaunchSpec::default();
        let empty = |_: &str| None;
        if let Err(e) = resolve_exe(&spec, &empty) {
            assert!(e.contains("pass `exe`"), "错误要告诉调用方怎么办: {e}");
        }
    }
}
