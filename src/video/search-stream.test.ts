import { describe, it, expect } from 'vitest'
import type { SearchGroup } from './search-groups.ts'
import type { VideoSearchEvent } from './types.ts'
import { videoSearchStream, type SearchStreamDeps } from './search-stream.ts'

const group = (source_id: string): SearchGroup => ({ source_id, provider: false, physicalParams: {} })

/** 记下 groups 函数收到的 providerId 实参（含「一次都没传」的 undefined），其余依赖走最省的假身。 */
function harness(opts: {
  groups?: (providerId?: string) => SearchGroup[]
  meta?: SearchStreamDeps['searchMetaBySourceId']
  runOne?: SearchStreamDeps['searchOneGroup']
} = {}) {
  const calls: Array<string | undefined> = []
  const meta = opts.meta ?? (() => undefined)
  const deps: SearchStreamDeps = {
    resourceSearchGroups: (providerId) => {
      calls.push(providerId)
      return opts.groups ? opts.groups(providerId) : [group('pansou')]
    },
    searchMetaBySourceId: meta,
    searchOneGroup:
      opts.runOne ?? (async () => ({ part: { shows: [], loose: [] }, timing: { ms: 0, count: 0, dropped: 0, status: 'empty' } })),
  }
  return { deps, calls }
}

