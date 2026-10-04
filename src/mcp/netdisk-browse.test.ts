import { describe, expect, test } from 'vitest'
import {
  BROWSE_LIST_THRESHOLD,
  BROWSE_MAX_ENTRIES,
  BROWSE_SAMPLE,
  browseResult,
  shapeOf,
  type BrowseEntry,
} from './netdisk-browse.ts'

const file = (name: string, size = 1000): BrowseEntry => ({ name, size, isDir: false })
const dir = (name: string): BrowseEntry => ({ name, size: 0, isDir: true })
const files = (n: number, ext = 'mp3', size = 1000): BrowseEntry[] =>
  Array.from({ length: n }, (_, i) => file(`第${i}期.${ext}`, size))

describe('小目录：逐条给', () => {
  test('阈值以内给清单、不给形状', () => {
    const r = browseResult('/quark/x', false, [dir('更新'), file('001.mp3', 42)])
    expect(r.entries).toEqual([
      { name: '更新', size: 0, isDir: true },
      { name: '001.mp3', size: 42, isDir: false },
    ])
    expect(r.shape).toBeUndefined()
    expect(r.total).toBe(2)
    expect(r.truncated).toBeUndefined()
  })

  test('空目录也是合法答案，不是错误', () => {
    const r = browseResult('/quark/empty', false, [])
    expect(r.entries).toEqual([])
    expect(r.total).toBe(0)
  })
})

describe('大目录：先给形状再给清单', () => {
  // 这条守的是上下文预算：5000 条逐条列会吃掉对话一大块，而挑目录压根不需要逐条读。
  test('超过阈值就不给 entries，给形状 + 样本', () => {
    const r = browseResult('/quark/big', false, files(BROWSE_LIST_THRESHOLD + 1))
    expect(r.entries).toBeUndefined()
    expect(r.shape?.files).toBe(BROWSE_LIST_THRESHOLD + 1)
    expect(r.shape?.byExt).toEqual({ mp3: BROWSE_LIST_THRESHOLD + 1 })
    expect(r.sample).toHaveLength(BROWSE_SAMPLE)
  })

  test('样本目录优先——挑目录时子文件夹比头几个文件名有用', () => {
    const r = browseResult('/quark/mixed', true, [
      ...Array.from({ length: 3 }, (_, i) => dir(`子节目${i}`)),
      ...files(BROWSE_LIST_THRESHOLD),
    ])
    expect(r.sample!.slice(0, 3)).toEqual(['子节目0/', '子节目1/', '子节目2/'])
    expect(r.sample).toHaveLength(BROWSE_SAMPLE)
    expect(r.shape?.dirs).toBe(3)
  })
})

describe('截断要如实招供', () => {
  // 「看到 5000 条」和「总共 5000 条」是两个结论。不报真数，AI 会把上限当成事实往下推。
  test('到顶时 total 报真数并标 truncated', () => {
    const r = browseResult('/quark/huge', true, files(BROWSE_MAX_ENTRIES + 7))
    expect(r.total).toBe(BROWSE_MAX_ENTRIES + 7)
    expect(r.truncated).toBe(true)
    expect(r.shape?.files).toBe(BROWSE_MAX_ENTRIES)
  })

  test('没到顶就不许出现 truncated', () => {
    expect(browseResult('/x', true, files(BROWSE_MAX_ENTRIES)).truncated).toBeUndefined()
  })
})

describe('形状', () => {
  test('扩展名按条数排序，无扩展名归空串', () => {
    const s = shapeOf([...files(3, 'mp3'), ...files(5, 'm4a'), file('README', 10), dir('d')])
    expect(Object.keys(s.byExt)).toEqual(['m4a', 'mp3', ''])
    expect(s.byExt).toEqual({ m4a: 5, mp3: 3, '': 1 })
    expect(s.dirs).toBe(1)
    expect(s.files).toBe(9)
  })

  test('长尾扩展名并进「其他」——扩展名多到几十种时它自己会吃掉预算', () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.ext${i}`))
    const s = shapeOf([...files(9, 'mp3'), ...many])
    expect(s.byExt.mp3).toBe(9)
    expect(Object.keys(s.byExt)).toHaveLength(13) // 12 种 + 「其他」
    expect(s.byExt['其他']).toBe(20 - 12 + 1) // 12 格里有一格被 mp3 占了
  })

  test('隐藏文件不当成扩展名', () => {
    expect(shapeOf([file('.DS_Store')]).byExt).toEqual({ '': 1 })
  })

  test('大小区间只算文件，目录不掺进来', () => {
    const s = shapeOf([file('a.mp3', 10), file('b.mp3', 30), dir('d')])
    expect(s.sizeBytes).toEqual({ min: 10, max: 30, total: 40 })
  })

  test('一个文件都没有时缺席，不是 0', () => {
    expect(shapeOf([dir('a'), dir('b')]).sizeBytes).toBeUndefined()
  })
})
