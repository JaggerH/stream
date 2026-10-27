# private-fetch-guard — tasks

## 计划 1：守卫模块与接线

- [x] 1. `src/net/caller-fetch-guard.ts`：配置 → 策略（`reject_private`、`allow` 名单解析、可注入 `resolve`）；地址判定（IPv4/IPv6 各类 + IPv4 映射剥皮）；`CallerUrlBlockedError`
- [x] 2. 连接时校验的 undici Agent（自定义 connector：IP 字面量直判 + 守卫 lookup 只还放行地址），按策略缓存
- [x] 3. 作用域（AsyncLocalStorage 的 `withCallerFetchGuard`）与模块级策略位（`configureCallerFetchGuard`）
- [x] 4. `safe-fetch.ts`：激活时走受校验 dispatcher（协议预检 + 名单放行旧闸），未激活原路径
- [x] 5. `devices/fetch.ts` 的 `fetchFor` local 分支：激活时同样受校验
- [x] 6. 三个 MCP 工具（`read_url` / `stream_fetch_url` / `video_resolve`）与 `/api/media/from-url`、`/api/enrich?source=link` 包作用域、接住拒绝错误
- [x] 7. 配置接线：`AppConfig.caller_fetch_guard`、装配期解析、`config.example.yaml` 注释样例

## 计划 2：测试（解析注入，不碰外网）

- [x] 1. 地址类逐条：回环 v4/v6、10/8、172.16/12、192.168/16、169.254/16、fe80::/10、100.64/10、fc00::/7、0.0.0.0/8、::、IPv4 映射；公网放行；非 http/https 拒绝
- [x] 2. rebinding：同一主机名第一次解析公网、第二次内网 → 被拒（第二次才是要连的那次）
- [x] 3. 重定向：公网主机 302 → 127.0.0.1 被拒（本机监听套接字 + 注入解析）
- [x] 4. 开关关闭：`read_url` / `fetchUrl` / `fetchFor` 对内网 URL 的行为与现在一致（现有主机名级闸照旧、不带 dispatcher）
- [x] 5. 范围不扩大：开关打开且不进作用域时，`fetchFor`（订阅源/适配器走的口）访问 127.0.0.1 照常成功；RSSHub 桥独立请求栈不受影响（结构断言 + 现有测试不回归）
- [x] 6. 例外名单：名单内主机名/网段经 `read_url` 路径放行（打本机套接字），名单外同类地址被拒

## 计划 3：验证与交付

- [x] 1. `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run src/net src/adapters/safe-fetch.test.ts src/devices/fetch.test.ts src/http/fetch-url.test.ts`（及相关面）全绿
- [x] 2. `node_modules/.bin/tsc --noEmit -p .` 干净（javis 上 9 文件 18 用例的 ffmpeg / optional-package.e2e 环境性失败不计）
- [x] 3. rebase 到 origin/main，conventional 提交（英文标题，交付报告在提交说明），push，main 线性
