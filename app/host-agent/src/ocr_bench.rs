//! `stream-desktop ocr-bench <图目录> [选项]` —— 识别层的**台架**：对一组固定图片量
//! "一次读要多久、读出了什么"，打一份 JSON 给评分脚本（`scripts/ocr-score.mjs`）。
//!
//! **为什么不是 `see-probe`**：`see-probe` 量的是活体窗口，每次跑画面都不一样，比不起来；
//! 而引擎选型要的恰恰是"同一批像素、换一个引擎"。台架吃**盘上的图**，所以同一组数字在
//! Windows / mac / Linux 上是可比的，也可以隔几个月再跑一遍。
//!
//! **冷热必须分开报**，否则两个差一个数量级的数会被混成一个没有意义的平均：
//!   - `loadMs`  模型读进内存（长驻 agent 里一辈子只付一次）
//!   - `coldMs`  这个引擎的**第一次**读（线程池起动 + 内核选择；`--prewarm` 就是为了把它挪走）
//!   - `warmMs`  **rec 内容缓存清空**后的一次完整识别 —— recipe 里一步的真实价钱
//!   - `cachedMs` 同一张图再读一遍（内容缓存全中）—— `expect` 轮询在画面没动时的价钱
//!
//! 三种输入按 `<图名>.regions.json` 给（缺省只跑整图）：
//! ```json
//! [{ "name": "search", "x": 40, "y": 96, "w": 320, "h": 96 }]
//! ```

use crate::ocr::OcrEngine;
use image::RgbImage;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

struct Opts {
    dir: PathBuf,
    runs: usize,
    scale: f64,
    prewarm: bool,
    /// 共用一个引擎按顺序把所有单元读一遍，报每个单元的**第一次**耗时——长驻 agent 就是这个
    /// 形状（一个引擎伺候一整趟 recipe），"第一次读一块新尺寸要不要额外付钱"只在这一档里看得见。
    session: bool,
    /// 从第一张图上裁 N 块**尺寸各不相同**的区域连着读——这才是 recipe 的真实形状
    /// （每个 region 的宽高都不一样）。报总耗时。
    sweep: usize,
}

pub fn main(args: &[String]) {
    let mut o = Opts {
        dir: PathBuf::new(),
        runs: 5,
        scale: 1.0,
        prewarm: false,
        session: false,
        sweep: 0,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--runs" => o.runs = it.next().and_then(|v| v.parse().ok()).unwrap_or(5),
            "--scale" => o.scale = it.next().and_then(|v| v.parse().ok()).unwrap_or(1.0),
            "--prewarm" => o.prewarm = true,
            "--session" => o.session = true,
            "--sweep" => o.sweep = it.next().and_then(|v| v.parse().ok()).unwrap_or(12),
            other if o.dir.as_os_str().is_empty() && !other.starts_with("--") => {
                o.dir = PathBuf::from(other)
            }
            other => {
                eprintln!("ocr-bench: 不认识的参数 {other}");
                std::process::exit(2);
            }
        }
    }
    if o.dir.as_os_str().is_empty() {
        eprintln!("用法：stream-desktop ocr-bench <图目录> [--runs N] [--scale 2] [--prewarm] [--session] [--sweep N]");
        eprintln!("  --scale  截图相对逻辑画面的倍数（mac Retina 原生截图 = 2）；检测在 1× 上跑、识别吃物理像素，与 agent 一致");
        eprintln!("  --prewarm  读之前先各跑一次最小形状（量'启动预热'那一档，coldMs 应贴近 warmMs）");
        std::process::exit(2);
    }
    match run(&o) {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("ocr-bench: {e}");
            std::process::exit(1);
        }
    }
}

#[derive(Clone)]
struct Unit {
    image: String,
    region: Option<String>,
    img: RgbImage,
    /// 整图走"整窗"语义（短边不足 736 要放大），裁块走"区域"语义（只压不放）。见 `read_opts`。
    upscale: bool,
}

fn run(o: &Opts) -> Result<Value, String> {
    let dir = crate::see::ocr_models_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&o.dir)
        .map_err(|e| format!("读不了图目录 {}: {e}", o.dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            matches!(
                p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
                Some("jpg") | Some("jpeg") | Some("png")
            )
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err(format!("{} 里一张图都没有", o.dir.display()));
    }

    let mut units: Vec<Unit> = Vec::new();
    for f in &files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let img = image::open(f).map_err(|e| format!("{name} 读不了: {e}"))?.to_rgb8();
        for r in regions_of(f)? {
            let (rn, x, y, w, h) = r;
            if x + w > img.width() as i64 || y + h > img.height() as i64 || w <= 0 || h <= 0 {
                return Err(format!("{name} 的区域 {rn} 越界：{x},{y},{w},{h} 图是 {}x{}", img.width(), img.height()));
            }
            let crop = image::imageops::crop_imm(&img, x as u32, y as u32, w as u32, h as u32).to_image();
            units.push(Unit { image: name.clone(), region: Some(rn), img: crop, upscale: false });
        }
        units.push(Unit { image: name.clone(), region: None, img, upscale: true });
    }

    if o.session {
        return session(&dir, &units, o);
    }
    if o.sweep > 0 {
        return sweep(&dir, &units, o);
    }
    let mut out = Vec::new();
    for u in &units {
        out.push(bench_unit(&dir, u, o)?);
    }
    Ok(json!({
        "engine": "ort",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "threads": crate::ocr::ort_threads(),
        "prewarm": o.prewarm,
        "scale": o.scale,
        "runs": o.runs,
        "models": dir.display().to_string(),
        "units": out,
    }))
}

