## ADDED Requirements

### Requirement: 出站 HTTP 只有一个入口

系统 SHALL 提供唯一的出站入口 `fetchFor`，按执行上下文设备选择实现：`local` 经 owned 通道发出，其他设备经该设备
的 `http.fetch` op 发出；两者 SHALL 对调用方呈现相同的 fetch 签名与 `Response` 语义。`PluginContext` SHALL 提供
`ctx.fetch`；plain-HTTP 与 HTML recipe 执行器 SHALL 经 `fetchFor` 发请求。code 包 SHALL NOT 直接调用全局 `fetch`，
一条守卫测试 SHALL 在出现时失败。

#### Scenario: eastmoney 的请求从绑定设备发出
- **WHEN** 东财绑定到 NAS，一条东财任务执行建会话、查委托、提交申购
- **THEN** 这些请求全部经 NAS 的 `http.fetch` 发出，包括不带 cookie 的行情请求

#### Scenario: 包绕过入口被拦下
- **WHEN** `packages/**` 下某个 code 包的源码直接调用全局 `fetch`
- **THEN** 守卫测试失败并指出位置

### Requirement: http.fetch 的线上语义

`http.fetch` SHALL 传递方法、URL、多值有序的请求头、可选请求体、重定向模式与超时；SHALL 回传状态码、多值有序的
响应头（含 `set-cookie`）、响应体与最终 URL。`redirect: 'manual'` 时 SHALL 原样回传 3xx 响应。响应体超过 10MB 时
SHALL 以 `too-large` 失败。cookie SHALL 由后端放进请求头，agent SHALL NOT 维护 cookie 状态。

#### Scenario: 302 原样回传
- **WHEN** 东财会话失效，经 NAS 请求 `/Trade/Buy`，重定向模式为 `manual`
- **THEN** 调用方收到 302 与 `location` 头，据此判定会话失效

### Requirement: 设备请求不占用 UI 会话租约

设备上的 `http.fetch` SHALL NOT 获取或等待该设备的 UI 会话租约；每台设备的在途 `http.fetch` SHALL 有独立的并发上限，
排队超时 SHALL 以区别于 UI 租约排队超时的错误报告。

#### Scenario: UI recipe 运行时 HTTP 照常
- **WHEN** 一台设备正在执行一条占用会话租约的 UI recipe，同时一条任务要经它发 HTTP 请求
- **THEN** HTTP 请求不等待租约，照常发出

### Requirement: 允许的主机由包声明并双重校验

包 SHALL 能在 `package.json#stream.network.hosts` 声明会访问的主机名后缀，缺省等于 `stream.credentials`；安装闸门 SHALL
向用户展示这份声明。后端 SHALL 只在目标主机匹配本次执行所属包的声明时派发到非 `local` 设备，否则以 `host-not-allowed`
失败且不发帧；派发时 SHALL 附带这份允许清单，agent SHALL 再次校验。设备配置了 `ALLOW_HOSTS` 时，agent SHALL 以它为准。

#### Scenario: 包访问未声明的站点
- **WHEN** 一次在 NAS 上执行的任务，其所属包经 `ctx.fetch` 请求一个它没有声明的主机
- **THEN** 后端以 `host-not-allowed` 失败，NAS 没有收到请求

#### Scenario: 设备侧清单优先
- **WHEN** NAS 配置了 `ALLOW_HOSTS=eastmoneysec.com`，后端下发的允许清单包含 `eastmoney.com`，请求目标是 `push2.eastmoney.com`
- **THEN** agent 以 `host-not-allowed` 拒绝

### Requirement: 设备始终拒绝私网目标

agent SHALL 在设备侧解析目标的 DNS，任一结果落在 loopback、RFC1918、链路本地、CGNAT（含 `100.64.0.0/10`）或 ULA
地址段时 SHALL 以 `private-target` 拒绝；SHALL 连接到校验过的那个地址；跟随重定向时 SHALL 对每一跳重复校验。
该检查 SHALL NOT 可被配置关闭。`local` 设备 SHALL 沿用主实例既有的 SSRF 守卫，语义不变。

#### Scenario: 不能借设备访问用户内网
- **WHEN** 经 NAS 请求一个解析到 `192.168.1.1` 的主机名，即使它在允许清单里
- **THEN** agent 以 `private-target` 拒绝

#### Scenario: 重定向到内网被拦
- **WHEN** 一个允许的公网主机以 302 重定向到 `http://10.0.0.5/`，重定向模式为 `follow`
- **THEN** agent 以 `private-target` 拒绝该跳

### Requirement: 设备请求可观测且不泄露内容

每次设备 `http.fetch` SHALL 在 debug bus 记录设备、方法、主机、状态码与耗时，SHALL NOT 记录请求头、响应头或请求体、响应体。

#### Scenario: 日志里没有 cookie
- **WHEN** 一次带 cookie 的东财请求经 NAS 完成
- **THEN** debug bus 有一条记录含设备、主机与状态码，不含任何 cookie 或请求体内容
