// S2（N3 返工）：缺省包目录跟着 Stream 自己的安装位置走，不随调用方 cwd 变——
// 嵌入方（别的进程 createStream）从任何目录起都能看见内置源。
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readConfig } from './bootstrap.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('readConfig 的缺省包目录', () => {
  it('不写 packages_dir 时指向仓库的 packages/，与调用方的 cwd 无关', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'pkg-dir-')), 'config.yaml')
    try {
      const before = readConfig(missing, {})
      expect(before.packages_dir).toBe(join(repoRoot, 'packages'))
      const cwd = mkdtempSync(join(tmpdir(), 'pkg-dir-cwd-'))
      const oldCwd = process.cwd()
      process.chdir(cwd)
      try {
        expect(readConfig(missing, {}).packages_dir).toBe(join(repoRoot, 'packages'))
      } finally {
        process.chdir(oldCwd)
        rmSync(cwd, { recursive: true, force: true })
      }
    } finally {
      rmSync(dirname(missing), { recursive: true, force: true })
    }
  })
})

describe('嵌入方从陌生 cwd 起 createStream', () => {
  it('stream_sources 照样非空（内置源按安装位置解析）', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreign-cwd-'))
    try {
      const dataDir = join(dir, 'data')
      const probe = join(dir, 'probe.mts')
      const NL = String.fromCharCode(10)
      writeFileSync(
        probe,
        [
          `const { createStream } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'src/engine/index.ts')).href)})`,
          `const s = await createStream({ dataDir: process.argv[2], log: () => {} })`,
          `try {`,
          `  const r = await s.tools.call('stream_sources', {}, {})`,
          `  const n = (r.value && Array.isArray(r.value.sources)) ? r.value.sources.length : -1`,
          `  console.log('SOURCES=' + n)`,
          `} finally {`,
          `  await s.close()`,
          `}`,
          `process.exit(0)`,
        ].join(NL),
      )
      const out = execFileSync(join(repoRoot, 'node_modules/.bin/tsx'), [probe, dataDir], {
        cwd: tmpdir(), // 嵌入方的真实处境：工作目录与 Stream 仓库无关
        timeout: 100_000,
        encoding: 'utf8',
        // TMPDIR 指进本用例的临时目录：tsx 的 `tsx-<uid>` 管道目录跟着它一起删。
        env: { ...process.env, TMPDIR: dir, STREAM_NO_SCHEDULER: '1' },
      })
      const n = Number(/SOURCES=(-?\d+)/.exec(out)?.[1])
      expect(n).toBeGreaterThan(50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
