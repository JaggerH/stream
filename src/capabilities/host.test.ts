import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilityHost } from './host.ts'
import type { Capability, CapabilityContext, ToolDef } from '../../shared/capability/types.ts'

const tool = (name: string): ToolDef => ({
  name,
  description: name,
  parameters: {},
  output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: name }] },
  execute: async () => ({ ok: true }),
})

/** 一个只做「拿到 ctx 就交出去」的假能力，让用例直接对 ctx 下断言。 */
function probe(name: string, body: (ctx: CapabilityContext, config: Record<string, unknown>) => void | Promise<void>): Capability {
  return { name, mount: async (ctx, config) => { await body(ctx, config as Record<string, unknown>) } }
}

function newHost(extra: Partial<Parameters<typeof createCapabilityHost>[0]> = {}) {
  const lines: string[] = []
  const dataDir = mkdtempSync(join(tmpdir(), 'cap-host-'))
  const host = createCapabilityHost({ dataDir, log: (l) => lines.push(l), ...extra })
  return { host, lines, dataDir }
}

describe('CapabilityContext 七格', () => {
  it('dataDir 是 <dataDir>/capabilities/<name>/ 且已经建好', async () => {
    const { host, dataDir } = newHost()
    let seen = ''
    await host.mount(probe('demo', (ctx) => { seen = ctx.dataDir }), {})
    expect(seen).toBe(join(dataDir, 'capabilities', 'demo'))
    expect(existsSync(seen)).toBe(true)
  })

  // 读到才建：大多数能力从不落盘，而 mkdir 会因为权限/只读挂载失败——急着建目录就是让一个
  // 用不到的副作用去否决整个能力的挂载（Stream Desktop 正是这样，它一个字节都不写）。
  it('没读 dataDir 就不建目录，读了才建', async () => {
    const { host, dataDir } = newHost()
    await host.mount(probe('untouched', () => {}), {})
    expect(existsSync(join(dataDir, 'capabilities', 'untouched'))).toBe(false)
  })

  it('log 带 [stream-<name>] 前缀，warn 多一个 WARN', async () => {
    const { host, lines } = newHost()
    await host.mount(probe('demo', (ctx) => { ctx.log.info('hi'); ctx.log.warn('uh') }), {})
    expect(lines).toContain('[stream-demo] hi')
    expect(lines).toContain('[stream-demo] WARN uh')
  })

  it('provide / require 在同一个进程里互相看得见', async () => {
    const { host } = newHost()
    await host.mount(probe('a', (ctx) => { ctx.provide('svc', { v: 7 }) }), {})
    let got: unknown
    await host.mount(probe('b', (ctx) => { got = ctx.require('svc') }), {})
    expect(got).toEqual({ v: 7 })
  })

  it('require 一个没人给的服务 → undefined（降级归包自己判，不抛）', async () => {
    const { host } = newHost()
    let got: unknown = 'unset'
    await host.mount(probe('a', (ctx) => { got = ctx.require('nobody') }), {})
    expect(got).toBeUndefined()
  })

  it('destructiveGate 是 host —— 破坏性由宿主（Claude Code 等）自己弹确认', async () => {
    const { host } = newHost()
    let gate = ''
    await host.mount(probe('a', (ctx) => { gate = ctx.destructiveGate }), {})
    expect(gate).toBe('host')
  })

  it('config 原样递给 mount', async () => {
    const { host } = newHost()
    let seen: unknown
    await host.mount(probe('a', (_ctx, config) => { seen = config }), { tier: 'external' })
    expect(seen).toEqual({ tier: 'external' })
  })
})

describe('撞名硬拒', () => {
  it('两个包注册同名工具 → 后一个 mount 抛错', async () => {
    const { host } = newHost()
    await host.mount(probe('a', (ctx) => { ctx.registerTools([tool('shared_verb')]) }), {})
    await expect(
      host.mount(probe('b', (ctx) => { ctx.registerTools([tool('shared_verb')]) }), {}),
    ).rejects.toThrow(/shared_verb/)
  })

  it('与后端自己的工具名撞 → 抛错', async () => {
    const { host } = newHost({ reservedToolNames: () => ['cdp_look', 'extract'] })
    await expect(
      host.mount(probe('a', (ctx) => { ctx.registerTools([tool('cdp_look')]) }), {}),
    ).rejects.toThrow(/cdp_look/)
  })

  it('同一批里自己撞自己 → 抛错', async () => {
    const { host } = newHost()
    await expect(
      host.mount(probe('a', (ctx) => { ctx.registerTools([tool('x'), tool('x')]) }), {}),
    ).rejects.toThrow(/x/)
  })

  it('provide 同名服务两次 → 抛错', async () => {
    const { host } = newHost()
    await host.mount(probe('a', (ctx) => { ctx.provide('svc', 1) }), {})
    await expect(host.mount(probe('b', (ctx) => { ctx.provide('svc', 2) }), {})).rejects.toThrow(/svc/)
  })

  // 撞名不许留下半个包：注册在抛错之前的那几个工具必须一起撤掉，否则工具面上会挂着一个
  // 没人 mount 成功的包的动词——调用它必然炸，而且没有任何一处会说这个包没装上。
  it('mount 中途抛错 → 它已经注册的工具全部撤回', async () => {
    const { host } = newHost()
    await host.mount(probe('a', (ctx) => { ctx.registerTools([tool('keep')]) }), {})
    await expect(
      host.mount(probe('b', (ctx) => {
        ctx.registerTools([tool('gone')])
        throw new Error('boom')
      }), {}),
    ).rejects.toThrow(/boom/)
    expect(host.toolDefs().map((d) => d.name)).toEqual(['keep'])
    expect(host.toolsByCapability()).toEqual({ a: ['keep'] })
  })

  it('同名能力挂两次 → 抛错', async () => {
    const { host } = newHost()
    await host.mount(probe('dup', () => {}), {})
    await expect(host.mount(probe('dup', () => {}), {})).rejects.toThrow(/dup/)
  })
})

