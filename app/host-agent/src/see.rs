//! `pixel` 词汇里平台无关的那一半：模板匹配。按键精灵的 FindPic 在 Rust 里长这样。

// 这里的东西唯一的生产消费者在有截图的两个后端（`windows.rs` / `macos.rs`）里，所以在 Linux
// 上编二进制时整块是死代码。留在这边不是为了将来：NCC 和缩放几何算错的表现都是安静的
// （错命中、框整体偏一档），而只有在这一侧它们才测得到——用一句 allow 换 Linux 上的覆盖。
// 同 `see_detect.rs`。
#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]

use crate::protocol::{Element, ElementKind, Rect, ScreenText};
use image::GrayImage;

/// 粗搜的面积闸：`hay` 超过它就**先按整数倍缩小搜一遍、再回全分辨率精修**。
///
/// 全分辨率 NCC 是 O(W·H·w·h)。4K 整窗（3840×2160）配一个 100×40 的模板是三百多亿次乘加——
/// 几十秒，而 `template` 段正是稳态回放**每一步**都要走的那条路。缩 f 倍两边都缩，代价降到
/// 约 1/f⁴。1M ≈ 1000×1000：1080p 及以下原样全搜（快得没必要绕），4K 落在 f=3 那一档。
const COARSE_MAX_AREA: u64 = 1_000_000;
/// 缩小之后模板短边不能少于它：再小就没有形状可比，粗搜会指到一个随便什么地方，
/// 而精修只在那个错地方的 ±2f 内找——比不缩更糟。到不了这个下限就整个退回全分辨率。
const MIN_COARSE_NEEDLE_SIDE: u32 = 4;

/// 预处理过的模板：零均值向量 + 它的模长。抽出来是为了粗、细两趟共用一份代码。
struct Needle {
    w: u32,
    h: u32,
    z: Vec<f64>,
    norm: f64,
}

fn prep(needle: &GrayImage) -> Option<Needle> {
    let (w, h) = needle.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let n = (w * h) as f64;
    let raw = needle.as_raw();
    let mean = raw.iter().map(|&v| v as f64).sum::<f64>() / n;
    let z: Vec<f64> = raw.iter().map(|&v| v as f64 - mean).collect();
    let norm = z.iter().map(|v| v * v).sum::<f64>().sqrt();
    if norm == 0.0 {
        return None; // 纯色模板没有形状可匹配
    }
    Some(Needle { w, h, z, norm })
}

/// 在 `hay` 的 `[x0..=x1] × [y0..=y1]` 这些左上角位置上滑窗，返回最高分的位置与分数（-1..1）。
/// 分数是**零均值**的：模板和目标同时变亮/变暗不影响，但形状差、尺寸差立刻掉分——
/// 所以缩放比变了的旧模板会在这里被拒，而不是错命中。
fn scan(hay: &GrayImage, n: &Needle, x0: u32, y0: u32, x1: u32, y1: u32) -> Option<(Rect, f64)> {
    let hw = hay.width();
    // 直接按 u8 索引原始缓冲：过去每次调用都先把整张图铺成一份 `Vec<f64>`（4K 整窗 = 66MB），
    // 而那份东西每个位置只读一次，转换放在内层循环里一样便宜。
    let hv = hay.as_raw();
    let count = (n.w * n.h) as f64;
    let mut best = (0u32, 0u32, -2.0f64);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let mut sum = 0.0;
            let mut sq = 0.0;
            let mut dot = 0.0;
            for j in 0..n.h {
                let row = ((y + j) * hw + x) as usize;
                for i in 0..n.w {
                    let v = hv[row + i as usize] as f64;
                    sum += v;
                    sq += v * v;
                    dot += v * n.z[(j * n.w + i) as usize];
                }
            }
            let mean = sum / count;
            let var = sq - count * mean * mean;
            if var <= 0.0 {
                continue;
            }
            let score = dot / (var.sqrt() * n.norm); // Σ(h-mean)·nz = Σh·nz - mean·Σnz，而 Σnz = 0
            if score > best.2 {
                best = (x, y, score);
            }
        }
    }
    (best.2 > -2.0).then(|| {
        (
            Rect { x: best.0 as i32, y: best.1 as i32, w: n.w as i32, h: n.h as i32 },
            best.2,
        )
    })
}

/// 全分辨率那一趟。**只有它记账**（见 `FULL_POSITIONS`）：粗搜的位置是廉价的，
/// 要钉住的是"全分辨率上到底算了几个位置"。
fn scan_full(hay: &GrayImage, n: &Needle, x0: u32, y0: u32, x1: u32, y1: u32) -> Option<(Rect, f64)> {
    note_full_positions(((x1 - x0 + 1) as u64) * ((y1 - y0 + 1) as u64));
    scan(hay, n, x0, y0, x1, y1)
}

