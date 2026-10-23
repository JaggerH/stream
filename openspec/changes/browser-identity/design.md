## Context

device-execution 之后，执行位置是「设备」，一台设备上的浏览器能力来自挂在它上面的扩展绑定（D7）。这套模型默认一台设备
一个浏览器、一个浏览器一套登录态。用户的真实情况是一个 Chrome 里有好几个 profile，各自登着不同的账号。今天的几个事实：

1. **本机只有一条绑定。** `LOCAL_BINDING = 'local'`；`ExtRelay.connect` 以最新为准、顶替旧 socket
   （`shared/browser-relay/relay.ts`）。两个 profile 的扩展都会连本机 Stream，结果是互相顶替、来回重连。
2. **本机路径到处直接拿 `registry.local`。** 8 个文件、约 30 处（`serve.ts`、`replay/session-manager.ts`、
   `kernel/plugins/harvest.ts`、`kernel/plugins/auth.ts` 等）。`pickBrowser` 在 `local` 设备上恒返回 `local`。
3. **配对绑定天然按 profile 分开**：每个 profile 的扩展实例有自己的 `chrome.storage.local`，各自配对、各得一条绑定。
   但绑定表不知道它是哪个 profile，`pick` 只按「设备默认 → 最近连上」选。
4. **登录态按设备一份、整份替换**（`data/cookies/<deviceId>.json`，`device-cookie-pullers.ts`）。拉取经设备上被选中的
   那条绑定；两条绑定轮流被选中，快照就在两个账号之间来回覆盖。
5. **扩展的 id 是固定的**（`STREAM_EXTENSION_ID`，manifest `key` 派生）。任何 profile 里装的都是同一个 id。
6. **host agent 能按 profile 拉起 Chrome**（`launch.rs` 的 `profileDirectory`），但 `ensure_running` 只判「有没有 Chrome
   进程」：Chrome 开着、目标 profile 没加载时唤不醒它（`launch.rs` 头注明说了这个代价）。
7. **登录检测只到「在不在」**：`sessionPrecheck` 看会话 cookie 在不在，recipe 的 `loginCheck` 在真页面上确认。没有任何一处
   回答「登着的是谁」。

## Goals / Non-Goals

**Goals**
- 同一台机器上多个 profile 的扩展同时在线，互不顶替。
- Stream 知道每个扩展实例在哪台设备、哪个 profile、什么环境。
- Stream 知道每个节点上各 facility 登着哪个账号。
- 任务和 facility 可以指定「用哪个身份」「在哪个环境」；指定了就绝不换成别的身份执行。
- 目标 profile 没开时能把它唤起来。
- 每条运行记录能答出「这是在哪个身份下完成的」。

**Non-Goals**
见 proposal。要点：cookie 不出浏览器另开题；环境策略归大脑；一个 profile 一个站点只有一个账号；只验收 Chrome。

## Decisions

### D1. 节点 = 一个 profile 里的一个扩展实例

- 扩展首次运行生成 `nodeId`（`node_<uuid>`），存在 `chrome.storage.local.node`。存储按 profile 隔离，所以它就是 profile
  的稳定标识；扩展重装、profile 被删了重建，会得到新的 `nodeId`，按新节点处理。
- 握手（`ExtHandshake`）加三个自报字段：`nodeId`、`profileDir`、`profileName`。后两个在认领（D3）之后才有。
  老扩展一个都不带，走 D2 的兼容槽。
- 后端新表 `browser_nodes`（`data/stream.db` 用户侧）：

  ```
  node_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  profile_dir TEXT, profile_name TEXT, label TEXT, environment TEXT,
  is_default INTEGER, first_seen_at INTEGER, last_seen_at INTEGER,
  woken_at INTEGER   -- 由 Stream 静默唤起的时刻（D8）；用户自己开过窗即清空
  ```

  节点第一次连上时建行；`device_id` 来自它连进来的那条绑定。
- **配对绑定与节点一一对应。** 绑定第一次连上时把 `nodeId` 记进绑定行；之后同一 token 带着不同的 `nodeId` 来连，以关闭码
  4004 拒绝。这意味着 token 被拷到了另一个 profile，不能让它冒充原来那个节点。
