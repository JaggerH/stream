import { describe, it, expect } from 'vitest'
import { provisionDeclaredBackends, type ProvisionWiringDeps } from './provision-wire.ts'
import type { ProvisionResult, ProvisionOptions } from './provisioner.ts'
import type { DockerClient, DockerEndpoint } from './standby/docker-api.ts'
import type { PluginDescriptor } from './types.ts'

/**
 * 这个文件**绝不碰真 daemon**——活体上跑着用户在用的插件容器（stream-alist-1 等）。
 * 每条路径都通过注入点（resolveEndpoint / makeClient / provision）断言"发了什么/没发什么"。
 */

const plugin = (id: string, backend?: Partial<NonNullable<PluginDescriptor['backend']>>): PluginDescriptor => ({
  id,
  backend: backend ? ({ image: `img/${id}:v1`, port: 80, ...backend } as PluginDescriptor['backend']) : undefined,
})

interface Spy {
  endpointCalls: number
  clientCalls: number
  provisioned: { plugin: string; opts: ProvisionOptions }[]
  logs: string[]
}

function harness(
  over: Partial<ProvisionWiringDeps> = {},
  result: (p: PluginDescriptor) => ProvisionResult = (p) => ({ service: p.id, action: 'created', containerId: `c-${p.id}` }),
  ping = true,
) {
  const spy: Spy = { endpointCalls: 0, clientCalls: 0, provisioned: [], logs: [] }
  // ping 之外的方法一律抛：接线层不该越过 provision 直接对 docker 下手。
  const dockerStub = new Proxy({} as DockerClient, {
    get: (_t, prop) => {
      if (prop === 'ping') return async () => ping
      return async () => { throw new Error(`wire must not call docker.${String(prop)} directly`) }
    },
  })
  const deps: ProvisionWiringDeps = {
    descriptors: [plugin('pansou', {}), plugin('xhs')],
    enabled: true,
    mode: 'compose',
    isEnabled: () => true,
    resolveEndpoint: () => { spy.endpointCalls += 1; return { socketPath: '/nope.sock' } as DockerEndpoint },
    makeClient: () => { spy.clientCalls += 1; return dockerStub },
    provision: async (_docker, p, opts) => { spy.provisioned.push({ plugin: p.id, opts }); return result(p) },
    log: (m) => spy.logs.push(m),
    ...over,
  }
  return { deps, spy }
}

describe('provisionDeclaredBackends 开关', () => {
  it('开关关闭 → 一个 docker 调用都不发（今天的行为一字不差）', async () => {
    const { deps, spy } = harness({ enabled: false })
    const out = await provisionDeclaredBackends(deps)
    expect(out.results).toEqual([])
    expect(spy.endpointCalls).toBe(0)
    expect(spy.clientCalls).toBe(0)
    expect(spy.provisioned).toEqual([])
  })

  it('开关打开 → 只对声明了 backend 的包各调一次', async () => {
    const { deps, spy } = harness()
    const out = await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['pansou'])
    expect(out.results.map((r) => r.action)).toEqual(['created'])
  })

  it('被用户关掉的插件不碰它的容器', async () => {
    const { deps, spy } = harness({
      descriptors: [plugin('pansou', {}), plugin('alist', {})],
      isEnabled: (p) => p.id !== 'alist',
    })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['pansou'])
  })
})

describe('provisionDeclaredBackends 传下去的口径', () => {
  it('host 档必须 publishLoopback —— 否则探活会去打后端解析不了的容器 DNS', async () => {
    const { deps, spy } = harness({ mode: 'host' })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned[0]?.opts.publishLoopback).toBe(true)
  })

  it('compose 档 publishLoopback = false（容器 DNS 直连）', async () => {
    const { deps, spy } = harness({ mode: 'compose' })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned[0]?.opts.publishLoopback).toBe(false)
  })

  // 镜像与声明对不上就删了重建，不通知、不问、不给按钮。容器层不许住状态（要保就声明
  // volume，见 docs/PACKAGE.md §4.1），所以重建没有可丢的东西；恒 false 的旧口径会把容器永远
  // 钉死在旧镜像上——用户唯一的出路是自己 docker rm。
  it('接线启用重建 —— recreateOnImageMismatch 恒 true', async () => {
    const { deps, spy } = harness()
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned[0]?.opts.recreateOnImageMismatch).toBe(true)
  })

  it('mode=none（后端够不着容器）→ 跳过，零 docker 调用', async () => {
    const { deps, spy } = harness({ mode: 'none' })
    const out = await provisionDeclaredBackends(deps)
    expect(out.results).toEqual([])
    expect(spy.endpointCalls).toBe(0)
    expect(spy.provisioned).toEqual([])
  })
})

