import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchProgressStore, isFinished } from './watch-progress-store.ts'
import type { WatchProgressRow } from './watch-progress-store.ts'

describe('isFinished', () => {
  it('剩余 < 30s 算看完;剩 31s 但已看到 99% 也算看完', () => {
    expect(isFinished(2971, 3000)).toBe(true)
    expect(isFinished(2969, 3000)).toBe(true)   // 剩 31s、98.97% — 百分比条件已够
  })
  it('> 98% 算看完(短片:剩余秒数够不着 30s 门槛)', () => {
    expect(isFinished(96, 100)).toBe(true)
    expect(isFinished(50, 100)).toBe(false)
  })
  it('duration 为 0 不崩、不算看完', () => {
    expect(isFinished(0, 0)).toBe(false)
  })
  it('两小时的片子:剩 6 分钟还没完(0.95 会误判),剩 2 分钟算完', () => {
    expect(isFinished(6840, 7200)).toBe(false)   // 95% — 还剩 6 分钟
    expect(isFinished(7080, 7200)).toBe(true)    // 98.3% — 剩 2 分钟
  })
  it('position=0 的极短片不算看完(remaining 天然 < 30 的陷阱)', () => {
    expect(isFinished(0, 20)).toBe(false)
  })
})

describe('WatchProgressStore', () => {
  const row = (over: Partial<Omit<WatchProgressRow, 'updatedAt'>> = {}) => ({
    key: 'tmdb:1:S01E01', workKey: 'tmdb:1', workTitle: '某剧', workPoster: '/p.jpg',
    epLabel: 'S01E01', position: 100, duration: 3000, ...over,
  })

  it('put 是 upsert:同 key 覆盖位置,不产生第二行', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row())
      s.put(row({ position: 250 }))
      expect(s.get('tmdb:1:S01E01')).toMatchObject({ position: 250, workTitle: '某剧' })
      expect(s.inProgress()).toHaveLength(1)
    } finally { s.close() }
  })

  it('inProgress:每个作品只取最近一条,按时间新→旧', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01', position: 100 }), 1000)
      s.put(row({ key: 'tmdb:1:S01E02', position: 200, epLabel: 'S01E02' }), 2000)   // 同作品,更晚
      s.put(row({ key: 'tmdb:2:S01E01', workKey: 'tmdb:2', workTitle: '另一部', position: 50 }), 3000)
      const out = s.inProgress()
      expect(out.map((r) => r.key)).toEqual(['tmdb:2:S01E01', 'tmdb:1:S01E02'])  // 最近的在前
      expect(out.filter((r) => r.workKey === 'tmdb:1')).toHaveLength(1)          // 同作品只一条
    } finally { s.close() }
  })

  it('同一毫秒内两行属于同一作品(MAX(updated_at) 打平)——inProgress 只留一张卡', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01', position: 100 }), 5000)
      s.put(row({ key: 'tmdb:1:S01E02', position: 200, epLabel: 'S01E02' }), 5000)   // 同一毫秒,同作品
      const out = s.inProgress()
      expect(out.filter((r) => r.workKey === 'tmdb:1')).toHaveLength(1)
    } finally { s.close() }
  })

  it('inProgress(limit) 截取排好序的前 N 条', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01' }), 1000)
      s.put(row({ key: 'tmdb:2:S01E01', workKey: 'tmdb:2', workTitle: '2' }), 2000)
      s.put(row({ key: 'tmdb:3:S01E01', workKey: 'tmdb:3', workTitle: '3' }), 3000)
      expect(s.inProgress({ limit: 2 }).map((r) => r.workKey)).toEqual(['tmdb:3', 'tmdb:2'])
    } finally { s.close() }
  })

  it('看完的不出现在 inProgress,但 get 仍拿得到(重看能续播)', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ position: 2990 }))   // 剩 10s → 看完
      expect(s.inProgress()).toEqual([])
      expect(s.get('tmdb:1:S01E01')).toMatchObject({ position: 2990 })
    } finally { s.close() }
  })

  it('打开一个 channel_id 上线前建的库:补列而不是崩,老行照常读得出来', () => {
    // CREATE TABLE IF NOT EXISTS 不会给已存在的表加列——没有这条 ALTER,用户那份真库一开就在
    // put 上抛(缺列),而测试用的 :memory: 每次都是新表,永远看不到这个失败。
    const path = join(mkdtempSync(join(tmpdir(), 'wp-')), 'user.db')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE watch_progress (
        key TEXT PRIMARY KEY, work_key TEXT NOT NULL, work_title TEXT NOT NULL,
        work_poster TEXT, ep_label TEXT, position REAL NOT NULL, duration REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO watch_progress VALUES ('tmdb:1:S01E01','tmdb:1','某剧',NULL,'S01E01',100,3000,1000);
    `)
    legacy.close()

    const s = new WatchProgressStore(path)
    try {
      expect(s.get('tmdb:1:S01E01')).toMatchObject({ position: 100, channelId: undefined })
      s.put(row({ key: 'tmdb:2:S01E01', workKey: 'tmdb:2', channelId: 'kids' }), 2000)
      expect(s.inProgress({ channels: ['kids'] }).map((r) => r.workKey)).toEqual(['tmdb:2'])
    } finally { s.close() }
  })

  it('按频道筛:只给这一屏的进度(儿童频道不该看见大人正在追的剧)', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01', channelId: 'default-video' }), 1000)
      s.put(row({ key: 'tmdb:9:S01E01', workKey: 'tmdb:9', workTitle: '小猪', channelId: 'kids' }), 2000)
      expect(s.inProgress({ channels: ['kids'] }).map((r) => r.workKey)).toEqual(['tmdb:9'])
      expect(s.inProgress({ channels: ['default-video'] }).map((r) => r.workKey)).toEqual(['tmdb:1'])
      expect(s.inProgress().map((r) => r.workKey)).toEqual(['tmdb:9', 'tmdb:1'])   // 不筛 = 整份
    } finally { s.close() }
  })

  it('归属未知的老行只在明说 unattributed 时出现——不筛频道时照常在', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01' }), 1000)   // 无 channelId
      expect(s.inProgress({ channels: ['kids'] })).toEqual([])
      expect(s.inProgress({ channels: ['kids'], unattributed: true }).map((r) => r.workKey)).toEqual(['tmdb:1'])
      expect(s.inProgress()).toHaveLength(1)
    } finally { s.close() }
  })

  it('同一作品在两个频道各播过——两边都还看得见自己的那条', () => {
    // 筛频道必须发生在按 work 去重之前:去重在前的话,全局最新的那条会把另一个频道的进度整条吃掉。
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ key: 'tmdb:1:S01E01', channelId: 'default-video', position: 100 }), 1000)
      s.put(row({ key: 'tmdb:1:S01E05', channelId: 'kids', position: 500, epLabel: 'S01E05' }), 2000)
      expect(s.inProgress({ channels: ['default-video'] }).map((r) => r.key)).toEqual(['tmdb:1:S01E01'])
      expect(s.inProgress({ channels: ['kids'] }).map((r) => r.key)).toEqual(['tmdb:1:S01E05'])
    } finally { s.close() }
  })

  it('不传 channelId 的心跳不会把已经记下的归属抹成未知', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row({ channelId: 'kids' }), 1000)
      s.put(row({ position: 300 }), 2000)   // 老客户端/不知道自己在哪一屏的调用点
      expect(s.get('tmdb:1:S01E01')).toMatchObject({ position: 300, channelId: 'kids' })
    } finally { s.close() }
  })

  it('remove 删掉记录', () => {
    const s = new WatchProgressStore(':memory:')
    try {
      s.put(row())
      expect(s.remove('tmdb:1:S01E01')).toBe(true)
      expect(s.get('tmdb:1:S01E01')).toBeNull()
      expect(s.remove('nope')).toBe(false)
    } finally { s.close() }
  })
})
