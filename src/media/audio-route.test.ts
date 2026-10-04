import { describe, it, expect } from 'vitest'
import { pickAudioContainer, pickAudioTrack, transcodeContainer, effectiveBitrate, trackLabel, type AudioContainer } from './audio-route.ts'

// 实测形状（百花杀 S01E17，2026-07-22）：5.5GiB 原盘 + 夸克四个转码档。
const ORIGINAL: AudioContainer = { kind: 'original', label: 'original', bytes: 5_911_523_677 }
const LOW = transcodeContainer({ resolution: 'low', url: 'https://cdn/low.mp4', sizeBytes: 143_139_304 })
const SUPER = transcodeContainer({ resolution: 'super', url: 'https://cdn/s.mp4', sizeBytes: 535_195_094 })

describe('pickAudioContainer — 抽音的网络代价是容器大小，不是音轨大小', () => {
  it('取最小的容器：低清转码档比原盘小 41 倍，赢', () => {
    const chosen = pickAudioContainer([ORIGINAL, SUPER, LOW])
    expect(chosen).toBe(LOW)
    expect(ORIGINAL.bytes! / chosen!.bytes!).toBeGreaterThan(40)
  })

  it('转码档没报大小 → 不可比，回落原盘（不拿猜的数字赌几百 MB 传输）', () => {
    const unsized = transcodeContainer({ resolution: 'low', url: 'https://cdn/l.mp4' })
    expect(pickAudioContainer([ORIGINAL, unsized])).toBe(ORIGINAL)
  })

  it('原盘大小未知 → 同样不可比，回落原盘', () => {
    const unknown: AudioContainer = { kind: 'original', label: 'original' }
    expect(pickAudioContainer([unknown, LOW])).toBe(unknown)
  })

  it('转码档并不更小（原盘本来就是低码率）→ 留在原盘', () => {
    const small: AudioContainer = { kind: 'original', label: 'original', bytes: 50_000_000 }
    expect(pickAudioContainer([small, LOW])).toBe(small)
  })

  it('大小相同算平手，归原盘——它不依赖转码存在、不怕档位过期', () => {
    const tie: AudioContainer = { kind: 'original', label: 'original', bytes: LOW.bytes }
    expect(pickAudioContainer([LOW, tie])).toBe(tie)
  })

  it('没有原盘（只给了档位）也能选', () => {
    expect(pickAudioContainer([SUPER, LOW])).toBe(LOW)
  })

  it('什么都没有 → undefined', () => {
    expect(pickAudioContainer([])).toBeUndefined()
  })
})

describe('effectiveBitrate — 无损编码必须单独一档', () => {
  it('容器声明了码率就用声明的', () => {
    expect(effectiveBitrate({ index: 1, codec: 'eac3', channels: 6, bitrate: 448_000 })).toBe(448_000)
  })

  it('有损编码没声明就按声道估', () => {
    expect(effectiveBitrate({ index: 1, codec: 'aac', channels: 2 })).toBe(192_000)
    expect(effectiveBitrate({ index: 2, codec: 'ac3', channels: 6 })).toBe(640_000)
  })

  it('FLAC 立体声不能按 192kbps 算——无损实打实 700kbps 以上', () => {
    // 低估是危险方向：它会让判决**主动选中**一条更贵的轨（高估只会让它避开）。
    const flac = effectiveBitrate({ index: 1, codec: 'flac', channels: 2 })
    expect(flac).toBeGreaterThan(700_000)
    expect(flac).toBeGreaterThan(effectiveBitrate({ index: 2, codec: 'aac', channels: 2 }))
  })

  it('TrueHD/DTS-HD 多声道估到 Mbps 级', () => {
    expect(effectiveBitrate({ index: 1, codec: 'truehd', channels: 8 })).toBeGreaterThan(3_000_000)
  })
})

describe('pickAudioTrack — 省的是产出（喂给 ASR 的字节），不是下载', () => {
  it('实测那一集的四条轨：取 128kbps 立体声，不取 448kbps 的 Atmos', () => {
    const tracks = [
      { index: 1, codec: 'eac3', channels: 6, bitrate: 448_000 },
      { index: 2, codec: 'flac', channels: 2 },
      { index: 3, codec: 'aac', channels: 2 },
      { index: 4, codec: 'eac3', channels: 2, bitrate: 128_000 },
    ]
    expect(pickAudioTrack(tracks)?.index).toBe(4)
  })

  it('不会因为 FLAC 被低估而选中它', () => {
    const tracks = [
      { index: 1, codec: 'flac', channels: 2 }, // 真实约 900kbps
      { index: 2, codec: 'aac', channels: 2, bitrate: 128_000 },
    ]
    expect(pickAudioTrack(tracks)?.index).toBe(2)
  })

  it('码率相同保持文件顺序', () => {
    expect(pickAudioTrack([{ index: 4, codec: 'aac', channels: 2 }, { index: 5, codec: 'aac', channels: 2 }])?.index).toBe(4)
  })

  it('没有音轨 → undefined', () => {
    expect(pickAudioTrack([])).toBeUndefined()
  })
})

describe('trackLabel', () => {
  it('把估出来的码率也印进去，日志里一眼看得出量级', () => {
    expect(trackLabel({ index: 4, codec: 'eac3', channels: 2, bitrate: 128_000 })).toBe('eac3/2ch/128kbps')
    expect(trackLabel({ index: 2, codec: 'flac', channels: 2 })).toBe('flac/2ch/900kbps')
  })
})
