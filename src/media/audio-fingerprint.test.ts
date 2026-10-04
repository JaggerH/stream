import { describe, it, expect, vi } from 'vitest'
import { encodeFingerprint, decodeFingerprint, compareFingerprints } from './audio-fingerprint.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeFingerprintEngine, fingerprintBytes, parseFpcalcRaw } from './audio-fingerprint.ts'
const execFileP = promisify(execFile)

/** 可复现的伪随机 uint32 序列（不许用 Math.random，xorshift 足够）。 */
function seq(n: number, seed = 0x9e3779b9): Uint32Array {
  const out = new Uint32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0
    out[i] = s
  }
  return out
}
/** 给序列每一项翻 flipBits 个低位——模拟"同一份录音、不同编码"的位噪声。 */
function noisy(a: Uint32Array, flipBits: number): Uint32Array {
  const out = new Uint32Array(a)
  for (let i = 0; i < out.length; i++) out[i] ^= (1 << flipBits) - 1
  return out
}

const RATE = 7 // items/second，chromaprint 实测量级

describe('encode/decode', () => {
  it('round-trip 一字不差', () => {
    const a = seq(1000)
    expect(decodeFingerprint(encodeFingerprint(a))).toEqual(a)
  })
})

describe('compareFingerprints', () => {
  it('同一序列带偏移 + 位噪声 → match，且恢复出偏移', () => {
    const base = seq(RATE * 1200) // 20 分钟
    const shifted = noisy(base.slice(RATE * 30), 3) // b 比 a 晚 30s 开始，每项 3 个低位翻转
    const r = compareFingerprints(base, shifted, { itemsPerSecond: RATE })
    expect(r.match).toBe(true)
    expect(Math.abs(r.offsetS - 30)).toBeLessThanOrEqual(1)
    expect(r.overlapS).toBeGreaterThan(1100)
  })

  it('两段无关序列 → 不 match（随机基线 ~0.5，阈值 0.75 必须挡住）', () => {
    const r = compareFingerprints(seq(RATE * 600, 1), seq(RATE * 600, 2), { itemsPerSecond: RATE })
    expect(r.match).toBe(false)
    expect(r.similarity).toBeLessThan(0.6)
  })

  it('相似但重叠太短 → 不 match（共用片头不算同一期）', () => {
    const intro = seq(RATE * 60) // 60s 相同片头
    const a = new Uint32Array([...intro, ...seq(RATE * 1200, 7)])
    const b = new Uint32Array([...intro, ...seq(RATE * 1200, 8)])
    // 只有 60s 吻合，正文各不相同 → 整体相似度过不了线
    const r = compareFingerprints(a, b, { itemsPerSecond: RATE })
    expect(r.match).toBe(false)
  })

  it('短媒体：minOverlap 缩到 0.8×较短时长，3 分钟的重投也能 match', () => {
    const base = seq(RATE * 180) // 3 分钟 < minOverlapS 300s
    const r = compareFingerprints(base, noisy(base, 2), { itemsPerSecond: RATE })
    expect(r.match).toBe(true)
    expect(r.offsetS).toBe(0)
  })

  it('长短悬殊不缩下限：3 小时正片 vs 2 分钟切片（相似度满分）仍不 match', () => {
    const base = seq(RATE * 10800) // 3 小时正片
    const clip = base.slice(RATE * 60, RATE * 180) // 从第 60s 抠出的 2 分钟切片，逐位吻合
    const r = compareFingerprints(base, clip, { itemsPerSecond: RATE })
    // 重叠只有 120s < 300s 下限 —— 缩放若对这种对生效，它会以 similarity=1 被并成"同一份录音"
    expect(r.match).toBe(false)
  })

  it('超出 maxOffsetS 的偏移不被搜索', () => {
    const base = seq(RATE * 3000)
    const shifted = base.slice(RATE * 400) // 偏移 400s > maxOffsetS 300
    const r = compareFingerprints(base, shifted, { itemsPerSecond: RATE })
    expect(r.match).toBe(false)
  })
})

