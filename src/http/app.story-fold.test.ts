import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHttpApiFixture, item } from './__fixtures__/app-harness.ts'
import { StoryFoldStore } from '../story-fold/store.ts'

let h: ReturnType<typeof createHttpApiFixture>
let storyFold: StoryFoldStore

beforeEach(() => {
  h = createHttpApiFixture()
  storyFold = new StoryFoldStore(':memory:')
})
afterEach(() => {
  storyFold.close()
  h.close()
})

const app = () => h.build(undefined, { storyFold })
const why = [{ kind: 'text-identity' as const, score: 0.9, detail: '正文几乎一样（0.90）' }]

type Listed = { id: string; storyGroup?: { id: string; isRep: boolean; size: number; why: unknown[] } }
const list = async (built = app()): Promise<Listed[]> =>
  (await (await built.request('/api/items?stream=s1')).json()) as Listed[]

describe('/api/items 带上归堆标记', () => {
  it('归过堆的条目带 storyGroup，**成员条照发不隐藏**', async () => {
    h.store.addMany([item('a', 's1'), item('b', 's1')], 'post')
    storyFold.join('b', 'a', why)
    const items = await list()
    // 两条都在 —— 折不折是前端的事；后端少发一条就等于替用户决定他看不到什么。
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b'])
    const rep = items.find((i) => i.id === 'a')!
    const member = items.find((i) => i.id === 'b')!
    expect(rep.storyGroup).toEqual({ id: 'a', isRep: true, size: 2, why: [] })
    expect(member.storyGroup?.isRep).toBe(false)
    expect(member.storyGroup?.why).toHaveLength(1) // 凭什么并的，一路带到前端
  })

  it('没归过堆的条目不带这个字段（绝大多数条目走这条路）', async () => {
    h.store.addMany([item('solo', 's1')], 'post')
    expect((await list()).find((i) => i.id === 'solo')!.storyGroup).toBeUndefined()
  })

  it('没接账本时列表完全不受影响（纯附加能力）', async () => {
    h.store.addMany([item('a', 's1')], 'post')
    expect(await list(h.build())).toHaveLength(1)
  })
})

describe('拆堆', () => {
  it('拆开之后不再带标记，而且**记下永不再并**', async () => {
    h.store.addMany([item('a', 's1'), item('b', 's1')], 'post')
    storyFold.join('b', 'a', why)
    const res = await app().request('/api/story-fold/b', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(storyFold.vetoed('a', 'b')).toBe(true)
    expect((await list()).every((i) => i.storyGroup === undefined)).toBe(true)
  })

  it('展开一个堆看都有谁', async () => {
    storyFold.join('b', 'a', why)
    const body = await (await app().request('/api/story-fold/a')).json() as { members: Array<{ itemId: string }> }
    expect(body.members.map((m) => m.itemId).sort()).toEqual(['a', 'b'])
  })

  it('没接账本 → 503（而不是假装拆成功了）', async () => {
    expect((await h.build().request('/api/story-fold/x', { method: 'DELETE' })).status).toBe(503)
  })
})

describe('谁在同质内容上持续先发', () => {
  it('按领先次数排，带平均领先多久', async () => {
    storyFold.recordPair({ streamId: 'fast', ts: '2026-08-13T08:00:00Z' }, { streamId: 'slow', ts: '2026-08-13T08:10:00Z' })
    const body = await (await app().request('/api/story-fold/leaderboard')).json() as {
      sources: Array<{ streamId: string; leads: number; behinds: number; avgLeadS: number }>
    }
    expect(body.sources[0]).toMatchObject({ streamId: 'fast', leads: 1, behinds: 0, avgLeadS: 600 })
  })

  it('没同框过的源之间没有可比性 → 空榜', async () => {
    const body = await (await app().request('/api/story-fold/leaderboard')).json() as { sources: unknown[] }
    expect(body.sources).toEqual([])
  })

  it('没接账本 → 503', async () => {
    expect((await h.build().request('/api/story-fold/leaderboard')).status).toBe(503)
  })
})
