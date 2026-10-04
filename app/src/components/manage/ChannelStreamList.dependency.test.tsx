/**
 * 「这个源绿着，但它依赖的东西坏了」在订阅列表里的露出。
 *
 * 钉的是那个静音故障：xhs 的 home 采集次次成功、健康点是绿的，而共用的 detail 一漂，点开每条
 * 笔记都是空的。这条提示是界面上唯一说得出这件事的地方——没了它，页面上一切正常。
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api.ts')>()
  return { ...mod, api: { ...mod.api, channels: vi.fn(async () => []), streams: vi.fn(async () => []) } }
})

import { ChannelStreamList } from './ChannelStreamList.tsx'
import { ChannelsProvider } from '../../lib/channels.tsx'
import type { ChannelView, DependencyIssue } from '../../lib/types.ts'

const conn = { baseUrl: '' } as never

function channelWith(dependencyIssues?: DependencyIssue[]): ChannelView {
  return {
    id: 'c1', label: '小红书', kind: 'timeline', present: 'timeline',
    streams: [{
      id: 's1', description: '首页流', cadence_seconds: 3600, vault_subdir: '',
      sources: [{
        source: {
          id: '@streamapp/xhs/xhs-home', pluginId: 'replay', pluginName: 'Recipe', title: 'HomeFeed',
          categories: [], capabilities: ['timeline'], auth: 'none', paramCount: 0, requiredParamCount: 0,
        },
        params: {},
        health: 'healthy',
        ...(dependencyIssues ? { dependencyIssues } : {}),
      }],
    }],
  } as unknown as ChannelView
}

const renderList = (issues?: DependencyIssue[]) =>
  render(
    <ChannelsProvider conn={conn}>
      <ChannelStreamList conn={conn} channel={channelWith(issues)} title="订阅列表" />
    </ChannelsProvider>,
  )

describe('ChannelStreamList — 依赖出问题的提示', () => {
  it('依赖坏了 → 在这一行说出来（自己的健康点仍是绿的，这条是唯一的出口）', () => {
    renderList([{ kind: 'broken', id: '@streamapp/xhs/xhs-detail', title: '笔记详情（enrich）', health: 'dead' }])
    expect(screen.getByText(/依赖的「笔记详情（enrich）」失效/)).toBeTruthy()
    expect(screen.getByText(/内容可能是残的/)).toBeTruthy()
  })

  it('没有依赖问题 → 一个字都不出现（今天全库只有一条 uses 关系，常驻就是噪音）', () => {
    renderList()
    expect(screen.queryByText(/内容可能是残的/)).toBeNull()
    expect(screen.queryByText(/依赖的/)).toBeNull()
  })

  it('依赖解析不到 → 照样说出来：答案里的洞不是噪音，压掉它就是把「没验到」讲成「验过了」', () => {
    renderList([{ kind: 'unresolved', id: '@someone/pkg/their-detail' }])
    expect(screen.getByText(/申报依赖的「@someone\/pkg\/their-detail」找不到/)).toBeTruthy()
  })

  it('降级和失效说的是两个词，不混成一句「有问题」', () => {
    renderList([{ kind: 'broken', id: 'x/dep', health: 'degraded' }])
    expect(screen.getByText(/依赖的「x\/dep」降级/)).toBeTruthy()
  })

  it('两条问题各占一行，不合并成一句', () => {
    renderList([
      { kind: 'broken', id: 'x/dep', health: 'dead' },
      { kind: 'unresolved', id: 'y/gone' },
    ])
    expect(screen.getAllByText(/内容可能是残的/).length).toBe(2)
  })
})
