import { describe, expect, it } from 'vitest'
import { errText } from './err-text.ts'

describe('errText', () => {
  it('普通 Error → message', () => {
    expect(errText(new Error('boom'))).toBe('boom')
  })
  it('字符串/对象照旧', () => {
    expect(errText('s')).toBe('s')
    expect(errText({ a: 1 })).toBe('{"a":1}')
  })
  it('带 cause 链的 Error → 逐层展开(undici 的 fetch failed 真因藏在 cause 里)', () => {
    // 真实事故(2026-07-23):/_p 网关 502 的 body 只有 {"error":"fetch failed"},
    // 真因(TypeError→SocketError: other side closed / UND_ERR_*)全在 cause 链上,
    // 排障只能靠临时插桩。errText 逐层展开后,一条 502 自己就把病根说全。
    const inner = new Error('other side closed') as Error & { code?: string }
    inner.code = 'UND_ERR_SOCKET'
    const outer = new TypeError('fetch failed', { cause: inner })
    expect(errText(outer)).toBe('fetch failed ← other side closed [UND_ERR_SOCKET]')
  })
  it('cause 链成环不死循环', () => {
    const e = new Error('a') as Error & { cause?: unknown }
    e.cause = e
    expect(errText(e)).toBe('a')
  })
  it('非 Error 的 cause 也能展示', () => {
    const outer = new Error('outer', { cause: 'raw-string-cause' })
    expect(errText(outer)).toBe('outer ← raw-string-cause')
  })
})
