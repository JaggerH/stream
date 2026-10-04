# @streamapp/netdisk

Stream 的**可选能力包**：**认盘**——验一条网盘分享还活不活着、把夸克分享转存进用户自己的盘、
取可播放的直链、跳转网盘 web 页。**配号**（把网盘文件对上节目单：绑定 / 匹配 / 归档）不在这里，
那是 Stream 编排层的事。

这份 README 是这个包对外的全部说明，所以它**自包含**：不指向仓库里的设计文档（那些路径装了包
的人一个都打不开）。

## 装法

```bash
stream add @streamapp/netdisk
```

装进 `<dataDir>/recipes/@streamapp__netdisk/`，Stream 后端**重载后**按 `package.json#stream.capability`
这一格动态 import `dist/index.js`、取它导出的 `capability` 挂上。四个动词随之出现在 8900 的
`/api/mcp` 上，宿主（Claude Code / Codex / DSH）那一行不用改——它们只认得 Stream 一个口。
不想要了就 `stream remove @streamapp/netdisk`。

**产物必须自包含**：装到的那个目录里没有 `node_modules`，安装门的白名单也只放行
`package.json` / README / `dist/index.js` 这几样，所以 tsdown 把 `shared/netdisk/` 那些相对
import 全打进那一个文件（`tsdown.config.ts`）。

**登录态不用另装东西**：电脑操作是 Stream 的内置能力，`streamBrowserCookies` 服务由后端在
同一个进程里挂出来（下节）。这个包在 `package.json#stream.credentials` 申报它要借哪几个域
（`quark.cn` / `115.com` / `drive.uc.cn`）——那是它的授权边界，安装确认页会逐域念给用户听。

## 给模型的四个动词

| 动词 | 做什么 | 要什么 |
|---|---|---|
| `netdisk_verify_share` | 一条分享（quark / baidu）→ `validity` + 文件名（匿名只读） | 无 |
| `netdisk_save_share` | 一条夸克分享 → 转存进用户自己的盘（**写盘**） | 夸克登录态 |
| `netdisk_play_link` | OpenList 路径 → 直链（+ 有登录态时夸克转码流） | OpenList（external 档）；转码流另要登录态 |
| `netdisk_folder_url` | 网盘内目录 → 夸克 web 页 URL | 夸克登录态 |

「让模型直接翻盘」（列目录 / 取文件信息）不由本包提供：OpenList 自带只读 MCP（`/mcp`），一行
`@deepseek-ai/dsh-mcp-client` 指过去即可（`Authorization` 裸放永久 token，无 `Bearer`）。

**登录态从哪来**：同进程借后端挂出来的 `streamBrowserCookies` 服务（用户自己那个 Chrome 里的
cookie，不落盘、不出进程）。能力体只认识 `ctx.require(BROWSER_COOKIE_SERVICE)` 并**每次调用
现取**——那个服务可能比它晚挂上、也可能中途被收掉，装配期取一次就等于把一个会变的答案冻住。
服务不在场时，要登录态的动词回「失败 + 指路」，验活照常。

## 两档，由配置决定

这个包的 config 从 Stream 的 `config.yaml` 里 `capabilities.netdisk` 那一格来，只有两个字段：

```yaml
capabilities:
  netdisk:
    openlistUrl: http://127.0.0.1:8900/_p/alist   # 给了 = external 档
    openlistToken: alist-…                         # 必须是永久 token，不能是 48h JWT
```

- **external 档**（给了 `openlistUrl`）：只做读 / 转存 / 播放，**不碰 storage admin**——挂载自愈归给
  这个 OpenList 的主人（Stream 在场就是 Stream；两个 reconciler 抢一个 OpenList 会打架）。
