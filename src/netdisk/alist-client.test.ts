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
  afterEach(() => {
    delete process.env.ALIST_URL
    setPluginTargetResolver(() => null)
  })
  // 网盘底座是内置托管的：地址只有「宿主此刻给的容器地址」这一个来源。留着环境变量那一层，
  // 机器上碰巧设了 ALIST_URL 就会把所有网盘请求悄悄引到别处。
  it('只认 plugin target；ALIST_URL 环境变量不再生效', () => {
    process.env.ALIST_URL = 'http://from-env'
    setPluginTargetResolver((s) => (s === 'alist' ? 'http://127.0.0.1:45001' : null))
    expect(resolveAlistUrl()).toBe('http://127.0.0.1:45001')
  })
  it('没有容器地址（mode:none）→ 空串', () => {
    process.env.ALIST_URL = 'http://from-env'
    setPluginTargetResolver(() => null)
    expect(resolveAlistUrl()).toBe('')
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

  // 同 adapter 那一条：host 档下 plugin target 只在容器醒着时有值，而唤醒发生在 withAwake 里。
  it('容器睡着（唤醒之前 plugin target 为空）时第一个请求也能成：地址在 withAwake 里面才取', async () => {
    let awake = false
    setPluginTargetResolver((s) => (awake && s === 'alist' ? 'http://127.0.0.1:45001' : null))
    withAwakeMock.mockImplementationOnce(async (_service, fn) => { awake = true; try { return await fn() } finally { awake = false } })
    const client = hostAlistClient({ token: 'tok' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 200, data: { content: [] } }) } as Response)
    await client.listDir('/d')
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45001/api/fs/list')
  })

  it('token 裸放 authorization 头', async () => {
    setPluginTargetResolver(() => 'http://alist-target')
    const client = hostAlistClient({ token: 'my-token' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 200, data: { content: [] } }) } as Response)
    await client.listDir('/d')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://alist-target/api/fs/list')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'my-token' })
  })
})
