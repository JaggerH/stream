import { describe, it, expect, vi } from 'vitest'
import { buildMcpExtras } from './mcp-extras.ts'

// 用户定的规则：**关闭是清理工作，不是这个操作的一部分**。
// - interactive:true = 给人看的 → 开了不关，让用户真的看见 AI 在干活（关掉正好把目的否了）。
// - interactive:false = 后台静默探针 → 采完即关，回收资源。
// 留下的 tab 不泄漏：它在会话标签组里，SW 重启由 reapOrphanTabs 按出身兜底，用户也能随手关。
//
// 走的是统一 cdp facade：target:'chrome' + url 落到 cdp_look 的 chromeCdp 分支（cdp-router.ts）。

function fakeBoot() {
  const close = vi.fn(async () => {})
  const launch = vi.fn(async () => ({ rawPage: { tabId: 42, evalExpr: async () => 'value' }, close }))
  return { boot: { extLauncher: { launch } } as never, close, launch }
}

describe('cdp_look(target:chrome)：关闭是命令，不是强制 finally', () => {
  it('interactive:true（给人看的）→ 求值后不关，tab 留在用户眼前', async () => {
    const { boot, close } = fakeBoot()
    const extras = buildMcpExtras(boot)
    const r = await extras.cdpLook!({ target: 'chrome', url: 'https://a.example/x', js: 'document.title', interactive: true })
    expect(r).toMatchObject({ value: 'value' })
    expect(close).not.toHaveBeenCalled()
  })

  it('interactive:true 返回 target —— 留着的 tab 得可寻址（AI 之后能直接拿 target 传给 cdp_look/cdp_act/cdp_shot/cdp_pages）', async () => {
    const { boot } = fakeBoot()
    const extras = buildMcpExtras(boot)
    const r = await extras.cdpLook!({ target: 'chrome', url: 'https://a.example/x', js: '1', interactive: true })
    expect(r).toEqual({ value: 'value', target: 'chrome:42', kept: true })
  })

  it('interactive:false（后台静默）→ 采完即关，回收', async () => {
    const { boot, close } = fakeBoot()
    const extras = buildMcpExtras(boot)
    await extras.cdpLook!({ target: 'chrome', url: 'https://a.example/x', js: '1', interactive: false })
    expect(close).toHaveBeenCalled()
  })

  it('缺省（不传 interactive）→ 按静默处理，采完即关', async () => {
    const { boot, close } = fakeBoot()
    const extras = buildMcpExtras(boot)
    await extras.cdpLook!({ target: 'chrome', url: 'https://a.example/x', js: '1' })
    expect(close).toHaveBeenCalled()
  })

  it('求值抛错时：静默档仍关（清理），交互档仍不关（留着给人看现场）', async () => {
    const boom = new Error('eval boom')
    const closeSilent = vi.fn(async () => {})
    const silentBoot = {
      extLauncher: {
        launch: async () => ({
          rawPage: {
            tabId: 1,
            evalExpr: async () => {
              throw boom
            },
          },
          close: closeSilent,
        }),
      },
    } as never
    await expect(
      buildMcpExtras(silentBoot).cdpLook!({ target: 'chrome', url: 'u', js: 'x', interactive: false })
    ).rejects.toThrow('eval boom')
    expect(closeSilent).toHaveBeenCalled()

    const closeInteractive = vi.fn(async () => {})
    const interactiveBoot = {
      extLauncher: {
        launch: async () => ({
          rawPage: {
            tabId: 1,
            evalExpr: async () => {
              throw boom
            },
          },
          close: closeInteractive,
        }),
      },
    } as never
    await expect(
      buildMcpExtras(interactiveBoot).cdpLook!({ target: 'chrome', url: 'u', js: 'x', interactive: true })
    ).rejects.toThrow('eval boom')
    expect(closeInteractive).not.toHaveBeenCalled() // 现场留着，好让人看到哪儿炸了
  })
})