#[cfg(test)]
thread_local! {
    /// 这条线程上全分辨率算过的位置数。测试用它证明粗搜真的省下了那几百万次——
    /// "找对了"证明不了这一点：不缩也照样找得对，只是慢几十倍。
    static FULL_POSITIONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
fn note_full_positions(n: u64) {
    FULL_POSITIONS.with(|c| c.set(c.get() + n));
}
#[cfg(not(test))]
fn note_full_positions(_n: u64) {}

/// 该缩几倍：满足面积闸的最小整数倍。`None` = 别缩（图本来就不大，或者缩完模板就没形状了）。
fn coarse_factor(hw: u32, hh: u32, nw: u32, nh: u32) -> Option<u32> {
    if (hw as u64) * (hh as u64) <= COARSE_MAX_AREA {
        return None;
    }
    for f in 2..=16u32 {
        if (hw as u64 / f as u64) * (hh as u64 / f as u64) <= COARSE_MAX_AREA {
            let ok = nw / f >= MIN_COARSE_NEEDLE_SIDE && nh / f >= MIN_COARSE_NEEDLE_SIDE;
            return ok.then_some(f);
        }
    }
    None
}

/// 归一化互相关（NCC）：在 `hay` 上找 `needle`，返回最高分的位置与分数（-1..1）。
///
/// **入口负责决定怎么搜**：小图直接全搜；大图先缩 `f` 倍粗搜，再只在粗命中周围 ±2f 像素内
/// 回全分辨率精修（缩小引入的位置误差至多 f/2 放大回来，±2f 是四倍余量）。粗搜落空（缩完
/// 模板是纯色之类）就退回全搜——**宁可慢，不可指错**。返回的框和分数永远是全分辨率那一趟的。
pub fn find_image(hay: &GrayImage, needle: &GrayImage) -> Option<(Rect, f64)> {
    let (hw, hh) = hay.dimensions();
    let (nw, nh) = needle.dimensions();
    if nw == 0 || nh == 0 || nw > hw || nh > hh {
        return None;
    }
    let n = prep(needle)?;
    let full = |n: &Needle| scan_full(hay, n, 0, 0, hw - n.w, hh - n.h);
    let Some(f) = coarse_factor(hw, hh, nw, nh) else {
        return full(&n);
    };
    let (cw, ch) = (hw / f, hh / f);
    let filter = image::imageops::FilterType::Triangle;
    let small_hay = image::imageops::resize(hay, cw, ch, filter);
    let small_needle = image::imageops::resize(needle, (nw / f).max(1), (nh / f).max(1), filter);
    let Some(cn) = prep(&small_needle) else {
        return full(&n);
    };
    if cn.w > cw || cn.h > ch {
        return full(&n);
    }
    let Some((cr, _)) = scan(&small_hay, &cn, 0, 0, cw - cn.w, ch - cn.h) else {
        return full(&n);
    };
    // 粗坐标放大回来，再往四周留 ±2f 的余量；两边都夹进合法的左上角范围。
    let pad = 2 * f;
    let (mx, my) = (hw - nw, hh - nh);
    let (cx, cy) = ((cr.x as u32) * f, (cr.y as u32) * f);
    let x1 = (cx + pad).min(mx);
    let y1 = (cy + pad).min(my);
    scan_full(hay, &n, cx.saturating_sub(pad).min(x1), cy.saturating_sub(pad).min(y1), x1, y1)
}

/// 两个框指的是不是同一个东西：IoU 超过它就合成一条。
///
/// 0.6 不是随手取的：a11y 报的控件框和检测器猜的框差几个像素（边框、阴影算不算在内），
/// IoU 落在 0.9 以上；而"按钮里套着一个图标"这种真·两个东西，IoU 通常低于 0.4。
/// **跨档**（a11y × 检测器、× 文字）判"同一条"用它。
const SAME_ELEMENT_IOU: f64 = 0.6;

/// **同档**（两个检测器框）判"同一条"用 `overlap_ratio`，0.7 抄自 OmniParser 的
/// `remove_overlap_new`。为什么两档用两把尺子，见 `synthesize_elements` 的文档。
const SAME_ELEMENT_OVERLAP: f64 = 0.7;

fn area(r: &Rect) -> f64 {
    (r.w.max(0) as f64) * (r.h.max(0) as f64)
}

/// 交并比。任一框面积为 0 时回 0——退化的框不该和谁"是同一个东西"。
fn iou(a: &Rect, b: &Rect) -> f64 {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.w).min(b.x + b.w);
    let y1 = (a.y + a.h).min(b.y + b.h);
    let inter = ((x1 - x0).max(0) as f64) * ((y1 - y0).max(0) as f64);
    let union = area(a) + area(b) - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// 重叠度：`max(IoU, 交集/A 的面积, 交集/B 的面积)`。
///
/// **只用 IoU 会漏掉套娃**：检测器同时报出一个大容器框和它里面的按钮时，两者的 IoU 很低
/// （交集只占并集的一小块），于是两个框都留了下来——表现是元素表里一堆互相交叉的框，而那个
/// 容器框的中心往往落在按钮之间的空隙上，点它就点空了。把"交集占谁的比例"也算进来，套娃就
/// 落进同一个比较里。
///
/// **只用在同档**（两个检测器框）。跨档不能用：a11y 报的工具栏里套着一个检测器猜的按钮，
/// 比值同样是 1.0，但那是真的两个东西——合并掉就少了一块能点的地方。
fn overlap_ratio(a: &Rect, b: &Rect) -> f64 {
    let x0 = a.x.max(b.x);
    let y0 = a.y.max(b.y);
    let x1 = (a.x + a.w).min(b.x + b.w);
    let y1 = (a.y + a.h).min(b.y + b.h);
    let inter = ((x1 - x0).max(0) as f64) * ((y1 - y0).max(0) as f64);
    if inter <= 0.0 {
        return 0.0;
    }
    let (sa, sb) = (area(a), area(b));
    if sa <= 0.0 || sb <= 0.0 {
        return 0.0;
    }
    // **不用再取一次 IoU 的 max。** IoU = inter/(sa+sb-inter)，而 sb >= inter，
    // 所以分母 >= sa，于是 IoU <= inter/sa；同理 IoU <= inter/sb。它永远被这两项之一压住，
    // 取 max 时不可能赢，只是白算一遍交集。
    (inter / sa).max(inter / sb)
}

/// 可信度：a11y 知道控件真正的边界，检测器只是猜，文字框只圈住那几个字。
fn trust(k: &ElementKind) -> u8 {
    match k {
        ElementKind::A11y => 2,
        ElementKind::Detector => 1,
        ElementKind::Text => 0,
    }
}

/// 这个框上是不是写着这段字。**判据是文字框的中心点落在框内**，不是完全包含：
/// OCR 框比字略大（`unclip` 会往外涨），完全包含会漏掉贴着按钮边缘的那些标签——
/// 而漏掉的后果是那个按钮变成一条没名字的元素，`see:{text:"发送"}` 一次都命不中。
fn holds_center(outer: &Rect, inner: &Rect) -> bool {
    let cx = inner.x + inner.w / 2;
    let cy = inner.y + inner.h / 2;
    cx >= outer.x && cx < outer.x + outer.w && cy >= outer.y && cy < outer.y + outer.h
}

/// 三档来源缝成一张**元素表**：哪儿能点、点的是什么。
///
/// 每一档单独都不够用：a11y 知道名字和准确的框，但自绘应用（微信、QQ）大片界面根本不在树里；
/// 检测器知道"这儿有个控件"，认不出那是什么；OCR 知道写着什么，但文字框不是可点区域
/// （蓝底蓝字的「发送」，文字框只圈住那两个字，边缘点空）。缝起来才有"带名字的可点框"。
///
/// 规则就三条：
/// - **包含即命名**：文字框的中心落在某个框里 → 那段字就是这个框的名字（多段按左到右拼起来）。
/// - **落单即入表**：没被任何框包住的文字自己入表（`kind: Text`）——自绘界面里大部分可点的
///   东西只有 OCR 看得见，丢掉它们等于把这条路的主要用途丢掉。
/// - **判"同一条"两档两把尺子**，这是刻意的：
///   - **跨档 `IoU > 0.6`**。a11y 的框是真相，它和检测器的框套在一起**是真的层级**——工具栏里
///     套着一个按钮，合并掉就少了一块能点的地方。所以跨档只认"几乎重合"。
///   - **同档 `overlap_ratio > 0.7`，留小的**。两个检测器框套在一起是同一个东西被报了两遍，
///     或者报出了一个把整组按钮圈起来的框；留大的会把里面每个按钮都删掉，而那个大框的中心
///     往往落在按钮之间的空隙上，点它就点空了。
///
///   合并时 `rect` 取更可信那档（同档取小的），`name` 取第一个非空的。
///
/// 输出按 (y, x) 排序——上层"同档多命中就拒绝"的判据要一个稳定的次序才可复现。
pub fn synthesize_elements(a11y: Vec<Element>, detector: Vec<Rect>, texts: &[ScreenText]) -> Vec<Element> {
    let mut out: Vec<Element> = Vec::new();
    let absorb = |cand: Element, out: &mut Vec<Element>| {
        let same = |e: &Element| {
            if e.kind == cand.kind {
                overlap_ratio(&e.rect, &cand.rect) > SAME_ELEMENT_OVERLAP
            } else {
                iou(&e.rect, &cand.rect) > SAME_ELEMENT_IOU
            }
        };
        if let Some(hit) = out.iter_mut().find(|e| same(e)) {
            // 框归谁：先比可信度，同档才比大小（小的赢）。
            let takes_rect = match trust(&cand.kind).cmp(&trust(&hit.kind)) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => area(&cand.rect) < area(&hit.rect),
            };
            if takes_rect {
                hit.rect = cand.rect;
                hit.kind = cand.kind;
            }
            if hit.name.as_deref().unwrap_or("").is_empty() {
                hit.name = cand.name;
            }
            return;
        }
        out.push(cand);
    };
    for e in a11y {
        absorb(e, &mut out);
    }
    for rect in detector {
        absorb(Element { rect, name: None, kind: ElementKind::Detector }, &mut out);
    }

    // 文字：先按 x 排序，这样同一个框里的多段字拼出来就是左到右的阅读顺序。
    let mut ordered: Vec<&ScreenText> = texts.iter().collect();
    ordered.sort_by_key(|t| t.rect.x);
    let mut names: Vec<String> = vec![String::new(); out.len()];
    let mut loners: Vec<Element> = Vec::new();
    for t in ordered {
        match out.iter().position(|e| holds_center(&e.rect, &t.rect)) {
            Some(i) => names[i].push_str(&t.text),
            None => loners.push(Element {
                rect: t.rect.clone(),
                name: Some(t.text.clone()),
                kind: ElementKind::Text,
            }),
        }
    }
    for (e, name) in out.iter_mut().zip(names) {
        if e.name.as_deref().unwrap_or("").is_empty() && !name.is_empty() {
            e.name = Some(name);
        }
    }
    out.extend(loners);
    out.sort_by_key(|e| (e.rect.y, e.rect.x));
    out
}

