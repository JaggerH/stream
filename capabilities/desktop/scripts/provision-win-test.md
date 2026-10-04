# 在一台 Windows 机器上备齐「活体配对」所需的四件东西

这份清单只做**布置**，不做配对。真起一次后端让它铸 token、改 `~/.stream/datadir` 指针、
登记 native messaging host、起中继，是另一步，刻意分开：那一步会**抢走这台机器上浏览器的
归属**，而抢的时候「后登记者赢，且不吭声」——它必须是一个人有意识发起、并且记录下来的动作，
不能混在布置里顺手发生。

**判据只有一条：每一件都要有「我让它自己开口说话」的证据。** `scp` 完 `dir` 一下不是证明——
文件在那儿和它能在这台机器上跑起来是两件事，而后者失败的时候前者看上去完全正常。

---

## 0. 前置

- 目标机能 SSH 进去（下面所有命令都是从开发机经 SSH 发过去的）。
- 目标机装了 node（本次实测 v24.19.0；`observe2.mjs` 用了 Node 22+ 才有的全局 `WebSocket`，
  再老的 node 要自己带 `ws`）。
- 目标机有能出墙的 HTTP 代理（本次是 Clash Verge 的 `127.0.0.1:7897`）。Chrome for Testing 的
  构建在 `storage.googleapis.com` 上。

**SSH 会话的四条坑，别重新学一遍：**

1. **单行 `cmd` 里的 `%ERRORLEVEL%` 是在解析期展开的**，所以 `xxx.exe & echo EXIT=%ERRORLEVEL%`
   永远打的是上一条命令的陈旧值——它曾经为一次根本没发生的安装打印 `EXIT=0`。要真实退出码就走
   PowerShell：`$p = Start-Process ... -Wait -PassThru; $p.ExitCode`。
2. **SSH 会话落在 Windows 的 session 0，没有交互桌面**。需要桌面的东西在这里会「进程起来了、
   窗口层没起来」。本清单全程用 `--headless=new` 绕开这一点；真要 GUI 就挂一个登录触发的
   计划任务，让它在登录会话里跑。
3. **SSH 会话退出会带走它起的子进程。** 所以「起浏览器」和「问浏览器」必须写在**同一条**
   远端命令里（见 §1.3）。分两次 ssh 的表现是第二次 `ECONNREFUSED`，看起来像 CDP 没开。
4. **中文输出在这条通道上是乱码，而且 `chcp 65001` 一条不够。** 本仓库的日志、报告行、错误
   话术全是中文，直接 ssh 读回来是一屏 `M-iM-^HM-+`。ASCII 的路径不受影响，所以「乱码但看得懂
   路径」是常态，别以为程序出错了。要读中文就**把输出重定向到文件，再显式按 UTF-8 取回**：

   ```powershell
   # 远端：程序输出重定向到文件
   Start-Process <exe> -Wait -PassThru -NoNewWindow -RedirectStandardOutput C:\stream-pair\out.txt ...
   # 取回：控制台和 Get-Content 两处都要点名 UTF-8，少一处仍然是乱码
   powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Encoding UTF8 C:\stream-pair\out.txt"
   ```

   实测（2026-09-01）：只在 ssh 命令前加 `chcp 65001` 仍然乱码——程序写进文件的是 UTF-8，
   而 `Get-Content` 不带 `-Encoding` 时按 ANSI（这台机器是 GBK）去解，`chcp` 管不到它。
   两处都点名 UTF-8 才一次读对。

约定的落点（换机器就换这个前缀，其余不变）：

