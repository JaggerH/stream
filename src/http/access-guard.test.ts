import { describe, it, expect } from 'vitest'
import { isLoopbackAddress, authorizeAccess, isTrustedHost, isTrustedOrigin, parseTrustedOrigins } from './access-guard.ts'

const TOKEN = 'a'.repeat(64)

describe('isLoopbackAddress', () => {
  it('accepts the shapes Node actually hands us for a local peer', () => {
    // 实测：Windows 的 Chrome 打 WSL 后端（mirrored 网络）看到的就是 127.0.0.1，主路必须免密。
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true) // 双栈监听下的 IPv4-mapped
    expect(isLoopbackAddress('[::1]')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true) // 127.0.0.0/8 整段
  })

  it('rejects LAN peers and anything unparseable', () => {
    expect(isLoopbackAddress('10.0.0.21')).toBe(false) // 本机自己的 LAN 地址也算外来
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('::ffff:10.0.0.21')).toBe(false)
    expect(isLoopbackAddress('fe80::1')).toBe(false)
    expect(isLoopbackAddress('127.0.0.999')).toBe(false) // 越界八位组不是地址
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false)
  })

  it('treats a missing peer address as NOT local (fail-closed)', () => {
    // 读不到源地址绝不能变成"那就当本机吧"——那是把门拆了还以为锁着。
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })
})

describe('isTrustedHost（防 DNS rebinding）', () => {
  it('认 IP 字面量与 localhost —— rebinding 借不到它们', () => {
    expect(isTrustedHost('127.0.0.1:8900')).toBe(true)
    expect(isTrustedHost('10.0.0.21:8900')).toBe(true) // 手机从局域网访问的形状
    expect(isTrustedHost('localhost:8900')).toBe(true)
    expect(isTrustedHost('[::1]:8900')).toBe(true)
  })

  it('默认拒一切域名，登记过的才放行', () => {
    // evil.com 解析到 127.0.0.1 时，Origin 和 Host 都是它、同源判据照样成立，
    // 认得出它的只有"这个名字我们没登记过"。
    expect(isTrustedHost('evil.com')).toBe(false)
    expect(isTrustedHost('stream.example.com', ['stream.example.com'])).toBe(true)
    expect(isTrustedHost('stream.example.com', ['other.example.com'])).toBe(false)
    expect(isTrustedHost('evil.com', ['stream.example.com'])).toBe(false)
    expect(isTrustedHost(undefined)).toBe(false)
  })
})

