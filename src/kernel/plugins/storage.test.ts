import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, quiesceKernel } from '../context.ts'
import { storagePlugin, type Stores } from './storage.ts'

function mount() {
  const dir = mkdtempSync(join(tmpdir(), 'stream-storage-'))
  const kernel = createKernel()
  const fiber = kernel.plugin(storagePlugin, {
    dataDir: dir,
    streamDb: join(dir, 'stream.db'),
    cacheDb: join(dir, 'cache.db'),
    legacyItemDb: join(dir, 'items.db'),
    legacyDedupDb: join(dir, 'dedup.db'),
    audioArchiveRoot: join(dir, 'archive'),
    audioArchiveDb: join(dir, 'audio-archive.db'),
    log: () => {},
    downloadQueueDeps: ({ archive }) => ({
      archive,
      resolveDownload: async () => ({ audio: null }),
      syncEnabled: () => false,
      setSyncEnabled: () => {},
    }),
  })
  return { kernel, dir, ready: fiber }
}

/** 有 close() 的那些——它们各持一个 sqlite 连接，是本域要清的欠账。 */
const CLOSEABLE: (keyof Stores)[] = [
  'dedup', 'itemStore', 'storyFold', 'contentCache', 'audioArchive', 'downloadQueue',
  'channels', 'seenStore', 'collections', 'watchProgress', 'discoveredChannels',
]

describe('storagePlugin', () => {
  it('挂成 ctx.stores 的一个聚合对象，dispose 后整体消失', async () => {
    const { kernel, ready } = mount()
    await ready
    for (const k of [...CLOSEABLE, 'sourceHealth' as const]) expect(kernel.stores[k]).toBeDefined()
    await quiesceKernel(kernel)
    expect(kernel.stores).toBeUndefined()
  })

  // 这条是本域存在的主要理由：搬进来之前只有 dedup / itemStore 两个在关停路径上被手写关掉，
  // 其余十来个句柄从没人关。往 Stores 里加一个持句柄的 store 却忘了包 effect，这里当场变红。
  it('每个持句柄的 store 都随 dispose 关掉', async () => {
    const { kernel, ready } = mount()
    await ready
    const closed: string[] = []
    for (const k of CLOSEABLE) {
      const store = kernel.stores[k] as unknown as { close(): void }
      const original = store.close.bind(store)
      store.close = () => { closed.push(k); original() }
    }
    await quiesceKernel(kernel)
    expect(closed.sort()).toEqual([...CLOSEABLE].sort())
  })

  // 上面那条只能证明「名册里的都关了」。这条守的是名册本身：新加一个持句柄的 store 却没登记
  // effect（也没进 CLOSEABLE），这里变红——否则它会静默变成第 12 个没人关的句柄。
  it('Stores 上带 close() 的字段恰好就是名册里那些', async () => {
    const { kernel, ready } = mount()
    await ready
    const withClose = (Object.keys(kernel.stores) as (keyof Stores)[])
      .filter((k) => typeof (kernel.stores[k] as { close?: unknown }).close === 'function')
    expect(withClose.sort()).toEqual([...CLOSEABLE].sort())
    await quiesceKernel(kernel)
  })
})
