import { describe, it, expect } from 'vitest'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import type { StreamService } from './tools.ts'

// 统一 cdp facade 回归锁。
//
// 「看/动一个活页面」曾是三套动词分家（chrome_* 按 tabId、facility_* 按 facility）——
// 想法相同、地址不同,却各自长出了自己的一套工具。收敛之后是一套动词（look/shot/act/pages）
// + 一个 `target` 参数（chrome[:tabId] / facility:<name> / desktop）选终端,不再是每加一个
// 终端就多一批工具。这个锁钉住的就是这四个动词的曲面本身:存在、按需注册、`target` 贯穿到底。

const fakeService = {} as StreamService

/** 四个都填上，好让 catalog 把它们对应的工具都注册出来（presence 是全有或全无）。 */
const allExtras: McpExtras = {
  isCommunitySource: () => false,
  cdpLook: async () => ({ value: null }),
  cdpShot: async () => ({ shot: null }),
  cdpAct: async () => ({ status: 'done' }),
  cdpPages: async () => ({ pages: [] }),
}
const names = (extras: McpExtras) => new Set(toolCatalog(fakeService, extras).map((t) => t.name))

describe('cdp facade surface', () => {
  it('exposes exactly the four cdp_* verbs when wired', () => {
    const n = names(allExtras)
    for (const v of ['cdp_look', 'cdp_shot', 'cdp_act', 'cdp_pages']) expect(n.has(v)).toBe(true)
    for (const gone of ['chrome_cdp', 'chrome_look', 'chrome_act', 'facility_look', 'facility_act']) expect(n.has(gone)).toBe(false)
  })
  it('every cdp_* verb takes a target', () => {
    for (const t of toolCatalog(fakeService, allExtras)) {
      if (t.name.startsWith('cdp_')) expect(Object.keys(t.schema)).toContain('target')
    }
  })
  it('cdp_act carries the full action shape', () => {
    const act = toolCatalog(fakeService, allExtras).find((t) => t.name === 'cdp_act')!
    for (const k of ['target', 'kind', 'domain', 'selector', 'text', 'targetUrl', 'px', 'expression', 'expect', 'intent', 'confirmed'])
      expect(Object.keys(act.schema)).toContain(k)
  })
  it('registers nothing browser-side when extras are empty', () => {
    const n = names({ isCommunitySource: () => false })
    for (const v of ['cdp_look', 'cdp_shot', 'cdp_act', 'cdp_pages']) expect(n.has(v)).toBe(false)
  })
  // shared/browser-relay/tool-specs.test.ts 只钉住生成器本身（chrome-only vs 四档齐全的文本
  // 差异）；它证明不了 Stream 的 catalog 真的在调那个生成器，而不是一份被人重新写死回
  // tool-catalog.ts 里的冻结拷贝——那样改动的话生成器那份守卫依旧全绿，整个任务悄悄失效。
  // 这里只需钉住 `facility:` 真的出现在**注册进 catalog 的** cdp_act 描述里。
  it('cdp_act 的描述是从共享生成器渲染出来的（含 facility 档），不是写死的冻结拷贝', () => {
    const act = toolCatalog(fakeService, allExtras).find((t) => t.name === 'cdp_act')!
    expect(act.description).toContain('facility:')
  })
})
