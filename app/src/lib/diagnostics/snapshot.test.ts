import { describe, expect, it } from 'vitest'
import { readDom, buildSample, type SampleDeps } from './snapshot.ts'
import { readMemory } from './capabilities.ts'
import type { AudioSnapshot } from './types.ts'

const deps = (over: Partial<SampleDeps> = {}): SampleDeps => ({
  doc: document,
  route: '/podcast',
  audio: () => null,
  memory: () => null,
  longTasks: () => null,
  resourceEntries: () => 0,
  ...over,
})

describe('readDom', () => {
  it('数出节点数与媒体元素数', () => {
    document.body.innerHTML = '<div><img/><img/><audio></audio></div>'
    const dom = readDom(document)
    expect(dom.img).toBe(2)
    expect(dom.audio).toBe(1)
    expect(dom.video).toBe(0)
    expect(dom.nodes).toBeGreaterThan(0)
  })
})

describe('readMemory 降级', () => {
  it('performance.memory 不存在时返回 null 且不抛（jsdom 就没有）', () => {
    expect(() => readMemory()).not.toThrow()
    expect(readMemory()).toBeNull()
  })

  it('存在时读出三个字段', () => {
    const perf = performance as unknown as Record<string, unknown>
    perf.memory = { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 }
    expect(readMemory()).toEqual({ usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 })
    delete perf.memory
  })
})

describe('buildSample', () => {
  it('无 memory API 时样本照常成型，memory 为 null', () => {
    const s = buildSample('sess', 123, deps())
    expect(s.sessionId).toBe('sess')
    expect(s.at).toBe(123)
    expect(s.memory).toBeNull()
    expect(s.route).toBe('/podcast')
  })

  it('未测量的指标记 null，绝不造 0 —— 「没测」和「实测为零」在读曲线时含义相反', () => {
    const s = buildSample('sess', 1, deps({ longTasks: () => null }))
    expect(s.longTasks).toBeNull()
    expect(s.longTasks).not.toEqual({ count: 0, totalMs: 0 })
  })

  it('测到了就如实记', () => {
    const s = buildSample('sess', 1, deps({ longTasks: () => ({ count: 3, totalMs: 420 }) }))
    expect(s.longTasks).toEqual({ count: 3, totalMs: 420 })
  })

  it('带上音频快照', () => {
    const audio: AudioSnapshot = {
      playing: true, currentTime: 10, duration: 4200, readyState: 4, networkState: 2,
      buffered: [{ start: 0, end: 120 }],
      media: { host: 'cdn.example.com', pathHash: 'abcd1234', sameOrigin: false },
    }
    const s = buildSample('sess', 1, deps({ audio: () => audio }))
    expect(s.audio!.buffered).toEqual([{ start: 0, end: 120 }])
    expect(s.audio!.duration).toBe(4200)
  })

  it('样本里不含任何 URL 原文', () => {
    const audio: AudioSnapshot = {
      playing: true, currentTime: 0, duration: 0, readyState: 0, networkState: 0, buffered: [],
      media: { host: 'cdn.example.com', pathHash: 'abcd1234', sameOrigin: false },
    }
    const s = buildSample('sess', 1, deps({ audio: () => audio }))
    expect(JSON.stringify(s)).not.toContain('http')
    expect(JSON.stringify(s)).not.toContain('.mp3')
  })
})
