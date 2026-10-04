import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Radix 必须只有一份实例——两份就是整页 `pointer-events: none` 卡死。
 *
 * Radix 的"点外面关掉"那层（DismissableLayer）用**模块级**变量记账：开第一层时把
 * `document.body.style.pointerEvents` 存进模块变量、设成 `none`，关最后一层时再还原。
 * 同一个 npm 包被加载成两份 → 两本账 → B 层持锁期间 A 层把 `none` 记成"原值"，A 关掉时还原成
 * `none`，body 就永远不可点了。**没有任何报错，主线程也正常**，表现只有"页面点不动"。
 *
 * 这里守住两条会造出第二份实例的路：
 *
 * 1. `app/src` 一律走 `radix-ui` 元包，不许 import 独立的 `@radix-ui/react-*`。独立包有两种
 *    翻车方式：**没声明**时 pnpm 严格布局下它不在 `app/node_modules` 里，而 Node 会继续往上层
 *    目录找，解析逃到仓库根、捡到另一代 radix；**声明了**也只是把炸弹推后——元包对同族依赖钉的是
 *    精确版本，app 这边写的是 caret，两边现在碰巧对齐，发个 patch 版本就分家。
 * 2. 仓库根的 `package.json` 不许出现 `@radix-ui/*`。后端没有 UI，这里放一个前端包唯一的作用
 *    就是给上面那条逃逸路准备好一个落点。
 *
 * 真事（2026-07-30）：`@radix-ui/react-dropdown-menu@^2.1.18` 写在了**后端**的 package.json 里，
 * app 的两个 dropdown-menu 组件 import 它却没声明，于是解析逃到后端仓，拿到 2.1.18 那一代自带的
 * `react-dismissable-layer@1.1.13`；app 自己所有其它 radix 组件用的是 `1.1.19`。两份实例、两本账，
 * 音乐页开关几次菜单后整页点不动。上游 acrylic-ui 已同步改成元包（registry 22 个组件），所以
 * vendored 组件下次同步不会把独立包带回来。
 */

const REPO = new URL('..', import.meta.url).pathname

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => join(dir, f))
}

/** 源码里所有裸 `@radix-ui/<pkg>` import 说明符（去掉子路径）。 */
function radixImports(dir: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of tsFilesUnder(dir)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/from\s+['"](@radix-ui\/[a-z0-9-]+)/g)) {
      const pkg = m[1]!
      found.set(pkg, [...(found.get(pkg) ?? []), file.slice(REPO.length)])
    }
  }
  return found
}

function deps(pkgJsonPath: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return { ...pkg.dependencies, ...pkg.devDependencies }
}

describe('radix 单实例', () => {
  it('app/src 一律 import `radix-ui` 元包，不许出现独立的 @radix-ui/react-*', () => {
    const offenders = [...radixImports(join(REPO, 'app/src'))].map(
      ([pkg, files]) => `${pkg}  ←  ${files.join(', ')}`
    )
    expect(offenders).toEqual([])
  })

  it('app/package.json 也不再声明独立的 @radix-ui/*（声明了就等着版本漂移把它劈成两份）', () => {
    const strays = Object.keys(deps(join(REPO, 'app/package.json'))).filter((d) =>
      d.startsWith('@radix-ui/')
    )
    expect(strays).toEqual([])
  })

  it('仓库根的 package.json 不含 @radix-ui/*（后端没有 UI，放这儿只会当逃逸落点）', () => {
    const strays = Object.keys(deps(join(REPO, 'package.json'))).filter((d) => d.startsWith('@radix-ui/'))
    expect(strays).toEqual([])
  })
})
