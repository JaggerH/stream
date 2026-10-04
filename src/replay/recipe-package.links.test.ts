import { describe, it, expect } from 'vitest'
import { linkTableOf } from './recipe-package.ts'
import type { LinksDeclaration } from '../packages/links.ts'

const links = (platform: string, ...hosts: string[]): LinksDeclaration => ({
  hosts: hosts.map((host) => ({ host, platform })),
  shortHosts: [],
  patterns: [],
})

describe('linkTableOf —— 各包的 links 并成一张认领表', () => {
  it('不撞 → 各包一条 entry，声明序；没声明 links 的包不出现', () => {
    const t = linkTableOf([
      { facility: 'a', name: '@x/a', links: links('a', 'a-site.com') },
      { facility: 'n' },
      { facility: 'b', links: links('b', 'b-site.com', 'b.short') },
    ])
    expect(t.entries.map((e) => e.package)).toEqual(['@x/a', 'b'])
    expect(t.entries[1].hosts.map((h) => h.host)).toEqual(['b-site.com', 'b.short'])
    expect(t.rejected).toEqual([])
  })

  it('撞主机 → 后来那个包整份拒，点名撞了谁', () => {
    const t = linkTableOf([
      { facility: 'a', name: '@x/a', links: links('a', 'same.com') },
      { facility: 'b', name: '@x/b', links: links('b', 'b-own.com', 'same.com') },
    ])
    expect(t.entries.map((e) => e.package)).toEqual(['@x/a'])
    expect(t.rejected).toEqual([{ package: '@x/b', reason: '主机 same.com 已归 @x/a' }])
  })

  it('撞平台 → 后来那个包整份拒', () => {
    const t = linkTableOf([
      { facility: 'a', links: links('p', 'a-site.com') },
      { facility: 'b', links: links('p', 'b-site.com') },
    ])
    expect(t.entries.map((e) => e.package)).toEqual(['a'])
    expect(t.rejected[0]).toMatchObject({ package: 'b', reason: expect.stringContaining('平台 p') })
  })

  it('同一个包里多个主机同平台、一包两平台都不算撞', () => {
    const t = linkTableOf([{
      facility: 'x',
      links: { hosts: [{ host: 'p1.com', platform: 'p1' }, { host: 'p1b.com', platform: 'p1' }, { host: 'p2.com', platform: 'p2' }], shortHosts: [], patterns: [] },
    }])
    expect(t.rejected).toEqual([])
    expect(t.entries).toHaveLength(1)
  })

  it('嵌套主机分属两个包不算撞（认领时最长后缀胜）', () => {
    const t = linkTableOf([
      { facility: 'a', links: links('a', 'site.com') },
      { facility: 'b', links: links('b', 'm.site.com') },
    ])
    expect(t.rejected).toEqual([])
  })
})
