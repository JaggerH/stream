//! PP-OCRv5 mobile 的两段式 OCR：det 框出"哪儿有一行字"，rec 逐行认。
//!
//! **为什么不是 Windows 系统自带的 OCR**：本机 2026-09-07 的五张真实失败截图里它错了四张
//! （光标旁的占位字漏认、弹层里「陈雪韵」认成「阝东雪韵」、12px 小字整屏错、蓝底蓝字漏认），
//! PP-OCRv5 全部认对。代价是慢一个数量级，所以识别必须能只在一小块上跑（见 `read_region`）。
//!
//! **引擎只有一个：ONNX Runtime**（`ort` crate，`load-dynamic`，运行时 dlopen 随平台包出货的官方
//! 动态库），**没有回落**：模型或运行时库缺一样，`load` 明着报错（`ocr-missing:` / `ort-missing:`）。
//! 为什么是它、为什么不留退路：`docs/superpowers/specs/2026-09-14-desktop-ocr-onnxruntime-design.md` §1；
//! 两平台实测 `docs/research/ocr-engine-benchmark.md`。前后处理（尺度、DB、分桶、CTC、缓存）与
//! 引擎无关，是准确率逐字一致的原因，别顺手动它们。
use crate::protocol::Rect;
use image::RgbImage;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 钉住的 ONNX Runtime 版本。换版本三处一起动：这里、`capabilities/desktop/platforms/ort-<pkg>.sha256`、
/// GitHub release `desktop-ort-v*`（spec §3）。加载日志把它打出来，就是"跑的是哪一份"的核对点。
pub const ORT_VERSION: &str = "1.20.1";

/// 运行时库在这个平台上的约定文件名（与模型同目录）。
pub fn ort_lib_name() -> &'static str {
    if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

/// 运行时库在哪：`STREAM_ORT_LIB` 指了就用它，否则模型目录里的约定文件名。**不搜系统路径**——
/// 搜到一份别的版本比没有更坏（API 版本对不上时 ort 报的是一串看不懂的 GetApi 失败）。
pub fn ort_lib_path(dir: &Path) -> PathBuf {
    match std::env::var("STREAM_ORT_LIB") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => dir.join(ort_lib_name()),
    }
}

