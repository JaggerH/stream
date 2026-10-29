// 测试临时目录的守卫（vitest setupFiles，每个测试文件跑一次）。
//
// 测试里到处是 `mkdtempSync(join(tmpdir(), 'xxx-'))`，漏删一个，TMPDIR 里就多一个目录——
// 全量跑完曾攒下近千个。这里把 `mkdtemp` / `mkdtempSync` 包一层：建出来的目录记进本文件的
// 清单，文件跑完由 afterAll 删掉。不搬目录、不清整个 TMPDIR，只删「这个测试文件建出来的」那些。
//
// afterAll 时仍然存在的 = 测试自己没删的：打一条警告点名文件与前缀；设了
// `STREAM_TEST_TMP_LEAK_LOG` 时另写一份清单，供 scripts/check-tmp-residue.mjs 判断。
import { afterAll, expect, vi } from 'vitest'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'

const state = vi.hoisted(() => ({ created: new Set<string>() }))

function record(dir: string): string {
  state.created.add(dir)
  return dir
}

type Mkdtemp = {
  (prefix: string, options?: unknown): Promise<string>
  (prefix: string, callback: (err: NodeJS.ErrnoException | null, dir?: string) => void): void
}

function wrapMkdtemp(actual: Mkdtemp) {
  return (prefix: string, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
    // 两种用法：promise 形式 `mkdtemp(prefix)` 与回调形式 `mkdtemp(prefix, cb)`。
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (typeof callback === 'function') {
      return actual(prefix, (err: NodeJS.ErrnoException | null, dir?: string) => {
        if (!err && dir) record(dir)
        ;(callback as (err: NodeJS.ErrnoException | null, dir?: string) => void)(err, dir)
      })
    }
    return actual(prefix, optionsOrCallback).then(record)
  }
}

function wrapMkdtempSync(actual: (prefix: string) => string) {
  return (prefix: string) => record(actual(prefix))
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtemp: wrapMkdtemp(actual.mkdtemp as unknown as Mkdtemp),
    mkdtempSync: wrapMkdtempSync(actual.mkdtempSync),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdtemp: (prefix: string, options?: unknown) =>
      (actual.mkdtemp as unknown as Mkdtemp)(prefix, options).then(record),
  }
})

// 裸 'fs' / 'fs/promises' 与带 node: 前缀的是同一个模块，但 vi.mock 按说明符匹配，两边都包。
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtemp: wrapMkdtemp(actual.mkdtemp as unknown as Mkdtemp),
    mkdtempSync: wrapMkdtempSync(actual.mkdtempSync),
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdtemp: (prefix: string, options?: unknown) =>
      (actual.mkdtemp as unknown as Mkdtemp)(prefix, options).then(record),
  }
})

afterAll(() => {
  const leaked = [...state.created].filter((dir) => existsSync(dir))
  if (leaked.length > 0) {
    const testPath = (expect.getState() as { testPath?: string }).testPath ?? '<unknown>'
    const prefixes = [...new Set(leaked.map((dir) => basename(dir).replace(/-[A-Za-z0-9]{6,}$/, '')))]
    const line = `[test-tmp] ${testPath} 留下 ${leaked.length} 个临时目录: ${prefixes.join(', ')}`
    console.warn(line)
    if (process.env.STREAM_TEST_TMP_LEAK_LOG) appendFileSync(process.env.STREAM_TEST_TMP_LEAK_LOG, `${line}\n`)
  }
  for (const dir of state.created) rmSync(dir, { recursive: true, force: true })
  state.created.clear()
})
