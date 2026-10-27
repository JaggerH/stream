// src/net/caller-fetch-guard.test.ts
//
// caller-fetch-guard 的判据测试（openspec/changes/private-fetch-guard）。解析可注入，
// 全程不碰外网：真实网络只有本机监听套接字（127.0.0.1），外网地址只出现在**注入的解析
// 结果**里——rebinding 用例里那个"公网地址"永远不会被连接（第二次解析已在连接前被拒）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const ownedFetch = vi.hoisted(() => vi.fn())
vi.mock('../http/owned-outbound.ts', () => ({ ownedFetch }))

import {
  CallerUrlBlockedError,
  callerFetchGuardActive,
  callerFetchGuardPolicy,
  configureCallerFetchGuard,
  privateAddressReason,
  withCallerFetchGuard,
  assertCallerUrlAllowed,
  type CallerFetchGuardPolicy,
} from './caller-fetch-guard.ts'
import { safeFetchText } from '../adapters/safe-fetch.ts'
import { makeFetchFor } from '../devices/fetch.ts'
import { toolCatalog } from '../mcp/tool-catalog.ts'

// ─── 地址判定：每类一条 ──────────────────────────────────────────────

describe('privateAddressReason — 拒绝清单逐类', () => {
  const blocked: Array<[ip: string, reasonPart: string]> = [
    ['127.0.0.1', '回环'],
    ['127.8.8.8', '回环'],
    ['10.1.2.3', '私有段（10.0.0.0/8）'],
    ['172.16.0.1', '私有段（172.16.0.0/12）'],
    ['172.31.255.254', '私有段（172.16.0.0/12）'],
    ['192.168.1.1', '私有段（192.168.0.0/16）'],
    ['169.254.169.254', '链路本地'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT'],
    ['0.0.0.0', '未指定'],
    ['0.1.2.3', '未指定'],
    ['::', '未指定'],
    ['::1', '回环'],
    ['fe80::1', '链路本地'],
    ['febf::1', '链路本地'],
    ['fc00::1', 'ULA'],
    ['fd12:3456::1', 'ULA'],
    ['ff02::1', '组播'],
    // IPv4 映射的 IPv6：按内嵌 IPv4 判
    ['::ffff:127.0.0.1', '回环'],
    ['::ffff:10.0.0.9', '私有段（10.0.0.0/8）'],
    ['::ffff:192.168.0.1', '私有段（192.168.0.0/16）'],
    ['::ffff:169.254.1.1', '链路本地'],
  ]
  for (const [ip, part] of blocked) {
    it(`${ip} 被拒（${part}）`, () => {
      expect(privateAddressReason(ip)).toContain(part)
    })
  }

  it('公网地址放行（含边界外的近邻）', () => {
    expect(privateAddressReason('8.8.8.8')).toBeNull()
    expect(privateAddressReason('93.184.216.34')).toBeNull()
    expect(privateAddressReason('11.0.0.1')).toBeNull()
    expect(privateAddressReason('100.128.0.1')).toBeNull() // 100.64/10 止于 100.127
    expect(privateAddressReason('172.32.0.1')).toBeNull()
    expect(privateAddressReason('172.15.0.1')).toBeNull()
    expect(privateAddressReason('2606:2800:220:1:248:1893:25c8:1946')).toBeNull()
    expect(privateAddressReason('::ffff:8.8.8.8')).toBeNull() // 映射的是公网 IPv4
  })
})

// ─── 策略：开关与例外名单 ────────────────────────────────────────────

describe('callerFetchGuardPolicy', () => {
  it('缺省 / reject_private 缺省 = 关闭（null）', () => {
    expect(callerFetchGuardPolicy(undefined)).toBeNull()
    expect(callerFetchGuardPolicy({})).toBeNull()
    expect(callerFetchGuardPolicy({ reject_private: false, allow: ['127.0.0.1'] })).toBeNull()
  })

  it('名单解析：主机名精确匹配、裸 IP、CIDR；写错在装配期炸出来', async () => {
    const p = callerFetchGuardPolicy({ reject_private: true, allow: ['NAS.internal', '192.168.8.0/24', 'fd00::/8', '127.0.0.1'] })!
    const ok = async (url: string) => {
      await assertAllowed(p, url)
    }
    await ok('http://nas.internal/') // 名单主机名：解析到内网也放行（它背书）
    await ok('http://192.168.8.7/')
    await ok('http://[fd12::1]/') // fd00::/8 罩住 fdxx
    await ok('http://127.0.0.1/')
    await expect(assertAllowed(p, 'http://192.168.9.7/')).rejects.toThrow(/拒绝访问内网地址/)
    await expect(assertAllowed(p, 'http://10.1.2.3/')).rejects.toThrow(/私有段（10\.0\.0\.0\/8）/)
    expect(() => callerFetchGuardPolicy({ reject_private: true, allow: ['10.0.0.0/40'] })).toThrow(/前缀长度越界/)
  })

  /** 策略的 URL 预检要在作用域里才生效——测试直接用 ALS 包一层。 */
  async function assertAllowed(p: CallerFetchGuardPolicy | null, url: string): Promise<void> {
    configureCallerFetchGuard(p)
    try {
      await withCallerFetchGuard(async () => {
        await assertCallerUrlAllowed(url)
      })
    } finally {
      configureCallerFetchGuard(null)
    }
  }
})

// ─── 本机套接字与注入解析表 ─────────────────────────────────────────

let server: Server
let port: number
const hits: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/redirect') {
      // 302 落点是 **IP 字面量** 的回环地址——连接层对它不调 DNS，只有 connector 直判接得住。
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>hello</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  hits.length = 0
  ownedFetch.mockReset()
  ownedFetch.mockImplementation(async () =>
    new Response('<html><body>mocked</body></html>', { headers: { 'content-type': 'text/html' } }))
})
afterEach(() => configureCallerFetchGuard(null))

