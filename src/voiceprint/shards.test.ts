import { describe, expect, it } from 'vitest'
import { shardSuspects } from './shards.ts'
import type { DiarizedSegment } from './resolve.ts'

/** 造段：[开始, 结束, 谁] */
const seg = (start: number, end: number, speaker: string): DiarizedSegment =>
  ({ start, end, speaker, embedding: [] }) as unknown as DiarizedSegment

/** 一个人连续讲话、中间被小簇按 gap 秒间隔插进来（掌声的形状）。 */
function sandwich(host: string, shard: string, n: number, gap: number, shardDur = 3) {
  const out: DiarizedSegment[] = []
  let t = 10
  for (let i = 0; i < n; i++) {
    out.push(seg(t, t + 8, host))
    t += 8 + gap
    out.push(seg(t, t + shardDur, shard))
    t += shardDur + gap
  }
  out.push(seg(t, t + 40, host)) // 宿主还得远远长于碎片
  return out
}

describe('shardSuspects — 结构上像「被夹碎的非人声」的簇', () => {
  it('抓：短、整段套在某人发言里、0 秒间隔高频交替、别处不露面', () => {
    const sus = shardSuspects(sandwich('多多', 'SPEAKER_08', 6, 0))
    expect(sus.get('SPEAKER_08')).toBe('多多')
  })

  it('不抓：交替间隔大（真的在轮流说话，中间有停顿）', () => {
    const sus = shardSuspects(sandwich('多多', 'SPEAKER_08', 6, 2.5))
    expect(sus.has('SPEAKER_08')).toBe(false)
  })

  it('不抓：只插了一两次（真人插一句嘴，不是被切碎）', () => {
    const sus = shardSuspects(sandwich('多多', 'SPEAKER_08', 1, 0))
    expect(sus.has('SPEAKER_08')).toBe(false)
  })

  it('不抓：它在宿主范围之外也说话——那是个会在别处露面的真人', () => {
    // 这条是最要紧的护栏：评委在演员 set 中间插话、后面点评环节又长篇发言,
    // 判据必须放过他。E02 上 6 个评委簇一个都没被抓,靠的就是这一条。
    const segs = [...sandwich('多多', 'SPEAKER_20', 6, 0), seg(3000, 3060, 'SPEAKER_20')]
    const sus = shardSuspects(segs)
    expect(sus.has('SPEAKER_20')).toBe(false)
  })

  it('不抓：跟宿主时长相当（两个人对谈，不是一个人被垫底噪声切碎）', () => {
    const segs: DiarizedSegment[] = []
    let t = 0
    for (let i = 0; i < 8; i++) {
      segs.push(seg(t, t + 10, 'A'))
      t += 10
      segs.push(seg(t, t + 9, 'B'))
      t += 9
    }
    const sus = shardSuspects(segs)
    expect(sus.has('B')).toBe(false)
    expect(sus.has('A')).toBe(false)
  })

  it('宿主自己不会被当成碎片（它最长）', () => {
    const sus = shardSuspects(sandwich('多多', 'SPEAKER_08', 6, 0))
    expect(sus.has('多多')).toBe(false)
  })

  it('空输入不炸', () => {
    expect(shardSuspects([]).size).toBe(0)
  })
})
