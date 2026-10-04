import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../http/build-identity.ts'

/**
 * 判定这一层(证据图引擎 + 规划器)只吃抽象文件条目,不认识任何 I/O(spec 2026-09-03 §3.6)。
 * 今天已成立;钉住是为了抽包时不退步——一旦引擎 import 了 OpenList 客户端,"匹配是通用能力"就是空话。
 * 匹配同时抓 `from '...'`/`from "..."`静态 import 和 `import('...')`/`import("...")`动态 import——
 * 只认单引号 `from` 会被双引号或动态 import 绕过,而绕过的形状恰恰是最容易在重构里悄悄写出来的那种。
 */
const FORBIDDEN = [/openlist-client/, /alist-client/, /node:fs/, /better-sqlite3/, /node:child_process/]
const files = [
  ...readdirSync(join(repoRoot, 'src/netdisk/match-engine')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => `src/netdisk/match-engine/${f}`),
  'src/netdisk/reconcile/plan.ts',
  'src/netdisk/match-spec.ts',
]

describe('引擎边界', () => {
  it.each(files)('%s 不 import I/O', (rel) => {
    const src = readFileSync(join(repoRoot, rel), 'utf8')
    const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    const bad = imports.filter((i) => FORBIDDEN.some((re) => re.test(i)))
    expect(bad).toEqual([])
  })
})
