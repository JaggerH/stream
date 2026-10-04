import { describe, it, expect, vi } from 'vitest'
import { reloadExtension, RELOAD_EXTENSION_RECIPE } from './extension-reload.ts'
import { EXTENSION_RELOAD_BUTTON, OMNIBOX, BLANK_URL, extensionDetailUrl } from './chrome-ext-page.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import type { DesktopDriver, WindowInfo, AppMatch, A11yQuery } from '../replay/desktop-driver.ts'

const BLANK_WIN = 'about:blank - Google Chrome'
/** 详情页的**真标题**（活体读到的），中间夹着扩展名——不是列表页那个「扩展程序 - Google Chrome」。 */
const EXT_WIN = '扩展程序 - Stream Companion - Google Chrome'
const DETAIL_URL = extensionDetailUrl(STREAM_EXTENSION_ID)
const RELOAD = EXTENSION_RELOAD_BUTTON.names[0]

const win = (title: string): WindowInfo => ({ id: title, process: 'chrome.exe', title, foreground: false })
type Ctl = { name: string; className?: string }

/**
 * 假 Chrome。刻意"能露馅"的一处：详情页窗口里有**两枚**叫「重新加载」的按钮——卡片上那枚
 * （`icon-refresh no-overlap`）和浏览器工具栏的刷新（`ReloadButton`）。点错了只会刷新页面。
 */
function fakeDriver(pageControls: Ctl[]) {
  const calls: string[] = []
  const windows = new Set([BLANK_WIN])
  const controls: Record<string, Ctl[]> = { [BLANK_WIN]: [{ name: OMNIBOX.names[0] }] }
  let pending = ''
  let scope = ''
  const driver = {
    ensureApp: vi.fn(async () => ({ running: true, started: true, process: 'chrome.exe' })),
    windows: vi.fn(async () => [...windows].map(win)),
    focusApp: vi.fn(async (m: AppMatch) => { calls.push(`focusApp:${m.title ?? ''}`); return true }),
    scopeWindow: vi.fn(async (m: AppMatch) => { scope = m.title ?? ''; return win(scope) }),
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
    invoke: vi.fn(async (ref: string) => { calls.push(`invoke:${ref}`); return { via: 'invoke' as const, confirmed: true } }),
    setValue: vi.fn(async (_ref: string, text: string) => { pending = text; return { via: 'value' as const, confirmed: true } }),
    type: vi.fn(async (text: string) => {
      if (text === '\n' && pending === DETAIL_URL) {
        windows.delete(BLANK_WIN)
        windows.add(EXT_WIN)
        controls[EXT_WIN] = pageControls
      }
      return { via: 'coords' as const, confirmed: true }
    }),
    click: vi.fn(async () => ({ via: 'coords' as const })),
    sleep: vi.fn(async () => {}),
    readSubtree: vi.fn(async () => []),
    screenshot: vi.fn(async () => null),
    url: vi.fn(async () => 'app#win'),
    moveMouse: vi.fn(async () => ({})),
    scroll: vi.fn(async () => ({})),
    status: vi.fn(async () => {}),
  }
  return { calls, driver: driver as unknown as DesktopDriver, raw: driver }
}

const bothButtons: Ctl[] = [
  { name: RELOAD, className: 'ReloadButton' },
  { name: RELOAD, className: EXTENSION_RELOAD_BUTTON.className },
]

describe('重载扩展（全程 Stream Desktop，不碰中继）', () => {
  it('每一步都能对用户说人话', () => {
    expect(RELOAD_EXTENSION_RECIPE.steps.every((s) => !!s.label)).toBe(true)
  })

  it('开普通窗口（force）→ 地址栏进详情页 → 点卡片那枚，不是工具栏刷新 → 以新 since 判成功', async () => {
    const { driver, calls, raw } = fakeDriver(bothButtons)
    const waitForReconnect = vi.fn(async () => 'T2')
    const out = await reloadExtension({ driver, relaySince: () => 'T1', waitForReconnect })
    expect(out).toEqual({ status: 'reloaded', since: 'T2' })
    // chrome:// 不能从命令行进：先开 about:blank；Chrome 在跑也得开出窗口，所以 force
    expect(raw.ensureApp).toHaveBeenCalledWith({ args: [BLANK_URL], force: true })
    expect(raw.setValue).toHaveBeenCalledWith(expect.anything(), DETAIL_URL)
    expect(calls.filter((c) => c.startsWith('invoke:'))).toEqual([`invoke:ref:${EXTENSION_RELOAD_BUTTON.className}:${RELOAD}`])
    // 基线是点之前的 since——"换没换新连接"要和它比
    expect(waitForReconnect).toHaveBeenCalledWith('T1')
  })

  it('中继断着（since=null）也照跑——这正是它存在的理由', async () => {
    const { driver } = fakeDriver(bothButtons)
    const out = await reloadExtension({ driver, relaySince: () => null, waitForReconnect: async (b) => (b === null ? 'T9' : null) })
    expect(out).toEqual({ status: 'reloaded', since: 'T9' })
  })

  it('点了但中继没以新连接回来 → no-reconnect，**不许报"重载成功"**', async () => {
    const { driver } = fakeDriver(bothButtons)
    const out = await reloadExtension({ driver, relaySince: () => 'T1', waitForReconnect: async () => null })
    expect(out).toEqual({ status: 'no-reconnect' })
  })

  it('详情页上只有工具栏刷新（扩展不是未打包装的）→ blocked，一枚都没点', async () => {
    const { driver, calls } = fakeDriver([{ name: RELOAD, className: 'ReloadButton' }])
    const out = await reloadExtension({ driver, relaySince: () => 'T1', waitForReconnect: async () => 'T2' })
    expect(out.status).toBe('blocked')
    expect(calls.some((c) => c.startsWith('invoke:'))).toBe(false)
  })
})
