import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { UserStore } from '../store/user-store.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { ImportRunStore, type ImportItem, type ImportRun } from './import-run-store.ts'
import { decideImportItem } from './decide.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'

const dirOf = (store: UserStore) => new ProviderDirectory(store, SYSTEM_IDENTITIES)

function mkRuns(): ImportRunStore {
  return new ImportRunStore(join(tmpdir(), `ir-${randomUUID()}.json`))
}
function mkRun(items: ImportItem[]): ImportRun {
  return { id: 'imp-t', at: '2026-07-24T00:00:00.000Z', meta: { title: 'T', revision: '1.0.0' }, remaps: {}, recipeDecisions: {}, netdiskBindings: [], items }
}
function providerRow(id: string, serves: string[], extra: Record<string, unknown> = {}) {
  return { id, label: id, description: '', category: 'resolve' as const, serves, strategy: 'sequential' as const, members: [], contract: null, options: { ...extra } }
}
const noticeItem = (id = 'itm-1'): ImportItem => ({ id, kind: 'notice', status: 'open', subject: { reason: 'missing-plugin' }, choices: ['dismiss'], detail: 'x' })
const parkedItem = (providerId: string, id = 'itm-1'): ImportItem => ({ id, kind: 'parked-provider', status: 'open', subject: { providerId }, choices: ['use-imported', 'keep-mine', 'append', 'dismiss'], detail: 'x' })
const slotItem = (channelId: string, callsiteId: string, mine: string[], theirs: string[], id = 'itm-1'): ImportItem => ({
  id, kind: 'slot-conflict', status: 'open', subject: { channelId, callsiteId },
  mine: { providerIds: mine }, theirs: { providerIds: theirs }, choices: ['keep-mine', 'use-imported', 'dismiss'], detail: 'x',
})

describe('decideImportItem — 通用', () => {
  it('未知 run / item → not_found；非法 choice → invalid_choice；重复拍板 → already_decided', () => {
    const s = new UserStore(':memory:')
    const runs = mkRuns()
    runs.create(mkRun([noticeItem()]))
    const deps = { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) }
    expect(decideImportItem('nope', 'itm-1', 'dismiss', deps)).toMatchObject({ ok: false, code: 'not_found' })
    expect(decideImportItem('imp-t', 'nope', 'dismiss', deps)).toMatchObject({ ok: false, code: 'not_found' })
    expect(decideImportItem('imp-t', 'itm-1', 'use-imported', deps)).toMatchObject({ ok: false, code: 'invalid_choice' })
    expect(decideImportItem('imp-t', 'itm-1', 'dismiss', deps)).toMatchObject({ ok: true })
    expect(decideImportItem('imp-t', 'itm-1', 'dismiss', deps)).toMatchObject({ ok: false, code: 'already_decided' })
    s.close()
  })

  it('notice dismiss → status=dismissed 持久化', () => {
    const s = new UserStore(':memory:')
    const runs = mkRuns()
    runs.create(mkRun([noticeItem()]))
    const r = decideImportItem('imp-t', 'itm-1', 'dismiss', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect(runs.get('imp-t')!.items[0].status).toBe('dismissed')
    expect(runs.get('imp-t')!.items[0].choice).toBe('dismiss')
    s.close()
  })
})

