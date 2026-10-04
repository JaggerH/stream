/**
 * 后端地址那条线：**host 半注入 → 浏览器半读 → 缺席时说人话**。
 *
 * 为什么这条线值得一整个测试文件：它的两种失败都**很安静**。
 *   - 注入这一步没做（或行 config 丢了 `streamBaseUrl`）→ 页面上没有那个常量，主区什么
 *     都不画。空白和"后端挂了"、"面板崩了"长得一模一样。
 *   - 反过来，回落到一个写死的地址 → 在作者自己机器上一切正常，在别人机器上是一堆
 *     指向 127.0.0.1:8900 的 404。
 * 所以这里钉两头：注进去的确实是那个地址；没注进去时画的是**一句人话**而不是空白。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { STREAM_UI_GLOBAL, normalizeBackendUrl } from '../src/wire.ts'
import { apply as hostApply, injectStreamUiConfig, type StreamUiHostContext } from '../src/index.ts'
import { BACKEND_MISSING_MESSAGE, readBackendUrl } from '../src/client/backend.ts'
import { channelUrl, configureBackend, timelineUrl } from '../src/deep-links.ts'
import { DeepLink } from '../src/client/cards/frame.tsx'

vi.mock('../src/client/panel/host.ts', () => ({
  mountPanelInto: vi.fn(() => Promise.resolve({ unmount: () => {} })),
  mountNavInto: vi.fn(() => Promise.resolve({ unmount: () => {} })),
}))

const { makeStreamShell } = await import('../src/client/shell/StreamShell.tsx')
const { ShellLayoutController } = await import('../src/client/shell/layout-service.ts')
const panelHost = await import('../src/client/panel/host.ts')

/** 一个只记账的 host ctx 替身：`inject` 同步跑回调（软门在场时的行为）。 */
function fakeHostCtx() {
  const taps: Array<(html: string) => string> = []
  const warnings: string[] = []
  const injected: string[][] = []
  const ctx: StreamUiHostContext = {
    inject: (deps, cb) => { injected.push(deps); cb(ctx) },
    effect: (setup) => { setup() },
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    webServer: { tapIndex: (t) => { taps.push(t); return () => {} } },
  }
  return { ctx, taps, warnings, injected }
}

describe('normalizeBackendUrl', () => {
  it('去尾斜杠', () => {
    expect(normalizeBackendUrl('http://box.lan:4555/')).toBe('http://box.lan:4555')
  })
  it('非 http(s) 绝对地址一律判成没配（半截地址会拼出没有出处的 404）', () => {
    for (const bad of [undefined, null, 42, '', '   ', '127.0.0.1:8900', '/api', 'ftp://x']) {
      expect(normalizeBackendUrl(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('host 半：把地址注进页面', () => {
  it('有配置 → 注入 window.__STREAM_UI__，且挂在 webServer 软门后面', () => {
    const { ctx, taps, injected } = fakeHostCtx()
    hostApply(ctx, { streamBaseUrl: 'http://box.lan:4555/' })
    expect(injected).toEqual([['webServer']])
    expect(taps).toHaveLength(1)
    const html = taps[0]!('<html><head><title>x</title></head><body></body></html>')
    expect(html).toContain(`window.${STREAM_UI_GLOBAL} = {"backendUrl":"http://box.lan:4555"}`)
    // 注在 <head> 开头：壳的任何脚本执行之前它就在了。
    expect(html.indexOf('__STREAM_UI__')).toBeLessThan(html.indexOf('<title>'))
  })

  it('没配置 → 不注入、不抛，warn 一句（一个渲染包不该把工作台装载搞崩）', () => {
    const { ctx, taps, warnings } = fakeHostCtx()
    hostApply(ctx, {})
    expect(taps).toHaveLength(0)
    expect(warnings.join('\n')).toContain('streamBaseUrl')
  })

  it('注入的 JSON 里 `<` 被转义（配置值不能提前闭合 script）', () => {
    expect(injectStreamUiConfig('<head></head>', { backendUrl: 'http://x</script><b>' }))
      .not.toContain('</script><b>')
  })
})

describe('浏览器半：读那个常量', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[STREAM_UI_GLOBAL]
  })

  it('页面上有 → 读出来', () => {
    ;(globalThis as Record<string, unknown>)[STREAM_UI_GLOBAL] = { backendUrl: 'http://box.lan:4555' }
    expect(readBackendUrl()).toBe('http://box.lan:4555')
  })

  it('页面上没有 / 形状不对 → undefined（不回落到任何写死的地址）', () => {
    expect(readBackendUrl()).toBeUndefined()
    ;(globalThis as Record<string, unknown>)[STREAM_UI_GLOBAL] = { backendUrl: 42 }
    expect(readBackendUrl()).toBeUndefined()
  })
})

describe('地址缺席时的行为：说人话，不是白屏', () => {
  beforeEach(() => { cleanup() })

  it('壳的主区画那句人话，且**不去装面板资产**（没有地址可取）', () => {
    const Shell = makeStreamShell(new ShellLayoutController(), undefined, () => {}, async () => {})
    render(<Shell renderSlot={() => null} />)
    expect(screen.getByText(BACKEND_MISSING_MESSAGE)).toBeTruthy()
    expect(panelHost.mountPanelInto).not.toHaveBeenCalled()
  })

  it('有地址时照常把面板挂进主区', () => {
    const Shell = makeStreamShell(new ShellLayoutController(), 'http://box.lan:4555', () => {}, async () => {})
    render(<Shell renderSlot={() => null} />)
    expect(screen.queryByText(BACKEND_MISSING_MESSAGE)).toBeNull()
    expect(panelHost.mountPanelInto).toHaveBeenCalled()
  })

  it('深链降级成不可点的文本，而不是指向别处的死链', () => {
    configureBackend(undefined)
    expect(timelineUrl()).toBeUndefined()
    expect(channelUrl('music')).toBeUndefined()
    const { container } = render(<DeepLink href={channelUrl('music')}>去音乐</DeepLink>)
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('去音乐')).toBeTruthy()
  })

  it('配上地址后深链恢复', () => {
    configureBackend('http://box.lan:4555/')
    expect(timelineUrl()).toBe('http://box.lan:4555/timeline')
    expect(channelUrl('a b')).toBe('http://box.lan:4555/c/a%20b')
  })
})
