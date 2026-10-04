// src/packages/self-contained.guard.test.ts
//
// 守的是 spec 2026-09-20-code-packages-prebuilt-dist §2.1 的不变量：**包只靠三样东西——类型、`shared/`、`ctx`**。
// 带代码的内置包被 tsdown 打成自包含的 `dist/index.js` 发 npm；`activate.ts` 可达图里任何一条**非类型**的
// 宿主 `src/` import 都会被 inline 进那份 bundle，而这两种复制都是静默故障：
//   - 复制**类**（`ValidationError`）：包抛的实例 `instanceof` 宿主那份恒 false → 400 全变 502，没有一处会喊；
//   - 复制**单例**（`plugin-target.ts` 的 resolver 表、`dash.ts` 的分片信任表）：包登记进第二份表，
//     宿主路由查的是第一份 → 永远为空 → 分片恒 400 / 容器地址恒解析不到。
//
// 判据（与 tsdown 的取舍一致）：
//   - `import type` / `export type` / 花括号里每一项都带 `type` 前缀 → **放行**。类型编译期抹掉，dist 里没有它，
//     所以包可以照旧 `import type { Adapter } from '../../src/adapters/types.ts'`。
//   - 混合 import（`{ ValidationError, type Enricher }`）算**运行时** import——`ValidationError` 那一项会真进 bundle。
//   - 只从 `activate.ts` 起沿相对 import 走（包目录内、以及 `shared/`——`shared/` 是允许的去处，但它自己若再
//     运行时 import `src/` 同样会被 inline，所以也跟进去看）；裸包名（npm 依赖）不跟。
//   - **`provision.ts` 不在图里**（alist）：它是宿主 `src/kernel/plugins/packages.ts` 直接 import 的"接管内置
//     AList 容器"编排，方向是宿主够进包、不是包够进宿主，`activate.ts` 不 import 它 → dist 里没有它 → 不扫。
//     同理测试文件、README 都不在图里。
//
// `KNOWN_RED`：还没清完的包。守卫对它们断言**红**（hits > 0），清完一个就从名单里摘掉——名单不许只增不减：
// 一个包清干净之后名单没摘，这条会红（"该绿了却还在 KNOWN_RED"），逼着人把名单收紧。
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SRC_DIR = join(REPO, 'src') + sep
const PACKAGES_DIR = join(REPO, 'packages')

/** 带 `stream.code` 的内置包（spec §0 的 7 个 + 后来归包的 xueqiu / telegram / firecrawl）。 */
export const CODE_PACKAGES = [
  'bilibili', 'Douyin_TikTok_Download_API', 'xhs', 'netease', 'pansou', 'eastmoney', 'alist',
  'xueqiu', 'telegram', 'firecrawl', 'hackernews', 'v2ex',
  // 第八 / 九批从宿主搬出来的厂商客户端包（发 npm，dist 必须自包含）
  'cloudflare', 'xunlei', 'shooter', 'omdb',
] as const

/** 还在清的包。上面的包已全部自包含，所以是空集；下次有包又红了，先把它加回这里再清（名单不许只增不减）。 */
const KNOWN_RED = new Set<string>([])

export interface SrcImportHit {
  /** 相对 repo 根的文件路径 */
  file: string
  line: number
  specifier: string
  /** 解析后相对 repo 根的目标 */
  target: string
}

/** 一条 import / export-from 语句：整段源文本、所在行、from 后的说明符、是不是类型专属。 */
interface ImportStmt { line: number; specifier: string; typeOnly: boolean }

/**
 * 只认行首的 `import` / `export … from`（多行花括号也吃得下）。行首锚定是为了放过注释里当散文引用的
 * import 片段（本仓注释行以 ` * ` / `//` 开头，不会命中）。
 * 子句里排除引号与分号：否则副作用 `import './x.ts'` 会被懒匹配一路吞到下一条语句的 `from`。
 *
 * 第三、四支是**动态** `import('…')` 与 `require('…')`——它们不在行首（多半在表达式里），所以不锚定；
 * 只认字面量说明符（变量拼出来的路径这道闸看不见，也没有别的静态办法看见）。落在注释行里的
 * （行首 `//` / `*` / `/*`）由 parseImports 剔掉，理由同行首锚定：注释里当散文引用的不算。
 */