describe('工具面', () => {
  it('toolDefs 汇总各包注册的工具；toolsByCapability 按包分组', async () => {
    const { host } = newHost()
    await host.mount(probe('a', (ctx) => { ctx.registerTools([tool('a1'), tool('a2')]) }), {})
    await host.mount(probe('b', (ctx) => { ctx.registerTools([tool('b1')]) }), {})
    expect(host.toolDefs().map((d) => d.name)).toEqual(['a1', 'a2', 'b1'])
    expect(host.toolsByCapability()).toEqual({ a: ['a1', 'a2'], b: ['b1'] })
  })

  // 这一条钉的是「后 mount 的包也看得见」：工具面是每请求现建的，读的必须是**此刻**这张表，
  // 不是装配那一刻的快照（AGENTS.md「装配期取的值 = 冻住的答案」）。
  it('mount 之后再问 toolDefs 拿得到新工具', async () => {
    const { host } = newHost()
    expect(host.toolDefs()).toEqual([])
    await host.mount(probe('late', (ctx) => { ctx.registerTools([tool('late_verb')]) }), {})
    expect(host.toolDefs().map((d) => d.name)).toEqual(['late_verb'])
  })
})

describe('dispose', () => {
  it('逆 mount 顺序收摊', async () => {
    const { host } = newHost()
    const order: string[] = []
    await host.mount(probe('a', (ctx) => { ctx.onDispose(() => { order.push('a1') }); ctx.onDispose(() => { order.push('a2') }) }), {})
    await host.mount(probe('b', (ctx) => { ctx.onDispose(() => { order.push('b') }) }), {})
    await host.dispose()
    expect(order).toEqual(['b', 'a2', 'a1'])
  })

  it('一个收摊函数抛错不挡住后面的，只记一行', async () => {
    const { host, lines } = newHost()
    const order: string[] = []
    await host.mount(probe('a', (ctx) => { ctx.onDispose(() => { order.push('a') }) }), {})
    await host.mount(probe('b', (ctx) => { ctx.onDispose(() => { throw new Error('nope') }) }), {})
    await host.dispose()
    expect(order).toEqual(['a'])
    expect(lines.some((l) => l.includes('nope'))).toBe(true)
  })

  it('单个能力自己收摊后，它的工具从工具面上消失', async () => {
    const { host } = newHost()
    const mounted = await host.mount(probe('a', (ctx) => { ctx.registerTools([tool('a1')]) }), {})
    await host.mount(probe('b', (ctx) => { ctx.registerTools([tool('b1')]) }), {})
    await mounted.dispose()
    expect(host.toolDefs().map((d) => d.name)).toEqual(['b1'])
    expect(host.toolsByCapability()).toEqual({ b: ['b1'] })
  })

  /**
   * 工具下表了、服务却还在，是最难看出来的一种半收摊：`require()` 回的不是 undefined（那会
   * 走降级），而是一份指向已收摊对象的东西——消费者一切正常，只是永远拿不到结果。
   */
  it('单个能力自己收摊后，它 provide 的服务也从总线上撤掉', async () => {
    const { host } = newHost()
    const mounted = await host.mount(probe('a', (ctx) => { ctx.provide('svc', { v: 7 }) }), {})
    let seen: unknown = 'not-run'
    await host.mount(probe('b', (ctx) => { seen = ctx.require('svc') }), {})
    expect(seen).toEqual({ v: 7 })

    await mounted.dispose()

    let after: unknown = 'not-run'
    await host.mount(probe('c', (ctx) => { after = ctx.require('svc') }), {})
    expect(after).toBeUndefined()
    // 撤干净的第二个判据：同一个名字能再被 provide，重挂这个包不会撞上"已经有主人了"。
    await expect(host.mount(probe('a2', (ctx) => { ctx.provide('svc', { v: 8 }) }), {})).resolves.toBeTruthy()
  })

  it('mount 交回的名字与工具清单', async () => {
    const { host } = newHost()
    const mounted = await host.mount(probe('a', (ctx) => { ctx.registerTools([tool('a1')]) }), {})
    expect(mounted.name).toBe('a')
    expect(mounted.tools).toEqual(['a1'])
  })
})

