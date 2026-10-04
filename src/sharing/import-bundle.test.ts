import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { importBundle, type ImportDeps } from './import-bundle.ts'
import { writeEmbeddedToDir } from './recipe-embed.ts'
import { STREAM_BUNDLE_FORMAT, type StreamBundleV1, type EmbeddedRecipePackage } from './bundle-format.ts'
import type { ImportItem } from './import-run-store.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { Registry } from '../registry/registry.ts'
import type { MappingSet } from '../netdisk/types.ts'

function memMappingStore() {
  const saved: MappingSet[] = []
  return { saved, get: (id: string) => saved.find((s) => s.id === id), save: (s: MappingSet) => { saved.push(s) } }
}

function mkBundle(over: Partial<StreamBundleV1> = {}): StreamBundleV1 {
  return {
    format: STREAM_BUNDLE_FORMAT,
    meta: { title: 'Mine', author: 'alice', created: '2026-07-18', revision: '1.0.0' },
    channels: [{ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: {} }],
    streams: [{ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} }],
    providers: [],
    requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
    embedded: { recipes: {} },
    ...over,
  }
}
function deps(store: UserStore): ImportDeps & { _installed: string[] } {
  const installed: string[] = []
  return {
    store,
    installedPlugins: new Set<string>(),
    installedRecipes: new Map<string, { version?: string }>(),
    installRecipePackage: vi.fn(() => { installed.push('x') }),
    _installed: installed,
  }
}
const notices = (items: ImportItem[]) => items.filter((i) => i.kind === 'notice')
const reason = (i: ImportItem) => (i.subject as { reason?: string }).reason