const STMT_RE = /^[ \t]*(import|export)\b([^'"`;]*?)\bfrom\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

export function parseImports(source: string): ImportStmt[] {
  const out: ImportStmt[] = []
  for (const m of source.matchAll(STMT_RE)) {
    const before = source.slice(0, m.index)
    const line = before.split('\n').length
    if (m[4] !== undefined) { out.push({ line, specifier: m[4], typeOnly: false }); continue }
    const dynamic = m[5] ?? m[6]
    if (dynamic !== undefined) {
      const linePrefix = before.slice(before.lastIndexOf('\n') + 1)
      if (/^\s*(\/\/|\*|\/\*)/.test(linePrefix)) continue
      out.push({ line, specifier: dynamic, typeOnly: false })
      continue
    }
    const clause = m[2].trim()
    out.push({ line, specifier: m[3], typeOnly: isTypeOnlyClause(clause) })
  }
  return out
}

function isTypeOnlyClause(clause: string): boolean {
  if (/^type\b/.test(clause)) return true // `import type {…}` / `import type X` / `export type {…}`
  const braces = /^\{([\s\S]*)\}$/.exec(clause)
  if (!braces) return false // 默认导入、`* as ns`、`export * from` → 运行时
  const specs = braces[1].split(',').map(s => s.trim()).filter(Boolean)
  return specs.length > 0 && specs.every(s => /^type\b/.test(s))
}

/** 相对说明符 → 磁盘上的 .ts 文件；解析不到（.json / 目录无 index）回 undefined。 */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return undefined
}

/** 从 `packages/<pkg>/activate.ts` 起走静态 import 图，收集每一条落进 `src/` 的运行时 import。 */
export function scanPackage(pkg: string): SrcImportHit[] {
  const entry = join(PACKAGES_DIR, pkg, 'activate.ts')
  const hits: SrcImportHit[] = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const stmt of parseImports(source)) {
      if (stmt.typeOnly) continue
      if (!stmt.specifier.startsWith('.')) continue // 裸包名：npm 依赖，不归这道闸
      const target = resolveRelative(file, stmt.specifier)
      const targetPath = target ?? resolve(dirname(file), stmt.specifier)
      if (targetPath.startsWith(SRC_DIR)) {
        hits.push({
          file: relative(REPO, file), line: stmt.line, specifier: stmt.specifier, target: relative(REPO, targetPath),
        })
        continue // 不跟进 src/：那边的图是宿主的事，报出这一条就够了
      }
      if (target) queue.push(target)
    }
  }
  return hits
}

function render(hits: SrcImportHit[]): string {
  return hits.map(h => `  ${h.file}:${h.line} → ${h.target}  (${h.specifier})`).join('\n')
}

describe('parseImports：类型 import 放行、混合 import 算运行时', () => {
  it('import type / export type / 全 type 花括号 → typeOnly', () => {
    const src = [
      "import type { A } from './a.ts'",
      "import type B from './b.ts'",
      "export type { C } from './c.ts'",
      "import { type D, type E } from './d.ts'",
      'import type {',
      '  F, G,',
      "} from './f.ts'",
    ].join('\n')
    expect(parseImports(src).map(s => s.typeOnly)).toEqual([true, true, true, true, true])
  })
  it('混合 / 默认 / 命名空间 / 副作用 / export * → 运行时', () => {
    const src = [
      "import { X, type Y } from './x.ts'",
      "import Z from './z.ts'",
      "import * as ns from './ns.ts'",
      "import './side.ts'",
      "export * from './all.ts'",
      "export { W } from './w.ts'",
      'import {',
      '  P, Q,',
      "} from './pq.ts'",
    ].join('\n')
    const parsed = parseImports(src)
    expect(parsed.map(s => s.typeOnly)).toEqual([false, false, false, false, false, false, false])
    expect(parsed.map(s => s.line)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parsed[3].specifier).toBe('./side.ts')
  })
  it('注释里当散文引用的 import 不算', () => {
    const src = [
      '/**',
      " * 别再写 import { X } from '../../src/x.ts'——那会进 bundle。",
      ' */',
      "// import { Y } from '../../src/y.ts'",
      "import type { Z } from '../../src/z.ts'",
    ].join('\n')
    expect(parseImports(src)).toHaveLength(1)
  })
  it("动态 import('…') 算运行时——表达式里、带空格、带 await 都吃；注释里的不算", () => {
    const src = [
      "const m = await import('../../src/lazy.ts')",
      'export async function load() {',
      "  return import( \"./local.ts\" )",
      '}',
      "// const n = await import('../../src/nope.ts')",
    ].join('\n')
    const parsed = parseImports(src)
    expect(parsed.map(s => [s.line, s.specifier, s.typeOnly])).toEqual([
      [1, '../../src/lazy.ts', false],
      [3, './local.ts', false],
    ])
  })
  it("require('…') 算运行时——createRequire 那条路也不能绕过这道闸", () => {
    const src = [
      "const { X } = require('../../src/x.ts')",
      "const y = require( './y.ts' )",
      " * 注释里的 require('../../src/z.ts') 不算",
    ].join('\n')
    expect(parseImports(src).map(s => s.specifier)).toEqual(['../../src/x.ts', './y.ts'])
  })
})

describe('带代码的内置包自包含：activate.ts 可达图里没有非类型的 src/ import', () => {
  it('KNOWN_RED 只含 CODE_PACKAGES 里的名字', () => {
    for (const name of KNOWN_RED) expect(CODE_PACKAGES).toContain(name)
  })

  it.each(CODE_PACKAGES)('%s', (pkg) => {
    const hits = scanPackage(pkg)
    if (KNOWN_RED.has(pkg)) {
      // 还在清的包：断言它**确实**还红。清干净了这条会红，提醒把它从 KNOWN_RED 摘掉。
      expect(hits.length, `${pkg} 已经没有 src/ 运行时 import 了——把它从 KNOWN_RED 摘掉`).toBeGreaterThan(0)
      return
    }
    expect(hits, `${pkg} 的 activate 可达图里有运行时 src/ import（会被 inline 进 dist）：\n${render(hits)}`).toEqual([])
  })
})
