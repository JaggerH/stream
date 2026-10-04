import { describe, expect, it } from 'vitest'
import { hashPath, redactUrl } from './redact.ts'

const ORIGIN = 'http://localhost:5273'

describe('redactUrl', () => {
  it('丢弃 query 和 fragment，只留 host + 路径 hash', () => {
    const ctx = redactUrl('https://cdn.example.com/audio/ep1.mp3?sig=SECRET&t=123#x', ORIGIN)
    expect(ctx).not.toBeNull()
    expect(ctx!.host).toBe('cdn.example.com')
    expect(ctx!.sameOrigin).toBe(false)
    // 脱敏结果里任何地方都不得残留签名/query/fragment
    expect(JSON.stringify(ctx)).not.toContain('SECRET')
    expect(JSON.stringify(ctx)).not.toContain('sig')
    expect(JSON.stringify(ctx)).not.toContain('123')
  })

  it('同一 pathname 的不同签名 URL hash 相同（可分组）', () => {
    const a = redactUrl('https://cdn.example.com/audio/ep1.mp3?sig=AAA', ORIGIN)
    const b = redactUrl('https://cdn.example.com/audio/ep1.mp3?sig=BBB', ORIGIN)
    expect(a!.pathHash).toBe(b!.pathHash)
  })

  it('不同 pathname hash 不同', () => {
    const a = redactUrl('https://cdn.example.com/audio/ep1.mp3', ORIGIN)
    const b = redactUrl('https://cdn.example.com/audio/ep2.mp3', ORIGIN)
    expect(a!.pathHash).not.toBe(b!.pathHash)
  })

  it('标记同源', () => {
    expect(redactUrl(`${ORIGIN}/api/audio/x.mp3`, ORIGIN)!.sameOrigin).toBe(true)
  })

  it('相对 URL 按页面 origin 解析', () => {
    const ctx = redactUrl('/api/audio/x.mp3', ORIGIN)
    expect(ctx!.host).toBe('localhost:5273')
    expect(ctx!.sameOrigin).toBe(true)
  })

  it('blob: / data: 记协议不记内容', () => {
    const blob = redactUrl('blob:http://localhost:5273/9f08-uuid', ORIGIN)
    expect(blob!.host).toBe('blob:')
    expect(blob!.sameOrigin).toBe(true)
    const data = redactUrl('data:audio/mpeg;base64,AAAAAAAAAAAAAA', ORIGIN)
    expect(data!.host).toBe('data:')
    expect(JSON.stringify(data)).not.toContain('AAAAAAAA')
  })

  it('空串 → null', () => {
    expect(redactUrl('', ORIGIN)).toBeNull()
  })

  it('真正无法解析的 URL → null，不抛', () => {
    // 'http://' 有 scheme 但 host 为空 —— WHATWG 判定非法
    expect(redactUrl('http://', ORIGIN)).toBeNull()
  })

  it('怪串按相对路径解析，不抛也不泄漏', () => {
    // `::::` 不是垃圾，是合法的相对路径 → 解析成同源 URL。要的是「不抛、不泄漏」，
    // 不是「一定返回 null」。
    const ctx = redactUrl('::::', ORIGIN)
    expect(ctx!.sameOrigin).toBe(true)
    expect(ctx!.host).toBe('localhost:5273')
  })
})

describe('hashPath', () => {
  it('稳定且不含原文', () => {
    expect(hashPath('/audio/ep1.mp3')).toBe(hashPath('/audio/ep1.mp3'))
    expect(hashPath('/audio/ep1.mp3')).not.toContain('ep1')
  })
})
