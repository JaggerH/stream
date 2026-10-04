import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlockEpisodeLog, FALLBACK_BASE_MS, FALLBACK_CAP_MS, FLOOR_BASE_MS, HARD_CAP_MS } from './block-episodes.ts'

/** 可控时钟：这台机器的单调时钟偏快约 7.6%，区间的算术不该靠"跑得够快"来验。 */
function log(t: { ms: number }, path?: string) {
  const p = path ?? join(mkdtempSync(join(tmpdir(), 'block-episodes-')), 'log.json')
  return { path: p, l: new BlockEpisodeLog(p, { now: () => t.ms }) }
}

const MIN = 60_000
const HOUR = 3600_000

describe('BlockEpisodeLog — 用自然流量把「多久才凉」框出来', () => {
  it('还没撞过 → 退回固定的 60s/30min 阶梯', () => {
    const t = { ms: 0 }
    expect(log(t).l.learn('google')).toEqual({ baseMs: FALLBACK_BASE_MS, capMs: FALLBACK_CAP_MS, samples: 0 })
  })

  it('撞墙 → 之后的每一次尝试收窄区间：又被拦给下界，跑成了给上界并封口', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('google', '撞上 /sorry')
    t.ms = 5 * MIN
    l.blocked('google', '撞上 /sorry') // 还没凉 → 下界 5min
    t.ms = 20 * MIN
    l.recovered('google') // 凉了 → 上界 20min，封口
    const [e] = l.episodes('google')
    expect(e).toMatchObject({ at: 0, lastBlockedAt: 5 * MIN, recoveredAt: 20 * MIN })
    // 下一次撞墙是**新的一条**，不是续上封了口的那条
    t.ms = 30 * MIN
    l.blocked('google', 'x')
    expect(l.episodes('google')).toHaveLength(2)
  })

  it('底数取「见过的最短一次成功等待」——低估会被翻倍纠回来，高估没有信号能纠', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    // 第一条：等了 40 分钟才见到成功
    l.blocked('g', 'x')
    t.ms = 40 * MIN
    l.recovered('g')
    // 第二条：等 3 分钟就成功了
    t.ms = HOUR
    l.blocked('g', 'x')
    t.ms += 3 * MIN
    l.recovered('g')
    expect(l.learn('g')).toMatchObject({ baseMs: 3 * MIN, samples: 2 })
  })

  it('两种墙混在一起也不会互相污染——因为取的是分位不是均值', () => {
    // 同一张 /sorry 页底下：打太密的瞬时拦截（秒级恢复）和一小时累计打爆（小时级）。
    // 取均值会得到一个对两种都不对的数；取最小值 → 第一次退让短，没凉就靠翻倍自己climb上去。
    const t = { ms: 0 }
    const { l } = log(t)
    for (const [gapMs, startMs] of [[30_000, 0], [2 * HOUR, HOUR], [45_000, 4 * HOUR]] as const) {
      t.ms = startMs
      l.blocked('g', 'x')
      t.ms = startMs + gapMs
      l.recovered('g')
    }
    const learned = l.learn('g')
    expect(learned.baseMs).toBe(30_000) // 不是三者的平均（约 41 分钟）
    expect(learned.samples).toBe(3)
  })

  it('底数有地板：一次抖动般的"两秒就好了"不该把冷却废掉', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('g', 'x')
    t.ms = 2_000
    l.recovered('g')
    expect(l.learn('g').baseMs).toBe(FLOOR_BASE_MS)
  })

  it('封顶由下界喂养：见过「3h10m 还没凉」就不该再假装 30 分钟够了', () => {
    // 2026-08-15 抖音实测：一晚 30–40 发之后进挑战态，3h10m 后单发仍被挑战。
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('douyin', '风控挑战')
    t.ms = 3 * HOUR + 10 * MIN
    l.blocked('douyin', '风控挑战')
    const learned = l.learn('douyin')
    expect(learned.capMs).toBe(2 * (3 * HOUR + 10 * MIN))
    expect(learned.capMs).toBeLessThanOrEqual(HARD_CAP_MS)
  })

  it('封顶有硬顶：台账再长也不许把一个源锁掉超过 12 小时', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('g', 'x')
    t.ms = 30 * HOUR
    l.blocked('g', 'x')
    expect(l.learn('g').capMs).toBe(HARD_CAP_MS)
  })

  it('底数不许越过封顶', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('g', 'x')
    t.ms = 20 * HOUR // 上界 20h（唯一样本），封顶被硬顶压在 12h
    l.recovered('g')
    const learned = l.learn('g')
    expect(learned.baseMs).toBeLessThanOrEqual(learned.capMs)
  })

  it('每个 facility 各学各的——Google 学出来的小时级不许压到"用户这就去登"那一档头上', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('google', 'x')
    t.ms = 4 * HOUR
    l.blocked('google', 'x')
    expect(l.learn('google').capMs).toBeGreaterThan(FALLBACK_CAP_MS)
    expect(l.learn('xhs')).toMatchObject({ baseMs: FALLBACK_BASE_MS, capMs: FALLBACK_CAP_MS })
  })

  it('跨重启活着——今天 strikes/until 全在内存，重启就把刚学到的扔了', () => {
    const t = { ms: 0 }
    const { path, l } = log(t)
    l.blocked('g', 'x')
    t.ms = 7 * MIN
    l.recovered('g')
    const reborn = new BlockEpisodeLog(path, { now: () => t.ms })
    expect(reborn.learn('g')).toMatchObject({ baseMs: 7 * MIN, samples: 1 })
  })

  it('撞墙前那一小时发了几发也记下来——perHour 那个闸门的实测分布就从这一列来', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.blocked('google', 'x', { spentLastHour: 97 })
    expect(l.episodes('google')[0]!.spentLastHour).toBe(97)
  })

  it('没有开着的 episode 时 recovered 是空转（它挂在每一次成功运行上）', () => {
    const t = { ms: 0 }
    const { l } = log(t)
    l.recovered('never-blocked')
    expect(l.episodes('never-blocked')).toHaveLength(0)
  })

  it('文件坏了当空台账起步，绝不让采集起不来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'block-episodes-'))
    const p = join(dir, 'log.json')
    const t = { ms: 0 }
    const { l } = log(t, p)
    l.blocked('g', 'x')
    // 半截 JSON（写盘被打断的形状）
    writeFileSync(p, '{"version":1,"facilities":{"g":[{"at"')
    expect(() => new BlockEpisodeLog(p, { now: () => t.ms })).not.toThrow()
    expect(new BlockEpisodeLog(p, { now: () => t.ms }).learn('g').samples).toBe(0)
  })

  it('每个 facility 只留最近 N 条，不无限长', () => {
    const t = { ms: 0 }
    const { path } = log(t)
    const l = new BlockEpisodeLog(path, { now: () => t.ms, keep: 3 })
    for (let i = 0; i < 6; i++) {
      t.ms = i * HOUR
      l.blocked('g', 'x')
      t.ms += MIN
      l.recovered('g')
    }
    expect(l.episodes('g')).toHaveLength(3)
  })
})
