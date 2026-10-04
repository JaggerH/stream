import { describe, it, expect } from 'vitest'
import { toImportSpecifier } from './rsshub-specifier.ts'

/**
 * 这条守的是一个**只在 Windows 上现形**的失败：本机（Linux）怎么跑都是绿的，因为这里的绝对
 * 路径以 `/` 开头、没有盘符。所以判据必须写成"给它一个 Windows 路径会怎样"，而不是"在本机
 * 跑得通吗"——后者永远通过。
 */
describe('toImportSpecifier', () => {
  it('Windows 盘符路径 → file:// URL（不转的话 ESM loader 报协议 c: 不支持）', () => {
    expect(toImportSpecifier('C:\\Users\\x\\rsshub\\dist-lib\\pkg.mjs')).toMatch(/^file:\/\/\//)
    expect(toImportSpecifier('c:/Users/x/pkg.mjs')).toMatch(/^file:\/\/\//)
  })

  it('POSIX 绝对路径 → 也转（同一条路，别让两个平台走不同的分支）', () => {
    expect(toImportSpecifier('/home/u/RSSHub/lib/pkg.ts')).toBe('file:///home/u/RSSHub/lib/pkg.ts')
  })

  it('已经是 file:// URL → 原样放过（import.meta.resolve 返回的就是它）', () => {
    const u = 'file:///n/rsshub/dist-lib/pkg.mjs'
    expect(toImportSpecifier(u)).toBe(u)
  })

  it('盘符不是 scheme —— 这正是最容易写错的那一格', () => {
    // 只按 /^[a-z]+:/ 判"有没有 scheme"的写法会把 C: 当成协议放过去，于是 Windows 上照样炸。
    expect(toImportSpecifier('D:\\a\\b.mjs')).not.toBe('D:\\a\\b.mjs')
  })
})
