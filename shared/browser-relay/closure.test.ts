import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 这个库的不变量：**它的运行时 import 闭包里不许出现 `src/` 下的模块。**
 *
 * 为什么需要它：`shared/browser-relay/` 存在的全部理由是「未来的 DSH 插件能在自己的进程里
 * import 同一份中继」。而加一条 `../../src/xxx.ts` 的 import 既不会让 tsc 报错、也不会让任何
 * 测试变红——它的代价要到写插件包、`npm install` 把整条 replay 引擎（含 isolated-vm 原生扩展）
 * 拖进来时才现形，隔着好几周。这条守卫把那个反馈拉回到当场。
 *
 * **判据是「零 src 边」而不是「闭包恰好 N 个模块」**：数字会因为正当地新增文件而变，而人一旦
 * 习惯了把数字调大，守卫就废了。「零 src 边」是不变量，正当的新增不会破坏它。
 *
 * **入口不是单一文件，是这个库的全部模块。** `relay.ts` 只是其中一个入口——`verify.ts`、
 * `interactive-gate.ts`、`page-inventory.ts` 是未来插件会独立 import 的另外几个入口（高危动作
 * 确认闸、`/api/ext/verify` 证明、页面元素清单），它们不经过 `relay.ts`。只从 `relay.ts` 出发
 * 走闭包，会漏掉「有人往这几个文件里加了一条 `src/` import」这类改动——它们今天没有任何 import，
 * 干净只是因为还没人碰，不是因为被守着。所以这里 glob 这个目录下的每个非测试 `*.ts` 文件，各自
 * 当一个入口跑一遍闭包，取并集断言。
 *
 * **只跟 value import，`import type` 不算**：类型在编译期就擦除了，运行时闭包里根本没有它们，
 * 对插件的 bundle 零成本。`relay.ts` 对 `src/debug.ts`(DebugEntry) 与 `src/events/store.ts`
 * (EventInput) 的两条 type-only 边是有意保留的——把类型复制一份到库里反而制造新的漂移源。
 *
 * **`export ... from` 与 `import ... from` 同样是运行时边，必须一起跟。** 本分支自己就三次
 * 引入了「薄壳转出」的写法（`src/failure.ts`、`src/http/secrets.ts`、
 * `src/browser/capability-store.ts` 都是 `export { x } from '...'`）——library 模块里出现同样的
 * `export { classifyError } from '../../src/failure.ts'`，是一条货真价实的运行时依赖，只是语法
 * 长得像"导出"而不是"导入"。同样只擦除 `export type { X } from` 与 `export { type X } from`。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

/** 匹配 `import ... from '...'` 与 `export ... from '...'`（含 `export * from`）。
 *  第 1 组捕获 `type` 关键字（`import type` / `export type`），第 2 组是花括号里的具名子句
 *  （用于判断"全 type"具名导入/导出），第 3 组是模块说明符。 */
const IMPORT_OR_EXPORT_RE =
  /^\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+['"]([^'"]+)['"]/gm

/** 从一个入口出发，跟着 value import / value export-from 走一遍，回收集到的文件绝对路径。 */
function runtimeClosure(entryAbs: string): Set<string> {
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      return
    }
    const re = new RegExp(IMPORT_OR_EXPORT_RE)
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const typeKeyword = m[1]
      const clause = m[2]
      const spec = m[3]
      // `import/export { type A, type B } from` —— 命名项全是 type，同样擦除
      const namedAllType =
        /^\s*\{[^}]*\}\s*$/.test(clause) &&
        clause
          .replace(/[{}]/g, '')
          .split(',')
          .filter((s) => s.trim())
          .every((s) => s.trim().startsWith('type '))
      if (typeKeyword || namedAllType) continue
      if (!spec.startsWith('.')) continue // 裸包名，不是仓内模块
      const base = resolve(dirname(file), spec)
      const hit = [base, base + '.ts', base + '.js', base + '/index.ts'].find((p) => existsSync(p))
      if (hit) visit(hit)
    }
  }
  visit(entryAbs)
  return seen
}

/** 库的全部入口：目录下每个非测试 `.ts` 文件。别只挑 `relay.ts`——见头注。 */
function libraryEntries(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => resolve(HERE, f))
}

describe('shared/browser-relay 的运行时闭包', () => {
  it('每个入口模块的闭包里都不含 src/ 下的模块（否则独立进程 import 不了这个库）', () => {
    const failures: string[] = []
    for (const entry of libraryEntries()) {
      const closure = runtimeClosure(entry)
      const srcEdges = [...closure]
        .map((f) => f.replace(REPO_ROOT + '/', ''))
        .filter((f) => f.startsWith('src/'))
        .sort()
      if (srcEdges.length > 0) {
        const entryName = entry.replace(REPO_ROOT + '/', '')
        failures.push(`${entryName} 拉入了: ${srcEdges.join(', ')}`)
      }
    }
    expect(failures).toEqual([])
  })
})
