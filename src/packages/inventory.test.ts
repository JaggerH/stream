import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamPackage } from './scan.ts'
import {
  isHostedPackage,
  runtimeStateOf,
  summarizePackage,
  buildPackageInventory,
  mergePackageRuntime,
  mergeCapabilityTools,
  type PackageSummary,
} from './inventory.ts'
import { NETDISK_BASE_PACKAGE_ID } from '../netdisk/base-package.ts'

function pkg(over: Partial<StreamPackage> & { id: string }): StreamPackage {
  return { dir: '/nowhere', ...over }
}

describe('isHostedPackage — 分段判据', () => {
  it('有容器 → hosted', () => {
    expect(isHostedPackage({ backend: { image: 'x', port: 1 } })).toBe(true)
  })
  it('要凭证域 → hosted', () => {
    expect(isHostedPackage({ credentials: ['douyin.com'] })).toBe(true)
  })
  it('空的 credentials 数组不算 hosted —— 申报了个空名单等于没申报', () => {
    expect(isHostedPackage({ credentials: [] })).toBe(false)
  })
  it('只有清单 / 代码 / normalizer / recipe 的包不是 hosted（它们没有会崩的活件）', () => {
    expect(isHostedPackage(pkg({ id: 'a', sources: [{ id: 'a' }] as never }))).toBe(false)
    expect(isHostedPackage(pkg({ id: 'a', code: { entry: 'activate.ts' } }))).toBe(false)
    expect(isHostedPackage(pkg({ id: 'a', normalizer: 'x' }))).toBe(false)
    expect(isHostedPackage({})).toBe(false)
  })
})

describe('runtimeStateOf — 复用 pluginStatus，不新起探活', () => {
  it('standby awake → running', () => {
    expect(runtimeStateOf({ id: 'a', configured: true, health: 'ok', standby: { state: 'awake', lastUsed: 1, lastWakeMs: 2 } })).toBe('running')
  })
  it('standby 非 awake → idle（不是 error：它只是没被唤醒）', () => {
    expect(runtimeStateOf({ id: 'a', configured: true, health: 'unknown', standby: { state: 'idle', lastUsed: null, lastWakeMs: null } })).toBe('idle')
  })
  it('无 standby，health ok → running；down → error；unknown → unknown', () => {
    expect(runtimeStateOf({ id: 'a', configured: true, health: 'ok' })).toBe('running')
    expect(runtimeStateOf({ id: 'a', configured: true, health: 'down' })).toBe('error')
    expect(runtimeStateOf({ id: 'a', configured: true, health: 'unknown' })).toBe('unknown')
  })
  it('压根没有 status 行 → unknown（不许假装 running）', () => {
    expect(runtimeStateOf(undefined)).toBe('unknown')
  })
})

describe('summarizePackage — 槽位投影', () => {
  it('容器包：backend + credentials + code + 清单条数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    const s = summarizePackage(
      pkg({
        id: 'douyin-api',
        name: '抖音 / TikTok',
        tagline: '抖音与 TikTok 的解析后端',
        dir,
        backend: { image: 'img:latest', port: 80 },
        credentials: ['douyin.com', 'tiktok.com'],
        code: { entry: 'activate.ts' },
        sources: [{ id: 'a' }, { id: 'b' }] as never,
      }),
      'builtin',
    )
    expect(s.slots).toEqual({ sources: 2, code: true, backend: true, credentials: ['douyin.com', 'tiktok.com'] })
    expect(s.hosted).toBe(true)
    expect(s.name).toBe('抖音 / TikTok')
    expect(s.description).toBe('抖音与 TikTok 的解析后端')
    expect(s.layer).toBe('builtin')
  })

  it('recipe 包：数 *.recipe.json 的份数，没有的槽位不出现在对象里', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    writeFileSync(join(dir, 'a.recipe.json'), '{}')
    writeFileSync(join(dir, 'b.recipe.json'), '{}')
    writeFileSync(join(dir, 'notes.md'), 'x')
    const s = summarizePackage(pkg({ id: 'xhs', dir, pkgName: '@streamapp/xhs', pkgVersion: '1.0.0' }), 'user')
    // 名字排序后给：配方行要说出「是哪几条」，而不只是「2 条」。顺序稳定，UI 才不会每次刷新换位。
    expect(s.slots).toEqual({ recipes: 2, recipeNames: ['a', 'b'] })
    expect(s.hosted).toBe(false)
    expect(s.name).toBe('xhs') // 没有 stream.name 就回落到 id
    expect(s.pkgName).toBe('@streamapp/xhs')
    expect(s.version).toBe('1.0.0')
    expect(s.layer).toBe('user')
  })

  it('包目录读不到时 recipes 记 0，不抛（一个坏目录不该掀翻整页）', () => {
    const s = summarizePackage(pkg({ id: 'ghost', dir: join(tmpdir(), 'definitely-not-here-xyz') }), 'builtin')
    expect(s.slots.recipes).toBeUndefined()
    expect(s.slots.recipeNames).toBeUndefined()
  })

  it('recipeNames 剥掉 .recipe.json 后缀,而不是只剥 .json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    writeFileSync(join(dir, 'xhs-home-xhr.recipe.json'), '{}')
    const s = summarizePackage(pkg({ id: 'xhs', dir }), 'builtin')
    expect(s.slots.recipeNames).toEqual(['xhs-home-xhr'])
  })
})