async function drain(gen: AsyncGenerator<VideoSearchEvent>): Promise<VideoSearchEvent[]> {
  const out: VideoSearchEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/** 流式资源搜索的 generator。承重条是第一组：`opts.providerId` 必须原样转发给 groups 函数——
 *  这一跳被改回无参调用时，HTTP 层（假 generator）和 search-groups（不经 generator）两头的测试
 *  都照样全绿，线上却退回「换了 Provider 等于没换」。 */
describe('videoSearchStream', () => {
  describe('providerId 转发', () => {
    it('把 opts.providerId 原样传给 resourceSearchGroups', async () => {
      const { deps, calls } = harness()
      await drain(videoSearchStream(deps, 'q', { providerId: 'nsfw-search' }))
      expect(calls).toEqual(['nsfw-search'])
    })

    it('没给 providerId 时传 undefined（由 groups 函数自己兜到全局行，不在这里硬编码行名）', async () => {
      const { deps, calls } = harness()
      await drain(videoSearchStream(deps, 'q', {}))
      expect(calls).toEqual([undefined])
      const bare = harness()
      await drain(videoSearchStream(bare.deps, 'q'))
      expect(bare.calls).toEqual([undefined])
    })

    it('换一个行 id 就换一套扇出成员（转发丢了这条会塌）', async () => {
      const rows: Record<string, SearchGroup[]> = {
        'resource-search': [group('pansou')],
        'nsfw-search': [group('zuna-dl'), group('toubiec-dl')],
      }
      const { deps } = harness({ groups: (id) => rows[id ?? 'resource-search'] ?? [] })
      const events = await drain(videoSearchStream(deps, 'q', { providerId: 'nsfw-search' }))
      const init = events[0]
      expect(init.type).toBe('init')
      expect(init.type === 'init' && init.sources.map((s) => s.key)).toEqual(['zuna-dl', 'toubiec-dl'])
    })
  })

  describe('事件形状', () => {
    it('init 先发，sources 用 meta 的 key/label/searchUrl，未登记的源退回 source_id', async () => {
      const { deps } = harness({
        groups: () => [group('pansou'), group('unknown-src')],
        meta: (sourceId) =>
          sourceId === 'pansou'
            ? { source_id: 'pansou', key: '盘搜', label: '盘搜聚合', param: 'keyword', kind: 'download', nsfw: false, searchUrl: (q: string) => `https://example.com/s?q=${q}` }
            : undefined,
      })
      const events = await drain(videoSearchStream(deps, 'ip man', { providerId: 'resource-search' }))
      expect(events[0]).toEqual({
        type: 'init',
        sources: [
          { key: '盘搜', label: '盘搜聚合', searchUrl: 'https://example.com/s?q=ip man' },
          { key: 'unknown-src', label: 'unknown-src', searchUrl: undefined },
        ],
      })
      expect(events.at(-1)).toEqual({ type: 'done' })
    })

    it('source 事件按完成序发（先到先得，不是声明序）', async () => {
      const delays: Record<string, number> = { slow: 30, fast: 1 }
      const { deps } = harness({
        groups: () => [group('slow'), group('fast')],
        runOne: async (g) => {
          await new Promise((r) => setTimeout(r, delays[g.source_id] ?? 0))
          return { part: { shows: [], loose: [] }, timing: { ms: 0, count: 1, dropped: 0, status: 'ok' } }
        },
      })
      const events = await drain(videoSearchStream(deps, 'q', {}))
      expect(events.filter((e) => e.type === 'source').map((e) => (e.type === 'source' ? e.key : ''))).toEqual([
        'fast',
        'slow',
      ])
    })
  })

  /** 身份归上层：generator 在 init 那一步给每个源发一个**下标**，派活记下标、回来按下标销号。
   *  下游只量数据（part + 耗时/条数/状态），不自称叫什么——所以「建表的名字」和「销号的名字」
   *  这两个概念根本不存在，对不上的可能性是被结构消掉的，不是被防御拦住的。 */
  describe('身份由上层发下标，不由下游自称', () => {
    it('两个源撞同一个展示 key，两个都要发出来（按 key 建表会静默吞掉一个）', async () => {
      // meta 表把两个 source_id 配成了同一个展示名——现实里配重了就会这样。
      // 旧模型用 key 当 Map 键：后一条覆盖前一条，pending 只剩 1 项，另一个源跑完了却永远发不出去，
      // 而且不报错、不卡住，就是少一个源的结果。
      const { deps } = harness({
        groups: () => [group('a-dl'), group('b-dl')],
        meta: (sourceId) => ({ source_id: sourceId, key: '同名', label: '同名', param: 'keyword', kind: 'download', nsfw: false }),
      })
      const events = await drain(videoSearchStream(deps, 'q', {}))
      expect(events.filter((e) => e.type === 'source')).toHaveLength(2)
    })

    it('对外的 key/label 一律取自 init 那张表，下游只报数不报名', async () => {
      const { deps } = harness({
        groups: () => [group('pansou')],
        meta: () => ({ source_id: 'pansou', key: '盘搜', label: '盘搜聚合', param: 'keyword', kind: 'download', nsfw: false }),
        runOne: async () => ({ part: { shows: [], loose: [] }, timing: { ms: 12, count: 3, dropped: 1, status: 'ok' } }),
      })
      const events = await drain(videoSearchStream(deps, 'q', {}))
      const ev = events.find((e) => e.type === 'source')
      expect(ev).toEqual({
        type: 'source',
        key: '盘搜',
        part: { shows: [], loose: [] },
        timing: { key: '盘搜', label: '盘搜聚合', ms: 12, count: 3, dropped: 1, status: 'ok' },
      })
    })
  })

  /** generator 自己的活性保障：不把「会不会一直等下去」外包给依赖的自觉。 */
  describe('总预算', () => {
    it('到点还没回来的源按 timeout 发出去，然后收工——不接着等', async () => {
      const { deps } = harness({
        groups: () => [group('fast'), group('never')],
        runOne: async (g) =>
          g.source_id === 'never'
            ? new Promise(() => {}) // 永不 settle
            : { part: { shows: [], loose: [] }, timing: { ms: 1, count: 2, dropped: 0, status: 'ok' } },
      })
      const events = await drain(videoSearchStream(deps, 'q', { budgetMs: 20 }))
      const sources = events.filter((e) => e.type === 'source')
      expect(sources.map((e) => (e.type === 'source' ? [e.key, e.timing.status] : []))).toEqual([
        ['fast', 'ok'],
        ['never', 'timeout'],
      ])
      expect(events.at(-1)).toEqual({ type: 'done' })
    })
  })
})
