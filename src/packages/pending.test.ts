import { describe, it, expect } from 'vitest'
import { diffLoadedVsDisk, type LoadedPackage } from './pending.ts'

const slots = (over: Partial<LoadedPackage['slots']> = {}): LoadedPackage['slots'] =>
  ({ recipes: false, code: false, capability: false, backend: false, credentials: false, ...over })
const pkg = (name: string, version: string, over: Partial<LoadedPackage> = {}): LoadedPackage =>
  ({ name, version, slots: slots(), ...over })

describe('diffLoadedVsDisk — 启动快照 vs 盘上现状', () => {
  it('完全一致 → 空', () => {
    const a = [pkg('@streamapp/xhs', '1.0.0', { slots: slots({ recipes: true }) })]
    expect(diffLoadedVsDisk(a, a)).toEqual([])
  })
  it('新装纯 recipe 包 → installed，不需要重启（源立刻生效）', () => {
    const d = [pkg('@streamapp/xhs', '1.0.0', { slots: slots({ recipes: true }) })]
    expect(diffLoadedVsDisk([], d)).toEqual([
      { name: '@streamapp/xhs', kind: 'installed', to: '1.0.0', needsRestart: false, why: 'recipe 数据已热生效' },
    ])
  })
  it('新装带代码 / 能力 / 容器的包 → 要重启', () => {
    const d = [
      pkg('@streamapp/netease', '1.0.0', { slots: slots({ code: true }) }),
      pkg('@scope/demo-capability', '0.2.0', { slots: slots({ capability: true }) }),
      pkg('@streamapp/mineru', '1.0.1', { slots: slots({ backend: true }), image: 'ghcr.io/jaggerh/mineru-server:1.0.1' }),
    ]
    const out = diffLoadedVsDisk([], d)
    expect(out.map((c) => [c.name, c.needsRestart, c.why])).toEqual([
      ['@streamapp/netease', true, '代码包要重启才装载'],
      ['@scope/demo-capability', true, '能力包（工具）要重启才挂上'],
      ['@streamapp/mineru', true, '容器要重启后按 ghcr.io/jaggerh/mineru-server:1.0.1 重建'],
    ])
  })
  it('版本变了：纯 recipe 不重启；镜像变了要重启', () => {
    const l = [
      pkg('@streamapp/xhs', '1.0.0', { slots: slots({ recipes: true }) }),
      pkg('@streamapp/mineru', '1.0.0', { slots: slots({ backend: true }), image: 'x:1.0.0' }),
    ]
    const d = [
      pkg('@streamapp/xhs', '1.1.0', { slots: slots({ recipes: true }) }),
      pkg('@streamapp/mineru', '1.0.1', { slots: slots({ backend: true }), image: 'x:1.0.1' }),
    ]
    expect(diffLoadedVsDisk(l, d)).toEqual([
      { name: '@streamapp/xhs', kind: 'updated', from: '1.0.0', to: '1.1.0', needsRestart: false, why: 'recipe 数据已热生效' },
      { name: '@streamapp/mineru', kind: 'updated', from: '1.0.0', to: '1.0.1', needsRestart: true, why: '容器要重启后按 x:1.0.1 重建' },
    ])
  })
  it('卸载：装载过代码 / 能力 / 容器的要重启（已装载的仍在），纯 recipe 不用；凭证域单独不算（与安装同一把尺）', () => {
    const l = [
      pkg('@streamapp/netease', '1.0.0', { slots: slots({ code: true, credentials: true }) }),
      pkg('@streamapp/xhs', '1.0.0', { slots: slots({ recipes: true }) }),
      pkg('local/creds-only', '1.0.0', { slots: slots({ recipes: true, credentials: true }) }),
    ]
    expect(diffLoadedVsDisk(l, [])).toEqual([
      { name: '@streamapp/netease', kind: 'removed', from: '1.0.0', needsRestart: true, why: '已装载的代码 / 能力 / 容器要重启才卸掉' },
      { name: '@streamapp/xhs', kind: 'removed', from: '1.0.0', needsRestart: false, why: 'recipe 数据已热卸掉' },
      { name: 'local/creds-only', kind: 'removed', from: '1.0.0', needsRestart: false, why: 'recipe 数据已热卸掉' },
    ])
    // 同一个包装上也不要重启——卸载那条路不许比安装严。
    expect(diffLoadedVsDisk([], [l[2]])[0]).toMatchObject({ kind: 'installed', needsRestart: false })
  })
  it('同版本但盘上多了容器槽（手改 package.json）→ updated 且要重启', () => {
    const l = [pkg('local/demo', undefined as never, { slots: slots({ recipes: true }) })]
    const d = [pkg('local/demo', undefined as never, { slots: slots({ recipes: true, backend: true }), image: 'i:1' })]
    expect(diffLoadedVsDisk(l, d)[0]).toMatchObject({ kind: 'updated', needsRestart: true })
  })
})
