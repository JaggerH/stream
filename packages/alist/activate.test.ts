import { describe, it, expect, vi } from 'vitest'
import { activate } from './activate.ts'
import { resolveAlistToken } from './adapter.ts'
import type { PluginContext } from '../../src/packages/activate.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const ctx = (config: Record<string, unknown> = {}): PluginContext => ({
  backendUrl: () => 'http://alist:5244',
  withAwake: (_s, fn) => fn(),
  cookieFor: async () => undefined,
  // 这个包不碰登录态。桩子抛而不是 no-op：静默的空实现会让"其实调到了"这件事看不见。
  login: async () => { throw new Error('这个包不该调 login') },
  readSource: async () => { throw new Error('这个包不该调 readSource') },
  readArticle: async () => { throw new Error('这个包不该调 readArticle') },
  log: () => {},
  config,
})

/** adapter 把宿主给的两个值收在私有字段里（client 才是惰性的），所以断的就是这两个快照。 */
const snapshotOf = (a: unknown): { baseUrl?: string; token?: string } =>
  a as { baseUrl?: string; token?: string }

describe('alist activate', () => {
  it('registers the alist adapter', () => {
    const out = activate(ctx())
    expect(Object.keys(out.adapters ?? {})).toEqual(['alist'])
  })

  it('registers the alist normalizer', () => {
    const out = activate(ctx())
    expect(Object.keys(out.normalizers ?? {})).toEqual(['alist'])
  })

  it('passes the host-resolved url and token through to the adapter', () => {
    const out = activate(ctx({ url: 'http://alist.test:5244', token: 'jwt-from-provisioning' }))
    const snap = snapshotOf(out.adapters?.alist)
    expect(snap.baseUrl).toBe('http://alist.test:5244')
    // token 走 adapter 自己的回退链（显式 → ALIST_TOKEN env）——断解析结果，不只断字段存在。
    expect(resolveAlistToken(snap.token)).toBe('jwt-from-provisioning')
  })

  // 这条线断了的症状：启动时没拿到 token 的那一整个进程里，网盘来源每次都报「缺少 token」，
  // 而宿主手里明明有能把 token 取来的通道。
  it('宿主给的接管通道（config.refresh）一路递到 adapter', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({ code: 200, data: { raw_url: 'http://cdn/x' } }) } as Response))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const refresh = vi.fn(async () => 'provisioned')
      const out = activate(ctx({ url: 'http://alist.test:5244', refresh }))
      const manifest = { id: 'alist-resolve', adapter: 'alist', fixed_params: { mode: 'resolve' } } as unknown as SourceManifest
      await out.adapters!.alist.fetch({ path: '/d/x' }, manifest)
      expect(refresh).toHaveBeenCalledTimes(1)
      expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: 'provisioned' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('没有显式 url 时容器地址来自 ctx.backendUrl，请求经 ctx.withAwake 唤醒', async () => {
    const prev = process.env.ALIST_URL
    delete process.env.ALIST_URL
    const seen: string[] = []
    const withAwake: PluginContext['withAwake'] = async (service, fn) => { seen.push(service); return fn() }
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({ code: 200, data: { raw_url: 'http://cdn/x' } }) } as Response))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const out = activate({ ...ctx({ token: 'tok' }), backendUrl: () => 'http://127.0.0.1:45001', withAwake })
      const manifest = { id: 'alist-resolve', adapter: 'alist', fixed_params: { mode: 'resolve' } } as unknown as SourceManifest
      await out.adapters!.alist.fetch({ path: '/d/x' }, manifest)
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:45001/api/fs/get')
      expect(seen).toEqual(['alist'])
    } finally {
      vi.unstubAllGlobals()
      if (prev !== undefined) process.env.ALIST_URL = prev
    }
  })
})
