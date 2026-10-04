# Stream Desktop —— Stream 的内置电脑操作能力

装了 `@streamapp/stream` 就有它，**不用也不能单独装**（`private: true`，不发 npm）。
它随后端 bundle 出货，由后端在自己进程里 mount：`src/host-agent/mount.ts` 把这个目录当成一个
名叫 `desktop` 的 `Capability` 交给能力宿主（`src/capabilities/host.ts`），日志前缀因此是
`[stream-desktop]`。

本机那个进程叫 `stream-desktop`：可执行文件名、native messaging host id `com.stream.desktop`、
npm 平台包 `@streamapp/desktop-<平台>`、注册表键路径、release tag 前缀 `desktop-v*`、环境变量
`STREAM_NO_DESKTOP` —— 这些是**线上常量**，写进每一台配对过的机器上的浏览器清单与注册表。
改其中任何一个，那些机器就得重新 `--register` 一次；不重配的表现是静默失联（扩展拿不到 relay
token，而且不报错）。

**目录名仍是 `src/host-agent/`**（连同后端的 `src/host-agent/` 与 `app/host-agent/`）——纯内部
路径，用户看不见，没跟着改名。

这个目录留在 `capabilities/` 而不是并进 `src/`，是因为它和 `platforms/`（`stream-desktop`
的 npm 平台包）、`scripts/provision*`（真机备机手册与探针）是一整套——拆开只会让「那个 exe 到底
从哪来」散成三处。

## 这里还剩什么、什么归后端主路（对账表）

浏览器那条主路整个在后端（会话组、facility 面、DebugBox），这个包里没有第二份。

**别往这个包里加一份"自己起中继 / 自己物化扩展 / 自己判归属让位 / 自己注册 `cdp_*`"的简化版。**
后果是同一件事有两份实现：两份都挂着的话，能力宿主的工具名同名硬拒会在启动时当场红；只挂一份
的话，用户机器上那半永远是被主路的会话组管不到的那半。唯一的宿主是 Stream 后端，所以这个包只
交出后端够不着的那部分（下表 `保留` 那几行）。

| 东西 | 后端里对应的是谁 | 结论 |
|---|---|---|
| `src/host-agent/*`（`binary.ts` 解 exe、`agent.ts` 养进程、`index.ts` 的 `mountHostAgent`） | `src/host-agent/mount.ts` 经能力宿主挂它 | **保留**——后端是它唯一的消费者 |
| `src/wsl.ts`（`detectWsl` / `translateToWindowsPath` / `buildWindowsAgentEnv` / `buildRegisterEnv`） | `src/host-agent/index.ts` 的两次 spawn（常驻 agent、`--register`）都从这一份取判据 | **保留** |
| `src/extension-id.ts`（`STREAM_EXTENSION_ID`） | 与后端 `src/browser/` 那份同值 | **保留** |
| `src/cookies.ts`（服务名常量 `BROWSER_COOKIE_SERVICE` + `BrowserCookieService` 类型） | `src/serve.ts` 用这个名字 `provide` 后端自己那份实现；`capabilities/netdisk` import 同一个常量 | **保留**——名字分家的表现是转存永远回「没有登录态」，没有一处会喊 |
| `platforms/`、`scripts/provision-win-test.md`、`scripts/provision/*` | `scripts/build-server.mjs` 拷 bin、release workflow 发平台包、真机备机照着手册做 | **保留** |
| 中继、扩展物化、`cdp_*` 的注册、`/api/ext/verify`、归属让位、relay token | 后端主路：`attachExtRelay` + `src/mcp/cdp-router.ts` + `src/browser/extension-dir.ts` + `src/http/ext-verify.ts`；`--register` 由 agent mount 自己做 | **不在这里**——这些只有一份，在后端 |
| DSH 那张脸（`cordis.patch.yml`、`package.json` 的 `dsh` 字段、`@deepseek-ai/dsh-tools`） | 无：DSH 经 `/api/mcp` 用 Stream 的工具面，不装能力包 | **不在这里** |

桌面那一半**不交出动词**：`target:'desktop'` / `'app:<进程>'` 那几档来自后端的 `cdp_*`，
养着 agent 是为了让它们有东西可驱动。二进制按平台走 npm 可选子包
`@streamapp/desktop-<os>-<cpu>`（源码 `platforms/`）：`win32-x64`、`darwin-x64`、
`darwin-arm64`，别的平台解不到就记一行日志。

**这只手是两半，平台可以只有一半**——两个事实分开记，`src/host-agent/binary.ts` 里各有一份名单：

