import { describe, it, expect } from 'vitest'
import { LiveStreamService } from './service.ts'

const manifest = { id: 'research-runs', adapter: 'builtin' } as never

function makeService(fetchImpl: (params?: unknown) => Promise<unknown>) {
  return new LiveStreamService({
    getStream: (id) => (id === 's1'
      ? { id: 's1', label: 'L', strategy: 'fanout', cadence_seconds: 0, members: [{ plugin: 'builtin', source: 'research-runs', params: { artifactsDir: '/d' } }], options: {} }
      : null) as never,
    manifestOf: () => manifest,
    adapterFor: () => ({ fetch: fetchImpl }) as never,
    runtimeConfigFor: () => ({}),
  })
}

describe('LiveStreamService', () => {
  it('把源返回的 raw 条目映射成 item 形状,带上 stream_id 和 source_id', async () => {
    const svc = makeService(async () => [
      { guid: 'research-run:r1', title: 'RUN 一号', description: 'sharpe=1.2', pubDate: '2026-08-01T00:00:00Z', author: 'research' },
    ])
    const items = await svc.items('s1')
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('research-run:r1')
    expect(items[0]!.stream_id).toBe('s1')
    expect(items[0]!.source_id).toBe('research-runs')
    expect(items[0]!.title).toBe('RUN 一号')
    expect(items[0]!.body_text).toBe('sharpe=1.2')
    expect(items[0]!.timestamp).toBe('2026-08-01T00:00:00Z')
  })

  it('成员 params 原样递给源(artifactsDir 靠它定位)', async () => {
    let seen: unknown
    const svc = makeService(async (params: unknown) => { seen = params; return [] })
    await svc.items('s1')
    expect(seen).toEqual({ artifactsDir: '/d' })
  })

  it('流不存在 → 抛 LiveStreamError(unknown_stream)', async () => {
    const svc = makeService(async () => [])
    await expect(svc.items('nope')).rejects.toMatchObject({ code: 'unknown_stream' })
  })

  it('源抛错原样上抛,不吞成空列表', async () => {
    const svc = makeService(async () => { throw new Error('artifactsDir 未配置') })
    await expect(svc.items('s1')).rejects.toThrow(/artifactsDir 未配置/)
  })
})
