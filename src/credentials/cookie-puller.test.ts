import { describe, it, expect, vi } from 'vitest'
import { CookiePuller, type CookiePullTransport, type CookieSnapshot } from './cookie-puller.ts'
import type { BrowserCookie } from '../types.ts'
import type { DebugEntry } from '../debug.ts'

const cookie = (name: string): BrowserCookie =>
  ({ name, value: `v-${name}`, domain: '.quark.cn', path: '/' }) as BrowserCookie

function makeStore(initial: Record<string, BrowserCookie[]> = {}, updatedAt: number | null = null) {
  let held = initial
  let at = updatedAt
  const replace = vi.fn((c: Record<string, BrowserCookie[]>) => {
    held = c
    at = 1_000
  })
  const store: CookieSnapshot = {
    replace,
    status: () => ({ domains: Object.keys(held).sort(), updatedAt: at }),
  }
  return { store, replace, held: () => held }
}

function makeRelay(
  impl: (domains: string[]) => Promise<{ cookies: Record<string, unknown[]>; refused: string[] }>,
  connected = true,
) {
  const cookiePull = vi.fn(impl)
  return { relay: { connected, cookiePull } as CookiePullTransport, cookiePull }
}

const REQUIRED = ['quark.cn', 'xiaohongshu.com']

describe('CookiePuller.pull', () => {
  it('取回来整份替换写进快照', async () => {
    const { store, replace } = makeStore()
    const { relay } = makeRelay(async () => ({ cookies: { 'quark.cn': [cookie('sid')] }, refused: [] }))
    const out = await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} }).pull('t')
    expect(out).toMatchObject({ ok: true, domains: ['quark.cn'] })
    expect(replace).toHaveBeenCalledWith({ 'quark.cn': [cookie('sid')] })
  })

  // 写入口是整份替换，所以取数也必须是全量：只取"变了的那几个"就得改成按域合并，
  // 而按域合并会让用户退登过的域以僵尸形式永远留在快照里。
  it('【核心】永远请求全量 requiredDomains，不管触发原因是什么', async () => {
    const { store } = makeStore()
    const { relay, cookiePull } = makeRelay(async () => ({ cookies: {}, refused: [] }))
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} }).pull('cookies-changed')
    expect(cookiePull).toHaveBeenCalledWith(REQUIRED)
  })

  it('退登的域会从快照里消失（整份替换的意义所在）', async () => {
    const { store, held } = makeStore({ 'quark.cn': [cookie('sid')], 'xiaohongshu.com': [cookie('a1')] })
    const { relay } = makeRelay(async () => ({ cookies: { 'quark.cn': [cookie('sid')] }, refused: [] }))
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} }).pull('t')
    expect(Object.keys(held())).toEqual(['quark.cn'])
  })

  // 一次网络抖动不能被放大成全站游客态。
  it('【核心】拉失败绝不清空快照', async () => {
    const { store, replace } = makeStore({ 'quark.cn': [cookie('sid')] })
    const { relay } = makeRelay(async () => { throw new Error('boom') })
    const out = await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} }).pull('t')
    expect(out).toMatchObject({ ok: false, reason: 'failed' })
    expect(replace).not.toHaveBeenCalled()
  })

  it('Chrome 关着 = relay-down，是常态不是故障，也不动快照', async () => {
    const { store, replace } = makeStore({ 'quark.cn': [cookie('sid')] })
    const { relay, cookiePull } = makeRelay(async () => ({ cookies: {}, refused: [] }), false)
    const out = await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} }).pull('t')
    expect(out).toMatchObject({ ok: false, reason: 'relay-down' })
    expect(cookiePull).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  // 三个触发时机会撞在一起（中继刚连上、扩展同时报变更）。不去重就是同一份数据来回覆盖。
  it('并发去重：同一时刻只飞一轮', async () => {
    const { store } = makeStore()
    let resolve!: (v: { cookies: Record<string, unknown[]>; refused: string[] }) => void
    const { relay, cookiePull } = makeRelay(() => new Promise((r) => { resolve = r }))
    const p = new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {} })
    const a = p.pull('one')
    const b = p.pull('two')
    resolve({ cookies: {}, refused: [] })
    await Promise.all([a, b])
    expect(cookiePull).toHaveBeenCalledTimes(1)
  })

  // refused 的表现和"用户没登录"一模一样（都是取不到 cookie），不喊就会被当成登录问题查半天。
  it('被扩展拒掉的域要喊出来', async () => {
    const lines: string[] = []
    const { store } = makeStore()
    const { relay } = makeRelay(async () => ({ cookies: {}, refused: ['mybank.example'] }))
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: (l) => lines.push(l) }).pull('t')
    expect(lines.join('\n')).toContain('mybank.example')
  })

  it('没有要同步的域 → 不打扰浏览器', async () => {
    const { store } = makeStore()
    const { relay, cookiePull } = makeRelay(async () => ({ cookies: {}, refused: [] }))
    const out = await new CookiePuller({ relay, store, requiredDomains: () => [], log: () => {} }).pull('t')
    expect(out).toMatchObject({ ok: false, reason: 'no-domains' })
    expect(cookiePull).not.toHaveBeenCalled()
  })
})

