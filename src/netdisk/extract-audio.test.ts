import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractNetdiskAudio } from './extract-audio.ts'
import * as extract from '../media/extract.ts'
import { AudioCache } from '../media/audio-cache.ts'

vi.mock('../media/extract.ts', () => ({
  probeStreams: vi.fn(),
  extractStream: vi.fn(),
}))
vi.mock('../media/prefetch.ts', () => ({ prefetchToFile: vi.fn() }))
import { prefetchToFile } from '../media/prefetch.ts'

/**
 * 注入用的缓存：**真 `AudioCache`**，只把落盘的 read/write 换成桩。
 *
 * 在途表（share/isInFlight）是这里要测的那一半，**绝不能拿假的顶**——那等于把「同一时刻只抽
 * 一次」测成了「我说它只抽一次」。而 read/write 打桩只是为了不碰真磁盘、并且看得见调用参数。
 */
function fakeCache(over: {
  read: (k: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
  write: (k: string, v: { bytes: Uint8Array; mime: string }) => Promise<void>
}) {
  const cache = new AudioCache('/nonexistent-audio-cache-dir')
  vi.spyOn(cache, 'read').mockImplementation(over.read)
  vi.spyOn(cache, 'write').mockImplementation(over.write)
  return cache as AudioCache & typeof over
}

const FILE_BYTES = 5_911_523_677 // 实测那一集的原盘：5.5GiB
const LOW_BYTES = 143_139_304 // 夸克 low 档：143MiB
const netdisk = {
  rawUrl: vi.fn(async (p: string) => `http://fake${p}`),
  fileSize: vi.fn(async () => FILE_BYTES),
}

beforeEach(() => {
  vi.mocked(extract.probeStreams).mockReset()
  vi.mocked(extract.extractStream).mockReset()
  vi.mocked(extract.extractStream).mockResolvedValue({ bytes: Buffer.from('audio'), mime: 'audio/x-matroska' })
  // 默认：预取失败 → 走流式回落。要测预取成功的用例自己覆写。
  vi.mocked(prefetchToFile).mockReset()
  vi.mocked(prefetchToFile).mockImplementation(async () => { throw new Error('prefetch unavailable') })
  netdisk.rawUrl.mockClear()
  netdisk.fileSize.mockClear()
})

describe('extractNetdiskAudio — 挑容器', () => {
  it('有更小的转码档就从它抽，而不是从 5.5GiB 原盘抽', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2, bitrate: 47_000 }],
    })
    const onTiming = vi.fn()

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', {
      onTiming,
      transcodeCandidates: async () => [
        { resolution: 'super', url: 'https://cdn/s.mp4', sizeBytes: 535_195_094 },
        { resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES, headers: { cookie: 'k=v' } },
      ],
    })

    // 探的和抽的都必须是**选中那个容器**，且带上取它所需的凭证（此例预取失败 → 流式回落）
    expect(extract.probeStreams).toHaveBeenCalledWith('https://cdn/low.mp4', { headers: { cookie: 'k=v' } })
    expect(extract.extractStream).toHaveBeenCalledWith('https://cdn/low.mp4', { index: 1, kind: 'audio', headers: { cookie: 'k=v' } })
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({
      container: 'transcode', containerLabel: 'transcode:low', containerBytes: LOW_BYTES, containers: 3,
      prefetchMs: undefined,
    }))
  })

  it('没有转码档就走原盘，行为等同接线之前', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 2, codec: 'eac3', channels: 2, bitrate: 128_000 }],
    })
    const onTiming = vi.fn()

    await extractNetdiskAudio(netdisk, '/quark/show/e1.mkv', { onTiming })

    expect(extract.extractStream).toHaveBeenCalledWith('http://fake/quark/show/e1.mkv', { index: 2, kind: 'audio', headers: undefined })
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({
      container: 'original', containerBytes: FILE_BYTES, containers: 1, track: 'eac3/2ch/128kbps', tracks: 1,
    }))
  })

  it('网盘答不出档位 → 少一个候选，不是失败', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', {
      transcodeCandidates: async () => { throw new Error('quark says no') },
    })

    expect(extract.extractStream).toHaveBeenCalledWith('http://fake/quark/e.mkv', { index: 1, kind: 'audio', headers: undefined })
  })

  it('原盘大小求不到 → 不可比，回落原盘而不是赌转码档', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })
    const noSize = { ...netdisk, fileSize: vi.fn(async () => { throw new Error('alist down') }) }

    await extractNetdiskAudio(noSize, '/quark/e.mkv', {
      transcodeCandidates: async () => [{ resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES }],
    })

    expect(extract.extractStream).toHaveBeenCalledWith('http://fake/quark/e.mkv', expect.objectContaining({ index: 1 }))
  })
})

