// Apple Vision（`VNRecognizeTextRequest`）的台架 —— 和 `stream-desktop ocr-bench` 打**同一份
// JSON**，好让 `ocr-score.mjs` 把两个引擎放进同一张表。只有 mac 有这条路。
//
//   swift vision-bench.swift <图目录> [--runs N] [--fast] > vision.json
//
// 与 `ocr-bench`（PP-OCR / ort）那一档的对齐（不对齐就没法比）：
//   - 同一个图目录、同一份 `<图>.regions.json`（区域先裁再识别，和 agent 的 region 下推一样）；
//   - 冷/热分开报：`coldMs` 是这个进程里对这一块的第一次（含 Vision 自己的模型惰性加载），
//     `warmMs` 是随后的 N 次。Vision 没有我们那种内容缓存，所以 `cachedMs` 恒等于再跑一次。
//   - 每个单元**新建一个 VNRecognizeTextRequest**，不复用——复用会把第二次变成一次缓存命中，
//     量出来的就不是识别的价钱了。
//
// 注意：`.accurate` + `usesLanguageCorrection = false`。开语言纠错会让它"猜"成通顺的词，
// 而我们要判的是"屏上那几个字是不是它"——纠错把错字改得更像人话，恰恰更难发现（实测
// 2026-09-13：「微信红包」→「微倍紅包」这类错就是在关着纠错时暴露的）。
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
var dir = ""
var runs = 5
var level = VNRequestTextRecognitionLevel.accurate
var i = 1
while i < args.count {
  switch args[i] {
  case "--runs": i += 1; runs = i < args.count ? (Int(args[i]) ?? 5) : 5
  case "--fast": level = .fast
  default: if dir.isEmpty { dir = args[i] }
  }
  i += 1
}
if dir.isEmpty {
  FileHandle.standardError.write("用法：swift vision-bench.swift <图目录> [--runs N] [--fast]\n".data(using: .utf8)!)
  exit(2)
}

struct Region { let name: String; let x: Int; let y: Int; let w: Int; let h: Int }

func regionsOf(_ path: String) -> [Region] {
  let p = (path as NSString).deletingPathExtension + ".regions.json"
  guard let d = FileManager.default.contents(atPath: p),
        let arr = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else { return [] }
  return arr.compactMap {
    guard let x = $0["x"] as? Int, let y = $0["y"] as? Int, let w = $0["w"] as? Int, let h = $0["h"] as? Int
    else { return nil }
    return Region(name: ($0["name"] as? String) ?? "region", x: x, y: y, w: w, h: h)
  }
}

/// 跑一次识别，交回（行, 毫秒）。**框换算回入参图片自己的坐标系**：Vision 交的是归一化的
/// 左下原点矩形，而我们全链路用的是左上原点的像素——不换算的话框全是上下颠倒的。
func recognize(_ cg: CGImage) -> ([(String, Double, [Int])], Int) {
  let t0 = Date()
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = level
  req.recognitionLanguages = ["zh-Hans", "en-US"]
  req.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try? handler.perform([req])
  let ms = Int(Date().timeIntervalSince(t0) * 1000)
  var out: [(String, Double, [Int])] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    let x = Int(b.minX * CGFloat(cg.width))
    let w = Int(b.width * CGFloat(cg.width))
    let h = Int(b.height * CGFloat(cg.height))
    let y = Int((1 - b.maxY) * CGFloat(cg.height))
    out.append((c.string, Double(c.confidence), [x, y, w, h]))
  }
  return (out, ms)
}

func crop(_ cg: CGImage, _ r: Region) -> CGImage? {
  cg.cropping(to: CGRect(x: r.x, y: r.y, width: r.w, height: r.h))
}

let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
  .filter { ["jpg", "jpeg", "png"].contains(($0 as NSString).pathExtension.lowercased()) }
  .sorted()

var units: [[String: Any]] = []
for f in files {
  let path = (dir as NSString).appendingPathComponent(f)
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("读不了 \(path)\n".data(using: .utf8)!)
    continue
  }
  var todo: [(String?, CGImage)] = []
  for r in regionsOf(path) {
    if let c = crop(cg, r) { todo.append((r.name, c)) }
  }
  todo.append((nil, cg))
  for (name, im) in todo {
    let (_, cold) = recognize(im)
    var warm: [Int] = []
    var last: [(String, Double, [Int])] = []
    for _ in 0..<runs {
      let (t, ms) = recognize(im)
      warm.append(ms)
      last = t
    }
    let (_, cached) = recognize(im)
    let sorted = warm.sorted()
    units.append([
      "image": f, "region": name as Any, "w": im.width, "h": im.height,
      "detInput": [im.width, im.height], "detBucket": [im.width, im.height],
      "loadMs": 0, "coldMs": cold, "warmMs": warm,
      "warmMedianMs": sorted.isEmpty ? 0 : sorted[sorted.count / 2],
      "cachedMs": cached, "detMs": 0, "boxes": last.count,
      "lines": last.count, "cachedLines": last.count,
      "texts": last.map { ["text": $0.0, "score": $0.1, "rect": $0.2] },
    ])
  }
}

let doc: [String: Any] = [
  "engine": level == .fast ? "vision-fast" : "vision",
  "platform": "macos", "arch": "x86_64",
  "threads": ProcessInfo.processInfo.activeProcessorCount,
  "detBucket": false, "prewarm": false, "scale": 1, "runs": runs,
  "models": "Apple Vision (VNRecognizeTextRequest)", "units": units,
]
let out = try! JSONSerialization.data(withJSONObject: doc, options: [])
FileHandle.standardOutput.write(out)
