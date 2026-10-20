import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { allowedDomains, pendingDomains, storageKey, type Binding } from './config.ts'
import { isPairableAddress, pairWithCode, PairAddressRefused, PairFailed } from './pair-code.ts'
import { verifyBackend, VERIFY_PREFIX } from './backend-identity.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const paired = (p: Partial<Binding> = {}): Binding => ({
  id: 'ext:a', kind: 'paired', baseUrl: 'https://main.example', token: 't', label: 'NAS',
  domains: [], requiredDomains: [], approvedDomains: [], autoSync: true, ...p,
})

describe('cookie 范围（design D7）', () => {
  it('本机：用户填的 ∪ Stream 申报的，与以前一致', () => {
    const local: Binding = { id: 'local', kind: 'local', baseUrl: '', label: '', domains: ['a.com'], requiredDomains: ['b.com'], autoSync: true }
    expect(allowedDomains(local)).toEqual(['a.com', 'b.com'])
    expect(pendingDomains(local)).toEqual([])
  })

  it('配对：远程实例申报的域只有批准过的才算', () => {
    const b = paired({ domains: ['a.com'], requiredDomains: ['eastmoneysec.com', 'mail.google.com'], approvedDomains: ['eastmoneysec.com'] })
    expect(allowedDomains(b)).toEqual(['a.com', 'eastmoneysec.com'])
    expect(pendingDomains(b)).toEqual(['mail.google.com'])
  })

  it('配对：批准过但实例已不再要的域不进范围', () => {
    expect(allowedDomains(paired({ approvedDomains: ['old.com'] }))).toEqual([])
  })
})

describe('storageKey', () => {
  it('本机沿用原来的键名；配对绑定带后缀', () => {
    expect(storageKey('tabGroup', 'local')).toBe('tabGroup')
    expect(storageKey('tabGroup', 'ext:a')).toBe('tabGroup:ext:a')
  })
})

describe('getBindings', () => {
  it('旧配置就是本机那条，不迁移、不改写', async () => {
    const set = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      storage: { local: {
        get: vi.fn(async (k: string) => (k === 'config'
          ? { config: { baseUrl: 'http://127.0.0.1:8900', domains: ['a.com'], requiredDomains: ['b.com'], autoSync: true } }
          : {})),
        set,
      } },
    })
    const { getBindings } = await import('./config.ts')
    expect(await getBindings()).toEqual([
      { id: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8900', label: '本机 Stream', domains: ['a.com'], requiredDomains: ['b.com'], autoSync: true },
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('配对绑定排在本机之后', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: {
        get: vi.fn(async (k: string) => (k === 'config' ? { config: {} } : { bindings: [paired()] })),
        set: vi.fn(async () => {}),
      } },
    })
    const { getBindings } = await import('./config.ts')
    expect((await getBindings()).map((b) => b.id)).toEqual(['local', 'ext:a'])
  })
})

describe('isPairableAddress', () => {
  it.each([
    ['https://main.example', true],
    ['http://127.0.0.1:8900', true],
    ['http://localhost:8900', true],
    ['http://[::1]:8900', true],
    ['http://203.0.113.5:8900', false],
    ['http://100.70.0.5:8900', false],
    ['ftp://main.example', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => expect(isPairableAddress(url)).toBe(ok))
})

describe('pairWithCode', () => {
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response

  it('明文远程地址：一个请求都不发', async () => {
    const f = vi.fn()
    await expect(pairWithCode('http://203.0.113.5:8900', '123456', {}, { fetch: f })).rejects.toBeInstanceOf(PairAddressRefused)
    expect(f).not.toHaveBeenCalled()
  })

  it('成功：回绑定 id、token 与设备', async () => {
    const f = vi.fn(async () => reply(200, { bindingId: 'ext:a', token: 'tok', deviceId: 'linux:nas', deviceName: 'NAS' }))
    expect(await pairWithCode('https://main.example/', ' 123456 ', { name: 'Chrome' }, { fetch: f as never })).toEqual({
      bindingId: 'ext:a', token: 'tok', deviceId: 'linux:nas', deviceName: 'NAS',
    })
    expect(f).toHaveBeenCalledWith('https://main.example/api/ext/pair', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ code: '123456', name: 'Chrome' }),
    }))
  })

  it('403 → 码不对或过期', async () => {
    await expect(pairWithCode('https://main.example', '1', {}, { fetch: (async () => reply(403, {})) as never })).rejects.toThrow(/配对码不对/)
  })

  it('回复缺 token → 失败', async () => {
    await expect(pairWithCode('https://main.example', '1', {}, { fetch: (async () => reply(200, { bindingId: 'x' })) as never })).rejects.toBeInstanceOf(PairFailed)
  })
})

describe('verifyBackend — 配对绑定', () => {
  it('请求带 binding，proof 以 sha256hex(token) 为 key（与后端 extVerifyProofForBinding 互验）', async () => {
    const TOKEN = 'p'.repeat(64)
    const hash = createHash('sha256').update(TOKEN).digest('hex')
    let sent: { nonce: string; binding?: string } | undefined
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      const proof = createHmac('sha256', hash).update(`${VERIFY_PREFIX}${sent!.nonce}`).digest('hex')
      return { ok: true, status: 200, json: async () => ({ proof }) }
    }))
    await expect(verifyBackend('https://main.example', TOKEN, { binding: 'ext:a' })).resolves.toBeUndefined()
    expect(sent?.binding).toBe('ext:a')
  })

  it('对端用 token 本身签（不是哈希）→ 不通过', async () => {
    const TOKEN = 'p'.repeat(64)
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const { nonce } = JSON.parse(String(init.body))
      const proof = createHmac('sha256', TOKEN).update(`${VERIFY_PREFIX}${nonce}`).digest('hex')
      return { ok: true, status: 200, json: async () => ({ proof }) }
    }))
    await expect(verifyBackend('https://main.example', TOKEN, { binding: 'ext:a' })).rejects.toThrow()
  })
})
