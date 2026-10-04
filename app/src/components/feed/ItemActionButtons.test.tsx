import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { api, type ActionResult, type ActionRunView } from '../../lib/api.ts'
import type { ItemActionView } from '@item/actions.ts'
import { ItemActionButtons } from './ItemActionButtons.tsx'

const toastError = vi.fn()
vi.mock('../acrylic/sonner.tsx', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

/** 后端投影出来的样子（包的 `stream.item.actions` 代入参数之后）。 */
const RECIPE = '@acme/demo/demo-like'
const ACTIONS: ItemActionView[] = [
  { id: 'like', icon: 'heart', label: '点赞', recipe: RECIPE, params: { postId: 'n1' }, toggle: ['like', 'unlike'] },
  { id: 'collect', icon: 'bookmark', label: '收藏', recipe: RECIPE, params: { postId: 'n1' }, toggle: ['collect', 'uncollect'] },
]

const done = (action: string): ActionResult =>
  ({ status: 'done', sourceId: RECIPE, items: [{ postId: 'n1', action, ok: 'true' }] })

describe('ItemActionButtons', () => {
  beforeEach(() => {
    toastError.mockClear()
    vi.restoreAllMocks()
  })

  it('没有动作 → 什么都不画', () => {
    const { container } = render(<ItemActionButtons actions={[]} />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('optimistically presses and runs the declared recipe with confirmed:true + toggle[0]', async () => {
    const spy = vi.spyOn(api, 'runAction').mockResolvedValue(done('like'))
    render(<ItemActionButtons actions={ACTIONS} counts={{ like: 10 }} />)
    const like = screen.getByRole('button', { name: '点赞' })
    expect(like.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(like)
    // optimistic: pressed immediately + count bumped, before the request resolves
    expect(screen.getByRole('button', { name: '取消点赞' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('11')).toBeTruthy()
    // 用户点的那一下就是二次确认：直接带 confirmed:true，走通用动作路由。recipe 与参数全来自包的声明。
    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      sourceId: RECIPE,
      params: { postId: 'n1', action: 'like' },
      confirmed: true,
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '取消点赞' }).getAttribute('aria-pressed')).toBe('true'))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('pressing again sends toggle[1]', async () => {
    const spy = vi.spyOn(api, 'runAction').mockResolvedValue(done('x'))
    render(<ItemActionButtons actions={ACTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })   // 让第一下的 finally 收尾（busy 复位）
    fireEvent.click(screen.getByRole('button', { name: '取消收藏' }))
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ params: { postId: 'n1', action: 'uncollect' } }))
  })

  it('rolls back and toasts when the request itself fails', async () => {
    vi.spyOn(api, 'runAction').mockRejectedValue(new Error('POST /api/recipes/action → 500'))
    render(<ItemActionButtons actions={ACTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' }).getAttribute('aria-pressed')).toBe('false'))
    expect(toastError).toHaveBeenCalledWith('收藏失败', { description: 'POST /api/recipes/action → 500' })
  })

  // 动作路由把"没做成"当 200 原样回（blocked / needs-login / …），`post` 不会替我们抛——
  // 组件必须自己看 status。
  it('rolls back and toasts the reason when the action route reports a non-done status', async () => {
    vi.spyOn(api, 'runAction').mockResolvedValue({ status: 'blocked', sourceId: RECIPE, reason: '该条暂不支持收藏' })
    render(<ItemActionButtons actions={ACTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    expect(screen.getByRole('button', { name: '取消收藏' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' }).getAttribute('aria-pressed')).toBe('false'))
    expect(toastError).toHaveBeenCalledWith('收藏失败', { description: '该条暂不支持收藏' })
  })

  it('polls the run until it settles when the route answers running', async () => {
    vi.spyOn(api, 'runAction').mockResolvedValue({ status: 'running', sourceId: RECIPE, runId: 'r1' })
    const views: ActionRunView[] = [
      { runId: 'r1', domain: 'action', status: 'running', sourceId: RECIPE, note: '' } as ActionRunView,
      { runId: 'r1', domain: 'action', status: 'done', sourceId: RECIPE, result: done('like'), note: '' } as ActionRunView,
    ]
    const poll = vi.spyOn(api, 'actionRun').mockImplementation(async () => views.shift()!)
    render(<ItemActionButtons actions={ACTIONS} pollIntervalMs={1} />)
    fireEvent.click(screen.getByRole('button', { name: '点赞' }))
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2))
    expect(poll).toHaveBeenCalledWith(expect.anything(), 'r1')
    expect(screen.getByRole('button', { name: '取消点赞' }).getAttribute('aria-pressed')).toBe('true')
    expect(toastError).not.toHaveBeenCalled()
  })

  // run 的 status 与 result.status 是两层：run 跑完了但动作本身没做成也要回滚。
  it('rolls back when the polled run finishes but the action itself did not succeed', async () => {
    vi.spyOn(api, 'runAction').mockResolvedValue({ status: 'running', sourceId: RECIPE, runId: 'r1' })
    vi.spyOn(api, 'actionRun').mockResolvedValue({
      runId: 'r1', domain: 'action', status: 'done', sourceId: RECIPE, note: '',
      result: { status: 'needs-login', sourceId: RECIPE, reason: '要重新登录' },
    } as ActionRunView)
    render(<ItemActionButtons actions={ACTIONS} pollIntervalMs={1} />)
    fireEvent.click(screen.getByRole('button', { name: '点赞' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '点赞' }).getAttribute('aria-pressed')).toBe('false'))
    expect(toastError).toHaveBeenCalledWith('点赞失败', { description: '要重新登录' })
  })

  // 卡片随时会被滚出虚拟列表卸掉，而轮询最长 30s：卸载后循环必须停，且不能再 setState / toast。
  it('stops polling on unmount and never toasts for a component that is gone', async () => {
    vi.spyOn(api, 'runAction').mockResolvedValue({ status: 'running', sourceId: RECIPE, runId: 'r1' })
    const poll = vi.spyOn(api, 'actionRun').mockResolvedValue({
      runId: 'r1', domain: 'action', status: 'running', sourceId: RECIPE, note: '',
    } as ActionRunView)
    const { unmount } = render(<ItemActionButtons actions={ACTIONS} pollIntervalMs={1} pollMaxMs={10_000} />)
    fireEvent.click(screen.getByRole('button', { name: '点赞' }))
    await waitFor(() => expect(poll).toHaveBeenCalled())
    unmount()
    await new Promise((r) => setTimeout(r, 5))
    const after = poll.mock.calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(poll.mock.calls.length).toBe(after)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('gives up polling after the deadline and says the outcome is unknown', async () => {
    vi.spyOn(api, 'runAction').mockResolvedValue({ status: 'running', sourceId: RECIPE, runId: 'r1' })
    vi.spyOn(api, 'actionRun').mockResolvedValue({
      runId: 'r1', domain: 'action', status: 'running', sourceId: RECIPE, note: '',
    } as ActionRunView)
    render(<ItemActionButtons actions={ACTIONS} pollIntervalMs={1} pollMaxMs={5} />)
    fireEvent.click(screen.getByRole('button', { name: '点赞' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '点赞' }).getAttribute('aria-pressed')).toBe('false'))
    expect(toastError).toHaveBeenCalledWith('点赞失败', { description: expect.stringContaining('还没跑完') })
  })
})
