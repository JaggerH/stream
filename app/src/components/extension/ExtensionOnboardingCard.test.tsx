import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ExtensionOnboardingCard, type ExtensionOnboardingActions } from './ExtensionOnboardingCard.tsx'

/** 本仓库没装 `@testing-library/user-event`（worktree 里也不能加依赖），点击一律走
 *  `fireEvent`——和 `AuthPanel.test.tsx` 等既有测试同一个写法。 */
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

/** 假的动作面。真身是 `extensionActions(conn)`（三个端点的薄封装），组件只吃这个接口——
 *  测试因此不用去桩 fetch，也不会因为 api 模块换写法而红。 */
const fakeActions = (over: Partial<ExtensionOnboardingActions> = {}): ExtensionOnboardingActions => ({
  materialize: vi.fn(async () => ({ dir: 'C:\\data\\extension', source: 'repo' })),
  install: vi.fn(async () => ({ status: 'connected' as const })),
  decline: vi.fn(async () => {}),
  ...over,
})

describe('扩展安装引导卡片', () => {
  it('先说为什么再说做什么——用户此刻不知道扩展和他想追的内容有什么关系', () => {
    render(<ExtensionOnboardingCard variant="banner" actions={fakeActions()} />)
    expect(screen.getByText(/登录态/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '帮我装' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '我自己来' })).toBeTruthy()
  })

  it('点「帮我装」先出确认，且确认文案里必须写着开发者模式气泡那件事', async () => {
    render(<ExtensionOnboardingCard variant="banner" actions={fakeActions()} />)
    click('帮我装')
    expect(screen.getByText(/开发者模式扩展/)).toBeTruthy()
    expect(screen.getByText(/Ctrl\+Alt\+Esc/)).toBeTruthy()
  })

  it('确认之前一个动作都不发——「先说清会发生什么」不是文案，是时序', async () => {
    const actions = fakeActions()
    render(<ExtensionOnboardingCard variant="banner" actions={actions} />)
    click('帮我装')
    expect(actions.install).not.toHaveBeenCalled()
  })

  it('needs-chrome-restart 不显示成「安装失败」，而是给重启 Chrome 的下一步', async () => {
    const actions = fakeActions({ install: async () => ({ status: 'needs-chrome-restart' as const }) })
    render(<ExtensionOnboardingCard variant="banner" actions={actions} />)
    click('帮我装')
    click('确认')
    await waitFor(() => expect(screen.getByText(/重启一次/)).toBeTruthy())
    expect(screen.queryByText(/安装失败/)).toBeNull()
  })

  it('blocked 时把 reason 原样显示出来——不许收成一句「装不上」', async () => {
    const actions = fakeActions({
      install: async () => ({ status: 'blocked' as const, reason: '找不到「开发者模式」开关' }),
    })
    render(<ExtensionOnboardingCard variant="banner" actions={actions} />)
    click('帮我装')
    click('确认')
    await waitFor(() => expect(screen.getByText(/找不到「开发者模式」开关/)).toBeTruthy())
  })

  it('代装根本没跑起来（端点抛错）也要说人话，不是静默什么都不发生', async () => {
    const actions = fakeActions({
      install: async () => {
        throw new Error('Stream Desktop 没连上')
      },
    })
    render(<ExtensionOnboardingCard variant="banner" actions={actions} />)
    click('帮我装')
    click('确认')
    await waitFor(() => expect(screen.getByText(/Stream Desktop 没连上/)).toBeTruthy())
  })

  it('「我自己来」给出的目录路径，和代装用的是同一个（materialize 的返回）', async () => {
    const actions = fakeActions()
    render(<ExtensionOnboardingCard variant="banner" actions={actions} />)
    click('我自己来')
    await waitFor(() => expect(screen.getByText(/C:\\data\\extension/)).toBeTruthy())
  })

  it('「以后再说」记一条并让调用方收起横幅——现场提示那条路不受影响', async () => {
    const actions = fakeActions()
    const onDismiss = vi.fn()
    render(<ExtensionOnboardingCard variant="banner" actions={actions} onDismiss={onDismiss} />)
    click('以后再说')
    await waitFor(() => expect(actions.decline).toHaveBeenCalledTimes(1))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('现场那一档（inline）不给「以后再说」——他正要用这个能力，收起来只会让他卡在原地', () => {
    render(<ExtensionOnboardingCard variant="inline" actions={fakeActions()} />)
    expect(screen.queryByRole('button', { name: '以后再说' })).toBeNull()
    expect(screen.getByRole('button', { name: '帮我装' })).toBeTruthy()
  })
})
