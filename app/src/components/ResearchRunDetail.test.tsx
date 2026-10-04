import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ResearchRunDetail } from './ResearchRunDetail.tsx'
import * as api from '../research/artifact.ts'

const conn = { baseUrl: '', token: '' } as never
const manifest = {
  schema: 'run/v1', id: 'r1', name: '基线', variant: null, tags: ['t'], params: {},
  status: 'success', metrics: { sharpe: 1.23 },
  // 这份清单是回归闸门的夹具,形状是有讲究的——老设计有**两种**独立的丢弃方式,
  // 各要一个对应物才钉得住:
  //   ①view 不在它那个四项联合里 → 整条丢弃      → 'no-such' 与 'text' 负责
  //   ②同一 view 只取第一个                      → 三个 'table' 负责
  // 少了任何一类,某天有人重新引入「按 view 去重」都不会有测试变红。
  artifacts: [
    { name: 'a', view: 'table' },
    { name: 'a2', view: 'table' },
    { name: 'a3', view: 'table' },
    { name: 'b', view: 'text' },
    { name: 'c', view: 'no-such' },
  ],
  created_at: '2026-08-01T00:00:00Z', finished_at: '2026-08-01T00:01:00Z',
}

beforeEach(() => { vi.restoreAllMocks() })

describe('ResearchRunDetail', () => {
  it('卡片数 == manifest.artifacts.length（回归闸门：上一版只显示 9.4%）', async () => {
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue(manifest as never)
    vi.spyOn(api, 'fetchArtifact').mockImplementation(async (_c, _s, _r, name) =>
      ({ schema: 'artifact/v1', view: 'text', name, data: 'x', config: {} }) as never)
    const { container } = render(<ResearchRunDetail conn={conn} streamId="s1" runId="r1" onBack={() => {}} />)
    await waitFor(() => expect(container.querySelectorAll('[data-artifact-card]')).toHaveLength(manifest.artifacts.length))
  })

  it('每个 artifact 独立拉一次数（懒拉，不打包）', async () => {
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue(manifest as never)
    const spy = vi.spyOn(api, 'fetchArtifact').mockResolvedValue({ schema: 'artifact/v1', view: 'text', name: 'x', data: '', config: {} } as never)
    render(<ResearchRunDetail conn={conn} streamId="s1" runId="r1" onBack={() => {}} />)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(manifest.artifacts.length))
  })

  it('单个 artifact 拉失败只影响那张卡,其余照常', async () => {
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue(manifest as never)
    vi.spyOn(api, 'fetchArtifact').mockImplementation(async (_c, _s, _r, name) => {
      if (name === 'b') throw new Error('cannot read artifact /d/r1/b.json')
      return { schema: 'artifact/v1', view: 'text', name, data: 'ok', config: {} } as never
    })
    const { container } = render(<ResearchRunDetail conn={conn} streamId="s1" runId="r1" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/cannot read artifact/)).toBeTruthy())
    // 卡片一张不少——失败的那一张只是内容换成了错误文案,不是从列表里消失。
    expect(container.querySelectorAll('[data-artifact-card]')).toHaveLength(manifest.artifacts.length)
    const cards = Array.from(container.querySelectorAll('[data-artifact-card]'))
    expect(cards.some((c) => /载入中|ok/.test(c.textContent ?? ''))).toBe(true)
  })

  it('指标摊出来', async () => {
    vi.spyOn(api, 'fetchRunManifest').mockResolvedValue(manifest as never)
    vi.spyOn(api, 'fetchArtifact').mockResolvedValue({ schema: 'artifact/v1', view: 'text', name: 'x', data: '', config: {} } as never)
    render(<ResearchRunDetail conn={conn} streamId="s1" runId="r1" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('sharpe')).toBeTruthy())
    expect(screen.getByText('1.23')).toBeTruthy()
  })

  it('manifest 读不到 → 整页一句人话', async () => {
    vi.spyOn(api, 'fetchRunManifest').mockRejectedValue(new Error('cannot read /d/r9/run.json'))
    render(<ResearchRunDetail conn={conn} streamId="s1" runId="r9" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/cannot read/)).toBeTruthy())
  })
})