// ── 两个平台后端共用的那一半：模型放哪、引擎怎么惰性加载、region 怎么裁、探针怎么跑 ──────
//
// 这些原来住在 `windows.rs` 里。mac 后端补上截图之后同样要读模型、裁 region、跑 see-probe，
// 而"模型放哪"这种判据一旦两份，就会出现「Windows 找 exe 同目录、mac 找 cwd」这类静默分家
// ——表现是同一份包在一个平台上认字、另一个平台上"这一屏没有字"。所以只留一份。

/// 单次推理失败的日志**要限流**：失败通常不是一次性的（形状不对、图坏了），而
/// `readElements` 在一条 recipe 里每步都可能调一次——照实打会把同一行刷满整份日志，
/// 把别的线索埋掉。首次必打（那是唯一会被看见的一次），之后每 50 次打一行、带上累计数。
pub fn log_see_failure(e: String) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEEN: AtomicUsize = AtomicUsize::new(0);
    let n = SEEN.fetch_add(1, Ordering::Relaxed) + 1;
    if n == 1 || n % 50 == 0 {
        eprintln!("[see] 这一次检测失败（累计 {n} 次）：{e}");
    }
}

/// 检测器模型放哪：`STREAM_SEE_DETECTOR` 指的路径优先，缺省是 exe 同目录的 `see-detector.onnx`。
///
/// 缺省取 **exe 同目录**而不是当前工作目录：host agent 是被后端拉起来的，cwd 是后端的 cwd，
/// 按 cwd 找等于"从这台机器上哪儿启动就决定了模型在不在"——一个只在某些启动方式下缺席的能力。
pub fn see_detector_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("STREAM_SEE_DETECTOR") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("see-detector.onnx")))
        .unwrap_or_else(|| std::path::PathBuf::from("see-detector.onnx"))
}

/// PP-OCRv5 的三个文件（`ocr-det.onnx` / `ocr-rec.onnx` / `ocr-rec-dict.txt`）放哪：
/// `STREAM_OCR_MODELS` 指的目录优先，缺省是 exe 同目录。理由同 `see_detector_path`——
/// 按 cwd 找等于"从这台机器上哪儿启动就决定了模型在不在"。
pub fn ocr_models_dir() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("STREAM_OCR_MODELS") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}
/// 检测要不要留在物理分辨率上跑（`STREAM_OCR_PHYSICAL=1`）。缺省不：Retina / 200% DPI 的截图
/// 是逻辑画面的 4 倍像素，而 det 的成本按面积走（约 1.7s/百万像素，mac 实测 2026-09-13：
/// 2098×1528 整窗物理 7.3–8.5s、检测缩到 1× 后 2.3–3.1s，框数一样）。这个开关只为 A/B
/// 量准确率留着，不是给生产用的。
pub fn ocr_at_physical() -> bool {
    std::env::var("STREAM_OCR_PHYSICAL").map(|v| v.trim() == "1").unwrap_or(false)
}

/// 同一帧缓存要不要关（`STREAM_OCR_FRAME_CACHE=0`）。`see-probe` 把它关掉：它对同一个窗口连读
/// 两遍就是为了量第二遍的真实识别成本，命中缓存那一遍量出来的是哈希的价钱，不是 OCR 的。
pub fn ocr_frame_cache_enabled() -> bool {
    std::env::var("STREAM_OCR_FRAME_CACHE").map(|v| v.trim() != "0").unwrap_or(true)
}

/// 这一次检测跑在哪个尺度上：`scale > 1` 且没开物理开关才缩到 1×。抽成一个函数是因为日志
/// 里的 `ocr@det1x` / `ocr@phys` 标签和真正的分支必须同一个判据——两处各写一遍就会出现
/// "日志说 1×、实际跑的是物理"这种读 A/B 时最要命的错位。
pub fn ocr_runs_logical(scale: f64) -> bool {
    scale > 1.0 && !ocr_at_physical()
}

/// 日志标签，与 `ocr_runs_logical` 同源。`det1x` 说的是**只有检测**在 1× 上——识别永远吃物理像素。
pub fn ocr_mode_label(scale: f64) -> &'static str {
    if ocr_runs_logical(scale) { "ocr@det1x" } else { "ocr@phys" }
}

