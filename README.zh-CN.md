# Stream

[English](README.md) | **简体中文**

**让你的 AI 探一次路，Stream 把这条路记下来——之后定时跑、不花 token、能进桌面 app，坏了再叫 AI 来修。**

今天的 agent 都能替你操作浏览器和电脑，但同一件事做第二遍，它不比第一遍便宜、也不比第一遍稳。
Stream 把 agent 跑通的那条路固化成一份 **recipe**——是可执行的数据，不是提示词——再由本机的调度器
在你**自己登录着的 Chrome** 和**桌面客户端**里重放，全程不经模型。

底下是一个可自托管的**信息流层**：RSSHub 路由加原生适配器（小红书、B 站、抖音、播客、网盘……）
汇进同一个收件箱，由同一个进程提供给网页界面和 AI agent（MCP）。所有数据都在你自己机器上。

## 一段话讲清架构

你订阅的是**频道（Channel）**（时间线 / 搜索 / 音频）。一个频道聚合若干条**流（Stream）**——
按计划抓取的成员，每条流从一个或多个**源（Source）**取数（`strategy: fanout` 全部合并；
`strategy: exclusive` 只取第一个健康的）。每个源只属于一个**插件（Plugin）**（适配器 + 展示器 +
可选的托管后端容器），源就是靠它执行的。无状态的按需能力（搜索、音频下载）是 **Provider**——
全局、带参数、内部在它的几个源之间互斥。权威定义、不变量与数据流见
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 快速上手

```bash
npx @streamapp/stream                    # 试一下
npm i -g @streamapp/stream && stream     # 长期用
```

需要 **Node 20+**，除此之外什么都不用装——不需要 git、Docker 或编译器。装完打开
<http://127.0.0.1:8900>；网页界面、`/api/*`、`/ws`、MCP 都走这一个端口。数据全在 `~/.stream`
（卸载 = 删掉它 + `npm rm -g @streamapp/stream`）。

**已经在用 Claude Code / Codex / OpenClaw？** 把这段话贴给它，它自己装、自己接上：

```text
Install Stream with `npm i -g @streamapp/stream`, start it with `stream`, verify
`curl -s 127.0.0.1:8900/api/health` returns ok:true, then register it as an MCP server
(`claude mcp add stream -- stream mcp`, or the equivalent one line for this host) and install its
skills with `curl -s -X POST 127.0.0.1:8900/api/skills/install`. If the browser extension is not
connected (`/api/browser-capability` is not "ready"), walk me through loading it.
```

从「装上了」到「它真的在替我干活」，这条路上每一种坏法都是安静的，所以按顺序以副作用为准：

| 问 | 命令 | 绿的样子 |
|---|---|---|
| 后端活着吗 | `curl -s 127.0.0.1:8900/api/health` | `{"ok":true}` |
| 浏览器扩展连上了吗 | `curl -s 127.0.0.1:8900/api/browser-capability` | `"state":"ready"` |
| 这条流在调度里吗 | `curl -s 127.0.0.1:8900/api/streams` | 看得到你建的那个 id |
| 它真采到东西了吗 | `POST /api/streams/<id>/refresh` | `fetched > 0` **且** `written > 0` |
| 这个能力现在能用吗 | `curl -s 127.0.0.1:8900/api/conversion-kinds` | 那条的 `available` / `branches.*` 为 true |

- **没装 Chrome 扩展，要登录的站点只回游客看得见的内容——而且不报错。** 采集借的是你自己浏览器的
  登录态；Stream 不自带浏览器，也不存你的密码。
- **建流时带上 `channel_id`。** 不属于任何频道的流这次会跑，重启之后就没了。
- **`fetched: 0` 不等于「没有新内容」**——更常见的是源解析不到、参数不对、或者缺登录态。

**完整的分步指南**——装扩展、订第一条流、打开转写、接对话宿主、装 skill、从命令行跑 recipe——在
**[cli/README.zh-CN.md](cli/README.zh-CN.md)**（npm 页上那份的中文版）。

## 接入 MCP

Stream 用**两种传输提供同一套工具**，按客户端挑：

| 传输 | 哪里有 | 什么时候用 | 要后端常驻吗 |
|---|---|---|---|
| **stdio** —— `stream mcp` | 每一份 npm 安装 | 默认选它。一行搞定，后端在不在都能用 | **不用**——它替你起一份 |
| **HTTP**（streamable）—— `http://127.0.0.1:8900/api/mcp` | 每一份安装 | 后端本来就常驻，想让客户端直连 | **要** |
| **stdio** —— `src/mcp/stdio-entry.ts` | 只有源码检出 | 在仓库里干活，想让只读工具在没有后端时也能答 | **不用** |

