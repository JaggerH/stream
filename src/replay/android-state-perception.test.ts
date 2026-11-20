import { describe, expect, it } from 'vitest'
import {
  AndroidPerception,
  type AndroidElement,
  type AndroidProbe,
  type AndroidScreen,
} from './android-state-perception.ts'
import { classifyWithPerception } from './state-classify.ts'
import { checkDiscriminative, featureKey, type StateDef } from './state-graph.ts'

const rect = (x: number, y: number, w = 200, h = 80) => ({ x, y, w, h })

function element(over: Partial<AndroidElement>): AndroidElement {
  return { ref: 'n1', role: 'Button', name: '', className: 'android.widget.Button', rect: rect(0, 0), ...over }
}

const screen = (over: Partial<AndroidScreen> = {}): AndroidScreen => ({
  elements: [
    element({ ref: 'n1', role: 'Button', name: '搜索', viewId: 'com.example:id/search', rect: rect(100, 200) }),
    element({ ref: 'n2', role: 'TextView', name: '购物车', rect: rect(100, 400) }),
    element({ ref: 'n3', role: 'ocr-text', name: '确认订单', source: 'ocr', className: 'ocr', rect: rect(100, 800) }),
  ],
  viewport: { width: 1080, height: 2400 },
  foreground: { package: 'com.example.shop', activity: 'com.example.shop/.CheckoutActivity', title: '结算' },
  ...over,
})

function fakeProbe(s: AndroidScreen = screen()) {
  let reads = 0
  const modes: string[] = []
  const probe: AndroidProbe = {
    async read(opts) {
      reads += 1
      modes.push(opts?.ocr ?? 'auto')
      return s
    },
    async snapshot() {
      return { foreground: s.foreground, elements: s.elements.map((e) => ({ role: e.role, name: e.name, rect: e.rect })) }
    },
  }
  return { probe, reads: () => reads, modes }
}

const state = (id: string, features: StateDef['features'], group?: string): StateDef => ({ id, features, group })

describe('Android state perception', () => {
  it('judges a11y (including resourceId), OCR text and the foreground window in one read', async () => {
    const { probe, reads, modes } = fakeProbe()
    const p = new AndroidPerception(probe)
    const r = await p.identify([
      state('shop/cart', [
        { kind: 'android-window', package: 'com.example.shop', activity: 'CheckoutActivity', title: '结算' },
        { kind: 'a11y', query: { viewId: 'com.example:id/search' } },
        { kind: 'text', text: '确认订单' },
      ]),
    ])
    expect(r).toEqual({ states: ['shop/cart'], matched: expect.any(Array) })
    expect(reads()).toBe(1)
    expect(modes).toEqual(['on'])
  })

  it('does not run the OCR tier when no text feature is asked for', async () => {
    const { probe, modes } = fakeProbe()
    await new AndroidPerception(probe).identify([state('shop/cart', [{ kind: 'a11y', query: { role: 'Button', name: '搜索' } }])])
    expect(modes).toEqual(['off'])
  })

  it('honours absent on a11y and window features', async () => {
    const { probe } = fakeProbe()
    const p = new AndroidPerception(probe)
    const r = await p.identify([
      state('shop/login', [
        { kind: 'a11y', query: { role: 'Button', name: '登录' }, absent: true },
        { kind: 'android-window', package: 'com.example.other', absent: true },
        { kind: 'text', text: '不存在的字', absent: true },
      ]),
    ])
    expect(r.states).toEqual(['shop/login'])
  })

  it('narrows a text feature with its where anchor', async () => {
    const { probe } = fakeProbe(
      screen({
        elements: [
          element({ ref: 'a1', role: 'TextView', name: '张三', rect: rect(50, 100) }),
          element({ ref: 'a2', role: 'TextView', name: '发送', rect: rect(800, 100) }),
          element({ ref: 'a3', role: 'TextView', name: '发送', rect: rect(800, 900) }),
        ],
      }),
    )
    const p = new AndroidPerception(probe)
    const hit = await p.identify([
      state('chat/compose', [
        { kind: 'text', text: '发送', where: { anchor: { text: '张三' }, side: 'right', maxDist: 8 } },
      ]),
    ])
    expect(hit.states).toEqual(['chat/compose'])
    const miss = await p.identify([
      state('chat/other', [
        { kind: 'text', text: '发送', where: { anchor: { text: '张三' }, side: 'left', maxDist: 8 } },
      ]),
    ])
    expect(miss).toEqual({ states: null, reason: 'no-match', candidates: [] })
  })

  it('reports a same-group collision instead of picking one', async () => {
    const { probe } = fakeProbe()
    const r = await new AndroidPerception(probe).identify([
      state('shop/a', [{ kind: 'a11y', query: { role: 'Button' } }], 'shop/screen'),
      state('shop/b', [{ kind: 'android-window', package: 'com.example.shop' }], 'shop/screen'),
    ])
    expect(r).toEqual({ states: null, reason: 'ambiguous', candidates: ['shop/a', 'shop/b'] })
  })

  it('rejects feature kinds Android cannot evaluate instead of treating them as false', async () => {
    const { probe } = fakeProbe()
    await expect(
      new AndroidPerception(probe).identify([state('shop/dom', [{ kind: 'dom', selector: '.x' }])]),
    ).rejects.toThrow(/dom/)
  })

  it('gives classifyWithPerception the same verdicts and observation ledger hooks as the browser path', async () => {
    const { probe } = fakeProbe()
    const observed: Array<{ state: string; truths: string[] }> = []
    const graph = {
      states: [state('shop/checkout', [{ kind: 'text', text: '确认订单' }])],
      transitions: [],
    }
    const verdict = await classifyWithPerception(new AndroidPerception(probe), graph, (o) => observed.push(o))
    expect(verdict).toEqual({ kind: 'identified', states: ['shop/checkout'] })
    expect(observed).toHaveLength(1)
    expect(observed[0].truths).toContain(featureKey({ kind: 'text', text: '确认订单' }))
  })

  it('classifies an empty graph as unknown without reading the screen', async () => {
    const { probe, reads } = fakeProbe()
    const verdict = await classifyWithPerception(new AndroidPerception(probe), { states: [], transitions: [] })
    expect(verdict).toEqual({ kind: 'unknown' })
    expect(reads()).toBe(0)
  })

  it('gives android-window features a stable, distinct key', () => {
    const a = featureKey({ kind: 'android-window', package: 'com.example.a', activity: 'Main' })
    const b = featureKey({ kind: 'android-window', package: 'com.example.b', activity: 'Main' })
    expect(a).not.toBe(b)
    expect(a).toContain('android-window')
  })

  it('feeds checkDiscriminative with Android observations', () => {
    const candidate = state('shop/checkout', [{ kind: 'text', text: '确认订单' }])
    const other = state('shop/other', [{ kind: 'text', text: '确认订单' }])
    const observations = [{ state: 'shop/other', truths: [featureKey({ kind: 'text', text: '确认订单' })] }]
    expect(checkDiscriminative(candidate, [candidate, other], observations)).toEqual({
      ok: false,
      collidesWith: ['shop/other'],
    })
  })
})
