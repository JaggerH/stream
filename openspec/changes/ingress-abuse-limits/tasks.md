# ingress-abuse-limits — tasks

- [x] 1. `src/http/client-ip.ts`：`normalizeIp` / `isTrustedProxy` / `resolveClientIp` / `clientIp`；单测覆盖默认不信头、受信代理取最右一跳、垃圾头回退
- [x] 2. `src/http/rate-limit.ts`：`TokenBucket`（按 key、可注入时钟、键数上限）与 `PairingGuard`（窗口失败计数 + 冷却 + 请求桶）；单测覆盖阈值、窗口、成功清零、冷却期正确码也拒
- [x] 3. `device-routes.ts`：`/devices/pair` 过 `sourceIp` + `pairingGuard`；被拒回 429 + `Retry-After`
- [x] 4. `ext-binding-routes.ts`：`extPairHandler` 同上（网关的 basePath app 与固定 `/api/ext` app 共用）
- [x] 5. `ext-public-routes.ts`：`/ext/verify` 按来源令牌桶，超限 429；缺省每个挂载一份
- [x] 6. `device-gateway.ts`：`trustedProxies` 与 `rateLimit` 选项，接上三处
- [x] 7. `http/app.ts`（serve）：`/api/ext/verify` 用同一份默认限流器；`HttpDeps` 加 `trustedProxies` / `verifyRateLimit`
- [x] 8. 测试：设备配对、扩展配对、网关（受信代理头）、verify 各一条限流用例；既有用例全绿
- [x] 9. 全量 `vitest run src shared` + `tsc --noEmit -p .`
