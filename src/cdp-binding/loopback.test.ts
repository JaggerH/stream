/**
 * CDP 地址的准入判据：**只许回环**。
 *
 * CDP 口 = 驱动整台浏览器（任意求值、读 cookie、代填密码）。这条绑定是普通进程，不该成为
 * 把那扇门带出本机的那一步——地址不是回环就直接拒，进程根本起不来。
 */
import { describe, expect, it } from 'vitest'
import { CdpAddressRefused, loopbackCdpUrl, serverUrlOf } from './loopback.ts'

describe('loopbackCdpUrl：只许回环', () => {
  it.each([
    'http://127.0.0.1:9222',
    'http://127.0.0.1',
    'http://127.1.2.3:9222', // 127.0.0.0/8 整段都是本机
    'http://localhost:9222',
    'http://LOCALHOST:9222',
    'http://foo.localhost:9222',
    'http://[::1]:9222',
    'https://127.0.0.1:9222',
  ])('放行 %s', (url) => {
    expect(loopbackCdpUrl(url).hostname).toBeTruthy()
  })

  it.each([
    ['http://192.168.1.5:9222', '私网地址不是本机'],
    ['http://10.0.0.1:9222', '私网地址不是本机'],
    ['http://example.com:9222', '域名不是本机'],
    ['http://0.0.0.0:9222', '通配地址不是本机'],
    ['http://[::]:9222', '通配地址不是本机'],
    ['ws://127.0.0.1:9222', '协议不是 http(s)'],
    ['ftp://127.0.0.1:9222', '协议不是 http(s)'],
    // URL 解析会把 IPv4-mapped 形式归一成十六进制（`[::ffff:7f00:1]`），而共用的判据只认
    // 点分形式（它面对的是 Node 的 remoteAddress）。拒 = fail-closed：宁可让人改写成
    // 127.0.0.1，也不在这里另写一套地址判据——两套判据漂移之后，一处放行的另一处会拒。
    ['http://[::ffff:127.0.0.1]:9222', '归一成十六进制后判据认不出，按非回环拒（fail-closed）'],
    ['不是 url', '不是合法的 URL'],
  ])('拒绝 %s（%s）', (url) => {
    expect(() => loopbackCdpUrl(url)).toThrow(CdpAddressRefused)
  })

  it('拒绝时说清楚是哪一条：报错里带原地址与原因', () => {
    expect(() => loopbackCdpUrl('http://example.com:9222')).toThrow(/example\.com.*不是本机/)
  })
})

describe('serverUrlOf：只认 http/https', () => {
  it('去掉尾斜杠（拼 /api/ext/pair 时不能出现双斜杠）', () => {
    expect(serverUrlOf('http://127.0.0.1:8900/')).toBe('http://127.0.0.1:8900')
    expect(serverUrlOf('https://stream.example.com//')).toBe('https://stream.example.com')
    expect(serverUrlOf('http://127.0.0.1:8900/base/')).toBe('http://127.0.0.1:8900/base')
  })

  it('别的协议拒', () => {
    expect(() => serverUrlOf('ftp://127.0.0.1:8900')).toThrow(/http/)
    expect(() => serverUrlOf('不是 url')).toThrow(/不是合法的 URL/)
  })
})
