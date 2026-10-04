import { describe, it, expect } from 'vitest'
import { openNetdiskDb } from '../db.ts'
import { PendingShareLedger, PENDING_SHARE_TTL_MS } from './pending-shares.ts'

const T0 = new Date('2026-09-04T10:00:00Z')
const row = (over: Partial<Parameters<PendingShareLedger['record']>[0]> = {}) => ({
  netdisk: 'quark', pwdId: 'p1', dirPath: '/quark/From Stream/tv-1', savedAt: T0.toISOString(), ...over,
})

describe('PendingShareLedger', () => {
  it('落地目录命中就领走，领过就不在了（认领是一次性的，不是只读查询）', () => {
    const l = new PendingShareLedger(openNetdiskDb(':memory:'))
    l.record(row({ passcode: 'abcd' }))
    expect(l.claim('/quark/From Stream/tv-1', T0)).toMatchObject([{ netdisk: 'quark', pwdId: 'p1', passcode: 'abcd' }])
    expect(l.claim('/quark/From Stream/tv-1', T0)).toEqual([])
    expect(l.list()).toEqual([])
  })

  it('别的目录领不走——落地目录不同就是两条不相干的分享', () => {
    const l = new PendingShareLedger(openNetdiskDb(':memory:'))
    l.record(row())
    expect(l.claim('/quark/From Stream/tv-2', T0)).toEqual([])
    expect(l.list()).toHaveLength(1)
  })

  it('结尾斜杠 / 重复斜杠不构成两条：写入与认领过同一个归一化', () => {
    const l = new PendingShareLedger(openNetdiskDb(':memory:'))
    l.record(row({ dirPath: '/quark//From Stream/tv-1/' }))
    expect(l.list()[0]!.dirPath).toBe('/quark/From Stream/tv-1')
    expect(l.claim('/quark/From Stream/tv-1/', T0)).toHaveLength(1)
  })

  it('过了保质期的行不会被领走，而且顺手清掉——这张表只增不减就是个漏', () => {
    const l = new PendingShareLedger(openNetdiskDb(':memory:'))
    l.record(row())
    const late = new Date(T0.getTime() + PENDING_SHARE_TTL_MS + 1)
    expect(l.claim('/quark/From Stream/tv-1', late)).toEqual([])
    expect(l.list()).toEqual([])
  })

  it('同一条分享转存两次只留一行（后写的时间戳生效）', () => {
    const l = new PendingShareLedger(openNetdiskDb(':memory:'))
    l.record(row())
    const later = new Date(T0.getTime() + 3600_000).toISOString()
    l.record(row({ savedAt: later }))
    expect(l.list()).toMatchObject([{ pwdId: 'p1', savedAt: later }])
  })
})
