// `scripts/publish-extension.mjs` 的纯函数那一半。
//
// 钉住的是**两件会静默出错的事**：npm 包的 version 必须照抄 manifest（手改一次，用户 Chrome 里
// 显示的版本和 npm 上的就分家，而"我装的是哪一版"只能靠这两个数对得上），以及 `files` 白名单
// 必须真的把字节带上（漏了 `chrome-mv3/`，publish 出去的是一个能装、能解析、但里面什么都没有
// 的包——两个消费者拿到的都是空目录，没有任何一处会报错）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error - 纯 .mjs 脚本，没有类型声明；这里只取它的纯函数。
import { buildNpmDir } from './publish-extension.mjs'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'publish-ext-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fakeBuilt(version: string): string {
  const built = join(tmp, 'chrome-mv3')
  mkdirSync(built, { recursive: true })
  writeFileSync(join(built, 'manifest.json'), JSON.stringify({ manifest_version: 3, version, key: 'AAA' }))
  writeFileSync(join(built, 'background.js'), '// bytes')
  return built
}

describe('buildNpmDir', () => {
  it('version 照抄 manifest（不是模板里那个占位值，也不接受手改）', () => {
    const out = join(tmp, 'npm')
    const pkg = buildNpmDir(fakeBuilt('0.4.2'), out)
    expect(pkg.version).toBe('0.4.2')
    expect(pkg.name).toBe('@streamapp/chrome-extension')
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).version).toBe('0.4.2')
  })

  it('files 白名单带上扩展字节和入口——漏了就是一个"装上了却是空的"包', () => {
    const out = join(tmp, 'npm')
    const pkg = buildNpmDir(fakeBuilt('0.1.0'), out)
    expect(pkg.files).toEqual(['chrome-mv3/', 'index.js'])
    expect(existsSync(join(out, 'chrome-mv3/manifest.json'))).toBe(true)
    expect(existsSync(join(out, 'chrome-mv3/background.js'))).toBe(true)
    expect(existsSync(join(out, 'index.js'))).toBe(true)
  })

  it('模板的 private 被摘掉——留着它 npm publish 会当场拒绝', () => {
    const out = join(tmp, 'npm')
    const pkg = buildNpmDir(fakeBuilt('0.1.0'), out)
    expect(pkg.private).toBeUndefined()
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).private).toBeUndefined()
    // 而模板自己必须留着它：那是"在模板目录里手滑 publish"唯一的拦截。
    const template = JSON.parse(readFileSync(join(import.meta.dirname, '../extension/npm/package.json'), 'utf8'))
    expect(template.private).toBe(true)
  })

  it('产物先删后建：上一次的残余文件不许混进这一版', () => {
    const out = join(tmp, 'npm')
    buildNpmDir(fakeBuilt('0.1.0'), out)
    writeFileSync(join(out, 'chrome-mv3', 'stale.js'), '// 上一代')
    buildNpmDir(fakeBuilt('0.2.0'), out)
    expect(existsSync(join(out, 'chrome-mv3/stale.js'))).toBe(false)
  })

  it('没有构建产物 → 抛，并说清该跑哪条命令（绝不组装一个空包）', () => {
    expect(() => buildNpmDir(join(tmp, 'nope'), join(tmp, 'npm'))).toThrow(/pnpm --dir extension build/)
  })
})
