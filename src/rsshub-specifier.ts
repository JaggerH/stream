import { pathToFileURL } from 'node:url'

/**
 * 「这个东西能不能直接喂给动态 `import()`」——不能就转成 `file://` URL。
 *
 * **Windows 上不转就 100% 失败**：绝对路径 `C:\…\pkg.mjs` 会被 ESM loader 当成协议 `c:` 拒掉，
 * `Only URLs with a scheme in: file, data, and node are supported … Received protocol 'c:'`。
 * 活体撞到过（2026-09-04，win-test 上第一次跑按需装的 RSSHub）：RSSHub 装是装上了、用户等了
 * 整整两分钟，换回来一句读不懂的 `not_found`。**Linux 上永远不会现**——那儿的绝对路径以 `/`
 * 开头，没有盘符，所以本机怎么跑都是绿的。
 *
 * 已经是 URL 的原样放过（`import.meta.resolve` 返回的就是 `file://…`）。判据要能分清
 * 「scheme」和「盘符」：`C:\…` 和 `c:/…` 长得就像一个 scheme 是 `c` 的 URL。
 */
export function toImportSpecifier(p: string): string {
  const looksLikeWindowsDrive = /^[a-z]:[\\/]/i.test(p)
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(p)
  return hasScheme && !looksLikeWindowsDrive ? p : pathToFileURL(p).href
}