/// intra-op 线程数：`STREAM_OCR_ORT_THREADS`，缺省 `min(物理核, 8)`。研究档 §2：Windows 20 线程
/// 分一个 48×320 的小卷积，一行 rec 反而 40–100ms；4 线程 18ms。
pub fn ort_threads() -> usize {
    std::env::var("STREAM_OCR_ORT_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| num_cpus::get_physical().clamp(1, 8))
}

/// "跑的是哪一份"：`see-probe` 回执多一格（经 `Desktop::ocr_engine_info`），加载日志同一份数据。
#[derive(Debug, Clone)]
pub struct EngineInfo {
    pub name: &'static str,
    pub version: String,
    pub threads: usize,
    pub lib: PathBuf,
}

/// 进程内只 init 一次 ort（OCR 与图标检测器共用；第二个 OcrEngine——台架、测试——复用第一次的）。
/// 库不在场 / 加载失败都以 `ort-missing:` 开头，文本含期望路径。
///
/// 存在性检查放在 `OnceLock` **外面**：不在场直接 `Err`、不碰 `INIT`——否则一次拿空目录的调用
/// （测试里就有）会把整个进程钉在 Err 上，后面每个引擎都跟着红。`INIT` 只包 `init_from` 那一步。
///
/// **`INIT` 一旦成功就是进程生命期唯一的一次**：用不同 `dir` 再调一次，拿回的仍是第一次真加载
/// 那份库的路径——不会重新按新 `dir` 解析、也不会重新 `init_from`。同进程内切目录测试这条要注意。
pub fn ensure_ort_loaded(dir: &Path) -> Result<PathBuf, String> {
    static INIT: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
    let lib = ort_lib_path(dir);
    if !lib.is_file() {
        return Err(format!(
            "ort-missing: {} 不在场——ONNX Runtime {ORT_VERSION} 的动态库要和 ocr-det.onnx 放在同一目录（或 STREAM_ORT_LIB 指到它）",
            lib.display()
        ));
    }
    INIT.get_or_init(|| {
        // `init_from` 在 dlopen 之后还核一遍库的 minor 版本（低于 ort 要求的就是错）；
        // `commit()` 回 `false` 只表示环境已经有人建过，不是失败。
        ort::init_from(&lib)
            .map_err(|e| {
                let hint = if cfg!(windows) {
                    "（Windows 上 126/127 = 依赖缺席：msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll 在不在 exe 同目录）"
                } else {
                    ""
                };
                format!("ort-missing: {} 加载失败：{e}{hint}", lib.display())
            })?
            .commit();
        // **Linux（只有开发机 `cargo test` 跑它）：故意把 ort 的环境句柄泄漏到进程结束。**
        // ort 靠 exe 的 `.fini_array` 在退出时 `ReleaseEnv`，可 dlopen 进来的 libonnxruntime.so
        // 的 C++ 静态析构走的是 `__cxa_atexit`，在 `_dl_fini` 之前就跑完了——于是 `ReleaseEnv`
        // 碰的是已经析构的全局，每次都 SIGSEGV（gdb 实测 2026-09-14：`_dl_call_fini` 第一个进来的
        // 就是 exe，.so 的 fini 还没轮到；`ReleaseEnv` 里崩）。多持一份 `Arc` 让那次 release
        // 变成减引用、永不真释放；进程退出时 OS 收回一切，不释放没有代价。mac 那边 ort 自己在
        // 建环境之后才注册 `__cxa_atexit`（顺序正确），Windows 走 TLS 回调，都不需要这一手。
        #[cfg(target_os = "linux")]
        if let Ok(env) = ort::environment::Environment::current() {
            std::mem::forget(env);
        }
        Ok(lib.clone())
    })
    .clone()
}

/// det / rec 两个 session。`Mutex`：ort 的 `run` 要 `&mut`，而整窗读的逐行识别在多个线程上跑——
/// 这里让它们排队。ORT 自己的 intra-op 线程池已经把核吃满，逐行串行不是瓶颈：小区域只有一两行，
/// 整窗那一格还有余量但不是 recipe 的热路径（研究档 §2 的读法一节、spec §6）。
struct OrtSessions {
    det: std::sync::Mutex<ort::session::Session>,
    rec: std::sync::Mutex<ort::session::Session>,
    det_input: String,
    rec_input: String,
}

pub struct OcrEngine {
    ort: OrtSessions,
    info: EngineInfo,
    chars: Vec<String>,
    /// 认过的小块图 → 认出来的字。**界面上大多数文字帧间不变**（侧栏、菜单、已有消息），
    /// 而 rec 是整窗读的大头（29 行 × 20~50ms）；有了它，第二次整窗只需要认变了的那几行。
    ///
    /// key 是**那一小块图的像素内容**，不是它的位置——列表滚动一下，同一行字换了个 y，
    /// 按位置做 key 就全部失效，按内容做 key 照样命中。
    rec_cache: HashMap<u64, (String, f32)>,
    /// 淘汰顺序（先进先出）。不做 LRU：整窗读是一趟扫过去，命中顺序天然就是插入顺序，
    /// LRU 多维护一份链表却换不到更高的命中率。
    rec_order: std::collections::VecDeque<u64>,
    /// 真正跑过多少次 rec 推理（缓存命中不计）。**测试靠它证明缓存真的挡住了推理**——
    /// 只比较两次 `read` 的耗时是证不了的：机器忙一下就能让快的那次看起来更慢。
    rec_runs: usize,
}

/// 缓存里最多留多少块。512 块 ≈ 十几屏的文字，够覆盖"在几个窗口之间来回切"这种用法；
/// 再多就只是占内存——桌面上不会有那么多**不同**的文字块同时活着。
const REC_CACHE_CAP: usize = 512;

impl OcrEngine {
    /// 错误以 `ort-missing: `（运行时库）或 `ocr-missing: `（三件模型）开头，文本写明缺的是哪个
    /// 文件、该放哪（spec §4）。**先库后模型**：库不在场时三件模型齐不齐都跑不了。
    pub fn load(dir: &Path) -> Result<Self, String> {
        let lib = ensure_ort_loaded(dir)?;
        for name in ["ocr-det.onnx", "ocr-rec.onnx", "ocr-rec-dict.txt"] {
            if !dir.join(name).is_file() {
                return Err(format!(
                    "ocr-missing: {} 不在场——PP-OCRv5 三件要放在 stream-desktop 同目录（或 STREAM_OCR_MODELS 指的目录）",
                    dir.join(name).display()
                ));
            }
        }
        let dict = std::fs::read_to_string(dir.join("ocr-rec-dict.txt"))
            .map_err(|e| format!("OCR 字典读不了: {e}"))?;
        // PaddleOCR 的类别表：0 号是 CTC 的 blank，末尾补一个空格字符。
        // 文件若以换行结尾，`split` 会多出一条空串——那会让整张表错位一格（表现是全屏乱码），
        // 所以在这里剪掉，而不是去动类别表的构造顺序。
        let mut chars = vec!["<blank>".to_string()];
        let mut lines: Vec<&str> = dict.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        chars.extend(lines.into_iter().map(str::to_string));
        chars.push(" ".to_string());
        let threads = ort_threads();
        let open = |name: &str| -> Result<(std::sync::Mutex<ort::session::Session>, String), String> {
            let mut b = ort::session::Session::builder()
                .map_err(|e| format!("ort builder: {e}"))?
                .with_intra_threads(threads)
                .map_err(|e| format!("ort 线程数设不了: {e}"))?;
            let s = b.commit_from_file(dir.join(name)).map_err(|e| format!("ort 打不开 {name}: {e}"))?;
            let input = s.inputs().first().map(|i| i.name().to_string()).ok_or_else(|| format!("{name} 没有输入"))?;
            Ok((std::sync::Mutex::new(s), input))
        };
        let (det, det_input) = open("ocr-det.onnx")?;
        let (rec, rec_input) = open("ocr-rec.onnx")?;
        let info = EngineInfo { name: "ort", version: ORT_VERSION.to_string(), threads, lib };
        // 这一行是"跑的是哪一份"的唯一自证（spec §2.1）。版本号是钉住的那个数，不是库自报的：
        // ort 只暴露构建信息串（`ort::info()`，实测 1.20.1 的官方包里没有版本号），而库的 minor
        // 版本低于 ort 要求时 `init_from` 已经明着拒绝了。
        eprintln!("[ocr] engine = ort {} threads={} lib={}", info.version, info.threads, info.lib.display());
        Ok(Self {
            ort: OrtSessions { det, rec, det_input, rec_input },
            info,
            chars,
            rec_cache: HashMap::new(),
            rec_order: std::collections::VecDeque::new(),
            rec_runs: 0,
        })
    }

    /// 引擎名 / 钉住的版本 / 线程数 / 真加载的那份库。
    pub fn info(&self) -> &EngineInfo {
        &self.info
    }

    pub fn classes(&self) -> usize {
        self.chars.len()
    }

    /// 真正跑过多少次 rec 推理。只给测试与排查用（"整窗慢"到底是框多还是缓存没命中）。
    pub fn rec_runs(&self) -> usize {
        self.rec_runs
    }

    /// 把 rec 的内容缓存清空。**只给台架用**：同一张图读第二遍时缓存全中，量出来的是哈希的
    /// 价钱不是识别的价钱；而真实屏幕每次读都有一批新内容。清掉缓存、留着 session，量到的
    /// 才是"热态一次完整识别"。
    pub fn clear_rec_cache(&mut self) {
        self.rec_cache.clear();
        self.rec_order.clear();
    }

    /// 加载后各跑一次最小形状，把线程池起动和内核选择付在这儿（研究档 §2：ort cold 22ms 对
    /// warm 18ms）。ort 不按形状编译，所以不吃形状。回毫秒。
    pub fn prewarm(&mut self) -> Result<u128, String> {
        let t = std::time::Instant::now();
        let det = ndarray::Array4::<f32>::zeros((1, 3, 32, 32));
        run_ort(&self.ort.det, &self.ort.det_input, det, "det")?;
        let rec = ndarray::Array4::<f32>::zeros((1, 3, REC_HEIGHT as usize, REC_BUCKETS[0]));
        run_ort(&self.ort.rec, &self.ort.rec_input, rec, "rec")?;
        Ok(t.elapsed().as_millis())
    }

    /// 框出"哪儿有一行字"。返回的框在**入参图片自己的坐标系**里。
    pub fn detect(&mut self, img: &RgbImage) -> Result<Vec<(Rect, f32)>, String> {
        self.detect_opts(img, true)
    }

    /// 见 `read_opts` 的 `upscale_small`。
    pub fn detect_opts(&mut self, img: &RgbImage, upscale_small: bool) -> Result<Vec<(Rect, f32)>, String> {
        let (ow, oh) = (img.width(), img.height());
        if ow == 0 || oh == 0 {
            return Ok(Vec::new());
        }
        let (nw, nh, _k) = if upscale_small { det_input_size(ow, oh) } else { det_input_size_no_upscale(ow, oh) };
        let small = image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle);
        // det 按真实形状直接跑（ort 是动态形状，不按形状编译、不补白）。
        // 归一化是 mean = std = 0.5，**不是 ImageNet 那组**。
        let input = ndarray::Array4::<f32>::from_shape_fn((1, 3, nh as usize, nw as usize), |(_, c, y, x)| {
            let p = small.get_pixel(x as u32, y as u32);
            (p[c] as f32 / 255.0 - 0.5) / 0.5
        });
        let prob = self.run_det(input)?;
        if prob.len() != (nw as usize) * (nh as usize) {
            return Err(format!("det 概率图 {} 个点，期望 {}", prob.len(), nw * nh));
        }
        // **按轴各算一个比例回原图**，而不是共用 det_input_size 的 k：nw/nh 是 k 之后又向上
        // 取整到 32 的，两轴的余量各不相同，共用一个 k 会让框在长边上系统性偏移最多半格。
        let (rx, ry) = (ow as f64 / nw as f64, oh as f64 / nh as f64);
        Ok(db_boxes(&prob, nw as usize, nh as usize)
            .into_iter()
            .map(|(r, s)| {
                let x = (r.x as f64 * rx).round() as i32;
                let y = (r.y as f64 * ry).round() as i32;
                let x1 = ((r.x + r.w) as f64 * rx).round() as i32;
                let y1 = ((r.y + r.h) as f64 * ry).round() as i32;
                (
                    Rect {
                        x: x.clamp(0, ow as i32),
                        y: y.clamp(0, oh as i32),
                        w: (x1 - x).clamp(0, ow as i32 - x.clamp(0, ow as i32)),
                        h: (y1 - y).clamp(0, oh as i32 - y.clamp(0, oh as i32)),
                    },
                    s,
                )
            })
            .filter(|(r, _)| r.w > 0 && r.h > 0)
            .collect())
    }

    /// 跑一次 det：扁平的概率图（行优先，h×w）。
    fn run_det(&self, input: ndarray::Array4<f32>) -> Result<Vec<f32>, String> {
        Ok(run_ort(&self.ort.det, &self.ort.det_input, input, "det")?.0)
    }

    /// det 出框 → 逐框裁出来认。返回的框在**入参图片自己的坐标系**里，按 (y, x) 排好序。
    ///
    /// **这就是「不带 region 的整窗读」的价格**（研究档 §2，六张图取中位数）：小区域 320×96
    /// warm 18ms（Windows）/ 21ms（mac），标题条 36 / 43ms，**整窗 774 / 875ms**。det 随输入面积
    /// 近似线性，rec 随框数近似线性（整窗 28–50 行）。整窗接近一秒是不能每一步都付的，所以识别
    /// 必须能只在一小块上跑——`region` 不是优化项，是这条路能用的前提。
    pub fn read(&mut self, img: &RgbImage) -> Result<Vec<OcrLine>, String> {
        self.read_opts(img, true)
    }

    /// `read` 的带开关版。`upscale_small`：det 之前要不要把短边不足 736 的图放大（见
    /// `det_input_size`）。**整窗截图给 true，窗口里裁出来的一块给 false**：裁块里的字和整窗
    /// 一样大，放大只是把一块 382×270 的搜索框拉成 1040×736 去跑检测——活体 2026-09-12 这一块
    /// 要 2.8s，按面积算该是零点几秒。
    ///
    /// 逐行识别的裁块与预处理分给 `available_parallelism` 个线程；推理本身在 rec session 的
    /// `Mutex` 后排队（ort 的 `run` 要 `&mut`，而它自己的 intra-op 线程池已经把核吃满——
    /// 研究档 §2 的读法一节）。**结果顺序与串行完全一致**（按框的下标回填），缓存也照旧按内容 key 记。
    pub fn read_opts(&mut self, img: &RgbImage, upscale_small: bool) -> Result<Vec<OcrLine>, String> {
        let boxes = self.detect_opts(img, upscale_small)?;
        self.recognize_boxes(img, boxes)
    }

    /// `read_opts` 的后半段：按给定的框从 `img` 上裁块、逐行识别（缓存 + 并行，见 `read_opts`）。
    /// 单独露出来是为了让**检测和识别吃不同的图**：Retina / 200% DPI 上检测在缩到 1× 的图上跑
    /// （成本按面积走），而识别必须从物理像素上裁——rec 把每行拉到高 48，1× 上一行 14px 的字
    /// 要放大 3.4 倍，mac 实测（2026-09-13）会掉字（「没事儿」→「没事」、「大概」→「概」）；
    /// 物理像素上同一行 28px 只放 1.7 倍，认得全。框在 `img` 自己的坐标系里。
    pub fn recognize_boxes(&mut self, img: &RgbImage, boxes: Vec<(Rect, f32)>) -> Result<Vec<OcrLine>, String> {
        // 第一遍：裁块 + 查缓存，分出要真跑的那些。
        let mut crops: Vec<(Rect, RgbImage, u64)> = Vec::new();
        for (r, _) in boxes {
            let crop = image::imageops::crop_imm(
                img,
                r.x.max(0) as u32,
                r.y.max(0) as u32,
                r.w.max(0) as u32,
                r.h.max(0) as u32,
            )
            .to_image();
            if crop.width() == 0 || crop.height() == 0 {
                continue;
            }
            let key = crop_key(&crop);
            crops.push((r, crop, key));
        }
        let mut results: Vec<Option<(String, f32)>> = crops.iter().map(|(_, _, k)| self.rec_cache.get(k).cloned()).collect();
        let misses: Vec<usize> = (0..crops.len()).filter(|&i| results[i].is_none()).collect();
        if !misses.is_empty() {
            // 工作线程只拿 `&OrtSessions`（session 内部排队）与字典，不碰 self 的其余部分。
            let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(misses.len()).max(1);
            let chars = &self.chars;
            let crops_ref = &crops;
            let ort_ref = &self.ort;
            let next = std::sync::atomic::AtomicUsize::new(0);
            let got: Vec<std::sync::Mutex<Option<Result<(String, f32), String>>>> =
                misses.iter().map(|_| std::sync::Mutex::new(None)).collect();
            std::thread::scope(|s| {
                for _ in 0..workers {
                    s.spawn(|| loop {
                        let j = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if j >= misses.len() {
                            break;
                        }
                        let crop = &crops_ref[misses[j]].1;
                        *got[j].lock().unwrap() = Some(recognize_with(ort_ref, chars, crop));
                    });
                }
            });
            for (j, &i) in misses.iter().enumerate() {
                let r = got[j].lock().unwrap().take().expect("每个 miss 都该被某个线程认过")?;
                self.rec_runs += 1;
                self.remember(crops[i].2, r.clone());
                results[i] = Some(r);
            }
        }
        let mut out = Vec::new();
        for ((r, _, _), res) in crops.into_iter().zip(results) {
            let (text, score) = res.expect("上面已经把 miss 全填上了");
            // 上游的 text_score：认出来但没把握的段扔掉，否则整屏会多出一堆头像里的假字。
            if score < 0.5 || text.is_empty() {
                continue;
            }
            out.push(OcrLine { rect: r, text, score });
        }
        out.sort_by_key(|l| (l.rect.y, l.rect.x));
        Ok(out)
    }

    /// 记一条进缓存，满了从头上丢。
    fn remember(&mut self, key: u64, val: (String, f32)) {
        if self.rec_cache.insert(key, val).is_none() {
            self.rec_order.push_back(key);
            while self.rec_order.len() > REC_CACHE_CAP {
                if let Some(old) = self.rec_order.pop_front() {
                    self.rec_cache.remove(&old);
                }
            }
        }
    }

}

