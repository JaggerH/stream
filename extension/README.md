# Stream Companion (Chrome extension)

A thin WXT/MV3 extension that does two things for a [Stream](../README.md) instance:

1. **Cookie sync** — tells Stream which domains' cookies are worth pulling and lets it read them
   straight out of this browser over the relay. This is what makes logged-in sources
   (xhs / bilibili / douyin …) harvest.
2. **Radar** — for the page you're on, asks Stream which sources can ingest it and subscribes
   in one click.

All the hard logic (URL→sources matching, subscribe, cookie storage) lives in Stream. The
extension's only setting is the **Stream URL** (auto-detected at `127.0.0.1:8900`); it asks Stream
which domains to sync and answers the backend's pulls. **It never sends a cookie over the network
itself, and holds no key of any kind.**

## Pair with your Stream — the one-time setup step

扩展**不认地址，只认 secret**：`127.0.0.1:8900` 那头是不是你那台 Stream，靠双方都知道
`data/ext-relay-token` 来判（为什么见 `docs/API.md` 的 "The Reverse Gate"）。扩展读不了文件，
所以由 `stream-desktop` 代读——需要先把它注册成 Chrome 的 native messaging host：

```bash
# 从仓库根，扩展 id 见 wxt.config.ts 的注释
app/host-agent/target/x86_64-pc-windows-gnu/release/stream-desktop.exe \
  --register --extension-id dmhlfkdjljnilhnfajjpaobehenbokij
```

**注册完要重启一次 Chrome**——清单是启动时读的。没注册的表现是扩展一直连不上，popup 里
写着 `native messaging host not found`；**它不会退回去问后端要 token**（那正是这套机制要拆掉
的东西，见 `lib/native-host.ts`）。

三个平台的落地位置、以及 WSL 下的已知限制（Chrome 能否从 `\\wsl.localhost\…` 拉起 host
**尚未验证**，绕法是把 `.exe` 拷到 Windows 侧再 `--register --exe <那个路径>`）见
`app/host-agent/README.md`。

## How it talks to Stream

| Action | Call |
|---|---|
| Prove the backend is ours | `POST {stream}/api/ext/verify {nonce}` → `{proof}` |
| Learn the sync scope | `GET {stream}/api/ext/sync-config` → `{configured, requiredDomains}` |
| Hand over cookies | 中继上的 `op:'cookiePull'`，**由后端发起** |
| Say "cookies changed" | 中继上的 `{type:'cookies-changed', domains}` |
| Radar | `GET {stream}/api/radar?input=<tabUrl>` |
| Subscribe | `POST {stream}/api/streams/from-intent {input}` |

**扩展不推登录态，是后端来取。** 扩展这边只做两件事：把 `requiredDomains`
缓存下来（那是 `cookiePull` 的**范围闸**——只应答用户填的域 ∪ Stream 申报的域，范围外一个字
都不给），以及在同步域的 cookie 变了时叫一声。取不取、什么时候取由后端定，因为只有它知道
什么时候要用（要采集了／手里那份多旧／刚吃了个 401）。

**没有周期同步闹钟**，那是刻意撤掉的：扩展按时间猜的代价是 cookie 轮换之后干等一整个周期。

**`/api/ext/sync-config` 里不许有密钥。** 它只回答"该读哪些域"；扩展这边没有任何东西需要加密，
也就没有任何钥匙可丢。

**每次用 token 之前都先 `verify`。** 握手会把 token 交出去，而这条中继的能力等于用户的全部
登录态——把它交给一个抢到 8900 的进程，比采集停一轮严重得多。

## Develop

```bash
cd extension
pnpm install        # standalone workspace (own pnpm-workspace.yaml)
pnpm build          # → .output/chrome-mv3   (the build you load when you're NOT developing)
pnpm test           # vitest
pnpm typecheck
```

### Live reload — load it once, never click "Reload" again

Chrome never picks up changes to an unpacked extension by itself, so the naive loop ends with a
human clicking **Reload** on `chrome://extensions` after every edit. The dev build removes that
click: it holds a WebSocket to the WXT dev server (`:5279`) and calls `chrome.runtime.reload()`
itself whenever a rebuild lands.