/** 注入解析表的策略：表里没有的主机名按解析失败处理。 */
function policy(allow: string[], table: Record<string, string[]>): CallerFetchGuardPolicy {
  return callerFetchGuardPolicy({ reject_private: true, allow }, async (hostname) => {
    const list = table[hostname]
    if (!list) throw new Error(`injected dns: no entry for ${hostname}`)
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  })!
}

// ─── read_url 背后的抓取路径（safeFetchText） ───────────────────────

/** safeFetchText 的调用要发生在守卫作用域里（真实调用方 read_url 就是这么包的）。 */
const guardedText = (url: string) => withCallerFetchGuard(() => safeFetchText(url))

describe('safeFetchText — 开关打开', () => {
  it('解析到回环的内网主机：预检就拒，一个包都不发', async () => {
    configureCallerFetchGuard(policy([], { 'evil.example': ['127.0.0.1'] }))
    await expect(guardedText('http://evil.example/page')).rejects.toThrow(/127\.0\.0\.1.*回环/s)
    expect(hits).toEqual([])
    expect(ownedFetch).not.toHaveBeenCalled()
  })

  it('门入口预检用注入解析、连接时校验用同一份（守卫 fetch 不经 ownedFetch）', async () => {
    // 名单主机名放行 → 真实连接发生；这一跳走的是受校验的 undici dispatcher。
    configureCallerFetchGuard(policy(['pub.example'], { 'pub.example': ['127.0.0.1'] }))
    const got = await guardedText(`http://pub.example:${port}/page`)
    expect(got?.html).toContain('hello')
    expect(got?.finalUrl).toContain('/page')
    expect(hits).toEqual(['/page'])
    expect(ownedFetch).not.toHaveBeenCalled()
  })

  it('公网域名 302 跳 127.0.0.1：重定向被拒，/secret 没被打到', async () => {
    configureCallerFetchGuard(policy(['pub.example'], { 'pub.example': ['127.0.0.1'] }))
    await expect(guardedText(`http://pub.example:${port}/redirect`)).rejects.toThrow(/127\.0\.0\.1.*回环/s)
    expect(hits).toEqual(['/redirect'])
  })

  it('DNS rebinding：预检解析到公网、连接时解析到内网 —— 被拒', async () => {
    let call = 0
    const p = callerFetchGuardPolicy({ reject_private: true }, async (hostname) => {
      if (hostname !== 'flip.example') throw new Error(`no entry for ${hostname}`)
      call += 1
      // 第一次（门入口预检）公网；第二次（真正要连接的那次）内网。
      return call === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
    })!
    configureCallerFetchGuard(p)
    await expect(guardedText('http://flip.example/')).rejects.toThrow(CallerUrlBlockedError)
    expect(hits).toEqual([])
    expect(call).toBe(2)
  })

  it('例外名单里的内网地址放行（名单主机名跳过 IP 判定）', async () => {
    configureCallerFetchGuard(policy(['pub.example'], { 'pub.example': ['127.0.0.1'] }))
    const got = await guardedText(`http://pub.example:${port}/page`)
    expect(got?.html).toContain('hello')
  })

  it('例外名单里的网段放行，名单外同类地址被拒', async () => {
    configureCallerFetchGuard(policy([`127.0.0.0/8`], {}))
    const got = await guardedText(`http://127.0.0.1:${port}/page`)
    expect(got?.html).toContain('hello')
    configureCallerFetchGuard(policy(['192.168.0.0/16'], {}))
    await expect(guardedText(`http://127.0.0.1:${port}/page`)).rejects.toThrow(CallerUrlBlockedError)
  })

  it('非 http/https 协议被拒', async () => {
    configureCallerFetchGuard(policy([], {}))
    await expect(guardedText('ftp://pub.example/file')).rejects.toThrow(/只允许 http\/https/)
  })
})

