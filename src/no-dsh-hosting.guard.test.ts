/**
 * spec 2026-09-05 §2 的不变量的牙：Stream 后端不装、不起、不代理任何对话宿主，仓库里不出现
 * DSH 的版本号。这类回归**不会报错**——把 spawn 塞回来的那一天，一切测试照样绿。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './http/build-identity.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|mts|cts|mjs|js)$/.test(name) && !name.includes('.guard.test.')) out.push(p)
  }
  return out
}

const BANNED: Array<[RegExp, string]> = [
  [/DSH_VERSION/, '仓库里不出现 DSH 的版本号——升到哪个版本是用户的事'],
  [/dsh-engine-lock/, '没有要装的引擎，就没有引擎的 lockfile'],
  [/spawn\w*\((?:[^)]*['"`])dsh/, '后端不起 dsh——要起就在启动器里起（spec §2.1）'],
  [/\/api\/dsh\//, '托管面的三条路由已拆'],
]

describe('Stream 不托管 DSH', () => {
  const files = walk(join(repoRoot, 'src'))
  it.each(BANNED)('src/ 里没有 %s', (re, why) => {
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')))
    expect(hits, why).toEqual([])
  })
})
