import { describe, it, expect } from 'vitest'
import { compareVersions, isStrictlyHigher, parseVersion } from './semver.ts'

describe('compareVersions（两层同名包「谁高」的唯一尺子）', () => {
  it('三段数字逐段比，按数值不按字典序', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)   // 字典序会判反
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.0.1', '0.1.0')).toBeLessThan(0)
  })

  it('同核心版本：正式版 > 预发布；两个预发布按字符串比', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
    // 预发布不会把核心版本的高低翻过来
    expect(compareVersions('1.1.0-alpha', '1.0.0')).toBeGreaterThan(0)
  })

  it('缺失 / 不合法 → null（不是 0、不是"更低"）', () => {
    expect(compareVersions(undefined, '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', undefined)).toBeNull()
    expect(compareVersions(null, null)).toBeNull()
    expect(compareVersions('v1.0.0', '1.0.0')).toBeNull()      // v 前缀
    expect(compareVersions('1.2', '1.0.0')).toBeNull()         // 两段
    expect(compareVersions('^1.0.0', '1.0.0')).toBeNull()      // 范围
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBeNull() // build 元数据不受理
    expect(compareVersions('latest', '1.0.0')).toBeNull()
    expect(compareVersions(' 1.0.0', '1.0.0')).toBeNull()      // 不 trim：字面值就该是干净的
  })

  it('parseVersion 拆出核心与预发布', () => {
    expect(parseVersion('1.2.3-rc.1')).toEqual({ core: [1, 2, 3], prerelease: 'rc.1' })
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], prerelease: undefined })
    expect(parseVersion('nope')).toBeNull()
  })
})

describe('isStrictlyHigher（调用方用的那一问：用户层能不能赢）', () => {
  it('只有严格更高才 true', () => {
    expect(isStrictlyHigher('1.0.1', '1.0.0')).toBe(true)
    expect(isStrictlyHigher('1.0.0', '1.0.0')).toBe(false)
    expect(isStrictlyHigher('0.9.9', '1.0.0')).toBe(false)
  })
  it('看不懂的版本号不许赢：任一侧不合法 → false', () => {
    expect(isStrictlyHigher(undefined, '1.0.0')).toBe(false)
    expect(isStrictlyHigher('9.9.9', undefined)).toBe(false)
    expect(isStrictlyHigher('v9.9.9', '1.0.0')).toBe(false)
  })
})