describe('宿主自己往服务总线上放东西', () => {
  it('host.provide 放的服务，包 require 得到', async () => {
    const { host } = newHost()
    host.provide('streamBrowserCookies', { cookieFor: async () => 'a=b' })
    let got: { cookieFor(d: string): Promise<string | undefined> } | undefined
    await host.mount(probe('netdisk', (ctx) => { got = ctx.require('streamBrowserCookies') }), {})
    expect(await got?.cookieFor('quark.cn')).toBe('a=b')
  })
})

// 能力包是**一等的登录态消费者**：它经 `streamBrowserCookies` 取用户浏览器里的 cookie，
// 和一份 manifest 的 `auth` 同级，只是申报点是包描述符的 `stream.credentials` 那一格。
// 宿主把这些域收起来交给 `requiredCookieDomains`，扩展才会去读它们——漏了的表现是包每次
// 拿到空 cookie，而那和"用户没登录"一字不差，没有任何一处会喊。
//
// **申报从第三个参数进来，不从模块上读**：那一格过安装门（schema 校验 + 确认页逐域点名），
// 模块级属性是装完之后才读得到的——放模块上等于「用户批准的名单」和「实际同步的名单」
// 分成两份，而两份漂移了没有任何一处会喊。
describe('包申报的登录态域', () => {
  const plain = (name: string): Capability => ({ name, mount: async () => {} })

  it('把已挂能力那个包申报的域收起来，去重 + 归一化 + 排序', async () => {
    const { host } = newHost()
    await host.mount(plain('netdisk'), {}, { credentials: ['.Quark.CN', 'pan.baidu.com'] })
    await host.mount(plain('other'), {}, { credentials: ['quark.cn'] })
    expect(host.credentialDomains()).toEqual(['pan.baidu.com', 'quark.cn'])
  })

  it('没申报的包一格都不加（空名单不是"未知"）', async () => {
    const { host } = newHost()
    await host.mount(probe('plain', () => {}), {})
    expect(host.credentialDomains()).toEqual([])
  })

  // 模块自己在对象上写一个 credentials 也不算数——申报点只有包描述符那一格。
  it('模块自己声明的 credentials 不被采信', async () => {
    const { host } = newHost()
    await host.mount({ ...plain('sneaky'), credentials: ['evil.com'] } as Capability, {})
    expect(host.credentialDomains()).toEqual([])
  })

  // 现取而不是快照：可选包在 boot 之后才装载，取一次等于永远只认内置那半。
  it('后挂上的能力，域跟得上；收摊之后随它一起消失', async () => {
    const { host } = newHost()
    expect(host.credentialDomains()).toEqual([])
    const mounted = await host.mount(plain('late'), {}, { credentials: ['quark.cn'] })
    expect(host.credentialDomains()).toEqual(['quark.cn'])
    await mounted.dispose()
    expect(host.credentialDomains()).toEqual([])
  })

  it('mount 抛错的能力，它的域一并回滚（没装上就不该让扩展去读那个域）', async () => {
    const { host } = newHost()
    await expect(host.mount({ name: 'bad', mount: async () => { throw new Error('炸了') } }, {}, { credentials: ['quark.cn'] }))
      .rejects.toThrow('炸了')
    expect(host.credentialDomains()).toEqual([])
  })
})

describe('host.dispose 收摊得干净', () => {
  // 服务总线留着的代价有两条，两条都很安静：收摊之后 `require` 仍拿得到一个指向已关停中继的
  // 对象；以及同一个进程里重建一遍时，第二次 provide 同名会被判成"已经有主人了"直接抛。
  it('services 也清空——重新 provide 同一个名字不再撞', async () => {
    const { host } = newHost()
    host.provide('streamBrowserCookies', { cookieFor: async () => 'a=b' })
    await host.dispose()
    expect(() => host.provide('streamBrowserCookies', { cookieFor: async () => 'c=d' })).not.toThrow()
    let got: { cookieFor(d: string): Promise<string | undefined> } | undefined
    await host.mount(probe('after', (ctx) => { got = ctx.require('streamBrowserCookies') }), {})
    expect(await got?.cookieFor('quark.cn')).toBe('c=d')
  })

  it('工具、申报的域、已挂名册一起归零', async () => {
    const { host } = newHost()
    await host.mount({ name: 'a', mount: async (ctx) => { ctx.registerTools([tool('a1')]) } }, {}, { credentials: ['quark.cn'] })
    await host.dispose()
    expect(host.toolDefs()).toEqual([])
    expect(host.credentialDomains()).toEqual([])
    // 名册也清了 → 同名能力可以重新挂上，而不是被"已经挂过了"永久拒绝。
    await expect(host.mount(probe('a', () => {}), {})).resolves.toBeTruthy()
  })
})
