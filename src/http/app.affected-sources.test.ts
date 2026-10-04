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

/**
 * `GET /api/sources/affected` —— 「这份 recipe 坏了会连累谁」的可查面。
 *
 * 它存在的理由：一份被共用的 detail recipe 漂了，用它的那几个 feed 源**各自的健康状态仍是绿的**
 * （没人替它们跑过那份 recipe），所以除了这里，没有任何一处能把它们点出来。
 */
const HOME = '@streamapp/xhs/xhs-home'
const SEARCH = '@streamapp/xhs/xhs-search'
const DETAIL = '@streamapp/xhs/xhs-detail'

const SOURCES = [
  mk({ id: HOME, description: '首页推荐', uses: [DETAIL] }),
  mk({ id: SEARCH, description: '搜索', uses: [DETAIL] }),
  mk({ id: DETAIL, description: '笔记详情' }),
  mk({ id: 'ghost/consumer', description: '指着一个装不到的源', uses: ['@nobody/pkg/gone'] }),
]

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'affected-'))
  const registry = new Registry(SOURCES)
  const scheduler = new Scheduler({
    registry, streams: [stream], adapters: new Map([['fake', fake]]),
    resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup: new DedupStore(join(dir, 'd.db')),
  })
  const service = new StreamService({
    registry, scheduler, channels: new UserStore(join(dir, 'svc.db')), plugins: [{ id: 'fake', name: 'Fake Plugin' }],
  })
  return createHttpApp({
    service,
    itemStore: new ItemStore(join(dir, 'i.db')),
    health,
    resolve: {
      registry,
      sourceHealth: undefined,
      resolveEngine: {} as never,
      intentResolver: {} as never,
      radarMatcher: {} as never,
      streams: () => [],
    } as never,
  })
}

async function ask(id: string) {
  const res = await build().request(`/api/sources/affected?id=${encodeURIComponent(id)}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('GET /api/sources/affected', () => {
  it('共用一份 detail 的两个 feed 源，一起被列出来', async () => {
    const { status, body } = await ask(DETAIL)
    expect(status).toBe(200)
    expect(body.id).toBe(DETAIL)
    expect((body.affected as Array<{ id: string }>).map((r) => r.id)).toEqual([DETAIL, HOME, SEARCH])
  })

  it('吃存量形状：库里的两截行重组出来的 xhs:xhs-detail、以及裸名', async () => {
    for (const legacy of ['xhs:xhs-detail', 'xhs-detail']) {
      const { body } = await ask(legacy)
      // 报的是归一后的全名，不是用户写下的那个串
      expect(body.id).toBe(DETAIL)
      expect((body.affected as Array<{ id: string }>).map((r) => r.id)).toContain(HOME)
    }
  })

  it('解析不到的 uses 边照实报出来——那是答案里的洞，不是噪音', async () => {
    const { body } = await ask(DETAIL)
    expect(body.unresolved).toEqual(['ghost/consumer → @nobody/pkg/gone'])
  })

  it('不存在的源 404，缺 id 400', async () => {
    expect((await ask('no/such/source')).status).toBe(404)
    expect((await build().request('/api/sources/affected')).status).toBe(400)
  })

  it('不和源目录那条路由撞车（/api/sources 仍是目录）', async () => {
    const res = await build().request('/api/sources')
    expect(res.status).toBe(200)
    // 目录那条回的不是 affected 的形状——两条路由各答各的
    expect(await res.json()).not.toHaveProperty('unresolved')
  })
})
