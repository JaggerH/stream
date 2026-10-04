import { describe, expect, it } from 'vitest'
import { PRESENTS, presentDescriptor } from './presents.ts'

describe('present registry', () => {
  it('registers the seven official presents', () => {
    expect(PRESENTS.map((p) => p.id).sort()).toEqual(['audio', 'embed', 'research', 'search', 'tasks', 'timeline', 'video'])
    expect(presentDescriptor('search')?.needsStreams).toBe(false)
    expect(presentDescriptor('timeline')?.needsStreams).toBe(true)
  })

  it('tasks 跟 search 同形：不绑流、live 取数、没有专属槽位', () => {
    const p = presentDescriptor('tasks')!
    expect(p.needsStreams).toBe(false)
    expect(p.data).toBe('live')
    expect(p.slots).toEqual([])
  })
  it('embed 跟 search 同形：不绑流、live、没有槽位——它的全部配置就是 options.url', () => {
    const p = presentDescriptor('embed')!
    expect(p.label).toBe('外接面板')
    expect(p.needsStreams).toBe(false)
    expect(p.data).toBe('live')
    expect(p.slots).toEqual([])
  })
  it('aggregates slots from callsite entries — single source of truth in callsites.ts', () => {
    const video = presentDescriptor('video')!
    expect(video.slots.map((s) => s.callsiteId)).toContain('search.video')
    expect(video.slots.map((s) => s.callsiteId)).toContain('netdisk.play')
    // 影视作品页的「找资源」写的就是这个槽位——它必须出现在 video Present 的 slots 里,
    // 否则频道管理面看不见、清不掉这条覆盖（chip 和 Sheet 不是同一份数据）。
    expect(video.slots.map((s) => s.callsiteId)).toContain('search.resources')
    const timeline = presentDescriptor('timeline')!
    expect(timeline.slots.map((s) => s.callsiteId)).toContain('search.resources')
    // slot 元数据来自 callsite 本体
    const slot = timeline.slots.find((s) => s.callsiteId === 'search.resources')!
    expect(slot.category).toBe('search')
    expect(slot.mode).toBe('fixed')
  })

  it('research 是 live 取数、且要绑流', () => {
    const p = presentDescriptor('research')!
    expect(p.data).toBe('live')
    expect(p.needsStreams).toBe(true)
    expect(p.slots).toEqual([])
  })

  it('三个采集 present 是 collected', () => {
    for (const id of ['timeline', 'audio', 'video']) {
      expect(presentDescriptor(id)!.data).toBe('collected')
    }
  })

  it('search 不绑流但也是 live', () => {
    expect(presentDescriptor('search')!.needsStreams).toBe(false)
    expect(presentDescriptor('search')!.data).toBe('live')
  })

  it('每个 present 都显式声明了 data 轴', () => {
    for (const p of PRESENTS) expect(['collected', 'live']).toContain(p.data)
  })
})
