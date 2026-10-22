import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mount, unmount } from './manage-entry.tsx'

/** 配对手机的地方必须在用户真能点到的设置里：它曾经住在一个没人挂载的组件里，真机验收时
 *  整个面板都找不到「手机」——只能在后端机器上手调接口拿配对码。 */
describe('DSH 设置里的 Stream 分区', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string) => {
      // 其他页的接口一直挂着：那几页停在「加载中」，不拿假数据去撑它们的格式。
      if (!String(url).endsWith('/api/devices')) return new Promise(() => {})
      const body = { devices: [{ deviceId: 'android:1', name: 'K80', platform: 'android', paired: true, online: true }] }
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { act(() => unmount()) })

  it('有一页「手机」：列出已配对的手机，能在这里添加手机', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    act(() => mount(el, { backend: 'http://127.0.0.1:8900' }))
    fireEvent.click(await screen.findByRole('tab', { name: '设备' }))
    expect(await screen.findByText('K80')).toBeTruthy()
    expect(screen.getByRole('button', { name: /添加手机/ })).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8900/api/devices', expect.anything()))
  })
})
