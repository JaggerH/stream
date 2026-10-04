import { describe, expect, it, vi } from 'vitest'
import { openNetdiskDb } from '../db.ts'
import { SampleCache } from './sample-cache.ts'
import {
  clampWindowS,
  makeAudioSampler,
  SAMPLE_WINDOW_DEFAULT_S,
  SAMPLE_WINDOW_MAX_S,
  SAMPLE_WINDOW_MIN_S,
  type AudioSamplerDeps,
} from './sample-audio.ts'

const PATH = '/quark/来源/116.安特卫普金库案.mp3'

function deps(over?: Partial<AudioSamplerDeps>): AudioSamplerDeps {
  return {
    rawUrl: vi.fn(async () => 'https://cdn/x.mp3'),
    fetchRange: vi.fn(async (_u: string, s: number, e: number) => new Uint8Array(e - s + 1)),
    transcribe: vi.fn(async () => ({ text: '安特卫普' })) as never,
    fileSize: vi.fn(async () => 122_000_000),
    fileId: vi.fn(async () => 'fid-abc'),
    durationOf: vi.fn(async () => 6000),
    cache: new SampleCache(openNetdiskDb(':memory:')),
    ...over,
  }
}

describe('clampWindowS', () => {
  it('不传 = 那个实测定下来的 120 秒', () => {
    expect(clampWindowS(undefined)).toBe(SAMPLE_WINDOW_DEFAULT_S)
    expect(clampWindowS('两分钟')).toBe(SAMPLE_WINDOW_DEFAULT_S)
  })

  /**
   * **上限是产品底线，不是建议**：整集几十分钟不许全转（转写全文会把整轮对话顶爆，而且是
   * 真金白银的 ASR 钱）。模型从 schema 里看得见这个参数，所以它必须调不动。
   */
  it('调大调不出上限，调小调不出下限', () => {
    expect(clampWindowS(99_999)).toBe(SAMPLE_WINDOW_MAX_S)
    expect(clampWindowS(1)).toBe(SAMPLE_WINDOW_MIN_S)
  })
})

describe('makeAudioSampler', () => {
  it('采到两段，并把它落进缓存', async () => {
    const d = deps()
    const sample = makeAudioSampler(d)
    const first = await sample({ path: PATH })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.cached).toBe(false)
    expect(first.probe.tail).toBeTruthy()
    expect(first.file.durationS).toBe(6000)
  })

  /** 缓存命中 = **一次网络都不发**。这条就是这个模块存在的理由（转写要花钱）。 */
  it('第二次同一份文件走缓存，不再发一次转写', async () => {
    const d = deps()
    const sample = makeAudioSampler(d)
    await sample({ path: PATH })
    const calls = (d.transcribe as ReturnType<typeof vi.fn>).mock.calls.length
    const again = await sample({ path: PATH })
    expect(again.ok && again.cached).toBe(true)
    expect((d.transcribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  /**
   * **整理的本职就是搬文件**：判完这份是哪一集，下一步就把它挪上货架。按对象 id 缓存的意义
   * 全在这一条上——搬完再听一次必须还是命中，否则每一份被判过的文件都要重付一次转写。
   */
  it('文件被整理搬走后按对象 id 照样命中', async () => {
    const d = deps()
    const sample = makeAudioSampler(d)
    await sample({ path: PATH })
    const moved = await sample({ path: '/quark/货架/116.安特卫普金库案.mp3' })
    expect(moved.ok && moved.cached).toBe(true)
  })

  /** driver 给不出对象 id → 退成路径档，**并且说出来**（否则"缓存没生效"查不出来）。 */
  it('取不到对象 id：退成路径档并记一行日志', async () => {
    const log = vi.fn()
    const sample = makeAudioSampler(deps({ fileId: vi.fn(async () => { throw new Error('no id') }), log }))
    expect((await sample({ path: PATH })).ok).toBe(true)
    expect(log.mock.calls.flat().join(' ')).toContain('退成路径档')
  })

  /** 切不动的容器**一次网络都不发**：切一段 mkv 回来是解不开的字节，转写返回空会被读成"没人说话"。 */
  it('mp4/mkv 直接说听不了，不发任何请求', async () => {
    const d = deps()
    const out = await makeAudioSampler(d)({ path: '/quark/来源/S01E01.mkv' })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toContain('只支持 mp3/aac')
    expect((d.fileSize as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  /** 时长探不出来 = 切不出"大约两分钟"那一段。照实说，别端一份空采样。 */
  it('时长探不出来 → ok:false，且不去转写', async () => {
    const d = deps({ durationOf: vi.fn(async () => null) })
    const out = await makeAudioSampler(d)({ path: PATH })
    expect(out.ok).toBe(false)
    expect((d.transcribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  /** 窗口不同的两次不许共用一格缓存，否则「我要 30 秒」会拿回一份 120 秒的转写。 */
  it('换了窗口长度就重新采', async () => {
    const d = deps()
    const sample = makeAudioSampler(d)
    await sample({ path: PATH })
    const short = await sample({ path: PATH, windowS: 30 })
    expect(short.ok && short.cached).toBe(false)
    expect(short.ok && short.windowS).toBe(30)
  })
})
