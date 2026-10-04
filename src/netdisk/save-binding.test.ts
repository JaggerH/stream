import { describe, it, expect } from 'vitest'
import { planBinding } from './save-binding.ts'
import type { MappingSet } from './types.ts'

const ref = { id: '842675', media: 'tv' as const, title: '流浪地球2' }
const existing = (path: string): MappingSet => ({
  id: 'map_1', left: { kind: 'tmdb', id: '842675', media: 'tv', title: '流浪地球2' },
  right: { kind: 'alist-dir', path, boundAt: '2026-07-18T00:00:00Z' },
  rightHistory: [], autoSync: true, entries: [],
})

describe('planBinding —— 转存后建/同步绑定的决策', () => {
  it('未绑过 → 新建（dirPath = 挂载前缀 + 转存落点）', () => {
    expect(planBinding('quark', 'From Stream/流浪地球2', ref, undefined)).toEqual({
      kind: 'create', dirPath: '/quark/From Stream/流浪地球2', left: { kind: 'tmdb', ...ref },
    })
  })

  // 同一作品转存第二条分享（补集/换版本），落进同一目录 → 只重新 sync，绝不重复建绑定。
  it('已绑到同一目录 → sync，不重复建', () => {
    expect(planBinding('quark', 'From Stream/流浪地球2', ref, existing('/quark/From Stream/流浪地球2')))
      .toEqual({ kind: 'sync', setId: 'map_1' })
  })

  // 同作品但落点变了（用户改了落点根）→ rebind 到新目录，保留人工订正的指纹继承。
  it('已绑但目录不同 → rebind', () => {
    expect(planBinding('quark', 'From Stream/流浪地球2', ref, existing('/quark/旧目录')))
      .toEqual({ kind: 'rebind', setId: 'map_1', dirPath: '/quark/From Stream/流浪地球2' })
  })

  it('未知网盘（无挂载前缀）→ skip，不瞎绑', () => {
    expect(planBinding('mystery', 'From Stream/x', ref, undefined).kind).toBe('skip')
  })

  it('转存没返回落点（dest 空）→ skip', () => {
    expect(planBinding('quark', '', ref, undefined).kind).toBe('skip')
    expect(planBinding('quark', undefined, ref, undefined).kind).toBe('skip')
  })
})

describe('落点目录两侧同一个口径', () => {
  const ref = { id: '1', media: 'tv' as const, title: 'X' }
  const set = (path: string) => ({ id: 'map_1', right: { path } }) as never

  // 归一化只加在右边、左边直接拿库里存的串比，会把一条历史上带双斜杠的绑定判成"落点变了"，
  // 从 sync 翻成 rebind——而两个路径指的是同一个目录。
  it('库里存着未归一化的老路径，仍判成 sync 而不是 rebind', () => {
    expect(planBinding('quark', 'From Stream/X', ref, set('/quark//From Stream/X/'))).toMatchObject({ kind: 'sync' })
  })

  it('落点真的变了才 rebind', () => {
    expect(planBinding('quark', 'From Stream/X', ref, set('/quark/别处/Y'))).toMatchObject({ kind: 'rebind' })
  })
})