/// 一条会话：一个引擎按顺序读完所有单元，报每个单元**第一次**的耗时。
/// 长驻 agent 就是这个形状（一个引擎伺候一整趟 recipe）。
fn session(models: &Path, units: &[Unit], o: &Opts) -> Result<Value, String> {
    let t = std::time::Instant::now();
    let mut e = OcrEngine::load(models)?;
    let load_ms = t.elapsed().as_millis();
    let mut rows = Vec::new();
    let mut total = 0u128;
    for u in units {
        e.clear_rec_cache(); // 内容缓存会掩盖"第一次读"的差异——这里量的是引擎，不是缓存
        let t = std::time::Instant::now();
        let lines = read(&mut e, u, o.scale)?;
        let ms = t.elapsed().as_millis();
        total += ms;
        let (dw, dh) = det_shape(&u.img, u.upscale, o.scale);
        rows.push(json!({
            "image": u.image, "region": u.region, "w": u.img.width(), "h": u.img.height(),
            "detInput": [dw, dh], "firstMs": ms, "lines": lines.len(),
        }));
    }
    Ok(json!({
        "engine": "ort", "platform": std::env::consts::OS, "mode": "session",
        "threads": crate::ocr::ort_threads(), "scale": o.scale,
        "loadMs": load_ms, "totalMs": total, "units": rows,
    }))
}

/// 从第一张图上裁 N 块尺寸各不相同的区域连着读。**recipe 的真实形状**：每个 region 的宽高
/// 都由界面决定，没有两块是一样的——引擎对"新尺寸"有没有额外开销，这一档看得最清楚。
fn sweep(models: &Path, units: &[Unit], o: &Opts) -> Result<Value, String> {
    let base = units
        .iter()
        .filter(|u| u.region.is_none())
        .max_by_key(|u| u.img.width() * u.img.height())
        .ok_or("sweep 需要至少一张整图")?;
    let t = std::time::Instant::now();
    let mut e = OcrEngine::load(models)?;
    let load_ms = t.elapsed().as_millis();
    let mut rows = Vec::new();
    let mut total = 0u128;
    // 尺寸用一个**固定的**伪随机序列（xorshift，种子写死），好让两次跑逐块可比——
    // 换个随机源就换了一组形状，任何 A/B 都会变成两组不同的活儿。
    let mut s: u64 = 0x9e3779b97f4a7c15;
    let mut next = |lo: u32, hi: u32| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        lo + (s % ((hi - lo + 1) as u64)) as u32
    };
    for _ in 0..o.sweep {
        let w = next(180, (base.img.width() - 8).min(900));
        let h = next(48, (base.img.height() - 8).min(320));
        let x = next(0, base.img.width() - w - 1);
        let y = next(0, base.img.height() - h - 1);
        let crop = image::imageops::crop_imm(&base.img, x, y, w, h).to_image();
        let u = Unit { image: base.image.clone(), region: Some(format!("{w}x{h}")), img: crop, upscale: false };
        e.clear_rec_cache();
        let t = std::time::Instant::now();
        let lines = read(&mut e, &u, o.scale)?;
        let ms = t.elapsed().as_millis();
        total += ms;
        rows.push(json!({ "w": w, "h": h, "firstMs": ms, "lines": lines.len() }));
    }
    Ok(json!({
        "engine": "ort", "platform": std::env::consts::OS, "mode": "sweep",
        "threads": crate::ocr::ort_threads(), "image": base.image,
        "loadMs": load_ms, "totalMs": total, "units": rows,
    }))
}