describe('isTrustedOrigin（防本机上的恶意网页）', () => {
  const host = '127.0.0.1:8900'

  it('没有 Origin 就是可信 —— curl / MCP / 桌面壳的 Rust 侧都不带它', () => {
    expect(isTrustedOrigin({ hostHeader: host })).toBe(true)
    expect(isTrustedOrigin({ origin: '', hostHeader: host })).toBe(true)
  })

  it('同源（我们自己的前端）放行', () => {
    expect(isTrustedOrigin({ origin: 'http://127.0.0.1:8900', hostHeader: host })).toBe(true)
    expect(isTrustedOrigin({ origin: 'http://10.0.0.21:8900', hostHeader: '10.0.0.21:8900' })).toBe(true)
  })

  it('拦住任意网页 —— 这正是"本机免密"挡不住的那一类', () => {
    expect(isTrustedOrigin({ origin: 'https://evil.com', hostHeader: host })).toBe(false)
    expect(isTrustedOrigin({ origin: 'http://10.0.0.5:3000', hostHeader: host })).toBe(false) // 局域网别的机器
    expect(isTrustedOrigin({ origin: 'null', hostHeader: host })).toBe(false) // sandboxed iframe
  })

  it('只认我们自己那个扩展，不认别的扩展', () => {
    const extId = 'dmhlfkdjljnilhnfajjpaobehenbokij'
    expect(isTrustedOrigin({ origin: `chrome-extension://${extId}`, hostHeader: host, extId })).toBe(true)
    expect(isTrustedOrigin({ origin: `chrome-extension://${'a'.repeat(32)}`, hostHeader: host, extId })).toBe(false)
    expect(isTrustedOrigin({ origin: `chrome-extension://${extId}`, hostHeader: host })).toBe(false)
  })

  it('本机来源（任意端口）默认可信 —— 用户 DSH 里那张 Stream 页不用登记', () => {
    // 那张页绑在用户的 dsh web 口上，我们不知道那个数；能以本机地址为 origin 的只有本机上的软件。
    for (const o of [
      'http://127.0.0.1:8901',
      'http://127.0.0.1:9999',
      'http://localhost:5173',
      'http://[::1]:8901',
      'http://app.localhost:3000',
      'http://127.1.2.3:80',
    ]) {
      expect(isTrustedOrigin({ origin: o, hostHeader: host }), o).toBe(true)
    }
  })

  it('非本机来源照样拦：域名、局域网地址、以及"看着像本机"的骗子', () => {
    for (const o of ['https://evil.com', 'http://10.0.0.5:8901', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com']) {
      expect(isTrustedOrigin({ origin: o, hostHeader: host }), o).toBe(false)
    }
  })

  it('登记过的额外 origin 精确匹配放行 —— 留给后端不在本机的场景', () => {
    const lanOrigin = 'http://10.0.0.5:8901'
    expect(isTrustedOrigin({ origin: lanOrigin, hostHeader: host, extraOrigins: [lanOrigin] })).toBe(true)
    // 白名单非空不等于放开别的外部源。
    expect(isTrustedOrigin({ origin: 'https://evil.com', hostHeader: host, extraOrigins: [lanOrigin] })).toBe(false)
  })
})

describe('authorizeAccess', () => {
  it('lets loopback through with no credential at all', () => {
    expect(authorizeAccess({ remoteAddress: '127.0.0.1', token: TOKEN })).toBe('local')
  })

  it('requires a matching token from a LAN peer', () => {
    const from = (bearer?: string, queryToken?: string) =>
      authorizeAccess({ remoteAddress: '10.0.0.21', bearer, queryToken, token: TOKEN })
    expect(from()).toBe('denied')
    expect(from(`Bearer ${TOKEN}`)).toBe('token')
    expect(from(`Bearer ${'b'.repeat(64)}`)).toBe('denied')
    expect(from('Bearer')).toBe('denied')
    expect(from(TOKEN)).toBe('denied') // 裸 token 不算 Bearer 头
    expect(from(undefined, TOKEN)).toBe('token') // ?token= —— 浏览器 WS / 手机首访那条路
    expect(from(undefined, 'nope')).toBe('denied')
  })

  it('denies everything remote when the server has no token configured', () => {
    // 空 token 若被当成"随便什么都对"，就是一把恒开的锁。
    expect(authorizeAccess({ remoteAddress: '10.0.0.21', bearer: 'Bearer ', token: '' })).toBe('denied')
    expect(authorizeAccess({ remoteAddress: '10.0.0.21', queryToken: '', token: '' })).toBe('denied')
  })
})

describe('parseTrustedOrigins', () => {
  it('逗号分隔、去空白、去尾斜杠、丢空项', () => {
    expect(parseTrustedOrigins(' http://127.0.0.1:3000/ ,, http://a:1 ')).toEqual(['http://127.0.0.1:3000', 'http://a:1'])
    expect(parseTrustedOrigins(undefined)).toEqual([])
  })

  // 去尾斜杠不是洁癖：`isTrustedOrigin` 是精确串匹配，而浏览器发的 Origin 永远不带尾斜杠。
  // 用户从地址栏抄一份 `http://127.0.0.1:3000/` 进 env，不归一化就等于登记了个永不命中的串——
  // 静默 403，没有一处会喊。
  it('归一化后的串能直接被 isTrustedOrigin 认', () => {
    const [origin] = parseTrustedOrigins('http://127.0.0.1:3000/')
    expect(isTrustedOrigin({ origin: 'http://127.0.0.1:3000', hostHeader: '127.0.0.1:8900', extraOrigins: [origin!] })).toBe(true)
  })
})
