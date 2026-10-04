import { describe, it, expect } from 'vitest'
import { makeResolveDownload } from './resolve-download.ts'

const surface = (providerId: string | null, item: unknown) => ({
  providerExecutor: { invoke: async () => ({ strategy: 'sequential' as const, value: [item], via: 'm', misses: [], timings: [] }) },
  providerBindings: { dispatch: () => providerId },
})

describe('makeResolveDownload', () => {
  it('按 platform 派发拿到行 → 调它，字段映射走 mapDownloadItem', async () => {
    const r = await makeResolveDownload(() => surface('x-track', { url: 'https://cdn/a.flac', format: 'flac', author: 'A' }) as never)(
      { platform: 'x', id: '1' } as never)
    expect(r.audio).toMatchObject({ url: 'https://cdn/a.flac', format: 'flac', artist: 'A' })
  })
  it('没有行认领这个平台、但 pageUrl 本身是音频直链 → 直链档（播客的常态）', async () => {
    const r = await makeResolveDownload(() => surface(null, null) as never)(
      { platform: 'pod', id: '1', pageUrl: 'https://cdn/ep.mp3' } as never)
    expect(r.audio).toEqual({ url: 'https://cdn/ep.mp3', format: 'mp3' })
  })
  it('两档都落空 → audio: null', async () => {
    const r = await makeResolveDownload(() => surface(null, null) as never)({ platform: 'pod', id: '1' } as never)
    expect(r.audio).toBeNull()
  })
  it('Provider 面还没挂上 → 抛（不是记成"这首歌没资源"）', async () => {
    await expect(makeResolveDownload(() => undefined)({ platform: 'x', id: '1' } as never)).rejects.toThrow(/provider/i)
  })
  it('pageUrl 直链 + provider() 返回 undefined → 仍回直链，不抛', async () => {
    const r = await makeResolveDownload(() => undefined)({ platform: 'pod', id: '1', pageUrl: 'https://cdn/ep.mp3' } as never)
    expect(r.audio).toEqual({ url: 'https://cdn/ep.mp3', format: 'mp3' })
  })
})