/// 一个测量单元（整图或一块区域）的冷/热/缓存三档。**每个单元都从一个全新的引擎开始**——
/// 共用引擎会让第二个单元白捡前一个已经热起来的线程池，`coldMs` 就不再是冷的了。
fn bench_unit(models: &Path, u: &Unit, o: &Opts) -> Result<Value, String> {
    let t = std::time::Instant::now();
    let mut e = OcrEngine::load(models)?;
    let load_ms = t.elapsed().as_millis();

    let (dw, dh) = det_shape(&u.img, u.upscale, o.scale);
    let prewarm = if o.prewarm { json!({ "totalMs": e.prewarm()? }) } else { Value::Null };

    let t = std::time::Instant::now();
    let first = read(&mut e, u, o.scale)?;
    let cold_ms = t.elapsed().as_millis();

    let mut warm = Vec::new();
    let mut last = first.clone();
    for _ in 0..o.runs {
        e.clear_rec_cache();
        let t = std::time::Instant::now();
        last = read(&mut e, u, o.scale)?;
        warm.push(t.elapsed().as_millis());
    }
    let t = std::time::Instant::now();
    let cached = read(&mut e, u, o.scale)?;
    let cached_ms = t.elapsed().as_millis();

    // det 单独再量一次（引擎已热、缓存与 rec 无关），好说清楚"慢在检测还是识别"。
    let t = std::time::Instant::now();
    let boxes = detect(&mut e, u, o.scale)?;
    let det_ms = t.elapsed().as_millis();

    let mut sorted = warm.clone();
    sorted.sort_unstable();
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0);

    Ok(json!({
        "image": u.image,
        "region": u.region,
        "w": u.img.width(), "h": u.img.height(),
        "detInput": [dw, dh],
        "loadMs": load_ms,
        "prewarmed": prewarm,
        "coldMs": cold_ms,
        "warmMs": warm,
        "warmMedianMs": median,
        "cachedMs": cached_ms,
        "detMs": det_ms,
        "boxes": boxes,
        "lines": last.len(),
        // 缓存那一遍的行数必须和热态一致，否则缓存改变了结果（那是 bug，不是省钱）
        "cachedLines": cached.len(),
        "texts": last.iter().map(|l| json!({
            "text": l.text, "score": l.score,
            "rect": [l.rect.x, l.rect.y, l.rect.w, l.rect.h],
        })).collect::<Vec<_>>(),
    }))
}

/// 与 `see::SeeEngines::ocr_texts` 同一条路：`scale > 1` 时检测在缩到逻辑 1× 的图上跑、
/// 识别从物理像素上裁。台架必须照抄这一格，否则量的不是 agent 真正会走的那条路。
fn read(e: &mut OcrEngine, u: &Unit, scale: f64) -> Result<Vec<crate::ocr::OcrLine>, String> {
    if crate::see::ocr_runs_logical(scale) {
        let (lw, lh) = crate::see::logical_size(u.img.width(), u.img.height(), scale);
        let small = image::imageops::resize(&u.img, lw, lh, image::imageops::FilterType::Triangle);
        let boxes = e.detect_opts(&small, u.upscale)?;
        let boxes = crate::see::scale_boxes_back(boxes, scale, u.img.width(), u.img.height());
        e.recognize_boxes(&u.img, boxes)
    } else {
        e.read_opts(&u.img, u.upscale)
    }
}

fn detect(e: &mut OcrEngine, u: &Unit, scale: f64) -> Result<usize, String> {
    if crate::see::ocr_runs_logical(scale) {
        let (lw, lh) = crate::see::logical_size(u.img.width(), u.img.height(), scale);
        let small = image::imageops::resize(&u.img, lw, lh, image::imageops::FilterType::Triangle);
        Ok(e.detect_opts(&small, u.upscale)?.len())
    } else {
        Ok(e.detect_opts(&u.img, u.upscale)?.len())
    }
}

/// 这一块**真正喂给 det 的形状**（报进 `detInput`，好把耗时和面积对上）。
fn det_shape(img: &RgbImage, upscale: bool, scale: f64) -> (u32, u32) {
    let (w, h) = if crate::see::ocr_runs_logical(scale) {
        crate::see::logical_size(img.width(), img.height(), scale)
    } else {
        (img.width(), img.height())
    };
    let (nw, nh, _) = if upscale {
        crate::ocr::det_input_size(w, h)
    } else {
        crate::ocr::det_input_size_no_upscale(w, h)
    };
    (nw, nh)
}

/// `<图>.regions.json` 里的区域；文件不在就只跑整图。
fn regions_of(img: &Path) -> Result<Vec<(String, i64, i64, i64, i64)>, String> {
    let p = img.with_extension("regions.json");
    if !p.exists() {
        return Ok(Vec::new());
    }
    let txt = std::fs::read_to_string(&p).map_err(|e| format!("{} 读不了: {e}", p.display()))?;
    let v: Value = serde_json::from_str(&txt).map_err(|e| format!("{} 不是 JSON: {e}", p.display()))?;
    let arr = v.as_array().ok_or_else(|| format!("{} 该是一个数组", p.display()))?;
    let mut out = Vec::new();
    for r in arr {
        let g = |k: &str| r[k].as_i64().ok_or_else(|| format!("{} 里缺 {k}", p.display()));
        out.push((
            r["name"].as_str().unwrap_or("region").to_string(),
            g("x")?,
            g("y")?,
            g("w")?,
            g("h")?,
        ));
    }
    Ok(out)
}
