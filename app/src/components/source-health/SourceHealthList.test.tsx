import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceHealthList } from './SourceHealthList.tsx'

const sources = [
  { source: { id: 'a', title: '笔记详情' }, status: 'awaiting', health: { state: 'dead', lastAt: 't' }, affectedChannels: [{ id: 'c1', label: '小红书' }, { id: 'c2', label: '搜索' }], run: { id: 'r1', status: 'awaiting_confirmation', startedAt: 't', usage: { promptTokens: 0, completionTokens: 0, turns: 0, wallMs: 0, reported: false } } },
  { source: { id: 'b', title: '首页' }, status: 'degraded', health: { state: 'degraded', lastAt: 't' }, affectedChannels: [] },
]
const posted: string[] = []
let list: unknown[]
beforeEach(() => {
  cleanup(); posted.length = 0; list = sources
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(init.body)); return new Response(JSON.stringify({ error: { code: 'agent-unavailable', message: '还没配 ai-agent' } }), { status: 503 }) }
    return new Response(JSON.stringify({ sources: list }), { status: 200 })
  }))
})

describe('SourceHealthList', () => {
  it('一行一个：名字、状态词、连累数；点行进详情；「让 agent 修」对黄源也有', async () => {
    const onOpen = vi.fn()
    render(<SourceHealthList apiBase="http://b" onOpen={onOpen} />)
    await waitFor(() => expect(screen.getByText('笔记详情')).toBeTruthy())
    expect(screen.getByText('等你拍板')).toBeTruthy()
    expect(screen.getByText(/连累 2 个频道/)).toBeTruthy()
    expect(screen.getByText('变差')).toBeTruthy()
    fireEvent.click(screen.getByText('首页'))
    expect(onOpen).toHaveBeenCalledWith('b')
    const buttons = screen.getAllByRole('button', { name: '让 agent 修' })
    expect(buttons.length).toBe(1)   // a 已在修（活跃 run）→ 不给按钮；b 给
    fireEvent.click(buttons[0]!)
    await waitFor(() => expect(posted[0]).toBe('{"sourceId":"b"}'))
    await waitFor(() => expect(screen.getByText(/还没配 ai-agent/)).toBeTruthy())
  })
  it('全绿：一句「所有源正常」', async () => {
    list = []
    render(<SourceHealthList apiBase="http://b" onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('所有源正常')).toBeTruthy())
  })
})
