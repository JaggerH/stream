import { describe, it, expect } from 'vitest'
import { cdpToolSpecs, ALL_CDP_TIERS } from './tool-specs.ts'

/**
 * **说明书不许撒谎。** 这四段描述是模型驱动一张活页面时手里唯一的手册；里面每一句"你可以用
 * `facility:<name>`"都是一条承诺。承诺给一个**根本不存在这一档**的宿主（DSH 插件只有 chrome），
 * 模型就会去试、拿到一个说明书宣称合法的失败，然后重试或者把原因归到别处。
 *
 * 这类缺陷**没有任何一处会喊**：工具跑得动、schema 合法、日志干净。所以守卫只能立在文本上。
 */
describe('cdpToolSpecs —— 描述按宿主真有的档位生成', () => {
  // `data-stream-el` 不属于这份名单：它是 `ref` 的选择器属性，chrome-only 那份里同样会出现
  // （见 actDescription 里 ref 那句，不挂在任何 tier 开关下面），放进「只属于别的档」的名单
  // 会在下一次把它挪进 chrome-only 缺失回路时炸出一条假红。
  const OTHER_TIER_MARKERS = ['facility:', 'desktop', 'app:<process>', 'a11y'] as const

  it('chrome-only 宿主：四段描述里不出现 facility: / desktop / app:', () => {
    for (const spec of cdpToolSpecs(['chrome'])) {
      const d = spec.description
      expect(d, `${spec.name} 提到了 facility:`).not.toMatch(/facility:/)
      expect(d, `${spec.name} 提到了 desktop`).not.toMatch(/desktop/i)
      expect(d, `${spec.name} 提到了 app:<process>`).not.toMatch(/app:<process>/)
      // 原生窗口那一档的专有名词也不许漏出来（它们只在那一档成立）。
      expect(d, `${spec.name} 提到了 a11y`).not.toMatch(/a11y/i)
    }
  })

  it('chrome-only 宿主：参数表里没有只服务原生窗口的 exe / args', () => {
    const act = cdpToolSpecs(['chrome']).find((s) => s.name === 'cdp_act')!
    const names = act.parameters.map((p) => p.name)
    expect(names).not.toContain('exe')
    expect(names).not.toContain('args')
    // 但 chrome 档自己的参数一个不少。
    expect(names).toEqual(expect.arrayContaining(['target', 'kind', 'domain', 'ref', 'targetUrl', 'confirmed']))
  })

  it('Stream（三档齐全）：三档在描述里都点到名', () => {
    const all = cdpToolSpecs(ALL_CDP_TIERS)
    const joined = all.map((s) => s.description).join('\n')
    for (const marker of OTHER_TIER_MARKERS) expect(joined).toContain(marker)
    // 逐个动词也要对得上自己的面：cdp_look 三档都列，cdp_act 的 target 一栏也是这三档。
    const look = all.find((s) => s.name === 'cdp_look')!.description
    for (const m of ['`chrome`', '`facility:<name>`', '`desktop`']) expect(look).toContain(m)
    const act = all.find((s) => s.name === 'cdp_act')!.description
    const targetSegment = act.split('`target`: ')[1]!.split(' `domain` is the hostname')[0]!
    const targetTokens = targetSegment.replace(/\.$/, '').split(' / ')
    expect(targetTokens).toContain('chrome:<tabId>')
    expect(targetTokens).toContain('facility:<name>')
    expect(cdpToolSpecs(ALL_CDP_TIERS).find((s) => s.name === 'cdp_act')!.parameters.map((p) => p.name)).toContain('exe')
  })

  it('每一段都保住了跨档通用的那几条硬经验（不许在重构里被摘掉）', () => {
    for (const tiers of [['chrome'] as const, ALL_CDP_TIERS]) {
      const byName = new Map(cdpToolSpecs(tiers).map((s) => [s.name, s.description]))
      // ref 编号是会话脚手架，不是稳定选择器——丢了这句，模型会把 ref 写进 recipe。
      expect(byName.get('cdp_look')).toContain('SESSION SCAFFOLDING')
      // 「点了但什么都没匹配上」必须与「做完了」分开。
      expect(byName.get('cdp_act')).toContain("{status:'not-found'}")
      // 高危动作的二次确认闸。
      expect(byName.get('cdp_act')).toContain("{status:'needs-confirmation'}")
    }
  })

  it('缺 chrome 档直接拒绝——这四个动词的骨架就长在它上面', () => {
    expect(() => cdpToolSpecs(['facility'])).toThrow(/chrome/)
  })
})
