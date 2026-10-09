# Stream

[English](https://github.com/JaggerH/stream/blob/main/cli/README.md) | **简体中文**

**让你的 AI 探一次路，Stream 把这条路记下来——之后定时跑、不花 token、能进桌面 app，坏了再叫 AI 来修。**

今天的 agent（Claude Code / Codex / OpenClaw / 豆包）都能替你操作浏览器和电脑，但同一件事做第二遍，
它不比第一遍便宜、也不比第一遍稳。Stream 把 agent 跑通的那条路固化成一份 **recipe**——不是提示词，
是一份可执行的数据——然后由本机的调度器按时重放：在你**自己登录着的 Chrome** 里、在**桌面客户端**
（微信 / QQ / 券商）里，不经模型、不花 token，锁屏了也照跑，每一次都有回执。网站改版了，重放会在
断言那一步停下、把现场落盘、再把 agent 叫回来修。

它同时是一个自托管的**收件箱**：小红书 / B 站 / 抖音 / 播客 / 网盘 / RSS 借你自己的登录态汇进来，
整个收件箱开放给 AI（MCP）。所有数据都在你自己机器上。

## 你需要哪一种 Stream？

| 路 | 你是谁 | 怎么装 |
|---|---|---|
| **① 贴一段话给你的 agent** | 已经在用 Claude Code / Codex / OpenClaw | 把下面那段提示词丢给它，它自己装、自己接上 |
| **② 装了直接用** | 想要一个收件箱 + 定时跑的东西，不一定有 agent | `npm i -g @streamapp/stream && stream`，打开 <http://127.0.0.1:8900> |
| **③ 从源码跑** | 要改代码、写 RSSHub 路由 | [仓库 README 的「从源码跑」一节](https://github.com/JaggerH/stream/blob/main/README.zh-CN.md#从源码跑) |

### ① 贴给你的 agent

把这段话原样贴进 Claude Code / Codex / OpenClaw：

```text
Install Stream with `npm i -g @streamapp/stream`, start it with `stream`, verify
`curl -s 127.0.0.1:8900/api/health` returns ok:true, then register it as an MCP server
(`claude mcp add stream -- stream mcp`, or the equivalent one line for this host) and install its
skills with `curl -s -X POST 127.0.0.1:8900/api/skills/install`. If the browser extension is not
connected (`/api/browser-capability` is not "ready"), walk me through loading it.
```

装完 agent 多了一组 `stream_*` / `cdp_*` / `run_action_recipe` 工具和一批 `stream-` 前缀的 skill。
agent 跑通的动作 recipe 之后不需要它在场：下面「跑一条 recipe，不经 agent」那一节的命令行就是
交给调度中心的那句话。

### ② 装了直接用

```bash
npx @streamapp/stream                    # 试一下
npm i -g @streamapp/stream && stream     # 长期用
```

需要 **Node 20+**（`node -v` 查；没有就去 <https://nodejs.org> 装 LTS，Windows 上
`winget install OpenJS.NodeJS.LTS` 也行）。**除了 Node 别的什么都不用装**——不需要 git、不需要
Docker、不需要 Python 或编译器（原生依赖有预编译包）。
开箱这一次是 96 个包 / 230MB / 十几秒。

装完打开 <http://127.0.0.1:8900>。

```
stream [--port <n>] [--data <dir>]        起后端
stream mcp                                给 agent 用的 stdio 入口（后端没起就替你起一份）
stream add <包名>                          装一个能力 / recipe 包
stream update [<包名>…] [--yes]            把内置 / 已装的包更到 npm 最新版（多了副作用要 --yes）
stream restart [--force]                  重启后端（装 / 更 / 卸完有待重启项会问一句；
                                          脚本里用 --restart / --no-restart 跳过那一问）
stream recipe run <id> [--param 名字=值]… [--yes]
                                          从命令行跑一条动作 recipe

  --port, -p <n>   监听端口（默认 8900）
  --data <dir>     数据目录（默认 ~/.stream）
```

- **数据全在 `~/.stream`**：删掉它就是重置；卸载 = 删掉它 + `npm rm -g @streamapp/stream`。
- **只有一个端口**：前端、`/api/*`、`/ws`、插件全走 8900 这一扇门。
- **大件用到才装**，不占开箱体积：RSSHub 在第一次跑到 RSSHub 源时装（约 400MB，43~147 秒，
  看机器和网络）。
- **`stream restart` 在前台档会把后端脱离终端**：前台 `stream` 起的后端重启时是自己再起一份、
  旧的退出，新的那份不再挂在你的终端上——Ctrl-C 够不着它了，要停它按端口找 pid
  （`lsof -i :8900` / `ss -ltnp`）。systemd 或 `stream mcp` 养着的后端没有这一层变化。

### 跑一条 recipe，不经 agent

```bash
stream recipe run qq-send --param contact=张三 --param message=到了     # 只打印它会做什么
stream recipe run qq-send --param contact=张三 --param message=到了 --yes  # 真跑
```

不带 `--yes` 只回执"会做什么"（目标应用 / 目标站点 / 参数），退出码 2，什么都不执行。退出码：
0 做成 · 1 跑了但没读到落地回执 · 2 用法或参数 · 3 没正常收尾（**动作可能已做了一部分**，先核
目标应用）· 4 环境（没连 Stream Desktop / Chrome 扩展 / 要登录）· 5 够不着后端。`--json` 时
stdout 只有一份 JSON。

**要定时**：在 <http://127.0.0.1:8900> 的调度中心建一条任务，命令填 `stream`、参数填
`recipe run qq-send --param contact=张三 --param message=到了 --yes`（不经 shell，参数逐个给）。
从此它不需要任何 agent 在场；跑没跑成看任务的运行记录，退出码非 0 就是红。

---

## 上手：五步，每步都有判据

下面每一步都给了一条能跑的命令和一个该看到的答案。**判据不过就别往下走**——这条链路上每一种
坏法都是安静的（采到游客态数据、流不排班、能力显示可用但一跑就失败），往下走只会把一个静默的
失败带到更远的地方。

### 1. 把 Chrome 扩展装上 —— 不装的后果是静默的

采集**借你自己浏览器的登录态**（Stream 不自带浏览器，也不碰你的密码）。没有扩展，小红书 / B 站 /
抖音这类站点只能拿到游客看得见的东西——**不报错，只是采得少、采得浅**。

打开 <http://127.0.0.1:8900> 首次会引导你装。手动装：

```bash
curl -s -X POST 127.0.0.1:8900/api/extension/materialize    # → {"dir":"…/.stream/extension"}
```

拿那个 `dir` 去 Chrome：`chrome://extensions` → 打开右上角**开发者模式** → **加载已解压的扩展程序**
→ 选那个目录。（Chrome 从 137 起移除了 `--load-extension`，命令行装不了，GUI 是唯一的路。）

扩展连后端之前要经 **Stream Desktop** 的本机进程（可执行文件叫 `stream-desktop`）拿一把钥匙。
后端启动时自己把它登记进 Chrome 并拉起，
不用你装别的；启动日志里有一行 `[stream-desktop] host-agent → <路径>` 就是登记成功。
**Windows 与 macOS 都有这个小程序**（Linux 上后端会记一行 warn，扩展配不上，采集只有游客态）。
mac 上它只做配对——扩展照常拿到钥匙、采集带得上登录态；**驱动原生桌面窗口那部分只有 Windows 有**。

**判据**（唯一可信的那个，别看 Chrome 里的图标）：

```bash
curl -s 127.0.0.1:8900/api/browser-capability     # → {"state":"ready","connected":true,…}
```

- `"never-seen"` = 从没连上过 → 还没装，或者装在了另一个 Chrome 上。
- `"disconnected"` = 装过、现在没连 → 点一下扩展图标叫醒它（Chrome 会让它休眠，后端重启后尤其）。

### 2. 订第一条流 —— 记得给它一个频道

先找源：

```bash
curl -s -G 127.0.0.1:8900/api/sources --data-urlencode "q=播客"
```

`members[].source` 填它回的 `id`（**真正必须对的是这一个**），`plugin` 填它的 `adapter`
（`rsshub` / `replay` / `builtin` …）：

```bash
curl -s -X POST 127.0.0.1:8900/api/streams -H 'content-type: application/json' -d '{
  "id": "my-podcast",
  "label": "故事FM",
  "strategy": "fanout",
  "cadence_seconds": 86400,
  "options": {},
  "channel_id": "default-audio",
  "members": [{ "plugin": "replay", "source": "@streamapp/lizhi/lizhi-user",
                "params": { "id": "2657184879512415276" } }]
}'
```

**`channel_id` 不是可选的讲究**：一条不属于任何频道的流，这次会话在调度里、**重启之后就没了**
（开机只装载被某个频道引用的流）。要绑就在建流这一句里绑，别建完再补。频道用
`curl -s 127.0.0.1:8900/api/channels` 看，开箱自带四个（`default-timeline` / `default-audio` /
`default-video` / `default-tasks`）。

**判据**：

```bash
curl -s -X POST 127.0.0.1:8900/api/streams/my-podcast/refresh   # → {"fetched":961,"written":961}
```

`fetched: 0` **不是**"没有新内容"。常见成因：那个 `source` 在本机解析不到、参数不对、缺登录态、
或者那条源坏了。去 `curl -s "127.0.0.1:8900/api/debug/log?channel=harvest"` 看这一轮的分阶段
结论——**日志里连一条这个源的记录都没有，就是根本没跑到它**，而不是跑了没结果。

### 3. 打开需要钥匙的能力（转写 / 认字 / 摘要）

先问它现在缺什么：

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds
# extract 那一行的 branches: {"stt":false,"ocr":true,"article":true}   ← stt 缺钥匙
```

要语音转文字就配一把 Groq 的 key。**Stream 可以替你去申请**——它在你自己的 Chrome 里打开厂商
控制台、用你**已经登录**的账号建一把新 key，写进本地配置（不经过任何第三方）。

> **前提：先在那个 Chrome 里登录 <https://console.groq.com>**（Groq 支持用 Google 账号登录，免费额度
> 够用）。这一步用的就是你现成的登录态——没登录的话它会停在登录页，这不是失败，是缺前提。


```bash
curl -s -X POST 127.0.0.1:8900/api/source-runtime-config/provision \
  -H 'content-type: application/json' \
  -d '{"pluginId":"builtin","sourceId":"groq-whisper","params":{"name":"stream-auto-7f3a"}}'
# → secrets.apiKey.configured: true            实测约 17 秒
```

自己去 <https://console.groq.com/keys> 拿一把、用 `PUT /api/source-runtime-config` 填进去也行。
**配完不用重启**，下一次问就变了：

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds     # branches.stt → true
```

转写一集：

```bash
curl -s -X POST 127.0.0.1:8900/api/conversions -H 'content-type: application/json' \
     -d '{"kind":"extract","item":"<item id>"}'      # → {"id":"cv_…","status":"running"}
curl -s 127.0.0.1:8900/api/conversions/cv_…          # 轮到 status:"done"，result.text 就是文字稿
```

一小时的播客约 4~5 分钟（取媒体和重编码占大头，真正的识别只要几十秒）。

### 4. 接一个对话宿主（可选）

Stream 自己没有对话，用你已有的 agent。三步，第三步才是可选的：

**一、装 Stream。** 第 1 步已经做完了（`npm i -g @streamapp/stream && stream`）。
**装了它就有电脑操作**——用户自己那个已登录的 Chrome，加上原生桌面窗口。

**二、宿主那边配一行，指向 Stream。**

```bash
claude mcp add stream -- stream mcp      # Codex 是 config.toml 的 mcp_servers 一行
```

`stream mcp` 是一层 stdio 壳：它探一次本机的后端，在场就整面转发到 `/api/mcp`，不在场就先把
后端拉起来再转发。**这一行此后不用再改**——往 Stream 里加多少能力，工具都从同一个口出去。

**三、想要更多能力就往里加：**

```bash
stream add @streamapp/netdisk      # 网盘：验分享 / 转存 / 直链 / 跳转
stream remove @streamapp/netdisk   # 不想要了
```

能力包是 Stream 包的一格槽位（`package.json#stream.capability`），装进 `<dataDir>/recipes/`
后由后端在**自己进程里**挂上——登录态不出这个进程。界面上的「组件」页里点装是同一条路。
**装完要重启后端才生效**（安装那一刻只落盘），装上了没有的话先重启再排查。

内容检索与下载适配器不随新安装默认带上；需要时由你明确选择安装：

```bash
stream add @streamapp/bt0
stream add @streamapp/btbtla
stream add @streamapp/1lou
stream add @streamapp/zuna
stream add @streamapp/toubiec
stream add @streamapp/shooter
stream add @streamapp/iqiyi
```

它们仍是独立的 Stream 包，默认不带只是避免发行包替用户决定内容来源；安装、审核与卸载都走同一条
`stream add` / `stream remove` 链路。

再往下：第 5 节把 Stream 的 skill 装给你的 agent（MCP 给工具，skill 给"什么时候用哪个"）。

#### DSH 用户多一样：Stream UI bundle

DSH 装上它之后整张脸就是 Stream（内容流 + 对话）。它也读第 5 节装的那批 skill（同一个
`~/.agents/skills/` 目录）：

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2   # 引擎版本要对得上：这份 bundle 按 0.2.0 的客户端模块表构建
# 装进已经带 web 界面的那个 profile（$DSH_HOME/profiles/web）——bundle 关掉的是 web-app 的整页壳，
# 新建的空 profile 里没有它可关。想单独留一个 profile 给 Stream：先 cp -r profiles/web profiles/stream，再把下面的 web 换成 stream。
dsh plugin --profile web add @streamapp/dsh-plugin-stream-ui
dsh web                                                          # 单独的 profile 就是 dsh --profile stream
```

这份 bundle 是**唯一**要装进 DSH profile 的东西；能力包一律装进 Stream，DSH 那边一个字都不用改。
Stream 后端照常跑着就行（`stream`），那张页在本机哪个口上都不用告诉它——本机来源默认可信。
后端和 DSH 不在同一台机器时才需要登记：`STREAM_TRUSTED_ORIGINS=http://<那台机器>:<口> stream`。

> **模型是你自己的**：在 DSH 的「设置 - 模型」页配 provider；Stream 不参与。
> **前面三步都不依赖它**——收集、采集、转写都不用模型。

### 接给别的 AI 客户端（MCP）

不走 `stream mcp` 也行：后端跑着就直接用 HTTP 这一档 `http://127.0.0.1:8900/api/mcp`
（设了 `api_token` 才需要 `Authorization: Bearer …`）。不想让后端常驻就用 stdio 那一档，
客户端按需拉起进程。三条路的工具集一样。

### 5. 把 Stream 的 skill 装进你自己的 agent（Claude Code / Codex）

上一步给的是**工具**，这一步给的是**手艺**——什么时候用哪个、按什么顺序、什么算数。

```bash
curl -s -X POST 127.0.0.1:8900/api/skills/install
```

它把随包出货的 skill 刷进 `~/.stream/skills/`，再从 `~/.claude/skills/`（Claude Code）和
`~/.agents/skills/`（Codex）**链接**过去。是链接不是拷贝——升级之后两边同时变新。

**判据**：

```bash
curl -s 127.0.0.1:8900/api/skills      # hosts[].landings[].mode 都是 "link"
```

Claude Code 里敲 `/stream-` 看得到它们，Codex 里是 `$stream-`。名字一律带 `stream-` 前缀，
**不会顶掉你自己的同名 skill**；那个位置已经有别的东西就跳过并说明。撤销用
`POST /api/skills/uninstall`（只删它自己建的那些）。`mode` 报 `"copy"` 说明这台机器建不出
符号链接——功能一样，但升级后要再跑一次 install。

---

## 出问题时先跑这几句

**以副作用为准，不要以"应该好了"为准**——每一种坏法都是安静的。

| 问 | 命令 | 绿的样子 |
|---|---|---|
| 后端活着吗 | `curl -s 127.0.0.1:8900/api/health` | `{"ok":true}` |
| 采集的手在不在 | `curl -s 127.0.0.1:8900/api/browser-capability` | `"state":"ready"` |
| 这条流在调度里吗 | `curl -s 127.0.0.1:8900/api/streams` | 看得到你建的那个 id |
| 它真采到东西了吗 | `POST /api/streams/<id>/refresh` | `fetched > 0` **且** `written > 0` |
| 这个能力现在能用吗 | `curl -s 127.0.0.1:8900/api/conversion-kinds` | 那条的 `available` / `branches.*` 为 true |
| 我自己写的 recipe 装载了吗 | `curl -s 127.0.0.1:8900/api/recipes/local` | `ok: true`（`dir` 就是该往哪写；没装载会带 `error` 原文） |
| 这件事为什么做不了 | MCP 工具 `capability_status` | 它会分清「缺钥匙且我能替他申请」/「缺钥匙只能他自己拿」/「根本不是缺钥匙」 |

三个最容易误判的地方：

- **`fetched: 0` 不等于「没有新内容」**（见第 2 步）。
- **建流不带 `channel_id`**：这次能跑，重启后消失。
- **「配好了」不等于「能用了」**：判据是那条能力自己的自述（`/api/conversion-kinds`），
  不是配置那一格的 `configured`。

---

Apache-2.0 · 数据全在本机，不上传任何地方。
