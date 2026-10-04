import { describe, it, expect } from 'vitest'
import { createHttpApp } from './app.ts'
import type { PluginDescriptor } from '../plugins/types.ts'

/**
 * `/api/plugins` 的响应不是把状态行展开,而是 `mergePluginStatus` **挑字段重组**出来的。
 * 挑漏一个,该字段就在 HTTP 边界悄悄消失,而直测 `aggregatePluginStatus`(字段确实是在那层挂上的)
 * 的单测照样全绿 —— standby 就这么漏过了十轮任务评审加一次整分支评审,最后是活体 curl 才看出来。
 * 这个文件专钉「状态行 → 客户端」这一段投影。
 *
 * 刻意独立成文件而不是塞进 `app.test.ts`:那个文件已经 139 条 / 单跑 50 秒,再加两条就会把邻居
 * (一条 5 秒超时的频道测试)在全量并行下挤爆 —— 实测过,加进去必红、跳过就绿。
 */
describe('plugin status projection', () => {
  const descriptors: PluginDescriptor[] = [{ id: 'fake', name: 'Fake Plugin' } as PluginDescriptor]
  // 最小装配:这段只关心响应投影,不需要 Scheduler/Registry/SQLite。service 只被插件路由读
  // `plugins`,给一个够用的替身即可。
  const build = (pluginStatus: () => Promise<unknown[]>) =>
    createHttpApp({
      service: { plugins: () => descriptors } as unknown as Parameters<typeof createHttpApp>[0]['service'],
      itemStore: { list: () => [], get: () => undefined } as unknown as Parameters<typeof createHttpApp>[0]['itemStore'],
      health: async () => ({}) as never,
      pluginStatus,
    } as Parameters<typeof createHttpApp>[0])

  it('carries standby state through to the client', async () => {
    const app = build(async () => [
      { id: 'fake', configured: true, health: 'ok', standby: { state: 'asleep', lastUsed: 123, lastWakeMs: 4567 } },
    ])
    const rows = (await (await app.request('/api/plugins')).json()) as { id: string; standby?: unknown }[]
    expect(rows.find((r) => r.id === 'fake')?.standby).toEqual({ state: 'asleep', lastUsed: 123, lastWakeMs: 4567 })
  })

  it('adds no standby key for plugins that have none', async () => {
    const app = build(async () => [{ id: 'fake', configured: true, health: 'ok' }])
    const rows = (await (await app.request('/api/plugins')).json()) as Record<string, unknown>[]
    expect(rows.find((r) => r.id === 'fake')).not.toHaveProperty('standby')
  })
})