/// 物理尺寸 ÷ scale 之后的逻辑尺寸（四舍五入，最小 1）。`scale ≤ 1` 原样交回——
/// 没有"放大到逻辑尺寸"这回事。
pub fn logical_size(w: u32, h: u32, scale: f64) -> (u32, u32) {
    if scale <= 1.0 {
        return (w, h);
    }
    let lw = (w as f64 / scale).round().max(1.0) as u32;
    let lh = (h as f64 / scale).round().max(1.0) as u32;
    (lw, lh)
}

/// 缩小图上的一个框换回原图（物理）坐标：× scale 四舍五入，再夹进 `(w, h)` 里。
/// **夹**是因为缩小时的四舍五入会让最右 / 最下那一行的框多出一两个像素，出了图的框会让
/// 之后从物理图上裁块（`recognize_boxes` 里的 `crop_imm`）越界 panic。
pub fn scale_rect_back(r: &Rect, scale: f64, w: u32, h: u32) -> Rect {
    let (w, h) = (w as i32, h as i32);
    let x0 = ((r.x as f64) * scale).round() as i32;
    let y0 = ((r.y as f64) * scale).round() as i32;
    let x1 = (((r.x + r.w) as f64) * scale).round() as i32;
    let y1 = (((r.y + r.h) as f64) * scale).round() as i32;
    let x0 = x0.clamp(0, w);
    let y0 = y0.clamp(0, h);
    let x1 = x1.clamp(x0, w);
    let y1 = y1.clamp(y0, h);
    Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/// 检测器在 1× 上出的框整批换回物理坐标（`scale_rect_back`），分数原样带着。
pub fn scale_boxes_back(boxes: Vec<(Rect, f32)>, scale: f64, w: u32, h: u32) -> Vec<(Rect, f32)> {
    boxes.into_iter().map(|(r, s)| (scale_rect_back(&r, scale, w, h), s)).collect()
}

/// 同一帧缓存的 key：整张（裁完的）图的像素指纹（`ocr::crop_key`，宽高已编进去）再混入
/// `cropped` 与"跑在哪个尺度"两个开关——它们改变识别结果（`cropped` 决定 det 前放不放大），
/// 像素一样、开关不一样，交出上一次的结果就是错的。
pub fn frame_key(img: &image::RgbImage, cropped: bool, logical: bool) -> u64 {
    let mut h = crate::ocr::crop_key(img);
    let flags = (cropped as u64) | ((logical as u64) << 1);
    h ^= flags;
    h = h.wrapping_mul(0x100000001b3);
    h
}

/// 把画面裁到 `region`（截图坐标系），返回那一块 + 它的原点。`None` = 整窗（原点 0,0）。
///
/// **裁剪必须真的发生**：整窗一次 PP-OCR 是 1–3.4 秒，"取回来再筛"和这里裁一刀的结果一样，
/// 只是每步慢两秒——而这一点不会出现在任何断言里。
///
/// region 落在窗口之外就**报错**，不静默当整窗：那多半是 recipe 写错了坐标，而静默退回整窗
/// 会让它一直"能跑、只是慢且认到一堆无关的字"。
pub fn crop_to_region<'a>(
    img: &'a image::RgbImage,
    region: Option<&Rect>,
) -> Result<(std::borrow::Cow<'a, image::RgbImage>, (i32, i32)), String> {
    let Some(r) = region else { return Ok((std::borrow::Cow::Borrowed(img), (0, 0))) };
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    let x0 = r.x.clamp(0, iw);
    let y0 = r.y.clamp(0, ih);
    let x1 = (r.x + r.w).clamp(0, iw);
    let y1 = (r.y + r.h).clamp(0, ih);
    if x1 <= x0 || y1 <= y0 {
        return Err(format!(
            "bad-region: region {r:?} 和窗口画面（{iw}×{ih}）没有交集——坐标系是截图坐标（相对窗口左上角、物理像素）"
        ));
    }
    let crop =
        image::imageops::crop_imm(img, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32).to_image();
    Ok((std::borrow::Cow::Owned(crop), (x0, y0)))
}

/// 识别层的两个引擎（PP-OCR + 图标检测器），**惰性加载各一次**：模型文件是可缺席的，而
/// "不在场"这件事每次读屏都去问一遍盘等于白花一次 IO，还会把同一行日志刷满。
///
/// OCR 不是 `OnceCell`：`read` 要 `&mut`（执行计划按形状缓存在引擎里），而 `OnceCell` 只交得出 `&`。
#[cfg(any(windows, target_os = "macos"))]
pub struct SeeEngines {
    ocr: Option<crate::ocr::OcrEngine>,
    /// `Some(错误原文)` = 试过加载、没成。**留着错误原文**：每个平台都要在报错里把它交出去，
    /// 而不是各自复述一句"模型不在"——原文里有路径与真因（缺文件 / 文件损坏 / 版本不对）。
    ocr_error: Option<String>,
    ocr_tried: bool,
    detector: std::cell::OnceCell<Option<crate::see_detect::Detector>>,
    /// 上一帧的识别结果（`frame_key` → 裁块坐标系的文字表）。**只留一条**：`expect` 轮询每 300ms
    /// 重读同一块，画面没动那几轮全是同一帧，一条就够；留多条只是多占内存、多算几次哈希。
    last_frame: Option<(u64, Vec<ScreenText>)>,
}