| 东西 | 落在哪 |
|---|---|
| Chrome for Testing | `C:\stream-pair\chrome-win64\` |
| 扩展（未打包） | `C:\stream-pair\extension\` |
| Stream | `npm i -g @streamapp/stream`（全局，不是 scp 上去的目录） |
| Stream Desktop 的本机进程 | `<npm root -g>\@streamapp\desktop-win32-x64\bin\stream-desktop.exe`——**它是 npm 装出来的，不是你 scp 上去的**（§3；平台包名与 exe 名是线上常量——改了要让每台机器重新 `--register`） |

下面用到的三个验证脚本都在本仓库 `capabilities/desktop/scripts/provision/` 下，一并 `scp` 到目标机即可：

| 脚本 | 干什么 | 放哪 |
|---|---|---|
| `ping-agent.mjs` | 让 Stream Desktop 自报版本（§3，**要在 §4 装完之后跑**） | `C:\stream-pair\` |
| `observe2.mjs` | 逐个 attach service worker 问它是谁（§5） | `C:\stream-pair\` |
| `observe-all.ps1` | 起浏览器 → 调 `observe2.mjs` → 收摊（§5） | `C:\stream-pair\` |

---

## 1. Chrome for Testing (win64)

**为什么不能用机器上那个 Chrome**：品牌版 Chrome 自 137 起移除了 `--load-extension`，
装未打包扩展只剩 GUI 一条路，而 SSH 里没有 GUI。Chrome for Testing 仍保留这个开关，
配对这条链又不依赖登录态，于是整轮可以全自动。

### 1.1 挑版本并下载

```powershell
# 版本清单（Stable 那一档的 win64 构建）
$env:NODE_USE_ENV_PROXY=1; $env:HTTPS_PROXY="http://127.0.0.1:7897"
node -e "const r=await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');console.log((await r.json()).channels.Stable.version)"
```

下载用 `curl.exe`，**必须带 `--retry --retry-all-errors -C -`**：经代理下 ~200MB 时
schannel 会中途断（本次断了两次，`UND_ERR_SOCKET` / `failed to receive handshake`）。
node 的 `fetch` 一次性把整份读进内存，断了就整份重来；curl 带续传能自己接上。

```powershell
curl.exe -sSL -x http://127.0.0.1:7897 --retry 8 --retry-all-errors -C - `
  -o C:\stream-pair\chrome-win64.zip `
  https://storage.googleapis.com/chrome-for-testing-public/<版本>/win64/chrome-win64.zip
```

**下完必须核大小**——curl 在续传循环里可能以 `HTTP=206` 收场，那个码不代表下全了：

```powershell
curl.exe -sSI -x http://127.0.0.1:7897 <同一个 URL> | findstr /I content-length
(Get-Item C:\stream-pair\chrome-win64.zip).Length     # 两个数必须相等
```

### 1.2 解包

```powershell
Expand-Archive -Path C:\stream-pair\chrome-win64.zip -DestinationPath C:\stream-pair -Force
```

### 1.3 验证：让它自己报版本

不要看 `(Get-Item chrome.exe).VersionInfo` 就收工——那是读文件头，证明不了它能跑。
真正的判据是**起来之后从 CDP 拿 `/json/version`**：

```powershell
$p = Start-Process C:\stream-pair\chrome-win64\chrome.exe -PassThru -WindowStyle Hidden -ArgumentList @(
  "--headless=new","--remote-debugging-port=9222","--user-data-dir=C:\stream-pair\cft-profile",
  "--no-first-run","--no-default-browser-check","--disable-gpu","about:blank")
Invoke-RestMethod "http://127.0.0.1:9222/json/version" -Proxy $null   # Browser: Chrome/<版本>
```

`-Proxy $null` 不能省：系统代理开着时 `Invoke-RestMethod` 会把 `127.0.0.1` 也送去代理。

### 1.4 它找 native messaging host 时读 Chrome 根与 Chromium 根，两者任一即可

**Chrome for Testing 读 `HKCU\Software\Google\Chrome\NativeMessagingHosts` 和
`HKCU\Software\Chromium\NativeMessagingHosts`**，任一在场就够；**不读** `Software\Microsoft\Edge`
那份，也不读它自己那个 `Software\Google\Chrome for Testing` 根（该根确实存在——`BLBeacon\version`、
`PreferenceMACs` 都在里面——但它**没有** `NativeMessagingHosts` 子键）。

单键实测（2026-09-01，CfT 152.0.7977.64；每轮先 `taskkill chrome.exe / stream-desktop.exe`，
新建 profile，键在后端的 `--register` 跑完之后、Chrome 起来之前删）：

