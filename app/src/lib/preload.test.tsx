import { render, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePrefetchOnApproach } from './preload.ts'
import type { SocketHandlers } from './transport.ts'
import type { Item } from './types.ts'

const enrichMock = vi.hoisted(() => vi.fn())
const observeMock = vi.hoisted(() => vi.fn())
const disconnectMock = vi.hoisted(() => vi.fn())
// useWs 连的 socket：vi.mock 而不是 spy——下面每条用例都 resetModules 后重新 import，spy 只钉得住
// 旧的那份模块实例。
const openSocketMock = vi.hoisted(() => vi.fn())

vi.mock('./transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport.ts')>()
  return { ...actual, selectTransport: () => ({ fetch: vi.fn(), openSocket: openSocketMock }) }
})

vi.mock('./api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      enrich: enrichMock,
    },
  }
})

const item: Item = {
  id: 'hn-1',
  stream_id: 'hn',
  type: 'post',
  title: 'Thin item',
  url: 'https://news.ycombinator.com/item?id=48526661',
  timestamp: '2026-06-27T00:00:00.000Z',
  fetched_at: '2026-06-27T00:00:00.000Z',
  content: {
    archetype: 'link',
    media: [{ kind: 'link', url: 'https://example.com/article', title: 'Source' }],
  },
  source_guid: '48526661',
}

