import { describe, expect, it } from 'vitest'
import { makeAndroidDriver, type AndroidOps } from './android-driver.ts'
import { runAndroidRecipe } from './android-runner.ts'
import type { AndroidRecipe } from './android-recipe.ts'
import type { StateGraph } from './state-graph.ts'

interface FakeElement {
  ref: string
  role: string
  name: string
  className: string
  rect: { x: number; y: number; w: number; h: number }
  viewId?: string
  source?: 'a11y' | 'ocr'
}

interface FakeScreen {
  stage: 'home' | 'input' | 'results'
  elements: FakeElement[]
}

const R = (x: number, y: number, w = 200, h = 80) => ({ x, y, w, h })

function element(over: Partial<FakeElement> & Pick<FakeElement, 'ref' | 'name'>): FakeElement {
  return { role: 'Button', className: 'android.widget.Button', rect: R(0, 0), ...over }
}

function device(opts: { renamed?: boolean; duplicateSearch?: boolean } = {}) {
  const calls: Array<{ op: string; args?: Record<string, unknown> }> = []
  let stage: FakeScreen['stage'] = 'home'
  const typed: string[] = []
  const searchName = opts.renamed ? '查找' : '搜索'
  const screens = (): FakeScreen => {
    if (stage === 'home') {
      return {
        stage,
        elements: [
          element({ ref: 'n1', name: searchName, rect: R(100, 200) }),
          ...(opts.duplicateSearch ? [element({ ref: 'n2', name: searchName, rect: R(100, 400) })] : []),
        ],
      }
    }
    if (stage === 'input') {
      return {
        stage,
        elements: [
          element({ ref: 'n3', role: 'EditText', className: 'android.widget.EditText', name: '搜索框', viewId: 'com.example:id/search', rect: R(100, 100) }),
          element({ ref: 'n4', name: '搜索', rect: R(900, 100) }),
        ],
      }
    }
    return { stage, elements: [element({ ref: 'n5', role: 'TextView', className: 'android.widget.TextView', name: '咖啡 结果', rect: R(100, 300) })] }
  }
  const match = (e: FakeElement, q: Record<string, unknown>) => {
    if (typeof q.role === 'string' && e.role !== q.role) return false
    if (typeof q.name === 'string' && e.name !== q.name) return false
    if (typeof q.nameContains === 'string' && !e.name.toLowerCase().includes(q.nameContains.toLowerCase())) return false
    if (typeof q.viewId === 'string' && e.viewId !== q.viewId) return false
    return true
  }
  const ops: AndroidOps = async (op, args = {}) => {
    calls.push({ op, args })
    switch (op) {
      case 'focusApp':
        stage = 'home'
        return { ok: true }
      case 'find': {
        const q = (args.query ?? {}) as Record<string, unknown>
        return { elements: screens().elements.filter((e) => match(e, q)), viewport: { width: 1080, height: 2400 } }
      }
      case 'click': {
        const r = args.rect as { x: number; y: number; w: number; h: number }
        const cx = r.x + r.w / 2
        const cy = r.y + r.h / 2
        const hit = screens().elements.find((e) => cx >= e.rect.x && cx < e.rect.x + e.rect.w && cy >= e.rect.y && cy < e.rect.y + e.rect.h)
        if (hit && (hit.name === '搜索' || hit.name === '查找')) stage = stage === 'home' ? 'input' : 'results'
        return { via: 'coords', settled: true }
      }
      case 'type':
        typed.push(String(args.text))
        return { via: 'value', settled: true }
      case 'windows':
        return [{ id: '1', process: 'com.example.app', title: '示例', foreground: true, viewport: { width: 1080, height: 2400 } }]
      case 'url':
        return 'com.example.app/.Home'
      case 'screenshot':
        return { base64: Buffer.from('jpeg').toString('base64') }
      default:
        return {}
    }
  }
  return { calls, ops, typed }
}

const recipe = (over: Partial<AndroidRecipe> = {}): AndroidRecipe => ({
  version: 1,
  kind: 'android',
  sourceId: 'android-e2e',
  app: { package: ['com.example.app', 'com.example.app.debug'] },
  entry: { features: [{ kind: 'android-window', package: 'com.example.app', activity: 'Home' }] },
  steps: [
    { kind: 'openApp' },
    { kind: 'tap', target: { text: '搜索' }, label: '打开搜索' },
    { kind: 'type', text: '{query}', label: '输入关键词' },
    { kind: 'tap', target: { text: '搜索' }, label: '提交搜索' },
  ],
  exit: { features: [{ kind: 'text', text: '咖啡 结果' }] },
  ...over,
})

