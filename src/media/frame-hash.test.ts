import { describe, expect, it } from 'vitest'
import { dhash, hammingDistance, dedupeFrames, THUMB_BYTES, THUMB_W, THUMB_H } from './frame-hash.ts'

/** 造一张 17×16 灰度缩略：`row(y, x)` 给每个像素一个值。 */
function thumb(px: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(THUMB_BYTES)
  for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[y * THUMB_W + x] = px(x, y)
  return out
}

const ZERO_HASH = '0'.repeat(64)
const ALL_ONES_HASH = 'f'.repeat(64)

describe('dhash', () => {
  it('纯色图的哈希是全零——约定是右边比左边亮才记 1，同色时这个条件处处不成立', () => {
    expect(dhash(thumb(() => 128))).toBe(ZERO_HASH)
  })

  it('每行从左到右递增 → 每一位都是 1', () => {
    expect(dhash(thumb((x) => x * 15))).toBe(ALL_ONES_HASH)
  })

  it('64 个十六进制字符 = 256 位（17×16 网格，每行 16 位）', () => {
    expect(dhash(thumb((x, y) => (x * 7 + y * 13) % 256))).toHaveLength(64)
  })

  it('尺寸不对就抛——静默算出一个错哈希比崩了坏得多', () => {
    expect(() => dhash(new Uint8Array(71))).toThrow()
  })

  it('只改一个像素，哈希最多差两位——相邻比较只涉及它左右两对', () => {
    const base = thumb(() => 100)
    const one = thumb((x, y) => (x === 4 && y === 2 ? 200 : 100))
    expect(hammingDistance(dhash(base), dhash(one))).toBeLessThanOrEqual(2)
  })
})

describe('hammingDistance', () => {
  it('相同 → 0', () => {
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0)
  })

  it('全反 → 64', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64)
  })

  it('差一位 → 1', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1)
  })

  it('长度不同就抛——比出来的数没有意义，不能装作算得出', () => {
    expect(() => hammingDistance('00', '0000')).toThrow()
  })

  it('非法字符就抛——Buffer.from(x, "hex") 会静默截断，脏串可能截出等长前缀骗出距离 0', () => {
    expect(() => hammingDistance('0g', '00')).toThrow()
  })

  it('奇数长度就抛——同样是 Buffer.from(x, "hex") 静默截断的来源', () => {
    expect(() => hammingDistance('0', '0')).toThrow()
  })
})

describe('dedupeFrames', () => {
  const f = (hash: string, at: number) => ({ hash, at })

  it('连续几乎相同的帧只留第一张——幻灯片停在同一页时的形状', () => {
    const kept = dedupeFrames(
      [f('0000000000000000', 0), f('0000000000000001', 2), f('0000000000000003', 4), f('ffffffffffffffff', 6)],
      10
    )
    expect(kept.map((k) => k.at)).toEqual([0, 6])
  })

  it('比的是「上一张留下的」，不是「上一张看过的」——否则慢慢漂移会一张都留不下', () => {
    // 每张比前一张只新增 4 位差异（都低于阈值 10），但都是相对第一张**新增**的位、不撤销前面的——
    // 与第一张的累计差距是 4、8、12。与「上一张看过的」比，每步都 <10，三张全被丢掉；
    // 与「上一张留下的」比，last 一直钉在第一张不动，累计差距在第四张越过阈值，第四张会被留下。
    const kept = dedupeFrames(
      [
        f('0000000000000000', 0),
        f('000000000000000f', 2),
        f('00000000000000ff', 4),
        f('0000000000000fff', 6),
      ],
      10
    )
    expect(kept.length).toBeGreaterThan(1)
    expect(kept[0]!.at).toBe(0)
  })

  it('第一张永远留下', () => {
    expect(dedupeFrames([f('0000000000000000', 0)], 10).map((k) => k.at)).toEqual([0])
  })

  it('空输入 → 空输出，不抛', () => {
    expect(dedupeFrames([], 10)).toEqual([])
  })

  it('汉明距离恰好等于门槛也算变了——达到门槛就保留，不是必须超过', () => {
    // '000000000000000f' 与 '0000000000000000' 只差最后一个十六进制位 0xf = 1111，恰好 4 位。
    const kept = dedupeFrames([f('0000000000000000', 0), f('000000000000000f', 2)], 4)
    expect(kept.map((k) => k.at)).toEqual([0, 2])
  })
})