describe('extractNetdiskAudio — 并行预取', () => {
  const lowCandidate = { resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES, headers: { cookie: 'k=v' } }

  it('容器不大 → 先预取到本地，探测和提取都对着本地文件、不再带远端凭证，完了清临时', async () => {
    const cleanup = vi.fn(async () => {})
    vi.mocked(prefetchToFile).mockResolvedValue({ path: '/tmp/pf/container', bytes: LOW_BYTES, ms: 13000, connections: 4, cleanup })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2, bitrate: 47_000 }],
    })
    const onTiming = vi.fn()

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', { onTiming, transcodeCandidates: async () => [lowCandidate] })

    expect(prefetchToFile).toHaveBeenCalledWith('https://cdn/low.mp4', { size: LOW_BYTES, headers: { cookie: 'k=v' } })
    expect(extract.probeStreams).toHaveBeenCalledWith('/tmp/pf/container', { headers: undefined })
    expect(extract.extractStream).toHaveBeenCalledWith('/tmp/pf/container', { index: 1, kind: 'audio', headers: undefined })
    expect(cleanup).toHaveBeenCalled()
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ prefetchMs: 13000, prefetchConnections: 4 }))
  })

  it('容器太大（4k 档 / 原盘）→ 不预取，流式抽', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', {
      transcodeCandidates: async () => [{ resolution: '4k', url: 'https://cdn/4k.mp4', sizeBytes: 1_791_699_008 }],
    })

    expect(prefetchToFile).not.toHaveBeenCalled()
    expect(extract.extractStream).toHaveBeenCalledWith('https://cdn/4k.mp4', expect.objectContaining({ index: 1 }))
  })

  it('提取中途抛错也要清掉预取的临时文件', async () => {
    const cleanup = vi.fn(async () => {})
    vi.mocked(prefetchToFile).mockResolvedValue({ path: '/tmp/pf/container', bytes: LOW_BYTES, ms: 1, connections: 4, cleanup })
    vi.mocked(extract.probeStreams).mockResolvedValue({ video: [], subtitle: [], audio: [] })

    await expect(
      extractNetdiskAudio(netdisk, '/quark/e.mkv', { transcodeCandidates: async () => [lowCandidate] }),
    ).rejects.toThrow('no audio stream')
    expect(cleanup).toHaveBeenCalled()
  })
})

describe('extractNetdiskAudio — 音轨缓存', () => {
  it('命中 → 零网络：rawUrl/判路/探测/提取全不发生', async () => {
    const cache = fakeCache({
      read: vi.fn(async () => ({ bytes: Buffer.from('cached'), mime: 'audio/x-matroska' })),
      write: vi.fn(async () => {}),
    })
    const onTiming = vi.fn()

    const r = await extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache, onTiming })

    expect(Buffer.from(r.bytes).toString()).toBe('cached')
    expect(netdisk.rawUrl).not.toHaveBeenCalled()
    expect(extract.probeStreams).not.toHaveBeenCalled()
    expect(extract.extractStream).not.toHaveBeenCalled()
    expect(cache.write).not.toHaveBeenCalled()
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ cached: true }))
  })

  it('未命中 → 正常提取并写回缓存', async () => {
    const cache = fakeCache({ read: vi.fn(async () => null), write: vi.fn(async () => {}) })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache })

    expect(cache.write).toHaveBeenCalledWith('/quark/e.mkv', expect.objectContaining({ mime: 'audio/x-matroska' }))
  })

  it('缓存读写抛错都不拖累提取', async () => {
    const cache = fakeCache({
      read: vi.fn(async () => { throw new Error('disk gone') }),
      write: vi.fn(async () => { throw new Error('disk full') }),
    })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    const r = await extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache })
    expect(r.mime).toBe('audio/x-matroska')
  })

  it('两个消费方同时要同一集：只抽一次，第二个等第一个', async () => {
    // 取白文 ‖ 声纹时间轴——并行之后这是常态。落盘缓存拦不住它（取完才写），只有在途表能。
    const cache = fakeCache({ read: vi.fn(async () => null), write: vi.fn(async () => {}) })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    const [a, b] = await Promise.all([
      extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache }),
      extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache }),
    ])

    expect(extract.extractStream).toHaveBeenCalledTimes(1) // ← 整条规则就是这个数字
    expect(netdisk.rawUrl).toHaveBeenCalledTimes(1)
    expect(Buffer.from(a.bytes).toString()).toBe(Buffer.from(b.bytes).toString())
  })

  it('等来的那一份也要在账上留一条 timing，不静静少一条', async () => {
    const cache = fakeCache({ read: vi.fn(async () => null), write: vi.fn(async () => {}) })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })
    const first = vi.fn()
    const second = vi.fn()

    await Promise.all([
      extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache, onTiming: first }),
      extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache, onTiming: second }),
    ])

    expect(first).toHaveBeenCalledWith(expect.objectContaining({ containerLabel: 'original' }))
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ containerLabel: 'inflight', cached: true }))
  })

  it('不同的集各抽各的', async () => {
    const cache = fakeCache({ read: vi.fn(async () => null), write: vi.fn(async () => {}) })
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2 }],
    })

    await Promise.all([
      extractNetdiskAudio(netdisk, '/quark/e1.mkv', { cache }),
      extractNetdiskAudio(netdisk, '/quark/e2.mkv', { cache }),
    ])

    expect(extract.extractStream).toHaveBeenCalledTimes(2)
  })

  it('显式 index 是调试路径，不读也不写缓存', async () => {
    const cache = fakeCache({ read: vi.fn(async () => null), write: vi.fn(async () => {}) })

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', { cache, index: 3 })

    expect(cache.read).not.toHaveBeenCalled()
    expect(cache.write).not.toHaveBeenCalled()
  })
})

