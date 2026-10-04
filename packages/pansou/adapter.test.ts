import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { resolvePansouUrl, PansouAdapter, PANSOU_SERVICE, withOrigin, type PansouAdapterDeps } from './adapter.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: 'pansou-search' } as unknown as SourceManifest
const none = () => undefined

describe('resolvePansouUrl', () => {
  beforeEach(() => {
    delete process.env.PANSOU_URL
  })

  it('prefers an explicit url', () => {
    expect(resolvePansouUrl('https://relay.example.com', () => 'http://pansou:8888')).toBe('https://relay.example.com')
  })

  it('falls back to PANSOU_URL', () => {
    process.env.PANSOU_URL = 'https://relay.example.com'
    expect(resolvePansouUrl(undefined, () => 'http://pansou:8888')).toBe('https://relay.example.com')
  })

  it('宿主给的容器地址（compose 档容器 DNS / host 档 loopback）排在 env 之后', () => {
    expect(resolvePansouUrl(undefined, () => 'http://pansou:8888')).toBe('http://pansou:8888')
  })

  it('宿主答不出地址（mode:none）→ 空串，不再默认 gateway loopback', () => {
    expect(resolvePansouUrl(undefined, none)).toBe('')
  })
})

describe('PansouAdapter', () => {
  beforeEach(() => {
    delete process.env.PANSOU_URL
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function okFetch() {
    const fetchMock = vi.fn(async (url: string) => {
      void url
      return { ok: true, status: 200, json: async () => ({ data: { results: [] } }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('base url 惰性：构造期宿主还答不出地址，fetch 时才读到（host 档开机时容器睡着）', async () => {
    let target: string | undefined // 构造时 backendUrl() 还是 undefined
    const deps: PansouAdapterDeps = { backendUrl: () => target, withAwake: (_s, fn) => fn() }
    const adapter = new PansouAdapter(deps)
    target = 'http://127.0.0.1:44888'
    const fetchMock = okFetch()

    await adapter.fetch({ keyword: 'x' }, manifest)

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:44888/api/search')
  })

  it('地址在 withAwake 回调里才求值——唤醒后才有 loopback origin', async () => {
    let target: string | undefined
    const withAwake: PansouAdapterDeps['withAwake'] = async (_s, fn) => {
      target = 'http://127.0.0.1:44888' // 模拟 standby 唤醒容器后 origin 才出现
      return fn()
    }
    const adapter = new PansouAdapter({ backendUrl: () => target, withAwake })
    const fetchMock = okFetch()

    await adapter.fetch({ keyword: 'x' }, manifest)

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:44888/api/search')
  })

  it('每次打容器都经 deps.withAwake，且唤醒键是本包的 service 名', async () => {
    const seen: string[] = []
    const withAwake: PansouAdapterDeps['withAwake'] = async (service, fn) => { seen.push(service); return fn() }
    const adapter = new PansouAdapter({ backendUrl: () => 'http://pansou:8888', withAwake })
    okFetch()

    await adapter.fetch({ keyword: 'x' }, manifest)

    expect(seen).toEqual([PANSOU_SERVICE])
    expect(PANSOU_SERVICE).toBe('pansou')
  })

  it('显式 url 压过宿主地址，且去掉尾斜杠', async () => {
    const adapter = new PansouAdapter({ backendUrl: () => 'http://pansou:8888', withAwake: (_s, fn) => fn() }, 'http://example.test:9999/')
    const fetchMock = okFetch()

    await adapter.fetch({ keyword: 'x' }, manifest)

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://example.test:9999/api/search')
  })
})

// spec 2026-09-26-boundary-stage9 §2.1：出处链接由本包产出通用字段，宿主只读 origin / provider /
// channel_url，不再认识盘搜上游的 message_id / unique_id 形状。拼法从宿主 adaptRawItem 原样搬来。
describe('withOrigin —— 盘搜条目 → 通用出处字段', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('Telegram 频道消息：origin = 那条消息，channel_url = 频道，不给 provider', () => {
    const out = withOrigin({ title: 't', channel: 'yunpanx', message_id: 80847 })
    expect(out.origin).toBe('https://t.me/yunpanx/80847')
    expect(out.channel_url).toBe('https://t.me/yunpanx')
    expect(out.provider).toBeUndefined()
    expect(out.channel).toBe('yunpanx') // 原字段保留（发现池按频道名记）
  })

  it('有频道没消息号：只有 channel_url，没有 origin', () => {
    const out = withOrigin({ channel: 'yunpanx' })
    expect(out.origin).toBeUndefined()
    expect(out.channel_url).toBe('https://t.me/yunpanx')
  })

  it('非 Telegram 命中：unique_id 是 "<插件>-<id>" → provider 取插件名', () => {
    const out = withOrigin({ unique_id: 'hdr4k-123' })
    expect(out.provider).toBe('hdr4k')
    expect(out.origin).toBeUndefined()
    expect(out.channel_url).toBeUndefined()
  })

  it('插件名不合文法（空 / 过长 / 带怪字符）→ 不给 provider', () => {
    expect(withOrigin({ unique_id: '' }).provider).toBeUndefined()
    expect(withOrigin({ unique_id: 'a'.repeat(30) + '-1' }).provider).toBeUndefined()
    expect(withOrigin({ unique_id: '坏-1' }).provider).toBeUndefined()
  })

  it('上游已带同名字段 → 不覆盖', () => {
    const out = withOrigin({ channel: 'c', message_id: 1, origin: 'https://x.test/p' })
    expect(out.origin).toBe('https://x.test/p')
  })

  it('fetch 返回的每条都带上通用字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { results: [{ title: 'a', channel: 'chan', message_id: 7 }] } }),
    }) as unknown as Response))
    const adapter = new PansouAdapter({ backendUrl: () => 'http://pansou:8888', withAwake: (_s, fn) => fn() })
    const out = await adapter.fetch({ keyword: 'x' }, manifest) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ origin: 'https://t.me/chan/7', channel_url: 'https://t.me/chan' })
  })
})
