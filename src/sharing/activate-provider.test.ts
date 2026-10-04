import { describe, it, expect } from 'vitest'
import { UserStore } from '../store/user-store.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { activateProvider, type ActivationProblem } from './activate-provider.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'

function mkDeps(store: UserStore) {
  const directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
  const bindings = new ProviderBindings(store, directory)
  const recorded: ActivationProblem[] = []
  const problems = { list: () => recorded, record: (p: ActivationProblem) => { recorded.push(p) } }
  return { store, bindings, directory, problems, bundleMeta: { title: 'T', revision: '1.0.0' } }
}
function parkedRow(id: string, serves: string[], extra: Record<string, unknown> = {}) {
  return { id, label: id, description: '', category: 'resolve' as const, serves, strategy: 'sequential' as const, members: [], contract: null, options: { parked: true, ...extra } }
}

describe('activateProvider', () => {
  it('无 serves 重叠 → 直接清 parked、入 dispatch', () => {
    const s = new UserStore(':memory:')
    s.putProvider(parkedRow('imp', ['aliyun-verify']))
    const d = mkDeps(s)
    const r = activateProvider('imp', d)
    expect(r.status).toBe('activated')
    expect(s.getProvider('imp')?.options.parked).toBeUndefined()
    s.close()
  })

  it('serves 重叠 + 无 decision → conflict、落台账、parked 不清、dispatch 不变', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider(parkedRow('imp', ['quark-verify']))
    const d = mkDeps(s)
    const r = activateProvider('imp', d)
    expect(r.status).toBe('conflict')
    expect(r.conflicts[0]).toMatchObject({ kind: 'serves-overlap', rivalProviderId: 'mine' })
    expect(s.getProvider('imp')?.options.parked).toBe(true)
    expect(d.problems.list().some((p) => p.kind === 'activation-conflict')).toBe(true)
    s.close()
  })

  it('候选 binding 抢占 callsite → binding-occupied 冲突', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['mine'] })
    s.putProvider(parkedRow('imp', ['zzz-verify'], { candidateBinding: { callsiteId: 'netdisk.share.verify' } }))
    const d = mkDeps(s)
    const r = activateProvider('imp', d)
    expect(r.conflicts.some((c) => c.kind === 'binding-occupied' && c.callsiteId === 'netdisk.share.verify')).toBe(true)
    s.close()
  })

  it('同 category 两条兜底行 → fallback-overlap（具名键都空，键重叠算不出来，但分发里它们真竞争）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['*'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider(parkedRow('imp', ['*']))
    const d = mkDeps(s)
    const r = activateProvider('imp', d)
    expect(r.status).toBe('conflict')
    expect(r.conflicts).toEqual([{ providerId: 'imp', kind: 'fallback-overlap', category: 'resolve', rivalProviderId: 'mine' }])
    expect(s.getProvider('imp')?.options.parked).toBe(true)
    s.close()
  })

  it('一条兜底一条具名 → 不报（兜底档只在具名全不命中时才轮到，两者不抢同一个键）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider(parkedRow('imp', ['*']))
    const d = mkDeps(s)
    expect(activateProvider('imp', d).status).toBe('activated')
    s.close()
  })

  it('两条兜底但跨 category → 不报（match 按 category 先筛，够不着彼此）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'search', serves: ['*'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider(parkedRow('imp', ['*'])) // parkedRow 的 category 是 resolve
    const d = mkDeps(s)
    expect(activateProvider('imp', d).status).toBe('activated')
    s.close()
  })

  it('keep-mine：serves 重叠时保留本机——import 保持 parked，不入 dispatch', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProvider(parkedRow('imp', ['quark-verify']))
    const d = mkDeps(s)
    const r = activateProvider('imp', d, 'keep-mine')
    expect(s.getProvider('imp')?.options.parked).toBe(true) // 仍趴着，没抢 dispatch
    expect(s.listActiveProviders().map((p) => p.id)).toEqual(['mine'])
    expect(r).toBeTruthy()
    s.close()
  })

  it('候选 binding 指向未知 callsite → 不抛不 500、保持 parked（不半提交）', () => {
    const s = new UserStore(':memory:')
    s.putProvider(parkedRow('imp', ['aliyun-verify'], { candidateBinding: { callsiteId: 'no.such.callsite' } }))
    const d = mkDeps(s)
    expect(() => activateProvider('imp', d, 'use-imported')).not.toThrow()
    expect(s.getProvider('imp')?.options.parked).toBe(true) // 未解除，避免半提交（active 但无 binding）
    s.close()
  })

  it('激活后：全部可用的 candidateSlots 键搬回 slots，键清除', () => {
    const s = new UserStore(':memory:')
    s.putProvider(parkedRow('imp', ['quark-verify']))
    s.putChannel({
      id: 'ch1', label: 'CH', present: 'timeline', stream_ids: [], options: {
        candidateSlots: { 'netdisk.share.verify': ['imp'] },
      },
    })
    const d = mkDeps(s)
    const r = activateProvider('imp', d)
    expect(r.status).toBe('activated')
    const ch = s.getChannel('ch1')!
    expect((ch.options.slots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['imp'])
    expect((ch.options.candidateSlots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    s.close()
  })

  it('候选槽位里还有别的 provider 未激活/仍 parked → 该键留在 candidateSlots，不半搬', () => {
    const s = new UserStore(':memory:')
    s.putProvider(parkedRow('imp', ['aliyun-verify']))
    s.putProvider(parkedRow('other', ['aliyun-verify']))
    s.putChannel({
      id: 'ch1', label: 'CH', present: 'timeline', stream_ids: [], options: {
        candidateSlots: { 'netdisk.share.verify': ['imp', 'other'] },
      },
    })
    const d = mkDeps(s)
    activateProvider('imp', d)
    const ch = s.getChannel('ch1')!
    expect((ch.options.slots as Record<string, unknown> | undefined)?.['netdisk.share.verify']).toBeUndefined()
    expect((ch.options.candidateSlots as Record<string, string[]>)['netdisk.share.verify']).toEqual(['imp', 'other'])
    s.close()
  })

  it('激活前搜索走全局默认：candidate 不生效（fixed() 走全局 binding，不读 candidateSlots）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'global', label: 'global', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['global'] })
    s.putProvider(parkedRow('imp', ['quark-verify']))
    s.putChannel({
      id: 'ch1', label: 'CH', present: 'timeline', stream_ids: [], options: {
        candidateSlots: { 'netdisk.share.verify': ['imp'] },
      },
    })
    const d = mkDeps(s)
    expect(d.bindings.fixed('netdisk.share.verify', { channelId: 'ch1' })).toBe('global')
    s.close()
  })

  it('use-imported：清 parked + 候选 binding 写入 provider_bindings（导入行居首）', () => {
    const s = new UserStore(':memory:')
    s.putProvider({ id: 'mine', label: 'mine', description: '', category: 'resolve', serves: ['quark-verify'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putProviderBinding({ callsiteId: 'netdisk.share.verify', providerIds: ['mine'] })
    s.putProvider(parkedRow('imp', ['quark-verify'], { candidateBinding: { callsiteId: 'netdisk.share.verify' } }))
    const d = mkDeps(s)
    const r = activateProvider('imp', d, 'use-imported')
    expect(r.status).toBe('activated')
    expect(s.getProvider('imp')?.options.parked).toBeUndefined()
    expect(s.getProviderBinding('netdisk.share.verify')?.providerIds[0]).toBe('imp')
    s.close()
  })
})
