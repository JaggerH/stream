import { describe, it, expect, vi } from 'vitest'
import { uninstallExtension, UNINSTALL_EXTENSION_RECIPE } from './extension-uninstall.ts'
import {
  REMOVE_BUTTON,
  CONFIRM_REMOVE_BUTTON,
  EXTENSION_SEARCH_BOX,
  EXTENSION_DISPLAY_NAME,
  OMNIBOX,
  EXTENSIONS_URL,
} from './chrome-ext-page.ts'
import type { DesktopDriver, WindowInfo, AppMatch, A11yQuery } from '../replay/desktop-driver.ts'

const BLANK_WIN = 'about:blank - Google Chrome'
const EXT_WIN = '扩展程序 - Google Chrome'
/** 确认框的标题里带着要删的那个扩展的名字——这条流程的安全闸就建在这上面。 */
const CONFIRM_WIN = `要删除“${EXTENSION_DISPLAY_NAME}”吗？`
const OTHER_CONFIRM_WIN = '要删除“别人的扩展”吗？'
const REMOVE = REMOVE_BUTTON.names[0]
const CONFIRM = CONFIRM_REMOVE_BUTTON.names[0]
const SEARCH = EXTENSION_SEARCH_BOX.names[0]
const OMNI = OMNIBOX.names[0]

/** 确认那一下 = 在确认框范围里发出的那次回车（`type:\n`）。第一次回车是地址栏导航，所以取最后一次。 */
const removedAt = (calls: string[]) => calls.lastIndexOf('type:\n') === calls.indexOf('type:\n') ? -1 : calls.lastIndexOf('type:\n')

const win = (title: string): WindowInfo => ({ id: title, process: 'chrome.exe', title, foreground: false })

type Ctl = { name: string; className?: string }

/**
 * 假 Chrome。两处刻意做得"能露馅"：
 * - 控件带 className（确认框里那个「移除」和卡片上那个同名，只有 className 分得开）；
 * - 点了卡片上的「移除」之后**才**冒出确认框窗口，标题由脚本决定——安全闸就是靠标题认的。
 */
function fakeDriver(script: {
  controls: Record<string, Ctl[]>
  /** 点了卡片「移除」之后冒出来的确认框标题；缺省是我们自己那个 */
  confirmWindow?: string | null
}) {
  const calls: string[] = []
  const windows = new Set([BLANK_WIN])
  const controls: Record<string, Ctl[]> = { ...script.controls }
  let pending = ''
  let scope = ''
  let removed = false
  const confirmTitle = script.confirmWindow === undefined ? CONFIRM_WIN : script.confirmWindow

  const driver = {
    ensureApp: vi.fn(async () => ({ running: true, started: false, process: 'chrome.exe' })),
    windows: vi.fn(async () => [...windows].map(win)),
    focusApp: vi.fn(async (m: AppMatch) => { calls.push(`focusApp:${m.title ?? ''}`); return true }),
    scopeWindow: vi.fn(async (m: AppMatch) => {
      calls.push(`scopeWindow:${m.title ?? ''}`)
      scope = m.title ?? ''
      return win(scope)
    }),
    find: vi.fn(async (q: A11yQuery) => {
      const hit = (controls[scope] ?? []).find(
        (c) => c.name === q.name && (q.className == null || c.className === q.className),
      )
      return {
        elements: hit
          ? [{ ref: `ref:${hit.className ?? ''}:${hit.name}`, role: q.role ?? 'Button', name: hit.name, className: hit.className ?? '', rect: { x: 0, y: 0, w: 1, h: 1 } }]
          : [],
      }
    }),
    invoke: vi.fn(async (ref: string) => {
      calls.push(`invoke:${ref}`)
      // 点卡片上那个「移除」→ 确认框出现（它的控件住在自己那个窗口里）
      if (ref === `ref::${REMOVE}` && confirmTitle) {
        windows.add(confirmTitle)
        controls[confirmTitle] = [{ name: CONFIRM, className: CONFIRM_REMOVE_BUTTON.className }]
      }
      return { via: 'invoke' as const, confirmed: true }
    }),
    setValue: vi.fn(async (ref: string, text: string) => {
      calls.push(`setValue:${ref}=${text}`)
      pending = text
      return { via: 'value' as const, confirmed: true }
    }),
    type: vi.fn(async (text: string) => {
      calls.push(`type:${text}`)
      if (text === '\n') {
        if (pending === EXTENSIONS_URL) {
          windows.delete(BLANK_WIN)
          windows.add(EXT_WIN)
        }
        // 确认框的范围里按回车 = 确认删除（它的默认按钮就是「移除」）
        if (scope.includes(EXTENSION_DISPLAY_NAME)) removed = true
        pending = ''
      } else pending = text
      return { via: 'coords' as const, confirmed: true }
    }),
    // 确认框那个「移除」走的是**坐标点击**（`fallbackClick`）——Chrome 弹层里的 Views 按钮
    // 不吃 UIA invoke。这里把它记下来，测试才能断言"确实点了确认"。
    click: vi.fn(async () => { calls.push('click'); return { via: 'coords' as const } }),
    sleep: vi.fn(async () => {}),
    readSubtree: vi.fn(async () => []),
    screenshot: vi.fn(async () => null),
    url: vi.fn(async () => 'app#win'),
    moveMouse: vi.fn(async () => ({})),
    scroll: vi.fn(async () => ({})),
    status: vi.fn(async () => {}),
  }
  return { calls, driver: driver as unknown as DesktopDriver, removed: () => removed }
}