- **managed 档**（没给）：本包自己管一个 OpenList——全走 Docker Engine API（`shared/docker/engine-api.ts`，
  与 Stream 的 standby 同一份；不需要 docker CLI / compose）。**懒**：装载期只探一眼记日志，第一次取直链
  才拉镜像 `openlistteam/openlist:latest`、建容器 `stream-netdisk-openlist`（命名卷 `netdisk-openlist-data`、
  只发布 `127.0.0.1` 随机口、`MCP_ENABLE=true`、**以 root 起**——Engine API 新建的命名卷是 root 属主而镜像
  以 UID 1001 跑、入口只查权限不 chown，活体撞到过容器秒退）→ 等 `/ping` → `openlist admin set` 随机密码 →
  login → 换永久 token → 落到 `<dataDir>/openlist.json`（0600）→ 按 `managed.mounts`（默认 `['quark']`）
  把浏览器里的 cookie 灌成 OpenList storage。空闲超过 `managed.idleMinutes`（默认 240）停容器，下次用到再起。

  ```yaml
  capabilities:
    netdisk:
      managed: { idleMinutes: 240, mounts: [quark] }   # 都可省
      dataDir: ~/.stream-netdisk-plugin                 # 可省
  ```

  **归属让位**：本机已有 `com.docker.compose.service=alist` 的容器（= Stream 在管 OpenList）时，本包不建
  第二份、每次调用都重问一次，理由里点名那个容器并指路 external 档。`managed.ignoreOwner: true` 只给冒烟用。

**token 必须是永久 token**（OpenList 设置页「令牌」那一格 / `x_setting_items.token`，形如 `openlist-…`
或旧的 `alist-…`），不能是 `auth/login` 换来的 48h JWT：本包没有 401 自动重登通道，JWT 过期就是静默断连。
判据按结构（`shared/netdisk/token-shape.ts`），JWT 形状的值会被当场拒掉并写进日志。Stream 在场时问
`GET /api/netdisk/openlist-access` 拿这个 token 和网关路径。

## 让模型直接翻盘：一行 dsh-mcp-client

OpenList 自带只读 MCP（`/mcp`：`fs.list` / `fs.get` / `fs.link`）。要它就自己在 profile 里加一行：

```yaml
- id: stream-netdisk-fs
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: stream-netdisk-fs
    transport: streamable-http
    url: http://127.0.0.1:<口>/mcp           # managed 档：口在容器 inspect 里（随重建变），token 在 <dataDir>/openlist.json
    headers: { Authorization: <永久 token> } # 裸放，无 Bearer（OpenList 对 Bearer 前缀答 401）
    failOnStartupError: false
```

## 冒烟：这台机器的 managed 档走不走得通

```bash
node_modules/.bin/tsdown
node scripts/smoke-managed.mjs [--data-dir <dir>] [--path </quark/x.mkv>] [--ignore-owner]
```

同机跑着 Stream 时**预期就是让位**（返回值里点名 Stream 的容器）。`--ignore-owner` 才真走整条链——会在本机
多出一个容器和一个卷，验完自己 `docker rm -f stream-netdisk-openlist && docker volume rm netdisk-openlist-data`。

## 本机怎么打开（Stream 开发机）

装它的是用户，不是 Stream。本地改完先出产物，打个 tarball 装进自己的 dataDir：

```bash
cd capabilities/netdisk && npm run bundle   # 产物 dist/ 不进 git
npm pack                                     # → streamapp-netdisk-<version>.tgz
stream add ./streamapp-netdisk-<version>.tgz
```

后端重载后看它日志里 `[stream-netdisk]` 那几行：`external 档：OpenList 在 …` +
`四个 netdisk 动词已交给宿主注册：…`；借到登录态时多一行 `已接上 streamBrowserCookies`。
真挂没挂上归宿主——撞名被硬拒时紧跟着会有一行说清是谁先占了那个名字。

## 开发

```bash
npm run typecheck     # 比根 tsconfig 严（exactOptionalPropertyTypes）：shared/netdisk 里的代码两边都要过
npm test              # 根 `pnpm test` 也会收进这份 suite
npm run bundle        # tsdown → dist/index.js（shared/netdisk 全部 inline 进去，无外部 import）
```

出货清单（`package.json#files`）只有 `dist`，产物只有 `dist/index.js` 一个文件。
**这个文件名是契约**：能力槽位与安装门的 tarball 白名单都只认它这一个字面量，多切一个 chunk
的表现是包装得进去、后端 import 时才 `ERR_MODULE_NOT_FOUND`——整条链上没有一处会红，
直到用户那边坏掉。所以 tsdown 配了 `noExternal` + 不出 dts。

判决与取数**全在** `shared/netdisk/`（OpenList client、夸克 save / play / browse / verify、百度 verify）；
Stream 编排层 import 的是同一份。别在这个包里复刻一份。