| | 判据 | 今天是谁 | 没有它会怎样 |
|---|---|---|---|
| **配对**（native messaging + `--register` 写浏览器根与 `~/.stream/datadir` 指针 + 递 relay token） | `HOST_AGENT_PACKAGES`（有没有二进制） | win32-x64 / darwin-x64 / darwin-arm64 | 扩展永远 `never-seen`，要登录态的源全是游客态——不报错，只是采得少采得浅 |
| **桌面控制**（控件树 / 坐标输入 / 窗口枚举 / 截图 / 读屏 / 找图） | `DESKTOP_CONTROL_PLATFORMS` | win32（UIA + PrintWindow）/ darwin（AX + CGWindowList） | `cdp_*` 的 `desktop` / `app:<进程>` 两档不可用 |

mac 上 `Desktop` trait 的每个动词都有实现（`app/host-agent/src/macos.rs`）；落在 trait 默认实现上、
mac 没有对应物的只有 `postInput`（`PostMessage` 投消息，recipe 的 `input:"message"`）、`nudgeInput`
（走 `moveMouse`）、`sessionLocked`（报"没验到"）。识别层（PP-OCR / 模板匹配 / 检测器）与 Windows
是同一份代码，mac 只补了取图那一环。**四条 mac 专属的硬事实**（活体 2026-09-12，Intel Mac /
macOS 14.6.1 / Retina 2×）：

- **坐标口径是点，不是物理像素。** AX、`CGEvent`（点击）、CGWindowList 的边界天然都是点，只有截图
  是 2× 的物理像素；所以 mac 把截图那一端换算到点：`screenshot` 交出去的图缩到点分辨率
  （宽高 == `window.w/h`），`readText` / `readElements` 在物理分辨率上识别、框出门 ÷ scale。
  判据：`see-probe` 打出的 `screenshot.imageW/H == rect.w/h`（实测 1049×764 对 1049×764，`scale: 2`，
  内部截图 2098×1528）。`scale` 只作诊断与缓存键，和 Windows 同一条约定。
- **截图要「屏幕录制」授权，授给的是起 `stream-desktop` 的那个应用**（和「辅助功能」同一条规矩）：
  开发验证经 ssh 起 → `/usr/libexec/sshd-keygen-wrapper`；用户机器上由后端拉起 → 起后端的那个终端
  / Stream 自己。**缺了不报错，CGWindowList 只给一张纯色图**——agent 先问 `CGPreflightScreenCaptureAccess`，
  拿到图后再验一次"不是纯色"，两道闸任一不过都报错（`screen-recording-denied` / `blank-capture`），
  绝不把壁纸交给 OCR。
- **锁屏下读不了**，和 Windows 正相反（Windows 锁屏不挡 UIA 读、`PrintWindow` 照截）：锁着时 AX 把
  每个窗口的 `AXTitle` 塌成应用名、`AXPosition`/`AXSize` 全是 0（`windows()` 列出来全是
  `微信/微信` × 4 这种），CGWindowList 截出来整张纯色（`blank-capture`）。所以 mac 上靠"眼睛"的
  recipe 只能在解锁状态跑；`see-probe` 在锁屏下会如实报 `blank-capture` 或 `ambiguous-window`。
- **读屏和 Windows 同一条判据、同样没有回落**：PP-OCR 三件模型缺席报 `ocr-missing`、ONNX Runtime
  动态库缺席报 `ort-missing`，`readText` / `readElements` 直接报错。本地验证要把模型三件和
  `libonnxruntime.dylib` 放到 `stream-desktop` 同目录（或分别用 `STREAM_OCR_MODELS` / `STREAM_ORT_LIB`
  指过去）。

