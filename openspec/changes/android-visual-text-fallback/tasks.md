# android-visual-text-fallback — tasks

## 计划 1：OCR 管线（纯 Kotlin，JVM 可测）

- [x] 1. `agent/Ocr.kt`：`OcrText { text, rect, confidence }`、`OcrEngine` 接口、
      `OcrTextNode`（`UiNode`，`role = "ocr-text"`，`className = "ocr"`，可点）、
      `OcrFrames`（按截图字节的 SHA-256 缓存，LRU 8 帧；计时；引擎缺席/报错时返回空而不是让 op 失败）
- [x] 2. `find` 的 `ocr` 参数：`auto`（缺省）/`on`/`off`；`auto` 只在前台窗口里
      「有名字的可见节点 < 3」时跑；只对前台窗口截图；关闭时回执不含 OCR 元素
- [x] 3. 元素形状与 ref：OCR 元素走同一个 ref 表（`r...` 单调递增），`className` 为 `"ocr"`，
      额外字段 `source: "ocr"`、`confidence`（0..1，三位小数）；`invoke(ref)` 点击该行中心；
      OCR 文字经 `maskCodeDigits` 遮码后再发出
- [x] 4. 回执：`ocr: {ran, cached, texts, error?}`、`timing: {ocrMs}`；截图失败
      （`secure-window` 等）只让 OCR 缺席，不让 `find` 失败

## 计划 2：闸

- [x] 5. `click(rect)` 落点：无障碍落点有名字 → 照旧；落点无名字或不存在 → 在落点处查 OCR
      文字（小于等于落点的最小元素优先），有文字就用它走 `Gate.reasons`；
      既无节点也无文字 → `blind`，在 `shopping` / `payments` / `finance` 类目里加
      `commit-unrecognized`
- [x] 6. `policy/apps.json`：新增 `shopping`、`payments` 两个非 deny 类目（常见购物 / 支付 App）
- [x] 7. 单测：OCR 文字「加入购物车」不拦；「提交订单」「立即支付」「立即购买」「领券购买」
      拦且不点击；盲点击在购物类目拦、在普通类目放行；`ocr:"off"` 时回退到盲点击规则；
      有名字的无障碍节点优先于 OCR

## 计划 3：真引擎、能力与文档

- [x] 8. `ocr/TesseractOcrEngine.kt`：Tesseract4Android（`cz.adaptech.tesseract4android`，
      JitPack），`chi_sim+eng`，`RIL_TEXTLINE` 逐行输出；模型首次使用时从 tessdata_fast 4.1.0
      下载到 `filesDir/tessdata`（SHA-256 校验、原子落盘），已存在则跳过
- [x] 9. `hello` 能力清单加 `ui.ocr` v1；`RelayService` 注入真引擎
- [x] 10. `docs/API.md`：`find` 的 `ocr`、元素形状与 `source`、`ui.ocr`、闸的判定表、
      模型体积与首次下载；`src/replay/desktop-driver.ts` 的可选类型
- [x] 11. `THIRD-PARTY-NOTICE` / `NOTICE`
- [x] 12. `:agent:testDebugUnitTest` 全量 + `pnpm -r typecheck`；环境性基线失败单列
