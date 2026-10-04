import { describe, it, expect } from 'vitest'
import { missingAired, nextCheckAt, progressOf, rankCandidates, pickFiles, type Candidate } from './plan.ts'

const e = (k: string, right: string | null, airDate?: string) => ({ leftKey: k, rightFile: right, status: right ? 'auto' : 'unmatched', ...(airDate ? { airDate } : {}) })
const f = (path: string, size = 1) => ({ fid: path, token: 't', name: path.split('/').pop()!, size, path })

describe('missingAired', () => {
  it('只算已播出且没配上的；没有 airDate 的不算', () => {
    const entries = [e('a', null, '2026-09-01'), e('b', 'x.mkv', '2026-09-01'), e('c', null, '2026-09-10'), e('d', null)]
    expect(missingAired(entries, '2026-09-03')).toEqual(['a'])
  })
  it('pending 的配对算没拿到', () => {
    expect(missingAired([{ leftKey: 'a', rightFile: 'x', status: 'pending', airDate: '2026-09-01' }], '2026-09-03')).toEqual(['a'])
  })
})

describe('progressOf', () => {
  it('分母只数已播出的集：未播（airDate > today）和没定档（无 airDate）且没拿到的不进分母', () => {
    const entries = [e('a', 'x', '2026-09-01'), e('b', null, '2026-09-01'), e('c', null, '2026-09-10'), e('d', null)]
    expect(progressOf(entries, '2026-09-03')).toEqual({ matched: 1, total: 2, unaired: 2 })
  })
  it('已经配上的集不管 airDate 怎样都在分子分母里——分子不能大过分母', () => {
    const entries = [e('a', 'x', '2026-09-10'), e('b', 'y')]
    expect(progressOf(entries, '2026-09-03')).toEqual({ matched: 2, total: 2, unaired: 0 })
  })
  it('播出当天算已播', () => {
    expect(progressOf([e('a', null, '2026-09-03')], '2026-09-03')).toEqual({ matched: 0, total: 1, unaired: 0 })
  })
  it('盘上已有候选文件（pending）的不是占位——没 airDate 也进分母', () => {
    expect(progressOf([{ leftKey: 'a', rightFile: 'x', status: 'pending' }], '2026-09-03')).toEqual({ matched: 0, total: 1, unaired: 0 })
  })
})

describe('nextCheckAt 的 today 覆盖', () => {
  it('锚在上一轮、按真正的今天判播出：上一轮之后新播的集按新鲜缺集起 6 小时', () => {
    const last = new Date('2026-09-02T14:00:00Z')
    const d = nextCheckAt({ entries: [e('a', null, '2026-09-03')], dryRuns: 0, now: last, today: '2026-09-03' })
    expect(d.toISOString()).toBe('2026-09-02T20:00:00.000Z')
  })
})

describe('nextCheckAt', () => {
  const now = new Date('2026-09-03T10:00:00Z')
  it('有缺集且最近一集 3 天内 → 6 小时', () => {
    const d = nextCheckAt({ entries: [e('a', null, '2026-09-02')], dryRuns: 5, now })
    expect(d.toISOString()).toBe('2026-09-03T16:00:00.000Z')
  })
  it('有缺集、不新鲜 → 24h × 2^min(dryRuns,3)', () => {
    expect(nextCheckAt({ entries: [e('a', null, '2026-01-01')], dryRuns: 0, now }).toISOString()).toBe('2026-09-04T10:00:00.000Z')
    expect(nextCheckAt({ entries: [e('a', null, '2026-01-01')], dryRuns: 2, now }).toISOString()).toBe('2026-09-07T10:00:00.000Z')
    expect(nextCheckAt({ entries: [e('a', null, '2026-01-01')], dryRuns: 9, now }).toISOString()).toBe('2026-09-10T10:00:00.000Z') // 封顶 7 天
  })
  it('无缺集、有未播出 → 下一集播出日当天 20:00 本地', () => {
    const d = nextCheckAt({ entries: [e('a', 'x', '2026-09-01'), e('b', null, '2026-09-06')], dryRuns: 0, now })
    expect(d.getFullYear()).toBe(2026); expect(d.getMonth()).toBe(8); expect(d.getDate()).toBe(6); expect(d.getHours()).toBe(20)
  })
  it('无缺集无未播 → 30 天', () => {
    expect(nextCheckAt({ entries: [e('a', 'x', '2026-09-01')], dryRuns: 0, now }).toISOString()).toBe('2026-10-03T10:00:00.000Z')
  })
})

describe('rankCandidates / pickFiles', () => {
  const missing = ['S3E14', 'S3E15', 'S3E16']
  const c = (key: string, pairs: Array<[string, string, number?]>): Candidate => ({
    key, files: pairs.map(([, p, s]) => f(p, s)), assigned: new Map(pairs.map(([k, p]) => [k, p])),
  })
  it('覆盖数多的在前，同分按大小之和', () => {
    const a = c('a', [['S3E14', 'a/14.mkv', 5]])
    const b = c('b', [['S3E14', 'b/14.mkv', 9], ['S3E15', 'b/15.mkv', 9]])
    const d = c('d', [['S3E14', 'd/14.mkv', 1], ['S3E15', 'd/15.mkv', 1]])
    expect(rankCandidates([a, d, b], missing).map((x) => x.key)).toEqual(['b', 'd', 'a'])
  })
  it('平局只比盖住缺集的那几个文件——塞满无关大文件的分享赢不了；再平就看谁认出的集更多', () => {
    const lean = c('lean', [['S3E14', 'l/14.mkv', 9]])
    const bloated = c('bloated', [['S3E14', 'b/14.mkv', 9], ['S1E01', 'b/01.mkv', 900], ['S1E02', 'b/02.mkv', 900]])
    // 同覆盖（1）、同覆盖字节（9）：bloated 认出更多集（3 vs 1）→ 它在前；但这是第三档判据，
    // 不是靠 1800 字节的无关文件——把 lean 的 14 集换成更大的版本就该反过来。
    expect(rankCandidates([lean, bloated], missing).map((x) => x.key)).toEqual(['bloated', 'lean'])
    const leanBig = c('lean', [['S3E14', 'l/14.mkv', 10]])
    expect(rankCandidates([bloated, leanBig], missing).map((x) => x.key)).toEqual(['lean', 'bloated'])
  })
  it('贪心：第二条只补第一条没覆盖的，最多 3 条，配到非缺集的文件不转', () => {
    const b = c('b', [['S3E14', 'b/14.mkv'], ['S3E15', 'b/15.mkv'], ['S3E01', 'b/01.mkv']])
    const g = c('g', [['S3E15', 'g/15.mkv'], ['S3E16', 'g/16.mkv']])
    const picked = pickFiles(rankCandidates([g, b], missing), missing)
    expect(picked).toEqual([
      { key: 'b', files: [f('b/14.mkv'), f('b/15.mkv')], covers: ['S3E14', 'S3E15'] },
      { key: 'g', files: [f('g/16.mkv')], covers: ['S3E16'] },
    ])
  })
})