- 「设备的默认浏览器」从 `ExtBindingStore.default` 搬到 `browser_nodes.is_default`：用户选的本来就是一个 profile。
  首启把已有的默认绑定迁到它所对应的节点（节点连上时迁）。

**为什么 `nodeId` 由扩展生成、而不是由后端在配对时发**：本机绑定不经配对，没有发号的时机；而扩展存储按 profile 隔离这件事
是 Chrome 保证的，比任何后端发的号都可靠。

### D2. 本机多节点

- 本机连接仍经 native host 取 token、挑战应答（信任链不变），升级请求带 `nodeId`。带了 → 绑定 id 为 `local:<nodeId>`，
  一个节点一条 relay，互不顶替；没带（老扩展）→ 落到兼容槽 `local`，行为与今天完全一致（以最新为准）。
- `ExtRelayRegistry.bindingsOf('local')` 返回全部 `local:*` 加兼容槽；`pick('local')` 与远程设备同一套规则
  （D7 的身份 / 环境优先，其次默认节点，再其次最近连上）。
- **`registry.local` 改成门面。** 30 处调用点不逐个改：`registry.local` 返回一个 `ExtRelay` 形状的门面，每次调用时按
  `pickBrowser` 解析到具体节点的 relay。执行内，`pickBrowser` 读执行上下文里选定的那个节点，整次执行不变；执行外（面板、
  MCP 工具）取本机默认节点。门面不缓存解析结果。
- 同机多个 profile 共享同一个 native host token：一个本机 profile 能冒充另一个本机 profile 的 `nodeId`。同机同用户，
  不防；配对绑定由 D1 的 4004 防住。

### D3. profile 认领

host agent 新增两个 op（在 `hello.ops` 里声明才派）：

```
browser.profiles  args: { exe?: string }
                  result: { userDataDir, profiles: [{ dir, name, gaiaEmail?, gaiaName? }] }
browser.claim     args: { profileDirectory, url, exe? }
                  result: { launched: boolean }
```

- `browser.profiles` 读用户数据目录下的 `Local State`（JSON），取 `profile.info_cache`。只读，Chrome 开着也能读。
  `gaiaEmail` 是 profile 登录 Chrome 用的 Google 账号，只用于给用户起名时作提示，不参与任何判定。
- `browser.claim` 执行 `<chrome> --profile-directory=<dir> <url>`。Chrome 已在运行时，这次调用会转给已有进程，在该 profile
  里开一个窗口打开 `url`。

认领流程（由用户在面板上点「识别 profile」发起；会开窗口，所以只在用户在场时做）：

1. 后端对设备调用 `browser.profiles`，得到 profile 列表。
2. 每个 profile 签一个一次性 `nonce`（2 分钟有效），调用 `browser.claim`，`url = chrome-extension://<STREAM_EXTENSION_ID>/claim.html#n=<nonce>`。
3. 那个 profile 里的扩展打开认领页。页面把 `nonce` 交给 SW，SW 经**它所有已连上的绑定**发 `{ type: 'claim', nonce }`。
4. 签发 `nonce` 的实例认出它，校验「这条绑定所在的设备 = 执行 `browser.claim` 的设备」，不符则拒绝（别的机器上的扩展不能
   认领这台机器的 profile）。然后把 `profile_dir`、`profile_name` 写进该节点行，回 `{ profileDir, profileName }`。
5. 扩展把 profile 记进 `chrome.storage.local.node`，之后每次握手都带上；认领页显示「已识别：工作（Profile 1）」。
6. 某个 profile 20 秒内没有认领回来，就标为「扩展未安装或未连上」。

- **新 profile 的竞态**（spike S1）：profile 第一次被拉起时，认领页会先于扩展注册打开，页面加载失败（标签停在 URL 上）。
  所以第 6 步的超时之前，若该设备上新连上了一个尚未认领的节点，就对那个 profile 再发一次 `browser.claim`，只重发一次。
  扩展没装时页面同样打不开，两种情况在 20 秒后合并为同一个提示。

- profile 显示名可能被用户改掉：每次「识别 profile」都按 `profile_dir` 刷新名字。`profile_dir` 是不变的键。
- 没有 host agent 的设备（只有扩展的机器）不能认领：节点照样能用，名字由用户在面板上手填，不能被唤起（D8）。

