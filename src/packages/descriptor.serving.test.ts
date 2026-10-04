import { describe, it, expect } from 'vitest'
import { parseStreamDescriptor, servingHostProblem } from './descriptor.ts'

const base = { name: '@t/x', version: '1.0.0', stream: { type: 'recipe', facility: 'x' } }
const withStream = (stream: Record<string, unknown>) => ({ ...base, stream: { ...base.stream, ...stream } })

describe('stream.serving —— facility 级送字节策略声明', () => {
  it('读入 match / hosts / reason', () => {
    const d = parseStreamDescriptor(withStream({
      serving: [{ match: '.x.fm', hosts: ['cdn1.x.fm', 'cdn.y.com'], reason: 'cdn0 对站外 403' }],
    }), 'x/package.json')
    expect(d.serving).toEqual([{ match: '.x.fm', hosts: ['cdn1.x.fm', 'cdn.y.com'], reason: 'cdn0 对站外 403' }])
  })
  it('hosts 可省略；reason 不可省略', () => {
    expect(parseStreamDescriptor(withStream({ serving: [{ match: 'x.fm', reason: 'r' }] }), 'x').serving?.[0].hosts).toBeUndefined()
    expect(() => parseStreamDescriptor(withStream({ serving: [{ match: 'x.fm' }] }), 'x')).toThrow(/reason/)
  })
  it.each([
    ['127.0.0.1', 'loopback'], ['10.1.2.3', '私网'], ['172.16.0.9', '私网'], ['192.168.1.1', '私网'],
    ['169.254.1.1', '链路本地'], ['[::1]', 'loopback'], ['::1', 'loopback'], ['fd00::1', '私网'],
    ['localhost', '单标签'], ['intranet', '单标签'], ['0.0.0.0', 'loopback'],
  ])('hosts 里出现 %s（%s）→ 整个包拒', (host) => {
    expect(() => parseStreamDescriptor(withStream({ serving: [{ match: 'x.fm', hosts: [host], reason: 'r' }] }), 'x/package.json'))
      .toThrow(/x\/package\.json/)
    expect(servingHostProblem(host)).not.toBeNull()
  })
  it.each([
    ['[::ffff:127.0.0.1]', 'IPv4 映射的 loopback'],
    ['[::ffff:10.0.0.1]', 'IPv4 映射的私网'],
    ['0177.0.0.1', '八进制写法的 loopback'],
    ['localhost.', '带尾点的单标签'],
    ['::ffff:7f00:1', '十六进制写法的映射 loopback'],
    ['not a host', '解析不出来的串'],
  ])('绕过写法 %s（%s）→ 整个包拒', (host) => {
    expect(servingHostProblem(host)).not.toBeNull()
    expect(() => parseStreamDescriptor(withStream({ serving: [{ match: 'x.fm', hosts: [host], reason: 'r' }] }), 'x/package.json'))
      .toThrow(/x\/package\.json/)
  })
  it('公网主机名与公网 IP 放行', () => {
    expect(servingHostProblem('cdn101.lizhi.fm')).toBeNull()
    expect(servingHostProblem('8.8.8.8')).toBeNull()
    expect(servingHostProblem('[2606:4700::1]')).toBeNull()
    expect(servingHostProblem('[::ffff:8.8.8.8]')).toBeNull()
  })
  it('match 必须至少两段标签——一个包不能声明接管整个 .fm 下的流量', () => {
    expect(() => parseStreamDescriptor(withStream({ serving: [{ match: '.fm', reason: 'r' }] }), 'x/package.json'))
      .toThrow(/x\/package\.json/)
    expect(() => parseStreamDescriptor(withStream({ serving: [{ match: 'com', reason: 'r' }] }), 'x/package.json'))
      .toThrow(/x\/package\.json/)
    expect(parseStreamDescriptor(withStream({ serving: [{ match: '.lizhi.fm', reason: 'r' }] }), 'x').serving?.[0].match)
      .toBe('.lizhi.fm')
    expect(parseStreamDescriptor(withStream({ serving: [{ match: 'example.com', reason: 'r' }] }), 'x').serving?.[0].match)
      .toBe('example.com')
  })
})

describe('stream.retires —— 这个包顶掉了哪些 RSSHub 路由', () => {
  it('读入 id → 理由', () => {
    const d = parseStreamDescriptor(withStream({ retires: { 'rsshub:x/user/:id': '上游关了 web 接口' } }), 'x')
    expect(d.retires).toEqual({ 'rsshub:x/user/:id': '上游关了 web 接口' })
  })
  it('理由为空串拒', () => {
    expect(() => parseStreamDescriptor(withStream({ retires: { 'rsshub:x/user/:id': '' } }), 'x')).toThrow()
  })
  it('键必须是 rsshub: 前缀的目录 id', () => {
    expect(() => parseStreamDescriptor(withStream({ retires: { 'x/user/:id': 'r' } }), 'x')).toThrow(/rsshub:/)
  })
})
