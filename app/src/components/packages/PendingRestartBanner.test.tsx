import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PendingRestartBanner } from './PendingRestartBanner.tsx'
import type { PendingChange } from '../../lib/types.ts'

const pending: PendingChange[] = [
  { name: '@streamapp/mineru', kind: 'updated', from: '1.0.0', to: '1.0.1', needsRestart: true, why: '容器要重启后按 x:1.0.1 重建' },
  // 热生效的那条不算「等待重启」：标题的计数只数 needsRestart，它也不该出现在清单里。
  { name: '@streamapp/foo-recipes', kind: 'installed', to: '0.1.0', needsRestart: false, why: 'recipe 数据热生效' },
]

describe('PendingRestartBanner', () => {
  it('列出待重启项，点「现在重启」调 restart(false)；409 后列任务、按钮变强制；点强制 → restart(true)', async () => {
    const restart = vi.fn(async (force: boolean) =>
      force
        ? ({ status: 202 as const, mode: 'supervised' as const })
        : ({ status: 409 as const, running: [{ id: 'x', label: '东财登录' }] })
    )
    const onRestarted = vi.fn()
    render(<PendingRestartBanner pending={pending} restart={restart} onRestarted={onRestarted} />)
    expect(screen.getByText(/1 项变更等待重启生效/)).toBeTruthy()
    expect(screen.getByText(/@streamapp\/mineru/)).toBeTruthy()
    expect(screen.queryByText(/foo-recipes/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /现在重启/ }))
    await waitFor(() => expect(restart).toHaveBeenLastCalledWith(false))
    await waitFor(() => expect(screen.getByText(/东财登录/)).toBeTruthy())
    expect(onRestarted).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /强制重启/ }))
    await waitFor(() => expect(restart).toHaveBeenLastCalledWith(true))
    await waitFor(() => expect(onRestarted).toHaveBeenCalledTimes(1))
    // 202 之后横幅进入「后端重启中…」，按钮不再可点（重复点会叠一次 restart）。
    expect(screen.getByText(/后端重启中/)).toBeTruthy()
  })

  it('没有 needsRestart 的项时什么都不画', () => {
    const { container } = render(
      <PendingRestartBanner pending={[pending[1]]} restart={vi.fn()} onRestarted={vi.fn()} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('restart 抛错 → 横幅回到可点状态并显示原话', async () => {
    const restart = vi.fn(async () => { throw new Error('restart not configured') })
    render(<PendingRestartBanner pending={pending} restart={restart} onRestarted={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /现在重启/ }))
    await waitFor(() => expect(screen.getByText(/restart not configured/)).toBeTruthy())
    expect((screen.getByRole('button', { name: /现在重启/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
