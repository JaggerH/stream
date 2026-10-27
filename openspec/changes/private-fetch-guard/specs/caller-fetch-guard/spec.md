## ADDED Requirements

### Requirement: 调用方 URL 抓取路径可选拒绝私网地址

系统 SHALL 提供可选开关（`caller_fetch_guard.reject_private`，缺省关闭）作用于**由调用方传入
任意网址**的抓取路径：MCP 工具 `read_url`、`stream_fetch_url`、`video_resolve` 与 HTTP 门
`GET /api/media/from-url`、`GET /api/enrich?source=link`。开关关闭时这些路径 SHALL 与开关引入前逐字节一致。开关 SHALL NOT
作用于订阅源采集、RSSHub 桥、插件与适配器的服务地址等可信配置路径，也 SHALL NOT 通过替换
全局 fetch 或进程级 HTTP 客户端实现。

#### Scenario: 关闭时一切如旧
- **WHEN** 未配置 `caller_fetch_guard`（或 `reject_private` 为 false），调用方经 `read_url` 请求一个内网地址
- **THEN** 行为与开关引入前完全一致（现有主机名级闸照常，不新增解析、不加连接层参数）

#### Scenario: 打开时不波及可信配置路径
- **WHEN** 开关打开，订阅源的适配器代码经 `ctx.fetch` 访问本机（127.0.0.1）上的服务
- **THEN** 请求照常发出并成功；RSSHub 桥的请求栈与本进程出站通道均不受影响

### Requirement: 连接时逐跳校验

开关打开时，上述路径的每一次出站连接（含重定向产生的每一跳）SHALL 在**连接时刻**按实际要
连接的 IP 判定：通过自定义连接层（IP 字面量直判 + 自定义 lookup 只向连接层返回放行地址）保证
被校验的地址就是实际连接的地址，SHALL NOT 采用「先解析校验、再让 fetch 自行重新解析」的写法。
协议 SHALL 限定为 http/https。拒绝的地址 SHALL 至少覆盖：回环（127/8、::1）、私有段
（10/8、172.16/12、192.168/16）、链路本地（169.254/16、fe80::/10）、CGNAT（100.64/10）、
ULA（fc00::/7）、未指定（0.0.0.0/8、::）、IPv4 映射的 IPv6。

#### Scenario: 公网页面 302 到回环被拒
- **WHEN** 一个公网主机的页面对守卫激活的路径 302 到 `http://127.0.0.1:…`
- **THEN** 不到达回环即被拒，错误指明重定向目标为回环地址

#### Scenario: DNS rebinding 被拒
- **WHEN** 同一主机名的解析第一次返回公网地址、第二次（实际连接那次）返回内网地址
- **THEN** 实际连接使用的是被校验过的放行地址列表，内网结果被拒，连接不建立

### Requirement: 例外名单

`caller_fetch_guard.allow` SHALL 接受主机名（精确匹配）与 CIDR 网段（IPv4 / IPv6）。名单内的
主机名 SHALL 跳过 IP 判定，名单内网段 SHALL 对解析出的地址放行。名单 SHALL 只作用于开关
覆盖的路径。

#### Scenario: 名单内的内网地址放行
- **WHEN** 开关打开、名单含 `127.0.0.1` 与 `192.168.8.0/24`，调用方经 `read_url` 请求这两类地址
- **THEN** 请求正常发出；名单外的同类地址（如 `10.1.2.3`）被拒

### Requirement: 拒绝时给出明确原因

被拒时系统 SHALL 以明确的错误返回（工具结果对象的 `error` 字段或 MCP isError 消息、HTTP 门
错误响应），错误 SHALL 带上被拒主机、地址与原因类别，SHALL NOT 表现为未处理异常或
「没抓到正文」一类的失败误报。

#### Scenario: read_url 被拒的回执
- **WHEN** 开关打开，`read_url` 收到一个解析到 `10.x.x.x` 的主机名
- **THEN** 工具回执为带原因的错误信息（含主机与地址类），不是异常、也不是「页面没正文」