describe('buildPackageInventory', () => {
  const mk = (id: string, over: Partial<StreamPackage> = {}) => pkg({ id, dir: mkdtempSync(join(tmpdir(), 'inv-')), ...over })

  it('两层合流，按 id 排序，layer 标对', () => {
    const list = buildPackageInventory({
      builtin: [mk('zuna'), mk('alist', { backend: { image: 'i', port: 1 } })],
      user: [mk('mine', { pkgName: '@x/mine' })],
    })
    expect(list.map((p) => [p.id, p.layer])).toEqual([
      ['alist', 'builtin'],
      ['mine', 'user'],
      ['zuna', 'builtin'],
    ])
  })

  it('enabled 只给填了插件槽位的包 —— 纯 recipe 包没有可翻的开关', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'))
    writeFileSync(join(dir, 'a.recipe.json'), '{}')
    const list = buildPackageInventory({
      builtin: [mk('alist', { backend: { image: 'i', port: 1 } }), pkg({ id: 'pure', dir })],
      user: [],
      enabled: (id) => id !== 'alist',
    })
    expect(list.find((p) => p.id === 'alist')!.enabled).toBe(false)
    expect(list.find((p) => p.id === 'pure')).not.toHaveProperty('enabled')
  })

  // 读不动的包必须**看得见**：目录整份 500 和悄悄少一行都是把问题藏起来——用户看不见自己
  // 刚装的包，只会以为没装上，去装第二遍。
  it('读不动的用户包照样出一行，带上原因', () => {
    const list = buildPackageInventory({
      builtin: [mk('alist')],
      user: [],
      unreadableUser: [{ dir: '/data/recipes/rotten', error: new Error('Invalid Stream package rotten/package.json') }],
    })
    expect(list.map((p) => p.id)).toEqual(['alist', 'rotten'])
    expect(list[1]).toMatchObject({ id: 'rotten', layer: 'user', slots: {}, hosted: false })
    expect(list[1].unreadable).toMatch(/Invalid Stream package/)
  })

  // 它连 id 都是从目录名猜的，凭什么盖掉一个真读出来的包。
  it('读不动的那一行盖不掉同 id 的好包', () => {
    const list = buildPackageInventory({
      builtin: [],
      user: [mk('quark', { pkgName: '@third/quark', pkgVersion: '2.0.0' })],
      unreadableUser: [{ dir: '/data/recipes/quark', error: new Error('boom') }],
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'quark', version: '2.0.0' })
    expect(list[0]).not.toHaveProperty('unreadable')
  })

  it('用户层同 id 覆盖内置层（装了第三方版就该看到第三方那份）', () => {
    const list = buildPackageInventory({
      builtin: [mk('quark')],
      user: [mk('quark', { pkgName: '@third/quark', pkgVersion: '2.0.0' })],
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'quark', layer: 'user', version: '2.0.0' })
  })
})

describe('summarizePackage — role', () => {
  it('网盘底座那个包带 role: netdisk-base（前端按 role 分支，不认包 id）', () => {
    const s = summarizePackage(pkg({ id: NETDISK_BASE_PACKAGE_ID, dir: mkdtempSync(join(tmpdir(), 'inv-')) }), 'builtin')
    expect(s.role).toBe('netdisk-base')
  })

  it('其余包不带 role 键', () => {
    const s = summarizePackage(pkg({ id: 'pansou', dir: mkdtempSync(join(tmpdir(), 'inv-')) }), 'builtin')
    expect(s).not.toHaveProperty('role')
  })
})

describe('summarizePackage — runtime 骨架', () => {
  it('带容器的包自带一个 runtime 骨架（image 来自声明，state 先记 unknown）', () => {
    const s = summarizePackage(
      pkg({ id: 'voiceprint', dir: mkdtempSync(join(tmpdir(), 'inv-')), backend: { image: 'sherpa:latest', port: 8000 } }),
      'builtin',
    )
    expect(s.runtime).toEqual({ state: 'unknown', image: 'sherpa:latest' })
  })

  it('没有 backend 的包不带 runtime —— 它没有活件，给个 unknown 状态行是凭空制造焦虑', () => {
    const s = summarizePackage(pkg({ id: 'imdb', dir: mkdtempSync(join(tmpdir(), 'inv-')) }), 'builtin')
    expect(s).not.toHaveProperty('runtime')
  })
})