describe('preload persistence', () => {
  beforeEach(() => {
    enrichMock.mockReset()
    window.sessionStorage.clear()
    vi.resetModules()
    observeMock.mockReset()
    disconnectMock.mockReset()
    openSocketMock.mockReset()
  })

  it('persists warm enrichments in session storage for refresh reuse', async () => {
    enrichMock.mockResolvedValue({
      article: { excerpt: 'Warm excerpt' },
      total: 7,
      comments: [],
    })

    const modA = await import('./preload.ts')
    modA.prefetchEnrichment(item, { baseUrl: '' })
    await waitFor(() => expect(enrichMock).toHaveBeenCalledTimes(1))

    const persisted = window.sessionStorage.getItem('stream.preload-cache.v1')
    expect(persisted).toContain('Warm excerpt')

    vi.resetModules()
    const modB = await import('./preload.ts')
    const { result } = renderHook(() => modB.useEnrichmentValue(item))
    expect(result.current?.article?.excerpt).toBe('Warm excerpt')

    modB.prefetchEnrichment(item, { baseUrl: '' })
    expect(enrichMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the shell-content scroller when no radix viewport exists', async () => {
    class IntersectionObserverStub {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        ;(this as { options?: IntersectionObserverInit }).options = options
      }
      options?: IntersectionObserverInit
      observe = observeMock
      disconnect = disconnectMock
    }

    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub as unknown as typeof IntersectionObserver)

    function Harness() {
      const ref = usePrefetchOnApproach<HTMLDivElement>(item, { baseUrl: '' })
      return (
        <div data-slot="shell-content">
          <div id="row" ref={ref} />
        </div>
      )
    }

    render(<Harness />)

    await waitFor(() => expect(observeMock).toHaveBeenCalled())
    const observerInstance = observeMock.mock.instances[0] as { options?: IntersectionObserverInit } | undefined

    expect(observerInstance?.options?.root).toBe(document.querySelector('[data-slot="shell-content"]'))
  })

  // 瀑布流一屏 20–30 张卡,被挤出 LRU 是常态。observer 原来在第一次相交后就 io.disconnect()
  // ("一次就够——结果已经缓存了"),于是滚下去三屏再滚回来,第一屏的卡片既没了缓存、也永远
  // 不会再 warm:一次降级变成不可逆的降级。这里的 stub 真的实现 disconnect 语义(断开后 emit
  // 不再回调),所以这条用例对"有没有 disconnect"是敏感的。
  it('再次进入视口时会重新 warm——缓存已经不新鲜了就真的再取一次', async () => {
    let observer: { emit: () => void } | null = null
    class IntersectionObserverStub {
      callback: IntersectionObserverCallback
      disconnected = false
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        observer = this
      }
      observe = observeMock
      disconnect = () => {
        this.disconnected = true
        disconnectMock()
      }
      emit() {
        if (this.disconnected) return
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub as unknown as typeof IntersectionObserver)
    enrichMock.mockResolvedValue({ article: { excerpt: 'Warm excerpt' }, total: 0, comments: [] })

    const mod = await import('./preload.ts')
    function Harness() {
      const ref = mod.usePrefetchOnApproach<HTMLDivElement>(item, { baseUrl: '' })
      return <div ref={ref} />
    }
    render(<Harness />)
    await waitFor(() => expect(observeMock).toHaveBeenCalled())

    observer!.emit()
    await waitFor(() => expect(enrichMock).toHaveBeenCalledTimes(1))

    // 缓存还新鲜时再相交一次:不该白发第二个请求(prefetchEnrichment 自己会拦)
    observer!.emit()
    expect(enrichMock).toHaveBeenCalledTimes(1)

    // 走过 TTL —— 等价于"这条已经被挤出 LRU / 过期了",卡片此刻正退回 body_text
    const realNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60 * 1000)
    observer!.emit()
    await waitFor(() => expect(enrichMock).toHaveBeenCalledTimes(2))
    nowSpy.mockRestore()
  })

  // 包声明的现取（`content.enrich`）多半骑着采集会话开标签页——只在用户点开时跑，列表滚动不预取。
  it('does not observe or prefetch a content.enrich row before the user opens it', async () => {
    class IntersectionObserverStub {
      observe = observeMock
      disconnect = disconnectMock
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub as unknown as typeof IntersectionObserver)
    const declared: Item = {
      ...item,
      id: 'pkg-1',
      stream_id: 'pkg-home',
      url: 'https://site.example/n/abc',
      content: { archetype: 'gallery', enrich: { source: 'demo-detail', params: { id: 'abc', token: 'TK' } } },
      source_guid: undefined,
    }
    const mod = await import('./preload.ts')
    mod.prefetchEnrichment(declared, { baseUrl: '' })
    expect(enrichMock).not.toHaveBeenCalled()

    function Harness() {
      const ref = usePrefetchOnApproach<HTMLDivElement>(declared, { baseUrl: '' })
      return <div ref={ref} />
    }
    render(<Harness />)
    expect(observeMock).not.toHaveBeenCalled()
  })

  /** 打开一条 `content.enrich` 条目走 WS 不走 HTTP：发 `enrich.open { source, params }`，按
   *  correlationId 认领 `enrich.*` 回程。宿主自己那几条（HN 等）仍走 `api.enrich`。 */
  it('useEnrichment opens a content.enrich item over WS and claims enrich.* by correlationId', async () => {
    let handlers: SocketHandlers | undefined
    const send = vi.fn()
    openSocketMock.mockImplementation((_url: string, h: SocketHandlers) => {
      handlers = h
      return { close: vi.fn(), send }
    })
    const declared: Item = {
      ...item,
      id: 'pkg-1',
      stream_id: 'pkg-home',
      content: { archetype: 'gallery', enrich: { source: 'demo-detail', params: { id: 'abc', token: 'TK' } } },
      source_guid: undefined,
    }
    const mod = await import('./preload.ts')
    const { result } = renderHook(() => mod.useEnrichment(declared, { baseUrl: '' }, true))
    handlers!.onOpen?.()
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const sent = JSON.parse(send.mock.calls[0][0] as string)
    expect(sent).toMatchObject({ type: 'enrich.open', source: 'demo-detail', params: { id: 'abc', token: 'TK' } })
    expect(typeof sent.correlationId).toBe('string')
    expect(enrichMock).not.toHaveBeenCalled()

    // 别人的 correlationId 一律忽略；自己的分片按序落进状态。
    handlers!.onMessage(JSON.stringify({ type: 'enrich.article', correlationId: 'someone-else', article: { text: 'nope' } }))
    handlers!.onMessage(JSON.stringify({ type: 'enrich.article', correlationId: sent.correlationId, article: { text: 'body' } }))
    handlers!.onMessage(JSON.stringify({ type: 'enrich.comments', correlationId: sent.correlationId, comments: [{ id: 'c1', author: 'u', text: 'hi', replies: [] }], total: 9 }))
    handlers!.onMessage(JSON.stringify({ type: 'enrich.completed', correlationId: sent.correlationId }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.article?.text).toBe('body')
    expect(result.current.comments).toHaveLength(1)
    expect(result.current.total).toBe(9)
    expect(result.current.err).toBe(false)
  })

  /** 包自报 `prefetch: true` 的现取（站外裸 HTTP 的讨论串）：随滚动预取，走 HTTP；点开时命中
   *  同一份暖好的缓存，不开 WS、不再发第二次请求。 */
  it('content.enrich with prefetch → warmed over HTTP on approach, open reuses the warm cache', async () => {
    enrichMock.mockResolvedValue({ comments: [{ id: 'c1', text: 'hi' }], total: 5, cursor: null })
    const cheap: Item = {
      ...item, id: 'pkg-3', stream_id: 'pkg-forum', source_guid: undefined,
      content: { archetype: 'text', enrich: { source: 'demo-comments', params: { id: '7' }, prefetch: true } },
    }
    const mod = await import('./preload.ts')
    mod.prefetchEnrichment(cheap, { baseUrl: '' })
    await waitFor(() => expect(enrichMock).toHaveBeenCalledTimes(1))
    expect(enrichMock.mock.calls[0][1]).toEqual({ source: 'demo-comments', params: { id: '7' }, prefetch: true })

    const { result } = renderHook(() => mod.useEnrichment(cheap, { baseUrl: '' }, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.comments).toHaveLength(1)
    expect(result.current.total).toBe(5)
    expect(enrichMock).toHaveBeenCalledTimes(1)
    expect(openSocketMock).not.toHaveBeenCalled()
  })

  it('useEnrichment treats enrich.blocked like a failure', async () => {
    let handlers: SocketHandlers | undefined
    const send = vi.fn()
    openSocketMock.mockImplementation((_url: string, h: SocketHandlers) => { handlers = h; return { close: vi.fn(), send } })
    const declared: Item = {
      ...item, id: 'pkg-2', stream_id: 'pkg-home', source_guid: undefined,
      content: { archetype: 'gallery', enrich: { source: 'demo-detail', params: { id: 'x' } } },
    }
    const mod = await import('./preload.ts')
    const { result } = renderHook(() => mod.useEnrichment(declared, { baseUrl: '' }, true))
    handlers!.onOpen?.()
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const { correlationId } = JSON.parse(send.mock.calls[0][0] as string)
    handlers!.onMessage(JSON.stringify({ type: 'enrich.blocked', correlationId, reason: 'throttled' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.err).toBe(true)
  })
})