**为什么用扩展自己的页面，而不是一个由后端提供的网页**：扩展 id 固定，页面一定由那个 profile 里的扩展实例打开，不需要
任何服务器，也不需要 `tabs` 监听；扩展没装时页面打不开，正好区分出「未安装」。

### D4. 环境

- `browser_nodes.environment`：自由文本，面板预置「工作」「个人」两项。没标 = 不属于任何环境。
- 环境在本 change 里只有两个用途：作为路由目标（D7），以及写进运行记录。**不挂任何策略**（审批、数据隔离归大脑 change）。

### D5. `whoami`：问站点「我是谁」

包在会话声明里可选地加一段，两种形状二选一（spike S3：各站差别大，一种形状覆盖不了）：

```ts
// src/manifest/types.ts，三种 session 登录都可带
whoami?:
  | { kind: 'http'              // 带该节点的 cookie 发一个 GET，不开标签
      url: string               // 必须落在包的 network.hosts 内
      id: string                // JSON：点路径，如 'data.mid'；HTML：带一个捕获组的正则
      name?: string
      format?: 'json' | 'html'  // 缺省 json
    }
  | { kind: 'page'              // 在节点的后台标签里打开站点页面，读页面上的全局状态
      url: string
      id: string                // window 上的点路径，如 '__INITIAL_STATE__.user.userInfo.userId'
      name?: string
    }
  | { kind: 'login'             // 账号就是宿主登录时填进去的那一格，不问站点
      param: string             // 登录 recipe 的 secret_params 之一，如 'zjzh'
    }
// http / page 两种都可再带：
//   signedIn?: string          // 登录标志的路径，取到 truthy 才算 signed-in。有的站点游客也有一份用户信息（小红书 guest）
```

- 路径取值时，遇到 Vue 的 ref 包装（带 `_value` / `_rawValue` 的对象）自动解一层。小红书的 `__INITIAL_STATE__` 就是这样，
  作者照页面上看到的结构写路径即可。
- `login`：东财这类由 Stream 自己拿配置里的账号去登录的 facility，账号在登录那一刻就已知。身份 id 存账号的 SHA-256 前 16 位，
  显示为打码后的账号（`12****78`），明文不落库。它不做执行前核对（D9 当作「没有 whoami」处理）；用户在那个 profile 里手动登了
  另一个号的情况它分辨不出来，这是接受的代价。

- `http`：经 `fetchFor` 发出，cookie 取自**该节点**的快照（D10），远程设备上由设备代发。和采集用的是同一条出站路，不开标签，
  代价最低。适用于有现成「当前用户」接口的站点（B 站 `x/web-interface/nav`），以及本来就走纯 HTTP 的包（东财，账号在交易页的
  HTML 里）。
- `page`：在该绑定自己的会话标签组里开一个后台标签，等页面加载完，读 `id` / `name` 路径，关闭标签。读法与 recipe 的
  `statePath` 观察器是同一套。适用于接口要签名、但页面会把当前用户写进全局状态的站点（小红书：`user/me` 不带签名回 406，
  而首屏 SSR 的 `__INITIAL_STATE__` 里有用户信息）。
- 结果三态，与 `sessionPrecheck` 一个脾气：
  - `signed-in { accountId, name? }`：取到了非空的 id。
  - `signed-out`：响应是 JSON，但 id 路径为空。
  - `unknown`：打不开、不是 JSON、节点断了。**绝不当成任何一边**，身份表维持原状。
- 没有 `whoami` 的 facility：身份退化为「这个节点上的账号」，`accountId = node:<nodeId>`，显示为「<profile 名> 上的账号」。
  它照样能按节点路由，只是同一账号登在两个 profile 里会被当成两个身份。

**为什么不复用 `loginCheck`**：`loginCheck` 是页面选择器，回答「登没登」；`whoami` 要的是一个稳定的账号 id。能走 `http`
的站点优先走 `http`：不开标签，也不受页面改版影响。

### D6. 身份表

```
site_identities(facility TEXT, node_id TEXT, account_id TEXT, display_name TEXT,
                state TEXT /* signed-in | signed-out */, verified_at INTEGER,
                PRIMARY KEY (facility, node_id))
```

