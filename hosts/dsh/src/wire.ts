/**
 * 两半之间那条**唯一**的配置线：host 半把 Stream 后端地址写进页面，浏览器半读它。
 *
 * 为什么需要这条线（三条路只有它成立，别再改回去）：
 *
 * 1. **行 config 直达浏览器 —— 不成立。** DSH 的客户端插件表是宿主 `dsh-client-modules`
 *    合成的 `window.__DSH_BOOT__`，一行只有 `{ id, url, rev, inject?, immediately? }`
 *    （`graphRow()`），浏览器那侧 `AppWebEntry.runPluginBoot` 又只用
 *    `loader.create({ name })` 建条目——**config 这个字段在浏览器半根本不存在**，
 *    所以客户端 `apply` 的签名全都是 `apply(ctx)` 一个参数。
 * 2. **兜底让插件自己发现 —— 方向就是错的。** 页面的 origin 是 DSH 的工作台口，不是
 *    Stream 后端；从页面上推不出后端在哪，猜出来的地址只会是个假装能用的死链。
 * 3. **host 半拿 config 再送给浏览器半 —— 成立，就是这条。** host 半跑在 DSH 引擎里，
 *    cordis 照常把行 config 作为 `apply(ctx, config)` 的第二个参数给它；`webServer`
 *    服务的 `tapIndex()` 是公开面（宿主自己的 `dsh-client-modules` 就用它注入
 *    `__DSH_BOOT__`），我们照同一条缝往 `<head>` 里注入一个常量。**同步、先于壳的
 *    任何脚本执行**，浏览器半开局第一拍就读得到，不用等一次 fetch。
 */

/** 页面上那个全局的名字（host 写、client 读，两边都从这里取，别各写各的字符串）。 */
export const STREAM_UI_GLOBAL = '__STREAM_UI__'

/** 注入页面的那份常量的形状。 */
export interface StreamUiWire {
  /** Stream 后端那扇门的绝对地址，如 `http://127.0.0.1:8900`，**不带尾斜杠**。 */
  backendUrl: string
}

/**
 * 归一化一个后端基址：非字符串 / 空串 / 不是 http(s) 绝对地址 → `undefined`。
 *
 * 宁可判成"没配"也不接受一个半截地址：接下来这个值要去拼 `<script src>` 和深链，
 * 一个畸形地址换来的是一堆没有出处的 404，而"没配"这条路上我们有一句人话。
 * @param raw - 行 config 里那个值（来源不可信，可能是用户手改的 patch）。
 * @returns 去掉尾斜杠的基址，或 `undefined`。
 */
export function normalizeBackendUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '') return undefined
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return undefined
  return trimmed
}
