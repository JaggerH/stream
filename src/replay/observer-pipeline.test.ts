import { describe, expect, it } from 'vitest'
import type { ExtCdpEvent } from '../http/ext-relay.ts'
import type { NetworkRecipeObserver, RecipeOutput } from './recipe.ts'
import type { MappedItem } from './interpret.ts'
import type { PageDriver } from './actions.ts'
import { NetworkObserverPipeline, ObserverPipeline, type ObserverRelay, type ReadClock } from './observer-pipeline.ts'

function fakeRelay(body: unknown) {
  let listener: ((event: ExtCdpEvent) => void) | null = null
  const calls: Array<{ method: string; params: unknown }> = []
  const unsubscribed: number[] = []
  const relay: ObserverRelay = {
    async subscribe() { return 41 },
    async unsubscribe(id) { unsubscribed.push(id) },
    onEvent(fn) { listener = fn; return () => { listener = null } },
    async sendCommand(_tabId, method, params) {
      calls.push({ method, params })
      return { body: JSON.stringify(body), base64Encoded: false }
    },
  }
  const emit = (event: ExtCdpEvent) => listener?.(event)
  /** 一条正常完成的响应在 CDP 上是两个事件——响应头，然后 body 齐了。真浏览器从不只发前者。 */
  const respond = (requestId: string, url: string) => {
    emit({ type: 'cdp-event', subscriptionId: 41, tabId: 7, method: 'Network.responseReceived', params: { requestId, response: { url } } })
    emit({ type: 'cdp-event', subscriptionId: 41, tabId: 7, method: 'Network.loadingFinished', params: { requestId } })
  }
  return { relay, calls, unsubscribed, emit, respond }
}

const observer: NetworkRecipeObserver = {
  kind: 'network', urlPattern: '*/api/feed*', windowMs: 30_000, maxBodyBytes: 1024,
}
const output: RecipeOutput = {
  itemsAt: 'data.items', dedupeBy: 'id', targetCount: 2,
  mapping: { guid: 'id', title: 'name' }, assert: [{ path: 'data.items', desc: 'items' }],
}

