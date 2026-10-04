// 布局是**视图偏好**不是频道配置——它描述"我这块屏幕现在想怎么看",随窗口宽度和手头的事
// 随时改,所以存 localStorage 不占后端契约。默认值由 present 推:搜索天生要密。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { defaultLayoutFor, readLayout, writeLayout, LAYOUT_STORAGE_PREFIX } from './layoutPref.ts'

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('defaultLayoutFor', () => {
  it('搜索默认瀑布流,其余默认列表', () => {
    expect(defaultLayoutFor('search')).toBe('waterfall')
    expect(defaultLayoutFor('timeline')).toBe('list')
    expect(defaultLayoutFor(undefined)).toBe('list')
  })
})

describe('readLayout / writeLayout', () => {
  it('写了就读得回来', () => {
    writeLayout('c1', 'waterfall')
    expect(readLayout('c1', 'timeline')).toBe('waterfall')
    expect(window.localStorage.getItem(`${LAYOUT_STORAGE_PREFIX}c1`)).toBe('waterfall')
  })

  it('按频道各存各的', () => {
    writeLayout('c1', 'waterfall')
    expect(readLayout('c2', 'timeline')).toBe('list')
  })

  it('没存过就回落到 present 的默认值', () => {
    expect(readLayout('__content_search__', 'search')).toBe('waterfall')
  })

  it('存着的是垃圾值也回落到默认值', () => {
    window.localStorage.setItem(`${LAYOUT_STORAGE_PREFIX}c1`, 'grid')
    expect(readLayout('c1', 'search')).toBe('waterfall')
  })

  it('localStorage 抛异常(隐私模式)时读回默认值、写不炸', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(readLayout('c1', 'search')).toBe('waterfall')
    expect(() => writeLayout('c1', 'list')).not.toThrow()
  })
})
