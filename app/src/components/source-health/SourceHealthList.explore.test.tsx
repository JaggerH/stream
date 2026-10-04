import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceHealthList } from './SourceHealthList.tsx'

const posted: string[] = []
let packages: unknown
let exploreStatus = 201
let exploreBody = '{"runId":"r-explore"}'

beforeEach(() => {
  cleanup(); posted.length = 0
  packages = [{ name: '@streamapp/xhs', version: '1.0.0', facility: 'xhs', sourceIds: ['@s/xhs/xhs-home', '@s/xhs/xhs-detail'] }]
  exploreStatus = 201; exploreBody = '{"runId":"r-explore"}'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace('http://b', '')
    if (init?.method === 'POST') { posted.push(path + ' ' + String(init.body)); return new Response(exploreBody, { status: exploreStatus }) }
    if (path === '/api/recipes/packages') return new Response(JSON.stringify(packages), { status: 200 })
    return new Response(JSON.stringify({ sources: [] }), { status: 200 })
  }))
})

const fill = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: '探索建图' }))
  await waitFor(() => expect(screen.getByLabelText('target')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('target'), { target: { value: 'chrome:7' } })
  fireEvent.change(screen.getByLabelText('goal'), { target: { value: '到搜索结果页' } })
}

describe('SourceHealthList「探索建图」', () => {
  it('顶栏按钮 → 表单 → 从装了的包里挑 → POST 逐字 → 跳到该 facility 的首源', async () => {
    const onOpen = vi.fn()
    render(<SourceHealthList apiBase="http://b" onOpen={onOpen} />)
    await waitFor(() => expect(screen.getByText('所有源正常')).toBeTruthy())
    await fill()
    // 下拉不预选：它只是快捷方式，挑一个回填进手填那一格。
    expect((screen.getByLabelText('facility') as HTMLInputElement).value).toBe('')
    await waitFor(() => expect(screen.getByLabelText('装了的包')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('装了的包'), { target: { value: 'xhs' } })
    expect((screen.getByLabelText('facility') as HTMLInputElement).value).toBe('xhs')
    fireEvent.click(screen.getByRole('button', { name: '开始探索' }))
    await waitFor(() => expect(posted[0]).toBe('/api/interventions/explorations {"facility":"xhs","target":"chrome:7","goal":"到搜索结果页"}'))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('@s/xhs/xhs-home'))
  })

  it('后端拒了（409 explore-busy）：错误文案留在表单下，不跳走', async () => {
    exploreStatus = 409; exploreBody = JSON.stringify({ error: { code: 'explore-busy', message: 'xhs 已有一条探索在跑' } })
    const onOpen = vi.fn()
    render(<SourceHealthList apiBase="http://b" onOpen={onOpen} />)
    await fill()
    fireEvent.change(screen.getByLabelText('facility'), { target: { value: 'xhs' } })
    fireEvent.click(screen.getByRole('button', { name: '开始探索' }))
    await waitFor(() => expect(screen.getByText(/已有一条探索在跑/)).toBeTruthy())
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('装了第三方包时，内置 facility（xhs）照样能手填提交——下拉挡不住它', async () => {
    // 这份名单只有 npm 装的包；内置的 xhs 永远不在里面。
    packages = [{ name: '@someone/quark', version: '2.0.0', facility: 'quark', sourceIds: ['@s/quark/quark-home'] }]
    const onOpen = vi.fn()
    render(<SourceHealthList apiBase="http://b" onOpen={onOpen} />)
    await fill()
    await waitFor(() => expect(screen.getByLabelText('装了的包')).toBeTruthy())
    expect(screen.queryByRole('option', { name: 'xhs' })).toBeNull()
    fireEvent.change(screen.getByLabelText('facility'), { target: { value: 'xhs' } })
    fireEvent.click(screen.getByRole('button', { name: '开始探索' }))
    await waitFor(() => expect(posted[0]).toBe('/api/interventions/explorations {"facility":"xhs","target":"chrome:7","goal":"到搜索结果页"}'))
    // 包名单里没有 xhs → 取不到首源 → 不瞎跳，走 toast 那条路。
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('读不到装了的包：facility 退回手填，照样能提交', async () => {
    packages = []
    render(<SourceHealthList apiBase="http://b" onOpen={() => {}} />)
    await fill()
    fireEvent.change(screen.getByLabelText('facility'), { target: { value: 'qq' } })
    fireEvent.click(screen.getByRole('button', { name: '开始探索' }))
    await waitFor(() => expect(posted[0]).toBe('/api/interventions/explorations {"facility":"qq","target":"chrome:7","goal":"到搜索结果页"}'))
  })
})
