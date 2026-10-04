import { describe, it, expect, vi } from 'vitest'
import { readExtensionConsole, READ_EXTENSION_CONSOLE_RECIPE, levelOf } from './extension-console.ts'
import { OMNIBOX, BLANK_URL, extensionDetailUrl, SERVICE_WORKER_LINK } from './chrome-ext-page.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import type { DesktopDriver, WindowInfo, AppMatch, A11yQuery, A11yElement } from '../replay/desktop-driver.ts'

const BLANK_WIN = 'about:blank - Google Chrome'
const DETAIL_WIN = '扩展程序 - Stream Companion - Google Chrome'
const DEVTOOLS_WIN = 'DevTools'
const DETAIL_URL = extensionDetailUrl(STREAM_EXTENSION_ID)
const WS_ERR = "WebSocket connection to 'ws://127.0.0.1:8900/api/ext' failed: WebSocket opening handshake timed out"

const win = (title: string): WindowInfo => ({ id: title, process: 'chrome.exe', title, foreground: false })
type Ctl = { role: string; name: string; className?: string }
const el = (c: Ctl): A11yElement => ({ ref: `ref:${c.name}`, role: c.role, name: c.name, className: c.className ?? '', rect: { x: 0, y: 0, w: 1, h: 1 } })

/** 假 Chrome：地址栏回车进详情页；点「Service Worker」冒出 DevTools 窗口，里面是给定的控制台节点。 */
function fakeDriver(opts: { swLink?: boolean; consoleNodes: Ctl[] }) {
  const windows = new Set([BLANK_WIN])
  const controls: Record<string, Ctl[]> = { [BLANK_WIN]: [{ role: 'Edit', name: OMNIBOX.names[0] }] }
  let pending = ''
  let scope = ''
  const driver = {
    ensureApp: vi.fn(async () => ({ running: true, started: true, process: 'chrome.exe' })),
    windows: vi.fn(async () => [...windows].map(win)),
    focusApp: vi.fn(async () => true),
    scopeWindow: vi.fn(async (m: AppMatch) => { scope = m.title ?? ''; return win(scope) }),
    find: vi.fn(async (q: A11yQuery) => ({
      elements: (controls[scope] ?? [])
        .filter((c) => (q.role == null || c.role === q.role) && (q.name == null || c.name === q.name))
        .map(el),
    })),
    invoke: vi.fn(async (ref: string) => {
      if (ref === `ref:${SERVICE_WORKER_LINK.name}`) {
        windows.add(DEVTOOLS_WIN)
        controls[DEVTOOLS_WIN] = [{ role: 'TabItem', name: 'Console' }, ...opts.consoleNodes]
      }
      return { via: 'invoke' as const, confirmed: true }
    }),
    setValue: vi.fn(async (_r: string, text: string) => { pending = text; return { via: 'value' as const, confirmed: true } }),
    type: vi.fn(async (text: string) => {
      if (text === '\n' && pending === DETAIL_URL) {
        windows.delete(BLANK_WIN)
        windows.add(DETAIL_WIN)
        controls[DETAIL_WIN] = opts.swLink === false ? [] : [{ role: 'Hyperlink', name: SERVICE_WORKER_LINK.name }]
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
  return { driver: driver as unknown as DesktopDriver, raw: driver }
}

describe('读扩展后台控制台（全程 Stream Desktop，不碰中继）', () => {
  it('每一步都能对用户说人话', () => {
    expect(READ_EXTENSION_CONSOLE_RECIPE.steps.every((s) => !!s.label)).toBe(true)
  })

  it('详情页 → Service Worker → DevTools，只收控制台消息节点，级别取自 className', async () => {
    const { driver, raw } = fakeDriver({
      consoleNodes: [
        { role: 'Group', name: WS_ERR, className: 'console-message-wrapper console-error-level' },
        // 同一条消息的堆栈折叠层：className 不同，不能重复收
        { role: 'Group', name: ` ${WS_ERR} Stack table collapsed`, className: 'console-message-stack-trace-wrapper' },
        { role: 'Group', name: '[pairing] ok', className: 'console-message-wrapper console-warning-level' },
      ],
    })
    const out = await readExtensionConsole(driver)
    expect(raw.ensureApp).toHaveBeenCalledWith({ args: [BLANK_URL], force: true })
    expect(out).toEqual({
      status: 'ok',
      messages: [
        { level: 'error', text: WS_ERR },
        { level: 'warning', text: '[pairing] ok' },
      ],
    })
  })

  it('控制台是空的 → ok + 空数组（不是 blocked）', async () => {
    const { driver } = fakeDriver({ consoleNodes: [] })
    expect(await readExtensionConsole(driver)).toEqual({ status: 'ok', messages: [] })
  })

  it('详情页上没有「Service Worker」（后台没在跑）→ blocked，reason 说出来', async () => {
    const { driver } = fakeDriver({ swLink: false, consoleNodes: [] })
    const out = await readExtensionConsole(driver)
    expect(out.status).toBe('blocked')
    expect((out as { reason: string }).reason).toContain('Service Worker')
  })

  it('levelOf', () => {
    expect(levelOf('console-message-wrapper console-info-level')).toBe('info')
    expect(levelOf('console-message-wrapper')).toBe('unknown')
  })
})