describe('mergePackageRuntime', () => {
  const withBackend = (): PackageSummary => ({
    id: 'voiceprint', name: 'voiceprint', layer: 'builtin',
    slots: { backend: true }, hosted: true,
    runtime: { state: 'unknown', image: 'sherpa:latest' },
  })

  it('把 pluginStatus 的说法填进 runtime（state + lastUsed），image 保持声明值', () => {
    const [out] = mergePackageRuntime(
      [withBackend()],
      [{ id: 'voiceprint', configured: true, health: 'unknown', standby: { state: 'idle', lastUsed: 1700, lastWakeMs: null } }],
    )
    expect(out.runtime).toEqual({ state: 'idle', image: 'sherpa:latest', lastUsed: 1700 })
  })

  it('没有 runtime 骨架的包不会被凭空造出一条状态行', () => {
    const [out] = mergePackageRuntime(
      [{ id: 'imdb', name: 'imdb', layer: 'builtin', slots: { recipes: 1 }, hosted: false }],
      [{ id: 'imdb', configured: true, health: 'down' }],
    )
    expect(out).not.toHaveProperty('runtime')
  })

  it('有 backend 但 status 里没有它 → state 留在 unknown', () => {
    const [out] = mergePackageRuntime([withBackend()], [])
    expect(out.runtime?.state).toBe('unknown')
  })
})

// 能力槽位在「包」页上和代码槽位是两件事：`code` 那格注册 adapter/normalizer，这一格交出一个
// `Capability`（工具 + 服务）。只画 `code` 的话，一个能力包和一份纯数据的 recipe 包长得一样。
describe('summarizePackage：能力槽位', () => {
  it('填了 capability → 槽位里出现入口路径', () => {
    const s = summarizePackage(pkg({ id: 'cap', capability: 'dist/index.js' }), 'user')
    expect(s.slots.capability).toBe('dist/index.js')
  })

  it('没填就整格缺席（不是空串，也不是 false）', () => {
    expect(summarizePackage(pkg({ id: 'plain' }), 'builtin').slots.capability).toBeUndefined()
  })

  // 工具名只有 mount 过才存在，包目录里没有这个答案——写进这一层等于把 boot 那一刻冻住。
  it('tools 不在这一层填（它的数据源是活着的宿主）', () => {
    expect(summarizePackage(pkg({ id: 'cap', capability: 'dist/index.js' }), 'user').slots.tools).toBeUndefined()
  })
})

describe('mergeCapabilityTools', () => {
  const cap = (id: string): PackageSummary =>
    ({ id, name: id, layer: 'user', slots: { capability: 'dist/index.js' }, hosted: false })
  const plain = (id: string): PackageSummary => ({ id, name: id, layer: 'user', slots: {}, hosted: false })

  it('按包 id 把宿主此刻的工具表填进去', () => {
    const [row] = mergeCapabilityTools([cap('netdisk')], { netdisk: ['netdisk_save', 'netdisk_verify'] })
    expect(row.slots.tools).toEqual(['netdisk_save', 'netdisk_verify'])
  })

  // 「声明了能力但没装载/没注册工具」是一句真话，和「这个包没有能力槽位」是两句不同的话。
  it('声明了能力却不在表里 → 空数组，不是缺席', () => {
    const [row] = mergeCapabilityTools([cap('netdisk')], {})
    expect(row.slots.tools).toEqual([])
  })

  it('没填能力槽位的包一格都不加', () => {
    const [row] = mergeCapabilityTools([plain('rsshub')], { rsshub: ['whatever'] })
    expect(row.slots.tools).toBeUndefined()
    expect(row.slots.capability).toBeUndefined()
  })

  it('不改原对象（读路径每次请求都跑一遍，就地改会把快照越改越花）', () => {
    const rows = [cap('netdisk')]
    mergeCapabilityTools(rows, { netdisk: ['x'] })
    expect(rows[0].slots.tools).toBeUndefined()
  })

  it('其余字段原样带过（runtime 骨架靠 mergePackageRuntime 再补，两步不能互相吃掉）', () => {
    const row = { ...cap('netdisk'), runtime: { state: 'unknown' as const, image: 'img' } }
    const [out] = mergeCapabilityTools([row], { netdisk: ['x'] })
    expect(out.runtime).toEqual({ state: 'unknown', image: 'img' })
    expect(out.slots.capability).toBe('dist/index.js')
  })
})
