# ingress-abuse-limits

## Why

服务可以经公网入口（反向代理终止 TLS）被设备、扩展与浏览器访问。配对码是 6 位、5 分钟有效的
一次性凭据，`POST /api/devices/pair` 与 `POST /api/ext/pair` 又没有 token 保护；`POST /api/ext/verify`
同样免 token。放在公网上，这三口没有速率限制，配对码空间只有 10^6，脚本几分钟就能走一遍。

现有的防线是「连错 5 次把活码全部作废」——它能挡住爆破，但也把用户手里的真码一起废掉；而且它
不区分来源，一个来源的失败会连带影响所有来源。入口这层还需要按来源计数与限流。

## What Changes

- **来源地址**：新增 `clientIp()`，从连接地址取来源；只有连接来自**受信的反向代理**时才读
  `X-Forwarded-For`（取最右一跳）。缺省不信任任何头。
- **限流原语**：新增 `TokenBucket`（按来源的请求速率）与 `PairingGuard`（按来源累计失败，到阈值
  冷却该来源；冷却期内正确的码也换不到 token）。
- **接上三处免 token 的入口**：设备配对口、扩展配对口、`POST /api/ext/verify`。前两处用
  `PairingGuard`，verify 用 `TokenBucket`。
- **设备网关**新增 `trustedProxies` 与 `rateLimit` 两个选项：嵌入方（宿主在反向代理后面）告诉网关
  信任哪个代理；`serve` 模式缺省不信任任何头，行为不变。

## Capabilities

### New Capabilities
- `request-rate-limits`：按来源的请求速率限制与配对码防爆破。

### Modified Capabilities
（无：现有路由的鉴权口径、返回码（错码仍是 403）与路径都不变；新增的只有 429 与两个可选选项。）

## Impact

- 新增：`src/http/client-ip.ts`、`src/http/rate-limit.ts`（各带测试）。
- 修改：`src/http/device-routes.ts`、`src/http/ext-binding-routes.ts`、`src/http/ext-public-routes.ts`、
  `src/engine/device-gateway.ts`、`src/http/app.ts`（只加可选依赖格与默认限流器）。
- 行为：公网上的爆破会在阈值后收到 429；正常配对（一次成功）不受影响。
- 不新建存储：计数只在进程内存里，重启即清（与配对码本身的生存期一致）。