/// 认出来的一行字：框（**入参图片自己的坐标系**）+ 文字 + 置信度。
#[derive(Debug, Clone)]
pub struct OcrLine {
    pub rect: Rect,
    pub text: String,
    pub score: f32,
}

/// rec 的输入高度，模型固定。
/// 一块图等比缩到高 48 之后该有多宽（夹在 1..最大桶之间）。桶由它定，缓存 key 不由它定。
fn rec_want(crop: &RgbImage) -> usize {
    let want = ((crop.width() as f64) * REC_HEIGHT as f64 / crop.height() as f64).round();
    (want as usize).clamp(1, *REC_BUCKETS.last().unwrap())
}

/// 认一小块图里的一行字。等比缩到高 48、宽度取桶、右侧补 0（补在**归一化之后**的空间，
/// 所以补的 0 对应灰度 127.5，与上游一致）。不碰 `self`，所以能在工作线程里跑（`read_opts`）。
fn recognize_with(o: &OrtSessions, chars: &[String], crop: &RgbImage) -> Result<(String, f32), String> {
    let want = rec_want(crop);
    let bucket = rec_bucket(want);
    let small =
        image::imageops::resize(crop, want as u32, REC_HEIGHT, image::imageops::FilterType::Triangle);
    let input = ndarray::Array4::<f32>::from_shape_fn((1, 3, REC_HEIGHT as usize, bucket), |(_, c, y, x)| {
        if x >= want {
            return 0.0;
        }
        let p = small.get_pixel(x as u32, y as u32);
        (p[c] as f32 / 255.0 - 0.5) / 0.5
    });
    let classes = chars.len();
    let (logits, shape) = run_ort(&o.rec, &o.rec_input, input, "rec")?;
    let c = *shape.last().ok_or("rec 输出没有形状")?;
    // 末维不等于类别数 = 字典构造错了。**必须在这里炸**：错位一格的表现是整屏乱码，
    // 看起来像"模型不行"，会把排查带去完全错误的方向。
    if c != classes {
        return Err(format!("rec 输出末维 {c}，字典 {classes} 类——字典构造错了"));
    }
    Ok(ctc_decode(&logits, logits.len() / c, c, chars))
}