describe('provisionDeclaredBackends 降级：docker 不可用绝不掀翻启动', () => {
  it('端点解析不出 → 空结果 + 一条响亮日志和通知', async () => {
    const { deps, spy } = harness({ resolveEndpoint: () => null })
    const out = await provisionDeclaredBackends(deps)
    expect(out.results).toEqual([])
    expect(spy.provisioned).toEqual([])
    expect(spy.logs.join('\n')).toMatch(/docker/i)
    expect(out.notices.some((n) => n.severity === 'error')).toBe(true)
  })

  it('ping 不通 → 同样降级，不抛', async () => {
    const { deps, spy } = harness({}, undefined, false)
    const out = await provisionDeclaredBackends(deps)
    expect(out.results).toEqual([])
    expect(spy.provisioned).toEqual([])
  })
})

describe('provisionDeclaredBackends 一个包的失败不牵连别的包', () => {
  it('中间那个包报错 → 前后两个照常，各自有结果', async () => {
    const { deps, spy } = harness(
      { descriptors: [plugin('a', {}), plugin('b', {}), plugin('c', {})] },
      (p) => p.id === 'b'
        ? { service: 'b', action: 'created', error: new Error('boom b') }
        : { service: p.id, action: 'ran', containerId: `c-${p.id}` },
    )
    const out = await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['a', 'b', 'c'])
    expect(out.results.map((r) => `${r.service}:${r.action}${r.error ? '!' : ''}`)).toEqual(['a:ran', 'b:created!', 'c:ran'])
    expect(out.notices.filter((n) => n.severity === 'error').map((n) => n.service)).toEqual(['b'])
  })

  it('provision 本身意外抛（契约说它不会，但接线不赌）→ 转成带 error 的结果，后面的包照跑', async () => {
    const { deps, spy } = harness({
      descriptors: [plugin('a', {}), plugin('b', {})],
      provision: async (_d, p) => {
        spy.provisioned.push({ plugin: p.id, opts: {} as ProvisionOptions })
        if (p.id === 'a') throw new Error('unexpected')
        return { service: p.id, action: 'ran' }
      },
    })
    const out = await provisionDeclaredBackends(deps)
    expect(out.results.map((r) => r.service)).toEqual(['a', 'b'])
    expect(out.results[0]?.error?.message).toBe('unexpected')
    expect(out.results[1]?.action).toBe('ran')
  })
})

/**
 * 用户数据目录里装的第三方包也带容器。它们的声明在**安装期**已经过钳制
 * （service 名指派、卷加前缀、mem 必填），这里只消费，不再钳一次。
 */
