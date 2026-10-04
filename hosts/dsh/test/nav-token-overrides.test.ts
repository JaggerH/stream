// @vitest-environment node
// ↑ 这个文件只读源码文本、不碰 DOM。jsdom 档里 `import.meta.url` 不是 file: URL
//   （它是那个假页面的地址），`fileURLToPath` 会当场抛 "The URL must be of scheme file"。
/**
 * 导航配色的对账表：面板那组 `--stream-nav-*` token，DSH 这边**每一格都得指到自己的变量**。
 *
 * 为什么要一条测试盯着：漏一格不报错、不降级——那一格静默用回面板自带的默认值（一个抄自
 * DSH 主题包的固定 rgb）。表现是暗色工作台里某个颜色"差一点点"，没有任何一处会喊，而
 * 判断它对不对要靠肉眼比色。面板那边加一格 token（新浮层、新状态色）时，这条会当场变红。
 *
 * 名单的真相源是**面板自己那份 `nav-styles.ts` 的 `:root` 段**（默认值定义处），这里直接
 * 读它的源码解析，不另抄一份——抄一份就是第二个真相源，漂移了同样没人喊。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { NAV_TOKEN_OVERRIDES } from '../src/client/shell/StreamShell.tsx'

/** 面板里 token 默认值的定义处（本仓库内的相对路径；两个包不共享代码，只共享这份名单）。 */
const NAV_STYLES = fileURLToPath(new URL('../../../app/src/panel/nav/nav-styles.ts', import.meta.url))

/** `nav-styles.ts` 的 `:root{…}` 段里声明的全部 `--stream-nav-*`。 */
function tokensDeclaredByPanel(): string[] {
  const src = readFileSync(NAV_STYLES, 'utf8')
  const root = /:root\{([^}]*)\}/.exec(src)
  if (root === null) throw new Error('nav-styles.ts 里找不到 :root 段——名单的真相源换地方了')
  return [...root[1]!.matchAll(/(--stream-nav-[a-z-]+)\s*:/g)].map((m) => m[1]!)
}

test('面板声明的每一个 --stream-nav-* token，DSH 侧都给了覆盖值', () => {
  expect([...Object.keys(NAV_TOKEN_OVERRIDES)].sort()).toEqual(tokensDeclaredByPanel().sort())
})

// 覆盖值必须**指向 DSH 自己的变量**（`var(--dsw-…)` / `var(--dsh-…)`）而不是一个写死的
// 颜色：写死的那一格不跟宿主换肤，暗色下就是一块亮片。
test('每个覆盖值都是 DSH 的变量引用，不是写死的颜色', () => {
  for (const [token, value] of Object.entries(NAV_TOKEN_OVERRIDES)) {
    expect(value, token).toMatch(/^var\(--ds[wh]?-/)
  }
})
