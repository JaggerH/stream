# cdp-binding — design

## D1 只换浏览器那一侧，协议与网关一行不改

绑定扮演的是**扩展那个浏览器客户端**：`POST /api/ext/pair` 换 token → `POST /api/ext/verify` 让对端
用这把 token 签一条挑战应答 → WS `/api/ext`（子协议 `[browser-relay.v1, token]`，query 带 `nodeId`）。
命令、回执、`cdp-event` / `tab-opened` 事件、心跳规矩全部照抄。

**为什么不新开一套端点**：服务端已有的一切（设备表、绑定表、上下线事件、lane、`cdp_*` 的
`device:<id>/chrome` 档）都按"扩展绑定"建好了。新端点等于把这些再实现一遍，而两份实现会在
"哪一侧算在线""谁来读 cookie"这些地方慢慢分叉。

## D2 两个 HTTP 端点报的是扩展的 Origin

`/api/ext/pair` 与 `/api/ext/verify` 各有一道 Origin 门，只认 `chrome-extension://<固定 id>`。它挡的是
**网页**（浏览器强制 Origin，网页改不了它）。CDP 绑定不是扩展，但它扮演的正是那个浏览器客户端，所以
报同一个 Origin。

这不是绕过：能设这个头的是本机进程，而本机进程本来就拿得到配对码 / token（同一条信任边界）；网页仍然
伪造不了它。要换成一个专属 Origin，得改服务端的门——那是协议层面的决定，不在这次范围内。

## D3 标签组 → 认领集合

扩展里"AI 可操作范围"是浏览器里那个可见的 Stream 标签组；CDP 没有标签组。这里换成一张进程内的认领
表：`newTab` / `openTab` 建出来的标签，以及认领标签自己 `window.open` 出来的标签（`Target.targetCreated`
的 `openerId`，由浏览器记录，页面伪造不了）算"在组内"；其余一律拒。用户自己的标签既关不掉也订阅不了，
与扩展同一条红线。

## D4 tabId 自管

中继协议里的 tabId 是数字，CDP 的 targetId 是字符串。绑定发一套自己的数字，进程内稳定（同一个 target
永远是同一个数）。重启后数字会变——服务端的 lane 本来就是按这一轮的执行重新建的。

## D5 只许回环的 CDP 地址

CDP 口等价于"驱动这台浏览器里的一切"（任意求值、读 cookie、代填密码）。浏览器自己只在
`--remote-debugging-address=127.0.0.1` 上开它，这条绑定是普通进程，不该成为把那扇门带出本机的那一步。
判据复用 `access-guard.ts` 的 `isLoopbackAddress`（外加 `localhost` / `*.localhost`），**不另写一套地址
判断**：两套判据漂移之后，一处放行的另一处会拒，而两边单看都正常。

## D6 状态文件：token + nodeId（+ 非机密的 bindingId）

配对的代价是一次性码，而进程会重启。状态文件在 = 重启后直接 verify 重连，不再要码。文件 0600、
临时文件 + rename 原子写（半截 JSON 等于重新配对，而那时可能没有码可喂）。

`bindingId` 跟 token 住在一起，虽然它不机密：`/api/ext/verify` 必须带它才能挑出那把 token 的哈希当
HMAC key，少了它，状态文件就不足以完成"重启不再要码"这件事。

## D7 两条失联路径各管各的

- **中继断了**（服务端重启 / 网络抖）：退避 1s → 30s，每次重连前重新 verify。
- **CDP 断了**（浏览器退出 / 被杀）：立刻断开中继（服务端据此判离线），然后按固定间隔重试 CDP；
  浏览器回来再走一遍 verify + 连中继。**回来时不再配对**——token 在状态文件里。
- 撤销（`4003`）与"token 被拷到另一个 profile"（`4004`）是终态：不再重连，`done` 兑现。

心跳照扩展中继的规矩：每个周期 ping 一次，上一轮之后既没 pong 也没任何帧 = 对端冻住，断开重连。

## D8 日志只记命令名

`Input.insertText` 的值、cookie 的值都不许进日志。映射层只记命令名、耗时（慢命令 / 失败），以及生命
周期（配对完成、连上、断开、重连）。错误文本来自 CDP 或我们自己的判据，不含参数。

## D9 与扩展 driver 对齐的口径

对照基准是 `extension/src/lib/driver.ts` 的 `dispatchInner`，**行为对齐、实现不逐行翻译**：

| 项 | 口径 |
|---|---|
| `sameUrl` | 协议 / 主机 / 路径 / 查询 / 片段一致，尾斜杠不算差别 |
| `domainMatches` | 同域或它的子域（cookie 的 domain 带不带点都算） |
| cookie 形状 | `serializeCookie`：`sameSite` 映射、`hostOnly` = 域不带点、`session` 透传 |
| `waitForNav` | **必须同时确认"已离开 about:blank"**——`createTarget({url})` 返回时标签里还是初始空文档，而空文档的 readyState 天生是 `complete` |
| `Page.captureScreenshot` | 1.5s 预算，超时后用 `captureBeyondViewport` 再试一次 |
| `Input.dispatchMouseEvent` | 发了就算（fire-and-forget） |
| `activateTab` | 礼貌闸门：当前焦点不是我们认领的标签就不碰 |
| `releaseProfile` | 只关认领的标签，用户标签与窗口一个不动 |

## 已知差异

- **headless 里的 Enter**：`Input.dispatchKeyEvent` 的 `keyDown` Enter 不带 `text` 时，`--headless=new`
  不触发表单隐式提交（真窗口会）。这是浏览器那一侧的行为，中继原样转发；`kind:'login'` 在无头浏览器上
  要显式给 `submitSelector`。已写进 `docs/ARCHITECTURE.md`。
- **`frames` 的 url**：`attachedToTarget` 里 OOPIF 的 url 常常还是空的，绑定在回答前从 `Target.getTargets`
  补一次（否则调用方分不清"这是哪一帧"）。
