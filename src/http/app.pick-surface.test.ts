import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHttpApp } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Scheduler } from '../scheduler.ts'
import { Registry } from '../registry/registry.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { UserStore } from '../store/user-store.ts'
import { fake, health, mk, stream } from './__fixtures__/app-harness.ts'
import type { PluginDescriptor } from '../plugins/types.ts'

/**
 * 「添加来源」和「给 Provider 挑成员」是**两个选择面**，共用同一个组件、同一个端点。这里钉的是
 * 端点真的按面过滤。
 *
 * 为什么这条用例值得存在：出错的方向是**多列出来**，而多列出来看起来完全正常——它就是一份更长
 * 的源列表。这条改动之前，"给小红书笔记点赞"（一个写操作）和"去 groq 建一把 API key"（一个要
 * 用户在场的配置流程）都能在「给频道添加来源」里被挑中，而界面上没有任何异样。
 */
const SOURCES = [
  mk({ id: 'feed-src', description: '一条普通的可订阅流' }),
  mk({ id: 'leg-src', description: '搜索腿：只当 Provider 成员', capabilities: ['search'], pick_in: ['provider'] }),
  mk({ id: 'action-src', description: '写操作：谁都不该挑它', capabilities: ['anchor'], pick_in: [] }),
]

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'pick-surface-'))
  const descriptors: PluginDescriptor[] = [{ id: 'fake', name: 'Fake Plugin' }]
  const registry = new Registry(SOURCES)
  const scheduler = new Scheduler({
    registry, streams: [stream], adapters: new Map([['fake', fake]]),
    resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup: new DedupStore(join(dir, 'd.db')),
  })
  const service = new StreamService({
    registry, scheduler, channels: new UserStore(join(dir, 'svc.db')), plugins: descriptors,
  })
  return createHttpApp({ service, itemStore: new ItemStore(join(dir, 'i.db')), health })
}

async function ids(path: string): Promise<string[]> {
  const res = await build().request(path)
  const body = await res.json() as { sources: Array<{ id: string }> }
  return body.sources.map((s) => s.id).sort()
}

describe('选择面过滤（surface）', () => {
  it('订阅面只给可订阅的流——搜索腿和写操作都不在', async () => {
    expect(await ids('/api/plugins/custom/sources?surface=stream')).toEqual(['feed-src'])
  })

  it('成员面额外给出搜索腿——它不是流，但确实该能被挑中', async () => {
    expect(await ids('/api/plugins/custom/sources?surface=provider')).toEqual(['feed-src', 'leg-src'])
  })

  it('不报面 = 两个面的并集，只滤掉"谁都不该挑"的那些（总览页用这一档）', async () => {
    expect(await ids('/api/plugins/custom/sources')).toEqual(['feed-src', 'leg-src'])
  })

  it('跨插件搜那一半用同一把尺——否则搜索框会把左边刚滤掉的端回来', async () => {
    const res = await build().request('/api/plugins/sources?surface=stream')
    const body = await res.json() as { sources: Array<{ id: string }> }
    expect(body.sources.map((s) => s.id).sort()).toEqual(['feed-src'])
  })

  it('surface 拼错了是 400，不是悄悄给一份更宽的列表', async () => {
    const res = await build().request('/api/plugins/custom/sources?surface=streams')
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { message: string } }).error.message).toContain('streams')
  })
})
