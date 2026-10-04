// @vitest-environment node
// ↑ 必须写在文件最前面，且必须是 node 不能吃 app/ 默认的 jsdom：jsdom 的 TextEncoder 产出的
//   不是真 Uint8Array，esbuild 启动时那条不变量检查会直接抛
//   「your JavaScript environment is broken」，测试连收集都进不去。
/**
 * 面板样式的**构建产物**守卫：主题 token 必须能在子树里换档。
 *
 * **为什么这条测试必须跑真构建、不能是普通单测**：jsdom 根本不解析自定义属性
 * （`getComputedStyle().getPropertyValue('--x')` 永远回空串），所以"面板在暗色宿主里
 * 渲染成亮底亮字"这类缺陷，在这个仓库现有的任何 jsdom 测试里都是全绿的。唯一能看见它的
 * 地方是编译出来的 CSS 本身——工具类到底写成了 `var(--foreground)` 还是
 * `var(--color-foreground)`。
 *
 * **它钉的那条不变量**：自定义属性在**声明它的元素上**求值一次，后代继承的是算完的结果。
 * `--color-*` 那层间接只在 `:root` 上声明，于是它在 `<html>` 上就被钉死了；面板挂在自己
 * 根上的 `.dark`（`hostTheme.ts`）改的是 `--foreground`，改不动已经算完的
 * `--color-foreground`。`entry.css` 的 `@theme inline` 就是为了让工具类跳过这层间接。
 * 把 `inline` 去掉，下面第二条断言会当场变红。
 */
import { describe, it, expect } from 'vitest'
import { build } from 'vite'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// 路径一律从本模块自己的位置推，不信 cwd：多 worktree 并行时 shell 的 cwd 会漂到别人那棵树。
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 跑一次真的面板构建（主入口），把编译出来的 panel.css 读回来。 */
async function buildPanelCss(): Promise<string> {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'panel-css-guard-'))
  try {
    await build({
      configFile: path.join(appRoot, 'vite.panel.config.ts'),
      root: appRoot,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
    return await readFile(path.join(outDir, 'panel.css'), 'utf8')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

/** 从 entry.css 的 `@theme` 块里抠出所有 `--color-*` token 名。名单变长时守卫自动跟着变宽。 */
async function themeColorTokens(): Promise<string[]> {
  const css = await readFile(path.join(appRoot, 'src/entry.css'), 'utf8')
  const block = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css)
  expect(block, '在 entry.css 里没找到 @theme 块').not.toBeNull()
  return [...block![1].matchAll(/^\s*(--color-[\w-]+)\s*:/gm)].map((m) => m[1])
}

describe('panel.css 构建产物', () => {
  it('工具类引的是可换档的底层 token，不是 :root 上算死的 --color-* 间接层', async () => {
    const css = await buildPanelCss()
    const tokens = await themeColorTokens()
    expect(tokens.length).toBeGreaterThan(10) // 名单被清空的话下面的断言会假绿

    // 1) 具体一条，读起来最直白：text-foreground 必须落到 var(--foreground)。
    const textForeground = /\.text-foreground[,{][^}]*?\{([^}]*)\}/.exec(css)
    expect(textForeground, '产物里没有 .text-foreground 规则').not.toBeNull()
    expect(textForeground![1]).toContain('var(--foreground)')

    // 2) 全名单：产物里不许有任何一处 `var(--color-X)` 引用。
    //    这一条覆盖以后新加的 token，也覆盖组件里手写的 arbitrary value
    //    （曾经 shimmer.tsx 就手写过 var(--color-background)）。
    const leaked = tokens.filter((t) => css.includes(`var(${t})`))
    expect(leaked, `这些 token 仍走 :root 上算死的间接层，面板子树里换不动：${leaked.join(', ')}`)
      .toEqual([])

    // 3) 反向自证：`.dark` 里确实重定义了底层 token，否则前两条可以空转着变绿。
    const darkBlock = /\.dark\{([^}]*)\}/.exec(css)
    expect(darkBlock, '产物里没有 .dark 块').not.toBeNull()
    expect(darkBlock![1]).toMatch(/--foreground:/)
  }, 180_000)
})
