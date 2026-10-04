/**
 * 测试替身：`@deepseek-ai/dsh-api-session-controller/client` 的**运行时**那一份。
 *
 * 为什么需要它：这个包发布的 `lib/client.js` 不是普通 ESM，是一段
 * `window.__ModuleLoader__.load({...})`——只有 DSH 那个页面装载器能吃。浏览器里真跑的时候
 * 由装载器提供（我们的产物里是 `require("@deepseek-ai/dsh-api-session-controller/client")`，
 * 和 DSH 自己那些客户端包逐字同形），但在 vitest 里 import 它会当场炸
 * （`Cannot read properties of undefined (reading 'load')`）。
 *
 * 所以这里只补我们**真正用到的那个值**（`createScope`）。类型仍从真包取（`import type`
 * 走 .d.ts，不碰这段 IIFE），所以签名漂了编译期还是会红。
 */

/** 铸一个带 session tag 的 scope。替身版：只把 key 记在 ctx 上，够测试断言用。 */
export function createScope(ctx: unknown, key: string): { ctx: unknown; fiber: { dispose: () => void } } {
  return {
    ctx: Object.create(ctx as object, { __scopeKey: { value: key, enumerable: true } }),
    fiber: { dispose: () => {} },
  }
}