describe('extractNetdiskAudio — 选中容器后挑轨', () => {
  it('取最便宜的那条轨；它决定产出大小，不决定下载量', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [],
      audio: [
        { index: 1, codec: 'eac3', channels: 6, bitrate: 448_000 },
        { index: 4, codec: 'eac3', channels: 2, bitrate: 128_000 },
      ],
    })
    const onTiming = vi.fn()

    await extractNetdiskAudio(netdisk, '/quark/e.mkv', { onTiming })

    expect(extract.extractStream).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ index: 4 }))
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({ track: 'eac3/2ch/128kbps', tracks: 2 }))
  })

  it('显式 index：调用方已经判过了，不探测、不判路', async () => {
    await extractNetdiskAudio(netdisk, '/quark/e.mkv', { index: 3 })

    expect(extract.probeStreams).not.toHaveBeenCalled()
    expect(netdisk.fileSize).not.toHaveBeenCalled()
    expect(extract.extractStream).toHaveBeenCalledWith('http://fake/quark/e.mkv', { index: 3, kind: 'audio' })
  })

  it('容器里一条音轨都没有 → 抛错，交给调用方降级', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({ video: [], audio: [], subtitle: [] })

    await expect(extractNetdiskAudio(netdisk, '/quark/e.mkv')).rejects.toThrow('no audio stream')
  })
})

describe('extractNetdiskAudio — 转码档失败回落原盘', () => {
  // 真实事故(2026-07-23):夸克转码直链全家 412(带 cookie+referer+同 UA 照拒),ffprobe 对它必炸;
  // 而原盘 AList 直链同刻 206 正常。播放代理早有 rawFallback,抽音轨此前没有——转码档一炸整个
  // extract 抛错,job 记 'no transcribable media',用户看到的是"网盘音频腿挂了"(其实只有转码腿挂)。
  it('转码档 probe 炸(如夸克 412) → 回落原盘重探重抽,onTiming 记 fellBackFrom', async () => {
    vi.mocked(extract.probeStreams).mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn/')) throw new Error('Server returned 4XX Client Error, but not one of 40{0,1,3,4}')
      return { video: [], subtitle: [], audio: [{ index: 1, codec: 'eac3', channels: 6, bitrate: 640_000 }] }
    })
    const onTiming = vi.fn()

    const r = await extractNetdiskAudio(netdisk, '/quark/e.mkv', {
      onTiming,
      transcodeCandidates: async () => [
        { resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES, headers: { cookie: 'k=v' } },
      ],
    })

    expect(r.mime).toBe('audio/x-matroska')
    // 第二轮探/抽必须打原盘 rawUrl 且不带转码档的凭证头
    expect(extract.probeStreams).toHaveBeenLastCalledWith('http://fake/quark/e.mkv', { headers: undefined })
    expect(extract.extractStream).toHaveBeenCalledWith('http://fake/quark/e.mkv', { index: 1, kind: 'audio', headers: undefined })
    expect(onTiming).toHaveBeenCalledWith(expect.objectContaining({
      container: 'original', fellBackFrom: 'transcode:low',
    }))
  })

  it('转码档 extractStream 炸 → 同样回落原盘', async () => {
    vi.mocked(extract.probeStreams).mockResolvedValue({
      video: [], subtitle: [], audio: [{ index: 1, codec: 'aac', channels: 2, bitrate: 47_000 }],
    })
    vi.mocked(extract.extractStream).mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn/')) throw new Error('curl 412 mid-stream')
      return { bytes: Buffer.from('audio'), mime: 'audio/x-matroska' }
    })

    const r = await extractNetdiskAudio(netdisk, '/quark/e.mkv', {
      transcodeCandidates: async () => [
        { resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES },
      ],
    })
    expect(r.bytes.toString()).toBe('audio')
    expect(extract.extractStream).toHaveBeenLastCalledWith('http://fake/quark/e.mkv', expect.objectContaining({ kind: 'audio' }))
  })

  it('原盘本身炸不回落(没有更下一级),原错误上抛', async () => {
    vi.mocked(extract.probeStreams).mockRejectedValue(new Error('origin dead'))
    await expect(extractNetdiskAudio(netdisk, '/quark/e.mkv')).rejects.toThrow('origin dead')
    expect(extract.probeStreams).toHaveBeenCalledTimes(1)
  })

  it('回落后原盘也炸 → 抛原盘的错误(带上下文),不无限循环', async () => {
    vi.mocked(extract.probeStreams).mockRejectedValue(new Error('everything dead'))
    await expect(
      extractNetdiskAudio(netdisk, '/quark/e.mkv', {
        transcodeCandidates: async () => [{ resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: LOW_BYTES }],
      })
    ).rejects.toThrow('everything dead')
    expect(extract.probeStreams).toHaveBeenCalledTimes(2) // 转码一次 + 原盘一次,恰好两次
  })
})
