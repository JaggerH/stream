/**
 * 「这一次工具调用是谁发起的」——`stream.tools.call(name, args, { caller })` 的那个 `caller`，挂在
 * AsyncLocalStorage 上跨 await 传播，调用期间建出来的运行记录（`agent-runs.db`）据此落 `caller` 列。
 *
 * 为什么不按参数透传：一次工具调用到建 run 记录之间隔着 catalog → extras → 域服务三四层，每层的签名
 * 都是给模型 / HTTP 面定的，为一个追溯字段全改一遍不值。它与 `devices/run-context.ts` 同类——值按**调用**
 * 走、不按实例走，所以不违反 D6（实例状态不进隐式上下文）。没有上下文 = 不记（MCP 端点今天就是这样）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<string>()

export function runWithToolCaller<T>(caller: string | undefined, fn: () => T): T {
  return caller ? store.run(caller, fn) : fn()
}

export function currentToolCaller(): string | undefined {
  return store.getStore()
}