describe('safeFetchText — 开关关闭（缺省）与现在逐字节一致', () => {
  it('内网地址：现有主机名级闸照旧拒（null），且不发请求', async () => {
    const got = await safeFetchText(`http://127.0.0.1:${port}/page`)
    expect(got).toBeNull()
    expect(hits).toEqual([])
    expect(ownedFetch).not.toHaveBeenCalled()
  })

  it('公网地址：走 ownedFetch，init 里连 dispatcher 字段都不出现', async () => {
    const got = await safeFetchText('http://8.8.8.8/page')
    expect(got?.html).toContain('mocked')
    expect(ownedFetch).toHaveBeenCalledTimes(1)
    expect((ownedFetch.mock.calls[0] as unknown[])[1]).not.toHaveProperty('dispatcher')
  })
})

// ─── fetchFor 的 local 分支：作用域只限门内（订阅源 / 适配器不受影响） ──

describe('fetchFor local 分支 — 作用域不扩大', () => {
  const fetchFor = makeFetchFor({
    directory: {
      isOnline: () => false,
      hasOp: () => false,
      fetchRelay: () => undefined,
    },
    local: ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
  })

  it('开关打开、不在守卫作用域里：订阅源/适配器访问 127.0.0.1 照常成功', async () => {
    configureCallerFetchGuard(policy([], {}))
    const res = await fetchFor(`http://127.0.0.1:${port}/page`)
    expect(res.status).toBe(200)
    expect(hits).toEqual(['/page'])
  })

  it('开关打开、在守卫作用域里（read_url / stream_fetch_url 调用中）：127.0.0.1 被拒', async () => {
    configureCallerFetchGuard(policy([], {}))
    await expect(
      withCallerFetchGuard(() => fetchFor(`http://127.0.0.1:${port}/page`)),
    ).rejects.toThrow(CallerUrlBlockedError)
    expect(hits).toEqual([])
  })

  it('开关关闭：同一份 fetchFor 行为不变', async () => {
    const res = await fetchFor(`http://127.0.0.1:${port}/page`)
    expect(res.status).toBe(200)
  })
})

