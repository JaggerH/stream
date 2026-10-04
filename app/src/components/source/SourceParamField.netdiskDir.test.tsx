import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceParamField } from './SourceParamField.tsx'
import type { ParamSpec } from '../../lib/types.ts'

/**
 * 「网盘目录参数用目录选择器填」这条**掉了不会报错**——它只是退化成一个纯文本框，用户得手敲
 * `/quark/来自：分享/播客付费节目合集/春典 JARGON` 这种路径。所以两端各钉一条：
 *
 * - 这里钉**前端这一端**：`widget: netdisk-dir` 兑得出选择器，且选完真的写回参数值；
 * - 另一端（alist-audio 的 path 真的声明了这个 widget）钉在 `packages/alist/manifests.real.test.ts`。
 *
 * 任一端改了 key 而另一端没跟，其中一条就会红。
 */
const fetchMock = vi.hoisted(() => vi.fn())

const FILES = [
  { name: '春典 JARGON', isDir: true, size: 0 },
  { name: '某一集.mp3', isDir: false, size: 12 },
]

describe('SourceParamField — 参数控件登记表', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/netdisk/fs')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: '/', files: FILES }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  const spec = (extra: Partial<ParamSpec> = {}): ParamSpec =>
    ({ type: 'string', required: true, description: 'AList 绝对目录路径', ...extra })

  it('widget: netdisk-dir → 出目录选择器；文本框仍可手敲', () => {
    const onChange = vi.fn()
    render(<SourceParamField name="path" spec={spec({ widget: 'netdisk-dir' })} value="" onChange={onChange} />)

    expect(screen.getByRole('button', { name: /浏览/ })).toBeTruthy()
    // 选择器是**省一次手敲**，不是取代手敲：路径已经知道时粘一条更快，AList 列不出目录时
    // 它还是唯一能把参数填进去的路。
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/quark/x' } })
    expect(onChange).toHaveBeenCalledWith('/quark/x')
  })

  it('在选择器里选一个目录 → 写回参数值', async () => {
    const onChange = vi.fn()
    render(<SourceParamField name="path" spec={spec({ widget: 'netdisk-dir' })} value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /浏览/ }))
    // 走进一层再确认——用户真实的动作就是这个，直接对着根目录点确认验不到路径拼接。
    fireEvent.click(await screen.findByText('春典 JARGON'))
    fireEvent.click(screen.getByRole('button', { name: /选定此目录/ }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/春典 JARGON'))
  })

  // 不认得的 key 静默退回文本框：参数本来就是字符串，控件只是省一次手敲，不该把整个配置
  // 面板打掉。（也钉住「没有 widget 的参数照旧是文本框」这个绝大多数源的常态。）
  it.each([undefined, 'no-such-widget'])('widget=%s → 纯文本框，没有浏览键', (widget) => {
    render(<SourceParamField name="path" spec={spec(widget ? { widget } : {})} value="" onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: /浏览/ })).toBeNull()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})
