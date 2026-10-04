import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ownedFetch = vi.hoisted(() => vi.fn())
vi.mock('../http/owned-outbound.ts', () => ({ ownedFetch }))

import { isPrivateHost, publicHttpUrl, safeFetchResponse } from './safe-fetch.ts'

describe('safe-fetch SSRF 守卫（语义不变）', () => {
  it('私网 host 一律拒绝', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('10.0.0.1')).toBe(true)
    expect(isPrivateHost('192.168.1.1')).toBe(true)
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('169.254.1.1')).toBe(true)
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })

  it('publicHttpUrl 拒非 http(s) 与私网', () => {
    expect(publicHttpUrl('ftp://x/')).toBeNull()
    expect(publicHttpUrl('http://127.0.0.1/')).toBeNull()
    expect(publicHttpUrl('not a url')).toBeNull()
    expect(publicHttpUrl('http://8.8.8.8/')).not.toBeNull()
    expect(publicHttpUrl('https://example.com/')).not.toBeNull()
  })
})

describe('safe-fetch 迁移守卫', () => {
  it('源码经 ownedFetch 出站，不再直接调用全局 fetch', () => {
    const src = readFileSync(fileURLToPath(new URL('./safe-fetch.ts', import.meta.url)), 'utf8')
    expect(src).toContain('ownedFetch(')
    // 裸 `fetch(` 小写单词边界不会误伤 `ownedFetch(`（大写 F，\b 不落在 d|F 之间）
    expect(src).not.toMatch(/\bfetch\(/)
  })
})

// 调用方的取消信号（转换任务被用户撤销）要能一路传到出站请求上。**但传了它不能把内部超时
// 顶掉**：`signal` 与 `AbortSignal.timeout` 是同一个位置上的两件事，直接赋值等于静默关掉超时，
// 于是一个不返回的服务端能把请求永远挂住——而症状只是"这次特别慢"，没人会想到是超时没了。
describe('safeFetchResponse 的取消信号', () => {
  it('外部 signal abort 能传导到出站请求', async () => {
    let seen: AbortSignal | undefined
    ownedFetch.mockImplementation(async (_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return new Response('', { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const ctrl = new AbortController()
    await safeFetchResponse('https://e.com/a.png', { signal: ctrl.signal })
    expect(seen!.aborted).toBe(false)
    ctrl.abort()
    expect(seen!.aborted).toBe(true)
  })

  it('传了 signal，内部超时照样生效（外部永不 abort 也不会挂死）', async () => {
    ownedFetch.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => (init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')))),
    )
    const ctrl = new AbortController() // 永不 abort
    await expect(safeFetchResponse('https://e.com/a.png', { signal: ctrl.signal, timeoutMs: 20 })).resolves.toBeNull()
  })
})