| 留哪个键 | 结果 |
|---|---|
| 只留 `Software\Google\Chrome` | 连上 |
| 只留 `Software\Chromium` | 连上（复现两次） |
| 只留 `Software\Microsoft\Edge` | 45s 无连接，退出码 1 |
| 三个全删 | 45s 无连接，退出码 1 |
| 三个键都在，只把清单 JSON 挪走 | 45s 无连接，退出码 1 |

两条量它时会栽的坑：

- **删键必须排在 `--register` 之后**。agent 自己会把三个根全写回去，先删后跑等于没删。
- **上一轮的 chrome 必须杀干净**。中继口不变，上一轮那个扩展会连到本轮的新中继上，把本该红的
  一档变成绿。判据：连接时刻与本轮 Chrome 启动之间要有几秒；秒级之内冒出来的连接是残影。

所以 `--register` 写的 Chrome / Chromium / Edge 三个根**已经够了**，不要再手工往
`Software\Google\Chrome for Testing` 下面造键——那是个没人读的地方，而"往没人读的地方写"
失败得很安静：写成功了、配对还是不通，人会去查别处。

---

## 2. 扩展产物

开发机上：

```bash
cd <repo>/extension && pnpm build      # 产出 .output/chrome-mv3
```

**推 `chrome-mv3`，绝不推 `chrome-mv3-dev`。** dev 档里烘着一个热重载客户端，它会去连一台
目标机上并不存在的 WXT 服务器；那不会报错，只会让扩展的 SW 在启动期多一段无谓的重试。
推完在目标机上核一眼 `manifest.json` 里没有 `wxt` 字样、`key` 字段在。

验证见 §5（观察扩展 id 那一步同时就证明了它装得上、SW 跑得起来）。

---

## 3. `stream-desktop.exe`

后端靠它做两件事：问「这只手现在归谁」、以及 `--register` 登记 native messaging host。

**这份二进制不用你推——它是 npm 装出来的**，所以这一节要**排在 §4 之后**跑。
`resolveAgentBinary()`（`src/host-agent/binary.ts`）解析路径只有两级，且第一级几乎总是命中：

1. `require.resolve('@streamapp/desktop-win32-x64/bin/stream-desktop.exe')`——即全局
   `node_modules` 下那一份。它由 `cli/package.json` 的 `optionalDependencies` 声明，
   §4 的 `npm i -g` 顺带就把它装下来了。
2. 只有第 1 级抛错（平台包没装上）才回落到**包根下**的
   `platforms\desktop-win32-x64\bin\stream-desktop.exe`。

