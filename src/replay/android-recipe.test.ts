import { describe, expect, it } from 'vitest'
import { validateRecipe } from './recipe-store.ts'
import { needsBrowser, type Recipe } from './recipe.ts'

function recipe(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'android',
    sourceId: 'android-demo',
    app: { package: 'com.example.app' },
    steps: [{ kind: 'openApp' }],
    ...over,
  }
}

const validate = (over: Record<string, unknown> = {}) => validateRecipe('android-demo', recipe(over)) as Recipe

describe('kind:android recipe validation', () => {
  it('accepts a recipe with locator-only steps and entry / exit feature sets', () => {
    const r = validate({
      entry: { features: [{ kind: 'android-window', package: 'com.example.app' }] },
      steps: [
        { kind: 'openApp' },
        { kind: 'tap', target: { text: '搜索' }, expect: { features: [{ kind: 'a11y', query: { role: 'EditText' } }] } },
        { kind: 'type', text: '{query}' },
        { kind: 'longPress', target: { resourceId: 'com.example:id/row' }, durationMs: 800 },
        { kind: 'swipe', from: { text: 'A' }, to: { query: { role: 'Button', name: 'B' } }, durationMs: 300 },
        { kind: 'scroll', dir: 'down', until: '更多' },
        { kind: 'setText', target: { resourceId: 'com.example:id/search' }, text: '咖啡' },
        { kind: 'press', key: 'Back' },
        { kind: 'sleep', ms: 100 },
      ],
      exit: { features: [{ kind: 'text', text: '咖啡 结果' }] },
    })
    expect(r.kind).toBe('android')
    expect(needsBrowser(r)).toBe(false)
  })

  it('requires an app identifier (one name or a non-empty candidate list)', () => {
    expect(() => validate({ app: {} })).toThrow(/app\.(id|package)/)
    expect(() => validate({ app: { package: [] } })).toThrow(/app\.(id|package)/)
    expect(() => validate({ app: { package: ['ok', ''] } })).toThrow(/app\.(id|package)/)
    expect(() => validate({ app: { package: ['com.example.app', 'com.example.app.debug'] } })).not.toThrow()
  })

  // The same recipe kind drives a phone, whichever phone it is: an Android package name and an
  // iOS bundle id are both just "the app's identifier on the device".
  it('accepts a neutral app identifier and keeps the legacy app.package spelling', () => {
    expect(() => validate({ app: { id: 'com.example.app' } })).not.toThrow()
    expect(() => validate({ app: { id: ['com.example.app', 'com.example.app.debug'] } })).not.toThrow()
    expect(() => validate({ app: { id: [] } })).toThrow(/app\.id/)
    expect(() => validate({ app: { id: ['ok', ''] } })).toThrow(/app\.id/)
    expect(() => validate({ app: { id: 'com.example.app', package: 'com.example.app' } })).toThrow(/只能给一个/)
  })

  it('openApp takes the neutral identifier too, with the same one-spelling rule', () => {
    expect(() => validate({ steps: [{ kind: 'openApp', id: 'com.example.app' }] })).not.toThrow()
    expect(() => validate({ steps: [{ kind: 'openApp', package: 'com.example.app' }] })).not.toThrow()
    expect(() => validate({ steps: [{ kind: 'openApp', id: [''] }] })).toThrow(/id/)
    expect(() => validate({ steps: [{ kind: 'openApp', id: 'a', package: 'b' }] })).toThrow(/只能给一个/)
  })

  it('rejects bare coordinates in a target', () => {
    expect(() => validate({ steps: [{ kind: 'tap', target: { x: 540, y: 1200 } }] })).toThrow(/坐标|x/)
    expect(() => validate({ steps: [{ kind: 'tap', target: { text: '搜索', x: 1 } }] })).toThrow(/坐标|x/)
    expect(() => validate({ steps: [{ kind: 'tap', target: { text: '搜索' }, at: { x: 1, y: 2 } }] })).toThrow(/坐标|x|at/)
  })

  it('rejects a swipe written as points', () => {
    expect(() =>
      validate({ steps: [{ kind: 'swipe', from: { x: 540, y: 1800 }, to: { x: 540, y: 600 } }] }),
    ).toThrow(/坐标|x/)
  })

  it('requires exactly one locator form and no unknown keys', () => {
    expect(() => validate({ steps: [{ kind: 'tap', target: {} }] })).toThrow(/target/)
    expect(() =>
      validate({ steps: [{ kind: 'tap', target: { text: '搜索', query: { role: 'Button' } } }] }),
    ).toThrow(/只能给一个/)
    expect(() => validate({ steps: [{ kind: 'tap', target: { text: '搜索', rect: { x: 0, y: 0 } } }] })).toThrow(/rect|坐标/)
  })

  it('rejects unknown step kinds and unsupported press keys', () => {
    expect(() => validate({ steps: [{ kind: 'clik' }] })).toThrow(/kind/)
    expect(() => validate({ steps: [{ kind: 'press', key: 'Escape' }] })).toThrow(/key/)
  })

  it('validates scroll arguments', () => {
    expect(() => validate({ steps: [{ kind: 'scroll', dir: 'sideways' }] })).toThrow(/dir/)
    expect(() => validate({ steps: [{ kind: 'scroll', dir: 'down' }] })).toThrow(/amount|until/)
    expect(() => validate({ steps: [{ kind: 'scroll', dir: 'down', amount: 3, until: 'x' }] })).toThrow(/只能给一个/)
    expect(() => validate({ steps: [{ kind: 'scroll', dir: 'down', amount: 11 }] })).toThrow(/amount/)
  })

  it('rejects an empty step list', () => {
    expect(() => validate({ steps: [] })).toThrow(/steps/)
  })

  it('validates entry / exit feature sets and only Android feature kinds', () => {
    expect(() => validate({ entry: { features: [] } })).toThrow(/features/)
    expect(() => validate({ exit: { features: [{ kind: 'dom', selector: '.x' }] } })).toThrow(/dom/)
    expect(() => validate({ entry: { features: [{ kind: 'image', png: 'AA==' }] } })).toThrow(/image/)
    expect(() => validate({ exit: { features: [{ kind: 'url', pattern: 'https://*' }] } })).toThrow(/url/)
  })

  it('rejects an expect feature set Android cannot evaluate', () => {
    expect(() =>
      validate({ steps: [{ kind: 'tap', target: { text: '搜索' }, expect: { features: [{ kind: 'dom', selector: '.x' }] } }] }),
    ).toThrow(/dom/)
    expect(() =>
      validate({ steps: [{ kind: 'tap', target: { text: '搜索' }, expect: { features: [] } }] }),
    ).toThrow(/features/)
  })

  it('validates long press / swipe durations', () => {
    expect(() => validate({ steps: [{ kind: 'longPress', target: { text: 'x' }, durationMs: 0 }] })).toThrow(/durationMs/)
    expect(() =>
      validate({ steps: [{ kind: 'swipe', from: { text: 'a' }, to: { text: 'b' }, durationMs: -1 }] }),
    ).toThrow(/durationMs/)
  })

  it('rejects a query with both name and nameContains', () => {
    expect(() =>
      validate({ steps: [{ kind: 'tap', target: { query: { name: 'A', nameContains: 'B' } } }] }),
    ).toThrow(/nameContains/)
  })
})
