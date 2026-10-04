import { describe, expect, it } from 'vitest'
import { DomPerception, matchUrlPattern } from './state-perception-dom.ts'
import type { StateDef } from './state-graph.ts'

describe('matchUrlPattern', () => {
  it('* 匹配任意一段字符', () => {
    expect(matchUrlPattern('https://x.com/*/detail', 'https://x.com/ab/detail')).toBe(true)
    expect(matchUrlPattern('https://x.com/*/detail', 'https://x.com/ab/other')).toBe(false)
  })

  it('没有 * 时是整串相等，不是 includes', () => {
    expect(matchUrlPattern('https://x.com/a', 'https://x.com/a')).toBe(true)
    expect(matchUrlPattern('https://x.com/a', 'https://x.com/a/b')).toBe(false)
  })

  // 钉住实现方式：拿某个字符当 `*` 的哨兵（比如换成空格再 split），会让模式里本来就有的
  // 那个字符跟着变成通配符。这条在那种实现下会红。
  it('模式里本来就有的空格是字面空格，不是通配符', () => {
    expect(matchUrlPattern('https://x.com/a b', 'https://x.com/a b')).toBe(true)
    expect(matchUrlPattern('https://x.com/a b', 'https://x.com/aZZZb')).toBe(false)
  })

  it('正则元字符按字面处理', () => {
    expect(matchUrlPattern('https://x.com/a?b=1', 'https://x.com/a?b=1')).toBe(true)
    expect(matchUrlPattern('https://x.com/a.b', 'https://x.com/aXb')).toBe(false)
  })
})

const fakeDriver = (opts: { url?: string; present?: string[] }) =>
  ({
    currentUrl: async () => opts.url ?? '',
    exists: async (sel: string) => (opts.present ?? []).includes(sel),
  }) as unknown as ConstructorParameters<typeof DomPerception>[0]

describe('DomPerception', () => {
  const states: StateDef[] = [
    { id: 'wall', features: [{ kind: 'dom', selector: '.login' }] },
    { id: 'feed', features: [{ kind: 'dom', selector: '.login', absent: true }, { kind: 'url', pattern: 'https://x.com/*' }] },
  ]

  it('选择器在场认出登录墙', async () => {
    const p = new DomPerception(fakeDriver({ url: 'https://x.com/home', present: ['.login'] }))
    expect(await p.identify(states)).toMatchObject({ states: ['wall'] })
  })

  it('absent 特征：登录按钮不在了才算已登录', async () => {
    const p = new DomPerception(fakeDriver({ url: 'https://x.com/home', present: [] }))
    expect(await p.identify(states)).toMatchObject({ states: ['feed'] })
  })

  it('driver 不给 currentUrl 时，url 特征抛错而不是静默为假', async () => {
    const noUrl = { exists: async () => false } as unknown as ConstructorParameters<typeof DomPerception>[0]
    const p = new DomPerception(noUrl)
    await expect(p.identify([{ id: 'x', features: [{ kind: 'url', pattern: 'a' }] }])).rejects.toThrow(
      /currentUrl/,
    )
  })

  it('桌面特征混进网页图会抛错', async () => {
    const p = new DomPerception(fakeDriver({}))
    await expect(
      p.identify([{ id: 'x', features: [{ kind: 'a11y', query: { role: 'Button' } }] }]),
    ).rejects.toThrow(/判不了/)
  })
})