实测成本（微信主窗 1049×764 点、QQ 960×640 点）：截窗 60–80ms；控件树 2–40ms
（微信 / QQ 各 3 个可交互控件——自绘应用，和 Windows 一样靠像素路）。微信整窗 66 段文字、
QQ 65 段，中文全部可读（`Athena麻麻`、`群聊的聊天记录`、`康琪: [链接]学生端-裂变分享操作指南`）。
读屏热态耗时（`research record` §2，1× 图集）：Windows 小区域 18ms / 标题条 36ms /
整窗 774ms，mac 21 / 43 / 875ms；引擎不按形状编译，第一次读 ≈ 热态。跑的是哪一份引擎看 `see-probe`
回执的 `engine{name,version,threads,lib}`（加载日志同一行 `[ocr] engine = ort …`）；线程数
`STREAM_OCR_ORT_THREADS`，缺省 `min(物理核, 8)`——多核机上放任默认线程数反而慢（研究档 §2）。
`scale > 1`（Retina / Windows 200% DPI）时
**检测在缩到逻辑 1× 的图上跑、识别从物理像素上裁**（det 成本按面积走，2× 是 4 倍时间，1× 上框一个不少；
但识别必须吃物理像素——rec 把每行拉到高 48，1× 上 14px 的行放大 3.4 倍会掉字，mac 实测「没事儿」→「没事」），
日志 `[see-read] … ocr@det1x`。同一窗口 A/B（2026-09-13，2098×1528，切引擎前量的，比值仍成立）：物理 7.3–8.5s → 2.3–3.1s。
`STREAM_OCR_PHYSICAL=1` 让检测也留在物理分辨率上（日志 `ocr@phys`），只为 A/B 量准确率用。同一帧（像素一样）连读不重认——`expect` 轮询那几轮
只付一次，日志 `[see-read] cache hit (same frame)`；`STREAM_OCR_FRAME_CACHE=0` 关掉它
（`see-probe` 自己就关，否则它第二遍量到的是哈希不是 OCR）。

所以**桌面控制不支持的平台跑 `--register`，但不起常驻 agent**：配对靠的是
Chrome 自己按 manifest 拉起 agent，和常驻那条命无关；而常驻 agent 在那些平台上连上 `/api/host`
之后每个 op 都 `unsupported`，是「装得上、一动就报错」那个形状，还白占一个进程。
`src/host-agent/index.test.ts` 有一条测试两个方向都钉着它。

`darwin-x64` 已在真机（Intel Mac / macOS 14.6.1）验过编译与配对；`darwin-arm64` 只做到编得过，
**尚未在真机上验过**。

## 排错

- **扩展一直连不上**：先看后端日志里 `--register` 那行（native messaging 没登记，Chrome 拉不起
  agent，扩展拿不到 token 就一个候选都不问）。
- **改了 `app/host-agent/` 的 Rust 代码**：光编译不生效，产物要拷到
  `platforms/desktop-win32-x64/bin/`（agent 真正被拉起的那个路径）。步骤见
  `.claude/skills/drive-live-ui/SKILL.md`。
- **在一台真机上从零备齐**：`scripts/provision-win-test.md`（每一步带判据，含负对照）。
- **接管提示 = 屏幕四边一圈七彩内阴影 + 顶部一条两行的提示条**（Windows `overlay_win.rs`、mac
  `overlay_mac.rs`，画面一致；mac 上渲染层占主线程、监督循环在自己的线程上跑，见 `main.rs`）。四边描边
  是"AI 正在操作你的电脑"这句话本身（每块显示器一圈、色相缓慢转动、已停止褪灰），条子只讲
  "在干什么 + 怎么停"：
  ```
  微信发消息 · 发给 文件传输助手   按 [Ctrl][Alt][Esc] 停止   ← 第一行：recipe 显示名 · 这次的目的 + 热键
  点候选里的他 (8/12)                                       ← 第二行：当前子步骤
  ```
  两行文字由后端每步发 `status` op 写上去，wire 上是一个 `第一行\n第二行` 的文本（`app/host-agent/
  src/overlay.rs` 的 `split_status` 拆；没有换行的文本只占第一行；`null` 时第一行只剩热键说明）。
  `status` 归 QUIET、不点亮。不想要就在后端侧 `STREAM_DESKTOP_STATUS=0`。老 agent 不认这个 op，
  后端静默吞掉——条子只剩热键说明，recipe 照跑。每行超宽各自末尾截 …；"已停止"只有一行、无热键。
  条子和四边长什么样人眼验：`stream-desktop.exe overlay-demo [停留秒数，缺省 5]`（带一段示例步骤
  文字）。**别每帧 `SetWindowPos(HWND_TOPMOST)`**：条子和四边都是置顶窗口且重叠，每帧互相插队
  肉眼就是条子频闪——只在第一次亮起时 show + 置顶，之后只换像素。
  **亮灭规则**：第一个键鼠 / 抢前台的 op 点亮；任务文字挂着（一趟 recipe 在跑）就一直亮到后端
  清掉文字，中间几秒的读屏不熄（`STATUS_STALL` 两分钟没有任何动作才算后端卡死、熄掉）；没有
  任务文字的零散 op 空闲 `LINGER` 1.5s 熄。关了 `STREAM_DESKTOP_STATUS` 就只剩后一档——条子
  会在长读屏之间灭了再亮。