- 一个节点上一个 facility 至多一个账号（Non-Goal：同 profile 多账号）。身份 = `(facility, account_id)`，可以出现在多个节点上。
- 什么时候探测：
  - 节点连上时：只探测 `sessionPrecheck` 为 `PRESENT` 的 facility，按节点串行、一次一个标签。
  - 某个 facility 的会话 cookie 在该节点上变了（扩展已有的 `cookiesChanged` 通知）。
  - 执行前核对（D9）。
  - 面板上手动刷新。
- `unknown` 不写表。`signed-out` 写表（保留上次的账号 id，显示为「已登出」），路由不再把它当作该身份的候选。

### D7. 路由目标与解析

目标从「设备」扩成三种：

```ts
type Target =
  | { kind: 'device'; deviceId: string }
  | { kind: 'identity'; accountId: string }   // facility 由动作 / 源所属的包给出
  | { kind: 'environment'; environment: string }
```

- `facility_devices` 加两列 `account_id`、`environment`，三选一（`device_id` 仍是今天的语义）。任务行 `device` 旁加
  `identity`、`environment` 两列。
- 解析顺序（每次执行开始时一次）：

  ```
  task.identity ?? task.environment ?? task.device
    ?? facilityTarget(facility)
    ?? 'local'
  ```

- `identity` 目标：候选 = 身份表里 `(facility, accountId)` 为 `signed-in` 的节点。在线的优先，同为在线取最近核对过的。
  没有在线的 → D8 唤起；唤不起 → `identity-offline`。
- `environment` 目标：候选 = 该环境下、该 facility 为 `signed-in` 的节点，挑法同上。同一环境里登着两个不同账号时取最近
  核对过的那个——用户选的是环境、不是账号，这一层歧义是用户接受的。
- 解析出的节点同时决定**设备**（节点所在的设备）和**绑定**（预先填进执行上下文的 `browser.bindingId`），`pickBrowser`
  之后不再重选。执行上下文另记 `identity?: { facility, accountId }` 供 D9 核对。
- `device` 目标与今天相同；设备上有多个节点时按「默认节点 → 最近连上」选，不看身份。

**任何一种目标都不换身份顶上。** 实现上，`identity` / `environment` 目标的候选集合为空时，解析器没有任何退回到
`device` 或 `local` 的分支。

### D8. 按需唤起 profile

- 候选节点全部离线，但其中某个节点有 `profile_dir`、所在设备的 host agent 在线：调 `ensureApp { profileDirectory, force: true }`
  唤起那个 profile，等节点连上（上限 30 秒），再进入 D9。
- `force: true` 绕开「有 Chrome 进程就不动手」的判断（Context 6）：节点离线这件事本身已经证明目标 profile 没加载。
- 唤起时带 `--no-startup-window`。spike S2（Linux）：交给运行中的 Chrome 后，目标 profile 被加载、扩展 SW 起来（报告 0 个窗口），
  没有开任何窗口。所以定时任务也可以唤起，不抢屏。Windows 真机复核前，这一条按「通过」设计；复核不过就退回「只在用户在场时
  触发的执行里唤起，定时任务按 `identity-offline` 失败」。
- 唤起后的 profile 没有窗口，第一次需要开标签时由 D13 的规则造一扇不聚焦的窗。
- **唤起的 profile 收不回去，但要看得见。** Cortana 实测：静默加载的 Profile 4 十分钟后仍被加载着，Chrome 不会自己卸载一个从没
  开过窗口的 profile。扩展 API 与命令行都没有「卸载某个 profile」的办法，只有整个 Chrome 退出时才会卸载。所以：
  - 执行结束后，Stream 关掉自己在那个 profile 里开的标签；那扇窗若是 Stream 为它造的（D13），一并关掉。不留任何可见的东西。
  - 节点表记一列 `woken_at`：这个 profile 是 Stream 唤起的、什么时候唤起的。用户自己打开过它的窗口（扩展报告窗口数 > 0）就清空。
  - 面板的设备页列出「Stream 在后台打开着的 profile」，并说明它会在 Chrome 退出时卸载、要立刻卸载就完全退出 Chrome。
  - **收回的路：关掉它的最后一扇窗。** Cortana 实测：给静默加载着的 Profile 4 开一扇窗、再关掉，5 秒内 profile 即被卸载（`History`
    解锁），之后一直不再加载。而从没开过窗的 profile 不会被卸载。所以执行结束时，若那个 profile 是 Stream 唤起的（`woken_at` 非空）
    且此刻只剩 Stream 造的那扇窗，关掉它就等于卸载 profile；若执行里根本没开过窗（纯 HTTP 的执行），就由扩展造一扇不聚焦的窗再关掉，
    换来卸载。这扇窗不抢焦点，但会在任务栏上闪一下。
  - 用户在那个 profile 里有自己的窗（扩展报告窗口数 > Stream 造的数目），一律不碰，`woken_at` 清空。
  - 实测里还看到：profile 第一次开窗时，它里面别的扩展可能弹自己的页面（AdBlock 的 What's new）。这扇窗里有不属于 Stream 的标签，
    按上一条不碰。
