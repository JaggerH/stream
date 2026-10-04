// scripts/bundle-code-packages.real.test.ts
//
// **慢**（真跑一次 tsdown，秒级）：对一个带代码的内置包（xhs，一份小而典型的可达图）真出一次
// `dist/index.js`，钉两件事——
//   1. 产物就在 `dist/index.js`（tsdown 的 entry 写成数组会出 `dist/activate.js`，装载器找不到；实测过）；
//   2. 产物里没有任何 import 语句残留：`shared/**` 全部内联、`src/` 只剩类型（被抹掉）。第三方层装到的目录
//      没有 node_modules，一条 `from "../../shared/…"` 就是运行期 `ERR_MODULE_NOT_FOUND`——而 tsdown
//      对此退出 0。
// 另外钉根脚本的判据本身：`packages/*` 里填了 `stream.code` 的恰好是名单里那几个（漏一个 = 那个包发上 npm 后
// `code.entry` 指着一个不存在的文件）。
//
// 找不到 tsdown 时这条**红**而不是跳过：根 devDependency 没装 = `pnpm packages:bundle` 在 CI 里也会
// 失败，跳过等于把"构建链断了"藏起来。
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— .mjs 无类型声明；只借它的两个纯函数
import { codePackageDirs, resolveTsdown } from './bundle-code-packages.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const SCRIPT = join(here, 'bundle-code-packages.mjs')

describe('bundle-code-packages（真构建）', () => {
  it('判据 = package.json#stream.code：恰好十七个包', () => {
    expect((codePackageDirs() as string[]).map((d) => basename(d)).sort()).toEqual(
      ['Douyin_TikTok_Download_API', 'alist', 'bilibili', 'cloudflare', 'eastmoney', 'firecrawl', 'hackernews', 'netease', 'omdb', 'pansou', 'rsshub', 'shooter', 'telegram', 'v2ex', 'xhs', 'xueqiu', 'xunlei'].sort(),
    )
  })

  it('xhs → dist/index.js，独占 dist/，产物里零 import 语句', () => {
    expect(resolveTsdown(), '根 node_modules/.bin/tsdown 不在（或 STREAM_TSDOWN_BIN 没指）——构建链断了').toBeTruthy()
    const pkgDir = join(repoRoot, 'packages', 'xhs')
    execFileSync(process.execPath, [SCRIPT, pkgDir], { stdio: 'pipe', encoding: 'utf8' })

    const out = join(pkgDir, 'dist', 'index.js')
    expect(existsSync(out)).toBe(true)
    expect(readdirSync(join(pkgDir, 'dist'))).toEqual(['index.js'])

    const js = readFileSync(out, 'utf8')
    expect(js.length).toBeGreaterThan(1000)
    // 顶层 import 语句一条都不许有：相对路径（shared/、src/）要内联，node 内建也没被这个包用到；
    // 动态 `import(` 同样算残留。注释里提到 `src/xxx.ts` 不算——只看语句。
    const importStmts = js.split('\n').filter((l) => /^\s*import\s/.test(l) || /\bimport\(/.test(l))
    expect(importStmts, importStmts.join('\n')).toEqual([])
    expect(js).toContain('activate')
  }, 60_000)
})