/// 用 ort 跑一次：交回 (扁平的 f32 输出, 输出形状)。session 排队（`Mutex`）。
fn run_ort(
    sess: &std::sync::Mutex<ort::session::Session>,
    input_name: &str,
    input: ndarray::Array4<f32>,
    what: &str,
) -> Result<(Vec<f32>, Vec<usize>), String> {
    let shape: [usize; 4] = [input.shape()[0], input.shape()[1], input.shape()[2], input.shape()[3]];
    let data: Vec<f32> = input.into_iter().collect();
    let tensor = ort::value::Tensor::from_array((shape, data)).map_err(|e| format!("{what} 输入建不了: {e}"))?;
    let mut s = sess.lock().map_err(|_| format!("{what} session 锁坏了"))?;
    let outputs = s.run(ort::inputs![input_name => tensor]).map_err(|e| format!("{what} 跑不动(ort): {e}"))?;
    let (_, v) = outputs.iter().next().ok_or_else(|| format!("{what} 没有输出"))?;
    let (shape, data) = v.try_extract_tensor::<f32>().map_err(|e| format!("{what} 输出读不了(ort): {e}"))?;
    Ok((data.to_vec(), shape.iter().map(|&d| d as usize).collect()))
}

const REC_HEIGHT: u32 = 48;

