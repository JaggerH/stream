import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { StoryFoldStore } from './store.ts'
import type { IndexRow } from './inbox.ts'

const row = (o: Partial<IndexRow> & { itemId: string; streamId: string }): IndexRow => ({
  title: o.itemId, titleFold: o.itemId, ts: '2026-08-13T00:00:00Z', ...o,
})

const store = () => new StoryFoldStore(':memory:')

describe('StoryFoldStore — 候选网（只缩范围，不下结论）', () => {
  /** 同期之外的一条，用来验"时长/链接"那两条支路真的在起作用。 */
  const old = (o: { itemId: string; streamId: string; durationS?: number; urlKey?: string }) =>
    row({ ...o, ts: '2026-06-01T00:00:00Z' })

  it('时长对得上的捞进来（音视频那条入口）', () => {
    const s = store()
    s.index(old({ itemId: 'same-dur', streamId: 's1', durationS: 96 }))
    s.index(old({ itemId: 'other-dur', streamId: 's3', durationS: 300 }))
    const n = s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 96 }), 365, 1)
    expect(n.map((r) => r.itemId)).toEqual(['same-dur'])
  })

  it('容差之内算对得上', () => {
    const s = store()
    s.index(old({ itemId: 'a', streamId: 's1', durationS: 97 }))
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 96 }), 365, 1)).toHaveLength(1)
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 94 }), 365, 1)).toHaveLength(0)
  })

  it('**同期发布的也捞进来**——纯文字内容没有时长，这是它唯一的入口', () => {
    const s = store()
    s.index(row({ itemId: 'same-day', streamId: 's1', ts: '2026-08-13T06:00:00Z' }))
    s.index(old({ itemId: 'long-ago', streamId: 's2' }))
    const n = s.neighbors(row({ itemId: 'x', streamId: 'sx', ts: '2026-08-13T00:00:00Z' }), 365, 1)
    expect(n.map((r) => r.itemId)).toEqual(['same-day'])
  })

  it('同一个 Stream 的不算近邻——它自己的两条永远不该归堆', () => {
    const s = store()
    s.index(row({ itemId: 'a', streamId: 's1', durationS: 96 }))
    expect(s.neighbors(row({ itemId: 'x', streamId: 's1', durationS: 96 }), 14, 1)).toHaveLength(0)
  })

  it('时间窗外的不看', () => {
    const s = store()
    s.index(row({ itemId: 'old', streamId: 's1', durationS: 96, ts: '2026-01-01T00:00:00Z' }))
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 96 }), 14, 1)).toHaveLength(0)
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 96 }), 400, 1)).toHaveLength(1)
  })

  it('同链接的捞进来（哪怕隔了很久）', () => {
    const s = store()
    s.index(row({ itemId: 'a', streamId: 's1', urlKey: 'x.com/1', ts: '2026-06-01T00:00:00Z' }))
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', urlKey: 'x.com/1' }), 365, 1)).toHaveLength(1)
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx' }), 365, 1)).toHaveLength(0)
  })

  it('**老库自动补列**：先建一张没有文本列的旧表，再开 store 就该能用', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE story_index (
      item_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, author TEXT, duration_s INTEGER,
      title_fold TEXT NOT NULL, title TEXT NOT NULL, url_key TEXT, ts TEXT NOT NULL)`)
    db.prepare(
      `INSERT INTO story_index (item_id, stream_id, title_fold, title, ts) VALUES ('old','s1','x','x','2026-08-13T00:00:00Z')`,
    ).run()
    const s = new StoryFoldStore(db)
    // 补列之前这三句都会抛：neighbors 的 SELECT 点名 text_sig、setText 要写它。
    // 活体卡住那次正是 neighbors 每条都抛、每条都被 defer，而异常被逐条吞掉、一条日志都没有。
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx' }), 365, 1)).toBeDefined()
    expect(s.row('old')!.textSig).toBeUndefined()
    s.setText('old', [1, 2], 'inline')
    expect(s.row('old')!.textSig).toEqual([1, 2])
  })

  it('文本草图存了就读得回来（判据全靠它）', () => {
    const s = store()
    s.index(row({ itemId: 'a', streamId: 's1' }))
    expect(s.row('a')!.textSig).toBeUndefined()
    s.setText('a', [1, 2, 3], 'stt')
    expect(s.row('a')!.textSig).toEqual([1, 2, 3])
    expect(s.row('a')!.textSource).toBe('stt')
  })

  it('**重新采集不会抹掉已取到的文本**——否则每轮都要重花一次转写的钱', () => {
    const s = store()
    s.index(row({ itemId: 'a', streamId: 's1' }))
    s.setText('a', [1, 2, 3], 'stt')
    s.index(row({ itemId: 'a', streamId: 's1', title: '标题被改了' }))
    expect(s.row('a')!.textSig).toEqual([1, 2, 3])
  })

  it('重复索引同一条是幂等的（重新采集会覆盖）', () => {
    const s = store()
    s.index(row({ itemId: 'a', streamId: 's1', durationS: 96 }))
    s.index(row({ itemId: 'a', streamId: 's1', durationS: 120 }))
    expect(s.neighbors(row({ itemId: 'x', streamId: 'sx', durationS: 120 }), 14, 1)).toHaveLength(1)
  })
})

describe('StoryFoldStore — 归属', () => {
  const why = [{ kind: 'text-identity' as const, score: 0.9, detail: '正文几乎一样' }]

  it('并进对方的堆，理由跟着走', () => {
    const s = store()
    const gid = s.join('b', 'a', why)
    expect(gid).toBe('a')
    expect(s.membership('b')?.why[0].detail).toBe('正文几乎一样')
  })

  it('**代表是发布最早的那条**，不是先被采到的那条', () => {
    const s = store()
    s.index(row({ itemId: 'late', streamId: 's1', ts: '2026-08-13T10:00:00Z' }))
    s.index(row({ itemId: 'early', streamId: 's2', ts: '2026-08-13T08:00:00Z' }))
    s.join('early', 'late', why) // 后采到的是首发
    expect(s.membership('early')?.isRep).toBe(true)
    expect(s.membership('late')?.isRep).toBe(false)
  })

  it('更早的一条后来才并进来 → 门面换给它', () => {
    const s = store()
    s.index(row({ itemId: 'b', streamId: 's1', ts: '2026-08-13T10:00:00Z' }))
    s.index(row({ itemId: 'c', streamId: 's2', ts: '2026-08-13T11:00:00Z' }))
    s.join('c', 'b', why)
    expect(s.membership('b')?.isRep).toBe(true)
    s.index(row({ itemId: 'a', streamId: 's3', ts: '2026-08-13T06:00:00Z' }))
    s.join('a', 'b', why)
    expect(s.membership('a')?.isRep).toBe(true)
    expect(s.membership('b')?.isRep).toBe(false)
  })

  it('拆掉的正好是门面 → 首发顺位给下一个，堆不会没有门面', () => {
    const s = store()
    for (const [id, ts] of [['a', '06'], ['b', '08'], ['c', '10']] as const) {
      s.index(row({ itemId: id, streamId: `s-${id}`, ts: `2026-08-13T${ts}:00:00Z` }))
    }
    s.join('b', 'a', why)
    s.join('c', 'a', why)
    expect(s.membership('a')?.isRep).toBe(true)
    s.unfold('a')
    expect(s.group('a').filter((m) => m.isRep)).toHaveLength(1)
    expect(s.membership('b')?.isRep).toBe(true)
  })

  it('第三条并进已有的堆，堆不分裂', () => {
    const s = store()
    s.join('b', 'a', why)
    s.join('c', 'b', why)
    expect(s.group('a').map((m) => m.itemId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('批量取归属——投影层一次拿一屏', () => {
    const s = store()
    s.join('b', 'a', why)
    const m = s.membershipsFor(['a', 'b', 'zzz'])
    expect([...m.keys()].sort()).toEqual(['a', 'b'])
  })
})

describe('StoryFoldStore — 源对与领先度（「来源」在归堆之后唯一的作用）', () => {
  it('并过几次自己攒出来，不问用户', () => {
    const s = store()
    expect(s.pairFolds('s1', 's2')).toBe(0)
    s.recordPair({ streamId: 's1', ts: '2026-08-13T08:00:00Z' }, { streamId: 's2', ts: '2026-08-13T09:00:00Z' })
    s.recordPair({ streamId: 's2', ts: '2026-08-13T09:00:00Z' }, { streamId: 's1', ts: '2026-08-13T08:00:00Z' })
    expect(s.pairFolds('s1', 's2')).toBe(2)
    expect(s.pairFolds('s2', 's1')).toBe(2) // 与顺序无关
  })

  it('领先次数与平均领先时长：只除以领先的那些次', () => {
    const s = store()
    s.recordPair({ streamId: 'fast', ts: '2026-08-13T08:00:00Z' }, { streamId: 'slow', ts: '2026-08-13T08:10:00Z' })
    s.recordPair({ streamId: 'fast', ts: '2026-08-14T08:00:00Z' }, { streamId: 'slow', ts: '2026-08-14T08:30:00Z' })
    const [first, second] = s.leaderboard()
    expect(first).toMatchObject({ streamId: 'fast', leads: 2, behinds: 0, avgLeadS: 1200 }) // (600+1800)/2
    expect(second).toMatchObject({ streamId: 'slow', leads: 0, behinds: 2, avgLeadS: 0 })
  })

  it('互有胜负的两个源各记各的', () => {
    const s = store()
    s.recordPair({ streamId: 'a', ts: '2026-08-13T08:00:00Z' }, { streamId: 'b', ts: '2026-08-13T09:00:00Z' })
    s.recordPair({ streamId: 'a', ts: '2026-08-14T09:00:00Z' }, { streamId: 'b', ts: '2026-08-14T08:00:00Z' })
    const board = s.leaderboard()
    expect(board.find((r) => r.streamId === 'a')).toMatchObject({ leads: 1, behinds: 1 })
    expect(board.find((r) => r.streamId === 'b')).toMatchObject({ leads: 1, behinds: 1 })
  })

  it('没同框过就没有可比性——榜是空的，不是并列第一', () => {
    expect(store().leaderboard()).toEqual([])
  })
})

describe('StoryFoldStore — 人工拆堆', () => {
  const why = [{ kind: 'title-dice' as const, score: 0.9, detail: 'x' }]

  it('拆开之后**记下永不再并**——否则下次采集又给合回去，用户白拆', () => {
    const s = store()
    s.join('b', 'a', why)
    s.unfold('b')
    expect(s.membership('b')).toBeUndefined()
    expect(s.vetoed('a', 'b')).toBe(true)
    expect(s.vetoed('b', 'a')).toBe(true) // 与顺序无关
  })

  it('拆到只剩代表一条 → 整堆撤销（一个人不成堆）', () => {
    const s = store()
    s.join('b', 'a', why)
    s.unfold('b')
    expect(s.membership('a')).toBeUndefined()
  })

  it('三条的堆拆掉一条，剩下两条还是一堆', () => {
    const s = store()
    s.join('b', 'a', why)
    s.join('c', 'a', why)
    s.unfold('c')
    expect(s.group('a')).toHaveLength(2)
  })

  it('没归过堆的条目拆它是无操作，不炸', () => {
    expect(() => store().unfold('nobody')).not.toThrow()
  })
})
