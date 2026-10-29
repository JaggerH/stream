import { describe, expect, it } from 'vitest'
import { isTrustedProxy, normalizeIp, resolveClientIp } from './client-ip.ts'

describe('normalizeIp', () => {
  it('去空白、去方括号、把 IPv4 映射的 IPv6 还原成 v4', () => {
    expect(normalizeIp(' 127.0.0.1 ')).toBe('127.0.0.1')
    expect(normalizeIp('[::1]')).toBe('::1')
    expect(normalizeIp('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(normalizeIp('::FFFF:203.0.113.9')).toBe('203.0.113.9')
  })

  it('空串、带端口、不像地址的都当没有', () => {
    expect(normalizeIp('')).toBeUndefined()
    expect(normalizeIp('   ')).toBeUndefined()
    expect(normalizeIp('127.0.0.1:5000')).toBeUndefined()
    expect(normalizeIp('not-an-ip')).toBeUndefined()
    expect(normalizeIp('a'.repeat(65))).toBeUndefined()
  })
})

describe('isTrustedProxy', () => {
  it('精确匹配，IPv4 映射与方括号形式都归一后比', () => {
    expect(isTrustedProxy('127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(isTrustedProxy('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(isTrustedProxy('[::1]', ['::1'])).toBe(true)
    expect(isTrustedProxy('10.0.0.2', ['127.0.0.1'])).toBe(false)
    expect(isTrustedProxy(undefined, ['127.0.0.1'])).toBe(false)
  })
})

describe('resolveClientIp', () => {
  it('默认不信任任何代理头：直连的对端地址就是它，X-Forwarded-For 被无视', () => {
    expect(resolveClientIp('203.0.113.9', '1.2.3.4', [])).toBe('203.0.113.9')
    expect(resolveClientIp('203.0.113.9', '1.2.3.4')).toBe('203.0.113.9')
  })

  it('连接来自受信代理时才读 X-Forwarded-For，取最右一跳（代理追加的那一跳）', () => {
    expect(resolveClientIp('127.0.0.1', '198.51.100.7', ['127.0.0.1'])).toBe('198.51.100.7')
    // 左边是客户端自己编的，右边是代理追加的真实来源
    expect(resolveClientIp('127.0.0.1', '1.1.1.1, 198.51.100.7', ['127.0.0.1'])).toBe('198.51.100.7')
    expect(resolveClientIp('::ffff:127.0.0.1', '198.51.100.7', ['127.0.0.1'])).toBe('198.51.100.7')
  })

  it('受信代理但头缺失 / 头里不是地址：退回连接地址，不把垃圾当键', () => {
    expect(resolveClientIp('127.0.0.1', undefined, ['127.0.0.1'])).toBe('127.0.0.1')
    expect(resolveClientIp('127.0.0.1', '', ['127.0.0.1'])).toBe('127.0.0.1')
    expect(resolveClientIp('127.0.0.1', 'garbage,  ', ['127.0.0.1'])).toBe('127.0.0.1')
  })

  it('连接地址拿不到：不给键（调用方按同一个共享桶处理）', () => {
    expect(resolveClientIp(undefined, '198.51.100.7', ['127.0.0.1'])).toBeUndefined()
  })
})