- **坐标 `click` 会先把指针滑到目标再按**（约 250ms + 到位停 80ms；`app/host-agent/src/glide.rs`）。
  一趟 recipe 里每个坐标点击因此多约 330ms，`moveMouse` / `type` / `scroll` 不变。
- **`~/.stream/datadir` 指针指着一个陌生目录**：这台机器上有别的东西登记过 native messaging
  （指针和登记都只有一份、后写者赢、都不吭声）。删掉这个指针文件后重启后端即可——后端会重新
  登记并把指针改指向自己的 dataDir。

## 平台包与版本

**平台包升版时，`optionalDependencies` 里的 pin 必须一起改。**
`.github/workflows/release-desktop.yml` 的 publish 步骤是「npm 上已存在该版本就跳过」——
只重发了平台包（`@streamapp/desktop-win32-x64` 等）、pin 没动，新 exe 确实上了 registry，
但没有任何理由重新解析 `optionalDependencies`，已装用户永远拿不到它，且没有一处会报错或提示。

**三个平台包的 `bin/` 出货清单**（exe 按同目录找后两类，都不在 git 里，workflow 从 GitHub release
下载、按仓库里的 sha256 核过再打包）：

每个平台包的 `package.json#files` 按下表逐文件列出，不接受 `bin/` 这种目录条目；发布闸也会拒绝
目录里存在白名单外的文件。这样本机构建用的 `see-detector.onnx` 不会随 npm 包发出。

| 东西 | 文件 | 大小 | release / 校验和 | 导出 |
|---|---|---|---|---|
| 可执行文件 | `stream-desktop(.exe)` | 19.7MB（gnu 交叉编译产物） | CI 现编 | — |
| 读屏模型（PP-OCRv5 三件） | `ocr-det.onnx` / `ocr-rec.onnx` / `ocr-rec-dict.txt` | 约 21MB | `desktop-models-v1` / `platforms/models.sha256`（**一份**，三个 job 共用） | `scripts/export-ocr-models.sh` |
| ONNX Runtime 1.20.1（识别层唯一引擎） | Windows `onnxruntime.dll` + 它依赖的 VC++ 运行时三件 `msvcp140.dll` / `vcruntime140.dll` / `vcruntime140_1.dll`；mac `libonnxruntime.dylib` | dll 11.6MB + 三件 0.7MB；dylib x64 28.6MB / arm64 25.5MB | `desktop-ort-v1` / `platforms/ort-<pkg>.sha256`（**一平台一份**；release 上 mac 两份 dylib 带 `darwin-x64-` / `darwin-arm64-` 前缀区分，CI 下载后改回约定名再核） | `scripts/export-ort.sh` |

**缺了不回落、也不在装机时报错**：模型缺席 `readText` / `readElements` 报 `ocr-missing`，运行时库缺席
报 `ort-missing`（两平台同一判据），要到第一次读屏才看得见，`/api/health` 照绿——所以 workflow 里
每一份都要核 sha256、核完再 `test -f` 主文件。换模型 / 换 ort 版本必须两处一起动：新 release tag +
改那份 sha256（ort 还有第三处：`ocr.rs` 的 `ORT_VERSION`）。VC++ 三件是 `onnxruntime.dll` 的依赖，
干净装机的 Windows 没有——少了它 dll 加载失败，同样报 `ort-missing`。检测器 `see-detector.onnx`（80MB）**不出货**：它只在
视觉模型那一段之前补可点框，文字目标用不到；要用就手工放到 exe 旁或 `STREAM_SEE_DETECTOR`
（导出脚本 `scripts/export-see-detector.sh`），缺席时 `clickables:[]`、stderr 一行。

三处必须是同一个数，各有一条测试钉着：本包的 `optionalDependencies`、
`platforms/<pkg>/package.json` 自己的 `version`（`scripts/desktop-platforms.test.ts`），
以及发行包 `cli/package.json` 的同名格（`src/host-agent/mount.test.ts`）——发行装机时 exe
是从**那一格**解出来的，本包 private 之后它才是用户机器上真正的来源。

npm 上曾经发过的 `@streamapp/browser` 与 `@streamapp/computer-use` 已 deprecate，指向
`@streamapp/stream`。**本包 `private: true`、永远不发 npm**，所以它叫 `@streamapp/desktop`
和 registry 上那个同名的旧包不冲突——这里的名字只是工作区内的标识。
