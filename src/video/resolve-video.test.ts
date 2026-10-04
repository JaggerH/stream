import { describe, it, expect, vi } from 'vitest'
import { makeVideoResolver } from './resolve-video.ts'
import { SlotBrokenError } from '../providers/bindings.ts'
import type { InvokeResult } from '../providers/executor.ts'

const ok = (value: unknown): InvokeResult => ({ strategy: 'sequential', value, misses: [] } as unknown as InvokeResult)

describe('makeVideoResolver', () => {
  it('按 `<platform>-video` 派发，把 {vid, format} 交给选中的行', async () => {
    const dispatch = vi.fn().mockReturnValue('video-somesite')
    const invoke = vi.fn().mockResolvedValue(ok([{ kind: 'progressive', url: 'https://cdn.example.test/a.mp4' }]))
    const resolve = makeVideoResolver({ executor: { invoke }, bindings: { dispatch } })
    const r = await resolve('somesite', 'ID1', 'progressive')
    expect(dispatch).toHaveBeenCalledWith('video.resolve', 'somesite-video', undefined, { fallback: true })
    expect(invoke).toHaveBeenCalledWith('video-somesite', { vid: 'ID1', format: 'progressive' })
    expect(r).toEqual({ kind: 'progressive', url: 'https://cdn.example.test/a.mp4' })
  })

  it('没有绑定行 → 直接按 category+key 调（保持今天的回落形状）', async () => {
    const invoke = vi.fn().mockResolvedValue(ok([{ kind: 'dash', manifest: { durationS: 1, video: [], audio: [] } }]))
    const resolve = makeVideoResolver({ executor: { invoke }, bindings: { dispatch: () => null } })
    await resolve('somesite', 'ID1', 'dash')
    expect(invoke).toHaveBeenCalledWith({ category: 'resolve', key: 'somesite-video' }, { vid: 'ID1', format: 'dash' })
  })

  it('没有 bindings（最小装配）也能跑', async () => {
    const invoke = vi.fn().mockResolvedValue(ok([]))
    const resolve = makeVideoResolver({ executor: { invoke } })
    expect(await resolve('somesite', 'ID1', 'audio')).toBeNull()
  })

  it('成员没解析出东西 → null，不是抛', async () => {
    const resolve = makeVideoResolver({ executor: { invoke: async () => ok([]) } })
    expect(await resolve('somesite', 'ID1', 'progressive')).toBeNull()
    const none = makeVideoResolver({ executor: { invoke: async () => null } })
    expect(await none('somesite', 'ID1', 'progressive')).toBeNull()
  })

  it('sink 接下这一次的整份 InvokeResult，连 null（没有行匹配）也写——调用点按请求读它', async () => {
    const res = ok([])
    const sink: { last?: InvokeResult | null } = {}
    await makeVideoResolver({ executor: { invoke: async () => res } })('somesite', 'ID1', 'progressive', undefined, sink)
    expect(sink.last).toBe(res)
    const none: { last?: InvokeResult | null } = {}
    await makeVideoResolver({ executor: { invoke: async () => null } })('somesite', 'ID1', 'progressive', undefined, none)
    expect(none.last).toBeNull()
  })

  it('SlotBrokenError 照原样抛出去——它是显式意图坏了，调用点要回 422', async () => {
    const dispatch = () => { throw new SlotBrokenError('ch1', 'video.resolve', ['gone']) }
    const resolve = makeVideoResolver({ executor: { invoke: async () => ok([]) }, bindings: { dispatch } })
    await expect(resolve('somesite', 'ID1', 'dash', { channelId: 'ch1' } as never)).rejects.toBeInstanceOf(SlotBrokenError)
  })
})
