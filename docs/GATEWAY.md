# 插件网关与端口规则（Gateway & Ports Cookbook）

> 给未来 AI 的渐进式披露入口：遇到"某个插件后端连不上 / 端口对不上 / `/_p` 404"类问题，先读这一篇，再按下面的文件指引深入。

## 一句话心智模型

**只有一个对外入口：`127.0.0.1:8900`。`/_p/<service>/*` 的反代由**后端自己**做（`mountPluginGateway`，见 `src/http/plugin-gateway.ts`），不是 Caddy——插件容器自己从不对外开门。**

形态只有两条：

- **主路（dev + 装好的 `stream` + MCP）**：**没有 Caddy**。后端是宿主上的原生进程、**自己绑 8900 就是那扇门**：`/api`、`/ws`、`/_p` 自己应答，其余路径 dev 期转给宿主的 Vite（`src/http/dev-frontend.ts`）、release 期是打包静态（`src/http/static-mount.ts`）。它够不到容器内网 DNS，所以插件走 **host 档**那扇 loopback 门（见下）。
  - release 与 dev 是同一个后端，只差谁拉起它：release = 打包的 `server.mjs`（`stream` 命令），dev = `tsx watch src/serve.ts`，两边都绑 `8900`。
- **自托管旁支（NAS/VPS，`pnpm plugins compose --selfhost`）**：Caddy 在 8900 上当**瘦边缘**——把 `/api`、`/ws`、`/_p/*` 统统转发给 `serve-backend`（`Caddyfile.local`），自己不认识任何插件；serve-backend 与每个插件容器同挂 `stream` 网，直连容器 DNS 完成 `/_p` 反代。

**`STREAM_PLUGIN_NETWORK` 决定后端怎么够到插件容器，三档**：

| 档 | 谁在用 | 怎么够到插件 |
|---|---|---|
| `host` | **主路常态**（`pnpm dev` / stdio / 装好的 `stream`；`scripts/dev.sh` 已默认设好） | 「一扇门」：`compose.ts` 给每个带 backend 的插件发布一个 `127.0.0.1::<容器口>` loopback 随机口；standby 唤醒容器后 inspect 出这个口、缓存 origin，后端直连（`plugin-target.ts` 头注 + spec `2026-07-22-host-plugin-door-design.md`） |
| `compose` | 只剩自托管旁支 | 与插件同 `stream` 内网，`resolvePluginTarget` 静态解析容器 DNS `http://<service>:<port>` |
| `none` | 没起任何插件容器 | 够不着：`/_p` 网关根本不挂载（打印 `/_p gateway not mounted`），`resolvePluginTarget` 返回 `null`，代理为零。**核心照跑** |

宿主端口数量是 O(1)，不随插件数量增长——**loopback 随机口不违背这条**（绑 `127.0.0.1`、随容器生灭、不占对外预算）。真正要守的是：**别给普通后端加固定 `ports:`**。

## 两类容器，两种出口（这是最容易被误导的地方）

| 类型 | 出口方式 | 例子 |
|---|---|---|
| 普通插件后端（无人类 UI） | `expose` + 一个 **loopback 随机口**（`127.0.0.1::<容器口>`，host 档的数据面）；客户端一律经 `/_p/<service>/*` | pansou、douyin-tiktok-download-api |
| 带自己管理 UI 的 facility | 在 `stream.backend` 里声明 `publish: <宿主端口>`，**额外**直接发布（`0.0.0.0`） | 机制在（`src/packages/descriptor.ts` schema + `compose.ts` `backendService`），但**无插件在用**（`grep publish packages/*/package.json` = 0）。含 AList：它是 expose+loopback，Stream 经登录态 + bootstrap 全权接管它的存储配置，不暴露它自身的 UI/密码。 |

生成物里**只有插件容器**，一个基础设施容器都没有（`compose.test.ts` 钉着）。登录态不经容器——扩展直推后端，见 `docs/PACKAGE.md` §5.2。

误区回顾：`docker ps` 里的端口清单 ≠ 插件网关路由表。**`docker ps` 现在会给每个跑着的插件显示一个 `127.0.0.1:<随机口>->…`**——那是 host 档的数据面，不是"这个插件对外开了口"，也不是网关规则的一部分；`/_p` 的路由表只在 `mountPluginGateway` 里。反过来，容器**停着**时那个口不存在（随容器生灭），所以从 `docker ps` 看不到某插件 ≠ 它坏了。

## 单一事实来源（改哪里）

