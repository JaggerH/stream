import { describe, it, expect } from 'vitest'
import { assertHostVersion } from './host-version.ts'

describe('assertHostVersion', () => {
  it('passes when no range is declared', () => {
    expect(() => assertHostVersion(undefined, '0.0.1', 'pkg')).not.toThrow()
  })

  it('passes when the host is newer', () => {
    expect(() => assertHostVersion('>=0.0.1', '0.1.0', 'pkg')).not.toThrow()
    expect(() => assertHostVersion('>=1.2.3', '1.2.3', 'pkg')).not.toThrow()
    expect(() => assertHostVersion('>=1.2.3', '1.10.0', 'pkg')).not.toThrow()  // 10 > 2，不是字符串比较
  })

  it('refuses when the host is older, naming both versions', () => {
    expect(() => assertHostVersion('>=0.9.0', '0.0.1', 'demo-pkg')).toThrow(/demo-pkg/)
    expect(() => assertHostVersion('>=0.9.0', '0.0.1', 'demo-pkg')).toThrow(/0\.9\.0/)
    expect(() => assertHostVersion('>=0.9.0', '0.0.1', 'demo-pkg')).toThrow(/0\.0\.1/)
  })

  it('refuses a form it does not support, saying which form is supported', () => {
    for (const bad of ['^1.0.0', '~1.0.0', '1.x', '>1.0.0', '>=1.0', 'latest']) {
      expect(() => assertHostVersion(bad, '1.0.0', 'pkg')).toThrow(/>=/)
    }
  })

  it('tolerates surrounding whitespace', () => {
    expect(() => assertHostVersion('  >= 1.0.0 ', '1.0.0', 'pkg')).not.toThrow()
  })

  // 宿主版本可能读不到（打包产物里源码那条相对路径指不到 package.json）。那时闸门 fail-closed：
  // 拒装声明了 hostVersion 的包，而不是当它通过——「跳过」等于这道闸门静默失效。
  it('refuses a declared range when the host version is unknown', () => {
    expect(() => assertHostVersion('>=1.0.0', undefined, 'demo-pkg')).toThrow(/宿主版本/)
    expect(() => assertHostVersion('>=1.0.0', undefined, 'demo-pkg')).toThrow(/demo-pkg/)
  })

  it('passes when neither side declares anything', () => {
    expect(() => assertHostVersion(undefined, undefined, 'pkg')).not.toThrow()
  })
})
