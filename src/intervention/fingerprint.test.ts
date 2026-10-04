import { describe, it, expect } from 'vitest'
import { sceneFingerprint, cacheKey } from './fingerprint.ts'

describe('fingerprint', () => {
  it('同 url 路径 + 同 truths + 同元素名集合 → 同指纹；query 不同不影响；元素多一个就变', () => {
    const base = { side: 'browser' as const, url: 'https://x.com/s?q=1', elements: [{ name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } }] }
    const a = sceneFingerprint(base, ['dom:.a'])
    const b = sceneFingerprint({ ...base, url: 'https://x.com/s?q=2' }, ['dom:.a'])
    const c = sceneFingerprint({ ...base, elements: [...base.elements, { name: '登录', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, ['dom:.a'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
  it('没有现场也能出指纹（只靠 truths）', () => {
    expect(sceneFingerprint(undefined, ['dom:.a'])).toMatch(/^[0-9a-f]{16}$/)
  })
  it('cacheKey 把三样拼起来', () => {
    expect(cacheKey('a/b', 'state', 'deadbeef')).toBe('a/b|state|deadbeef')
  })
  it('两个元素名 ["登录","注册"] 与单个元素名 "登录 注册" 指纹不同——分隔符不能是空格', () => {
    const base = { side: 'browser' as const, url: 'https://x.com/s' }
    const two = sceneFingerprint(
      { ...base, elements: [{ name: '登录', rect: { x: 0, y: 0, w: 1, h: 1 } }, { name: '注册', rect: { x: 0, y: 0, w: 1, h: 1 } }] },
      [],
    )
    const one = sceneFingerprint({ ...base, elements: [{ name: '登录 注册', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, [])
    expect(two).not.toBe(one)
  })
})
