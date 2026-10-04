import { createHash } from 'node:crypto'
import type { Scene } from '../replay/scene.ts'

/**
 * 段与段、项与项之间的分隔符：不分隔的话「path 的尾巴 + 第一条 truth」能和另一组材料拼出同一串。
 * 不能用空格——元素名和 `text:` 特征键本身经常带空格，`['登录','注册']` join 出来的
 * `"登录 注册"` 会和单个元素名 `'登录 注册'` 的结果完全相同，缓存就会拿错界面的答案往这边套。
 * 用 ASCII unit separator（`\x1f`）：控制字符，正常文本/元素名不会含它。
 */
const SEP = '\x1f'

/**
 * 现场指纹（spec §4.3）：同源同上下文再落空时先查库、指纹一致才复用。
 * 材料：url 的 origin+pathname（query 会变）、此刻为真的特征键（排序）、元素名集合（排序、去重）。
 * **不用截图哈希**——一个像素动就 miss，等于没有缓存。漂了当 miss 重新问，不硬用。
 */
export function sceneFingerprint(scene: Scene | undefined, truths: string[]): string {
  let path = ''
  if (scene?.url) {
    // 解析不了（相对路径、自造 scheme）就原样用整串——比把这一维丢掉强。
    try {
      const u = new URL(scene.url)
      path = `${u.origin}${u.pathname}`
    } catch {
      path = scene.url
    }
  }
  const names = [...new Set((scene?.elements ?? []).map((e) => e.name).filter((n): n is string => !!n))].sort()
  const h = createHash('sha256')
  h.update([path, [...truths].sort().join(SEP), names.join(SEP)].join(SEP))
  // 截 16 位十六进制（64 bit）：这是缓存键不是安全摘要，够避免偶然撞车，且轨迹里读得下去。
  return h.digest('hex').slice(0, 16)
}

/** 缓存键：同一个来源、同一种问题、同一个现场，三样都对上才算一次命中。 */
export function cacheKey(sourceId: string, kind: string, fp: string): string {
  return `${sourceId}|${kind}|${fp}`
}
