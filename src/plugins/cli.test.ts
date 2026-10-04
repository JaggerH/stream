import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { loadConfig, resolveDataDir } from '../bootstrap.ts'
import { buildCompose } from './cli.ts'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const withDataDir = <T,>(dir: string, fn: () => T): T => {
  const prev = process.env.STREAM_DATA_DIR
  process.env.STREAM_DATA_DIR = dir
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.STREAM_DATA_DIR
    else process.env.STREAM_DATA_DIR = prev
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveDataDir — CLI 与后端运行时的同一个数据目录', () => {
  it('永远返回绝对路径（config.yaml 里的相对 item_db 也定死到 cwd）', () => {
    const dir = resolveDataDir({ item_db: './data/items.db' } as never)
    expect(isAbsolute(dir)).toBe(true)
    expect(dir).toBe(join(process.cwd(), 'data'))
  })

  it('跟着 STREAM_DATA_DIR 走——后端在哪认 token，CLI 就该往哪铸', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stream-datadir-'))
    const dir = withDataDir(tmp, () => resolveDataDir(loadConfig()))
    expect(dir).toBe(join(tmp, 'data'))
  })

  it('没有第二份实现：dataDir 只能从 resolveDataDir 来', () => {
    // 复刻一份 `dirname(config.item_db)` 就是下一次分家的种子——CLI 写进 compose 的 token
    // 和后端认的 token 变成两套，表现是容器永远 401 而两边单看都正常。
    for (const f of ['bootstrap.ts', 'plugins/cli.ts']) {
      const src = readFileSync(join(SRC_ROOT, f), 'utf8')
      const offenders = src
        .split('\n')
        .filter((l) => /dirname\(\s*config\.item_db\s*\)/.test(l) && !l.trimStart().startsWith('*'))
        // resolveDataDir 自己的函数体是那唯一一份实现
        .filter((l) => !/^\s*return resolve\(dirname\(config\.item_db\)\)$/.test(l))
      expect(offenders, `${f} 里还有手算 dataDir 的地方`).toEqual([])
    }
  })
})

/**
 * 生成物里一个凭证都不能有。
 *
 * 这条守的是一次真实事故的两半：`docker-compose.yml` 曾经**被 git 跟踪着**（`.gitignore` 里
 * 写了它，但 gitignore 对已跟踪文件无效），而生成器那时会把每个申报了 credentials 的包的
 * `STREAM_CREDENTIAL_TOKEN` 明文写进去。两件事叠起来，任何一次 `git add docker-compose.yml`
 * 都会把用户的登录态凭据写进历史。
 *
 * 现在两半都堵上了（文件不再跟踪；生成器不再发凭证），这条是后一半的守卫——回归会很安静：
 * 往 YAML 里多写一个 env，没有任何别的断言会红。
 */
describe('buildCompose — 生成物里没有凭证', () => {
  it('主路：整份 YAML 里搜不到任何 token', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stream-compose-'))
    const yaml = withDataDir(tmp, () => buildCompose())
    expect(yaml).not.toContain('STREAM_CREDENTIAL_TOKEN')
    expect(yaml).not.toMatch(/token/i)
  })

  it('selfhost 档同样', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stream-compose-selfhost-'))
    const yaml = withDataDir(tmp, () => buildCompose(undefined, { selfhost: true }))
    expect(yaml).not.toContain('STREAM_CREDENTIAL_TOKEN')
    expect(yaml).not.toMatch(/token/i)
  })

  it('不再往 data 目录里铸 token 文件', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stream-compose-notoken-'))
    withDataDir(tmp, () => buildCompose())
    const dataDir = withDataDir(tmp, () => resolveDataDir(loadConfig()))
    expect(existsSync(join(dataDir, 'package-credential-tokens.json'))).toBe(false)
  })
})
