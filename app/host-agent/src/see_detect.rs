//! `see` 词汇里的 `clickables`：把一张窗口画面交给一个小模型，问"哪些地方看起来能点"。
//!
//! 分成两半，**故意的**：几何与后处理是纯算术，`Detector` 是 ort 上的一层薄壳；两半都平台无关，
//! 都能在 Linux 上被 `cargo test` 覆盖（后者带模型才跑）。生产上调它的只有有截图那一环的两个平台
//! （`see.rs` 的 `SeeEngines`）。把几何塞进推理那半、或把推理门控到平台，都等于把"框指到哪儿"
//! 这件唯一会算错的事挪出测试覆盖——而它算错的表现是点在按钮旁边几十像素处，看起来像"模型不准"。

// 这一整块的**唯一生产消费者**是下面有平台后端的推理段，所以在 Linux 上编二进制时它整个
// 是死代码。留着不是为了将来：几何算错的表现是点在按钮旁边几十像素处
// （看起来像"模型不准"），而它只有在这里才测得到——用一句 allow 换 Linux 上的覆盖是划算的。
#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]

use crate::protocol::Rect;
use image::RgbImage;

/// 模型入口边长（YOLOv8 的 `imgsz=640` 导出）。
pub const INPUT: u32 = 640;

/// letterbox 的几何：源 `src_w×src_h` 等比缩进 `size×size` 的正方形，剩下的边补灰。
/// 返回 `(缩放比 r, 左右各留的 pad_x, 上下各留的 pad_y)`，单位都是**模型输入的像素**。
///
/// 等比 + 补边而不是直接拉成正方形：拉伸会把宽窗口里的按钮压扁，模型见过的训练样本
/// 没有这种形状，掉的是召回率而不是报错——安静地少给几个框。
pub fn letterbox(src_w: u32, src_h: u32, size: u32) -> (f64, f64, f64) {
    if src_w == 0 || src_h == 0 {
        return (1.0, 0.0, 0.0);
    }
    let r = (size as f64 / src_w as f64).min(size as f64 / src_h as f64);
    let pad_x = (size as f64 - src_w as f64 * r) / 2.0;
    let pad_y = (size as f64 - src_h as f64 * r) / 2.0;
    (r, pad_x, pad_y)
}

/// 把源图 letterbox 进 `size×size`，空出来的边填 114（YOLO 系列的约定灰）。
pub fn letterbox_image(src: &RgbImage, size: u32) -> RgbImage {
    let (r, pad_x, pad_y) = letterbox(src.width(), src.height(), size);
    let nw = ((src.width() as f64 * r).round() as u32).max(1);
    let nh = ((src.height() as f64 * r).round() as u32).max(1);
    let resized = image::imageops::resize(src, nw, nh, image::imageops::FilterType::Triangle);
    let mut canvas = RgbImage::from_pixel(size, size, image::Rgb([114, 114, 114]));
    image::imageops::replace(&mut canvas, &resized, pad_x.round() as i64, pad_y.round() as i64);
    canvas
}

/// YOLOv8 的一行输出（模型输入坐标系里的 `cx, cy, w, h`）→ **源图坐标系**的框。
///
/// 反 letterbox 只有一步：先减掉补边，再除缩放比。顺序反了（先除再减）在方窗口上照样对，
/// 只在非正方形的窗口上偏——而那正是常态，所以这一步必须有测试钉着。
///
/// 出框会被裁进源图范围：模型允许框出界一点点，而出界的框换算成屏幕坐标后指向窗口外面。
pub fn yolo_to_rect(row: [f32; 4], size: u32, src_w: u32, src_h: u32) -> Rect {
    let (r, pad_x, pad_y) = letterbox(src_w, src_h, size);
    let [cx, cy, w, h] = row.map(|v| v as f64);
    let x0 = (cx - w / 2.0 - pad_x) / r;
    let y0 = (cy - h / 2.0 - pad_y) / r;
    let x1 = (cx + w / 2.0 - pad_x) / r;
    let y1 = (cy + h / 2.0 - pad_y) / r;
    let x0 = x0.round().clamp(0.0, src_w as f64);
    let y0 = y0.round().clamp(0.0, src_h as f64);
    let x1 = x1.round().clamp(0.0, src_w as f64);
    let y1 = y1.round().clamp(0.0, src_h as f64);
    Rect { x: x0 as i32, y: y0 as i32, w: (x1 - x0) as i32, h: (y1 - y0) as i32 }
}

