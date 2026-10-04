# stream-desktop（Stream Desktop 的本机进程）

The host side of the **host-desktop Engine**. A thin sidecar that connects to the backend's
`/api/host` WebSocket and executes the desktop ops (a11y locate/read + input) on **this machine**.
The backend holds all recipe logic; this agent is a pure executor (mirrors the ext-cdp extension).

The op flow was proven live via the PowerShell stand-in (`tg_verify.ps1`, 2026-07-19); this is that
flow in Rust. Design: `internal design record`.

它还兼一份**第二职业**：Chrome 的 **native messaging host**（`--native-messaging`），把本机
`data/ext-relay-token` 递给我们那个扩展。见下面「Native Messaging」一节。

## Layout

- `src/protocol.rs` — wire types + `Desktop` trait + op dispatch. **Platform-independent, unit-tested**
  (`cargo test` on any OS).
- `src/datadir.rs` — 找 Stream 的 `data/` 目录、读 `ext-relay-token`。**平台无关，纯函数 + 单测。**
- `src/nativemsg.rs` — Chrome native messaging 的 wire 编解码 + 请求处理。**平台无关，单测。**
- `src/register.rs` — `--register` / `--unregister`：manifest 正文、三平台落地位置、参数解析。**单测。**
- `src/windows.rs` — Windows **UIA** (locate/invoke/read) + **enigo** (input) + **xcap** (screenshot)
  backend. `#[cfg(windows)]`; cross-compiles clean for `x86_64-pc-windows-gnu`.
- `src/see.rs` / `src/see_detect.rs` — `see` 词汇的识别层。`see.rs` 是模板匹配（`findImage`）与
  OCR 前的缩放几何；`see_detect.rs` 是 `readScreen` 的 `clickables`——letterbox 几何、反算回源图
  坐标、NMS 都是平台无关的算术（Linux 上有单测），只有跑 ONNX 的那一小段是 `#[cfg(windows)]`。
