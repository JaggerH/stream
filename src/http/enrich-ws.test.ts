import { describe, expect, it, vi } from 'vitest'
import type { Enricher } from '../packages/activate.ts'
import { attachEnrichCommands } from './enrich-ws.ts'
import { WsHub } from './ws.ts'

function harness(enrichers: Record<string, Enricher>) {
  const hub = new WsHub()
  const frames: string[] = []
  const client = { send: (s: string) => frames.push(s) }
  hub.register(client)
  const map = new Map(Object.entries(enrichers))
  attachEnrichCommands(hub, { enrichers: () => map })
  const parsed = () => frames.map((s) => JSON.parse(s) as Record<string, unknown>)
  const open = (correlationId: string, source: string, params: Record<string, string>) =>
    hub.receive(client, JSON.stringify({ type: 'enrich.open', correlationId, source, params }))
  return { hub, client, frames, parsed, open }
}

describe('attachEnrichCommands', () => {
  it('streams correlated detail parts only to the requesting client', async () => {
    const hub = new WsHub()
    const a: string[] = []
    const b: string[] = []
    const ca = { send: (s: string) => a.push(s) }
    const cb = { send: (s: string) => b.push(s) }
    hub.register(ca)
    hub.register(cb)
    const fn = vi.fn().mockResolvedValue({
      article: { text: 'body', media: [{ kind: 'image', url: 'https://img.test/1' }] },
      comments: [{ id: 'c1', author: 'u', text: 'hi', replies: [] }],
      total: 1,
    })
    attachEnrichCommands(hub, { enrichers: () => new Map([['site-detail', fn]]) })
    hub.receive(ca, JSON.stringify({ type: 'enrich.open', correlationId: 'corr-1', source: 'site-detail', params: { id: 'n1', token: 't1' } }))
    await vi.waitFor(() => expect(a.some((s) => JSON.parse(s).type === 'enrich.completed')).toBe(true))
    expect(fn).toHaveBeenCalledWith({ id: 'n1', token: 't1' }, expect.any(AbortSignal))
    expect(a.map((s) => JSON.parse(s).type)).toEqual([
      'enrich.started', 'enrich.article', 'enrich.comments', 'enrich.completed',
    ])
    expect(a.every((s) => JSON.parse(s).correlationId === 'corr-1')).toBe(true)
    expect(b).toEqual([])
  })

  it('returns a correlated failure and rejects malformed commands without calling the enricher', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('login wall'))
    const h = harness({ 'site-detail': fn })
    // 缺 source / params 不是对象 / params 值不是字符串 / 超长：全部静默丢弃，不碰 enricher。
    h.hub.receive(h.client, JSON.stringify({ type: 'enrich.open', correlationId: 'bad', params: { id: 'n' } }))
    h.hub.receive(h.client, JSON.stringify({ type: 'enrich.open', correlationId: 'bad', source: 'site-detail', params: 'n' }))
    h.hub.receive(h.client, JSON.stringify({ type: 'enrich.open', correlationId: 'bad', source: 'site-detail', params: { id: 1 } }))
    h.hub.receive(h.client, JSON.stringify({ type: 'enrich.open', correlationId: 'bad', source: 'site-detail', params: { id: 'x'.repeat(5000) } }))
    expect(fn).not.toHaveBeenCalled()
    expect(h.frames).toEqual([])
    h.open('corr-2', 'site-detail', { id: 'n' })
    await vi.waitFor(() => expect(h.parsed().some((f) => f.type === 'enrich.failed')).toBe(true))
    expect(h.parsed().at(-1)).toMatchObject({ type: 'enrich.failed', correlationId: 'corr-2', error: 'login wall' })
  })

  it('answers an unknown source with a correlated failure（包没装载时静默回空会被读成"没有正文"）', async () => {
    const h = harness({})
    h.open('c0', 'nobody-detail', { id: 'n' })
    await vi.waitFor(() => expect(h.parsed().some((f) => f.type === 'enrich.failed')).toBe(true))
    expect(h.parsed().map((f) => f.type)).toEqual(['enrich.started', 'enrich.failed'])
    expect(h.parsed().at(-1)).toMatchObject({ correlationId: 'c0', error: expect.stringContaining('nobody-detail') })
  })

  /**
   * 连点两条的那个场景。**判据是 signal，不是消息**：前端本来就会按 correlationId 把旧答案丢掉，
   * 所以"第二条的结果到了"这件事在取消生效前后长得一模一样——真正要钉的是第一次那趟运行有没有
   * 被叫停（它占着那条串行 lane，还花着一发访问预算）。
   */
  it('supersedes an in-flight run when the same source is opened with different params', async () => {
    const signals: AbortSignal[] = []
    let releaseFirst: (() => void) | undefined
    const fn = vi.fn().mockImplementation((params: { id: string }, signal: AbortSignal) => {
      signals.push(signal)
      if (params.id === 'n1') {
        return new Promise((_resolve, reject) => {
          releaseFirst = () => reject(new Error('recipe cancelled'))
        })
      }
      return Promise.resolve({ article: { text: 'second' } })
    })
    const h = harness({ 'site-detail': fn })

    h.open('c1', 'site-detail', { id: 'n1' })
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    expect(signals[0].aborted).toBe(false)

    h.open('c2', 'site-detail', { id: 'n2' })
    expect(signals[0].aborted).toBe(true)

    // 被叫停的那次最终以 rejection 收场——它不该在前端制造一次假故障，所以一个 failed 帧都不发。
    releaseFirst!()
    await vi.waitFor(() => expect(h.parsed().some((f) => f.correlationId === 'c2' && f.type === 'enrich.article')).toBe(true))
    expect(h.parsed().filter((f) => f.type === 'enrich.failed')).toEqual([])
  })

  /** 同 source 同 params 再点一次：不取消、不重跑，搭上正在飞的那次。params 键序不同也算同一份。 */
  it('rides the in-flight run when the same source+params is opened again', async () => {
    let finish: ((value: unknown) => void) | undefined
    const fn = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const h = harness({ 'site-detail': fn })

    h.open('c1', 'site-detail', { id: 'n1', token: 't' })
    h.open('c2', 'site-detail', { token: 't', id: 'n1' })
    expect(fn).toHaveBeenCalledTimes(1)

    finish!({ article: { text: 'body' } })
    await vi.waitFor(() => expect(h.parsed().filter((f) => f.type === 'enrich.completed')).toHaveLength(2))
    expect(h.parsed().filter((f) => f.type === 'enrich.completed').map((f) => f.correlationId)).toEqual(['c1', 'c2'])
  })

  /** in-flight 按 source 分：两个不同 source 各自一条在飞，互不顶掉。 */
  it('keeps one in-flight run per source', async () => {
    const signals: AbortSignal[] = []
    const fn = vi.fn().mockImplementation((_p: unknown, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise(() => {})
    })
    const h = harness({ 'a-detail': fn, 'b-detail': fn })
    h.open('c1', 'a-detail', { id: '1' })
    h.open('c2', 'b-detail', { id: '1' })
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals.map((s) => s.aborted)).toEqual([false, false])
  })

  it('classifies RecipeBlockedError as blocked', async () => {
    const blocked = Object.assign(new Error('background throttled'), { name: 'RecipeBlockedError' })
    const h = harness({ 'site-detail': async () => { throw blocked } })
    h.open('c3', 'site-detail', { id: 'n' })
    await vi.waitFor(() => expect(h.frames).toHaveLength(2))
    expect(h.parsed()[1]).toEqual({ type: 'enrich.blocked', correlationId: 'c3', reason: 'background throttled' })
  })
})
