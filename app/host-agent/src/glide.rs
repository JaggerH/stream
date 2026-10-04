//! 点击前把指针**滑**到目标，而不是瞬移过去。纯几何、没有 IO，所以 Linux 上就能单测；
//! Windows / macOS 两个后端的 `click` 共用同一份，两边的手感才不会各长各的。
//!
//! 为什么要滑：用户看着桌面 recipe 跑（抢屏模式、真实键鼠）的时候，指针一下出现在屏幕另一头、
//! 紧接着就按下，人眼根本跟不上——"它刚点了哪儿"这件事只能事后从日志里猜。滑过去 250ms、
//! 到位再停 80ms，视线跟得上指针，点下去的那一刻用户知道点的是什么。这**只改 `click`**：
//! `moveMouse` 是叫醒渲染端用的、要的正是"一次真实位移"而不是观感；`type` 更不能逐字加节奏。

use std::time::Duration;

/// 整段滑行的时长与步数：250ms / 30 步 ≈ 每 8ms 一帧，比显示器刷新略密，看起来是连续的。
pub const GLIDE_MS: u64 = 250;
pub const GLIDE_STEPS: usize = 30;
/// 比这更近就直接到位：几像素的位移插 30 帧，每帧连 1px 都不到，全是空转。
pub const SNAP_PX: i32 = 20;
/// 到位之后停多久再按下。没有这一拍，"到了"和"按了"在人眼里是同一帧。
pub const SETTLE_MS: u64 = 80;

/// 三次缓入缓出：起步慢、中段快、到位前再慢下来——读起来是"伸手去够"，不是匀速平移。
fn ease_in_out(t: f32) -> f32 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// 从 `from` 到 `to` 的一串采样点。**首点是 `from`、尾点精确等于 `to`**（不靠浮点凑），
/// 中间按 `ease_in_out` 分布；起终点重合或距离小于 `SNAP_PX` 时只有 `to` 一个点。
pub fn glide_path(from: (i32, i32), to: (i32, i32)) -> Vec<(i32, i32)> {
    let (dx, dy) = ((to.0 - from.0) as f32, (to.1 - from.1) as f32);
    if (dx * dx + dy * dy).sqrt() < SNAP_PX as f32 {
        return vec![to];
    }
    let mut pts: Vec<(i32, i32)> = Vec::with_capacity(GLIDE_STEPS + 1);
    pts.push(from);
    for k in 1..GLIDE_STEPS {
        let e = ease_in_out(k as f32 / GLIDE_STEPS as f32);
        let p = ((from.0 as f32 + dx * e).round() as i32, (from.1 as f32 + dy * e).round() as i32);
        // 缓入那几帧取整后常落在同一个像素上，重复的点只是多发几次"移到原地"。
        if pts.last() != Some(&p) {
            pts.push(p);
        }
    }
    if pts.last() != Some(&to) {
        pts.push(to);
    }
    pts
}

/// 真的滑：逐点调 `mv` 并按时长均分停顿，到位后再停 `SETTLE_MS`。`from` 通常来自
/// `enigo.location()`；读不到就传 `to` 本身——退化成瞬移，比拒绝点击强。
pub fn glide_to<E>(from: (i32, i32), to: (i32, i32), mut mv: impl FnMut(i32, i32) -> Result<(), E>) -> Result<(), E> {
    let pts = glide_path(from, to);
    // 首点就是当前位置时不用再"移"一次；每两点之间停一拍，整段凑成 GLIDE_MS。
    let pause = Duration::from_millis(GLIDE_MS / GLIDE_STEPS as u64);
    let mut iter = pts.iter().peekable();
    while let Some(&(x, y)) = iter.next() {
        if (x, y) != from {
            mv(x, y)?;
        }
        if iter.peek().is_some() {
            std::thread::sleep(pause);
        }
    }
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起点 = 终点：只有一个点，别为零位移空转 30 帧。
    #[test]
    fn same_point_yields_a_single_point() {
        assert_eq!(glide_path((100, 100), (100, 100)), vec![(100, 100)]);
    }

    /// 近距离直接到位——插值出来的帧每帧不到 1px，纯浪费。
    #[test]
    fn short_hops_snap_without_interpolation() {
        assert_eq!(glide_path((100, 100), (110, 105)), vec![(110, 105)]);
    }

    /// 首尾点必须**精确**等于起终点：尾点差 1px 就是点偏 1px，而按钮边缘正好差这 1px。
    #[test]
    fn endpoints_are_exact_and_step_count_is_capped() {
        let p = glide_path((0, 0), (1000, 333));
        assert_eq!(*p.first().unwrap(), (0, 0));
        assert_eq!(*p.last().unwrap(), (1000, 333));
        assert!(p.len() <= GLIDE_STEPS + 1, "{}", p.len());
        assert!(p.len() >= GLIDE_STEPS / 2, "远距离该有足够的帧数才看得出滑：{}", p.len());
        assert!(p.windows(2).all(|w| w[0] != w[1]), "相邻点不许重复");
    }

    /// 单调逼近、不回头：缓动只改节奏，不改方向（overshoot 会点到别的东西再弹回来）。
    #[test]
    fn the_path_never_overshoots_or_backtracks() {
        let p = glide_path((500, 200), (20, 900));
        for w in p.windows(2) {
            assert!(w[1].0 <= w[0].0, "x 该单调递减：{:?}", w);
            assert!(w[1].1 >= w[0].1, "y 该单调递增：{:?}", w);
        }
    }

    /// 缓入缓出：中段一步的位移比开头一步大——否则和匀速没区别。
    #[test]
    fn it_eases_in_and_out() {
        let p = glide_path((0, 0), (3000, 0));
        let n = p.len();
        let first = p[1].0 - p[0].0;
        let mid = p[n / 2 + 1].0 - p[n / 2].0;
        let last = p[n - 1].0 - p[n - 2].0;
        assert!(mid > first * 3, "first={first} mid={mid}");
        assert!(mid > last * 3, "last={last} mid={mid}");
    }

    /// `glide_to` 不重复"移到当前位置"，且最后一次 `mv` 落在终点上。
    #[test]
    fn glide_to_skips_the_origin_and_ends_on_target() {
        let mut seen: Vec<(i32, i32)> = vec![];
        glide_to::<()>((0, 0), (400, 0), |x, y| {
            seen.push((x, y));
            Ok(())
        })
        .unwrap();
        assert_eq!(seen.len(), glide_path((0, 0), (400, 0)).len() - 1, "首点是原地，不用移");
        assert!(!seen.contains(&(0, 0)));
        assert_eq!(*seen.last().unwrap(), (400, 0));
    }
}
