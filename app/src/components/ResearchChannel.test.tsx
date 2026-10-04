import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchChannel } from './ResearchChannel.tsx'
import * as api from '../research/artifact.ts'
import { ChannelsProvider } from '../lib/channels.tsx'
import { api as streamApi } from '../lib/api.ts'
import type { ChannelView, WsMessage } from '../lib/types.ts'
import { RUN_GUID_PREFIX } from '@research/run-guid.ts'

// useWs 本身连真实 socket，组件测试里不起真连接——按 EventsProvider.test.tsx 的既有模式，
// mock 掉 hook、直接捕获 onMessage 回调,当作 WS 帧塞进去。
let onMessage: (m: WsMessage) => void = () => {}
vi.mock('../hooks/useWs.ts', () => ({
  useWs: (_url: string, cb: (m: WsMessage) => void) => {
    onMessage = cb
    return () => {}
  },
}))

// ChannelView 的流字段是 `streams: ChannelStream[]`（不是 stream_ids——那是写入 payload 专用的
// 别名，见 lib/types.ts ChannelRecordDto），组件要从这里取 id。
const stream = (id: string): ChannelView['streams'][number] =>
  ({ id, description: id, sources: [], cadence_seconds: 0, vault_subdir: id })

const channel: ChannelView = {
  id: 'rc', label: '研究', kind: 'timeline', present: 'research', space_id: 'default-space',
  streams: [stream('s1'), stream('s2')],
  options: {},
}
const conn = { baseUrl: '', token: '' } as never

beforeEach(() => { vi.restoreAllMocks() })