**没有任何一级会读 `C:\stream-pair\bin\`。** 往那儿放一份二进制不会有人用；要换一份去调试，
必须换掉 `node_modules\@streamapp\desktop-win32-x64\bin\` 里那一份（或换成上面第 2 级的位置）。
2026-09-01 那轮活体配对里三份二进制恰好逐字节相同，所以这个错位没造成任何差异——那是运气。

（仓库里另有一份 `capabilities/desktop/platforms/desktop-win32-x64/bin/stream-desktop.exe`，
**gitignored**、只在主检出里有。目标机装不上 npm 包时从它拷，落点是上面第 2 级那个路径。）

装完先让它开口——判据是它自己回一帧，不是文件在那儿：

```powershell
$agent = Join-Path (npm root -g) "@streamapp\desktop-win32-x64\bin\stream-desktop.exe"
Get-FileHash -Algorithm SHA256 $agent
node C:\stream-pair\ping-agent.mjs $agent
# 期望 REPLY={"id":1,"ok":true,"version":"0.1.0"}
```

`ping-agent.mjs` 就是照 native-messaging 的帧格式（**4 字节主机字节序长度前缀** + JSON body）
发一条 `{op:'ping'}` 再读一帧回来。

**为什么验的是 `ping` 不是 `token`**：`ping` 那条分支只回一个编译进去的版本号，**不碰文件系统**；
`token` 会去读 `~/.stream/datadir` 指着的那份，于是「二进制能不能跑」和「指针现在指着谁」两件
事就搅在了一起——一个失败会被读成另一个。而且取 token 已经是配对那一步的动作了。

---

## 4. Stream 本身

电脑操作是 Stream 的内置能力，随发行包出货——这台机器上要装的只有一个东西：

```cmd
set HTTPS_PROXY=http://127.0.0.1:7897
npm i -g @streamapp/stream
```

**这一步同时把 Stream Desktop 的本机进程装上了**：`cli/package.json` 的 `optionalDependencies` 里那个
`@streamapp/desktop-win32-x64` 会一起下来，而那正是后端真正拉起的那一份（§3）。
装完核一眼它在（路径随 npm 的全局前缀走，先 `npm root -g`）：

```powershell
Test-Path (Join-Path (npm root -g) "@streamapp\desktop-win32-x64\bin\stream-desktop.exe")
```

### 4.1 验证：后端真的起得来，而不只是文件在那儿

```powershell
Start-Process stream -NoNewWindow
Invoke-RestMethod http://127.0.0.1:8900/api/health   # 期望 ok=true，并带 commit / started_at
```

只 `dir` 一下是不够的：**装出一个空壳包、或者少一个原生依赖的表现是起进程那一刻才炸**，
而那时人已经在配对流程的中途了。把这个失败提前到布置阶段，坏得早也坏得便宜。

### 4.2 验证：这台机器上的能力面

```powershell
Invoke-RestMethod http://127.0.0.1:8900/api/packages | Select-Object -First 5
```

`cdp_look` / `cdp_shot` / `cdp_act` / `cdp_pages` 由后端自己注册，不需要装任何可选包。
想再加就 `stream add @streamapp/<x>`——那是另一件事，别混进这一轮布置里。

---

## 5. 扩展 id：观察出来，不要算出来

`allowed_origins` 是 native messaging 通道上**唯一**的准入门。id 差一个字符，Chrome 那边就是
静默拒绝——没有报错、没有日志，只是那条通道不通。id 由 `extension/wxt.config.ts` 里固定的
`key` 派生，理论上到哪台机器都一样；但「理论上一样」正是这轮要拆掉的那种信念，所以**认浏览器
自己报的那一份**。

方法：headless 起 Chrome for Testing 装上扩展，从 CDP 列 target，找 `type=service_worker` 的，
再 attach 上去让它自报家门。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\stream-pair\observe-all.ps1
```

**为什么不能只看 target 的 URL 里那串 id**：headless 里同时跑着若干 component 扩展
（Google Hangouts、Contextual Tasks），它们的 background 也叫 `background.js`，单看 URL
分不出哪个是我们的。`observe2.mjs` 逐个 attach 上去求值
`chrome.runtime.id + chrome.runtime.getManifest().name`，让每个 SW 自己说自己是谁。

本次在 win-test 上观察到的：

```
chrome-extension://dmhlfkdjljnilhnfajjpaobehenbokij/background.js
  -> {"id":"dmhlfkdjljnilhnfajjpaobehenbokij","name":"Stream Companion","version":"0.1.0"}
```

与仓库里 `src/ext-id.ts` 的 `STREAM_EXTENSION_ID` 一致。**在别的机器上重做这一步时仍要重新观察**，
不要引用这个值——引用它就等于又回到了「算出来的 id」。

---

## 6. 布置之前先看一眼这台机器上有没有旧的归属

这一条不是可选的。`~/.stream/datadir` 只有一份，native messaging host 也只有一份注册，
两者都是**后写者赢，且不吭声**。机器上如果已经装过 Stream 或跑过一轮配对，配对那一步会把
它们抢过来，而被抢的那一方不会有任何提示。

```powershell
Get-Content C:\Users\<用户>\.stream\datadir
Get-Content C:\Users\<用户>\.stream\NativeMessagingHosts\com.stream.desktop.json
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts"
```

本次在 win-test 上就读到了上一轮留下的一整套（指针指向 `C:\Users\xiaomi\stream5\data`，
注册的 host 路径指向 `stream5` 里那份 `@streamapp/desktop-win32-x64`，且那个文件还在）。
这台机器可以随便破坏，所以不动它；但下一步一旦跑配对，这套就会被覆盖——**要知道自己在覆盖什么**。
