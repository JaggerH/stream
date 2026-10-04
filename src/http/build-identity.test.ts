import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readCommit, countChangedSince, repoRoot, shippedRoot } from './build-identity.ts'

describe('build identity — 让活体自己说它跑的是哪一份代码', () => {
  it('readCommit 在真仓库里回一个短 sha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-id-repo-'))
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir })
      writeFileSync(join(dir, 'README.md'), 'fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: dir })
      execFileSync('git', ['-c', 'user.name=build-id-test', '-c', 'user.email=build-id@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: dir })
      expect(readCommit(dir)).toMatch(/^[0-9a-f]{7,40}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCommit 在非 git 目录里回 undefined 而不是抛——health 是探针,少个字段可以,挂掉不行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
    try {
      // git 在 /tmp 下找不到任何 .git（/tmp 本身不在任何仓库里），rev-parse 以非 0 退出
      expect(readCommit(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCommit 目录根本不存在时也不抛', () => {
    expect(readCommit(join(tmpdir(), 'definitely-missing-' + Date.now()))).toBeUndefined()
  })

  it('countChangedSince 只数 mtime 晚于基线的 .ts,别的后缀不算', () => {
    // 夹具必须造在**被扫描的那个根**下面，不是 cwd 下面：countChangedSince 的 roots 相对
    // repoRoot 解析，而 cwd 完全可以是另一棵树（`vitest --root <worktree>` 在主检出里起动就是），
    // 拿 cwd 拼就会写到别处、然后一个都数不到。pid + 随机后缀防同一棵树上两个并发跑撞名。
    const rel = join('src', `__buildid_fixture__${process.pid}_${Math.random().toString(36).slice(2, 8)}`)
    const abs = join(repoRoot, rel)
    mkdirSync(join(abs, 'nested'), { recursive: true })
    // 每个文件的 mtime 都显式钉死,不去碰当前时钟:这台机器上文件 mtime 会落后 Date.now() 十几毫秒
    // (内核粗时钟),拿 Date.now() 当基线的写法会偶发地一个都数不到。
    const stamp = (name: string, iso: string) => {
      writeFileSync(join(abs, name), 'export {}\n')
      utimesSync(join(abs, name), new Date(iso), new Date(iso))
    }
    const BASELINE = Date.parse('2025-01-01T00:00:00Z')
    try {
      stamp('stale.ts', '2020-01-01T00:00:00Z') // 基线之前
      stamp('fresh.ts', '2030-01-01T00:00:00Z') // 基线之后
      stamp(join('nested', 'deep.ts'), '2030-01-01T00:00:00Z') // 基线之后,且在子目录 => 证明递归
      stamp('fresh.md', '2030-01-01T00:00:00Z') // 够新但后缀不对,不该被数进去

      expect(countChangedSince([rel], BASELINE)).toBe(2)
      // 基线推到所有文件之后 => 一个都不该数到
      expect(countChangedSince([rel], Date.parse('2040-01-01T00:00:00Z'))).toBe(0)
    } finally {
      rmSync(abs, { recursive: true, force: true })
    }
  })

  it('countChangedSince 跳过不存在的树,不抛', () => {
    expect(countChangedSince(['no-such-tree-here'], 0)).toBe(0)
  })
})

/**
 * 发行形态下整个后端是一个 `server.mjs`，`repoRoot`（本模块 `../..`）算出来是资源目录的
 * **上两级**——一个不存在的地方。随载荷出货的东西必须按"它在不在"挑根，别按 `repoRoot` 写死。
 * 漏了这一步的样子：`/panel/*` 恒 404，工作台报「bundle 加载失败」，而那句话的两个猜测都不对。
 */
describe('shippedRoot', () => {
  it('源码树：repoRoot 下有它 → 用 repoRoot', () => {
    expect(shippedRoot('app/dist-panel', ['/repo', '/cwd'], (p) => p === '/repo/app/dist-panel')).toBe('/repo')
  })

  it('发行形态：只有 cwd 下有它（cli-entry 把 cwd 切到资源目录）→ 用 cwd', () => {
    expect(shippedRoot('app/dist-panel', ['/repo', '/res'], (p) => p === '/res/app/dist-panel')).toBe('/res')
  })

  it('都没有 → 回第一个根，让下游报一个指向源码树的 404，而不是指向别处', () => {
    expect(shippedRoot('app/dist-panel', ['/repo', '/res'], () => false)).toBe('/repo')
  })
})
