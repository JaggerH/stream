// 这个包里唯一的代码，只为回答一个问题：**解出来的这份扩展，目录在哪。**
//
// 两个消费者（Stream 后端 `shared/browser-relay/extension-dir.ts` 第二档、能力包
// `capabilities/desktop/`）今天都不 import 它——它们从 `resolvePkg('.../package.json')`
// 取包根再拼 `chrome-mv3`，因为它们要的是一个**路径**，不是一次模块装载。留着 `main`
// 是为了让 `require.resolve('@streamapp/chrome-extension')` 这种最朴素的写法也不报错：
// 一个没有入口的包在 CJS 侧解析会直接抛，而抛出的原因（"包里没有入口"）和真正的失败
// （"包没装上"）长得一模一样。
//
// 用 `fileURLToPath` 而不是 `new URL(...).pathname`：后者在 Windows 上回的是
// `/C:/Users/...`（多一个前导斜杠、`%20` 还没解码），拿去 `fs` 或递给 Chrome 都不认——
// 而这个包的唯一用户就是 Windows 上装扩展的那个人。
import { fileURLToPath } from 'node:url'

export const dir = fileURLToPath(new URL('./chrome-mv3/', import.meta.url))