- 一个节点同一时刻只有一次唤起在飞，并发的执行共用它的结果。

### D9. 执行前核对

- 目标是 `identity` 或 `environment`、facility 声明了 `whoami`：在选定的节点上核对一次，除非身份表里的记录还新鲜。
  - 采集（recipe 源）：10 分钟内核对过就不再核对。
  - 任务中心的动作：60 秒内核对过才免。动作可能对外，宁可多开一个标签。
- 核对结果：
  - 一致 → 执行。
  - 不一致 → `identity-mismatch`，更新身份表，发通知（「工作 profile 里的小红书现在登的是个人号B」）。
  - `signed-out` → `identity-signed-out`，交给已有的「需要登录」通知，并指名是哪个 profile。
  - `unknown` → 按 `identity-offline` 处理（可重试），不执行。
- 没有 `whoami` 的 facility 不核对：身份就是节点，选中了节点就等于选中了身份。

### D10. 登录态按节点

- 快照从 `data/cookies/<deviceId>.json` 改为 `data/cookies/<deviceId>/<nodeId>.json`，仍整份替换、仍 0600。
- `CookiePuller` 从按设备缓存改为按节点缓存；拉取走该节点自己的绑定，写该节点自己的快照。
- `CookieProvider.cookieString(domain)` 读执行上下文里选定的节点。纯 HTTP 的执行也一样：第一次 `cookieFor` 会触发
  `pickBrowser`，按 D7 选出节点。HTTP 执行因此也带上了身份，远程设备的 `http.fetch` 注入的是正确账号的 cookie。
- 远程设备该拉哪些域（`requiredDomainsFor`）改为按节点算：设备目标绑到该设备的 facility，加上身份 / 环境目标解析到该节点的 facility。
- **不迁移旧快照。** 节点连上时 `CookiePuller` 本来就会全量拉一次。旧的 `cookies/<deviceId>.json` 只留给兼容槽（D2 的老扩展）读。

### D11. 失败语义

在 device-execution D9 的表上增加：

| 时机 | 错误 | 是否已发出动作 | 自动重试 |
|---|---|---|---|
| 解析时没有在线且登着该身份的节点，也唤不起 | `identity-offline` | 否 | 按任务 `maxAttempts` |
| 核对时登着的是另一个账号 | `identity-mismatch` | 否 | **否**，发通知 |
| 核对时该节点已登出 | `identity-signed-out` | 否 | 否，走「需要登录」 |
| 认领时 profile 没回应 | （不是执行错误）面板标「扩展未安装或未连上」 | — | — |

- 三种都发生在派发任何动作之前，运行记录写明目标身份与原因。
- 都不回落：不换节点上的别的账号，不换设备，不回 `local`。

### D12. 留痕与界面

- 运行记录加 `nodeId`、`profileName`、`environment`、`accountId`、`accountName`（执行时的快照，不随节点改名而变）。
- 面板「设备」页：每台设备下列出节点（profile 名、环境、在线、默认）；「识别 profile」按钮（设备有 `browser.claim` 时可点）；
  身份表（facility / 账号 / 在哪些节点上 / 上次核对）。
- facility 默认目标与任务覆盖的选择器：设备 / 身份 / 环境三选一，身份下拉只列身份表里出现过的。
- 扩展 popup 顶部显示「工作 · Profile 1」，没认领过显示「未识别的 profile」与一行如何识别的说明。

