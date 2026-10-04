import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { join } from 'node:path'
import { mountResearchRoutes, isSafeSegment } from './research-routes.ts'
import { researchRunsFn } from '../board/run-source.ts'
import { LiveStreamService } from '../live/service.ts'
// 前端导航剥前缀用的**同一个**函数（shared/，两侧同源）——所以这条测试确实跨了边界。
import { runIdFromGuid } from '../../shared/research/run-guid.ts'

const FIX = join(import.meta.dirname, '__fixtures__', 'research-artifacts')
const RUN = '20260801-000000-aaaaaa'
// ASCII 白名单会判死的 90 个真实 artifact 里，**大多数是名字带空格**（54 个不重复名），
// 中文只占少数（16 个）——包括那个唯一的 distribution artifact，它是被空格挡的，不是被中文。
// 两种形状都得有夹具：只锁中文那一种，锁的不是真实数据里的主要形状。
const SPACE_ARTIFACT = 'R-multiple distribution'
const CN_ARTIFACT = 'top_window_C_物理需求中国房地产'

function app(dirForStream: (s: string) => string = () => FIX) {
  const a = new Hono()
  mountResearchRoutes(a, { dirForStream })
  return a
}

describe('GET /api/research/streams/:streamId/runs/:runId', () => {
  it('返回完整 manifest,artifacts 清单原样带出', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { artifacts: Array<{ name: string; view: string }>; metrics: Record<string, unknown> }
    expect(body.artifacts).toEqual([
      { name: 'curve', view: 'timeseries' }, { name: 'note', view: 'text' },
      { name: CN_ARTIFACT, view: 'timeseries' }, { name: SPACE_ARTIFACT, view: 'distribution' },
    ])
    expect(body.metrics).toEqual({ sharpe: 1.23 })
  })

  it('manifest 出网形状是完整的 11 个字段,schema 与 params 不丢', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'artifacts', 'created_at', 'finished_at', 'id', 'metrics', 'name',
      'params', 'schema', 'status', 'tags', 'variant',
    ])
    expect(body.schema).toBe('run/v1')
    expect(body.params).toEqual({})
  })

  it('run 不存在 → 404', async () => {
    const res = await app().request('/api/research/streams/s1/runs/20260101-000000-zzzzzz')
    expect(res.status).toBe(404)
  })

  it('runId 含路径穿越 → 400,且不去碰文件系统', async () => {
    const res = await app().request('/api/research/streams/s1/runs/..%2F..%2Fetc')
    expect(res.status).toBe(400)
  })

  // 纯 ".." 走不到路由层做 400/404 对照:@hono/node-server 和 fetch 的 URL 解析都会
  // 在分发前把请求行里字面的 ".." 以及单层编码的 "%2e%2e" 按 WHATWG URL 规范折叠掉
  // (实测:GET .../runs/.. 与 .../runs/%2e%2e 均被折成 .../s1,路由 404,拿不到穿越用
  // 的 runId 参数;双重编码 "%252e%252e" 能躲过折叠,但 Hono 的 param 只解一层,拿到的
  // 还是字面的 "%2e%2e" 而非 "..")。真正做判断的是 isSafeSegment,直接测它。
  it('isSafeSegment: 纯点分量一律拒绝(runId 用法)', () => {
    expect(isSafeSegment('..')).toBe(false)
    expect(isSafeSegment('.')).toBe(false)
    expect(isSafeSegment('...')).toBe(false)
    expect(isSafeSegment(RUN)).toBe(true)
  })

  it('artifactsDir 没配 → 400 带那句人话', async () => {
    const res = await app(() => { throw new Error('research source: artifactsDir 未配置(...)') })
      .request(`/api/research/streams/s1/runs/${RUN}`)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/artifactsDir 未配置/)
  })
})

