# android-visual-text-fallback

## Why

有些 App 的界面是自绘的：无障碍树里只有十几个没有 `text`、也没有 `contentDescription` 的
容器节点（典型：购物类 App 的规格选择页——口味、数量、价格、底部「加入购物车」全在画布上）。
`find` / `ui.tree` 在这种页面上什么都给不出来，调用方只能整屏截图交给模型看图。

模型看图有两个代价：一次往返的延迟，以及「看图点击」这件事在敏感闸面前是隐形的——
`click(rect)` 今天只在无障碍树里找落点，找不到节点就**没有任何判定**，直接点下去。
购物 / 支付 / 金融类 App 里一次盲点击可能正好落在「提交订单」上。

本变更给设备端补上**本地、离线**的文字识别（OCR）：无障碍树「看不见」时，对前台窗口截图做
识别，产出与无障碍元素同形状的文字元素，供 `find` 命中、供 `click(rect)` 落点判定；
同时把闸的盲区补上——落点既没有节点也没有 OCR 文字时，在购物 / 支付 / 金融类 App 里按
`commit-unrecognized` 处理。

## What Changes

- **设备端 OCR（离线）。** 执行端在请求方要求（`find` 的 `ocr` 参数）或无障碍树「看不见」
  （前台窗口里**有名字**的可见节点少于阈值，缺省 3）时，对前台窗口截图做文字识别，产出
  `{text, rect, confidence, source: "ocr"}` 形状的文字元素：`role` 为 `"ocr-text"`，
  `name` 即识别到的整行文字，坐标是截图像素（即屏幕像素）。元素可被 `find(nameContains)`
  命中，可用 `click(rect)` 点击；也带一个 ref，`invoke(ref)` 等价于点击该行中心。
- **能力协商。** `hello` 的能力清单新增 `ui.ocr`（`v: 1`），表示执行端支持 `find` 的
  `ocr` 参数并能提供文字元素。旧调用方不传 `ocr` 时行为不变：正常页面（有名字的节点够多）
  不会触发 OCR，回执形状只是多了可选字段。
- **可关掉。** `find` 的 `ocr` 参数取 `auto`（缺省：只在「看不见」时跑）、`on`（总是跑）、
  `off`（不跑，回执里也不会有 OCR 元素）。
- **闸：OCR 文字走同一套判定。** `click(rect)` 的落点命中不到无障碍节点（或命中的节点没有
  名字）时，读落点 rect **里面**的 OCR 文字（不只中心像素：自绘按钮的标签画在一侧时中心点
  落在字外，点按并不盲），每一行各按一个标签走现有的 commit / payment / claim 判定，整帧的
  文字充当这些判定要读的「屏幕」——「加入购物车」「加购」不拦（屏上有价格也不拦），
  「提交订单」「立即支付」「立即购买」「领券购买」照拦；单独一个「确定」在屏上既没有
  提交字样也没有金额、且能看到加购字样时按规格弹层的收尾放行，有金额则按 `payment-label`
  出卡，其余情况保持 `commit-unrecognized`（这几条只对购物 / 支付 / 金融类目生效，与盲点击
  同一范围）。
- **闸：盲点击。** 落点既没有节点也没有 OCR 文字时，在购物 / 支付 / 金融类目（`shopping` /
  `payments` / `finance`）的前台窗口里按 `commit-unrecognized` 处理，宁可多一张审批卡。
- **性能。** 一次 OCR 的耗时写进回执的 `timing.ocrMs`；同一屏（截图字节的 SHA-256 不变）
  缓存识别结果，缓存命中不再跑引擎。
- **选型（见 design 一节）：** Tesseract4Android 4.9.0（Apache-2.0，JitPack），Tesseract
  （Apache-2.0）+ Leptonica（BSD-2-Clause）；中文与拉丁模型来自 tessdata_fast 4.1.0
  （Apache-2.0），首次使用时下载（`chi_sim` 2.4 MiB + `eng` 3.9 MiB，SHA-256 固定），
  存到 `filesDir/tessdata`。不选 ML Kit：其设备端 SDK 按 Google 的 ML Kit 条款分发，
  不是 Apache-2.0 兼容许可。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：`find` 的 `ocr` 参数与文字元素形状、`ui.ocr` 能力、OCR 缓存与
  `timing.ocrMs`、`click(rect)` 的落点判定顺序（ADDED Requirement）。
- `device-sensitive-semantics`：盲点击在购物 / 支付 / 金融类目的判定、OCR 文字按既有词表
  判定（ADDED Requirement）。

## Dependencies

- 依赖 `android-phone-surface` 的 `find` / 元素形状与 `scopeWindow` 语义；
  依赖 `device-sensitive-semantics` 的 `commit-unrecognized` / `approval-required` 通道；
  依赖 `device-capability-manifest` 的 `hello.caps` 机制（新 id 不需要改后端）。

## Non-Goals

- **不替代无障碍树。** OCR 是无障碍树看不见时的兜底：节点有名字时仍以节点为准，OCR 不会
  覆盖、合并或修正它。
- **不做图标识别与模板匹配。** 只有文字；图标按钮交给桌面侧的 detector（`ENGINE.md` §7.3）。
- **不做跨帧文字拼接。** 每个元素是引擎在一帧里的一行；同一行被拆成多段时，调用方用
  `nameContains` 匹配，拼接规则与 `pickTextDetailed` 的桌面实现不在本变更里。
- **不做云端识别、不把截图送出设备。** 识别在设备上完成。
- **不改桌面 agent 与浏览器扩展。**

## Impact

- `app/android/agent`：`Ocr.kt`（引擎接口、文字元素、截图缓存）、`ocr/TesseractOcrEngine.kt`
  （真引擎与模型下载）、`Dispatcher`（`find` 的 `ocr` 参数、`click` 的落点判定）、
  `Gate`（盲点击与 OCR 文字判定）、`policy/apps.json`（`shopping` / `payments` 类目）。
- `app/android/agent/build.gradle.kts`、`app/android/settings.gradle.kts`（JitPack 与依赖）。
- `docs/API.md`（Android 段：`find` 的 `ocr`、元素形状、能力清单、闸的判定表）。
- `src/replay/desktop-driver.ts`（`A11yElement` 的可选 `source` / `confidence`，纯类型）。
- `THIRD-PARTY-NOTICE`、`NOTICE`（Tesseract4Android / Tesseract / Leptonica / tessdata）。
- 单测：Kotlin `:agent:testDebugUnitTest`（假引擎，JVM 可跑）；`pnpm -r typecheck`。