- `src/plugins/gateway.ts` — `GATEWAY_PORT`（默认 8900）、`GATEWAY_PREFIX`（`/_p`）、`pluginGatewayUrl()`（给客户端的根相对 URL）。compose 生成器和前端代码都从这里 import，**不要在别处硬编码端口**。
- `src/http/plugin-gateway.ts` — `mountPluginGateway`：后端自己实现的 `/_p/<service>/*` 反代，剥前缀、透传 method/headers/body、流式回传。目标 origin 由 `src/plugins/plugin-target.ts` 的 `resolvePluginTarget`（compose 形态：容器 DNS）或 standby 的 `standbyOrigin` 缓存（host 形态：唤醒后 inspect 出的 loopback 随机口）解析；none：不注册路由。**这是路由真正生效的地方，不是 Caddyfile。**
- `src/plugins/compose.ts` — 由各插件 `package.json` 的 `stream` 字段生成 compose 服务（`--selfhost` 时还生成瘦 Caddyfile）：
  - 普通 backend → `expose: [port]` + `ports: ["127.0.0.1::<port>"]`（`backendService`；后者是 host 档数据面）
  - `backend.publish` → 额外 `ports: ["<publish>:<port>"]`
  - 网关服务本身（瘦边缘 Caddy）→ `ports: ["127.0.0.1:8900:80"]`（`services.gateway`）——**只有 `--selfhost` 那一档才生成它**：条件是 `opts.stream` 在场，因为主路上后端自己就是门，一个 Caddy 站在那儿无处可转
  - `generateCaddyfile` → 只有 `import Caddyfile.local`：插件 `/_p` 反代已收进后端，Caddy 侧一条插件路由都不生成。
- `Caddyfile.local`（`.example` 为种子）— **仅自托管档**的瘦边缘手写路由：`/api`、`/ws`、`/_p/*` → `serve-backend`，`/` 也 → `serve-backend`（界面住在它发的那张独立正门页里）。主路没有 Caddy，这两个文件不参与。
- `packages/<name>/package.json`（`stream.backend`） — 每个插件声明自己的 backend（image/port/health/gpu/volumes/mem/publish 等）。（`src/plugins/` 是 loader/compose/gateway 的**代码**，不是描述符所在。）
- `docker-compose.override.yml` — 由生成器产出的本地 dev 覆盖（把 `backend.dev` 的服务换成本地源码挂载），**不要手改后指望持久**，重跑生成会覆盖。

## 排错顺序（按此渐进深入）

1. **宿主机上**（浏览器 / curl / Postman / host 侧脚本）打 `http://localhost:8900/...` 报 `ECONNREFUSED / fetch failed` → 先确认后端起没起（主路：`pnpm dev`；那扇门就是后端自己）；仍不通就换成 `127.0.0.1:8900`（自托管档的网关只发布 IPv4，部分 fetch 客户端解析 `localhost` 会先试 `::1` 扑空）。**这条不适用于 server-side adapter**——adapter 早已不经网关端口：走 `resolvePluginTarget`（`src/plugins/plugin-target.ts`）直连容器 DNS `http://<service>:<port>`，adapter 侧的 `ECONNREFUSED / fetch failed` 应查 descriptor / `STREAM_PLUGIN_NETWORK` 接线是否正确（见第 4 条）。
2. `/_p/<service>` **404** → 后端压根没注册该路由：`mountPluginGateway` 无目标时打印 `/_p gateway not mounted`（= `none` 档，没起插件容器），或该 service 不在 descriptors 里。
3. `/_p/<service>` **502，而且是秒回**（不是超时）→ host 档取不到 origin。最常见的原因不是"容器睡着"（睡着能唤醒），而是**容器根本不存在**：`docker compose down` 会把停着的插件容器**删掉**，而 standby 只启停、不创建。修法 `docker compose create`，再打一次就会看到 2～3 秒的唤醒。
4. 想直连某个后端调试 → 容器跑着时 `docker ps` 里那个 `127.0.0.1:<随机口>` 直接 curl（host 档本来就走它），或 `docker compose exec` 进容器；别为调试加 `publish`。
5. 远程栈 / 发行包 → 客户端侧用 `pluginGatewayUrl` 始终给根相对 `/_p/<service>`；服务端 fetch 基址由 `STREAM_PLUGIN_NETWORK` 决定（主路 `host` → standby 的 loopback origin；自托管 `compose` → 容器 DNS）。单个 adapter 的显式 url 配置优先级更高。**没有"整体 base url"这种配置**——base 一身二用（既给客户端又给后端自己 fetch）是错的，两者分家。

## 相关专题

- Stream 包总览与 `package.json#stream` 字段：`docs/PACKAGE.md`
- 整体架构：`docs/ARCHITECTURE.md`
- AList / netdisk 接入设计：`internal design record`（AList 现为 expose-only，Stream 经登录态 broker + bootstrap 自动接管其存储配置，不再经宿主发布的 Web UI 手动配；对外只走 `/api/netdisk/*`）