describe('probeFingerprintEngine', () => {
  it('ffmpeg muxers 里有 chromaprint → ffmpeg 档', async () => {
    const exec = async (cmd: string) =>
      cmd === 'ffmpeg' ? { stdout: ' E  matroska\n E  chromaprint     Chromaprint\n' } : { stdout: '' }
    // 第二个参数 = 用哪个 ffmpeg 问这句话（生产里由 src/media/ffmpeg-bin.ts 解出绝对路径）。
    // 显式传 'ffmpeg'，免得这条用例的成败取决于开发机上 ffmpeg 装在哪。
    expect(await probeFingerprintEngine(exec, 'ffmpeg')).toBe('ffmpeg')
  })
  it('这台机器上没有 ffmpeg → 直接跳过 ffmpeg 档，不去 spawn 一个不存在的命令', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === 'fpcalc') return { stdout: 'fpcalc version 1.5.1\n' }
      throw new Error('should not be called for ffmpeg')
    })
    expect(await probeFingerprintEngine(exec, null)).toBe('fpcalc')
    expect(exec).toHaveBeenCalledTimes(1)
  })
  it('muxer 缺席但 fpcalc 在 → fpcalc 档', async () => {
    const exec = async (cmd: string) => {
      if (cmd === 'ffmpeg') return { stdout: ' E  matroska\n' }
      if (cmd === 'fpcalc') return { stdout: 'fpcalc version 1.5.1\n' }
      throw new Error('ENOENT')
    }
    expect(await probeFingerprintEngine(exec, 'ffmpeg')).toBe('fpcalc')
  })
  it('都没有 → null（不猜、不抛）', async () => {
    const exec = async () => { throw new Error('ENOENT') }
    expect(await probeFingerprintEngine(exec)).toBe(null)
  })
})

describe('parseFpcalcRaw', () => {
  it('抠 FINGERPRINT= 逗号序列', () => {
    expect(parseFpcalcRaw('DURATION=10\nFINGERPRINT=1,2,4294967295\n')).toEqual(new Uint32Array([1, 2, 4294967295]))
  })
  it('没有 FINGERPRINT 行 → 抛（空指纹是错误，不是空结果）', () => {
    expect(() => parseFpcalcRaw('DURATION=10\n')).toThrow()
  })
})

// —— 门控真引擎冒烟：本机探测出引擎才跑 ——
const engine = await probeFingerprintEngine().catch(() => null)

describe.skipIf(!engine)('fingerprintBytes（真引擎）', () => {
  it('同一段音频两种编码 → match；不同音频 → 不 match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-test-'))
    try {
      // 60s 扫频信号（比纯正弦的指纹信息量大），转成 wav 与 mp3 两份"编码不同的同一录音"
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=sin(440*2*PI*t*(1+0.5*sin(0.1*2*PI*t))):d=60', '-ac', '1', '-ar', '16000', join(dir, 'a.wav')])
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'a.wav'), '-b:a', '64k', join(dir, 'a.mp3')])
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=60:c=pink', '-ac', '1', '-ar', '16000', join(dir, 'b.wav')])
      const { readFile } = await import('node:fs/promises')
      const [wav, mp3, noise] = await Promise.all(
        ['a.wav', 'a.mp3', 'b.wav'].map(async (f) => new Uint8Array(await readFile(join(dir, f)))),
      )
      const [fa, fb, fn] = [await fingerprintBytes(wav, engine!), await fingerprintBytes(mp3, engine!), await fingerprintBytes(noise, engine!)]
      const rate = fa.length / 60
      expect(compareFingerprints(fa, fb, { itemsPerSecond: rate }).match).toBe(true)
      expect(compareFingerprints(fa, fn, { itemsPerSecond: rate }).match).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