describe('provisionDeclaredBackends 认第三方包', () => {
  it('用户目录里带 backend 的包也被 provision（排在内置之后）', async () => {
    const { deps, spy } = harness({ thirdParty: [plugin('acme-scraper', { mem: '1G' }), plugin('nocontainer')] })
    const out = await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['pansou', 'acme-scraper'])
    expect(out.results.map((r) => r.service)).toEqual(['pansou', 'acme-scraper'])
  })

  it('只有第三方带 requireMemLimit —— 内置那份行为一字不变', async () => {
    const { deps, spy } = harness({ thirdParty: [plugin('acme-scraper', { mem: '1G' })] })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned.find((p) => p.plugin === 'pansou')?.opts.requireMemLimit).toBeFalsy()
    expect(spy.provisioned.find((p) => p.plugin === 'acme-scraper')?.opts.requireMemLimit).toBe(true)
  })

  it('开关关闭 → 第三方也一个 docker 调用都不发', async () => {
    const { deps, spy } = harness({ enabled: false, thirdParty: [plugin('acme-scraper', { mem: '1G' })] })
    const out = await provisionDeclaredBackends(deps)
    expect(out.results).toEqual([])
    expect(spy.provisioned).toEqual([])
    expect(spy.endpointCalls).toBe(0)
  })

  it('被用户关掉的第三方包不碰它的容器', async () => {
    const { deps, spy } = harness({
      thirdParty: [plugin('acme-scraper', { mem: '1G' })],
      isEnabled: (p) => p.id !== 'acme-scraper',
    })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['pansou'])
  })

  it('手改盘上的 package.json 去掉 mem → 拒绝创建，且明说是这个原因（不是静默跳过）', async () => {
    const { deps } = harness(
      { thirdParty: [plugin('acme-scraper', {})] },
      (p) => p.id === 'acme-scraper'
        ? { service: p.id, action: 'skipped', error: new Error('backend 缺 mem（内存上限）') }
        : { service: p.id, action: 'ran', containerId: 'c1' },
    )
    const out = await provisionDeclaredBackends(deps)
    const n = out.notices.find((x) => x.service === 'acme-scraper')
    expect(n?.severity).toBe('error')
    expect(`${n?.title}${n?.body}`).toMatch(/内存|mem/)
    expect(n?.dedupeKey).toMatch(/mem/)
  })

  it('第三方容器建失败不牵连内置的（也不牵连别的第三方）', async () => {
    const { deps, spy } = harness(
      { thirdParty: [plugin('a3', { mem: '1G' }), plugin('b3', { mem: '1G' })] },
      (p) => p.id === 'a3'
        ? { service: p.id, action: 'created', error: new Error('boom a3') }
        : { service: p.id, action: 'ran', containerId: `c-${p.id}` },
    )
    const out = await provisionDeclaredBackends(deps)
    expect(spy.provisioned.map((p) => p.plugin)).toEqual(['pansou', 'a3', 'b3'])
    expect(out.results.map((r) => `${r.service}:${r.error ? 'err' : 'ok'}`)).toEqual(['pansou:ok', 'a3:err', 'b3:ok'])
  })
})

describe('provisionDeclaredBackends 说出去', () => {
  it('镜像对不上重建完 → info 通报（不是请示），且说清卷里的数据没丢', async () => {
    const { deps } = harness({}, () => ({ service: 'pansou', action: 'recreated', containerId: 'new' }))
    const out = await provisionDeclaredBackends(deps)
    const n = out.notices.find((x) => x.service === 'pansou')
    expect(n?.severity).toBe('info')
    expect(`${n?.title}${n?.body}`).toMatch(/镜像/)
    expect(n?.body).toMatch(/volume/)
  })

  it('声明了 backend.publish（管理 UI 固定宿主口）→ 明确说它不会被发布，别静默', async () => {
    const { deps } = harness({ descriptors: [plugin('alist', { publish: 5244 })] })
    const out = await provisionDeclaredBackends(deps)
    expect(out.notices.some((n) => n.service === 'alist' && /端口/.test(`${n.title}${n.body}`))).toBe(true)
  })

  it('本来就在跑 → 不打扰用户（无通知），但日志有账', async () => {
    const { deps, spy } = harness({}, (p) => ({ service: p.id, action: 'ran', containerId: 'c1' }))
    const out = await provisionDeclaredBackends(deps)
    expect(out.notices).toEqual([])
    expect(spy.logs.join('\n')).toMatch(/pansou/)
  })

  it('每条通知都有 dedupeKey（否则每次启动都堆一条新的）', async () => {
    const { deps } = harness({}, (p) => ({ service: p.id, action: 'created', error: new Error('nope') }))
    const out = await provisionDeclaredBackends(deps)
    expect(out.notices.length).toBeGreaterThan(0)
    for (const n of out.notices) expect(n.dedupeKey).toBeTruthy()
  })
})

/** 接线层不再往下传任何凭证——宿主是唯一调度方，容器不自己去要 cookie。 */
describe('provisionDeclaredBackends 不传凭证', () => {
  it('声明了 credentials 的包，传给 provisioner 的 opts 里也没有凭证字段', async () => {
    const p = { ...plugin('pansou', {}), credentials: ['pansou.example'] } as PluginDescriptor
    const { deps, spy } = harness({ descriptors: [p] })
    await provisionDeclaredBackends(deps)
    expect(spy.provisioned[0]?.opts).not.toHaveProperty('credentialToken')
  })
})
