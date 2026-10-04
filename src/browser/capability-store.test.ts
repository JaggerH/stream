// BrowserCapability 缓存：扩展连上来那一刻同时答了「有没有 Chrome」和「有没有扩展」（spec §5）。
// 这份测试盯住三条不能破的性质：everSeen 单调、重启后仍在、握手缺字段是正常情况。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BrowserCapabilityStore,
  parseExtHandshake,
  sanitizeHandshake,
  summarizeCapability,
} from './capability-store.ts'

describe('BrowserCapabilityStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'browser-cap-'))
    path = join(dir, 'browser-capability.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('从没连过 → everSeen:false，且不写盘（新装机器不该凭空多出一份缓存）', () => {
    const s = new BrowserCapabilityStore(path)
    expect(s.get()).toEqual({ everSeen: false })
    expect(() => readFileSync(path, 'utf8')).toThrow()
  })

  it('连上一次 → everSeen:true + lastSeenAt；之后断开，缓存原样保留', () => {
    const s = new BrowserCapabilityStore(path, { now: () => new Date('2026-07-29T10:00:00.000Z') })
    const cap = s.markSeen({ extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' })
    expect(cap).toEqual({
      everSeen: true,
      lastSeenAt: '2026-07-29T10:00:00.000Z',
      extVersion: '0.4.1',
      browser: 'Chrome/131',
      platform: 'win',
    })
    // 断开在 relay 那边发生，这里什么都不做 —— "装过"是历史事实，不因掉线回退。
    expect(s.get()).toEqual(cap)
  })

  it('重启（重新构造 store 指向同一份文件）后 everSeen 仍为 true，自报字段一并还原', () => {
    const first = new BrowserCapabilityStore(path, { now: () => new Date('2026-07-29T10:00:00.000Z') })
    first.markSeen({ extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' })

    const reopened = new BrowserCapabilityStore(path)
    expect(reopened.get()).toEqual({
      everSeen: true,
      lastSeenAt: '2026-07-29T10:00:00.000Z',
      extVersion: '0.4.1',
      browser: 'Chrome/131',
      platform: 'win',
    })
  })

  it('握手一个字段都不带（老版本扩展）→ 不报错、不清空已记下的值，只刷新 lastSeenAt', () => {
    let clock = new Date('2026-07-29T10:00:00.000Z')
    const s = new BrowserCapabilityStore(path, { now: () => clock })
    s.markSeen({ extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' })

    clock = new Date('2026-07-29T12:00:00.000Z')
    const cap = s.markSeen() // 老版本扩展：什么都不自报
    expect(cap).toEqual({
      everSeen: true,
      lastSeenAt: '2026-07-29T12:00:00.000Z',
      extVersion: '0.4.1',
      browser: 'Chrome/131',
      platform: 'win',
    })
  })

  it('握手只带一部分字段 → 只覆盖带到的那些，其余保持原值', () => {
    const s = new BrowserCapabilityStore(path)
    s.markSeen({ extVersion: '0.4.1', browser: 'Chrome/131', platform: 'win' })
    const cap = s.markSeen({ extVersion: '0.5.0' }) // 扩展升级了，浏览器/平台没变也没重报
    expect(cap.extVersion).toBe('0.5.0')
    expect(cap.browser).toBe('Chrome/131')
    expect(cap.platform).toBe('win')
  })

  it('握手带空串/非字符串（脏值）→ 按缺失处理，不写进缓存', () => {
    const s = new BrowserCapabilityStore(path)
    s.markSeen({ extVersion: '0.4.1' })
    const cap = s.markSeen({ extVersion: '  ', browser: 42 as unknown as string, platform: null as unknown as string })
    expect(cap.extVersion).toBe('0.4.1')
    expect(cap.browser).toBeUndefined()
    expect(cap.platform).toBeUndefined()
    expect(cap.everSeen).toBe(true)
  })

  it('缓存文件损坏 → 冷启动（everSeen:false），不抛；下一次连上照常修复', () => {
    writeFileSync(path, '{ this is not json')
    const s = new BrowserCapabilityStore(path)
    expect(s.get()).toEqual({ everSeen: false })
    expect(s.markSeen().everSeen).toBe(true)
    expect(new BrowserCapabilityStore(path).get().everSeen).toBe(true)
  })

  it('写盘失败不抛 —— 一份诊断缓存不该掀翻一条正常的扩展连接', () => {
    const errs: unknown[] = []
    const bad = join(path, 'nested', 'browser-capability.json') // path 的父目录是个文件，mkdir 必失败
    writeFileSync(path, '{}')
    const s = new BrowserCapabilityStore(bad, { onError: (e) => errs.push(e) })
    expect(() => s.markSeen()).not.toThrow()
    expect(s.get().everSeen).toBe(true) // 内存里仍然记住了
    expect(errs).toHaveLength(1)
  })
})

describe('parseExtHandshake', () => {
  it('从升级请求 URL 的 query 取三个自报字段', () => {
    expect(parseExtHandshake('/api/ext?extVersion=0.4.1&browser=Chrome%2F131&platform=win')).toEqual({
      extVersion: '0.4.1',
      browser: 'Chrome/131',
      platform: 'win',
    })
  })

  it('老版本扩展不带 query（或 url 缺失/畸形）→ 空对象，不是错误', () => {
    expect(parseExtHandshake('/api/ext')).toEqual({})
    expect(parseExtHandshake(undefined)).toEqual({})
    expect(parseExtHandshake('::://')).toEqual({})
  })

  it('超长自报值被截断，不让扩展侧把缓存撑爆', () => {
    const long = 'v'.repeat(200)
    expect(parseExtHandshake(`/api/ext?extVersion=${long}`).extVersion).toHaveLength(64)
  })
})

describe('sanitizeHandshake', () => {
  it('null/undefined/非对象 → 空对象', () => {
    expect(sanitizeHandshake(undefined)).toEqual({})
    expect(sanitizeHandshake(null)).toEqual({})
  })
})

describe('summarizeCapability', () => {
  const seen = { everSeen: true, lastSeenAt: '2026-07-29T10:00:00.000Z', extVersion: '0.4.1' }

  it('relay 连着 → ready', () => {
    const s = summarizeCapability({ connected: true, since: '2026-07-29T11:00:00.000Z' }, seen)
    expect(s.state).toBe('ready')
    expect(s.connected).toBe(true)
    expect(s.since).toBe('2026-07-29T11:00:00.000Z')
    expect(s.extVersion).toBe('0.4.1')
  })

  it('没连 + 连过 → disconnected（提示掉线 + 排查步骤，不是"没装"）', () => {
    const s = summarizeCapability({ connected: false, since: null }, seen)
    expect(s.state).toBe('disconnected')
    expect(s.lastSeenAt).toBe('2026-07-29T10:00:00.000Z')
  })

  it('没连 + 从没连上过 → never-seen（装 Chrome + 装扩展是同一套引导）', () => {
    const s = summarizeCapability({ connected: false, since: null }, { everSeen: false })
    expect(s.state).toBe('never-seen')
    expect(s.lastSeenAt).toBeUndefined()
  })
})
