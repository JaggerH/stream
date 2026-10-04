import { describe, expect, test, vi } from 'vitest'
import {
  claimedShelfFor,
  offlineShelfFor,
  openReconcile,
  showIdFor,
  type OpenReconcileDeps,
  type OpenShow,
  type OpenStream,
} from './open.ts'

function harness(over: Partial<OpenReconcileDeps> & { stream?: Partial<OpenStream> } = {}) {
  const stream: OpenStream = { id: 'lizhi-x', label: '春典JARGON', members: [], ...over.stream }
  const state = {
    members: stream.members,
    bindings: [] as { id: string; left: { kind: string; streamId?: string }; right: { path: string } }[],
    shows: [] as OpenShow[],
    mkdirs: [] as string[],
    removed: [] as string[],
  }
  let seq = 0
  const deps: OpenReconcileDeps = {
    getStream: (id) => (id === stream.id ? { ...stream, members: state.members } : undefined),
    putMembers: (_id, m) => { state.members = m },
    listBindings: () => state.bindings,
    bind: async ({ streamId, dirPath }) => {
      const b = { id: `map_${++seq}`, left: { kind: 'stream', streamId }, right: { path: dirPath } }
      state.bindings.push(b)
      return { id: b.id }
    },
    removeBinding: (id) => {
      state.removed.push(id)
      state.bindings = state.bindings.filter((b) => b.id !== id)
    },
    mkdir: async (p) => { state.mkdirs.push(p) },
    getShows: () => state.shows,
    putShows: (s) => { state.shows = s },
    ...over,
  }
  return { deps, state }
}

const SRC = '/quark/来自：分享/播客付费节目合集/春典 JARGON'

describe('派生地址', () => {
  test('货架跟来源同盘，按约定拼', () => {
    expect(claimedShelfFor(SRC, '春典JARGON')).toBe('/quark/From Stream/春典JARGON/付费')
    expect(offlineShelfFor('/quark/From Stream/春典JARGON/付费')).toBe('/quark/From Stream/春典JARGON/下架')
  })

  test('派生不出来就抛，不给一个半截路径', () => {
    expect(() => claimedShelfFor('', '春典')).toThrow()
    expect(() => claimedShelfFor(SRC, '  ')).toThrow()
  })

  test('show id 撞了加后缀', () => {
    expect(showIdFor('lizhi-user-z7o4v', [])).toBe('lizhi-user-z7o4v')
    expect(showIdFor('lizhi-user-z7o4v', ['lizhi-user-z7o4v'])).toBe('lizhi-user-z7o4v-2')
    expect(showIdFor('!!!', [])).toBe('show')
  })
})

describe('从零开一次', () => {
  test('四步都做了：两个货架目录 / 绑定 / 下架来源 / 配置', async () => {
    const { deps, state } = harness()
    const r = await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })

    expect(state.mkdirs).toEqual(['/quark/From Stream/春典JARGON/付费', '/quark/From Stream/春典JARGON/下架'])
    expect(state.bindings).toHaveLength(1)
    expect(state.members).toEqual([
      { plugin: 'alist', source: 'alist-audio', params: { path: '/quark/From Stream/春典JARGON/下架' } },
    ])
    expect(state.shows).toEqual([
      { id: 'lizhi-x', bindingId: 'map_1', sourceDirs: [SRC], subShows: [], autoExecute: false },
    ])
    expect(r.created).toEqual({ binding: true, offlineSource: true, show: true })
    expect(r.shelves).toEqual({
      claimed: '/quark/From Stream/春典JARGON/付费',
      offline: '/quark/From Stream/春典JARGON/下架',
    })
  })

  // 这一条守的是那个最贵的半成品：绑定建好了、下架来源没补,于是整理照跑,判为下架的文件
  // 搬进一个没人扫的目录——在用户那边就是直接消失。
  test('永远不许只建绑定不补下架来源', async () => {
    const { deps, state } = harness()
    await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })
    expect(state.bindings).toHaveLength(1)
    expect(state.members.some((m) => m.plugin === 'alist')).toBe(true)
  })

  test('永远从「不自动执行」开始', async () => {
    const { deps, state } = harness()
    await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })
    expect(state.shows[0].autoExecute).toBe(false)
  })

  test('订阅不存在 / 一个来源目录都没有 → 抛，不留半个状态', async () => {
    const a = harness()
    await expect(openReconcile(a.deps, { streamId: '不存在', sourceDirs: [SRC] })).rejects.toThrow('订阅不存在')
    expect(a.state.mkdirs).toEqual([])

    const b = harness()
    await expect(openReconcile(b.deps, { streamId: 'lizhi-x', sourceDirs: ['  ', ''] })).rejects.toThrow('来源目录')
    expect(b.state.mkdirs).toEqual([])
  })
})