// ─── MCP 工具面：read_url / stream_fetch_url 的回执语义 ─────────────

describe('toolCatalog — 守卫作用域与拒绝回执', () => {
  const entry = (name: string, extras: Partial<Parameters<typeof toolCatalog>[1]>) =>
    toolCatalog({} as never, { isCommunitySource: () => false, ...extras }).find((t) => t.name === name)!

  it('read_url：作用域内的深层拒绝（重定向跳内网沿梯子带出）回 {url, error}，不裸抛', async () => {
    configureCallerFetchGuard(policy([], {}))
    const tool = entry('read_url', {
      readUrl: async () => {
        throw new CallerUrlBlockedError('evil.example', '10.0.0.1', '私有段（10.0.0.0/8）')
      },
    })
    const out = await tool.run({ url: 'http://evil.example/' }) as { error?: string }
    expect(out.error).toContain('拒绝访问内网地址')
    expect(out.error).toContain('10.0.0.1')
  })

  it('read_url：门入口预检拒绝时 readUrl 根本不被调', async () => {
    configureCallerFetchGuard(policy([], {}))
    const readUrl = vi.fn()
    const tool = entry('read_url', { readUrl })
    const out = await tool.run({ url: `http://127.0.0.1:${port}/` }) as { error?: string }
    expect(out.error).toContain('回环')
    expect(readUrl).not.toHaveBeenCalled()
  })

  it('read_url：开关关闭时行为与现在一致', async () => {
    const tool = entry('read_url', { readUrl: async () => ({ text: '正文内容' }) })
    const out = await tool.run({ url: 'https://example.com/' }) as { text?: string; chars?: number }
    expect(out.text).toBe('正文内容')
    expect(out.chars).toBe(4)
  })

  it('stream_fetch_url：预检拒绝回 {platform, error}；例外名单放行后照常出结果', async () => {
    configureCallerFetchGuard(policy([], {}))
    const tool = entry('stream_fetch_url', {})
    const blocked = await tool.run({ url: `http://10.9.8.7/img.jpg` }) as { error?: string; media?: unknown[] }
    expect(blocked.error).toContain('拒绝访问内网地址')
    expect(blocked.media).toEqual([])

    configureCallerFetchGuard(policy(['127.0.0.1'], {}))
    const allowed = await tool.run({ url: `http://127.0.0.1:${port}/img.jpg` }) as { platform?: string }
    expect(allowed.platform).toBe('image')
  })

  it('stream_fetch_url：开关关闭时对内网直链维持现状（直链分支不发包，返回 platform）', async () => {
    const tool = entry('stream_fetch_url', {})
    const out = await tool.run({ url: `http://127.0.0.1:${port}/img.jpg` }) as { platform?: string }
    expect(out.platform).toBe('image')
  })
})

// ─── 结构保证：守卫不碰进程的全局 ────────────────────────────────────

describe('守卫不碰全局 fetch / HTTP 客户端', () => {
  it('开关打开并跑过受守卫的抓取后，globalThis.fetch 与 dispatcher 原样', async () => {
    const before = globalThis.fetch
    configureCallerFetchGuard(policy([], {}))
    try {
      await withCallerFetchGuard(async () => {
        await expect(safeFetchText('http://10.0.0.1/')).rejects.toThrow(CallerUrlBlockedError)
      })
    } finally {
      configureCallerFetchGuard(null)
    }
    expect(globalThis.fetch).toBe(before)
  })

  it('callerFetchGuardActive：策略配置 + 作用域内才为真', async () => {
    expect(callerFetchGuardActive()).toBe(false)
    configureCallerFetchGuard(policy([], {}))
    expect(callerFetchGuardActive()).toBe(false) // 配置了但不在作用域
    await withCallerFetchGuard(async () => {
      expect(callerFetchGuardActive()).toBe(true)
    })
    expect(callerFetchGuardActive()).toBe(false)
  })
})
