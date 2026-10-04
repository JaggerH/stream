import { describe, expect, it } from 'vitest'
import { parseArgs } from './cli.ts'

describe('parseArgs', () => {
  it('parses translate facility and optional history', () => {
    expect(parseArgs(['translate', 'xhs'])).toEqual({ command: 'translate', facility: 'xhs' })
    expect(parseArgs(['translate', 'xhs', '--history', '/tmp/history.json'])).toEqual({ command: 'translate', facility: 'xhs', history: '/tmp/history.json' })
  })

  it('parses validate sourceId', () => {
    expect(parseArgs(['validate', 'source'])).toEqual({ command: 'validate', sourceId: 'source' })
  })

  it('rejects invalid validate args', () => {
    expect(() => parseArgs(['validate'])).toThrow(/record validate/)
    expect(() => parseArgs(['validate', 'a', 'b'])).toThrow(/record validate/)
  })

  it('rejects unknown commands', () => {
    expect(() => parseArgs(['wat'])).toThrow(/Unknown command/)
  })

  // login/explore 是 cloak 时代的命令：往 Stream 自己的浏览器 profile 里人工登一次、
  // 或把 browser-use agent 挂到那个窗口上。浏览器换成用户自己的之后，两件事都没有了。
  it('rejects the retired cloak-era commands', () => {
    expect(() => parseArgs(['login', 'xhs'])).toThrow(/Unknown command/)
    expect(() => parseArgs(['explore', 'xhs', 'find feed'])).toThrow(/Unknown command/)
  })

  it('rejects invalid translate args', () => {
    expect(() => parseArgs(['translate'])).toThrow(/record translate/)
    expect(() => parseArgs(['translate', 'xhs', '--wat'])).toThrow(/record translate/)
  })
})
