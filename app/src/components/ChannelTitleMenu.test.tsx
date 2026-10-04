import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChannelTitleMenu } from './ChannelTitleMenu.tsx'

describe('ChannelTitleMenu', () => {
  it('标题文字本身就是触发器，键盘 Enter 展开下拉', async () => {
    render(<ChannelTitleMenu title="时间线" onRefresh={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '时间线' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: '重新抓取' })).toBeTruthy()
  })

  it('没给 exportChannel → 只有「重新抓取」一项，不出现任何逐源列表', async () => {
    render(<ChannelTitleMenu title="音乐" onRefresh={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: '音乐' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menuitem', { name: '重新抓取' })
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  })

  // 「导出哪一个频道」由宿主回答：多频道那档（影视/音乐同时挂着好几个）不给这个 prop，
  // 于是这一项不画——一个点了不知道会导出谁的菜单项比没有更坏。
  it('给了 exportChannel → 「重新抓取」下面多一项「导出为分享包」，面板点开才挂', async () => {
    render(<ChannelTitleMenu title="影视" onRefresh={vi.fn()} exportChannel={{ conn: { baseUrl: '' }, id: 'c1' }} />)
    fireEvent.keyDown(screen.getByRole('button', { name: '影视' }), { key: 'Enter' })
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['重新抓取', '导出为分享包'])
    expect(screen.queryByRole('dialog', { name: '导出为分享包' })).toBeNull()
  })

  it('点「重新抓取」触发 onRefresh', async () => {
    const onRefresh = vi.fn()
    render(<ChannelTitleMenu title="影视" onRefresh={onRefresh} />)
    const trigger = screen.getByRole('button', { name: '影视' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '重新抓取' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
