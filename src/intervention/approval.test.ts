import { describe, it, expect } from 'vitest'
import type { RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk'
import { classifyPermission, classifyPermissionExplore, pickOption } from './approval.ts'

const W = '/data/repair-work/r1/xhs'
const req = (toolCall: RequestPermissionRequest['toolCall']): RequestPermissionRequest => ({
  sessionId: 's', toolCall,
  options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }],
})

describe('classifyPermission', () => {
  it('读类 kind 放行：read / search / think / fetch', () => {
    for (const kind of ['read', 'search', 'think', 'fetch'] as const)
      expect(classifyPermission(req({ toolCallId: '1', kind, title: 'x' }), W).verdict).toBe('allow')
  })
  it('写副本内的文件放行；写副本外的要问', () => {
    expect(classifyPermission(req({ toolCallId: '1', kind: 'edit', locations: [{ path: `${W}/xhs-search.recipe.json` }] }), W).verdict).toBe('allow')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'edit', locations: [{ path: '/home/u/.bashrc' }] }), W).verdict).toBe('ask')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'edit', locations: [{ path: `${W}/../escape.json` }] }), W).verdict).toBe('ask')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'edit' }), W).verdict).toBe('ask') // 没说写哪 = 不放
  })
  it('delete/move 副本内放行；副本外要问', () => {
    expect(classifyPermission(req({ toolCallId: '1', kind: 'delete', locations: [{ path: `${W}/old.recipe.json` }] }), W).verdict).toBe('allow')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'delete', locations: [{ path: '/home/u/.bashrc' }] }), W).verdict).toBe('ask')
  })
  it('execute 一律问', () => {
    expect(classifyPermission(req({ toolCallId: '1', kind: 'execute', title: 'bash: ls' }), W).verdict).toBe('ask')
  })
  it('我们的只读 cdp 工具放行（按 title / name 认）；cdp_act 只放 scroll/exists/look', () => {
    expect(classifyPermission(req({ toolCallId: '1', kind: 'other', name: 'mcp__stream__cdp_look' }), W).verdict).toBe('allow')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'other', title: 'cdp_shot', rawInput: {} }), W).verdict).toBe('allow')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'other', name: 'cdp_act', rawInput: { kind: 'scroll' } }), W).verdict).toBe('allow')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'other', name: 'cdp_act', rawInput: { kind: 'click' } }), W).verdict).toBe('ask')
    expect(classifyPermission(req({ toolCallId: '1', kind: 'other', name: 'cdp_act' }), W).verdict).toBe('ask')
  })
  it('没见过的工具、没 kind → 问', () => {
    expect(classifyPermission(req({ toolCallId: '1', name: 'mystery' }), W).verdict).toBe('ask')
  })
})

describe('classifyPermissionExplore：探索 run 的门', () => {
  it('cdp_look/shot/pages 放；cdp_act 只放 scroll/exists/look，其余拒；写文件与执行命令拒', () => {
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_shot' })).verdict).toBe('allow')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'mcp__stream__cdp_look' })).verdict).toBe('allow')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_pages' })).verdict).toBe('allow')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_act', rawInput: { kind: 'exists' } })).verdict).toBe('allow')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_act', rawInput: { kind: 'click' } })))
      .toMatchObject({ verdict: 'reject', why: expect.stringContaining('graph_act') })
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_act', rawInput: { kind: 'type' } })).verdict).toBe('reject')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'cdp_act' })).verdict).toBe('reject')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'Write', kind: 'edit' })).verdict).toBe('reject')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'bash', kind: 'execute' })).verdict).toBe('reject')
  })
  it('读类 kind 照放；没见过的动作拒（不是等人——探索期越界是拒）', () => {
    for (const kind of ['read', 'search', 'think', 'fetch'] as const)
      expect(classifyPermissionExplore(req({ toolCallId: 't', kind, title: 'x' })).verdict).toBe('allow')
    expect(classifyPermissionExplore(req({ toolCallId: 't', name: 'mystery' })).verdict).toBe('reject')
  })
})

describe('pickOption', () => {
  const opts: PermissionOption[] = [
    { optionId: 'aa', name: 'Always', kind: 'allow_always' }, { optionId: 'a', name: 'Once', kind: 'allow_once' },
    { optionId: 'r', name: 'No', kind: 'reject_once' },
  ]
  it('allow 优先 allow_once，没有再 allow_always；reject 同理', () => {
    expect(pickOption(opts, 'allow')?.optionId).toBe('a')
    expect(pickOption(opts.filter((o) => o.kind !== 'allow_once'), 'allow')?.optionId).toBe('aa')
    expect(pickOption(opts, 'reject')?.optionId).toBe('r')
    expect(pickOption([], 'allow')).toBeUndefined()
  })
})