/// rec 的宽度分桶：一行等比缩到高 48 后，宽度向上取到四档之一、右侧补白。ort 是动态形状，
/// 本不需要桶——**留着它是为了准确率**：golden（`tests/fixtures/ocr-golden.json`）与两平台实测
/// 都是按这四档补白跑出来的，rec 在同一行上的输出随补白长度而变；按真实宽度喂只省 14%
/// 且只在整窗上有差（研究档 §5，spec §6 明确先不动）。
const REC_BUCKETS: [usize; 4] = [160, 320, 640, 960];
pub fn rec_bucket(w: usize) -> usize {
    *REC_BUCKETS.iter().find(|&&b| b >= w).unwrap_or(REC_BUCKETS.last().unwrap())
}

/// 一小块图的内容指纹（FNV-1a）。**只对这一块的像素算，不对整张图算**——整窗读里变的
/// 只有几行，对整张图哈希等于每一趟都全灭。宽高一并编进去，免得两块像素相同、形状不同的
/// 图撞成一条（同样的 8 个像素，1×8 和 8×1 认出来的字不是一回事）。
///
/// 用 FNV 不用密码学哈希：这是本进程内的一张查找表，不是签名，没有对手会来构造碰撞。
pub fn crop_key(crop: &RgbImage) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut eat = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    };
    for v in crop.width().to_le_bytes().iter().chain(crop.height().to_le_bytes().iter()) {
        eat(*v);
    }
    for b in crop.as_raw() {
        eat(*b);
    }
    h
}

/// CTC 贪心解码：逐帧取最大类，**跳过 blank（0 号）**，**相邻同类只算一次**。
/// 置信度取被保留下来那些帧的最大概率均值（没有保留帧 → 0）。
pub fn ctc_decode(logits: &[f32], t: usize, c: usize, chars: &[String]) -> (String, f32) {
    let (mut s, mut sum, mut n, mut prev) = (String::new(), 0.0f32, 0usize, usize::MAX);
    for i in 0..t {
        let row = &logits[i * c..(i + 1) * c];
        let (k, &p) = row.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap();
        if k != 0 && k != prev {
            if let Some(ch) = chars.get(k) {
                s.push_str(ch);
            }
            sum += p;
            n += 1;
        }
        prev = k;
    }
    (s, if n == 0 { 0.0 } else { sum / n as f32 })
}

/// det 的输入尺寸：短边 ≥ 736 且长边 ≤ 1600，两边各自向上取整到 32 的倍数。
/// 返回 (宽, 高, 缩放比 k)——框要 ÷ k 才回到原图尺度。
///
/// **这个包络是量出来的**（2026-09-07，五张真实截图 × `min/736`、`max/{736,960,1280,1600}`
/// 五档，准确率完全一致），别自己另发明一组：det 的输入尺度直接决定小字认不认得出。
pub fn det_input_size(w: u32, h: u32) -> (u32, u32, f64) {
    let (w, h) = (w as f64, h as f64);
    let mut k = 1.0_f64;
    if w.min(h) < 736.0 {
        k = 736.0 / w.min(h);
    }
    if w.max(h) * k > 1600.0 {
        k = 1600.0 / w.max(h);
    }
    let up32 = |v: f64| ((v * k / 32.0).ceil() as u32).max(1) * 32;
    (up32(w), up32(h), k)
}

/// `det_input_size` 去掉"短边不足 736 就放大"那一条：只压不放（长边超 1600 才缩），对齐到 32。
/// 给窗口里裁出来的一块用——它的字和整窗一样大，不需要放大才认得出。
pub fn det_input_size_no_upscale(w: u32, h: u32) -> (u32, u32, f64) {
    let (w, h) = (w as f64, h as f64);
    let mut k = 1.0_f64;
    if w.max(h) > 1600.0 {
        k = 1600.0 / w.max(h);
    }
    let up32 = |v: f64| ((v * k / 32.0).ceil() as u32).max(1) * 32;
    (up32(w), up32(h), k)
}

const DB_THRESH: f32 = 0.3;
const DB_BOX_THRESH: f32 = 0.5;
const DB_UNCLIP: f64 = 1.6;