describe('importBundle → ImportRun', () => {
  it('run 骨架：id 可注入、meta 来自 bundle、无遗留时 items 为空', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle(), { ...deps(s), genRunId: () => 'imp-test01' })
    expect(r.id).toBe('imp-test01')
    expect(r.meta).toEqual({ title: 'Mine', author: 'alice', revision: '1.0.0' })
    expect(r.items).toEqual([])
    expect(s.getChannel('mine')?.stream_ids).toEqual(['s1'])
    expect(s.getStream('s1')).toBeTruthy()
    expect(r.remaps).toEqual({})
    s.close()
  })

  it('普通 id 撞车 → remap + 改写 channel.stream_ids，本机原行不变', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'OLD', strategy: 'fanout', cadence_seconds: 999, members: [], options: {} })
    const r = importBundle(mkBundle(), deps(s))
    expect(r.remaps['s1']).toBeDefined()
    expect(s.getStream('s1')?.label).toBe('OLD')
    const newId = r.remaps['s1']
    expect(s.getStream(newId)?.label).toBe('S1')
    expect(s.getChannel('mine')?.stream_ids).toEqual([newId])
    s.close()
  })

  it('同 id 撞车但同源(members 一致) → 复用本机行，不 fork、无空孪生', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'LOCAL', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    const r = importBundle(mkBundle(), deps(s))
    expect(r.remaps['s1']).toBeUndefined()
    expect(s.getStream('s1')?.label).toBe('LOCAL')
    expect(s.getStream('s1-imported')).toBeNull()
    expect(s.getChannel('mine')?.stream_ids).toEqual(['s1'])
    s.close()
  })

  it('回归：system 频道下重复导入同源流不产生空孪生（music 频道尾巴的成因）', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'LOCAL', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    const seeded = s.getChannel('default-audio')!.stream_ids
    s.patchChannel('default-audio', { stream_ids: [...seeded, 's1'] })
    importBundle(mkBundle({
      channels: [{ id: 'default-audio', label: '音乐/播客', present: 'audio', stream_ids: ['s1'], system: true, options: {} }],
    }), deps(s))
    const ids = s.getChannel('default-audio')!.stream_ids
    expect(s.getStream('s1-imported')).toBeNull()
    expect(ids.filter((x) => x === 's1')).toEqual(['s1'])
    expect(ids.some((x) => x.endsWith('-imported'))).toBe(false)
    s.close()
  })

  it('system 频道复用：default-audio 下的流 append，不新建系统频道', () => {
    const s = new UserStore(':memory:')
    const before = s.getChannel('default-audio')!.stream_ids.length
    importBundle(mkBundle({
      channels: [{ id: 'default-audio', label: '音乐/播客', present: 'audio', stream_ids: ['s1'], system: true, options: {} }],
    }), deps(s))
    const after = s.getChannel('default-audio')!
    expect(after.system).toBe(true)
    expect(after.stream_ids).toContain('s1')
    expect(after.stream_ids.length).toBe(before + 1)
    s.close()
  })

  it('缺代码插件 → notice item（reason=missing-plugin），不静默成功', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle({ requires: { plugins: [{ id: 'douyin', homepage: 'https://d' }], recipes: [], credentials: [], runtimeConfig: [] } }), deps(s))
    const n = notices(r.items).find((i) => reason(i) === 'missing-plugin')
    expect(n).toBeTruthy()
    expect((n!.subject as { dep?: string }).dep).toBe('douyin')
    expect(n!.status).toBe('open')
    expect(n!.choices).toEqual(['dismiss'])
    s.close()
  })

  it('跨 major recipe → recipeDecisions=ask + notice（不装该版本）', () => {
    const s = new UserStore(':memory:')
    const d = deps(s)
    d.installedRecipes.set('@a/xhs', { version: '2.9.9' })
    const r = importBundle(mkBundle({
      requires: { plugins: [], recipes: [{ id: '@a/xhs', version: '3.0.0' }], credentials: [], runtimeConfig: [] },
      embedded: { recipes: { '@a/xhs': { facility: 'xhs', author: 'a', version: '3.0.0', packageJson: JSON.stringify({ name: '@a/xhs', version: '3.0.0', stream: { type: 'recipe', facility: 'xhs', schemaVersion: 1 } }), recipeFiles: {} } } },
    }), d)
    expect(r.recipeDecisions['@a/xhs'].action).toBe('ask')
    expect(d.installRecipePackage).not.toHaveBeenCalled()
    expect(notices(r.items).some((i) => reason(i) === 'cross-major')).toBe(true)
    s.close()
  })

  it('corrupt recipe（facility 目录穿越）→ notice + 跳过安装', () => {
    const s = new UserStore(':memory:')
    const d = deps(s)
    const r = importBundle(mkBundle({
      embedded: { recipes: { evil: { facility: '../evil', author: 'a', version: '1.0.0', packageJson: '', recipeFiles: {} } } },
    }), d)
    expect(d.installRecipePackage).not.toHaveBeenCalled()
    expect(notices(r.items).some((i) => reason(i) === 'corrupt')).toBe(true)
    s.close()
  })

  it('内嵌包 name 非法 → 记 corrupt 跳过该包，同 bundle 里正常包/配置照落、导入不抛（一个坏包不掀翻整份）', () => {
    const s = new UserStore(':memory:')
    const userDir = mkdtempSync(join(tmpdir(), 'imp-corrupt-'))
    // 真实落盘：若守卫失灵，坏 name 会让 writeEmbeddedToDir 抛出、整个 importBundle 500
    const d = { ...deps(s), installRecipePackage: (pkg: EmbeddedRecipePackage) => writeEmbeddedToDir(pkg, userDir) }
    const mkPkg = (name: string | undefined, facility: string, sourceId: string): EmbeddedRecipePackage => ({
      facility, author: 'a', version: '1.0.0',
      packageJson: JSON.stringify({ ...(name !== undefined ? { name } : {}), version: '1.0.0', stream: { type: 'recipe', facility, schemaVersion: 1 } }),
      recipeFiles: { [`${sourceId}.recipe.json`]: JSON.stringify({ sourceId }) },
    })
    let run!: ReturnType<typeof importBundle>
    expect(() => {
      run = importBundle(mkBundle({
        embedded: { recipes: {
          bad: mkPkg('@x/../../evil', 'goodfac', 'evil-src'),      // name 非法
          good: mkPkg('@streamapp/telegram', 'telegram', 'tg-src'), // 正常
        } },
      }), d)
    }).not.toThrow()
    // 坏包记 corrupt、没落盘；正常包落到 dirNameFor(name)
    expect(notices(run.items).some((i) => reason(i) === 'corrupt')).toBe(true)
    expect(readdirSync(userDir)).toEqual(['@streamapp__telegram'])
    expect(existsSync(join(userDir, '@streamapp__telegram', 'package.json'))).toBe(true)
    // 同 bundle 里的 channel/stream 照落——坏内嵌包没有掀翻其余配置
    expect(s.getChannel('mine')).toBeTruthy()
    expect(s.getStream('s1')).toBeTruthy()
    s.close()
  })

  it('导入零执行：不发出站请求', () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const s = new UserStore(':memory:')
    importBundle(mkBundle(), deps(s))
    expect(spy).not.toHaveBeenCalled()
    s.close()
  })

  it('pending 凭证/runtime-config → notice items 引导补录', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle({ requires: { plugins: [], recipes: [], credentials: [{ domain: 'xhs.com', reason: 'r' }], runtimeConfig: [{ ref: 'tmdb', fields: ['apiKey'] }] } }), deps(s))
    const cred = notices(r.items).find((i) => reason(i) === 'pending-credential')
    expect((cred!.subject as { domain?: string }).domain).toBe('xhs.com')
    const rc = notices(r.items).find((i) => reason(i) === 'pending-runtime-config')
    expect((rc!.subject as { ref?: string }).ref).toBe('tmdb')
    s.close()
  })

  it('命门：导入含 Provider 的包后，对方每个 serves 键的 match 结果逐字不变；parked-provider 落 item', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'their-quark', label: 'TQ', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    const ex = new ProviderExecutor({ directory: new ProviderDirectory(s, SYSTEM_IDENTITIES), registry: new Registry([]), stats: { record() {} } as never, fetchSource: async () => null as never })
    const before = ex.match('resolve', 'quark-verify').map((r) => r.id)

    const bundle = mkBundle({
      providers: [{ id: 'their-quark', label: '作者的夸克', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
    })
    const r = importBundle(bundle, deps(s))

    const newId = r.remaps['their-quark'] ?? 'their-quark'
    const item = r.items.find((i) => i.kind === 'parked-provider')!
    expect((item.subject as { providerId?: string }).providerId).toBe(newId)
    expect(item.choices).toEqual(['use-imported', 'keep-mine', 'append', 'dismiss'])
    expect(s.getProvider(newId)?.options.parked).toBe(true)
    expect(s.getProvider('their-quark')?.label).toBe('TQ')
    expect(ex.match('resolve', 'quark-verify').map((rr) => rr.id)).toEqual(before)
    s.close()
  })

  it('旧包（variant 无 present）导入不崩，落库按 variant 映射', () => {
    const s = new UserStore(':memory:')
    const bundle = mkBundle({
      channels: [{ id: 'mine', label: 'Mine', variant: 'audio', stream_ids: ['s1'], options: {} } as never],
    })
    expect(() => importBundle(bundle, deps(s))).not.toThrow()
    expect(s.getChannel('mine')?.present).toBe('audio')
    s.close()
  })

  it('旧包 variant:mixed 无 present → 落库 present=timeline', () => {
    const s = new UserStore(':memory:')
    const bundle = mkBundle({
      channels: [{ id: 'mine', label: 'Mine', variant: 'mixed', stream_ids: ['s1'], options: {} } as never],
    })
    importBundle(bundle, deps(s))
    expect(s.getChannel('mine')?.present).toBe('timeline')
    s.close()
  })

  it('槽位引用随包 provider（parked-on-import）→ 摘到 candidateSlots，不进 slots，id 已 remap', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'their-quark', label: 'existing local', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    const bundle = mkBundle({
      channels: [{ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: { slots: { 'netdisk.share.verify': ['their-quark'] } } }],
      providers: [{ id: 'their-quark', label: '作者的夸克', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
    })
    const r = importBundle(bundle, deps(s))
    const newProviderId = r.remaps['their-quark']
    expect(newProviderId).toBeDefined()
    const ch = s.getChannel('mine')!
    expect((ch.options.slots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    expect((ch.options.candidateSlots as Record<string, string[]>)['netdisk.share.verify']).toEqual([newProviderId])
    s.close()
  })

  it('槽位引用未随包也不在本机的 provider（防御历史包）→ 键剥离', () => {
    const s = new UserStore(':memory:')
    const bundle = mkBundle({
      channels: [{ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: { slots: { 'netdisk.share.verify': ['ghost-provider'] } } }],
    })
    importBundle(bundle, deps(s))
    const ch = s.getChannel('mine')!
    expect((ch.options.slots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    expect((ch.options.candidateSlots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    s.close()
  })

  it('providerBindings 覆盖落候选（options.candidateBinding），不写 provider_bindings 表', () => {
    const s = new UserStore(':memory:')
    const bundle = mkBundle({
      channels: [], streams: [],
      providers: [{ id: 'p1', label: 'P1', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
      providerBindings: [{ callsiteId: 'netdisk.share.verify', providerIds: ['p1'] }],
    })
    const r = importBundle(bundle, deps(s))
    const id = r.remaps['p1'] ?? 'p1'
    expect((s.getProvider(id)?.options as { candidateBinding?: unknown }).candidateBinding).toEqual({ callsiteId: 'netdisk.share.verify' })
    expect(s.getProviderBinding('netdisk.share.verify')).toBeNull()
    s.close()
  })
})

describe('system channel 的 options.slots（TODO 认领项：不再无声丢弃）', () => {
  const sysBundle = (slots: Record<string, string[]>, over: Partial<StreamBundleV1> = {}) => mkBundle({
    channels: [{ id: 'default-video', label: '影视', present: 'video', stream_ids: [], system: true, options: { slots } }],
    streams: [],
    ...over,
  })

  it('本机未配置该 callsite → 静默合并进 system 频道 slots（引用本机既有 provider）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'local-p', label: 'LP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    const r = importBundle(sysBundle({ 'netdisk.share.verify': ['local-p'] }), deps(s))
    const ch = s.getChannel('default-video')!
    expect((ch.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['local-p'])
    expect(r.items.filter((i) => i.kind === 'slot-conflict')).toEqual([])
    s.close()
  })

  it('本机未配置 + 键引用随包 parked provider → 落 system 频道 candidateSlots（id 已 remap）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'their-p', label: 'occupies id', description: '', category: 'resolve', serves: ['x'], strategy: 'sequential', members: [], contract: null, options: {} })
    const r = importBundle(sysBundle({ 'netdisk.share.verify': ['their-p'] }, {
      providers: [{ id: 'their-p', label: '作者的', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} }],
    }), deps(s))
    const newId = r.remaps['their-p']
    const ch = s.getChannel('default-video')!
    expect((ch.options.candidateSlots as Record<string, string[]>)['netdisk.share.verify']).toEqual([newId])
    expect((ch.options.slots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    s.close()
  })

  it('本机 slots 已配置同 callsite → 本机不动，落 slot-conflict item（mine/theirs 双方信息）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'local-p', label: 'LP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider({ id: 'other-p', label: 'OP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    const r = importBundle(sysBundle({ 'netdisk.share.verify': ['other-p'] }), deps(s))
    const ch = s.getChannel('default-video')!
    expect((ch.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['local-p']) // 本机继续生效
    const item = r.items.find((i) => i.kind === 'slot-conflict')!
    expect(item.subject).toEqual({ channelId: 'default-video', callsiteId: 'netdisk.share.verify' })
    expect((item.mine as { providerIds: string[] }).providerIds).toEqual(['local-p'])
    expect((item.theirs as { providerIds: string[] }).providerIds).toEqual(['other-p'])
    expect(item.choices).toEqual(['keep-mine', 'use-imported', 'dismiss'])
    expect(item.status).toBe('open')
    s.close()
  })

  it('本机 candidateSlots 已占同 callsite → 同样算冲突（防止激活时盖掉本机活槽）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'other-p', label: 'OP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.patchChannel('default-video', { options: { candidateSlots: { 'netdisk.share.verify': ['mine-parked'] } } })
    const r = importBundle(sysBundle({ 'netdisk.share.verify': ['other-p'] }), deps(s))
    const ch = s.getChannel('default-video')!
    expect((ch.options.candidateSlots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['mine-parked'])
    expect(r.items.some((i) => i.kind === 'slot-conflict')).toBe(true)
    s.close()
  })

  it('悬空引用（既不随包也不在本机）→ 键剥离 + notice，不落冲突', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(sysBundle({ 'netdisk.share.verify': ['ghost'] }), deps(s))
    const ch = s.getChannel('default-video')!
    expect((ch.options.slots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    expect(r.items.some((i) => i.kind === 'slot-conflict')).toBe(false)
    expect(notices(r.items).some((i) => reason(i) === 'slot-dangling')).toBe(true)
    s.close()
  })

  it('冲突时包内那份不落频道 options 的任何字段（run 是唯一存储）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'local-p', label: 'LP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider({ id: 'other-p', label: 'OP', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    importBundle(sysBundle({ 'netdisk.share.verify': ['other-p'] }), deps(s))
    const opts = s.getChannel('default-video')!.options as Record<string, unknown>
    expect(Object.keys(opts).sort()).toEqual(['slots'])
    s.close()
  })

  it('混合：同包内一个键冲突、一个键静默合并、stream_ids 照常 append', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'local-p', label: 'LP', description: '', category: 'resolve', serves: ['a'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider({ id: 'free-p', label: 'FP', description: '', category: 'search', serves: ['b'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.patchChannel('default-video', { options: { slots: { 'occupied.callsite': ['local-p'] } } })
    const r = importBundle(mkBundle({
      channels: [{ id: 'default-video', label: '影视', present: 'video', stream_ids: ['s1'], system: true, options: { slots: { 'occupied.callsite': ['free-p'], 'free.callsite': ['free-p'] } } }],
    }), deps(s))
    const ch = s.getChannel('default-video')!
    expect((ch.options.slots as Record<string, string[]>)['occupied.callsite']).toEqual(['local-p'])
    expect((ch.options.slots as Record<string, string[]>)['free.callsite']).toEqual(['free-p'])
    expect(ch.stream_ids).toContain('s1')
    expect(r.items.filter((i) => i.kind === 'slot-conflict')).toHaveLength(1)
    s.close()
  })

  it('非系统频道撞 id 走 fork，不产生 slot-conflict', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'local-p', label: 'LP', description: '', category: 'resolve', serves: ['a'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putChannel({ id: 'mine', label: 'LOCAL', present: 'timeline', stream_ids: [], options: { slots: { 'x.y': ['local-p'] } } })
    const r = importBundle(mkBundle({
      channels: [{ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1'], options: { slots: { 'x.y': ['local-p'] } } }],
    }), deps(s))
    expect(r.items.some((i) => i.kind === 'slot-conflict')).toBe(false)
    expect(r.remaps['mine']).toBeDefined() // fork 出新频道
    s.close()
  })
})

describe('导入 netdiskBindings → pending MappingSet（零执行）', () => {
  const nbBundle = (over = {}) => mkBundle({ channels: [], streams: [], providers: [], netdiskBindings: [{
    left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权游' },
    matchSpec: { version: 2 } as never,
    entries: [{ leftKey: 'k2', leftTitle: '第二集', rightFile: '第二集.mkv', status: 'confirmed', corrected: { at: '2026-07-19', autoFile: null } }] as never,
  }], ...over })

  it('建 pending 集：right.path 空、autoSync=false、matchSpec 保留、entries=corrected', () => {
    const s = new UserStore(':memory:')
    const ms = memMappingStore()
    importBundle(nbBundle(), { ...deps(s), mappingStore: ms, genMappingId: () => 'map_imp' })
    expect(ms.saved).toHaveLength(1)
    expect(ms.saved[0].right.path).toBe('')
    expect(ms.saved[0].autoSync).toBe(false)
    expect(ms.saved[0].matchSpec?.version).toBe(2)
    expect(ms.saved[0].entries).toHaveLength(1)
    s.close()
  })

  it('导入零执行：只 save，无 sync/rebind/listDir', () => {
    const s = new UserStore(':memory:')
    const calls: string[] = []
    const ms = { get: () => undefined, save: () => { calls.push('save') } }
    const spy = vi.spyOn(globalThis, 'fetch')
    importBundle(mkBundle({ channels: [], streams: [], providers: [], netdiskBindings: [{ left: { kind: 'tmdb', id: '1', media: 'movie', title: 'X' } }] }), { ...deps(s), mappingStore: ms })
    expect(calls).toEqual(['save'])
    expect(spy).not.toHaveBeenCalled()
    s.close()
  })

  it('id 撞车 remap：mappingStore 已有同 id → 换新 id', () => {
    const s = new UserStore(':memory:')
    let n = 0
    const ms = { saved: [] as MappingSet[], get: (id: string) => (id === 'map_imp' ? ({ id } as MappingSet) : undefined), save(x: MappingSet) { this.saved.push(x) } }
    importBundle(nbBundle(), { ...deps(s), mappingStore: ms, genMappingId: () => (n++ === 0 ? 'map_imp' : 'map_fresh') })
    expect(ms.saved[0].id).not.toBe('map_imp')
    s.close()
  })

  it('run 回待转存清单（id/title/shareUrl）', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle({ channels: [], streams: [], providers: [], netdiskBindings: [{
      left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权游' }, shareUrl: 'https://pan.quark.cn/s/abc',
    }] }), { ...deps(s), mappingStore: memMappingStore(), genMappingId: () => 'map_imp' })
    expect(r.netdiskBindings).toEqual([{ id: 'map_imp', title: '权游', shareUrl: 'https://pan.quark.cn/s/abc' }])
    s.close()
  })

  it('stream-left 缺 stream → notice，不静默', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle({ channels: [], streams: [], providers: [], netdiskBindings: [{ left: { kind: 'stream', streamId: 's-gone', title: '某剧' } }] }), { ...deps(s), mappingStore: memMappingStore() })
    expect(r.items.some((i) => i.kind === 'notice' && i.detail.includes('s-gone'))).toBe(true)
    s.close()
  })

  it('未接 AList 但包含 netdisk binding → notice 跳过', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle({ channels: [], streams: [], providers: [], netdiskBindings: [{ left: { kind: 'tmdb', id: '1', media: 'movie', title: 'X' } }] }), deps(s))
    expect(notices(r.items).some((i) => reason(i) === 'netdisk-unavailable')).toBe(true)
    expect(r.netdiskBindings).toEqual([])
    s.close()
  })

  it('无 netdiskBindings 的包：清单为空数组（v1/A 兼容）', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle(), { ...deps(s), mappingStore: memMappingStore() })
    expect(r.netdiskBindings).toEqual([])
    s.close()
  })

  it('pending 集的 entries 不以 confirmed/auto 入库（否则空 dirPath 污染播放索引）', () => {
    const s = new UserStore(':memory:')
    const ms = memMappingStore()
    importBundle(nbBundle(), { ...deps(s), mappingStore: ms, genMappingId: () => 'map_imp' })
    for (const e of ms.saved[0].entries) {
      expect(['confirmed', 'auto']).not.toContain(e.status)
    }
    expect(ms.saved[0].entries[0].corrected).toBeTruthy()
    s.close()
  })
})

// §7.3 兜底：**旧** bundle 里的成员写的是裸名（新 bundle 由导出端写全名）。裸名在对面机器上
// 可能对应多个同名候选——不静默挑一个（那是最贵的静默失真），也不让整份导入失败。
describe('导入期的裸名解析', () => {
  const bare = () => mkBundle({
    streams: [{ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'custom', source: 'fetch-url', params: {} }], options: {} }],
  })

  it('唯一命中 → 成员就地改写成全名', () => {
    const s = new UserStore(':memory:')
    importBundle(bare(), { ...deps(s), resolveSource: () => '@streamapp/builtin/fetch-url' })
    expect(s.getStream('s1')!.members[0].source).toBe('@streamapp/builtin/fetch-url')
    s.close()
  })

  it('解析不到 → 原样落库（运行时再由 registry 现解析，与命名空间化之前一致）', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(bare(), { ...deps(s), resolveSource: () => undefined })
    expect(s.getStream('s1')!.members[0].source).toBe('fetch-url')
    expect(r.items.filter((i) => i.kind === 'source-ambiguous')).toEqual([])
    s.close()
  })

  it('歧义 → 落一条 open item（候选全名进 choices），成员先按原样落库', () => {
    const s = new UserStore(':memory:')
    const candidates = ['a-pkg/fetch-url', 'b-pkg/fetch-url']
    const r = importBundle(bare(), {
      ...deps(s),
      resolveSource: () => { throw Object.assign(new Error('ambiguous'), { candidates }) },
    })
    const item = r.items.find((i) => i.kind === 'source-ambiguous')!
    expect(item.status).toBe('open')
    expect(item.choices).toEqual([...candidates, 'dismiss'])
    expect(item.detail).toContain('a-pkg/fetch-url')
    // 拍板之前不猜：成员保持裸名。
    expect(s.getStream('s1')!.members[0].source).toBe('fetch-url')
    s.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 活体 2026-09-05：给另一台机分享一条播客流（stream-rooted，包里 channels: []）。
// 导入回 201 + 一个正常的 run，`streams` 表里确实有那一行——然后 `GET /api/streams`
// 看不见它、refresh 报 not_found、**重启之后它就没了**。整条路上没有一处会喊。
// ─────────────────────────────────────────────────────────────────────────────
describe('落库即孤儿：没有频道引用的流必须说出来，不许报一次干净的成功', () => {
  const onlyStream = () => mkBundle({ channels: [] })

  it('stream-rooted 包（channels 为空）→ 落一条 stream-unchanneled', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(onlyStream(), deps(s))
    // 行确实写进去了——这正是最坑人的地方：数据没错，缺的只有归属。
    expect(s.getStream('s1')).toBeTruthy()
    const n = notices(r.items).filter((i) => reason(i) === 'stream-unchanneled')
    expect(n).toHaveLength(1)
    expect((n[0]!.subject as { streamId?: string }).streamId).toBe('s1')
    // 说清后果，不是只报一个状态：用户要能从这句话知道"它不会被采集、重启就没了"。
    expect(n[0]!.detail).toContain('不会被采集')
    s.close()
  })

  it('包里带着频道引用它 → 不落这条 notice（默认那条路本来就是对的）', () => {
    const s = new UserStore(':memory:')
    const r = importBundle(mkBundle(), deps(s))
    expect(notices(r.items).filter((i) => reason(i) === 'stream-unchanneled')).toHaveLength(0)
    s.close()
  })

  // 判据必须看**导入结束后的最终状态**：id 撞车 remap 之后，频道里写的是新 id。
  // 拿包里那个旧 id 去问会全部误报。
  it('id 撞车 remap 之后仍不误报——问的是 remap 后那个 id', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'OLD', strategy: 'fanout', cadence_seconds: 999, members: [], options: {} })
    const r = importBundle(mkBundle(), deps(s))
    expect(r.remaps['s1']).toBeDefined()
    expect(notices(r.items).filter((i) => reason(i) === 'stream-unchanneled')).toHaveLength(0)
    s.close()
  })

  // 本机已有同一条流、且已经归在某个频道下：归属是本机既有的，不归这次导入管。
  it('复用本机同源流 → 不落这条 notice', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    s.putChannel({ id: 'local', label: '本机', present: 'timeline', stream_ids: ['s1'], options: {} })
    const r = importBundle(onlyStream(), deps(s))
    expect(notices(r.items).filter((i) => reason(i) === 'stream-unchanneled')).toHaveLength(0)
    s.close()
  })
})