`scripts/dev.sh` (`pnpm dev` at the repo root) already starts that watcher alongside the backend
and Vite. One-time setup:

1. Repo root: `pnpm dev` (or, extension only: `cd extension && pnpm dev`).
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   `extension/.output/chrome-mv3-dev` — the **`-dev`** directory, not `chrome-mv3`. Remove the
   old load first; both carry the same `key`, so Chrome refuses two loads of the same ID.
3. Edit anything under `extension/src` → rebuild + reload happen on their own.

The extension ID is unchanged (same `key` in both builds), so the backend's `Origin` gate and
everything stored under that ID carry over.

**When the watcher is down:** the background service worker is fully self-contained and keeps
working (cookie sync, harvest, driver — the WS just fails to connect and logs it). The **popup**
is served from the dev server, so it needs the watcher running. Not developing for a while?
`pnpm build` and load `chrome-mv3` again.

## Load unpacked (non-dev build)

Stream 自己会引导用户装它（工作台首启的横幅、设置页里的固定入口、以及某个动作因为扩展没连
而做不成时的现场提示）。引导有两条路，**都指向同一个目录 `<dataDir>/extension/`**：Stream 在
你点任一安装按钮时把产物整份物化到那儿（来源两档：仓库里的 `extension/.output/chrome-mv3`，
或发行形态自带的那份），然后要么代你去点，要么把那个路径念给你。目录只有一个，是故意的——
出问题时排查只有一条路径。

**装的是这一档（`<dataDir>/extension/`）而不是 `-dev` 目录时，改完代码用 `pnpm ext:reload`**
（`scripts/ext-reload.mjs`）：build → 重新物化 → `POST /api/extension/reload`（一条桌面 recipe，
`src/browser/extension-reload.ts`：Stream Desktop 开窗、地址栏进扩展详情页、点那枚「重新加载」、
等中继以新的 `since` 连回来）。只 `pnpm build` 不够——Chrome 装载的是物化那份拷贝，`.output/`
更新了它不知道。重载**全程不经中继**，所以扩展断连（后端重启后没连回来）时也用它：
`node scripts/ext-reload.mjs --no-build`。

**扩展连不上、要看它后台在说什么：`pnpm ext:console`**（`POST /api/extension/console`，桌面 recipe
`src/browser/extension-console.ts`）——Stream Desktop 开详情页、点「Service Worker」、按 a11y 读出
DevTools 控制台的每一条消息打到终端。这时扩展往 debug bus 写日志那条路也是断的，控制台是唯一的现场，
别再请用户去点开复制。`ext:reload` 没等到重连时会自动读一次。

判据是**扩展连上了中继**（`GET /api/browser-capability` 变 `ready`），不是
`chrome://extensions` 上出现了一张卡片：两者会安静地分家，最常见的是 native messaging 清单在
这次 Chrome 启动之后才登记（清单只在启动时读）。所以"步骤都跑完了但没连上"报的是
**需要重启一次 Chrome**，不是安装失败。

开发者模式加载的扩展，Chrome 每次启动都会问要不要停用它——这是它对所有非商店扩展的固定
提醒，绕不开（唯一能免掉的是商店上架，而扩展要读本机 `data/ext-relay-token`，和商店政策冲突）。

下面是手动那条路（也是引导里「我自己来」给出的步骤）：

1. `pnpm build`
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
   `extension/.output/chrome-mv3`。（中文界面上那个按钮叫「加载**未打包**的扩展程序」，
   不是一堆教程里写的「加载已解压的」。）
3. Click the toolbar icon. The popup auto-detects Stream at `127.0.0.1:8900` (edit the URL there
   if yours differs). Everything — Stream URL, **Sync cookies now**, and the per-page radar — is
   in the popup; there is no separate options page.
4. On a supported page, the popup shows the matching source → **Add to Stream**.

Prerequisite: pair the extension with your Stream (see above). If Stream doesn't answer the
sync-scope call, the popup will say so.
