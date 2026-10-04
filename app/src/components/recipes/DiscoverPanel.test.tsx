import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DiscoverPanel } from './DiscoverPanel.tsx'
import type { RecipePackageSearchHit } from '../../lib/types.ts'

const results: RecipePackageSearchHit[] = [
  { name: '@streamapp/xhs', version: '1.2.0', description: '小红书采集' },
  { name: '@streamapp/telegram', version: '0.3.1', description: '' },
]

const setup = (over: Partial<Parameters<typeof DiscoverPanel>[0]> = {}) => {
  const onQueryChange = vi.fn()
  const onSubmit = vi.fn()
  const onInstall = vi.fn()
  render(
    <DiscoverPanel
      query="" onQueryChange={onQueryChange} onSubmit={onSubmit}
      hasSearched={false} searching={false} error={null}
      results={[]} pendingName={null} onInstall={onInstall}
      {...over}
    />,
  )
  return { onQueryChange, onSubmit, onInstall }
}

describe('DiscoverPanel 搜索', () => {
  it('回车提交（不是输入即搜）', () => {
    const { onSubmit, onQueryChange } = setup({ query: 'xhs' })
    fireEvent.change(screen.getByPlaceholderText(/搜关键词/), { target: { value: 'xhs2' } })
    expect(onQueryChange).toHaveBeenCalledWith('xhs2')
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByPlaceholderText(/搜关键词/), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('点搜索按钮也提交', () => {
    const { onSubmit } = setup({ query: 'xhs' })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('结果区列出包名、版本、描述，点安装派发包名', () => {
    const { onInstall } = setup({ query: 'xhs', hasSearched: true, results })
    expect(screen.getByText('@streamapp/xhs')).toBeTruthy()
    expect(screen.getByText('1.2.0')).toBeTruthy()
    expect(screen.getByText('小红书采集')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '安装' })[0])
    expect(onInstall).toHaveBeenCalledWith('@streamapp/xhs')
  })

  it('搜索出错时结果区显示错误提示', () => {
    setup({ query: 'xhs', hasSearched: true, error: 'registry 502 for search' })
    expect(screen.getByText('registry 502 for search')).toBeTruthy()
  })

  it('初始态（还没搜过、结果为空）不显示「没搜到」提示', () => {
    setup()
    expect(screen.queryByText(/没搜到/)).toBeNull()
  })

  it('搜到空结果 → 提示可以直接粘完整包名', () => {
    setup({ query: 'nothinghere', hasSearched: true, results: [] })
    expect(screen.getByText('没搜到。刚发布的包可能尚未进入 npm 搜索索引，可直接粘贴完整包名安装。')).toBeTruthy()
  })
})

describe('DiscoverPanel 按名直装', () => {
  it('输入 scoped 包名 → 结果区直接给出该包名的安装项（没有第二个输入框）', () => {
    const { onInstall } = setup({ query: '@streamapp/telegram' })
    expect(screen.getAllByRole('textbox').length).toBe(1)
    const direct = screen.getByRole('button', { name: '安装 @streamapp/telegram' })
    fireEvent.click(direct)
    expect(onInstall).toHaveBeenCalledWith('@streamapp/telegram')
  })

  it('裸包名也给直装项', () => {
    setup({ query: 'telegram' })
    expect(screen.getByRole('button', { name: '安装 telegram' })).toBeTruthy()
  })

  it('不构成包名的输入不给直装项', () => {
    setup({ query: '小红书 采集' })
    expect(screen.queryByRole('button', { name: /^安装 / })).toBeNull()
  })

  it('输入是包名时，即使搜索空结果也不弹「没搜到」提示（直装项已经在了）', () => {
    setup({ query: '@streamapp/telegram', hasSearched: true, results: [] })
    expect(screen.queryByText(/没搜到/)).toBeNull()
  })

  it('pendingName 命中的那一项显示进行中且禁用（防重复提交）', () => {
    setup({ query: '@streamapp/telegram', pendingName: '@streamapp/telegram' })
    const btn = screen.getByRole('button', { name: '读取包信息…' })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})
