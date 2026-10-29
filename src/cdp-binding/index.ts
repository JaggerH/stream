/**
 * 公共入口：用 CDP 驱动一台没有装扩展的浏览器，对外讲扩展中继的同一套协议。
 *
 * 给嵌入方在测试里直接起一份（`startCdpBinding()` → `close()`），也供 `stream cdp-bind`
 * 这条命令用。它**不读环境变量、不注册进程信号**——那些是进程入口的事（见
 * `src/install/cdp-bind-command.ts`），与 `createStream()` 同一条规矩。
 */
export { startCdpBinding } from './binding.ts'
export type { CdpBinding, CdpBindingOptions } from './binding.ts'
