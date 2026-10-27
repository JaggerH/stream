# private-fetch-guard — 设计

## D1. 作用域：AsyncLocalStorage，不是全局客户端

开关要约束的是**四扇「调用方给什么抓什么」的门**：

| 门 | 底下的抓取 |
| --- | --- |
| MCP `read_url` | `article-extract` 梯子 → `safeFetchText`（Defuddle 档）；配图 OCR → `safeFetchResponse`；firecrawl 档（可信外部服务） |
| MCP `stream_fetch_url` | 直链分支不发包；包认领分支经包的 `ctx.fetch`（= `fetchFor`）发跳转请求（如 b23.tv 短链跟一跳） |
| MCP `video_resolve` | 经包 resolve 成员的 `ctx.fetch` |
| HTTP 门 `GET /api/media/from-url` | 与 `stream_fetch_url` 同一份 `fetchUrl` |
| HTTP 门 `GET /api/enrich?source=link` | 与 `read_url` 梯子第一档同一份 Defuddle 抽取与缓存 |

这四扇门的**共同底层**只有两处：`safe-fetch.ts` 的两个函数（文章路径），和 `fetchFor` 的
`local` 分支（包路径）。但这两处同时服务订阅采集、网盘、BYOK 端点等可信配置路径——所以校验
**不能挂在函数上，要挂在「这次调用在不在受守卫的作用域里」**：

- `src/net/caller-fetch-guard.ts` 用 `AsyncLocalStorage` 划作用域。四个门的入口各包一层
  `withCallerFetchGuard(fn)`；作用域内的出站连接走受校验的连接层，作用域外的一切照旧。
- 订阅采集、RSSHub 桥（独立 worker + 自带请求栈）、容器/适配器服务地址从不进入这个作用域，
  开关打开也访问不到它们——范围没有扩大是结构保证的，不是纪律约束的。
- 例外名单与开关状态也**不进 ALS**（ALS 只带「激活」这个事实）：名单在装配期从 config 解析一次，
  存进模块级策略位。同进程多实例（测试）各自装配时以最后一次为准——开关状态本来就是进程级
  部署配置，不是实例级业务数据。

## D2. 校验的就是连接的地址（防 rebinding 的唯一正解）

undici 允许给 Agent 一个自定义 connector（`buildConnector` 产物的包装）与自定义
`lookup`。组合成**连接时校验**：

1. **IP 字面量直接判**：connector 入口看 `options.hostname`，是 IP 字面量就走地址判定，
   拒绝类直接以带原因的错误结束连接（这一步不经过 DNS，net.connect 对 IP 字面量本就不会
   调 lookup——只挂 lookup 会漏掉重定向到 `http://127.0.0.1/` 这种目标）。
2. **主机名经守卫 lookup**：解析完成后**先判后还**——返回给连接层的地址列表里只剩放行的
   地址；一个不剩就报错。undici 只会连 lookup 返回的地址，所以「校验的地址」与「实际连接
   的地址」是同一批。
3. **每一跳都过 1 和 2**：`redirect: 'follow'` 下 undici 对每个新目标重新建连接，走的还是
   这个 Agent——重定向到内网、rebinding（第一次解析公网、第二次内网）都在同一道闸上被拒。

受校验的 Agent 只在守卫激活时构造（按策略缓存）；`safe-fetch` 与 `fetchFor` 的 `local` 分支
激活时把它作为 `dispatcher` 传给 ownedFetch，未激活时连 `dispatcher` 字段都不出现——关闭时
逐字节一致。

## D3. 地址判定清单

| 类别 | IPv4 | IPv6 |
| --- | --- | --- |
| 未指定 / 回环 | `0.0.0.0/8`、`127.0.0.0/8` | `::`、`::1` |
| 私有段 | `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` | — |
| 链路本地 | `169.254.0.0/16` | `fe80::/10` |
| CGNAT | `100.64.0.0/10` | — |
| ULA | — | `fc00::/7` |
| IPv4 映射 | — | `::ffff:0:0/96`（剥出内嵌 IPv4 按 v4 清单判） |
| 组播（自定） | `224.0.0.0/4` | `ff00::/8` |

组播不在需求清单里，是自加的：连接目标没有理由是组播地址，放行没有意义。判定基于
`node:ip`（`isLoopback` 等之外按 CIDR 手算，避免 Node 版本语义差异），错误信息带地址类。

## D4. 例外名单

`caller_fetch_guard.allow` 的每项：

- **主机名**（精确、大小写不敏感、去尾部 `.`）：该主机名的目标跳过 IP 判定——包括连接时
  lookup（名单内主机名解析出什么都放行，用户为它背书）。**不做后缀通配**：`*.internal`
  这类写法超出本次范围，需要时再扩。
- **CIDR / 裸 IP**（裸 IP 视为 /32 或 /128）：对解析出的地址判定放行。IPv6 段写作
  `fd00::/8` 这类标准形式。

名单只在守卫激活的路径上生效；`safe-fetch` 现有主机名级闸（`publicHttpUrl`）对未激活路径的
语义不变。名单内的主机名若被现有闸拦下（如 `localhost`）：激活路径以本名单为准放行——
名单就是「我知道我在干什么」的出口，若在激活路径上被旧闸先拦，名单就没有意义。

## D5. 拒绝的报错路径

统一抛 `CallerUrlBlockedError`（带 `host`、`address`、`reason`，消息中文、含地址类）。各门的
呈现：

- `read_url`：run 内接住 → `{ url, error: '<原因>' }`。未接住的深层路径（重定向跳内网被连接层
  拒绝）由错误沿梯子带上原因，工具面落成 isError 消息——两条路都不裸抛、都不误报
  「页面没正文」。
- `stream_fetch_url` / `video_resolve`：run 内接住 → 结果对象里的 `error` 字段。
- `/api/media/from-url`、`/api/enrich?source=link`：现有 catch → `upstream_error` + 原因。

门入口各做一次**前置校验**（协议 + 主机/IP 判定）：绝大多数拒绝在发包前就发生，错误 crisp；
连接时校验仍是第二道（也是对重定向唯一有效的那道）闸。

## D6. 测试策略（不碰外网）

- 解析器可注入：策略带 `resolve` 函数位（缺省 `node:dns.lookup` all 模式）；单测注入假解析表。
- 重定向与「范围没有扩大」用本机 `node:http` 起的真实监听套接字测（连的全是 127.0.0.1，靠
  注入解析把一个假主机名映到它）。
- rebinding：假解析第一次回公网地址（如 `93.184.216.34`——不真连，只会被连接层用；用
  `redirect:'manual'` 的首跳在假服务器上）第二次回内网 → 第二次被拒。
- 关闭一致性：策略缺省时对内网 URL 断言现状（`safeFetchText` → `null`、`fetchUrl` → 现有
  错误文案、`fetchFor` 不带 dispatcher）。