describe('decideImportItem — parked-provider', () => {
  it('use-imported 无冲突 → 激活（parked 清除），item decided', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('imp', ['aliyun-verify'], { parked: true }))
    const runs = mkRuns()
    runs.create(mkRun([parkedItem('imp')]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect(s.getProvider('imp')?.options.parked).toBeUndefined()
    expect(runs.get('imp-t')!.items[0].status).toBe('decided')
    s.close()
  })

  it('keep-mine → provider 保持 parked，item decided（本机路由不变）', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('mine', ['quark-verify']))
    s.putProvider(providerRow('imp', ['quark-verify'], { parked: true }))
    const runs = mkRuns()
    runs.create(mkRun([parkedItem('imp')]))
    const r = decideImportItem('imp-t', 'itm-1', 'keep-mine', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect(s.getProvider('imp')?.options.parked).toBe(true)
    expect(runs.get('imp-t')!.items[0].status).toBe('decided')
    s.close()
  })

  it('候选 binding 应用失败（未知 callsite）→ item 保持 open、detail 带原因、ok=false', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('imp', ['x-verify'], { parked: true, candidateBinding: { callsiteId: 'ghost.callsite' } }))
    const runs = mkRuns()
    runs.create(mkRun([parkedItem('imp')]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r).toMatchObject({ ok: false, code: 'apply_failed' })
    const item = runs.get('imp-t')!.items[0]
    expect(item.status).toBe('open')
    expect(s.getProvider('imp')?.options.parked).toBe(true) // 不半提交
    s.close()
  })

  it('provider 已被删除 → apply_failed、item 保持 open', () => {
    const s = new UserStore(':memory:')
    const runs = mkRuns()
    runs.create(mkRun([parkedItem('gone')]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r).toMatchObject({ ok: false, code: 'apply_failed' })
    expect(runs.get('imp-t')!.items[0].status).toBe('open')
    s.close()
  })

  it('dismiss → 不动 provider（保持 parked），item dismissed', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('imp', ['x'], { parked: true }))
    const runs = mkRuns()
    runs.create(mkRun([parkedItem('imp')]))
    const r = decideImportItem('imp-t', 'itm-1', 'dismiss', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect(s.getProvider('imp')?.options.parked).toBe(true)
    expect(runs.get('imp-t')!.items[0].status).toBe('dismissed')
    s.close()
  })
})

