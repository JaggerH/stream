import { describe, it, expect } from 'vitest'
import { searchableSourceTypes } from './source-types.ts'
import type { AlistStorage } from './alist-client.ts'

const st = (driver: string, extra: Partial<AlistStorage> = {}): AlistStorage => ({
  id: 1, mount_path: '/x', driver, addition: '{}', disabled: false, ...extra,
})

describe('searchableSourceTypes', () => {
  it('无 storage → 只有 magnet/ed2k（它们不依赖 AList）', () => {
    expect(searchableSourceTypes([])).toEqual(['magnet', 'ed2k'])
  })
  it('挂了夸克 → 加 quark', () => {
    expect(searchableSourceTypes([st('Quark')])).toEqual(['magnet', 'ed2k', 'quark'])
  })
  it('挂了搜索侧没有对应类型的盘（115/UC/Local）→ 忽略', () => {
    expect(searchableSourceTypes([st('115 Cloud'), st('UC'), st('Local')])).toEqual(['magnet', 'ed2k'])
  })
  it('手挂的百度/阿里也认（真相源是 storages，不是 MOUNT_PRESETS）', () => {
    const r = searchableSourceTypes([st('BaiduNetdisk'), st('AliyundriveOpen')])
    expect(r).toContain('baidu')
    expect(r).toContain('aliyun')
  })
  it('阿里两个驱动映射到同一个类型，不重复', () => {
    const r = searchableSourceTypes([st('AliyundriveOpen'), st('AliyundriveShare')])
    expect(r.filter((t) => t === 'aliyun')).toHaveLength(1)
  })
  it('disabled 的 storage 不算数', () => {
    expect(searchableSourceTypes([st('Quark', { disabled: true })])).toEqual(['magnet', 'ed2k'])
  })
  it('未知 driver → 忽略，不抛', () => {
    expect(searchableSourceTypes([st('SomeFutureDriver')])).toEqual(['magnet', 'ed2k'])
  })
})
