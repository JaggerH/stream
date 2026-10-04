//! 「这个 pid 是哪个进程」的唯一问法。
//!
//! **别用 `sysinfo::System::new_all()` 回答它。** `new_all` 刷的是整机：每个进程的命令行、
//! 环境变量、内存、磁盘读写、CPU，外加整机 CPU 与内存——为了拿一个进程名，把机器上几百个
//! 进程挨个读一遍。实测（本机 2026-09-29，22 个窗口 / 17 个进程）：`new_all` 热态 60–70ms、
//! 冷态 360–380ms，这里的 `snapshot` 20–35ms。`windows()`（`focusApp` / `scopeWindow`
//! 内部都先调它）和每次 `readElements` 都要问进程名，一趟 wechat-send 十几次。
//!
//! 这里只刷**点名的那几个 pid**，只带名字（名字在 Windows 上来自同一次
//! `NtQuerySystemInformation`，不用额外开进程），要 exe 路径时才多问一次 exe。
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// 只含 `pids` 这几个进程的快照；`exe` = 也取 exe 路径（读版本资源要它）。
pub fn snapshot(pids: &[u32], exe: bool) -> System {
    let pids: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();
    let kind = if exe {
        ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet)
    } else {
        ProcessRefreshKind::new()
    };
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);
    sys
}

/// 全部进程，但只带名字——按名字找进程（`launch.rs` 的 `pid_of`）用。
pub fn names_only() -> System {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());
    sys
}

/// 一个 pid 的进程映像名（Windows 上带 `.exe`）；进程已经没了就 `None`。
pub fn name_of(pid: u32) -> Option<String> {
    snapshot(&[pid], false)
        .process(Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小刷新档照样有名字——这正是替换 `new_all` 的前提；缺了它 `windows()` 的每一行
    /// `process` 都会是空串，而 `resolve_window` 按进程名过滤，于是一个窗口都认不出。
    #[test]
    fn minimal_refresh_still_carries_name_and_exe() {
        let me = std::process::id();
        let sys = snapshot(&[me], true);
        let p = sys.process(Pid::from_u32(me)).expect("自己这个进程必须在快照里");
        assert!(!p.name().is_empty());
        assert!(p.exe().is_some());
        assert_eq!(name_of(me).as_deref(), Some(p.name().to_string_lossy().as_ref()));
    }

    /// 只刷点名的 pid——快照里不该混进别的进程（否则就又退回了全表扫描）。
    #[test]
    fn snapshot_holds_only_the_named_pids() {
        let me = std::process::id();
        assert_eq!(snapshot(&[me], false).processes().len(), 1);
    }

    #[test]
    fn names_only_finds_self_by_name() {
        let me = std::process::id();
        let sys = names_only();
        assert!(sys.processes().len() > 1);
        assert!(sys.process(Pid::from_u32(me)).is_some());
    }
}