describe('幂等：模型会把同一句话说两遍', () => {
  test('再开一次复用绑定与 show，来源目录被替换而不是追加', async () => {
    const { deps, state } = harness()
    await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })
    const r = await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: ['/quark/另一堆'] })

    expect(state.bindings).toHaveLength(1)
    expect(state.shows).toHaveLength(1)
    expect(state.shows[0].sourceDirs).toEqual(['/quark/另一堆'])
    expect(r.created).toEqual({ binding: false, offlineSource: false, show: false })
  })

  // 派生地址和用户当初手选的往往不是一个。按约定重新派生 = 把货架搬走,架上的文件全成孤儿。
  test('已有绑定时用它的落地目录当货架，不重新派生', async () => {
    const { deps, state } = harness()
    state.bindings.push({ id: 'map_old', left: { kind: 'stream', streamId: 'lizhi-x' }, right: { path: '/quark/我自己选的/付费' } })
    const r = await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })

    expect(r.bindingId).toBe('map_old')
    expect(r.shelves).toEqual({ claimed: '/quark/我自己选的/付费', offline: '/quark/我自己选的/下架' })
  })

  // putShows 是整份写回。逐字段重建会静默剥掉别人的 identity 覆盖——配置还在、规则悄悄
  // 变回默认,两边单看都正常。类型上看不出这条,只有这条用例守得住。
  test('不碰别人的 show，连它们身上的 identity 覆盖一起原样带回去', async () => {
    const other = {
      id: 'yile', bindingId: 'map_other', sourceDirs: ['/quark/别人的'],
      subShows: [], autoExecute: true, identity: { epNumRegex: '\\d{3}' },
    }
    const { deps, state } = harness()
    state.shows.push(other as never)
    await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })

    expect(state.shows.find((s) => s.id === 'yile')).toEqual(other)
  })

  test('已经挂着网盘目录的订阅不动它——那可能是用户自己指到别处的', async () => {
    const existing = { plugin: 'alist', source: 'alist-audio', params: { path: '/quark/用户自己指的' } }
    const { deps, state } = harness({ stream: { members: [existing] } })
    const r = await openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })

    expect(state.members).toEqual([existing])
    expect(r.created.offlineSource).toBe(false)
  })
})

describe('失败回滚到进来之前', () => {
  test('配置写不进去 → 绑定与成员表都还原', async () => {
    const { deps, state } = harness({
      putShows: () => { throw new Error('两个节目不能认领同一片网盘区域') },
    })
    await expect(openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] }))
      .rejects.toThrow('同一片网盘区域')

    expect(state.bindings).toEqual([])       // 孤儿绑定 → 用户重交会变成双绑定双自动同步
    expect(state.removed).toEqual(['map_1'])
    expect(state.members).toEqual([])        // 幽灵成员 → 一条扫着空目录的来源
  })

  test('复用已有绑定时失败，绝不把别人的绑定删掉', async () => {
    const { deps, state } = harness({ putShows: () => { throw new Error('nope') } })
    state.bindings.push({ id: 'map_old', left: { kind: 'stream', streamId: 'lizhi-x' }, right: { path: '/quark/x/付费' } })
    await expect(openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })).rejects.toThrow('nope')

    expect(state.removed).toEqual([])
    expect(state.bindings).toHaveLength(1)
  })

  // 回滚里再抛会把真正的失败原因盖掉——排查时最要命的就是这个。
  test('回滚自己出错也要让原始错误浮上来', async () => {
    const { deps } = harness({
      putShows: () => { throw new Error('真正的原因') },
      removeBinding: () => { throw new Error('回滚也炸了') },
    })
    await expect(openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })).rejects.toThrow('真正的原因')
  })

  test('建目录就失败 → 什么都没建过', async () => {
    const bind = vi.fn()
    const { deps, state } = harness({ mkdir: async () => { throw new Error('AList 不通') }, bind: bind as never })
    await expect(openReconcile(deps, { streamId: 'lizhi-x', sourceDirs: [SRC] })).rejects.toThrow('AList 不通')
    expect(bind).not.toHaveBeenCalled()
    expect(state.shows).toEqual([])
  })
})
