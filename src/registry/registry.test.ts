import { describe, it, expect } from 'vitest'
import { Registry } from './registry.ts'
import type { SearchBackend } from './search.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1,
    adapter: 'rsshub',
    type: 'post',
    description: 'desc',
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

describe('Registry', () => {
  it('looks up by id and lists all', () => {
    const r = new Registry([mk({ id: 'a' }), mk({ id: 'b' })])
    expect(r.get('a')?.id).toBe('a')
    expect(r.get('missing')).toBeUndefined()
    expect(r.all()).toHaveLength(2)
  })

  it('throws on duplicate id, naming it', () => {
    expect(() => new Registry([mk({ id: 'dup' }), mk({ id: 'dup' })])).toThrow(/dup/)
  })

  it('delegates search to the backend interface', () => {
    const calls: string[] = []
    const fake: SearchBackend = {
      rank: (q, manifests, k) => {
        calls.push(`${q}|${manifests.length}|${k}`)
        return []
      },
    }
    const r = new Registry([mk({ id: 'a' })], fake)
    r.search('hello', 3)
    expect(calls).toEqual(['hello|1|3'])
  })

  it('matching() returns sources whose matchers contain the exact pattern, priority-ordered', () => {
    const r = new Registry([
      mk({ id: 'z', matchers: ['music.163.com/song'], priority: 2 }),
      mk({ id: 'a', matchers: ['music.163.com/song'], priority: 1 }),
      mk({ id: 'other', matchers: ['music.163.com/album'] }),
      mk({ id: 'none' }),
    ])
    expect(r.matching('music.163.com/song').map((m) => m.id)).toEqual(['a', 'z'])
    expect(r.matching('music.163.com/album').map((m) => m.id)).toEqual(['other'])
    expect(r.matching('nope')).toEqual([])
  })

  it('inCategory() 返回 categories 含该类且带 key_param 的源，priority 序；没 key_param 的不进', () => {
    const r = new Registry([
      mk({ id: 'z', categories: ['podcast'], key_param: 'id', priority: 2 }),
      mk({ id: 'a', categories: ['podcast'], key_param: 'id', priority: 1 }),
      mk({ id: 'nokey', categories: ['podcast'] }),
      mk({ id: 'news', categories: ['news'], key_param: 'id' }),
    ])
    expect(r.inCategory('podcast').map((m) => m.id)).toEqual(['a', 'z'])
    expect(r.inCategory('nope')).toEqual([])
  })

  // 先验后改：swapGroup 抛出去之后这个 registry 还得能继续用。启动期整组进不去会退化成
  // 逐包重试（sources 域），边插边抛留下的半批 manifest 会让每一次重试都撞上自己刚插的那些
  // ——表现是「一个坏包照样掀翻全部」，而错误信息指着无辜的包。
  it('swapGroup 撞了 id：整组原子拒绝，registry 保持原样，重试还能成', () => {
    const r = new Registry([mk({ id: 'curated' })])
    expect(() => r.swapGroup('recipes', [mk({ id: 'ok' }), mk({ id: 'curated' })])).toThrow(/curated/)
    expect(r.get('ok')).toBeUndefined()          // 抛之前插进去的那半批不许留下
    expect(r.get('curated')?.id).toBe('curated')
    expect(() => r.swapGroup('recipes', [mk({ id: 'ok' })])).not.toThrow()
    expect(r.get('ok')?.id).toBe('ok')
  })

  it('swapGroup 换掉本组自己的 id 不算撞（重挂同一份包）', () => {
    const r = new Registry([mk({ id: 'curated' })])
    r.swapGroup('recipes', [mk({ id: 'x', description: 'v1' })])
    r.swapGroup('recipes', [mk({ id: 'x', description: 'v2' })])
    expect(r.get('x')?.description).toBe('v2')
  })

  // —— 命名空间化后的四级解析（spec §4）——
  describe('全名 / 裸名解析', () => {
    const builtinXhs = mk({ id: '@streamapp/xhs/xhs-home' })
    const builtinFetch = mk({ id: '@streamapp/builtin/fetch-url' })
    const thirdFetch = mk({ id: 'evil-fetch/fetch-url' })
    const otherFetch = mk({ id: 'other-fetch/fetch-url' })

    it('① 两个包各有一个 fetch-url → 并存，各自用全名 get 得到自己那份', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [builtinFetch, thirdFetch], new Set([builtinFetch.id]))
      expect(r.get('@streamapp/builtin/fetch-url')?.id).toBe('@streamapp/builtin/fetch-url')
      expect(r.get('evil-fetch/fetch-url')?.id).toBe('evil-fetch/fetch-url')
      expect(r.all()).toHaveLength(2)
    })

    it('② 存量重组形 `xhs:xhs-home` → 第 2 级剥离 → 第 3 级按局部名命中全名', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [builtinXhs], new Set([builtinXhs.id]))
      expect(r.get('xhs:xhs-home')?.id).toBe('@streamapp/xhs/xhs-home')
      // 剥离后再精确命中全名的那一形（订阅时写进 stream 行的就是这个）
      expect(r.get('xhs:@streamapp/xhs/xhs-home')?.id).toBe('@streamapp/xhs/xhs-home')
    })

    it('③a 裸名唯一 → 命中', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [builtinFetch], new Set([builtinFetch.id]))
      expect(r.get('fetch-url')?.id).toBe('@streamapp/builtin/fetch-url')
    })

    // 第三方那条**故意排在前面**：判据是"内置优先"，不是"先到先得"。两种写法在
    // 内置恰好排第一时表现一模一样，那样的夹具会让这条测试假绿（spec §9.2 点名的坑）。
    it('③b 裸名歧义（内置 + 第三方）→ 内置那条胜出（哪怕第三方先入表），且记了一条歧义记录', () => {
      const r = new Registry([])
      const seen: unknown[] = []
      r.onAmbiguity((n) => seen.push(n))
      r.swapGroup('recipes', [thirdFetch, builtinFetch], new Set([builtinFetch.id]))
      expect(r.get('fetch-url')?.id).toBe('@streamapp/builtin/fetch-url')
      expect(seen).toEqual([{
        localName: 'fetch-url',
        chosen: '@streamapp/builtin/fetch-url',
        candidates: ['evil-fetch/fetch-url', '@streamapp/builtin/fetch-url'],
      }])
    })

    it('③c 裸名歧义（两个第三方、无内置）→ 抛 AmbiguousSourceIdError，消息含两个候选全名', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [thirdFetch, otherFetch], new Set())
      expect(() => r.get('fetch-url')).toThrow(/evil-fetch\/fetch-url/)
      expect(() => r.get('fetch-url')).toThrow(/other-fetch\/fetch-url/)
    })

    it('catalog 不进 byLocalName —— rsshub 长尾撞名仍是静默遮蔽，不是解析歧义', () => {
      const r = new Registry([], undefined, [mk({ id: 'rsshub:some/pkg/fetch-url' })])
      expect(r.get('fetch-url')).toBeUndefined()
      expect(r.get('rsshub:some/pkg/fetch-url')?.id).toBe('rsshub:some/pkg/fetch-url')
    })

    it('swapGroup 换掉一组时旧的局部名索引一起撤（不留幽灵候选）', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [builtinFetch, thirdFetch], new Set([builtinFetch.id]))
      r.swapGroup('recipes', [thirdFetch], new Set())
      expect(r.get('fetch-url')?.id).toBe('evil-fetch/fetch-url') // 不再歧义，也不再命中内置
    })

    it('providersOf 的隐式自供走 get —— 裸的 target-type 名在全名世界里仍找得到', () => {
      const r = new Registry([])
      r.swapGroup('recipes', [builtinFetch], new Set([builtinFetch.id]))
      expect(r.providersOf('fetch-url').map((m) => m.id)).toEqual(['@streamapp/builtin/fetch-url'])
    })
  })

  it('returns deduped, sorted topics', () => {
    const r = new Registry([
      mk({ id: 'a', topics: ['tech', 'ai'] }),
      mk({ id: 'b', topics: ['ai', 'crypto'] }),
    ])
    expect(r.topics()).toEqual(['ai', 'crypto', 'tech'])
  })
})