describe('GET .../artifacts/:name', () => {
  it('返回 artifact 全文,config 不丢', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/curve`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ schema: 'artifact/v1', view: 'timeseries', name: 'curve', config: { ylabel: 'PnL' } })
  })

  it('text 类 artifact 一样取得到(不是只有图表 view 能读)', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/note`)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: string }).data).toContain('结论')
  })

  it('artifact 名含路径穿越 → 400', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/..%2Frun`)
    expect(res.status).toBe(400)
  })

  // 同上,纯 ".." 走不到路由层;直接测 isSafeSegment 的 name 用法。
  it('isSafeSegment: 纯点分量一律拒绝(artifact name 用法)', () => {
    expect(isSafeSegment('..')).toBe(false)
    expect(isSafeSegment('curve')).toBe(true)
  })

  // 段校验是**黑名单**（拒分隔符 + 拒纯点），不是 ASCII 白名单：白名单版本把真实数据里
  // 90 个 artifact 全判成 400。带空格的那一档是主力（54/69 个不重复名），且唯一一个
  // distribution artifact 正在其中——白名单一上，那个 view 对现有数据一次都跑不到。
  it('artifact 名带空格 → 200,负载与 config 照样带出', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/${encodeURIComponent(SPACE_ARTIFACT)}`)
    expect(res.status).toBe(200)
    // 真实 distribution 的负载是 {values: [...]}——前端 isDistributionData 认的也是它。
    expect(await res.json()).toMatchObject({ view: 'distribution', name: SPACE_ARTIFACT, data: { values: expect.any(Array) }, config: { title: 'R 分布' } })
  })

  it('artifact 名含中文 → 200,config 照样带出', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/${encodeURIComponent(CN_ARTIFACT)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ view: 'timeseries', name: CN_ARTIFACT, config: { title: '物理需求' } })
  })

  it('isSafeSegment: 带空格与中文的段都放行,含分隔符的一律拒', () => {
    expect(isSafeSegment(SPACE_ARTIFACT)).toBe(true)
    expect(isSafeSegment(CN_ARTIFACT)).toBe(true)
    expect(isSafeSegment('a/b')).toBe(false)
    expect(isSafeSegment('a\\b')).toBe(false)
    expect(isSafeSegment('')).toBe(false)
  })

  it('artifact 不存在 → 404', async () => {
    const res = await app().request(`/api/research/streams/s1/runs/${RUN}/artifacts/nope`)
    expect(res.status).toBe(404)
  })

  it('artifactsDir 没配 → 400', async () => {
    const res = await app(() => { throw new Error('research source: artifactsDir 未配置(...)') })
      .request(`/api/research/streams/s1/runs/${RUN}/artifacts/curve`)
    expect(res.status).toBe(400)
  })
})

// —— 生产者 → 列表 → 详情路由：一条真正跨过边界的回归 ——
//
// 这一档存在的理由不是"再测一遍 400"，而是**两侧夹具各写各的**那类缺陷：列表侧的测试用
// `r1`，路由侧的测试用 `20260801-000000-aaaaaa`，两边各自都绿，接起来整条列表点进去全 400
// （id 上还挂着 `research-run:` 前缀，段校验不放行冒号）。所以这里**不手写形状**——
// 让真实生产者（researchRunsFn）在真实夹具目录上吐，再把吐出来的 id 原路喂进详情路由。
describe('生产者 → 详情路由(跨边界)', () => {
  function liveService() {
    return new LiveStreamService({
      getStream: () => ({
        id: 's1', label: 'L', strategy: 'fanout', cadence_seconds: 0,
        members: [{ plugin: 'builtin', source: 'research-runs', params: { artifactsDir: FIX } }], options: {},
      }) as never,
      manifestOf: () => ({ id: 'research-runs', adapter: 'builtin' }),
      adapterFor: () => ({ fetch: (params, _m, ctx) => researchRunsFn(undefined, params, ctx) as Promise<unknown> }),
      runtimeConfigFor: () => ({}),
    })
  }

  it('列表里每一条的 run id 都能被详情路由收下(不是 400)', async () => {
    const items = await liveService().items('s1')
    expect(items.length).toBeGreaterThan(0)
    for (const it of items) {
      const runId = runIdFromGuid(it.id)
      const res = await app().request(`/api/research/streams/s1/runs/${encodeURIComponent(runId)}`)
      expect([res.status, runId]).toEqual([200, runId])
    }
  })

  it('剥出来的 run id 就是 manifest 里那个 id', async () => {
    const items = await liveService().items('s1')
    expect(items.map((it) => runIdFromGuid(it.id))).toEqual([RUN])
  })
})
