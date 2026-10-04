import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilityHost } from './host.ts'
import { loadOptionalCapabilities } from './load.ts'

/** 在 recipes 层写一个包目录；`body` 是 `dist/index.js` 的源码（不给就不写这个文件）。 */
function writePkg(root: string, dir: string, stream: Record<string, unknown>, body?: string): void {
  const d = join(root, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `@t/${dir}`, version: '1.0.0', stream: { id: dir, ...stream } }))
  if (body !== undefined) {
    mkdirSync(join(d, 'dist'), { recursive: true })
    writeFileSync(join(d, 'dist', 'index.js'), body)
  }
}

const CAP = (name: string, tools: string[] = []) => `
export const capability = {
  name: ${JSON.stringify(name)},
  async mount(ctx, config) {
    globalThis.__capMounts ??= []
    globalThis.__capMounts.push({ name: ${JSON.stringify(name)}, config })
    ctx.registerTools(${JSON.stringify(tools)}.map((n) => ({
      name: n, description: n, parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: n }] },
      execute: async () => ({}),
    })))
  },
}
`

function newHost() {
  const lines: string[] = []
  const dataDir = mkdtempSync(join(tmpdir(), 'cap-load-data-'))
  return { host: createCapabilityHost({ dataDir, log: (l) => lines.push(l) }), lines }
}

describe('loadOptionalCapabilities', () => {
  it('装载一个声明了 capability 的包，工具进 toolDefs()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'demo', { capability: 'dist/index.js' }, CAP('demo', ['demo_verb']))
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })
    expect(loaded.map((l) => ({ name: l.name, tools: l.tools, id: l.pkg.id }))).toEqual([
      { name: 'demo', tools: ['demo_verb'], id: 'demo' },
    ])
    expect(host.toolDefs().map((d) => d.name)).toEqual(['demo_verb'])
  })

  it('config 按能力名从 capabilities 那一格取，缺席给空对象', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'cfg', { capability: 'dist/index.js' }, CAP('cfg-cap'))
    writePkg(root, 'nocfg', { capability: 'dist/index.js' }, CAP('nocfg-cap'))
    ;(globalThis as unknown as { __capMounts?: unknown[] }).__capMounts = []
    const { host, lines } = newHost()
    await loadOptionalCapabilities({
      recipesDir: root,
      host,
      log: (l) => lines.push(l),
      config: { 'cfg-cap': { tier: 'external' } },
    })
    expect((globalThis as unknown as { __capMounts: Array<{ name: string; config: unknown }> }).__capMounts).toEqual([
      { name: 'cfg-cap', config: { tier: 'external' } },
      { name: 'nocfg-cap', config: {} },
    ])
  })

  // 红线（spec §3.3）：一个包 mount 抛错只记一行、接着装下一个。
  it('一个包 mount 抛错不影响另一个，只记一行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'a-bad', { capability: 'dist/index.js' }, `
      export const capability = { name: 'a-bad', async mount() { throw new Error('boom') } }
    `)
    writePkg(root, 'b-good', { capability: 'dist/index.js' }, CAP('b-good', ['b_verb']))
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })
    expect(loaded.map((l) => l.name)).toEqual(['b-good'])
    expect(host.toolDefs().map((d) => d.name)).toEqual(['b_verb'])
    expect(lines.filter((l) => l.includes('boom'))).toHaveLength(1)
  })

  it('没有 capability 槽位的包被跳过', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'plain', { facility: 'plain', cookieDomain: 'example.com' })
    const { host, lines } = newHost()
    expect(await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })).toEqual([])
    expect(lines).toEqual([])
  })

  it('模块没有 capability 导出 → 记一行、跳过，不抛', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'empty', { capability: 'dist/index.js' }, 'export const nope = 1\n')
    const { host, lines } = newHost()
    expect(await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })).toEqual([])
    expect(lines.some((l) => l.includes('empty'))).toBe(true)
  })

  it('import 不到那个文件 → 记一行、跳过，不抛', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'missing', { capability: 'dist/index.js' })
    const { host, lines } = newHost()
    expect(await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })).toEqual([])
    expect(lines.some((l) => l.includes('missing'))).toBe(true)
  })

  it('recipes 目录不存在 → 空数组，不抛', async () => {
    const { host, lines } = newHost()
    expect(
      await loadOptionalCapabilities({ recipesDir: join(tmpdir(), 'definitely-not-there-xyz'), host, log: (l) => lines.push(l) }),
    ).toEqual([])
  })

  // 用户目录里放一个读不动的包不该掀翻整层（与 packages 域对用户层的立场一致）。
  it('一个 package.json 坏掉的包只掉它自己那一格', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    mkdirSync(join(root, 'broken'), { recursive: true })
    writeFileSync(join(root, 'broken', 'package.json'), '{ not json')
    writePkg(root, 'good', { capability: 'dist/index.js' }, CAP('good', ['g']))
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })
    expect(loaded.map((l) => l.name)).toEqual(['good'])
    expect(lines.some((l) => l.includes('broken'))).toBe(true)
  })
})

// 只兜 throw 不兜 hang 等于没兜：这条路被 `await` 在 serve.ts 的启动路径上，一个包的 mount
// 里 `await` 了永不 settle 的东西（等一个没人应答的容器、等一把用户还没填的钥匙），
// 整个后端就停在那儿——端口上没人听、日志停在上一行，症状和"启动很慢"一字不差。
describe('一个包卡住不该拖死后端', () => {
  const HANG = `
export const capability = {
  name: 'hang',
  async mount() { await new Promise(() => {}) },
}
`

  it('mount 永不 settle → 到点跳过它，其余包照装、函数照常返回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'a-hang', { capability: 'dist/index.js' }, HANG)
    writePkg(root, 'b-good', { capability: 'dist/index.js' }, CAP('b-good', ['b_verb']))
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({
      recipesDir: root, host, log: (l) => lines.push(l), mountTimeoutMs: 50,
    })
    expect(loaded.map((l) => l.name)).toEqual(['b-good'])
    expect(host.toolDefs().map((d) => d.name)).toEqual(['b_verb'])
    // 跳过必须留一行带包名和原因的日志——否则「装了没生效」与「根本没装」长得一模一样。
    expect(lines.some((l) => l.includes('a-hang') && l.includes('50ms'))).toBe(true)
  })

  it('import 本身卡住也走同一道闸（注入点让这条不用真造一个卡住的模块）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'slow-import', { capability: 'dist/index.js' })
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({
      recipesDir: root, host, log: (l) => lines.push(l), mountTimeoutMs: 50,
      importModule: () => new Promise(() => {}),
    })
    expect(loaded).toEqual([])
    expect(lines.some((l) => l.includes('slow-import') && l.includes('import'))).toBe(true)
  })

  it('正常的包不受这道闸影响（默认 30s，不是一个会误伤的数）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-load-'))
    writePkg(root, 'normal', { capability: 'dist/index.js' }, CAP('normal', ['n_verb']))
    const { host, lines } = newHost()
    const loaded = await loadOptionalCapabilities({ recipesDir: root, host, log: (l) => lines.push(l) })
    expect(loaded.map((l) => l.name)).toEqual(['normal'])
  })
})
