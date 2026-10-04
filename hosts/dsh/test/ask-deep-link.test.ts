// 深链那一句（外部/手写链接跳过来时带的，Stream 前端自己已不产生）。钉两件事：取得出来，
// 以及**取完就没了**——不抹参数的话按一次 F5 就再发一条消息，而用户完全不觉得自己发了。
import { describe, it, expect, vi } from 'vitest'

import { ASK_QUERY_PARAM, takeAskFromLocation } from '../src/client/ask-deep-link.ts'

function loc(href: string): { href: string } {
  return { href }
}

describe('takeAskFromLocation', () => {
  it('取出那一句，并把参数从地址栏抹掉', () => {
    const replaceState = vi.fn()
    const text = takeAskFromLocation(
      loc(`http://127.0.0.1:8901/?${ASK_QUERY_PARAM}=${encodeURIComponent('请调用 extract 转成文字')}&x=1`),
      { replaceState },
    )
    expect(text).toBe('请调用 extract 转成文字')
    expect(replaceState).toHaveBeenCalledTimes(1)
    const url = replaceState.mock.calls[0]![2] as string
    expect(url).not.toContain(ASK_QUERY_PARAM)
    // 同一个地址上别的参数不许被顺手抹掉。
    expect(url).toContain('x=1')
  })

  it('没有这个参数时什么都不做（连 replaceState 都不调）', () => {
    const replaceState = vi.fn()
    expect(takeAskFromLocation(loc('http://127.0.0.1:8901/'), { replaceState })).toBeUndefined()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('参数是空串也当作没有——空句子发进对话毫无意义', () => {
    const replaceState = vi.fn()
    expect(takeAskFromLocation(loc(`http://127.0.0.1:8901/?${ASK_QUERY_PARAM}=`), { replaceState })).toBeUndefined()
  })

  it('地址解析不了时安静返回（绝不因为一个怪地址把整个插件装载搞崩）', () => {
    expect(takeAskFromLocation(loc('not a url'), { replaceState: vi.fn() })).toBeUndefined()
  })
})