describe('decideImportItem — slot-conflict', () => {
  it('keep-mine → 频道不动，item decided', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('local-p', ['quark-verify']))
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'netdisk.share.verify', ['local-p'], ['their-p'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'keep-mine', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect((s.getChannel('default-video')!.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['local-p'])
    expect(runs.get('imp-t')!.items[0].status).toBe('decided')
    s.close()
  })

  it('use-imported（键内全部非 parked）→ 写 slots 替换本机键，item decided', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('local-p', ['quark-verify']))
    s.putProvider(providerRow('their-p', ['quark-verify']))
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'netdisk.share.verify', ['local-p'], ['their-p'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    expect((s.getChannel('default-video')!.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['their-p'])
    s.close()
  })

  it('use-imported（键内含 parked）→ 落 candidateSlots（不进 slots，激活时搬回），本机 slots 键保留至激活', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('local-p', ['quark-verify']))
    s.putProvider(providerRow('their-p', ['quark-verify'], { parked: true }))
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'netdisk.share.verify', ['local-p'], ['their-p'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    const opts = s.getChannel('default-video')!.options
    expect((opts.candidateSlots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['their-p'])
    expect((opts.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['local-p']) // 激活前本机继续生效
    expect(runs.get('imp-t')!.items[0].status).toBe('decided')
    s.close()
  })

  it('use-imported 时本机键在 candidateSlots → 被移除（防激活时盖掉已拍板结果）', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('mine-parked', ['quark-verify'], { parked: true }))
    s.putProvider(providerRow('their-p', ['quark-verify']))
    s.patchChannel('default-video', { options: { candidateSlots: { 'netdisk.share.verify': ['mine-parked'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'netdisk.share.verify', ['mine-parked'], ['their-p'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r.ok).toBe(true)
    const opts = s.getChannel('default-video')!.options
    expect((opts.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['their-p'])
    expect((opts.candidateSlots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    s.close()
  })

  it('use-imported 但引用的 provider 已消失 → apply_failed、item 保持 open、频道不动', () => {
    const s = new UserStore(':memory:')
    s.putProvider(providerRow('local-p', ['quark-verify']))
    s.patchChannel('default-video', { options: { slots: { 'netdisk.share.verify': ['local-p'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'netdisk.share.verify', ['local-p'], ['gone-p'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r).toMatchObject({ ok: false, code: 'apply_failed' })
    expect((s.getChannel('default-video')!.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['local-p'])
    expect(runs.get('imp-t')!.items[0].status).toBe('open')
    s.close()
  })

  it('use-imported 但 validateSelection 失败（fixed callsite 塞两个 id）→ apply_failed', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ ...providerRow('a', []), category: 'search' as const, serves: ['x'] })
    s.putProvider({ ...providerRow('b', []), category: 'search' as const, serves: ['y'] })
    s.patchChannel('default-video', { options: { slots: { 'search.video': ['a'] } } })
    const runs = mkRuns()
    runs.create(mkRun([slotItem('default-video', 'search.video', ['a'], ['a', 'b'])]))
    const r = decideImportItem('imp-t', 'itm-1', 'use-imported', { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) })
    expect(r).toMatchObject({ ok: false, code: 'apply_failed' })
    expect(runs.get('imp-t')!.items[0].status).toBe('open')
    s.close()
  })
})

describe('decideImportItem — source-ambiguous（旧 bundle 的裸名有多个同名候选）', () => {
  const ambiguousItem = (streamId: string, source: string, candidates: string[], id = 'itm-1'): ImportItem => ({
    id, kind: 'source-ambiguous', status: 'open', subject: { streamId, source },
    theirs: { source, candidates }, choices: [...candidates, 'dismiss'], detail: 'x',
  })
  const streamWith = (source: string) => ({
    id: 's1', label: 'S1', strategy: 'fanout' as const, cadence_seconds: 3600,
    members: [{ plugin: 'custom', source, params: {} }], options: {},
  })

  it('挑一个候选 → 那条流里引用该裸名的成员就地改写成全名', () => {
    const s = new UserStore(':memory:')
    s.putStream(streamWith('fetch-url'))
    const runs = mkRuns()
    runs.create(mkRun([ambiguousItem('s1', 'fetch-url', ['a-pkg/fetch-url', 'b-pkg/fetch-url'])]))
    const deps = { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) }
    expect(decideImportItem('imp-t', 'itm-1', 'b-pkg/fetch-url', deps)).toMatchObject({ ok: true })
    expect(s.getStream('s1')!.members[0].source).toBe('b-pkg/fetch-url')
    s.close()
  })

  it('dismiss → 什么都不动（成员保持裸名，运行时由 registry 现解析）', () => {
    const s = new UserStore(':memory:')
    s.putStream(streamWith('fetch-url'))
    const runs = mkRuns()
    runs.create(mkRun([ambiguousItem('s1', 'fetch-url', ['a-pkg/fetch-url', 'b-pkg/fetch-url'])]))
    const deps = { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) }
    expect(decideImportItem('imp-t', 'itm-1', 'dismiss', deps)).toMatchObject({ ok: true })
    expect(s.getStream('s1')!.members[0].source).toBe('fetch-url')
    s.close()
  })

  // 拍板可能是几天后的事：按**当前库值**改，改不动就如实失败，不半提交。
  it('流已被改过 / 已不存在 → apply_failed，item 保持 open', () => {
    const s = new UserStore(':memory:')
    s.putStream(streamWith('已经换过了'))
    const runs = mkRuns()
    runs.create(mkRun([ambiguousItem('s1', 'fetch-url', ['a-pkg/fetch-url'])]))
    const deps = { runs, store: s, bindings: new ProviderBindings(s, dirOf(s)), directory: dirOf(s) }
    expect(decideImportItem('imp-t', 'itm-1', 'a-pkg/fetch-url', deps)).toMatchObject({ ok: false, code: 'apply_failed' })
    expect(runs.get('imp-t')!.items[0].status).toBe('open')
    s.close()
  })
})
