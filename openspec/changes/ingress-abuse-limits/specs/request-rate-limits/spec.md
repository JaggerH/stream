## ADDED Requirements

### Requirement: 来源地址按受信代理解析

系统 SHALL 提供按来源的请求键：缺省取 TCP 连接的对端地址，**不信任任何转发头**。只有当对端地址
出现在调用方给出的受信代理清单里时，系统 SHALL 读 `X-Forwarded-For` 并取最右一跳作为来源；头缺失或
不是地址形状时 SHALL 退回连接地址。来源地址拿不到时 SHALL 使用同一个共享桶，不得因此放行。

#### Scenario: 直连时忽略伪造的转发头
- **WHEN** 请求直连到达（对端不在受信代理清单里），且带 `X-Forwarded-For: 1.2.3.4`
- **THEN** 限流键是连接的对端地址，不是 `1.2.3.4`

#### Scenario: 反向代理后面取真实来源
- **WHEN** 连接来自受信代理，且 `X-Forwarded-For` 是 `1.1.1.1, 198.51.100.7`
- **THEN** 限流键是 `198.51.100.7`（最右一跳）

### Requirement: 配对入口按来源限流与防爆破

`POST /devices/pair` 与 `POST /ext/pair` SHALL 先过该来源的请求令牌桶，再按来源累计失败次数。
同一来源在窗口内的失败次数达到阈值时，系统 SHALL 冷却该来源，冷却期内的请求 SHALL 返回 429 并带
`Retry-After`，**即使出示的是正确的码**。成功一次 SHALL 清掉该来源的失败计数。错码的返回码 SHALL
保持 403 `invalid-code` 不变。

#### Scenario: 连续错码后被冷却
- **WHEN** 同一来源对配对口连续提交错误码，次数达到阈值
- **THEN** 后续请求返回 429；冷却期内用正确的码请求同样返回 429

#### Scenario: 冷却只影响该来源
- **WHEN** 一个来源被冷却，另一个来源用同一个有效码请求
- **THEN** 另一个来源照常换到 token

#### Scenario: 一次成功不累积
- **WHEN** 同一来源先失败若干次（未到阈值），随后用正确的码成功一次，再继续失败
- **THEN** 失败计数从零重新开始

### Requirement: 免 token 的扩展身份口按来源限流

`POST /api/ext/verify` SHALL 按来源令牌桶限流，超出后 SHALL 返回 429，且不再签 proof。
限流器 SHALL 每个挂载一份（serve 与嵌入方各自一份），不共享全局状态。

#### Scenario: 高频打 verify
- **WHEN** 同一来源在短时间内超过令牌桶容量地调用 `/api/ext/verify`
- **THEN** 超出容量的请求返回 429，响应里没有 proof

### Requirement: 嵌入方声明受信代理

`deviceGateway(stream, opts)` SHALL 接受 `trustedProxies`（受信代理地址清单，缺省空）并把三处
入口的限流键按它解析；SHALL 接受 `rateLimit` 只为测试注入阈值。`serve` 模式 SHALL 缺省不信任
任何转发头，既有鉴权与路径行为不变。

#### Scenario: 嵌入方在反向代理后面
- **WHEN** 宿主传入 `trustedProxies: ['127.0.0.1']`，请求经该代理带 `X-Forwarded-For` 到达
- **THEN** 配对口的锁定按头里的来源计算，而不是按代理地址
