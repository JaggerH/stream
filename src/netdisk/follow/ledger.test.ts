import { describe, it, expect } from 'vitest'
import { openNetdiskDb } from '../db.ts'
import { ShareLedger, FollowRunLedger } from './ledger.ts'

describe('ShareLedger', () => {
  it('同一分享 upsert 覆盖、按 setId 列出、seenFiles/savedFids 往返', () => {
    const db = openNetdiskDb(':memory:')
    const l = new ShareLedger(db)
    l.upsert({ setId: 's1', netdisk: 'quark', pwdId: 'p1', origin: 'manual', addedAt: '2026-09-03T00:00:00Z', seenFiles: [], savedFids: [] })
    l.upsert({ setId: 's1', netdisk: 'quark', pwdId: 'p1', origin: 'manual', addedAt: '2026-09-03T00:00:00Z', validity: 'alive',
      seenFiles: [{ fid: 'f', token: 't', name: 'a.mkv', size: 1, path: 'S1/a.mkv' }], savedFids: ['f'] })
    l.upsert({ setId: 's2', netdisk: 'quark', pwdId: 'p9', origin: 'search', addedAt: '2026-09-03T00:00:00Z', seenFiles: [], savedFids: [] })
    expect(l.list('s1')).toHaveLength(1)
    expect(l.get('s1', 'quark', 'p1')).toMatchObject({ validity: 'alive', savedFids: ['f'], seenFiles: [{ path: 'S1/a.mkv' }] })
  })

  it('addedAt 完全相同的两条按插入序列出——同一轮里落的分享也不会串位', () => {
    const db = openNetdiskDb(':memory:')
    const l = new ShareLedger(db)
    const at = '2026-09-03T10:00:00Z'
    // 插入序**故意**与主键序相反：只按 added_at 排序时平局会退回主键扫描序，那一档在这里就是红的。
    for (const pwdId of ['p3', 'p1', 'p2']) {
      l.upsert({ setId: 's1', netdisk: 'quark', pwdId, origin: 'manual', addedAt: at, seenFiles: [], savedFids: [] })
    }
    expect(l.list('s1').map((r) => r.pwdId)).toEqual(['p3', 'p1', 'p2'])
  })
})

describe('FollowRunLedger', () => {
  it('append 回带 id，recent 新的在前、按 setId 过滤', () => {
    const db = openNetdiskDb(':memory:')
    const l = new FollowRunLedger(db)
    const base = { setId: 's1', trigger: 'scheduled' as const, missingAired: [], revisited: [], saved: [], synced: { matchedBefore: 0, matchedAfter: 0 }, errors: [] }
    l.append({ ...base, at: '2026-09-03T01:00:00Z' })
    const b = l.append({ ...base, at: '2026-09-03T02:00:00Z' })
    l.append({ ...base, setId: 's2', at: '2026-09-03T03:00:00Z' })
    expect(b.id).toMatch(/^fr_/)
    expect(l.recent('s1').map((r) => r.at)).toEqual(['2026-09-03T02:00:00Z', '2026-09-03T01:00:00Z'])
  })
})