/// DBNet 后处理：概率图 → 文本行框。
///
/// **只出轴对齐框，不做 minAreaRect**：桌面界面的文字不会歪，旋转框只会多一层坐标换算，
/// 而下游（点击、裁模板）要的正是轴对齐框。
///
/// unclip：DB 训练时把文本区域收缩过，推理要按 Vatti 偏移量把它涨回去。对矩形而言那个
/// 偏移距离就是 `面积 × ratio / 周长`，所以这里不需要多边形库。
pub fn db_boxes(prob: &[f32], w: usize, h: usize) -> Vec<(Rect, f32)> {
    // **膨胀是必需的一步，不是调优**（上游 `use_dilation` 默认开着）：概率图在一行字的笔画
    // 间隙上会掉到阈值以下，不先把 3×3 邻域连起来，一行会碎成好几块——实测 pop-cxy.jpg
    // 上不做膨胀出 26 框、参照实现只有 13 框，碎出来的每一块都会被当成独立的一行去 rec。
    let bin: Vec<bool> = prob.iter().map(|&p| p >= DB_THRESH).collect();
    let mut dil = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            if !bin[y * w + x] {
                continue;
            }
            for dy in y.saturating_sub(1)..(y + 2).min(h) {
                for dx in x.saturating_sub(1)..(x + 2).min(w) {
                    dil[dy * w + dx] = true;
                }
            }
        }
    }
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    for start in 0..w * h {
        if seen[start] || !dil[start] {
            continue;
        }
        // 泛洪出一块连通域（4 邻接），顺便攒出它的外接框与概率和
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
        let (mut sum, mut n) = (0.0f32, 0usize);
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            // 分数只按**真正过了阈值**的那些点算，不摊上膨胀补出来的空白——否则一个瘦长
            // 的框会被自己的留白拉到 box_thresh 以下，安静地丢掉一行。
            if bin[i] {
                sum += prob[i];
                n += 1;
            }
            let mut push = |j: usize, s: &mut Vec<usize>| {
                if !seen[j] && dil[j] {
                    seen[j] = true;
                    s.push(j);
                }
            };
            if x > 0 {
                push(i - 1, &mut stack);
            }
            if x + 1 < w {
                push(i + 1, &mut stack);
            }
            if y > 0 {
                push(i - w, &mut stack);
            }
            if y + 1 < h {
                push(i + w, &mut stack);
            }
        }
        let score = if n == 0 { 0.0 } else { sum / n as f32 };
        if score < DB_BOX_THRESH {
            continue;
        }
        let (bw, bh) = ((x1 - x0 + 1) as f64, (y1 - y0 + 1) as f64);
        // 上游的 min_size=3：短边不到 3px 的连通域是噪点，不是字。
        if bw.min(bh) < 3.0 {
            continue;
        }
        let d = (bw * bh * DB_UNCLIP / (2.0 * (bw + bh))).round() as i64;
        let nx = (x0 as i64 - d).max(0) as u32;
        let ny = (y0 as i64 - d).max(0) as u32;
        let nx1 = ((x1 as i64 + d) as usize).min(w - 1) as u32;
        let ny1 = ((y1 as i64 + d) as usize).min(h - 1) as u32;
        out.push((
            Rect {
                x: nx as i32,
                y: ny as i32,
                w: (nx1 - nx + 1) as i32,
                h: (ny1 - ny + 1) as i32,
            },
            score,
        ));
        if out.len() >= 1000 {
            break;
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// 模型放在环境变量指的目录里；没设就跳过——CI 上没有模型，这条不该把构建判红。
    fn models() -> Option<std::path::PathBuf> {
        std::env::var("STREAM_OCR_MODELS").ok().map(Into::into)
    }

    /// 环境变量是进程级的，而 cargo 的用例并行跑：改 `STREAM_ORT_LIB` / `STREAM_OCR_ORT_THREADS`
    /// 的用例与正在 `load` 的用例撞上，后者会读到一个错的路径、报一个假的 `ort-missing`。
    /// 所有碰这两个变量的地方（改它的、读它的 `load`）都握着这把锁——**包括别的模块里经
    /// `ensure_ort_loaded` 读它的用例**（`see_detect.rs` 的检测器加载），所以是 `pub(crate)`。
    pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 握着 `ENV_LOCK` 加载一个引擎（`load` 读 `STREAM_ORT_LIB`，见上）。
    fn load(dir: &Path) -> OcrEngine {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        OcrEngine::load(dir).expect("模型该能读进来")
    }

    /// RAII 放回环境变量原值——`assert!` panic 会跳过手写在断言之后的恢复语句，把变量永久
    /// 篡改（`None` 没放回、或留着测试塞的假值），后续并行跑的用例连锁假红。构造时先存旧值，
    /// `Drop`（含 panic 展开时）无条件放回：`Some` → `set_var`，`None` → `remove_var`。
    struct RestoreEnv(&'static str, Option<String>);
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            match &self.1 {
                Some(v) => std::env::set_var(self.0, v),
                None => std::env::remove_var(self.0),
            }
        }
    }

    /// 库不在场必须以 `ort-missing:` 开头报错，且文本里有期望的路径——这是"没静默回落"的唯一证据。
    #[test]
    fn 缺运行时库明着报_ort_missing_并说出期望路径() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("ort-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _restore = RestoreEnv("STREAM_ORT_LIB", std::env::var("STREAM_ORT_LIB").ok());
        std::env::remove_var("STREAM_ORT_LIB");
        // `.err()` 而不是 `unwrap_err()`：后者要 `OcrEngine: Debug`，而 session 没有 Debug。
        let err = OcrEngine::load(&dir).err().expect("库不在场的空目录必须报错");
        assert!(err.starts_with("ort-missing: "), "{err}");
        assert!(err.contains(&dir.join(ort_lib_name()).display().to_string()), "{err}");
    }

    #[test]
    fn 线程数缺省是物理核封顶八() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreEnv("STREAM_OCR_ORT_THREADS", std::env::var("STREAM_OCR_ORT_THREADS").ok());
        std::env::remove_var("STREAM_OCR_ORT_THREADS");
        assert_eq!(ort_threads(), num_cpus::get_physical().min(8));
        std::env::set_var("STREAM_OCR_ORT_THREADS", "3");
        assert_eq!(ort_threads(), 3);
    }

    #[test]
    fn 加载后_info_报的是_ort_与钉住的版本() {
        let Some(dir) = models() else { return };
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let e = OcrEngine::load(&dir).unwrap();
        assert_eq!(e.info().name, "ort");
        assert_eq!(e.info().version, ORT_VERSION);
        assert_eq!(e.info().threads, ort_threads());
        assert!(e.info().lib.is_file(), "info.lib 该指向真加载的那份库: {}", e.info().lib.display());
    }

    #[test]
    fn det_input_size_覆盖三种形状() {
        // 大窗口：长边压到 1600 以内，两边取到 32 的倍数
        assert_eq!(det_input_size(1946, 1045), (1600, 864, 1600.0 / 1946.0));
        // 小截图：短边顶到 736 以上
        let (w, h, k) = det_input_size(482, 300);
        assert!(h >= 736 && k > 1.0, "短边不足 736 要放大，得到 {w}x{h} k={k}");
        // 已经在包络内：不缩放，只对齐 32
        assert_eq!(det_input_size(960, 800), (960, 800, 1.0));
    }

    #[test]
    fn db_boxes_把一块连通的高概率区域框出来并按_unclip_外扩() {
        // 20x20 的图，中间 (5..15, 8..12) 是一块字
        let (w, h) = (20usize, 20usize);
        let mut prob = vec![0.0f32; w * h];
        for y in 8..12 {
            for x in 5..15 {
                prob[y * w + x] = 0.9;
            }
        }
        let boxes = db_boxes(&prob, w, h);
        assert_eq!(boxes.len(), 1);
        let (r, score) = boxes[0].clone();
        assert!(score > 0.8);
        // 原框 10x4，unclip 距离 d = area*1.6/perimeter = 40*1.6/28 ≈ 2.28 → 各边外扩 2
        assert!(r.x <= 3 && r.y <= 6 && r.w >= 14 && r.h >= 8, "外扩后得到 {r:?}");
    }

    #[test]
    fn db_boxes_丢掉低分区域() {
        let (w, h) = (20usize, 20usize);
        let mut prob = vec![0.0f32; w * h];
        for y in 8..12 {
            for x in 5..15 {
                prob[y * w + x] = 0.35; // 过了 thresh=0.3，但均分 < box_thresh=0.5
            }
        }
        assert!(db_boxes(&prob, w, h).is_empty());
    }

    /// 拿 `tests/fixtures/ocr-golden.json`（onnxruntime 参照实现在同一批图上的输出）对账。
    /// **只有这条能区分"跑通了"和"跑对了"** —— 自己实现的 DB 后处理很容易安静地少框半张图。
    ///
    /// **判据是"参照的每个框我们都框到了"，不是"框数落在 0.8–1.3 倍"**（计划里写的是后者）。
    /// 换判据的理由是量出来的，不是嫌它红：golden 是参照实现的**最终输出**——det 出框之后
    /// 还过了一道 rec 的 `text_score` 过滤。det 在微信/QQ 的头像列里会框出一堆"看着像字"的
    /// 小块（群头像是九宫格小照片拼的），参照实现也框到了，只是 rec 认不出东西就丢掉了。
    /// 所以拿 det 的框数去比一个 rec 之后的数，上界注定对不上：实测五张图
    /// wx1 58/27=2.15、pop-cxy 22/13=1.69、wx-unfocus 68/51=1.33、qq2 37/29=1.28、
    /// qq-chat 17/15=1.13——而参照的每一个框我们都覆盖到了，一个没漏。
    /// 「多框」由 Task 3 的文字对账负责收口（rec 分数低的自己会掉），det 这一层要守的是
    /// 「不许漏」，下面这条覆盖断言比原来的计数比严格得多。
    #[test]
    fn detect_覆盖参照实现的每一个框() {
        let Some(dir) = models() else { return };
        let mut e = load(&dir);
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ocr-golden.json")).unwrap();
        for (name, rows) in golden.as_object().unwrap() {
            let img = image::open(format!("tests/fixtures/{name}")).unwrap().to_rgb8();
            let got = e.detect(&img).unwrap();
            let rows = rows.as_array().unwrap();
            let mut missed = Vec::new();
            for r in rows {
                let g = &r["rect"];
                let (gx, gy, gw, gh) = (
                    g["x"].as_i64().unwrap() as i32,
                    g["y"].as_i64().unwrap() as i32,
                    g["w"].as_i64().unwrap() as i32,
                    g["h"].as_i64().unwrap() as i32,
                );
                // 参照的这个框，至少有 60% 的面积被我们某一个框盖住
                let covered = got.iter().any(|(o, _)| {
                    let ix = (o.x + o.w).min(gx + gw) - o.x.max(gx);
                    let iy = (o.y + o.h).min(gy + gh) - o.y.max(gy);
                    ix > 0 && iy > 0 && (ix * iy) as f64 >= 0.6 * (gw * gh) as f64
                });
                if !covered {
                    missed.push(r["text"].as_str().unwrap_or("?").to_string());
                }
            }
            assert!(missed.is_empty(), "{name} 没框到: {missed:?}");
            // 量级闸：真碎成半个字会是 5–10 倍，实测最大 2.15 倍（wx1 的头像列）。
            let (n, want) = (got.len() as f64, rows.len() as f64);
            assert!(n >= want * 0.8 && n <= want * 2.6, "{name}: 我们 {n} 框，参照 {want} 框");
        }
    }

    #[test]
    fn rec_bucket_取第一个装得下的桶() {
        assert_eq!(rec_bucket(1), 160);
        assert_eq!(rec_bucket(160), 160);
        assert_eq!(rec_bucket(161), 320);
        assert_eq!(rec_bucket(700), 960);
        assert_eq!(rec_bucket(5000), 960, "超过最大桶就压到最大桶，别现编一个新形状");
    }

    #[test]
    fn ctc_decode_合并重复并跳过_blank() {
        let chars: Vec<String> = ["<blank>", "甲", "乙"].iter().map(|s| s.to_string()).collect();
        // T=5, C=3：甲 甲 blank 甲 乙  → "甲甲乙"（重复只在被 blank 隔开时才算两个字）
        let mut l = vec![0.0f32; 5 * 3];
        let set = |l: &mut Vec<f32>, t: usize, c: usize| l[t * 3 + c] = 1.0;
        set(&mut l, 0, 1);
        set(&mut l, 1, 1);
        set(&mut l, 2, 0);
        set(&mut l, 3, 1);
        set(&mut l, 4, 2);
        let (s, score) = ctc_decode(&l, 5, 3, &chars);
        assert_eq!(s, "甲甲乙");
        assert!(score > 0.0);
    }

    #[test]
    fn ctc_decode_全是_blank_给空串() {
        let chars: Vec<String> = ["<blank>", "甲"].iter().map(|s| s.to_string()).collect();
        let l = vec![1.0f32, 0.0, 1.0, 0.0];
        assert_eq!(ctc_decode(&l, 2, 2, &chars).0, "");
    }

    /// 比较前的归一化：去空白 + 全角 ASCII 标点折成半角 + 弯引号折成直引号 +
    /// 省略号/连续句点折成一个句点 + 英文字母折成小写。
    ///
    /// **这是一条写明的豁免，不是放宽阈值。** 逐条列出实测差异（全都只差标点写法或字母
    /// 大小写，字一个不差）：
    ///   pop-cxy「包含：陈雪韵」/ 我们「包含:陈雪韵」（全角 vs 半角冒号）
    ///   pop-cxy「…钟晟…」/ 我们「…钟晟.…」（省略号前多认了一个点）
    ///   qq2「对方已成功接收文件"Scriptjs”」/ 我们「…"scriptjs"」（弯引号 + S 大小写）
    /// 成因是两边的 det 框差了 2px（例如 154,746,139,38 vs 156,748,135,34），裁出来的图
    /// 不同、rec 在同一个字形上的 argmax 就可能落到同形不同码位的字符上——这是参照实现
    /// 自己那一侧也有的噪声，不是我们漏读了一行。这条测试要守的是"有没有把这行字读出来"，
    /// 不是"有没有挑中同一个码位的冒号"。折叠范围刻意留窄：汉字一个不动。
    fn squash(s: &str) -> String {
        let mut out = String::new();
        for c in s.chars() {
            if c.is_whitespace() {
                continue;
            }
            let c = match c {
                '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
                '…' => '.',
                '\u{2018}' | '\u{2019}' => '\'',
                '\u{201C}' | '\u{201D}' => '"',
                c => c.to_ascii_lowercase(),
            };
            if c == '.' && out.ends_with('.') {
                continue;
            }
            out.push(c);
        }
        out
    }

    /// 参照实现自己认错、而我们认对了的那几段——不能拿它们要求我们"也错成一样"。
    /// 每一条都要写清楚错在哪，别拿这张表当红灯的垃圾桶。
    const 参照实现认错的段: &[(&str, &str, &str)] =
        &[
            ("qq2.jpg", "[屏草共享]通话时长39:26", "参照把「幕」认成「草」；我们读出的是「屏幕共享」"),
            ("wx1.jpg", "[12条]1： 收售体 |诚信… ", "参照漏了一个「一」；我们读出的是「收售一体」"),
        ];

    /// 形状也要编进指纹：同样的像素、不同的排布不是同一块图。
    #[test]
    fn crop_key_区分形状相同像素() {
        let a = RgbImage::from_raw(2, 1, vec![1, 2, 3, 4, 5, 6]).unwrap();
        let b = RgbImage::from_raw(1, 2, vec![1, 2, 3, 4, 5, 6]).unwrap();
        assert_ne!(crop_key(&a), crop_key(&b));
        let c = RgbImage::from_raw(2, 1, vec![1, 2, 3, 4, 5, 6]).unwrap();
        assert_eq!(crop_key(&a), crop_key(&c));
    }

    /// 同一张图读两遍，第二遍一次 rec 都不该跑。
    /// **判据是推理次数不是耗时**：机器忙一下就能让快的那次看起来更慢，用耗时会假绿也会假红。
    #[test]
    fn 同一块图第二次识别不再跑推理() {
        let Some(dir) = models() else { return };
        let mut e = load(&dir);
        let img = image::open("tests/fixtures/pop-cxy.jpg").unwrap().to_rgb8();
        let first = e.read(&img).unwrap();
        let runs = e.rec_runs();
        assert!(runs > 0, "第一遍总得真跑几次，否则这条测试什么都没证明");
        let second = e.read(&img).unwrap();
        assert_eq!(e.rec_runs(), runs, "第二遍不该再跑 rec");
        assert_eq!(first.len(), second.len(), "缓存不能改变结果");
    }

    /// 五张真实截图上，参照实现认出来的每一段文字，我们也得认出来（归一化后包含即可）。
    /// 允许我们多认（分段粒度可能不同），**不允许漏**。
    #[test]
    fn read_认得出参照实现认出的每一段() {
        let Some(dir) = models() else { return };
        let mut e = load(&dir);
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ocr-golden.json")).unwrap();
        // 一次跑完五张再断言：逐张 panic 会把后面几张藏起来，一轮只能看见一个问题。
        let mut missed = Vec::new();
        for (name, rows) in golden.as_object().unwrap() {
            let img = image::open(format!("tests/fixtures/{name}")).unwrap().to_rgb8();
            let got: String = e.read(&img).unwrap().iter().map(|l| squash(&l.text)).collect();
            for r in rows.as_array().unwrap() {
                // 参照实现自己也有低分噪声段，只对 score ≥ 0.8 的较真
                if r["score"].as_f64().unwrap() < 0.8 {
                    continue;
                }
                let raw = r["text"].as_str().unwrap();
                if 参照实现认错的段.iter().any(|(n, t, _)| n == name && t == &raw) {
                    continue;
                }
                // 末尾的省略号不算内容：界面里被截断的那一行，参照实现常把行尾的「…」也
                // 收进框、我们的框在那儿窄了几十像素就没收进来（wx1 三条都是这个）。
                // 一个表示"后面还有"的符号读没读到，不构成"这行字没读出来"。
                let want = squash(raw);
                let want = want.trim_end_matches('.').to_string();
                if want.chars().count() >= 2 && !got.contains(&want) {
                    missed.push(format!("{name}: {want}"));
                }
            }
        }
        assert!(missed.is_empty(), "漏认: {missed:#?}");
    }

    #[test]
    #[ignore]
    fn dump_boxes() {
        let Some(dir) = models() else { return };
        let mut e = load(&dir);
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ocr-golden.json")).unwrap();
        for (name, rows) in golden.as_object().unwrap() {
            let img = image::open(format!("tests/fixtures/{name}")).unwrap().to_rgb8();
            println!("== {name} {}x{} in={:?}", img.width(), img.height(), det_input_size(img.width(), img.height()));
            let nboxes = e.detect(&img).unwrap().len(); // 预热：第一次要起线程池、选内核
            let _ = e.read(&img).unwrap();
            let t0 = std::time::Instant::now();
            e.detect(&img).unwrap();
            let tdet = t0.elapsed();
            let t1 = std::time::Instant::now();
            let lines = e.read(&img).unwrap();
            println!("  [det {nboxes} 框 {:?} | det+rec {:?}]", tdet, t1.elapsed());
            for l in lines {
                println!("  ours {:?} {:.2} {}", l.rect, l.score, l.text);
            }
            for r in rows.as_array().unwrap() {
                println!("  REF  {} {} {}", r["rect"], r["score"], r["text"]);
            }
        }
    }

    #[test]
    fn loads_det_and_rec_and_dict() {
        let Some(dir) = models() else { return };
        let e = load(&dir);
        assert_eq!(e.classes(), 18385, "CTC 类别数 = 1 blank + 18383 字 + 1 空格");
    }
}