#[cfg(any(windows, target_os = "macos"))]
impl Default for SeeEngines {
    fn default() -> Self {
        SeeEngines {
            ocr: None,
            ocr_error: None,
            ocr_tried: false,
            detector: std::cell::OnceCell::new(),
            last_frame: None,
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl SeeEngines {
    /// PP-OCR 引擎；`Err` = 模型或运行时库缺席，**两平台都报错、不回落**（spec 2026-09-14 §1）。
    /// 错误是 `OcrEngine::load` 的原文、**原样透传**：它以 `ocr-missing: ` / `ort-missing: ` 开头，
    /// 文本里已有缺的文件与查找的目录，这里不再套一层——前缀在句首才是上层与 recipe 失败现场
    /// 的判据。**首次失败打一行 stderr**，之后每次 `readText` 照样报同一份错。
    pub fn ocr(&mut self) -> Result<&mut crate::ocr::OcrEngine, String> {
        if !self.ocr_tried {
            self.ocr_tried = true;
            match crate::ocr::OcrEngine::load(&ocr_models_dir()) {
                Ok(e) => self.ocr = Some(e),
                Err(e) => {
                    eprintln!("[see] {e}");
                    self.ocr_error = Some(e);
                }
            }
        }
        match self.ocr.as_mut() {
            Some(e) => Ok(e),
            None => Err(self.ocr_error.clone().expect("ocr_tried 为真且 ocr 为 None 时 ocr_error 必然已填")),
        }
    }

    /// 认出这一块图上的字（PP-OCR），两个平台共用的那一条路。`img` 是**物理像素**的截图（或它
    /// 裁出来的一块），`scale` 是它相对逻辑画面的倍数（mac `cap.scale`、Windows `dpi_scale`），
    /// 交回来的框仍在 `img` 的坐标系里——调用方照旧加 region 原点、mac 再 ÷ scale 成点。
    ///
    /// **`scale > 1` 时检测在缩到逻辑 1× 的图上跑、识别从物理像素上裁**：det 的成本按面积走，
    /// 2× 的截图是 4 倍像素、4 倍时间，而 1× 上的字和 Windows 100% DPI 一样大，框一个不少
    /// （mac 2026-09-13 实测 A/B：整窗 7.3–8.5s → 2.3–3.1s，49 → 56 行）。但识别**不能**也在
    /// 1× 上跑：rec 把每行拉到高 48，14px 的行要放大 3.4 倍，同一轮 A/B 里正常字号掉字
    /// （「没事儿」→「没事」、「大概」→「概」）；物理像素上 28px 只放 1.7 倍，认得全。所以框认完
    /// × scale 换回物理坐标（`scale_boxes_back`）、再从原图上裁（`OcrEngine::recognize_boxes`）。
    /// `STREAM_OCR_PHYSICAL=1` 让检测也留在物理分辨率上（与旧行为逐字节一致，只为 A/B 量准确率）；
    /// 日志里 `ocr@det1x` / `ocr@phys` 标的就是这一格。
    ///
    /// **同一帧不重复认**：上一帧的 key（像素指纹 + cropped + 尺度）和这次一样就直接交上次的
    /// 结果——`expect` 轮询每 300ms 读一次同一块，画面没动那几轮每轮再付一次 OCR 全是白付。
    /// 模型或库缺席 → `Err`（`ocr` 的那一份原文），两平台都报错。
    pub fn ocr_texts(&mut self, img: &image::RgbImage, scale: f64, cropped: bool) -> Result<Vec<ScreenText>, String> {
        let logical = ocr_runs_logical(scale);
        let cache_on = ocr_frame_cache_enabled();
        let key = if cache_on { Some(frame_key(img, cropped, logical)) } else { None };
        if let (Some(k), Some((last_k, last))) = (key, self.last_frame.as_ref()) {
            if k == *last_k {
                eprintln!("[see-read] cache hit (same frame)");
                return Ok(last.clone());
            }
        }
        let engine = self.ocr()?;
        let lines = if logical {
            let (lw, lh) = logical_size(img.width(), img.height(), scale);
            let small = image::imageops::resize(img, lw, lh, image::imageops::FilterType::Triangle);
            let boxes = engine.detect_opts(&small, !cropped)?;
            let boxes = scale_boxes_back(boxes, scale, img.width(), img.height());
            engine.recognize_boxes(img, boxes)?
        } else {
            engine.read_opts(img, !cropped)?
        };
        let texts: Vec<ScreenText> = lines.into_iter().map(|l| ScreenText { text: l.text, rect: l.rect }).collect();
        if let Some(k) = key {
            self.last_frame = Some((k, texts.clone()));
        }
        Ok(texts)
    }

    /// 这一块图上"看起来能点"的框。
    ///
    /// 模型不在场 → 空数组，**不报错**：检测器是锦上添花的一路（`synthesize_elements` 还有
    /// a11y 和文字两档兜底），为它整条 `readElements` 失败等于用一个可选能力的缺席拖垮一个
    /// 必需能力。推理本身失败也只记一行——同理。
    pub fn detector_rects(&self, img: &image::RgbImage) -> Vec<Rect> {
        let det = self.detector.get_or_init(|| {
            let path = see_detector_path();
            if !path.exists() {
                eprintln!("[see] 检测器缺席（{}），元素表里没有 detector 那一档", path.display());
                return None;
            }
            match crate::see_detect::Detector::load(&path) {
                Ok(d) => Some(d),
                Err(e) => {
                    eprintln!("[see] 检测器读不动（{}）：{e}，元素表里没有 detector 那一档", path.display());
                    None
                }
            }
        });
        match det {
            Some(d) => d.find_clickables(img).map_err(log_see_failure).unwrap_or_default(),
            None => Vec::new(),
        }
    }
}

/// `stream-desktop see-probe <进程> [标题子串]`——**不经后端**，对一个窗口跑一次
/// `readText` + `readElements`，把两张表、窗口 rect、缩放比与各自耗时打到 stdout。
///
/// 存在的理由：识别层平时只能经 recipe runner 触发，而 runner 的第一步是抢前台——桌面锁着、
/// 或者只想看"这台机器上 OCR 到底认出了什么"的时候，整条链路一步都走不到。这条子命令只读
/// （`scope_window` + 截窗），不碰焦点、不发输入，Windows 锁屏下照常能跑（活体 2026-09-07）。
/// 输出是 JSON，一行一份，好直接喂给 `jq`。
///
/// 平台无关：只经 `Desktop` trait，两个后端共用同一份——mac 与 Windows 报出来的字段一样，
/// 才比得起来。
#[cfg(any(windows, target_os = "macos"))]
pub fn see_probe<D: crate::protocol::Desktop + Default>(process: &str, title: Option<&str>, save: Option<&std::path::Path>) {
    // 下面对同一个窗口连读两遍，第二遍要量的是识别的真实成本；同一帧缓存开着的话第二遍
    // 会命中缓存，`textMs` 报出来的就是一次哈希的价钱（几毫秒），看起来像 OCR 白送。
    // 这个进程只活这一次 probe，关掉不影响长驻 agent。
    std::env::set_var("STREAM_OCR_FRAME_CACHE", "0");
    let mut d = D::default();
    let wins = match d.windows() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("windows 失败：{e}");
            std::process::exit(2);
        }
    };
    let mut hits: Vec<_> = wins
        .iter()
        .filter(|w| w.process.eq_ignore_ascii_case(process))
        .filter(|w| title.map_or(true, |t| w.title.contains(t)))
        .collect();
    let Some(w) = hits.pop() else {
        eprintln!("no-window-match: 没有 {process}{} 的窗口；现有：{:?}", title.map(|t| format!("/{t}")).unwrap_or_default(),
            wins.iter().map(|w| format!("{}/{}", w.process, w.title)).collect::<Vec<_>>());
        std::process::exit(2);
    };
    if !hits.is_empty() {
        eprintln!("ambiguous-window: {} 有多个窗口，用标题子串挑一个：{:?}", process,
            std::iter::once(w).chain(hits.iter().copied()).map(|w| &w.title).collect::<Vec<_>>());
        std::process::exit(2);
    }
    if let Err(e) = d.scope_window(&w.id) {
        eprintln!("{e}");
        std::process::exit(2);
    }
    // 截图单独报一次尺寸：活体判据「图的宽高 == window.w/h」只有在这里才看得见（文字表不带图）。
    let shot = match d.screenshot() {
        Ok(Some(s)) => {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(&s.base64).unwrap_or_default();
            let dims = image::load_from_memory(&bytes).ok().map(|i| (i.width(), i.height()));
            // `--save`：把这一张原样写到盘上。**截图权限是按可执行文件授的**，所以在 mac 上
            // 只有 agent 自己截得到窗口（`screencapture` 经 ssh 跑会被 TCC 拒，实测 2026-09-13
            // 「could not create image from display」）——要攒一套离线图集做引擎对比，这是唯一的取图口。
            let saved = save.map(|p| match std::fs::write(p, &bytes) {
                Ok(()) => serde_json::json!(p.display().to_string()),
                Err(e) => serde_json::json!(format!("写不了 {}: {e}", p.display())),
            });
            serde_json::json!({ "bytes": bytes.len(), "imageW": dims.map(|d| d.0), "imageH": dims.map(|d| d.1), "window": s.window, "scale": s.scale, "saved": saved })
        }
        Ok(None) => serde_json::json!({ "unsupported": true }),
        Err(e) => {
            eprintln!("screenshot 失败：{e}");
            std::process::exit(1);
        }
    };
    // 文字表先跑两遍：第一遍含 OCR 模型的惰性加载与执行计划编译（长驻 agent 里只发生一次），
    // 第二遍才是每次 `readText` 的真实成本。两个数都报——冷热差一个数量级，只报一个必被误读。
    let t0 = std::time::Instant::now();
    let first = d.read_text(None);
    let cold_ms = t0.elapsed().as_millis();
    let t1 = std::time::Instant::now();
    let text = match first.and_then(|_| d.read_text(None)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("readText 失败：{e}");
            std::process::exit(1);
        }
    };
    let text_ms = t1.elapsed().as_millis();
    // 元素表也跑两遍：**不带检测器的那遍才是动作路的真实成本**（`see.text` 的动作目标不开
    // 检测器，见 spec §1），带检测器的那遍只有 `see.icon` 会付。两个数相减就是检测器的价钱，
    // 再减掉 `textMs` 就是 a11y 那一档的价钱——三档各自多少钱，写 recipe 的人才知道该怎么写。
    // **探针永远全量读（`a11y = true`）**：它是排错面，`app.a11y:false` 该不该写正是看这里
    // `kind:"a11y"` 是不是恒空——探针自己关掉了就没人能回答这一问。
    let t2 = std::time::Instant::now();
    let plain = match d.read_elements(None, false, true) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("readElements 失败：{e}");
            std::process::exit(1);
        }
    };
    let plain_ms = t2.elapsed().as_millis();
    let t3 = std::time::Instant::now();
    let elements = match d.read_elements(None, true, true) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("readElements(icons) 失败：{e}");
            std::process::exit(1);
        }
    };
    let elements_ms = t3.elapsed().as_millis();
    println!(
        "{}",
        serde_json::json!({
            "window": { "id": w.id, "process": w.process, "title": w.title, "foreground": w.foreground },
            "rect": text.window, "scale": text.scale,
            "screenshot": shot,
            // "跑的是哪一份"：引擎名 / ORT 版本 / 线程数 / 真加载到的那个库的路径（spec §2.1）。
            // 上面 `read_text` 已经成功过，所以这里恒 `Some`——引擎缺席那条路在 `read_text` 处
            // 就以 `ocr-missing` / `ort-missing` 退出了，错误不会在这里重复报第二遍。
            "engine": d.ocr_engine_info().ok().map(|i| serde_json::json!({
                "name": i.name, "version": i.version, "threads": i.threads, "lib": i.lib.display().to_string(),
            })),
            "textMs": text_ms, "coldMs": cold_ms,
            // 两个数都是**实测**，不做减法。曾经在这里报过 `a11yMs = elementsMs - textMs`
            // 和 `detectorMs = elementsIconsMs - elementsMs`，而控件树那一档是**只付一次**的
            // （超预算之后整个进程都不再问），所以第二遍根本没有那一项——减出来的
            // `detectorMs` 是负数、被 saturating_sub 夹成 0，看起来像"检测器不要钱"。
            // 两个诚实的数好过四个自洽但错的数。
            "elementsMs": plain_ms, "elementsIconsMs": elements_ms,
            "elementsPlain": plain.elements.len(),
            "a11yCount": elements.elements.iter().filter(|e| e.kind == ElementKind::A11y).count(),
            "texts": text.texts, "elements": elements.elements,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma};

    fn t(text: &str, x: i32, y: i32, w: i32, h: i32) -> ScreenText {
        ScreenText { text: text.into(), rect: r(x, y, w, h) }
    }
    fn r(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    /// 一个写着「发送」的按钮：检测器知道那儿有控件，OCR 知道那儿写着什么，缝起来才有名字。
    #[test]
    fn 检测器框包住文字就拿它当名字() {
        let out = synthesize_elements(vec![], vec![r(100, 200, 80, 30)], &[t("发送", 110, 208, 40, 14)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name.as_deref(), Some("发送"));
        assert_eq!(out[0].kind, ElementKind::Detector);
        assert_eq!(out[0].rect, r(100, 200, 80, 30), "框取检测器那份——它才是可点区域");
    }

    /// 套娃：检测器同时报出一个大容器和它里面的按钮。IoU 只有 0.09，只看 IoU 时两个都会留下，
    /// 而容器框的中心落在两个按钮中间的空隙上——点它就点空了。
    #[test]
    fn 检测器的容器框和里面的按钮算同一条_留小的() {
        let container = r(100, 200, 300, 100);
        let button = r(110, 210, 80, 30);
        assert!(iou(&container, &button) < 0.2, "IoU 低到判不出它们相关，这正是要修的");

        let out = synthesize_elements(vec![], vec![container, button.clone()], &[]);
        assert_eq!(out.len(), 1, "容器和按钮不该各占一条");
        assert_eq!(out[0].rect, button, "同档留小的——反过来会留下容器、删掉里面每个按钮");
    }

    /// 同样的几何，跨档就**不**能合——这条钉的是那把尺子的不对称，不是某一档的行为。
    /// 两个检测器框套在一起是同一个东西报了两遍；a11y 的工具栏里套着一个按钮是真的两个东西，
    /// 合并掉就少了一块能点的地方。
    #[test]
    fn 同样的套娃_同档合并跨档不合并() {
        let outer = r(0, 0, 200, 40);
        let inner = r(0, 0, 40, 40);

        let same_tier = synthesize_elements(vec![], vec![outer.clone(), inner.clone()], &[]);
        assert_eq!(same_tier.len(), 1, "两个检测器框：同一个东西报了两遍");

        let cross_tier = synthesize_elements(
            vec![Element {
                rect: outer.clone(),
                name: Some("工具栏".into()),
                kind: ElementKind::A11y,
            }],
            vec![inner.clone()],
            &[],
        );
        assert_eq!(cross_tier.len(), 2, "a11y 的工具栏 + 检测器的按钮：真的两个东西");
    }

    /// 自绘界面里大部分可点的东西只有 OCR 看得见，丢掉落单的文字等于把这条路的用途丢掉。
    #[test]
    fn 没被任何框包住的文字自己入表() {
        let out = synthesize_elements(vec![], vec![], &[t("搜索", 10, 10, 40, 14)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, ElementKind::Text);
        assert_eq!(out[0].name.as_deref(), Some("搜索"));
    }

    #[test]
    fn 一个框包住多段文字则名字按左到右拼起来() {
        let out = synthesize_elements(
            vec![],
            vec![r(0, 0, 200, 30)],
            &[t("张三", 100, 8, 40, 14), t("发来", 10, 8, 40, 14)],
        );
        assert_eq!(out[0].name.as_deref(), Some("发来张三"));
    }

    #[test]
    fn a11y_与检测器指同一个东西时合成一条_框取_a11y() {
        let a = Element {
            rect: r(100, 200, 80, 30),
            name: Some("发送".into()),
            kind: ElementKind::A11y,
        };
        let out = synthesize_elements(vec![a], vec![r(102, 201, 78, 29)], &[]);
        assert_eq!(out.len(), 1, "IoU 高就是同一个东西");
        assert_eq!(out[0].kind, ElementKind::A11y);
        assert_eq!(out[0].rect, r(100, 200, 80, 30));
    }

    #[test]
    fn 文字被检测器框包住就不再单独入表() {
        let out = synthesize_elements(vec![], vec![r(100, 200, 80, 30)], &[t("发送", 110, 208, 40, 14)]);
        assert_eq!(out.len(), 1, "同一个按钮不能既是 Detector 又是 Text 两条");
    }

    /// 没名字的 a11y 元素（自绘应用里常见的一格空 Name）也该被文字补上名字——
    /// 判据是"名字是不是空"，不是"这一档有没有 name 字段"。
    #[test]
    fn 空名字的_a11y_元素照样被文字补名() {
        let a = Element { rect: r(0, 0, 60, 20), name: None, kind: ElementKind::A11y };
        let out = synthesize_elements(vec![a], vec![], &[t("确定", 10, 4, 30, 12)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name.as_deref(), Some("确定"));
        assert_eq!(out[0].kind, ElementKind::A11y);
    }

    /// **IoU 低就是两个东西**——按钮里套一个图标不该被并掉，否则那个图标永远点不到。
    #[test]
    fn iou_不够高的两个框各自入表() {
        let a =
            Element { rect: r(0, 0, 200, 40), name: Some("工具栏".into()), kind: ElementKind::A11y };
        let out = synthesize_elements(vec![a], vec![r(0, 0, 40, 40)], &[]);
        assert_eq!(out.len(), 2, "IoU = 0.2，两个东西");
    }

    fn canvas(w: u32, h: u32, f: impl Fn(u32, u32) -> u8) -> GrayImage {
        GrayImage::from_fn(w, h, |x, y| Luma([f(x, y)]))
    }

    /// 造一张"每一块都长得不一样"的图。**必须是非线性的**：线性的
    /// `(7x + 13y) % 251` 平移之后只是整体加了个常数，而 NCC 是零均值的——常数被减掉，
    /// 于是画面上散布着一堆和模板打成 1.0 平局的位置，找到哪一个纯看扫描顺序。
    /// 实测（本 fixture 的前身）：模板抠自 (40,20)，(4,1) 处逐像素恰好都比它大 3、无一处回绕，
    /// 得分 0.999999999999999 8，先被扫到就赢了。这不是算法的错，是靶子自己有重影。
    fn speckle(x: u32, y: u32) -> u8 {
        ((x * x * 13 + y * y * 7 + x * y * 31 + x * 5 + y) % 251) as u8
    }

    #[test]
    fn finds_exact_patch_at_its_origin() {
        let hay = canvas(120, 80, speckle);
        let needle = image::imageops::crop_imm(&hay, 40, 20, 16, 12).to_image();
        let (r, score) = find_image(&hay, &needle).unwrap();
        assert_eq!((r.x, r.y, r.w, r.h), (40, 20, 16, 12));
        assert!(score > 0.999, "{score}");
    }

    #[test]
    fn scaled_needle_scores_low() {
        let hay = canvas(120, 80, speckle);
        let big = image::imageops::resize(
            &image::imageops::crop_imm(&hay, 40, 20, 16, 12).to_image(),
            32,
            24,
            image::imageops::FilterType::Nearest,
        );
        let (_, score) = find_image(&hay, &big).unwrap();
        assert!(score < 0.9, "{score}");
    }

    #[test]
    fn needle_larger_than_haystack_is_none() {
        let hay = canvas(10, 10, |_, _| 0);
        let needle = canvas(20, 5, |_, _| 0);
        assert!(find_image(&hay, &needle).is_none());
    }

    /// 纯色模板没有形状，和任何一块纯色都"完美匹配"——报个位置等于随手指一处说找到了。
    #[test]
    fn flat_needle_is_none() {
        let hay = canvas(40, 30, speckle);
        assert!(find_image(&hay, &canvas(6, 6, |_, _| 128)).is_none());
    }

    /// 一张"色块"图：8×8 的格子内是常数，格子之间由同一个非线性式子决定。
    ///
    /// **粗搜那条路只能用它测，不能用 `speckle`**：逐像素的高频噪声一缩就没了（实测粗搜会
    /// 指到 500 像素之外的地方），而那是 fixture 的性质，不是算法的。真实的窗口截图是大片
    /// 平坦色块加文字——缩一半照样认得出来，正是粗搜赖以成立的前提。
    fn blocky(x: u32, y: u32) -> u8 {
        let (bx, by) = (x / 8, y / 8);
        ((bx * bx * 13 + by * by * 7 + bx * by * 31 + bx * 5 + by) % 251) as u8
    }

    fn full_positions_of(f: impl FnOnce()) -> u64 {
        FULL_POSITIONS.with(|c| c.set(0));
        f();
        FULL_POSITIONS.with(|c| c.get())
    }

    /// 面积闸之下不缩：1080p 全搜也就一两百毫秒，绕一趟粗搜只是多两次 resize。
    #[test]
    fn coarse_factor_leaves_small_images_alone() {
        assert_eq!(coarse_factor(900, 900, 60, 30), None);
        // 4K：3840×2160÷9 = 921k，f=3 那一档才过闸
        assert_eq!(coarse_factor(3840, 2160, 100, 40), Some(3));
        // 模板太小，缩完短边不够 4 像素——整个退回全分辨率，宁可慢也不指错
        assert_eq!(coarse_factor(3840, 2160, 9, 40), None);
    }

    /// **大图上必须先粗后细。** 全分辨率 O(W·H·w·h) 在 4K 整窗上是几十秒，而 `template` 段
    /// 是稳态回放每一步都走的路。这条钉两件事：找到的还是**那个**位置（分数照旧 >0.99），
    /// 而全分辨率上算过的位置数**不到全搜的 1%**——只"找对了"证明不了后半句，不缩也找得对。
    #[test]
    fn big_haystack_refines_only_around_the_coarse_hit() {
        let hay = canvas(2400, 1200, blocky);
        let needle = image::imageops::crop_imm(&hay, 800, 400, 60, 30).to_image();
        let mut got = None;
        let counted = full_positions_of(|| got = find_image(&hay, &needle));
        let (r, score) = got.unwrap();
        assert_eq!((r.x, r.y, r.w, r.h), (800, 400, 60, 30));
        assert!(score > 0.99, "{score}");
        let all = (2400 - 60 + 1) as u64 * (1200 - 30 + 1) as u64;
        assert!(
            counted * 100 < all,
            "全分辨率上算了 {counted} 个位置，全搜是 {all} —— 粗搜没省下东西"
        );
    }

    /// **靶子贴着右下角那一档**：精修窗口 `cx±2f / cy±2f` 会越过合法左上角的上界，全靠那两下
    /// 夹取。夹错了（比如让 `x0 > x1`）在这一档才看得见——靶子在画面中间时，越界那一侧根本
    /// 走不到。而右下角恰恰是真实界面上按钮最密的地方（确定 / 关闭 / 发送都在那儿）。
    #[test]
    fn big_haystack_finds_a_target_flush_against_the_bottom_right() {
        let (hw, hh, nw, nh) = (2400u32, 1200u32, 60u32, 30u32);
        let hay = canvas(hw, hh, blocky);
        let needle = image::imageops::crop_imm(&hay, hw - nw, hh - nh, nw, nh).to_image();
        let (r, score) = find_image(&hay, &needle).unwrap();
        assert_eq!((r.x, r.y), ((hw - nw) as i32, (hh - nh) as i32));
        assert!(score > 0.99, "{score}");
    }

    /// 小图那一档一个位置都不许少算：粗搜是**优化**，不是新的取舍。
    #[test]
    fn small_haystack_still_scans_every_position() {
        let hay = canvas(120, 80, speckle);
        let needle = image::imageops::crop_imm(&hay, 40, 20, 16, 12).to_image();
        let counted = full_positions_of(|| {
            find_image(&hay, &needle).unwrap();
        });
        assert_eq!(counted, (120 - 16 + 1) as u64 * (80 - 12 + 1) as u64);
    }

    // ---- 检测在逻辑 1× 上跑：几何与缓存 key 的纯函数部分（引擎要模型文件，Linux 上测不到）。

    /// 检测器在 1× 上出的框要 × scale 才能去物理图上裁——算错一档表现是"每行裁到隔壁的字"；
    /// 越界一像素则是 `crop_imm` 直接 panic，所以贴边的框必须夹进物理图的边界。
    #[test]
    fn 检测框乘回_scale_再夹进物理图边界() {
        let boxes = vec![(r(10, 20, 30, 40), 0.9), (r(1040, 760, 12, 5), 0.8)];
        let out = scale_boxes_back(boxes, 2.0, 2098, 1528);
        assert_eq!(out[0], (r(20, 40, 60, 80), 0.9));
        // 1×（1049×764）上贴右下角的框乘回去是 2080..2104 × 1520..1530，超出 2098×1528。
        assert_eq!(out[1], (r(2080, 1520, 18, 8), 0.8), "夹在物理图边界内、分数原样");
        let out = scale_boxes_back(vec![(r(0, 0, 1049, 764), 1.0)], 2.0, 2098, 1528);
        assert_eq!(out[0].0, r(0, 0, 2098, 1528), "整图框乘回来正好是整张物理图");
    }

    /// 单个框的几何：× scale、贴边夹取、scale 1 恒等。
    #[test]
    fn 单个框乘回_scale_并夹在原图内() {
        assert_eq!(scale_rect_back(&r(10, 20, 30, 40), 2.0, 1000, 1000), r(20, 40, 60, 80));
        // 贴边那一行：缩小时四舍五入让框多出去一个像素，乘回来会越过原图边界——夹住，
        // 否则后面的裁块（`crop_imm`）会 panic。
        assert_eq!(scale_rect_back(&r(490, 380, 12, 5), 2.0, 1000, 768), r(980, 760, 20, 8));
        assert_eq!(scale_rect_back(&r(1, 1, 2, 2), 1.0, 4, 4), r(1, 1, 2, 2), "scale 1 是恒等");
    }

    #[test]
    fn 逻辑尺寸是物理尺寸除以_scale_且不放大() {
        assert_eq!(logical_size(2098, 1528, 2.0), (1049, 764));
        assert_eq!(logical_size(1049, 764, 1.0), (1049, 764));
        assert_eq!(logical_size(1049, 764, 0.5), (1049, 764), "scale ≤ 1 原样交回");
        assert_eq!(logical_size(1, 1, 3.0), (1, 1), "最小 1，不出 0 宽的图");
    }

    /// key 区分的三样东西各一条：像素、`cropped`、尺度。漏了后两样的表现是"像素一样就交
    /// 上一次的结果"——而 `cropped` 决定 det 前放不放大，结果并不一样。
    #[test]
    fn 同一帧_key_只在像素与开关都相同时相等() {
        let mut a = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 200, 200]));
        let b = a.clone();
        assert_eq!(frame_key(&a, false, true), frame_key(&b, false, true));
        assert_ne!(frame_key(&a, false, true), frame_key(&b, true, true), "cropped 翻转要变");
        assert_ne!(frame_key(&a, false, true), frame_key(&b, false, false), "尺度翻转要变");
        a.put_pixel(3, 2, image::Rgb([201, 200, 200]));
        assert_ne!(frame_key(&a, false, true), frame_key(&b, false, true), "改一个像素要变");
    }
}
