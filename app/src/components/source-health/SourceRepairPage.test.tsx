import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceRepairPage } from './SourceRepairPage.tsx'
import type { SourceHealthView } from '../../lib/api.source-health.ts'

const base: SourceHealthView = {
  source: { id: '@s/xhs/xhs-detail', title: '笔记详情', pluginName: 'Recipe' },
  status: 'quarantined',
  health: { state: 'dead', lastAt: '2026-09-12T01:00:00Z', lastError: '第 2 步 expect 落空', lastErrorCategory: 'drift' },
  quarantine: { since: '2026-09-12T01:00:00Z', reason: '第 2 步 expect 落空', recipeVersion: 3, attempts: 0, affectedSources: ['@s/xhs/xhs-detail', '@s/xhs/xhs-home'] },
  affectedChannels: [{ id: 'c1', label: '小红书' }],
}
const usage = { promptTokens: 1200, completionTokens: 300, turns: 4, wallMs: 90_000, reported: true }
const posted: string[] = []
let view: SourceHealthView

beforeEach(() => {
  cleanup(); posted.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://b', '')
    if (init?.method === 'POST') { posted.push(path + (init.body ? ' ' + String(init.body) : '')); return new Response(JSON.stringify({ ok: true, runId: 'r-new' }), { status: 200 }) }
    if (path.startsWith('/api/source-health/')) return new Response(JSON.stringify(view), { status: 200 })
    if (path.includes('/events')) return new Response(JSON.stringify({ events: [{ seq: 1, kind: 'tool_call', at: 'x', title: '看截图' }, { seq: 2, kind: 'heartbeat', at: 'x', title: 'hb' }] }), { status: 200 })
    if (path.startsWith('/api/interventions?')) return new Response(JSON.stringify({ runs: [], pending: 0 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})

describe('SourceRepairPage 四格', () => {
  it('只关禁：第 ① 格高亮，原因翻人话、连累频道列出；有「让 agent 修」', async () => {
    view = base
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-1').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText(/页面结构和 recipe 对不上了/)).toBeTruthy()
    expect(screen.getByText('小红书')).toBeTruthy()
    fireEvent.click(screen.getByText('让 agent 修'))
    await waitFor(() => expect(posted[0]).toMatch(/\/api\/interventions\/repairs .*xhs-detail/))
  })

  it('等你拍板：第 ③ 格高亮，只有那一条许可、两个按钮；点允许 POST 到对应 permission', async () => {
    view = { ...base, status: 'awaiting', run: { id: 'r1', status: 'awaiting_confirmation', startedAt: '2026-09-12T01:01:00Z', usage, limits: { maxTurns: 12, maxTokens: 1_500_000, maxWallMinutes: 30 }, now: '看截图', pending: { permissionId: 'p1', title: '点击「登录」按钮', reason: '要进详情页', options: [{ optionId: 'y', name: '允许', kind: 'allow_once' }, { optionId: 'n', name: '拒绝', kind: 'reject_once' }] } } }
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-3').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText(/点击「登录」按钮/)).toBeTruthy()
    expect(screen.getByText(/要进详情页/)).toBeTruthy()
    expect(screen.getByText(/4 轮 \/ 12/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    await waitFor(() => expect(posted[0]).toBe('/api/interventions/r1/permissions/p1 {"optionId":"y"}'))
  })

  it('paused：第 ③ 格是预算拍板，「再给一段」走 continue、「停」走 cancel', async () => {
    view = { ...base, status: 'awaiting', run: { id: 'r1', status: 'paused', startedAt: 'x', usage, lastStatusNote: '暂停：撞闸 gate:turns', stopped: { produced: 'nothing', reason: 'gate:turns' } } }
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-3').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText(/轮数用完/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /再给一段/ }))
    await waitFor(() => expect(posted[0]).toBe('/api/interventions/r1/continue'))
    fireEvent.click(screen.getByRole('button', { name: '停' }))
    await waitFor(() => expect(posted[1]).toBe('/api/interventions/r1/cancel'))
  })

  it('待写回：第 ④ 格高亮，步骤级 diff 与校验一句话；「写回」POST accept', async () => {
    view = { ...base, status: 'proposed', run: { id: 'r1', status: 'done', startedAt: 'x', usage }, proposal: { id: 'p9', status: 'pending', recipePath: '/pkg/xhs-detail.recipe.json', validation: { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' }, diff: [{ step: 2, kind: 'changed', field: 'selector', before: '.old', after: '.new' }, { step: 4, kind: 'removed', before: { do: 'wait' } }] } }
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-4').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText(/第 2 步 · selector/)).toBeTruthy()
    expect(screen.getByText(/第 4 步 · 删掉整步/)).toBeTruthy()
    expect(screen.getByText(/结构合法.*没跑活体试抓/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '写回 recipe' }))
    await waitFor(() => expect(posted[0]).toMatch(/\/api\/interventions\/proposals\/p9\/accept/))
  })

  it('探索中：四格换探索版，第 ② 格报进度；graph 提议的第 ④ 格是「并进状态图」', async () => {
    view = {
      ...base, status: 'exploring',
      run: { id: 'r-ex', status: 'running', startedAt: 'x', usage, now: '在看首页那一屏' },
      exploration: { runId: 'r-ex', status: 'running', states: 2, transitions: 1, remaining: 3 },
    }
    const { unmount } = render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-2').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText('要探什么')).toBeTruthy()
    expect(screen.getByText('在探')).toBeTruthy()
    expect(screen.getByText('已记 2 个状态、1 条边，frontier 还剩 3')).toBeTruthy()
    expect(screen.getByText(/在看首页那一屏/)).toBeTruthy()
    expect(screen.getByText(/4 轮/)).toBeTruthy()
    unmount()

    view = {
      ...base, status: 'proposed',
      run: { id: 'r-ex', status: 'done', startedAt: 'x', usage },
      // 探完之后 `exploration` 按约定缺席：计数只能来自草稿自己那一格。
      proposal: { id: 'p-g', kind: 'graph', status: 'pending', recipePath: '', validation: { schema: 'n/a', version: 'n/a', assertions: 'n/a', probe: 'n/a' }, diff: [], graph: { states: 5, transitions: 6 } },
    }
    const { unmount: unmount2 } = render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-4').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText('探好了')).toBeTruthy()
    expect(screen.getByText('5 个状态、6 条边')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '写回 recipe' })).toBeNull()
    // validation 四格全 n/a：一句校验话都不该有（「结构合法」「没跑活体试抓」都是 recipe 的词）。
    expect(screen.queryByText(/结构合法|结构不合法|活体试抓/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '并进状态图' }))
    await waitFor(() => expect(posted[0]).toMatch(/\/api\/interventions\/proposals\/p-g\/accept/))
    unmount2()

    // 草稿那一格缺席时才退到正在探的现场的计数。
    view = {
      ...base, status: 'proposed',
      run: { id: 'r-ex', status: 'done', startedAt: 'x', usage },
      exploration: { runId: 'r-ex', status: 'done', states: 9, transitions: 12, remaining: 0 },
      proposal: { id: 'p-g', kind: 'graph', status: 'pending', recipePath: '', validation: { schema: 'n/a', version: 'n/a', assertions: 'n/a', probe: 'n/a' }, diff: [] },
    }
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('9 个状态、12 条边')).toBeTruthy())
  })

  it('修不了：第 ④ 格写 agent 的判定，给「重试」；详情抽屉收着，展开后心跳只剩一条', async () => {
    view = { ...base, status: 'unrepairable', run: { id: 'r1', status: 'stopped', startedAt: 'x', usage, stopped: { produced: 'verdict-unrepairable', reason: 'end_turn' }, lastStatusNote: '收尾：agent 判定修不了——站点改版成了 SPA' } }
    render(<SourceRepairPage apiBase="http://b" sourceId={base.source.id} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('stage-4').getAttribute('data-current')).toBe('true'))
    expect(screen.getByText(/agent 判定修不了/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.queryByText('看截图')).toBeNull()
    fireEvent.click(screen.getByText('详情'))
    await waitFor(() => expect(screen.getByText('看截图')).toBeTruthy())
    expect(screen.getAllByText(/心跳/).length).toBe(1)
  })
})