describe('live harvest emit (onItems)', () => {
  it('network: streams each fresh batch to onItems as the XHR body is read', async () => {
    const seen: MappedItem[][] = []
    const f = fakeRelay({ data: { items: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output, { onItems: (items) => seen.push(items) })
    await pipeline.start()
    f.respond('r1', 'https://x.test/api/feed?page=1')
    await pipeline.flush()
    expect(seen).toEqual([[{ guid: '1', title: 'A' }, { guid: '2', title: 'B' }]])
    await pipeline.stop()
  })

  it('eval offer(): emits fresh items and stays silent on a deduped batch', () => {
    const seen: MappedItem[][] = []
    const pipeline = new ObserverPipeline({} as unknown as PageDriver, [], output, { onItems: (items) => seen.push(items) })
    pipeline.offer({ data: { items: [{ id: '1', name: 'A' }] } })
    pipeline.offer({ data: { items: [{ id: '1', name: 'A' }] } }) // fully deduped → no emit
    pipeline.offer({ data: { items: [{ id: '2', name: 'B' }] } })
    expect(seen).toEqual([[{ guid: '1', title: 'A' }], [{ guid: '2', title: 'B' }]])
  })
})

describe('NetworkObserverPipeline', () => {
  it('reads a matching response body and maps deduped items', async () => {
    const f = fakeRelay({ data: { items: [{ id: '1', name: 'A' }, { id: '1', name: 'A2' }, { id: '2', name: 'B' }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    f.respond('r1', 'https://x.test/api/feed?page=1')
    await pipeline.flush()
    expect(pipeline.items()).toEqual([{ guid: '1', title: 'A' }, { guid: '2', title: 'B' }])
    expect(f.calls).toEqual([{ method: 'Network.getResponseBody', params: { requestId: 'r1' } }])
    await pipeline.stop()
    expect(f.unsubscribed).toEqual([41])
  })

  it('uses an observer-local input before final output merge', async () => {
    const f = fakeRelay({ data: { items: [{ id: '1', note: { title: 'A' } }] } })
    const local: NetworkRecipeObserver = {
      ...observer,
      input: { itemsAt: 'data.items', dedupeBy: 'id', targetCount: 2, mapping: { noteId: 'id', guid: 'id', title: 'note.title' } },
    }
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [local], {
      itemsAt: 'items', dedupeBy: 'noteId', targetCount: 2, mapping: { noteId: 'noteId', guid: 'guid' },
    })
    await pipeline.start()
    f.respond('r1', 'https://x.test/api/feed')
    await pipeline.flush()
    expect(pipeline.items()).toEqual([{ noteId: '1', guid: '1', title: 'A' }])
    await pipeline.stop()
  })

  it('ignores another tab, subscription, method, or URL', async () => {
    const f = fakeRelay({ data: { items: [{ id: '1' }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    for (const event of [
      { subscriptionId: 41, tabId: 8, method: 'Network.responseReceived', params: { requestId: 'a', response: { url: 'https://x.test/api/feed' } } },
      { subscriptionId: 99, tabId: 7, method: 'Network.responseReceived', params: { requestId: 'b', response: { url: 'https://x.test/api/feed' } } },
      { subscriptionId: 41, tabId: 7, method: 'Network.requestWillBeSent', params: { requestId: 'c' } },
      { subscriptionId: 41, tabId: 7, method: 'Network.responseReceived', params: { requestId: 'd', response: { url: 'https://x.test/other' } } },
      // 一条我们从没见过响应头的请求完成了（别的 observer 不关心的流量）——不该凭空去读它
      { subscriptionId: 41, tabId: 7, method: 'Network.loadingFinished', params: { requestId: 'e' } },
    ]) f.emit({ type: 'cdp-event', ...event } as ExtCdpEvent)
    // 被忽略的那几条 responseReceived 也不该留下登记，否则 flush 的兜底会把它们捞起来读
    for (const requestId of ['a', 'b', 'd']) {
      f.emit({ type: 'cdp-event', subscriptionId: 41, tabId: 7, method: 'Network.loadingFinished', params: { requestId } } as ExtCdpEvent)
    }
    await pipeline.flush()
    expect(f.calls).toEqual([])
    await pipeline.stop()
  })

  it('drops an oversized body and reports a bounded diagnostic', async () => {
    const f = fakeRelay({ data: { items: [{ id: '1', blob: 'x'.repeat(2000) }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [{ ...observer, maxBodyBytes: 100 }], output)
    await pipeline.start()
    f.respond('big', 'https://x.test/api/feed')
    await pipeline.flush()
    expect(pipeline.items()).toEqual([])
    expect(pipeline.diagnostics()).toEqual(['network body exceeded 100 bytes'])
    await pipeline.stop()
  })

  it('stop is idempotent and removes the event listener', async () => {
    const f = fakeRelay({ data: { items: [] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    await pipeline.stop()
    await pipeline.stop()
    expect(f.unsubscribed).toEqual([41])
  })

  it('bounds concurrent response-body reads instead of growing an unbounded queue', async () => {
    let listener: (event: ExtCdpEvent) => void = () => {}
    let finish!: (value: unknown) => void
    const body = new Promise((resolve) => { finish = resolve })
    const calls: string[] = []
    const relay: ObserverRelay = {
      subscribe: async () => 41,
      unsubscribe: async () => {},
      onEvent: (fn) => { listener = fn; return () => { listener = () => {} } },
      sendCommand: async (_tab, _method, params) => { calls.push((params as { requestId: string }).requestId); return body },
    }
    const pipeline = new NetworkObserverPipeline(relay, 7, [observer], output, { maxInFlight: 1 })
    await pipeline.start()
    for (const requestId of ['r1', 'r2']) {
      for (const method of ['Network.responseReceived', 'Network.loadingFinished']) {
        listener({
          type: 'cdp-event', subscriptionId: 41, tabId: 7, method,
          params: { requestId, response: { url: 'https://x.test/api/feed' } },
        })
      }
    }
    expect(calls).toEqual(['r1'])
    expect(pipeline.diagnostics()).toContain('network observer backpressure limit reached')
    finish({ body: '{"data":{"items":[]}}', base64Encoded: false })
    // 被背压挡下的那条不是丢了，是推迟了：flush 收尾时补读
    await pipeline.flush()
    expect(calls).toEqual(['r1', 'r2'])
    await pipeline.stop()
  })
})

/**
 * 活体（2026-07-28，douyin-search 连续两轮 0 items）钉死的缺陷：body 读在 `responseReceived`
 * 上发，那时只有响应头，Chrome 回 `-32000 No data found for resource with given identifier`。
 */
describe('NetworkObserverPipeline: body 读在 loadingFinished，不在 responseReceived', () => {
  /** 只在 loadingFinished 之后才给 body，之前照 Chrome 的原样回 -32000。 */
  function bodyOnlyAfterFinish(body: unknown) {
    let listener: ((event: ExtCdpEvent) => void) | null = null
    const finished = new Set<string>()
    const attempts: Array<{ requestId: string; ok: boolean }> = []
    const relay: ObserverRelay = {
      async subscribe() { return 41 },
      async unsubscribe() {},
      onEvent(fn) { listener = fn; return () => { listener = null } },
      async sendCommand(_tabId, _method, params) {
        const requestId = (params as { requestId: string }).requestId
        const ok = finished.has(requestId)
        attempts.push({ requestId, ok })
        if (!ok) throw new Error('{"code":-32000,"message":"No data found for resource with given identifier"}')
        return { body: JSON.stringify(body), base64Encoded: false }
      },
    }
    const emit = (method: string, params: unknown) =>
      listener?.({ type: 'cdp-event', subscriptionId: 41, tabId: 7, method, params } as ExtCdpEvent)
    return {
      relay, attempts,
      head: (requestId: string, url = 'https://x.test/api/feed') =>
        emit('Network.responseReceived', { requestId, response: { url } }),
      finish: (requestId: string) => { finished.add(requestId); emit('Network.loadingFinished', { requestId }) },
      fail: (requestId: string) => emit('Network.loadingFailed', { requestId }),
    }
  }

  it('等到 body 齐了才读——响应头到达时不读，所以拿不到 -32000', async () => {
    const f = bodyOnlyAfterFinish({ data: { items: [{ id: '1', name: 'A' }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    f.head('r1')
    // 注意不能用 flush() 探这一步——flush 是"运行结束"的兜底，它本来就会补读。这里要问的是
    // 响应头到达**当场**发没发命令，所以只让事件循环转一圈。
    await new Promise((r) => setTimeout(r, 0))
    expect(f.attempts).toEqual([]) // 响应头 ≠ body 可读，这时一趟 relay 都不该发
    f.finish('r1')
    await pipeline.flush()
    expect(f.attempts).toEqual([{ requestId: 'r1', ok: true }])
    expect(pipeline.items()).toEqual([{ guid: '1', title: 'A' }])
    expect(pipeline.diagnostics()).toEqual([])
    await pipeline.stop()
  })

  it('一条 body 读失败不清空整批——其余照收，失败只留一行诊断', async () => {
    const f = bodyOnlyAfterFinish({ data: { items: [{ id: '2', name: 'B' }] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    f.head('bad')   // 永不完成 → flush 兜底读，仍失败
    f.head('good')
    f.finish('good')
    await pipeline.flush()
    expect(pipeline.items()).toEqual([{ guid: '2', title: 'B' }])
    expect(pipeline.diagnostics()).toEqual([
      'network body unread (response never finished loading): {"code":-32000,"message":"No data found for resource with given identifier"}',
    ])
    await pipeline.stop()
  })

  it('请求夭折就别再兜底读它', async () => {
    const f = bodyOnlyAfterFinish({ data: { items: [] } })
    const pipeline = new NetworkObserverPipeline(f.relay, 7, [observer], output)
    await pipeline.start()
    f.head('gone')
    f.fail('gone')
    await pipeline.flush()
    expect(f.attempts).toEqual([])
    expect(pipeline.diagnostics()).toEqual([])
    await pipeline.stop()
  })
})

describe('ObserverPipeline', () => {
  it('normalizes state object maps and merges local DOM/state observer output', async () => {
    const pipeline = new ObserverPipeline(
      {
        async readItems() { return [{ noteId: 'dom-1', title: 'DOM' }] },
        async readState() { return { a: { noteId: 'state-1', title: 'State' } } },
      } as never,
      [
        { kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { noteId: {}, title: {} }, input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } } },
        { kind: 'state', trigger: 'after-step', statePath: '__STATE__.map', collection: 'values', input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } } },
      ],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } },
    )
    await pipeline.observe('entry')
    await pipeline.observe('after-step')
    expect(pipeline.items()).toEqual([
      { noteId: 'dom-1', title: 'DOM' },
      { noteId: 'state-1', title: 'State' },
    ])
  })

  it('puts an entry observer\'s items BEFORE the network\'s, because the page held them first', async () => {
    // The xhs case: the feed's first batch is SSR'd into the page and never requested, so only an
    // entry-trigger state observer can see it — and those notes come FIRST in the feed. Merged after
    // the network's items, the harvest would hand back the feed's SECOND batch first, silently
    // misordering the ledger that locate and the UI both read as feed order.
    const f = fakeRelay({ data: { items: [{ id: 'x2', name: 'from-xhr' }] } })
    const merged: RecipeOutput = { itemsAt: 'items', dedupeBy: 'guid', targetCount: 10, mapping: { guid: 'guid', title: 'title' } }
    const pipeline = new ObserverPipeline(
      { async readState() { return [{ id: 'x1', name: 'ssr' }] } } as never,
      [
        { kind: 'state', trigger: 'entry', statePath: '__INITIAL_STATE__.feed', input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id', title: 'name' } } },
        { kind: 'network', urlPattern: '*/api/feed*', windowMs: 30_000, maxBodyBytes: 1024, input: { itemsAt: 'data.items', dedupeBy: 'id', targetCount: 10, mapping: { guid: 'id', title: 'name' } } },
      ],
      merged,
      { relay: f.relay, tabId: 7 },
    )
    await pipeline.start()
    await pipeline.observe('entry')
    f.respond('r1', 'https://x.test/api/feed?page=2')
    await pipeline.flush()
    expect(pipeline.items()).toEqual([
      { guid: 'x1', title: 'ssr' },
      { guid: 'x2', title: 'from-xhr' },
    ])
    await pipeline.stop()
  })

  it('fails explicitly when a recipe requests an unavailable read capability', async () => {
    const pipeline = new ObserverPipeline(
      {} as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__STATE__' }],
      { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } },
    )
    await expect(pipeline.observe('entry')).rejects.toThrow(/state read capability/)
  })

  it('polls a declared state observer until its bounded state becomes available', async () => {
    let reads = 0
    const pipeline = new ObserverPipeline(
      { async readState() { return ++reads === 1 ? undefined : { note: { noteId: 'n1', desc: 'ready' } } }, async sleep() {} } as never,
      [{ kind: 'state', trigger: 'after-step', statePath: '__STATE__.detail', collection: 'single', maxWaitMs: 100, pollMs: 0, input: { itemsAt: 'items', dedupeBy: 'note.noteId', targetCount: 1, mapping: { noteId: 'note.noteId', desc: 'note.desc' } } }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'desc' } },
    )
    await pipeline.observe('after-step')
    expect(reads).toBe(2)
    expect(pipeline.items()).toEqual([{ noteId: 'n1', desc: 'ready' }])
  })

  it('injects an object-map key into a declared state item field', async () => {
    const pipeline = new ObserverPipeline(
      { async readState() { return { n1: { note: { desc: 'keyed' } } } } } as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__STATE__.map', collection: 'values', keyField: 'noteId', input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'note.desc' } } }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'desc' } },
    )
    await pipeline.observe('entry')
    expect(pipeline.items()).toEqual([{ noteId: 'n1', desc: 'keyed' }])
  })

  it('filters a values-map state observer to the declared identity param', async () => {
    const pipeline = new ObserverPipeline(
      { async readState() { return { stale: { note: { desc: 'old' } }, n1: { note: { desc: 'fresh' } } } } } as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__STATE__.map', collection: 'values', keyField: 'noteId', identityParam: 'noteId', input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'note.desc' } } }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'desc' } },
      { params: { noteId: 'n1' } },
    )
    await pipeline.observe('entry')
    expect(pipeline.items()).toEqual([{ noteId: 'n1', desc: 'fresh' }])
  })

  it('keeps polling while only non-matching identities are present', async () => {
    let reads = 0
    const pipeline = new ObserverPipeline(
      {
        async readState() {
          reads++
          return reads === 1
            ? { stale: { note: { desc: 'old' } } }
            : { stale: { note: { desc: 'old' } }, n1: { note: { desc: 'fresh' } } }
        },
        async sleep() {},
      } as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__STATE__.map', collection: 'values', keyField: 'noteId', identityParam: 'noteId', maxWaitMs: 100, pollMs: 0, input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'note.desc' } } }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', desc: 'desc' } },
      { params: { noteId: 'n1' } },
    )
    await pipeline.observe('entry')
    expect(reads).toBe(2)
    expect(pipeline.items()).toEqual([{ noteId: 'n1', desc: 'fresh' }])
  })

  it('lets a primary observer win over a fallback observer for the same identity', async () => {
    const pipeline = new ObserverPipeline(
      {
        async readItems() { return [{ noteId: 'n1', title: 'DOM' }, { noteId: 'n2', title: 'DOM-only' }] },
        async readState() { return { n1: { noteId: 'n1', title: 'STATE' } } },
      } as never,
      [
        { kind: 'dom', trigger: 'entry', fallback: true, itemSelector: '.card', fields: { noteId: {}, title: {} }, input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } } },
        { kind: 'state', trigger: 'entry', statePath: '__STATE__.map', collection: 'values', input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } } },
      ],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 10, mapping: { noteId: 'noteId', title: 'title' } },
    )
    await pipeline.observe('entry')
    expect(pipeline.items()).toEqual([
      { noteId: 'n1', title: 'STATE' },
      { noteId: 'n2', title: 'DOM-only' },
    ])
  })

  it('waits for a declared readiness flag before taking the state snapshot', async () => {
    let reads = 0
    const pipeline = new ObserverPipeline(
      {
        async readState() {
          reads++
          // the note lands first; its comment list is still loading for two more polls
          return { n1: { noteId: 'n1', comments: { done: reads >= 3, list: reads >= 3 ? ['a', 'b'] : [] } } }
        },
        async sleep() {},
      } as never,
      [{
        kind: 'state', trigger: 'entry', statePath: '__S__.map', collection: 'values', keyField: 'noteId',
        identityParam: 'noteId', readyWhen: 'comments.done', maxWaitMs: 5000, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', comments: 'comments.list' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId', comments: 'comments' } },
      { params: { noteId: 'n1' } },
    )
    await pipeline.observe('entry')
    expect(reads).toBe(3)
    expect(pipeline.items()).toEqual([{ noteId: 'n1', comments: ['a', 'b'] }])
  })

  it('takes whatever the state holds once the readiness wait times out', async () => {
    const pipeline = new ObserverPipeline(
      {
        async readState() { return { n1: { noteId: 'n1', comments: { done: false, list: [] } } } },
        async sleep() {},
      } as never,
      [{
        kind: 'state', trigger: 'entry', statePath: '__S__.map', collection: 'values', keyField: 'noteId',
        identityParam: 'noteId', readyWhen: 'comments.done', maxWaitMs: 0, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' } },
    )
    await pipeline.observe('entry')
    expect(pipeline.items()).toEqual([{ noteId: 'n1' }]) // degraded, not empty
  })

  it('diagnoses an absent state path distinctly from an identity that never appeared', async () => {
    const absent = new ObserverPipeline(
      { async readState() { return undefined }, async sleep() {} } as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__S__.note.map', collection: 'values', keyField: 'noteId', identityParam: 'noteId' }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' } },
    )
    await absent.observe('entry')
    expect(absent.diagnostics().join(' ')).toMatch(/__S__\.note\.map.*absent/)

    const mismatched = new ObserverPipeline(
      { async readState() { return { other: { noteId: 'other' } } }, async sleep() {} } as never,
      [{ kind: 'state', trigger: 'entry', statePath: '__S__.note.map', collection: 'values', keyField: 'noteId', identityParam: 'noteId' }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' } },
    )
    await mismatched.observe('entry')
    expect(mismatched.diagnostics().join(' ')).toMatch(/n1.*other/)
  })

  it('reports drift when most offered bodies fail their asserts', async () => {
    const pipeline = new ObserverPipeline(
      { async readItems() { return [{ noteId: 'n1' }] } } as never,
      [{ kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { noteId: {} }, input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' }, assert: [{ path: 'items.0.gone', desc: 'card shape' }] } }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
    )
    await pipeline.observe('entry')
    expect(pipeline.items()).toEqual([])
    expect(pipeline.driftReason()).toMatch(/malformed/)
  })
})

/**
 * 一次 `readState` 挂住 = 整个采集挂住（活体 2026-07-27）：渲染进程半死之后
 * `page.evaluate` 永不 resolve，poll 循环走不到下一轮，`maxWaitMs` 这个总上限
 * 形同虚设，运行几分钟不结束、还占着 facility 的 lane 不放。
 * **无界的挂死比一个 502 更坏** —— 502 至少会把 lane 还回来。
 */
describe('ObserverPipeline: a single state read is bounded', () => {
  /** 把被测 promise 关进一个看门狗：没超时就是"有界"，超时就以失败收场（而不是把整个测试套挂死）。 */
  async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
    })
    try {
      return await Promise.race([work, watchdog])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  it('ends the wait when readState never resolves, and says so', async () => {
    // 承重用例：驱动返回一个永不 resolve 的 promise —— 半死渲染进程的忠实模型。
    const pipeline = new ObserverPipeline(
      { readState: () => new Promise<never>(() => {}), async sleep() {} } as never,
      [{
        kind: 'state', trigger: 'after-step', statePath: '__S__.note.map', collection: 'values',
        keyField: 'noteId', identityParam: 'noteId', maxWaitMs: 1500, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' } },
    )
    // **一个数，不是两个。** 这里原来是「看门狗 6000ms」+ 另一条 `elapsed < 4000ms` 的断言，
    // 而被测的 maxWaitMs 是 1500 —— 隔离跑约 1.5s，宽裕得很；但全量跑时几百个文件抢 CPU，
    // 这 1.5s 的等待被拉过 4s 就红，于是它成了一条只在并行负载下随机失败的用例
    // （2026-07-29 实测：隔离 25 次 0 失败，全量偶发）。
    //
    // 注入时钟修不了它：这里量的是 `await` 前后的**真实**墙钟，里面本来就包含被抢走的 CPU
    // 时间；改成读注入的时钟，断言就退化成"验算了一下减法"，不再证明它真的返回了。
    //
    // 所以合并成一个界，并且给足余量。**它证明的东西一点没少**：这条用例的承重claim 是
    // 「挂死的 readState 不会永远挂着」，而任何一次 settle 都证明了它；界只是顺带说一句
    // "而且是按 maxWaitMs 收的，不是拖到天荒地老"。
    await settlesWithin(pipeline.observe('after-step'), 5000)
    // 挂死和"这个 state 压根不存在"是两码事，别把前者报成后者
    expect(pipeline.diagnostics().join(' ')).toMatch(/timed out/)
  })

  it('does not falsely time out a slow-but-alive read', async () => {
    const pipeline = new ObserverPipeline(
      {
        readState: () => new Promise((resolve) => setTimeout(() => resolve({ n1: { noteId: 'n1' } }), 60)),
        async sleep() {},
      } as never,
      [{
        kind: 'state', trigger: 'entry', statePath: '__S__.note.map', collection: 'values',
        keyField: 'noteId', identityParam: 'noteId', maxWaitMs: 3000, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' } },
    )
    await settlesWithin(pipeline.observe('entry'), 6000)
    expect(pipeline.items()).toEqual([{ noteId: 'n1' }])
    expect(pipeline.diagnostics()).toEqual([])
  })

  /**
   * 虚拟时钟：铃一响就把钟往前拨 `ms`，此外一秒都不走。
   *
   * 为什么不能用真钟：被测语义是「读超时结束的是**这一次读**，不是整轮等待」，而真钟下这条
   * 判据实际依赖的是"读超时 + 一次重试塞得进 maxWaitMs 的墙钟余量"——机器被全量并行压满时
   * 这个余量不成立，`reads` 停在 1（2026-08-23 实测偶发红）。虚拟钟让预算只被**声明的**
   * 超时消耗，判据回到它真正想钉的那件事上。
   *
   * 铃走 macrotask、已 resolve 的读走 microtask，所以"读先返回"这一侧的胜负也是确定的。
   */
  function virtualClock(): ReadClock {
    let t = 0
    return {
      now: () => t,
      bell: (ms) => ({
        rang: new Promise<void>((resolve) => setTimeout(() => { t += ms; resolve() }, 0)),
        cancel() {},
      }),
    }
  }

  /**
   * state 等待是一次运行里最长的一段（xhs-detail 声明 15s）。没人要这个结果之后还把它等完，
   * 就等于让被放弃的那次继续占着 facility 的串行 lane——用户想看的下一条只能排在后面。
   */
  it('stops waiting once the caller has given up — the abandoned run must not hold the lane', async () => {
    const controller = new AbortController()
    let reads = 0
    const pipeline = new ObserverPipeline(
      {
        readState: () => { reads++; controller.abort(); return Promise.resolve({}) },
        async sleep() {},
      } as never,
      [{
        kind: 'state', trigger: 'after-step', statePath: '__S__.note.map', collection: 'values',
        keyField: 'noteId', identityParam: 'noteId', maxWaitMs: 60_000, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' }, signal: controller.signal },
    )
    // 判据是"它抛了、而且没有把 60s 预算等完"，不是抛的哪一句：runner 靠这个异常把整轮判成 cancelled。
    await expect(settlesWithin(pipeline.observe('after-step'), 5000)).rejects.toThrow(/cancelled/)
    expect(reads).toBe(1)
  })

  it('keeps polling after a read times out — the timeout ends the READ, not the wait', async () => {
    let reads = 0
    const pipeline = new ObserverPipeline(
      {
        readState: () => {
          reads++
          // 第一次读挂死；页面随后缓过来，第二次读就该拿到数据
          return reads === 1 ? new Promise<never>(() => {}) : Promise.resolve({ n1: { noteId: 'n1' } })
        },
        async sleep() {},
      } as never,
      [{
        kind: 'state', trigger: 'after-step', statePath: '__S__.note.map', collection: 'values',
        keyField: 'noteId', identityParam: 'noteId', maxWaitMs: 3000, pollMs: 0,
        input: { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      }],
      { itemsAt: 'items', dedupeBy: 'noteId', targetCount: 1, mapping: { noteId: 'noteId' } },
      { params: { noteId: 'n1' }, clock: virtualClock() },
    )
    await settlesWithin(pipeline.observe('after-step'), 6000)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(pipeline.items()).toEqual([{ noteId: 'n1' }])
  })
})
