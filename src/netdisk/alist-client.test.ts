import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setPluginTargetResolver } from '../plugins/plugin-target.ts'

const withAwakeMock = vi.fn(async (_service: string, fn: () => Promise<unknown>) => fn())
vi.mock('../plugins/standby/hook.ts', () => ({ withAwake: (...args: [string, () => Promise<unknown>]) => withAwakeMock(...args) }))

const { resolveAlistUrl, toGatewayAlistUrl, hostAlistClient } = await import('./alist-client.ts')

describe('toGatewayAlistUrl', () => {
  it('re-serves an AList proxy link (internal host) through the same-origin gateway route', () => {
    // AList emits its own site host (here the internal docker name) which the browser cannot resolve.
    const raw = 'http://gateway/p/quark/%E6%80%A1%E4%B9%90/837.mp3?sign=abc=:0'
    expect(toGatewayAlistUrl(raw)).toBe('/_p/alist/p/quark/%E6%80%A1%E4%B9%90/837.mp3?sign=abc=:0')
  })
  it('re-serves a /d/ direct link too', () => {
    expect(toGatewayAlistUrl('http://gateway/d/mount/x.mp3?sign=z')).toBe('/_p/alist/d/mount/x.mp3?sign=z')
  })
  it('passes an external CDN direct link through untouched (browser reaches it directly)', () => {
    const cdn = 'http://cdn5.lizhi.fm/audio/2026/06/21/3218711731046364166_hd.mp3'
    expect(toGatewayAlistUrl(cdn)).toBe(cdn)
  })
  it('leaves a non-proxy AList path alone (only /p, /d are proxy paths)', () => {
    expect(toGatewayAlistUrl('http://gateway/api/fs/x')).toBe('http://gateway/api/fs/x')
  })
  it('returns a malformed / already-relative url unchanged', () => {
    expect(toGatewayAlistUrl('/_p/alist/p/x.mp3?sign=q')).toBe('/_p/alist/p/x.mp3?sign=q')
  })
})

describe('resolveAlistUrl', () => {
  it('explicit > env > plugin target', () => {
    const prev = process.env.ALIST_URL
    process.env.ALIST_URL = 'http://from-env'
    try {
      expect(resolveAlistUrl('http://explicit')).toBe('http://explicit')
      expect(resolveAlistUrl(undefined)).toBe('http://from-env')
    } finally {
      if (prev === undefined) delete process.env.ALIST_URL
      else process.env.ALIST_URL = prev
    }
  })
  it('三档都没有（mode:none）→ 空串', () => {
    setPluginTargetResolver(() => null)
    const prev = process.env.ALIST_URL
    delete process.env.ALIST_URL
    try {
      expect(resolveAlistUrl(undefined)).toBe('')
    } finally {
      if (prev !== undefined) process.env.ALIST_URL = prev
    }
  })
})

describe('hostAlistClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.ALIST_URL
    setPluginTargetResolver(() => null)
    withAwakeMock.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setPluginTargetResolver(() => null) // 复位,别污染别的用例
  })

  it('base 是惰性的:构造期未接线,请求时读到后接线的 plugin target(host 档开机时容器睡着)', async () => {
    const client = hostAlistClient({ token: 'tok' }) // 构造时 pluginTarget('alist') 还是 null
    setPluginTargetResolver((s) => (s === 'alist' ? 'http://127.0.0.1:45001' : null))

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 200, data: { content: [] } }) } as Response)
    await client.listDir('/d')

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45001/api/fs/list')
    // hostAlistClient 存在的唯一理由：请求必须经 withAwake('alist', …) 唤醒，不能直连 fetch。
    expect(withAwakeMock).toHaveBeenCalledTimes(1)
    expect(withAwakeMock.mock.calls[0][0]).toBe('alist')
    // 断言回调确实在 withAwake 内部跑过（而不是被忽略）：fetch 已经被调用。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('显式 baseUrl 压过 plugin target，token 裸放 authorization 头', async () => {
    setPluginTargetResolver(() => 'http://should-not-win')
    const client = hostAlistClient({ baseUrl: 'http://explicit', token: 'my-token' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 200, data: { content: [] } }) } as Response)
    await client.listDir('/d')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://explicit/api/fs/list')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'my-token' })
  })
})
