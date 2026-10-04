import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { VIDEO_RANKING_STREAMS } from './types.ts'
import { loadPlugins } from '../plugins/loader.ts'
import { Registry } from '../registry/registry.ts'
import { canonicalSourceId } from '../streams/store.ts'

const PACKAGES = fileURLToPath(new URL('../../packages', import.meta.url))

/**
 * 影视频道的默认榜单种子写**包全名**（宿主自己的代码不吃裸名——第三方装一个同局部名的包就能把它
 * 推进歧义分支，见 docs/PACKAGE.md §1.1）。种子经 `putStream` 落库成 `{plugin:'rsshub', source}`，
 * 调度时拼成 `rsshub:<全名>`，`Registry.get` 第 2 级剥掉 `rsshub:` 后第 1 级精确命中——这里按那条
 * 真实路径核每一条都解析得到、而且落在声明它的那个包上。
 */
describe('VIDEO_RANKING_STREAMS', () => {
  const registry = new Registry(loadPlugins(PACKAGES).flatMap((p) => p.sources ?? []))

  it.each(VIDEO_RANKING_STREAMS)('$id → $source resolves through the stored-member path', (seed) => {
    expect(seed.source.startsWith('@streamapp/rsshub/')).toBe(true)
    const m = registry.get(canonicalSourceId('rsshub', seed.source))
    expect(m?.id).toBe(seed.source)
    expect(m?.normalizer).toBe('movie')
  })
})
