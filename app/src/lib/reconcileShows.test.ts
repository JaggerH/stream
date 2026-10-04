import { describe, it, expect } from 'vitest'
import { showsForStream } from './reconcileShows.ts'
import type { MappingSet, ReconcileShowConfig } from './types.ts'

const show = (id: string, bindingId: string): ReconcileShowConfig =>
  ({ id, label: id, bindingId, sourceDirs: [], subShows: [], autoExecute: false })
const bind = (id: string, streamId: string): MappingSet =>
  ({ id, left: { kind: 'stream', streamId, title: id }, right: { kind: 'alist-dir', path: '/x', boundAt: '' }, rightHistory: [], autoSync: false, entries: [] }) as never

describe('showsForStream — 整理配置归哪条订阅', () => {
  const bindings = [bind('map_a', 's1'), bind('map_b', 's2')]
  const shows = [show('yile', 'map_a'), show('chundian', 'map_b')]

  // 归属只能绕道绑定：整理配置本身不记 streamId。
  it('按 show → bindingId → binding.left.streamId 归属', () => {
    expect(showsForStream(shows, bindings, 's1').map((s) => s.id)).toEqual(['yile'])
    expect(showsForStream(shows, bindings, 's2').map((s) => s.id)).toEqual(['chundian'])
  })

  it('绑定还没取到（空数组）→ 一条都不算它的，绝不回落成「全都算」', () => {
    expect(showsForStream(shows, [], 's1')).toEqual([])
  })

  // 绑定被删了但整理配置还在（真出现过：向导失败留下的残渣）——那条 show 不该挂到任何订阅名下。
  it('bindingId 指向一条已经不存在的绑定 → 不归任何订阅', () => {
    expect(showsForStream([show('orphan', 'map_没了')], bindings, 's1')).toEqual([])
  })
})
