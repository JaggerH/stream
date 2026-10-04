// @vitest-environment node
// ↑ 只读源码文本、不碰 DOM。jsdom 档里 `import.meta.url` 不是 file: URL（它是那个假页面的
//   地址），`fileURLToPath` 会当场抛 "The URL must be of scheme file"。
/**
 * 导航归面板之后守住的那条边界：**面板不认识 DSH**。
 *
 * 树是从 DSH 壳搬过来的，搬的时候每个 DSH 部件都换成了就地渲染的原生件、每个 `--dsw-*`
 * 都换成了自己的 `--stream-nav-*` token。这两条都**不会有任何构建期检查替你盯着**：
 *
 * - `import … from '@deepseek-ai/…'`：面板是独立 IIFE bundle，DSH 宿主里恰好有那个包，所以
 *   在 DSH 里跑起来一切正常；而 8900 那扇独立正门里它根本不存在——表现是整份 bundle 加载即
 *   炸，页面全白。写的人只在 DSH 里验过就完全看不见。
 * - `var(--dsw-…)`：在 DSH 里解析得到，在独立正门里解析不到就**静默回落到无值**——不是报错，
 *   是那一处颜色没了（文字透明、边框消失）。比上一条更难发现。
 *
 * 所以这两条只能靠一条读源码的测试钉住。两条断言都做过探针验证（各塞一处确认变红再删掉）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** `app/src` 的绝对路径（从本文件推，不用 `process.cwd()`——多 worktree 并行时 cwd 会漂）。 */
const SRC = fileURLToPath(new URL('../../', import.meta.url))

/** 本文件在 `app/src` 下的相对路径（扫描时跳过自己，见下面第一条断言）。 */
const SELF = 'panel/nav/nav-boundary.guard.test.ts'

/** `app/src` 下全部 `.ts` / `.tsx`（相对 SRC 的路径）。 */
function sources(dir = SRC, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...sources(abs, `${prefix}${name}/`))
    else if (/\.tsx?$/.test(name)) out.push(`${prefix}${name}`)
  }
  return out
}

describe('面板的 DSH 边界', () => {
  it('app/src 里没有任何一处 import @deepseek-ai/*——那个包只在 DSH 宿主里存在', () => {
    // 本文件自己不算：它非得把这个形状写出来不可（上面注释里就有一份）。
    const files = sources().filter((rel) => rel !== SELF)
    // 名单本身别悄悄变空：走错目录时下面那条断言会以 0 个文件"通过"。
    expect(files.length).toBeGreaterThan(100)
    const offenders = files.filter((rel) =>
      // import / export … from '@deepseek-ai/…' 与 import('@deepseek-ai/…') 两种形态都算。
      /(?:from|import)\s*\(?\s*['"]@deepseek-ai\//.test(readFileSync(join(SRC, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  // 只查那段 CSS，不查注释：头注里**必须**说得清这些默认值是从哪抄来的（`--dsw-alias-*`
  // 解析到 `--dsw-static-*` 的实测数值），把散文一并禁掉只会逼人把出处删掉——那才是真损失。
  // 会静默出事的只有真进了样式表的那一份。
  it('nav-styles.ts 的样式里没有 --dsw- / --dsh- 变量——配色只走自己那组 token', () => {
    const src = readFileSync(join(SRC, 'panel/nav/nav-styles.ts'), 'utf8')
    const css = /const CSS = `([\s\S]*?)`\n/.exec(src)
    if (css === null) throw new Error('nav-styles.ts 里找不到 `const CSS = \\`…\\`` —— 样式换地方了')
    expect(css[1]).not.toMatch(/--ds[wh]-/)
  })
})