### D13. 一个 profile 一个 Stream 标签组，撤掉「Stream 独立窗」

今天的 driver（`extension/src/lib/driver.ts`）有两处会在主组之外另起炉灶：

- `adoptOpenedTab`：AI 驱动的标签在**另一扇普通窗**里开出新标签时（站点 `window.open` 开了新窗口、或 Chrome 把它放进了别的窗），
  在那扇窗里另建一组「Stream 独立窗」，记进 `windowGroups`。标签组不能跨窗，所以每来一扇新窗就多一个组；这类标签继承开启者
  的出身，交互标签是 `created`，SW 醒来不回收——窗和组只增不减。用户实测攒了近 50 个。
- `createUnfocusedFullscreenWindow`：一扇窗都没有时（`--no-startup-window` 唤起的常态）造一扇不聚焦的窗放标签。这一处是必要的，保留。

改为一条不变式：**每个 profile、每条绑定，浏览器里至多一个 Stream 组。** 一个 profile 通常只绑一个 Stream 实例，就是一个组；
绑了两个实例才会有两个组（D7 的绑定隔离要求它们分开）。

- 新标签出现在主组所在窗口之外的**普通窗**里：`chrome.tabs.move` 把它挪进主组那扇窗，再入主组。`window.opener` 关系不受标签
  在窗口间移动的影响。挪完若那扇窗空了，且窗是随这个标签新开出来的，关掉它。
- 新标签在 **popup 窗**里（OAuth 弹窗之类）：不挪、不建组，照旧记进 `popups`。popup 的标签挪不进普通窗，站点也依赖它是弹窗。
- 主组所在的窗被用户关了：主组随之消失，下一次需要标签时在当前窗里重建主组（今天 `addTabToGroup` 的陈旧 id 重建分支已经这么做）。
- 删掉 `WINDOW_GROUP_TITLE`、`windowGroups` 与 `reconcileWindowGroups`。升级后第一次醒来做一次收编：浏览器里叫「Stream 独立窗」的组，
  `probe` 标签关掉；`created` 标签挪进主组；`adopted` 标签只解组、不关（红线不变：用户拖进来的东西绝不 remove）；
  因此空出来的窗关掉。同名的多个「Stream」主组（历史残留）合并进第一个。

## Risks / Trade-offs

- **门面藏住了选择。** `registry.local` 变成按调用解析的门面后，一次执行里如果有一处绕过执行上下文直接拿 relay，就可能落到
  默认节点上。缓解：门面只经 `pickBrowser` 解析；加一个测试，断言一次以身份为目标的执行里，所有 relay 调用都落在同一个节点上。
- **`page` 形状的 `whoami` 开标签有代价。** 一次核对一个后台标签、一次页面加载。`http` 形状没有这个代价，能用就用。
  动作前 60 秒的新鲜度窗口是安全与开销的折中；高频动作会被 `page` 核对拖慢，那时再考虑在节点侧缓存。
- **后台 profile 用户看不见。** 唤起之后它一直加载到 Chrome 退出，Chrome 的界面里没有任何地方显示它。占用的是一组渲染 / 扩展进程
  的内存，以及该 profile 的扩展照常在跑。缓解只有「面板上明说」（D8），没有办法替用户卸载。
- **挪标签会改变用户的窗口。** 站点开新窗、标签被挪回主组的窗，用户可能正看着那扇新窗。只挪 AI 驱动的标签开出来的标签
  （开启者在组内），用户自己开的窗不碰。
- **`whoami` 接口会变。** 站点改了「当前用户」接口，结果会落到 `unknown`（不是 `signed-out`），表现为该身份的执行被当作离线
  而失败，不会误判成换号。修 `whoami` 和修 recipe 是同一条路。
- **认领要开窗口。** 每个 profile 开一个窗口，只在用户点「识别 profile」时做。
- **同一账号登在两个 profile 里**：有 `whoami` 时是同一个身份、两个节点，路由任选其一；没有 `whoami` 时会被当成两个身份。
- **本机兼容槽**：老扩展与新扩展同时连本机时，老的那个仍是「以最新为准」的单槽，可能和新节点被一起选中。只在扩展升级的
  过渡期存在。

## Migration