const happy = {
  controls: {
    [BLANK_WIN]: [{ name: OMNI }],
    [EXT_WIN]: [{ name: SEARCH }, { name: REMOVE }],
  },
}

const deps = (over: Record<string, unknown>) => ({
  waitForDisconnected: vi.fn(async () => true),
  ...over,
}) as unknown as Parameters<typeof uninstallExtension>[0]

describe('卸载扩展', () => {
  it('每一步都能对用户说人话', () => {
    expect(UNINSTALL_EXTENSION_RECIPE.steps.every((s) => !!s.label)).toBe(true)
    expect(UNINSTALL_EXTENSION_RECIPE.allowEmpty).toBe(true)
  })

  it('先搜索再删——不在整页列表上按名字点「移除」', async () => {
    const { driver, calls, removed } = fakeDriver(happy)
    const out = await uninstallExtension(deps({ driver }))
    expect(out).toEqual({ status: 'removed' })
    expect(removed()).toBe(true)
    // 搜索必须发生在点「移除」之前，否则列表上还是一堆同名按钮
    expect(calls.indexOf(`invoke:ref::${SEARCH}`)).toBeLessThan(calls.indexOf(`invoke:ref::${REMOVE}`))
    expect(calls.indexOf(`type:${EXTENSION_DISPLAY_NAME}`)).toBeLessThan(calls.indexOf(`invoke:ref::${REMOVE}`))
  })

  /**
   * **这条是这个文件里最重要的一条。** 搜索万一没生效，上一步的「移除」就点在别人的卡片上，
   * 而那一步照样"成功"。确认框按标题里的扩展名换窗，把这种情况变成当场失败——而不是安静地
   * 删掉别人的扩展。把那个 `window` 步骤摘掉，这条会变红。
   */
  it('确认框问的不是我们那个扩展 → blocked，且一个「确认」都没点', async () => {
    const { driver, calls, removed } = fakeDriver({ ...happy, confirmWindow: OTHER_CONFIRM_WIN })
    const out = await uninstallExtension(deps({ driver }))
    expect(out.status).toBe('blocked')
    expect(removed()).toBe(false)
    expect(removedAt(calls)).toBe(-1)
    expect((out as { reason: string }).reason).toContain(EXTENSION_DISPLAY_NAME)
  })

  it('确认那一下发生在确认框的范围里，且排在卡片「移除」之后', async () => {
    const { driver, calls } = fakeDriver(happy)
    await uninstallExtension(deps({ driver }))
    expect(calls.indexOf(`scopeWindow:${CONFIRM_WIN}`)).toBeGreaterThan(calls.indexOf(`invoke:ref::${REMOVE}`))
    expect(removedAt(calls)).toBeGreaterThan(calls.indexOf(`scopeWindow:${CONFIRM_WIN}`))
  })

  it('步骤跑完但中继还连着 → still-connected，**不许报"卸载成功"**', async () => {
    const { driver } = fakeDriver(happy)
    const out = await uninstallExtension(deps({ driver, waitForDisconnected: async () => false }))
    expect(out).toEqual({ status: 'still-connected' })
  })

  it('页面上没有「移除」（扩展本来就不在）→ blocked，reason 指名是它', async () => {
    const { driver } = fakeDriver({ controls: { [BLANK_WIN]: [{ name: OMNI }], [EXT_WIN]: [{ name: SEARCH }] } })
    const out = await uninstallExtension(deps({ driver }))
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain('移除')
  })

  it('确认框根本没出来 → blocked（扩展没被删掉）', async () => {
    const { driver, removed } = fakeDriver({ ...happy, confirmWindow: null })
    const out = await uninstallExtension(deps({ driver }))
    expect(out.status).toBe('blocked')
    expect(removed()).toBe(false)
  })
})