describe('ResearchChannel 一级列表', () => {
  it('绑了两个流就并发取两次,结果合并', async () => {
    const spy = vi.spyOn(api, 'fetchLiveItems').mockImplementation(async (_c, s) =>
      [{ id: `${s}-r1`, stream_id: s, source_id: 'research-runs', title: `来自${s}`, timestamp: '2026-08-01T00:00:00Z' }] as never)
    render(<ResearchChannel channel={channel} conn={conn} />)
    await waitFor(() => expect(screen.getByText('来自s1')).toBeTruthy())
    expect(screen.getByText('来自s2')).toBeTruthy()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('列表按时间倒序,新的在前', async () => {
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([
      { id: 'old', stream_id: 's1', source_id: 'x', title: '旧', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'new', stream_id: 's1', source_id: 'x', title: '新', timestamp: '2026-08-01T00:00:00Z' },
    ] as never)
    const { container } = render(
      <ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />,
    )
    await waitFor(() => expect(screen.getByText('新')).toBeTruthy())
    expect(container.textContent!.indexOf('新')).toBeLessThan(container.textContent!.indexOf('旧'))
  })

  it('取数失败整页示错,把原文带出来', async () => {
    vi.spyOn(api, 'fetchLiveItems').mockRejectedValue(new Error('artifactsDir 未配置'))
    render(<ResearchChannel channel={channel} conn={conn} />)
    await waitFor(() => expect(screen.getByText(/artifactsDir 未配置/)).toBeTruthy())
  })

  it('收到本频道的 live-changed 就重查', async () => {
    const spy = vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([] as never)
    render(<ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    onMessage({ type: 'live-changed', streamId: 's1' })
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })

  it('别的流的 live-changed 一律不重查', async () => {
    const spy = vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([] as never)
    render(<ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    onMessage({ type: 'live-changed', streamId: 'other' })
    await new Promise((r) => setTimeout(r, 30))
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// 二级详情是本频道自己的子路由(/c/<channelId>/run/<streamId>/<runId>),与 MovieChannel 的
// /c/<id>/item/<id> 同一套 useSubRoute 机制——这里只验证「路由真的接上了」,不重复
// ResearchRunDetail 自己的渲染细节(那已经在 ResearchRunDetail.test.tsx 里锁住)。
describe('ResearchChannel 二级详情路由', () => {
  it('点一行就切到详情,地址栏落在 /c/<channelId>/run/<streamId>/<runId>', async () => {
    // 真实 App.tsx 在挂载频道组件之前,路由同步早就把地址栏落到 /c/<channelId> 了——
    // 组件自己不负责从零起步的 base,这里补上外层已经做过的那一步。
    window.history.pushState(null, '', '/c/rc')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([
      { id: 'r1', stream_id: 's1', source_id: 'x', title: '基线', timestamp: '2026-08-01T00:00:00Z' },
    ] as never)
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue({
      schema: 'run/v1', id: 'r1', name: '基线', variant: null, tags: [], params: {},
      status: 'success', metrics: {}, artifacts: [], created_at: '2026-08-01T00:00:00Z', finished_at: null,
    } as never)
    render(<ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线')).toBeTruthy())
    screen.getByText('基线').closest('button')!.click()
    await waitFor(() => expect(window.location.pathname).toBe('/c/rc/run/s1/r1'))
    // 详情页真的挂载了(不是只推了地址栏)——run 名字来自 manifest,不是列表行。
    await waitFor(() => expect(screen.getByText('这个 run 没有 artifact。')).toBeTruthy())
  })

  // 生产者吐的 id 带 feed guid 前缀（`research-run:<runId>`，见 shared/research/run-guid.ts）。
  // 这条测试**只用生产者真实的形状**，不用手写的 `r1`——之前两侧夹具各写各的，导致整条列表
  // 点进去每一行都 400，而两边的测试都是绿的。
  it('列表行的 id 带 feed guid 前缀时,导航与取详情都用剥完前缀的 run id', async () => {
    window.history.pushState(null, '', '/c/rc')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([
      { id: `${RUN_GUID_PREFIX}20260801-000000-aaaaaa`, stream_id: 's1', source_id: 'research-runs', title: '基线', timestamp: '2026-08-01T00:00:00Z' },
    ] as never)
    const manifest = vi.spyOn(api, 'fetchRunManifest').mockResolvedValue({
      schema: 'run/v1', id: '20260801-000000-aaaaaa', name: '基线', variant: null, tags: [], params: {},
      status: 'success', metrics: {}, artifacts: [], created_at: '2026-08-01T00:00:00Z', finished_at: null,
    } as never)
    render(<ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线')).toBeTruthy())
    screen.getByText('基线').closest('button')!.click()
    await waitFor(() => expect(window.location.pathname).toBe('/c/rc/run/s1/20260801-000000-aaaaaa'))
    expect(manifest).toHaveBeenCalledWith(expect.anything(), 's1', '20260801-000000-aaaaaa')
  })

  it('刷新/深链直接落在 /c/<channelId>/run/<streamId>/<runId> 上,不塌回列表', async () => {
    window.history.pushState(null, '', '/c/rc/run/s1/r7')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([] as never)
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue({
      schema: 'run/v1', id: 'r7', name: '深链落地', variant: null, tags: [], params: {},
      status: 'success', metrics: {}, artifacts: [], created_at: '2026-08-01T00:00:00Z', finished_at: null,
    } as never)
    render(<ResearchChannel channel={channel} conn={conn} />)
    await waitFor(() => expect(screen.getByText('深链落地')).toBeTruthy())
  })

  it('返回列表把地址栏收回频道 base,后退键(popstate)也能回列表', async () => {
    window.history.pushState(null, '', '/c/rc')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([
      { id: 'r1', stream_id: 's1', source_id: 'x', title: '基线', timestamp: '2026-08-01T00:00:00Z' },
    ] as never)
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue({
      schema: 'run/v1', id: 'r1', name: '基线', variant: null, tags: [], params: {},
      status: 'success', metrics: {}, artifacts: [], created_at: '2026-08-01T00:00:00Z', finished_at: null,
    } as never)
    render(<ResearchChannel channel={{ ...channel, streams: [stream('s1')] }} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线')).toBeTruthy())
    screen.getByText('基线').closest('button')!.click()
    await waitFor(() => expect(screen.getByText('← 返回列表')).toBeTruthy())
    screen.getByText('← 返回列表').click()
    await waitFor(() => expect(window.location.pathname).toBe('/c/rc'))
    expect(screen.getByText('基线')).toBeTruthy() // 列表行,不是详情标题——回到列表了
  })
})

// 顶栏是与音乐/影视档对齐的那一格（49px、图标 + 标题菜单 + 搜索），底下跟着「内容 | 配置」
// 那条分页。这几条盯的是
// "对齐"这件事本身：少一件就是这个 Present 在同一个壳里长得跟别人不一样。
describe('ResearchChannel 顶栏', () => {
  const twoRuns = [
    { id: 'r1', stream_id: 's1', source_id: 'x', title: '基线回测', timestamp: '2026-08-02T00:00:00Z' },
    { id: 'r2', stream_id: 's1', source_id: 'x', title: '压力测试', timestamp: '2026-08-01T00:00:00Z' },
  ]
  const one = { ...channel, streams: [stream('s1')] }

  it('画频道名 + 搜索框 + 内容/配置分页', async () => {
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue(twoRuns as never)
    render(<ResearchChannel channel={one} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线回测')).toBeTruthy())
    expect(screen.getByText('研究')).toBeTruthy()
    expect(screen.getByLabelText('搜索 run')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '配置' })).toBeTruthy()
  })

  it('搜索框只筛已取回的这一批,不重新打接口', async () => {
    const spy = vi.spyOn(api, 'fetchLiveItems').mockResolvedValue(twoRuns as never)
    render(<ResearchChannel channel={one} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线回测')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('搜索 run'), { target: { value: '压力' } })
    await waitFor(() => expect(screen.queryByText('基线回测')).toBeNull())
    expect(screen.getByText('压力测试')).toBeTruthy()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('筛没了说"没有匹配",不说"还没有 run"——两句话指向的处置完全不同', async () => {
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue(twoRuns as never)
    render(<ResearchChannel channel={one} conn={conn} />)
    await waitFor(() => expect(screen.getByText('基线回测')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('搜索 run'), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByText('没有匹配的 run。')).toBeTruthy())
  })

  it('详情态不画顶栏(详情自带返回键,不叠第二条)', async () => {
    window.history.pushState(null, '', '/c/rc/run/s1/r7')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue([] as never)
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue({
      schema: 'run/v1', id: 'r7', name: '深链落地', variant: null, tags: [], params: {},
      status: 'success', metrics: {}, artifacts: [], created_at: '2026-08-01T00:00:00Z', finished_at: null,
    } as never)
    render(<ResearchChannel channel={one} conn={conn} />)
    await waitFor(() => expect(screen.getByText('深链落地')).toBeTruthy())
    expect(screen.queryByLabelText('搜索 run')).toBeNull()
    expect(screen.queryByRole('tab', { name: '配置' })).toBeNull()
  })

  it('切到配置页出频道配置面(订阅/绑定的数据源就在这里改)', async () => {
    window.history.pushState(null, '', '/c/rc')
    vi.spyOn(api, 'fetchLiveItems').mockResolvedValue(twoRuns as never)
    vi.spyOn(streamApi, 'channels').mockResolvedValue([one] as never)
    vi.spyOn(streamApi, 'presents').mockResolvedValue({
      items: [{ id: 'research', label: '研究', needsStreams: true, data: 'live', slots: [] }],
    } as never)
    vi.spyOn(streamApi, 'providers').mockResolvedValue([] as never)
    vi.spyOn(streamApi, 'streams').mockResolvedValue([] as never)
    render(
      <ChannelsProvider conn={conn}>
        <ResearchChannel channel={one} conn={conn} />
      </ChannelsProvider>,
    )
    await waitFor(() => expect(screen.getByText('基线回测')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: '配置' }))
    // live 档的那句话——配置面按 present.data 自己判，这里只核它确实配的是本频道。
    await waitFor(() => expect(screen.getByText('绑定的数据源')).toBeTruthy())
  })
})
