import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHttpApp } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { UserStore } from '../store/user-store.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { join } from 'path'
import { createHttpApiFixture, fake, health, manifests, stream, type HttpApiFixture } from './__fixtures__/app-harness.ts'

// ── 同一个 method+path 被注册两次 = 后注册的那个永远够不到 ──
//
// 这不是理论洁癖，是 2026-08-02 的活体事故：意图跟踪那条线把 `GET /api/intents` 用作它的
// 列表端点，而 radar（URL → 候选源）本来就占着同一个路径。Hono 谁先注册谁应答，于是 radar
// 整条哑掉，扩展 popup 拿到 `{intents:[…]}`、读 `matches` 时**整个 popup 崩成一条空壳**。
//
// **为什么两边的单测都是绿的**：每个路由文件的测试只挂载自己那半个 app（`registerResolveRoutes`
// 单独挂一个 Hono、intents 的测试单独建一个），冲突只存在于**真实装配**里。所以这条守卫必须
// 建在整装的 app 上，而且判据是"路由表里有没有重复"，不是"某个端点返回对不对"——后者只能
// 一个个补，前者对所有未来的路径一次到位。
describe('路由表：没有两个 handler 抢同一个 method+path', () => {
  let fixture: HttpApiFixture
  let dir: string
  beforeEach(() => {
    fixture = createHttpApiFixture()
    ;({ dir } = fixture)
  })
  afterEach(() => fixture.close())

  it('整装 app 里 method+path 唯一', () => {
    const registry = new Registry(manifests)
    const channelStore = new UserStore(join(dir, `collide-${Math.random()}.db`))
    const sourceHealth = new SourceHealthStore(join(dir, `collide-health-${Math.random()}.json`))
    const scheduler = new Scheduler({
      registry,
      streams: [stream],
      adapters: new Map([['fake', fake]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'v'),
      dedup: fixture.dedup,
    })
    const app = createHttpApp({
      service: new StreamService({ registry, scheduler, channels: channelStore }),
      itemStore: fixture.store,
      health,
      channelStore,
      // resolve 在场才会挂 radar；intents 的那批路由是无条件注册的，所以这一份 deps 就够
      // 复现「radar vs 意图跟踪」那次撞车。
      resolve: {
        registry,
        sourceHealth,
        resolveEngine: {} as never,
        intentResolver: {} as never,
        radarMatcher: {} as never,
        streams: () => scheduler.list(),
      },
    })

    const seen = new Map<string, number>()
    for (const r of app.routes) {
      // Hono 内部会把中间件也放进 routes（method='ALL' 且 handler 名为 middleware）——
      // 中间件本来就允许层叠，只看真正的端点。
      if (r.method === 'ALL') continue
      const key = `${r.method} ${r.path}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    expect(dupes).toEqual([])
  })
})
