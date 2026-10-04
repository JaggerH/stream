import { describe, it, expect, vi } from 'vitest'
import { buildMcpExtras } from './mcp-extras.ts'
import type { ActResult } from '../replay/interactive-gate.ts'

// ── cdp_look / cdp_act（target:chrome:<tabId>）：作用在**已存在的** tabId 上 ──
// 这是"接管任意 tab"真正落地的地方。少了它们，cdp_pages 就是个只能看不能碰的清单：
// AI 认得出目标 tab，却没有任何工具能作用在那个 tabId 上。
function fakeBoot() {
  let href = 'https://a.example/x'
  const extRelay = {
    list: vi.fn(async () => [{ tabId: 42, url: href, title: 'A' }]),
    sendCommand: vi.fn(async (_tabId: number, method: string, params?: unknown) => {
      if (method === 'Page.navigate') return { ok: true }
      if (method !== 'Runtime.evaluate') return { ok: true }
      const expr = String((params as { expression?: string } | undefined)?.expression ?? '')
      if (expr.includes('getBoundingClientRect')) return { result: { value: { x: 10, y: 20 } } }
      if (expr.includes('innerWidth')) return { result: { value: { x: 640, y: 400 } } }
      if (expr.includes('readyState')) return { result: { value: { href, state: 'complete' } } }
      if (expr.includes('location.href')) return { result: { value: href } }
      return { result: { value: '标题' } }
    }),
    closeTab: vi.fn(async () => {}),
  }
  // 没有 session manager：act/look 作用在已存在的 tab 上，不需要租约
  return { extRelay } as never
}

describe('cdp_look(target:chrome:<tabId>) —— 读一眼某个已存在的 tab', () => {
  it('返回 {value}（拆过包），不是 CDP 原始回包', async () => {
    const extras = buildMcpExtras(fakeBoot())
    await expect(extras.cdpLook!({ target: 'chrome:42', js: 'document.title' })).resolves.toEqual({ value: '标题' })
  })
})

describe('cdp_act(target:chrome:<tabId>) —— 在已存在的 tab 上动手', () => {
  it('非高危动作直行，落成 trusted 输入', async () => {
    const boot = fakeBoot() as unknown as { extRelay: { sendCommand: { mock: { calls: unknown[][] } } } }
    const extras = buildMcpExtras(boot as never)

    const r = (await extras.cdpAct!({ target: 'chrome:42', kind: 'click', domain: 'a.example', selector: '#go' })) as ActResult

    expect(r.status).toBe('done')
    const pressed = boot.extRelay.sendCommand.mock.calls.filter(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type?: string })?.type === 'mousePressed',
    )
    expect(pressed).toHaveLength(1)
  })

  it('【门】高危动作默认不执行，返回待确认 + 理由，绝不先斩后奏', async () => {
    const boot = fakeBoot() as unknown as { extRelay: { sendCommand: { mock: { calls: unknown[][] } } } }
    const extras = buildMcpExtras(boot as never)

    const r = (await extras.cdpAct!({ target: 'chrome:42', kind: 'submit', domain: 'a.example', selector: '#f' })) as ActResult

    expect(r.status).toBe('needs-confirmation')
    expect(r.reason).toBeTruthy()
    // 一条命令都没发出去
    expect(boot.extRelay.sendCommand.mock.calls).toHaveLength(0)
  })

  it('confirmed:true（用户确认过）后高危动作才执行', async () => {
    const boot = fakeBoot() as unknown as { extRelay: { sendCommand: { mock: { calls: unknown[][] } } } }
    const extras = buildMcpExtras(boot as never)

    const r = (await extras.cdpAct!({
      target: 'chrome:42',
      kind: 'submit',
      domain: 'a.example',
      selector: '#f',
      confirmed: true,
    })) as ActResult

    expect(r.status).toBe('done')
    expect(boot.extRelay.sendCommand.mock.calls.some((c) => c[1] === 'Input.dispatchKeyEvent')).toBe(true)
  })
})
