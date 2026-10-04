import { describe, expect, it, vi } from 'vitest'
import { isSliceable, probeHeadTail, sliceRanges, PROBE_WINDOW_S } from './identity-probe.ts'

/**
 * 取证据层的测试。**这一层不判断任何事**——它只回答"这份文件的头尾各说了什么"，
 * 判读归对话里的模型（它经 `netdisk_transcribe` 拿到这两段话）。分层不是洁癖：证据原文必须能单独摆给用户看，
 * 否则 AI 给的就是一个无法核对的结论，而这张卡后面接的是删除或认领。
 */

describe('切片窗口：按比例算字节，不信文件名里的码率', () => {
  /** 活体：116.安特卫普金库案.mp3，127759079 字节 / 3194 秒 / 320k。 */
  const SIZE = 127759079
  const DUR = 3194

  it('头尾各一段，长度按 时长占比 × 总字节 算', () => {
    const r = sliceRanges(SIZE, DUR)!
    const want = Math.round((PROBE_WINDOW_S / DUR) * SIZE) // 120s 占比 → 4799962 字节
    expect(r.head).toEqual([0, want - 1])
    expect(r.tail).toEqual([SIZE - want, SIZE - 1])
  })

  /**
   * 按比例而不是按 `kbps × 秒`：VBR 文件没有单一码率，拿标称值算会偏；而占比对 CBR 精确、
   * 对 VBR 也够用——我们要的只是"大约两分钟的音频"，不是精确到帧。
   */
  it('VBR 也成立：只要求切出来的两段各约占总时长的窗口比例', () => {
    const r = sliceRanges(SIZE, DUR)!
    const headS = ((r.head[1] - r.head[0] + 1) / SIZE) * DUR
    expect(headS).toBeCloseTo(PROBE_WINDOW_S, 0)
  })

  /**
   * 短文件：头尾两个窗口会重叠，切两段等于把中间那截听两遍、还多花一次转写。
   * 整个文件一段过——那时它本来就短。
   */
  it('时长不足两个窗口 → 整个文件一段，没有 tail', () => {
    const r = sliceRanges(2_000_000, PROBE_WINDOW_S * 2 - 1)!
    expect(r.head).toEqual([0, 1_999_999])
    expect(r.tail).toBeUndefined()
  })

  it('时长恰好两个窗口 → 也走单段（两段首尾相接，没有省下任何东西）', () => {
    expect(sliceRanges(2_000_000, PROBE_WINDOW_S * 2)!.tail).toBeUndefined()
  })

  /** 时长为 0 / 缺失时无从按比例算——返回 null，调用方据此不做探测（绝不瞎切一段）。 */
  it('时长不可用 → null', () => {
    expect(sliceRanges(SIZE, 0)).toBeNull()
    expect(sliceRanges(0, DUR)).toBeNull()
  })
})

/**
 * **只有裸帧流能按字节切**：mp3/aac 从任意位置切开，解码器找到下一个同步字就能继续。
 * mp4/m4a/mkv 的索引（moov/cues）在容器别处，切一段出来是一堆解不开的字节——
 * 给这类文件切片，拿回来的是空转写，而空转写会被读成"这段没人说话"，是个会骗人的结果。
 */
describe('哪些容器能切', () => {
  it('mp3 / aac 能切', () => {
    expect(isSliceable('/a/b/116.mp3')).toBe(true)
    expect(isSliceable('/a/b/x.AAC')).toBe(true)
  })

  it('m4a / mp4 / mkv 不能切——索引不在切出来的那段里', () => {
    for (const p of ['/a/x.m4a', '/a/x.mp4', '/a/x.mkv', '/a/x.flac', '/a/x']) {
      expect(isSliceable(p)).toBe(false)
    }
  })
})

describe('取证据：两段各自转写', () => {
  const file = { path: '/lib/付费/116.安特卫普金库案.mp3', sizeBytes: 127759079, durationS: 3194 }

  function deps(transcripts: string[]) {
    const ranges: string[] = []
    let n = 0
    return {
      ranges,
      transcribed: () => n,
      d: {
        rawUrl: vi.fn(async () => 'https://cdn.example/x.mp3'),
        fetchRange: vi.fn(async (_url: string, start: number, end: number) => {
          ranges.push(`${start}-${end}`)
          return new Uint8Array(8)
        }),
        transcribe: vi.fn(async () => ({ text: transcripts[n++] ?? '' })),
      },
    }
  }

  /**
   * 两段**并行**取。下载打的是网盘 CDN、转写走 `transcribe` 那条梯子（远端 API），两边都没有
   * 本地资源可抢——串行纯属让第二段白等第一段。
   *
   * 这一条钉的是"同时在飞"，不是"谁先回来"：完成顺序由两段各自多快决定，断言它就成了测运气。
   */
  it('头尾两段同时在飞，不是一段等一段', async () => {
    let inflight = 0
    let peak = 0
    const d = {
      rawUrl: vi.fn(async () => 'https://cdn.example/x.mp3'),
      fetchRange: vi.fn(async () => new Uint8Array(8)),
      transcribe: vi.fn(async () => {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 5))
        inflight--
        return { text: 'x' }
      }),
    }
    await probeHeadTail(d, file)
    expect(d.transcribe).toHaveBeenCalledTimes(2)
    expect(peak).toBe(2)
  })

  it('头尾各取一段、各转写一次，原文原样带出', async () => {
    const { d, ranges } = deps(['大家好 欢迎收听……安特魏普……钻石之都', '……感谢您收听，咱们下期再见'])
    const probe = await probeHeadTail(d, file)
    expect(ranges).toHaveLength(2)
    expect(ranges[0].startsWith('0-')).toBe(true)
    expect(probe!.head.text).toContain('安特魏普')
    expect(probe!.tail!.text).toContain('下期再见')
    // 窗口的时间坐标要带出来：用户看到"这是第几分钟的话"才知道该不该信它。
    expect(probe!.head.startS).toBe(0)
    expect(probe!.tail!.endS).toBe(3194)
  })

  /**
   * 尾段**转写为空是合法结果**，不是失败：活体 116 的末 30 秒就是纯片尾音乐，whisper 如实返回空。
   * 那时这一段照样带出去（`text: ''`），由判读层去解释——**绝不当错误吞掉**：
   * "尾部没有人说话"本身就是一条证据（可能是音乐收尾，也可能是被截断）。
   */
  it('某一段转写为空 → 照样返回那一段，不报错、不丢', async () => {
    const { d } = deps(['开头有话', ''])
    const probe = await probeHeadTail(d, file)
    expect(probe!.tail!.text).toBe('')
  })

  it('切不动的容器 → null，一次网络都不发', async () => {
    const { d } = deps(['x'])
    expect(await probeHeadTail(d, { ...file, path: '/lib/x.mkv' })).toBeNull()
    expect(d.rawUrl).not.toHaveBeenCalled()
  })

  it('时长不可用 → null，一次网络都不发', async () => {
    const { d } = deps(['x'])
    expect(await probeHeadTail(d, { ...file, durationS: undefined })).toBeNull()
    expect(d.rawUrl).not.toHaveBeenCalled()
  })

  it('短文件只取一段，也就只转写一次', async () => {
    const { d, transcribed } = deps(['整段'])
    const probe = await probeHeadTail(d, { ...file, sizeBytes: 2_000_000, durationS: 100 })
    expect(transcribed()).toBe(1)
    expect(probe!.tail).toBeUndefined()
  })
})