**Claude Code**
```bash
claude mcp add stream -- stream mcp                                     # stdio —— 普通安装
claude mcp add --transport http stream http://localhost:8900/api/mcp    # HTTP —— 后端已在跑
# 源码检出，没有后端也能用只读工具
claude mcp add stream --env STREAM_DATA_DIR=<abs>/stream/data \
  -- npx tsx --tsconfig <abs>/stream/tsconfig.json <abs>/stream/src/mcp/stdio-entry.ts
```

**Codex**（`~/.codex/config.toml`）
```toml
[mcp_servers.stream]
command = "stream"
args = ["mcp"]
# HTTP 形式（后端在跑）：把 command/args 换成 `url = "http://localhost:8900/api/mcp"`，
# 前提是你的 Codex 版本支持 streamable-HTTP 的 MCP server。
```

**antigravity / Gemini CLI**（`~/.gemini/settings.json`）与 **Claude Desktop**（同一个形状）
```json
{ "mcpServers": { "stream": { "command": "stream", "args": ["mcp"] } } }
```
HTTP 形式把 `command`/`args` 换成 `"httpUrl": "http://localhost:8900/api/mcp"`。

- HTTP 形式只有设了 `api_token` 才需要加 `Authorization: Bearer <api_token>`。
- 源码检出那一种**别丢 `--tsconfig`**：tsx 读的是客户端*工作目录*的 `tsconfig.json`，不是 Stream 的；
  碰上一份它解析不了的，server 一启动就死，客户端只报 `CONNECTION_CLOSED`。
- **工具列表的变化在服务端。** 工具变了不用重装任何东西——各客户端重连 / 重启，重新拉一次
  `tools/list` 即可。

两种传输各自怎么工作（探测规则、没有后端时哪些工具降级、环境变量）见
[docs/ARCHITECTURE.md → *MCP over stdio*](docs/ARCHITECTURE.md)。

## 登录态

要 cookie 的源（B 站、微博、小红书、夸克……）需要你浏览器里的登录态。**没有任何东西要配，也不涉及
容器**：装上扩展，后端在需要的时候自己去你的 Chrome 里取它要的 cookie——取哪些域名由你装了什么、
订了什么推出来。它们落在 `data/cookies.json`，权限 0600。插件后端容器从不持有凭证。
细节见 [docs/PACKAGE.md](docs/PACKAGE.md) §5。

## 当前限制

- Linux 没有 Stream Desktop 可执行文件。要登录态浏览器的源在那里仍然能跑，但只看得到游客可见的
  内容，而且不一定把这个限制报成错误。
- 原生桌面控制只在 Windows 上可用。macOS 只支持浏览器配对那一部分，不能控制任意桌面窗口。
- 写 recipe 的闭环还没有端到端打通：录制、审核、发布一份稳健的 recipe 仍然需要手工开发。
- 动作 recipe 用漂移检查保护每一步，但界面变了仍可能让一个动作只完成一部分；不核对目标就重试，
  可能把副作用再做一遍。
- 很老的本地数据库升级时可能需要手工恢复，而不是自动迁移。
- 需要托管容器的内置包随主发行包一起安装，目前不能事后用 `stream add` 补装。

## 从源码跑

给要改代码、或者自己写 RSSHub 路由的人。需要 Node 20+ 和 pnpm 10+。

```bash
git clone <this-repo-url> stream && cd stream
pnpm install
cp config.example.yaml config.yaml           # 改路径
pnpm test && pnpm typecheck
pnpm dev                                     # 后端 :8900
curl -s http://127.0.0.1:8900/api/health     # 起来了就是 {"ok":true}
```

插件后端（pansou、AList、Douyin……）是可选的容器，另外起：
`pnpm plugins compose > docker-compose.yml && docker compose up -d`。完整的前置条件、可选的 RSSHub
克隆、老数据库怎么升、日志、自托管的整套容器形态见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；
贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 文档

`docs/` 下的文档是英文的。

| 文档 | 回答什么 |
|---|---|
| [cli/README.zh-CN.md](cli/README.zh-CN.md) | 完整的使用指南：安装、第一条流、各项能力、接 agent |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模型（Channel / Stream / Source / Plugin / Provider）、配置分层、调度、对外服务、广告过滤、代码里各样东西在哪 |
| [docs/PACKAGE.md](docs/PACKAGE.md) | 加一个源或插件：清单、recipe、代码、容器、凭证各槽位 |
| [docs/API.md](docs/API.md) | HTTP API：流、频道、转换、包、访问控制 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 从源码跑、日常运维、发布形态 |
| [docs/GATEWAY.md](docs/GATEWAY.md) | 插件网关与端口规则 |
| [docs/AGENT-TOOLING.md](docs/AGENT-TOOLING.md) | 给对话 agent 加工具，并验证它真的照做 |
| [extension/README.md](extension/README.md) | 浏览器扩展 |

## 状态

每天自用。Stream 以 [Apache License 2.0](LICENSE) 授权。