const graph: StateGraph = {
  states: [{ id: 'example/login', features: [{ kind: 'text', text: '登录' }] }],
  transitions: [],
}

describe('android recipe runner over injected ops', () => {
  it('runs a four-step recipe on a fake device', async () => {
    const dev = device()
    const out = await runAndroidRecipe(recipe(), { query: '咖啡' }, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('ok')
    expect(out.steps).toBe(4)
    expect(dev.typed).toEqual(['咖啡'])
    expect(dev.calls.map((c) => c.op)).toEqual([
      'focusApp', 'scopeWindow',
      'find', 'windows', 'url',
      'find', 'click', 'type', 'find', 'click',
      'find', 'windows', 'url',
    ])
  })

  it('opens the app by its neutral identifier, trying a candidate list in order', async () => {
    const dev = device()
    const r = recipe({ app: { id: ['com.example.ios', 'com.example.ios.debug'] } })
    const out = await runAndroidRecipe(r, { query: '咖啡' }, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('ok')
    const opened = dev.calls.filter((c) => c.op === 'focusApp').map((c) => (c.args?.match as { process: string }).process)
    expect(opened).toEqual(['com.example.ios'])
  })

  it('an openApp step identifier overrides the recipe default', async () => {
    const dev = device()
    const steps = recipe().steps.slice()
    steps[0] = { kind: 'openApp', id: 'com.example.other' }
    const out = await runAndroidRecipe(recipe({ steps }), { query: '咖啡' }, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('ok')
    expect((dev.calls.find((c) => c.op === 'focusApp')!.args?.match as { process: string }).process).toBe('com.example.other')
  })

  it('returns drift with an unknown classification and a readable scene after a control is renamed', async () => {
    const dev = device({ renamed: true })
    const out = await runAndroidRecipe(recipe(), { query: '咖啡' }, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('drift')
    expect(out.reason).toMatch(/打开搜索|搜索/)
    expect(out.state).toEqual({ kind: 'unknown' })
    expect(out.scene?.foreground).toMatchObject({ package: 'com.example.app', activity: '.Home' })
    expect(out.scene?.elements.map((e) => e.name)).toContain('查找')
  })

  it('treats an expect miss as a drift, not as success', async () => {
    const dev = device()
    const r = recipe({
      steps: [
        { kind: 'openApp' },
        { kind: 'tap', target: { text: '搜索' }, label: '打开搜索', expect: { features: [{ kind: 'text', text: '不该出现的字' }], timeoutMs: 30 } },
      ],
      exit: undefined,
    })
    const out = await runAndroidRecipe(r, {}, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('drift')
    expect(out.reason).toMatch(/expect|不该出现/)
    expect(out.state).toEqual({ kind: 'unknown' })
  })

  it('refuses to tap when a locator is ambiguous', async () => {
    const dev = device({ duplicateSearch: true })
    const out = await runAndroidRecipe(recipe(), { query: '咖啡' }, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('drift')
    expect(out.reason).toMatch(/ambiguous|两个|多处/)
    expect(dev.calls.filter((c) => c.op === 'click')).toHaveLength(0)
  })

  it('skips an optional step whose target is gone', async () => {
    const dev = device({ renamed: true })
    const r = recipe({
      steps: [
        { kind: 'openApp' },
        { kind: 'tap', target: { text: '搜索' }, label: '可选的旧入口', optional: true },
      ],
      exit: { features: [{ kind: 'text', text: '咖啡 结果' }] },
    })
    // Optional skip is not an exit success: the fake device stays on home, so exit misses.
    const out = await runAndroidRecipe(r, {}, makeAndroidDriver(dev.ops), { stateGraph: graph })
    expect(out.outcome).toBe('drift')
    expect(out.reason).toMatch(/exit|退出/)
  })

  it('records recognized states through onObserved when a failure is classified', async () => {
    const dev = device({ renamed: true })
    const observed: string[] = []
    const out = await runAndroidRecipe(recipe(), { query: '咖啡' }, makeAndroidDriver(dev.ops), {
      stateGraph: { states: [{ id: 'example/home', features: [{ kind: 'a11y', query: { name: '查找' } }] }], transitions: [] },
      onObserved: (o) => observed.push(o.state),
    })
    expect(out.outcome).toBe('drift')
    expect(out.state).toEqual({ kind: 'identified', states: ['example/home'] })
    expect(observed).toEqual(['example/home'])
  })
})