/**
 * catalog 是可以整份换掉的：发行安装上它不来自开机读的那个文件，而是 RSSHub worker 现取的
 * （`request('/api/namespace')`），那一刻后端早就起来了。
 */
describe('swapCatalog：整份换掉长尾', () => {
  const cat = (id: string) => mk({ id })

  it('换掉之后旧的长尾条目查不到了，新的查得到', () => {
    const r = new Registry([], undefined, [cat('rsshub:a/1')])
    expect(r.get('rsshub:a/1')).toBeTruthy()
    r.swapCatalog([cat('rsshub:b/2')])
    expect(r.get('rsshub:a/1')).toBeUndefined()
    expect(r.get('rsshub:b/2')).toBeTruthy()
  })

  it('curated 不受影响——哪怕它和某条 catalog 同 id', () => {
    const curated = mk({ id: 'rsshub:a/1', description: 'curated' })
    const r = new Registry([curated], undefined, [cat('rsshub:a/1'), cat('rsshub:a/2')])
    // 同 id 时 curated 赢（构造期就是这个语义），所以它根本没被当成 catalog 收下。
    expect(r.get('rsshub:a/1')?.description).toBe('curated')
    r.swapCatalog([])
    // 换掉整份 catalog 之后 curated 那条必须还在——它不属于 catalog，不该被顺手删掉。
    expect(r.get('rsshub:a/1')?.description).toBe('curated')
    expect(r.get('rsshub:a/2')).toBeUndefined()
  })

  it('recipe 组也不受影响（换目录不该把用户装的包换没了）', () => {
    const r = new Registry([], undefined, [cat('rsshub:a/1')])
    r.swapGroup('recipes', [mk({ id: '@x/y/z' })])
    r.swapCatalog([cat('rsshub:b/2')])
    expect(r.get('@x/y/z')).toBeTruthy()
  })

  it('换两次不会越换越少（第二次换回来的还能查到）', () => {
    const r = new Registry([], undefined, [cat('rsshub:a/1')])
    r.swapCatalog([cat('rsshub:b/2')])
    r.swapCatalog([cat('rsshub:a/1')])
    expect(r.get('rsshub:a/1')).toBeTruthy()
  })
})