- `src/relay.rs` — reconnect policy (exponential backoff, 1s → 30s, reset once a session connects —
  same semantics as the extension's `driver.ts`). **Pure, unit-tested.**
- `src/main.rs` — WS client + dispatch loop, wrapped in a supervisor loop: the agent's lifetime is
  **not** tied to one WebSocket, so a backend restart never orphans it (only the parent shell dying
  or a kill ends the process). macOS (AX) / Linux (AT-SPI) backends slot in later behind their own
  `cfg` (the `NotSupported` stub keeps the crate building everywhere meanwhile).

## Build

```bash
# protocol-layer tests (any OS)
cargo test

# cross-compile the Windows backend from WSL/Linux (checks it compiles)
cargo check --target x86_64-pc-windows-gnu

# on Windows: a runnable agent
cargo build --release            # → target/release/stream-desktop.exe
```

## Run

**不用给任何环境变量。** relay URL 默认就是后端自己绑的那个口（`ws://127.0.0.1:8900/api/host`，
没有代理），token 自己去 data 目录读（顺序见下面「data 目录怎么找到的」）。

```powershell
.\stream-desktop.exe                 # Windows
```

从 WSL 起也是同一条命令——它是 Windows 二进制，但 WSL 直接执行，不需要 Windows shell：

```bash
./app/host-agent/target/x86_64-pc-windows-gnu/release/stream-desktop.exe
```

要覆盖时才给 `STREAM_HOST_URL` / `STREAM_HOST_TOKEN`。**从 WSL 覆盖必须同时给 `WSLENV`**
（`WSLENV=STREAM_HOST_URL:STREAM_HOST_TOKEN`）——否则 Windows 那侧读到的是空值，而且不会说
为什么。这也正是默认值存在的理由：常规路径上根本不该碰到这个坑。

## `clickables` 的模型文件（可缺席）

`readScreen` 的 `want` 里带 `clickables` 时，agent 会拿一个小的 ONNX 图去问"画面上哪些地方
看起来能点"。**这个文件是可选的**：不在场就回空数组、不报错，只在第一次尝试时打一行
`[see] 检测器缺席（…）`；上层的 `see` 梯子会退回用文字框来编号候选。

- **文件名**：`see-detector.onnx`，默认放在 **exe 同目录**（不是当前工作目录——agent 是被后端
  拉起来的，按 cwd 找等于让"从哪儿启动"决定这个能力在不在）。
- **换个位置**：环境变量 `STREAM_SEE_DETECTOR` 指一个绝对路径。从 WSL 给它同样要带
  `WSLENV=STREAM_SEE_DETECTOR/p`，否则 Windows 那侧读到空值且不会说为什么。
- **权重从哪来**：OmniParser V2 的 `icon_detect` 权重（一个单类的 YOLOv8-nano，类别就是
  "可点的界面元素"），用 ultralytics 官方命令导成 ONNX：

  ```bash
  yolo export model=icon_detect/model.pt format=onnx imgsz=640
  ```

- **运行时**：和读屏同一份 ONNX Runtime（`ort` crate `load-dynamic`，运行时 dlopen 随平台包出货的
  官方动态库，`ocr.rs` 头注；为什么是它、为什么没有第二个引擎见
  `internal design record`）。检测器模型可缺席（上面
  那条），**运行时库不可缺席**：库不在场时检测器和读屏一起报 `ort-missing`，检测器那一档同样退成
  空数组 + stderr 一行 `[see] 检测器读不动（…）`。
- **管线**：letterbox 到 640×640（补边灰 114）→ RGB→CHW f32/255 → 输出 `[1, 5, 8400]`
  （cx, cy, w, h, conf）→ conf ≥ 0.3 → 反 letterbox 回**截图坐标系**（同 `texts[].rect`，
  相对窗口左上角、物理像素）→ NMS IoU 0.5 → 最多 200 个。

检测器**不随平台包出货**（80MB；读屏模型三件与 ONNX Runtime 动态库才出货，清单在
`capabilities/desktop/README.md`「平台包与版本」）；要用就手工放到 exe 旁边。

## Native Messaging —— 把 token 交给扩展

扩展连后端 WS 时**不校验对端身份**：token 是它向对端索取的，对端给什么就用什么。于是本机任何
进程抢到 `8900` 就拿到这条通道的全部能力（任意页面 `Runtime.evaluate`）。修法是用**文件系统当
带外通道**——`data/ext-relay-token` 只有同一个用户读得到。扩展读不了文件，但能通过 Chrome 的
native messaging 拉起一个本机可执行文件；那个可执行文件就是这个 agent。

**这条路平台无关**（纯 stdio + 读文件），Linux/mac/Windows 都立刻能跑，不依赖 UIA 那一半。

### Wire 协议

Chrome 的格式，不是我们定的：**4 字节 native-endian（主机字节序）长度前缀 + 该长度的 UTF-8 JSON
body**，stdin 收 / stdout 发。**stdout 上除了帧不许有任何别的字节**——一个 `println!` 就能把协议
打断，且表现是扩展那边收到乱码后静默断开。所以本模式下所有日志走 stderr。

请求（`id` 可选，原样回带）：

```jsonc
{ "op": "token", "id": 1 }   // 要 relay token
{ "op": "ping",  "id": 2 }   // 存活/版本探测，不需要 token 也能答
```

响应（**永远有一条**，永远不 panic、不静默）：

```jsonc
{ "ok": true,  "id": 1, "token": "<ext-relay-token>", "source": "/…/data/ext-relay-token" }
{ "ok": true,  "id": 2, "version": "0.1.0" }
{ "ok": false, "id": 1, "error": "找不到 ext-relay-token：设置 STREAM_DATA_DIR …" }
```

`ok:false` 的三种来路：读不到 token（`error` 里说了试过哪些目录）、body 不是合法 JSON、`op` 不认识。
**永远不会回一个空 token** —— 扩展拿到空串会照样去连，然后在 401 上打转，没人知道真因。

### 模式是怎么判出来的

**Chrome 不允许清单的 `path` 带参数**，所以我们没机会用自己的 flag 被拉起来。判据只能是 Chrome
自己塞进 argv 的那两样：调用方 origin（`chrome-extension://<id>/`）和 `--parent-window=<handle>`。
`--native-messaging` 那条只为手工调试留着（`is_native_messaging` 三条都认）。

### data 目录怎么找到的

token 以前是人手喂进环境变量的。Chrome 拉起我们时中间没有人，所以「token 从哪来」必须由 agent
自己回答。候选目录**按优先级从高到低**（`datadir.rs::candidate_data_dirs`，改了这里就要改那边）：

| # | 来源 | 说明 |
|---|---|---|
| 1 | `STREAM_DATA_DIR` | 显式指定，最高优先 |
| 2 | `config.yaml` 的 `item_db` 所在目录 | config 位置：`STREAM_CONFIG` → `$STREAM_DATA_DIR/config.yaml` → 从 cwd 向上找 → 从 exe 目录向上找（各最多 6 层）。`item_db` 是相对路径时**按 config.yaml 自己的目录解析**，不是 cwd（Chrome 拉起时 cwd 是 Chrome 的） |
| 3 | 可执行文件旁边 | `<exe>/data`、`<exe>/../data`… 向上最多 6 层 |
| 4 | cwd 旁边 | 同上，向上最多 6 层 |

token 本身另有一条更严的判据：候选目录里**第一个真的躺着 `ext-relay-token` 的**。一个存在但还没
生成 token 的空 `data/`（比如某个 worktree）不会把解析卡死在那儿。
`STREAM_HOST_TOKEN` 若非空则**跳过整套解析**直接用它。

### 登记 / 撤销

```bash
stream-desktop --register   --extension-id <32 位 id> [--host-name com.stream.desktop] \
                               [--exe <path>] [--manifest-dir <dir>] [--target linux|macos|windows]
stream-desktop --unregister [--host-name …] [--manifest-dir …] [--target …]
```

`--extension-id`（或 `STREAM_EXTENSION_ID`，逗号分隔多个）**必须给**：`allowed_origins` 是这条链路
唯一的准入闸门，代码里不会替你猜一个 id——猜错不会报错，只会把一把能拿 token 的钥匙交给别的扩展。
id 会先按 Chrome 的文法校验（32 个 `a`–`p` 的字母）再落任何盘。

`--target` 不给就按本机推（Windows → windows；macOS → macos；**WSL → windows**，因为用户的
Chrome 装在 Windows 上，给 WSL 的 `~/.config` 写等于写给一个没人用的浏览器）。落地位置：

| target | manifest 去哪 | 浏览器怎么找到它 |
|---|---|---|
| Linux | `~/.config/{google-chrome,chromium,microsoft-edge}/NativeMessagingHosts/<host>.json` | 就是这个约定目录 |
| macOS | `~/Library/Application Support/{Google/Chrome,Chromium,Microsoft Edge}/NativeMessagingHosts/<host>.json` | 同上 |
| Windows | `%USERPROFILE%\.stream\NativeMessagingHosts\<host>.json` | 注册表 `HKCU\Software\{Google\Chrome,Chromium,Microsoft\Edge}\NativeMessagingHosts\<host>` 的**默认值** = 那个 json 的 Windows 路径 |

Linux/macOS 只往**配置根已经存在**的浏览器写（没装的不给它凭空造目录），跳过的会在报告里说明。

### WSL → Windows 那一跳（本项目的实际场景）

WSL 里的 `--register --target windows` 会：manifest 写进 Windows 用户目录（`cmd.exe /c echo
%USERPROFILE%` → `wslpath -u`）、注册表键用 `reg.exe` 写、路径用 `wslpath -w` 转成 Windows 形式。
`--unregister` 原样撤掉。**已实测过一整轮**（写键 → `reg query` 核对默认值 → 撤 → 再查报找不到）。

**唯一的真陷阱是 `path` 指哪个可执行文件**：WSL 里跑的这一份是 Linux ELF，Windows Chrome 执行
不了它。所以 `--target windows` 时默认去找交叉编译产物
`app/host-agent/target/x86_64-pc-windows-gnu/{release,debug}/stream-desktop.exe`，找不到就**报错
要求显式 `--exe`**，不会拿 Linux 二进制去糊弄。给的路径会被 `wslpath -w` 转成 Windows 形式。

`wslpath -w` 对仓库里的 exe 会转出 `\\wsl.localhost\...` UNC 路径，**Chrome 从 UNC 路径能
正常拉起 native host**（2026-08-29 活体实测：登记完约 30s 后扩展自己退避重连上，
`/api/ext/relay-status` 翻 `connected:true`）。所以不必把 `.exe` 拷到 Windows 侧。

**别给 Windows 版 agent 传 `--exe <Linux 路径>`。** 它自己就是 Windows 进程，不给 `--exe` 时
`resolve_exe()` 取 `current_exe()`，那本来就是 Windows 形式的路径；而 `cfg!(windows)` 为真时
显式给的路径会被**原样**写进 manifest（那个 wslpath 转换分支只在 Linux 二进制上生效）。
写进去一个 `/home/...`，Chrome 报 `Specified native messaging host not found.`，扩展表现成
「ws off」永远连不上——两边都不报错，日志里只有 `pairing-refused`。

### 手工调试

```bash
# 不装扩展也能试：喂一帧，看回一帧
stream-desktop --native-messaging   # stdin/stdout 说 wire 格式，日志在 stderr
```

Once connected, `hostRelay.connected` flips true on the backend and a `kind:'desktop'` source
(e.g. `telegram-search`) can drive it. Verify end-to-end by invoking the telegram-search source and
comparing against the live Telegram window (the "read == what's on screen" discipline — there is no
API oracle).

## Status

- protocol/dispatch/WS: unit-tested (Linux). Window resolution, the lock/foreground gates and the
  post-action read-back all live in `protocol.rs`, so they are testable off-Windows.
- Windows backend: runtime-verified live (window enumeration, title disambiguation, scope-vs-focus,
  and a real click through `cdp_act`).
- Follow-ups: `ValuePattern` read + `from`-query in `readSubtree`, DPI/scaling calibration.

**Driving it ad hoc** (no recipe): `cdp_look` / `cdp_shot` / `cdp_act` / `cdp_pages` with
`target: 'desktop'` or `'app:<process>[/<title>]'`. See the `drive-live-ui` skill — including the
one trap that costs the most time: **UIA reading an element is not evidence that clicking it will
land** (background tabs keep a live a11y tree; a locked desktop refuses input while reads keep
working).