1. 首启：建 `browser_nodes`、`site_identities`；`facility_devices` 加列；`user_tasks` 加列。全部为空，所有执行照旧解析。
2. 扩展升级：首次运行生成 `nodeId`，握手开始带它。本机连接从兼容槽 `local` 迁到 `local:<nodeId>`。节点第一次连上时，
   `CookiePuller` 全量拉一次它的快照；原「设备默认绑定」迁到对应节点。
3. 用户在面板上点「识别 profile」，给节点标环境；身份表随节点连上逐步填满。
4. 用户把 facility 或任务的目标改成身份 / 环境。没改的照旧按设备执行。

## Spike 结果与待复核项

2026-10-23 在 javis 上用 Chrome for Testing 156（`--ozone-platform=headless`，完整浏览器、不出画面，进程单例照常工作）
和一个与 Stream 扩展同 key（同 id）的最小扩展验证：SW 生成 `nodeId` 并向本机一个记日志的 HTTP 端点报到，认领页把 `nonce`
经 SW 交回。spike 代码不入库。

- **S1 通过。** 对运行中的 Chrome 再调用 `--profile-directory=X chrome-extension://<id>/claim.html#n=…`，Chrome 输出
  「Opening in existing browser session」，认领页在 X 里打开，交回 `nonce` 的是 X 的节点（Default → `node_c1ea2200`，
  Profile 1 → `node_cf939548`，与各自 SW 报到的 id 一致）。**不需要** `web_accessible_resources`。
  新建 profile 第一次拉起时页面先于扩展注册，加载失败，补发一次即成功（已写进 D3）。
- **S2 通过（Linux + Windows）。** Linux：只开 Default 时调用 `--profile-directory="Profile 1" --no-startup-window`，Profile 1 的扩展
  SW 起来（报告 0 个窗口），页面目标仍只有原来那一张。Windows（Cortana，Chrome 155，从 WSL 经 interop 调起，与用户桌面同在
  session 1）：Chrome 回「正在现有的浏览器会话中打开」，目标 profile 随即被加载（其 `History` 文件被锁），可见的 Chrome 窗口数
  不变。那个 profile 没装扩展，SW 醒没醒没有直接观测；扩展随 profile 加载，按通过处理，计划 4 的冒烟再看一次。
- **S3 完成（Cortana，用户自己登着号的 Default profile）。** 经 Cortana 上 Stream 的 `cdp_look` 静默探测标签与本机 cookie 快照验证，
  回传的只有字段名与打码的 id：
  - **B 站**：`http` 形状。`https://api.bilibili.com/x/web-interface/nav`，`id: 'data.mid'`，`name: 'data.uname'`，
    `signedIn: 'data.isLogin'`。用该机 cookie 快照走纯 HTTP 与在页面里直接导航得到同一个账号（7 位 mid）。未登录时 `code:-101`、无 `mid`。
  - **小红书**：`page` 形状。`user/me` 不带签名回 406；`https://www.xiaohongshu.com/explore` 的 `__INITIAL_STATE__.user` 下有
    `loggedIn` 与 `userInfo`（`userId` 24 位、`nickname`、`guest`、`redId`），均为 Vue ref。`id: '__INITIAL_STATE__.user.userInfo.userId'`，
    `name: '__INITIAL_STATE__.user.userInfo.nickname'`，`signedIn: '__INITIAL_STATE__.user.loggedIn'`。游客也带 `userInfo`，所以必须有 `signedIn`。
  - **东财**：会话已过期（`/Trade/Buy` 302 到 `ExitLogin`），没有取到交易页里的账号字段。它的账号本来就是登录 recipe 的
    `secret_params.zjzh`，改用 `login` 形状，不为它再去页面里找。D5 据此改成三种形状加 `signedIn`。
- **S4 字段确认，Windows 路径确认，macOS 未验。** `Local State` 的 `profile.info_cache.<dir>` 有 `name`（显示名）、`user_name`
  （Google 邮箱，未登录为空）、`gaia_name`；`profile.last_active_profiles` 列出当前打开着的 profile，可以顺带判断哪些 profile 已加载。
  用户数据目录按 Chrome 的默认位置：Windows `%LOCALAPPDATA%\Google\Chrome\User Data`，macOS `~/Library/Application Support/Google/Chrome`。