fn iou(a: &Rect, b: &Rect) -> f64 {
    let ix = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let iy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    if ix <= 0 || iy <= 0 {
        return 0.0;
    }
    let inter = ix as f64 * iy as f64;
    let union = (a.w as f64 * a.h as f64) + (b.w as f64 * b.h as f64) - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// 非极大值抑制：同一个按钮模型常给出好几个几乎重合的框，留分最高的那个。
///
/// 不做这一步的代价不是"多几个框"，而是上层给候选编号时同一个按钮占掉三四个号——
/// 梯子那一段的编号本来就是给人/模型读的，重号让它读起来像有三个不同的目标。
pub fn nms(mut boxes: Vec<(Rect, f32)>, iou_thresh: f64) -> Vec<Rect> {
    boxes.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Rect> = Vec::new();
    for (rect, _) in boxes {
        if kept.iter().all(|k| iou(k, &rect) <= iou_thresh) {
            kept.push(rect);
        }
    }
    kept
}

/// 置信度下限与保留上限。0.3 是 YOLO 系列常用的展示阈值；200 是"一屏上可点的东西"的
/// 合理上界——再多就不是界面而是噪声，而下游要把它们逐个编号送给模型读。
pub const MIN_SCORE: f32 = 0.3;
pub const MAX_KEEP: usize = 200;
pub const IOU: f64 = 0.5;

/// 输出形状必须**恰好**是 `[1, 5, N]`——单类的 `icon_detect` 导出就是这个形状。
/// 回 `N`（候选个数），认不出的形状回 Err。
///
/// **宽松地判这里等于制造假框**：转置过的导出 `[1, 8400, 5]` 在 `len == 3 && shape[1] >= 5`
/// 下能过关，然后 `at(k, i)` 逐个读到错位的数——出来的不是错误，是几个**看起来很合理**的框。
/// 上层拿它去点，点在没有控件的地方；而日志、回包、活体截图三处都不会喊。宁可整条 op 报错。
pub fn candidate_count(shape: &[usize]) -> Result<usize, String> {
    if shape.len() == 3 && shape[0] == 1 && shape[1] == 5 {
        return Ok(shape[2]);
    }
    Err(format!(
        "see-detector: 输出形状 {shape:?} 不是我们认的 [1,5,N]。\
         这一版只吃单类的 icon_detect 导出（`yolo export format=onnx imgsz=640`，输出 [1,5,8400]）；\
         若形状是 [1,N,5] 则是转置过的导出，照读会出一批看似合理的假框，所以这里直接拒。"
    ))
}

/// `[1, 5, 8400]` 的原始输出 → 源图坐标系的框。`at(k, i)` 取第 `i` 个候选的第 `k` 个通道
/// （0..3 是 cx/cy/w/h，4 是置信度）——这样签名就不绑定任何一个推理运行时，能在 Linux 上测。
pub fn rows_to_rects(
    n: usize,
    at: impl Fn(usize, usize) -> f32,
    src_w: u32,
    src_h: u32,
) -> Vec<Rect> {
    let mut cand: Vec<(Rect, f32)> = Vec::new();
    for i in 0..n {
        let score = at(4, i);
        if score < MIN_SCORE {
            continue;
        }
        let r = yolo_to_rect([at(0, i), at(1, i), at(2, i), at(3, i)], INPUT, src_w, src_h);
        // 0 面积的框点不了，也占一个编号。
        if r.w > 0 && r.h > 0 {
            cand.push((r, score));
        }
    }
    let mut kept = nms(cand, IOU);
    kept.truncate(MAX_KEEP);
    kept
}

// ── 推理本体 ────────────────────────────────────────────────────────────────
//
// 推理走 ort，同 `ocr.rs`（运行时库由 `crate::ocr::ensure_ort_loaded` 统一 dlopen，与 OCR 谁先谁后都行）。
// 这一段**不再按平台门控**：ort 与 ndarray 都是通用依赖，而"模型读得进、框指到图内"这条唯一的活体闸门
// 只有在 Linux 的 `cargo test` 上才跑得到（下面 `mod tests` 带模型才跑的那条）。
mod session {
    use super::*;

    pub struct Detector {
        /// `Mutex`：ort 的 `run` 要 `&mut`，而 `see.rs` 从 `OnceCell` 里只交得出 `&`。
        sess: std::sync::Mutex<ort::session::Session>,
        input: String,
    }

    impl Detector {
        pub fn load(path: &std::path::Path) -> Result<Detector, String> {
            crate::ocr::ensure_ort_loaded(&crate::see::ocr_models_dir())?;
            let sess = ort::session::Session::builder()
                .map_err(|e| format!("ort builder: {e}"))?
                .with_intra_threads(crate::ocr::ort_threads())
                .map_err(|e| format!("ort 线程数设不了: {e}"))?
                .commit_from_file(path)
                .map_err(|e| format!("检测器打不开 {}: {e}", path.display()))?;
            let input = sess
                .inputs()
                .first()
                .map(|i| i.name().to_string())
                .ok_or_else(|| "检测器没有输入".to_string())?;
            Ok(Detector { sess: std::sync::Mutex::new(sess), input })
        }

        /// 一张窗口画面 → 可点框（**截图坐标系**，同 `texts[].rect`）。
        pub fn find_clickables(&self, rgb: &RgbImage) -> Result<Vec<Rect>, String> {
            let (src_w, src_h) = rgb.dimensions();
            let boxed = letterbox_image(rgb, INPUT);
            let shape = [1usize, 3, INPUT as usize, INPUT as usize];
            let data: Vec<f32> = ndarray::Array4::from_shape_fn(
                (1, 3, INPUT as usize, INPUT as usize),
                |(_, c, y, x)| boxed.get_pixel(x as u32, y as u32).0[c] as f32 / 255.0,
            )
            .into_iter()
            .collect();
            let tensor = ort::value::Tensor::from_array((shape, data)).map_err(|e| format!("检测器输入建不了: {e}"))?;
            let mut s = self.sess.lock().map_err(|_| "检测器 session 锁坏了".to_string())?;
            let outputs = s
                .run(ort::inputs![self.input.as_str() => tensor])
                .map_err(|e| format!("检测器跑不动(ort): {e}"))?;
            let (_, v) = outputs.iter().next().ok_or_else(|| "检测器没有输出".to_string())?;
            let (oshape, odata) = v.try_extract_tensor::<f32>().map_err(|e| format!("检测器输出读不了(ort): {e}"))?;
            let dims: Vec<usize> = oshape.iter().map(|&d| d as usize).collect();
            let n = candidate_count(&dims)?;
            let view = ndarray::ArrayView3::from_shape((dims[0], dims[1], dims[2]), odata)
                .map_err(|e| format!("检测器输出形状对不上: {e}"))?;
            Ok(rows_to_rects(n, |k, i| view[[0, k, i]], src_w, src_h))
        }
    }
}

pub use session::Detector;

#[cfg(test)]
mod tests {
    use super::*;

    /// 重合的框只留分最高的那个；离得远的互不影响。
    #[test]
    fn nms_drops_overlapping_lower_score_boxes() {
        let boxes = vec![
            (Rect { x: 0, y: 0, w: 100, h: 50 }, 0.9),
            (Rect { x: 5, y: 3, w: 100, h: 50 }, 0.8),
            (Rect { x: 300, y: 300, w: 20, h: 20 }, 0.7),
        ];
        let kept = nms(boxes, 0.5);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].x, 0, "留下的必须是分最高的那个");
    }

    /// 输入顺序不该影响结果：分最高的赢，不是先来的赢。
    #[test]
    fn nms_keeps_the_highest_score_not_the_first() {
        let boxes = vec![
            (Rect { x: 5, y: 3, w: 100, h: 50 }, 0.4),
            (Rect { x: 0, y: 0, w: 100, h: 50 }, 0.95),
        ];
        let kept = nms(boxes, 0.5);
        assert_eq!(kept.len(), 1);
        assert_eq!((kept[0].x, kept[0].y), (0, 0));
    }

    /// 模型入 640×640、源 1280×720：长边定倍率 r = 640/1280 = 0.5，短边 720×0.5 = 360，
    /// 上下各补 (640-360)/2 = 140。于是 `cx,cy,w,h = 320,320,64,32` 手算：
    ///   x0 = 320 - 32 - 0   = 288 → /0.5 = 576
    ///   y0 = 320 - 16 - 140 = 164 → /0.5 = 328
    ///   w  = 64 / 0.5 = 128，h = 32 / 0.5 = 64
    /// **减补边必须在除倍率之前**：反过来在非正方形窗口上会整体偏 140×0.5 那一档。
    #[test]
    fn yolo_row_to_rect_scales_back_to_source() {
        let r = yolo_to_rect([320.0, 320.0, 64.0, 32.0], 640, 1280, 720);
        assert_eq!((r.x, r.y, r.w, r.h), (576, 328, 128, 64));
    }

    /// 正方形源图不补边——这一档是上面那条测试的对照：它在"顺序反了"的实现里也过，
    /// 所以单靠它证明不了反 letterbox 是对的。
    #[test]
    fn yolo_row_to_rect_on_a_square_source_has_no_padding() {
        let r = yolo_to_rect([320.0, 320.0, 64.0, 64.0], 640, 1000, 1000);
        assert_eq!((r.x, r.y, r.w, r.h), (450, 450, 100, 100));
    }

    /// 往返：源图上的一个框 → 正着 letterbox 进模型坐标 → `yolo_to_rect` 反回来，
    /// 必须回到原处（取整误差 ≤1px）。这是"几何写对了"的唯一自证。
    #[test]
    fn letterbox_round_trips_a_source_rect() {
        for (sw, sh) in [(1280u32, 720u32), (720, 1280), (1000, 1000), (2560, 1440)] {
            let (r, pad_x, pad_y) = letterbox(sw, sh, INPUT);
            let (x, y, w, h) = (100.0f64, 60.0, 240.0, 90.0);
            let cx = (x + w / 2.0) * r + pad_x;
            let cy = (y + h / 2.0) * r + pad_y;
            let got = yolo_to_rect([cx as f32, cy as f32, (w * r) as f32, (h * r) as f32], INPUT, sw, sh);
            assert!(
                (got.x - x as i32).abs() <= 1 && (got.y - y as i32).abs() <= 1,
                "{sw}x{sh}: 原点回不去 {got:?}"
            );
            assert!(
                (got.w - w as i32).abs() <= 1 && (got.h - h as i32).abs() <= 1,
                "{sw}x{sh}: 尺寸回不去 {got:?}"
            );
        }
    }

    /// 出界的框裁进源图：模型允许框超出画面一点，而超出的部分换算成屏幕坐标后指向窗口外。
    #[test]
    fn yolo_to_rect_clamps_to_the_source() {
        let r = yolo_to_rect([0.0, 320.0, 200.0, 40.0], 640, 1280, 720);
        assert_eq!(r.x, 0);
        assert!(r.x + r.w <= 1280);
    }

    /// 低分候选不进结果，剩下的按 NMS 合并——这一层是 `Detector` 真正调的那个函数，
    /// 用一个假的 `at` 把它和推理运行时解耦，于是它在 Linux 上也有覆盖。
    #[test]
    fn rows_to_rects_filters_by_score_and_merges() {
        // 三个候选：两个高分且重合、一个低分。
        let rows: [[f32; 5]; 3] = [
            [320.0, 320.0, 64.0, 32.0, 0.9],
            [322.0, 321.0, 64.0, 32.0, 0.8],
            [100.0, 100.0, 64.0, 32.0, 0.1],
        ];
        let got = rows_to_rects(3, |k, i| rows[i][k], 1280, 720);
        assert_eq!(got.len(), 1, "重合的合并、低分的丢掉：{got:?}");
        assert_eq!(got[0].x, 576);
    }

    /// 转置过的导出 `[1, 8400, 5]` **必须报错，不许照读**：宽松判据（`shape[1] >= 5`）下它
    /// 能过关，然后逐个读到错位的数——出来的不是错误，是几个看起来很合理的假框，上层拿它
    /// 去点会点在没有控件的地方，而三处都不会喊。错误里要带上真实形状，否则没法排查。
    #[test]
    fn candidate_count_rejects_a_transposed_export() {
        assert_eq!(candidate_count(&[1, 5, 8400]).unwrap(), 8400);
        let err = candidate_count(&[1, 8400, 5]).unwrap_err();
        assert!(err.contains("[1, 8400, 5]"), "错误里要带真实形状：{err}");
        assert!(err.contains("转置"), "要点名这一档是转置导出：{err}");
        // 多类导出（[1, 4+C, N]）同样不认——这一版的后处理把第 4 通道当唯一的置信度。
        assert!(candidate_count(&[1, 6, 8400]).is_err());
        assert!(candidate_count(&[5, 8400]).is_err());
    }

    /// `letterbox_image` 与 `yolo_to_rect` 必须用**同一套** letterbox 几何：前者按 `round`
    /// 落像素、后者按浮点 pad 反算，两边差 1px 就让每个框整体偏一格，而没有任何东西会红。
    /// 判法是打一个标记像素，看它落在 `letterbox()` 自己算出来的那个位置上。
    #[test]
    fn letterbox_image_puts_a_marked_pixel_where_the_geometry_says() {
        let (sw, sh) = (1280u32, 720u32); // 非正方形，pad 才不是 0
        let (mx, my) = (400u32, 300u32);
        let mut src = RgbImage::from_pixel(sw, sh, image::Rgb([0, 0, 0]));
        src.put_pixel(mx, my, image::Rgb([255, 0, 0]));
        let out = letterbox_image(&src, INPUT);

        let (r, pad_x, pad_y) = letterbox(sw, sh, INPUT);
        let (ex, ey) = ((mx as f64 * r + pad_x).round() as u32, (my as f64 * r + pad_y).round() as u32);
        // 双线性缩放会把这一点抹开，所以判"最红的那个像素在哪儿"，不判某个像素恰好是纯红。
        let mut best = (0u32, 0u32, -1i32);
        for (x, y, p) in out.enumerate_pixels() {
            let redness = p.0[0] as i32 - p.0[1] as i32;
            if redness > best.2 {
                best = (x, y, redness);
            }
        }
        assert!(best.2 > 0, "标记点在缩放后整个没了");
        // **判等，不留 ±1 的余地**：这条测试存在的理由就是抓 1px 的错位（`round` 落像素
        // 与浮点 pad 反算之间的分歧），容忍 1px 等于把要抓的那件事放过去。
        assert_eq!((best.0, best.1), (ex, ey), "标记点落错了格子；几何说该在 ({ex}, {ey})");

        // 四角必须是补边灰 114：补边值变了，模型看到的是一圈它没见过的颜色。
        assert_eq!(out.dimensions(), (INPUT, INPUT));
        for (x, y) in [(0, 0), (INPUT - 1, 0), (0, INPUT - 1), (INPUT - 1, INPUT - 1)] {
            assert_eq!(out.get_pixel(x, y).0, [114, 114, 114], "角 ({x}, {y}) 不是补边灰");
        }
    }

    /// 上限 200：一屏上再多就不是界面而是噪声，而下游要把它们逐个编号送给模型读。
    #[test]
    fn rows_to_rects_caps_the_count() {
        let n = 500;
        let got = rows_to_rects(
            n,
            |k, i| match k {
                0 => (i % 25) as f32 * 25.0 + 12.0,
                1 => (i / 25) as f32 * 25.0 + 12.0,
                2 | 3 => 8.0,
                _ => 0.9,
            },
            1000,
            1000,
        );
        assert_eq!(got.len(), MAX_KEEP);
    }

    /// 带真模型跑一遍 `Detector`（`STREAM_OCR_MODELS` 指的目录里要有 `see-detector.onnx` 与运行时库；
    /// 没设就跳过，同 `ocr.rs` 的约定）。判据不是"框有多准"——那要标注真值——而是这条 ort 接线
    /// 本身：模型读得进、输出形状是我们认的 `[1,5,N]`（否则 `candidate_count` 就报错了）、
    /// 一张真实窗口截图上至少认出一个可点的东西、每个框都落在图内。上层拿框去点，出界的框指向窗外。
    #[test]
    fn detector_finds_clickables_inside_a_real_screenshot() {
        let Some(dir) = std::env::var_os("STREAM_OCR_MODELS").map(std::path::PathBuf::from) else {
            eprintln!("STREAM_OCR_MODELS 没设，跳过");
            return;
        };
        let model = dir.join("see-detector.onnx");
        if !model.is_file() {
            eprintln!("{} 不在场，跳过", model.display());
            return;
        }
        let det = {
            // `load` 经 `ensure_ort_loaded` 读 `STREAM_ORT_LIB`，与 `ocr.rs` 里改它的用例共握一把锁。
            let _g = crate::ocr::tests::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            Detector::load(&model).expect("检测器该能读进来")
        };
        let img = image::open("tests/fixtures/wx1.jpg").unwrap().to_rgb8();
        let (w, h) = (img.width() as i32, img.height() as i32);
        let rects = det.find_clickables(&img).expect("推理该能跑");
        assert!(!rects.is_empty(), "一张真实的微信窗口上一个可点的东西都没认出来");
        assert!(rects.len() <= MAX_KEEP);
        for r in &rects {
            assert!(r.w > 0 && r.h > 0, "0 面积的框：{r:?}");
            assert!(
                r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h,
                "框出了图 {w}x{h}：{r:?}"
            );
        }
    }
}
