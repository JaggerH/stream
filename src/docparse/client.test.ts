import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { resolveMineruUrl, mineruMode, MineruClient } from './client.ts'
import { setPluginTargetResolver, resolvePluginTarget } from '../plugins/plugin-target.ts'
import type { PluginDescriptor } from '../plugins/types.ts'

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
  vi.restoreAllMocks()
})

describe('resolveMineruUrl', () => {
  beforeEach(() => {
    delete process.env.MINERU_URL
    delete process.env.STREAM_PLUGIN_GATEWAY
    setPluginTargetResolver(() => null) // 未接线 = mode:none 的默认态
  })
  afterEach(() => setPluginTargetResolver(() => null))

  it('prefers an explicit url, stripping a trailing slash', () => {
    expect(resolveMineruUrl('https://relay.example.com/')).toBe('https://relay.example.com')
  })

  it('falls back to MINERU_URL', () => {
    process.env.MINERU_URL = 'https://relay.example.com'
    expect(resolveMineruUrl()).toBe('https://relay.example.com')
  })

  it('server-side base 未接线（mode:none，桌面无门）→ 空串，不再默认 gateway loopback', () => {
    expect(resolveMineruUrl()).toBe('')
  })

  it('bootstrap 接线后（compose 形态）→ 容器 DNS target，无需调用方自己穿 descriptors', () => {
    const descriptors: PluginDescriptor[] = [
      { id: 'mineru', backend: { image: 'x', port: 80 } } as PluginDescriptor,
    ]
    setPluginTargetResolver((service) => resolvePluginTarget(service, { descriptors, mode: 'compose' }))
    expect(resolveMineruUrl()).toBe('http://mineru:80')
  })
})

describe('mineruMode', () => {
  it('classifies the loopback gateway as local', () => {
    expect(mineruMode('http://127.0.0.1:8900/_p/mineru')).toBe('local')
    expect(mineruMode('http://localhost:8900/_p/mineru')).toBe('local')
  })
  it('classifies a remote host as cloud', () => {
    expect(mineruMode('https://relay.example.com')).toBe('cloud')
  })
})

describe('MineruClient.parse', () => {
  it('POSTs multipart with a pdf type hint and parses {markdown, json}', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ markdown: '# T\n\n净利润 42', json: { blocks: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const c = new MineruClient('https://relay.example.com')
    expect(c.mode()).toBe('cloud')
    const res = await c.parse(new Uint8Array([1, 2, 3]), 'application/pdf', 'report.pdf')
    expect(res.markdown).toContain('净利润 42')
    expect(res.json).toEqual({ blocks: 1 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://relay.example.com/parse')
    const body = init!.body as FormData
    expect(body.get('type')).toBe('pdf')
    expect(body.get('file')).toBeInstanceOf(Blob)
  })

  it('hints image for non-pdf input', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ markdown: 'ocr' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const c = new MineruClient('http://127.0.0.1:8900/_p/mineru')
    await c.parse(new Uint8Array([1]), 'image/png', 'shot.png')
    expect((fetchMock.mock.calls[0][1]!.body as FormData).get('type')).toBe('image')
  })

  it('MinerU 缺席（base 为空）→ 报「未安装 + 装法」，一个 fetch 都不发', async () => {
    delete process.env.MINERU_URL
    setPluginTargetResolver(() => null)
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = new MineruClient()
    await expect(c.parse(new Uint8Array([1]), 'application/pdf', 'x.pdf')).rejects.toThrow('stream add @streamapp/mineru')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const c = new MineruClient('https://relay.example.com')
    await expect(c.parse(new Uint8Array([1]), 'application/pdf', 'x.pdf')).rejects.toThrow('HTTP 500')
  })
})