// 这条链路的每一种失败都表现成同一件事：取不到 cookie → 采集变游客态。日志只在 stdout 上，
// 谁也看不到。所以每一轮都要往 debug bus 发一条——包括"跳过了"和"失败了"。
describe('CookiePuller 的可观测性', () => {
  const collect = () => {
    const entries: DebugEntry[] = []
    return { entries, report: (e: DebugEntry) => { entries.push(e) } }
  }

  it('成功那轮报取回了哪些域', async () => {
    const { store } = makeStore()
    const { relay } = makeRelay(async () => ({ cookies: { 'quark.cn': [cookie('sid')] }, refused: [] }))
    const { entries, report } = collect()
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {}, report }).pull('t')
    expect(entries[0]).toMatchObject({ channel: 'cookie-pull', ok: true })
    expect(JSON.stringify(entries[0].fields)).toContain('quark.cn')
  })

  // 被拒的域和"用户没登录"表现一样，必须让它在面板上是红的，而不是一条看着正常的成功。
  it('有域被拒 → 这一轮不算 ok', async () => {
    const { store } = makeStore()
    const { relay } = makeRelay(async () => ({ cookies: {}, refused: ['mybank.example'] }))
    const { entries, report } = collect()
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {}, report }).pull('t')
    expect(entries[0].ok).toBe(false)
    expect(JSON.stringify(entries[0].fields)).toContain('mybank.example')
  })

  it('失败那轮带上"快照多旧了"——排查时最想知道的就是这个数', async () => {
    const { store } = makeStore({ 'quark.cn': [cookie('sid')] }, 1_000)
    const { relay } = makeRelay(async () => { throw new Error('unknown op') })
    const { entries, report } = collect()
    await new CookiePuller({
      relay, store, requiredDomains: () => REQUIRED, log: () => {}, report, now: () => 601_000,
    }).pull('t')
    expect(entries[0].ok).toBe(false)
    expect(JSON.stringify(entries[0].fields)).toContain('unknown op')
    expect(JSON.stringify(entries[0].fields)).toContain('10 分钟前')
  })

  // 「为什么快照是旧的」必须能查到答案，哪怕答案是"浏览器没开"——查不到才是最费时间的那种。
  it('Chrome 没连也要留一条，别让这一轮无声消失', async () => {
    const { store } = makeStore({}, 1_000)
    const { relay } = makeRelay(async () => ({ cookies: {}, refused: [] }), false)
    const { entries, report } = collect()
    await new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {}, report }).pull('t')
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toContain('Chrome')
  })
})

describe('CookiePuller.ensureFresh', () => {
  const build = (updatedAt: number | null, now: number) => {
    const { store } = makeStore({ 'quark.cn': [cookie('sid')] }, updatedAt)
    const { relay, cookiePull } = makeRelay(async () => ({ cookies: { 'quark.cn': [cookie('sid')] }, refused: [] }))
    const puller = new CookiePuller({ relay, store, requiredDomains: () => REQUIRED, log: () => {}, now: () => now })
    return { puller, cookiePull }
  }

  it('快照还新 → 不去打扰浏览器（一轮批量采集里几十条流共用同一份）', async () => {
    const { puller, cookiePull } = build(10_000, 10_100)
    await puller.ensureFresh(60_000, 't')
    expect(cookiePull).not.toHaveBeenCalled()
  })

  it('快照过期 → 拉一次', async () => {
    const { puller, cookiePull } = build(10_000, 200_000)
    await puller.ensureFresh(60_000, 't')
    expect(cookiePull).toHaveBeenCalledTimes(1)
  })

  it('从没推/拉过（updatedAt 为空）→ 拉一次，别把"没有"当成"还新"', async () => {
    const { puller, cookiePull } = build(null, 10_000)
    await puller.ensureFresh(60_000, 't')
    expect(cookiePull).toHaveBeenCalledTimes(1)
  })
})
