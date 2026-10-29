# ingress-abuse-limits — design

## 现状

| 入口 | token | 现有防线 |
|---|---|---|
| `POST /api/devices/pair` | 无（码就是凭据） | 码 5 分钟一次性；**全局**连错 5 次作废活码 |
| `POST /api/ext/pair` | 无 | 同上（扩展绑定表自己一份计数） |
| `POST /api/ext/verify` | 无（Origin 门控） | 无 |

「全局连错 5 次作废」不区分来源：公网上的脚本可以拿它当 DoS，把用户刚签出来的码打废；
也没有请求速率上限。服务在反向代理后面时，连接地址永远是代理，按连接地址计数等于所有客户端
共用一个桶——必须能读代理追加的来源。

## 形状

```ts
// src/http/client-ip.ts
resolveClientIp(peer, xff, trustedProxies): string | undefined
clientIp(c, trustedProxies): string | undefined

// src/http/rate-limit.ts
class TokenBucket { constructor(opts: { capacity; refillPerSecond; now?; maxKeys? }); take(key): boolean }
class PairingGuard {
  constructor(opts?: { now?; maxFailures?; failureWindowMs?; cooldownMs?; burst?; refillPerSecond? })
  allow(source): boolean          // false → 429
  fail(source): void              // 到阈值 → 冷却这个来源
  succeed(source): void
  retryAfterSeconds(source): number
}
```

### 关键决定

1. **缺省不信任任何转发头。** `trustedProxies` 是一份精确地址清单（不做 CIDR：部署里代理就那几个
   地址）。只有 TCP 对端在清单里时才读 `X-Forwarded-For`，取**最右一跳**（代理追加的那一跳；
   左边的可以被客户端自己编）。头缺失或不是地址形状就退回连接地址，不把垃圾当键。
2. **两种限制分开。** 请求速率（令牌桶）挡高频；失败计数（PairingGuard）挡慢速猜码。只看速率的话，
   每分钟 10 次、10^6 的空间仍然要 70 天；只看失败计数的话，失败前的请求量不设上限。
3. **冷却按来源，不按码。** 码自身「连错 5 次作废」保留（那是最后一道），但冷却期内这个来源
   连正确的码也换不到 token（429）——否则攻击者只要等用户重新签一个码就能接着猜。
4. **成功一次清掉失败计数。** 正常用户签一次、配一次，不会累积。
5. **计数只在内存。** 与配对码同一生存期；重启即清，不需要新表。
6. **返回码**：错码仍是 403 `invalid-code`（既有客户端行为不变）；被限流 / 冷却才是 429
   `too-many-attempts`，带 `Retry-After`。
7. **谁传 `trustedProxies`**：`stream serve` 缺省不传（不信任任何头）；嵌入方在网关选项里传
   （宿主知道自己的反向代理是谁）。`DeviceGatewayOptions.rateLimit` 只为测试注入阈值，生产用缺省值。

### 缺省值

- `PairingGuard`：窗口内 5 次失败 → 冷却 10 分钟；请求桶突发 10、每秒补 0.2（约每分钟 12 次）。
- `ext/verify`：突发 30、每秒补 1。
