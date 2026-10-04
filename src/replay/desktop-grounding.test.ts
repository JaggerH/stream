// src/replay/desktop-grounding.test.ts
import { describe, it, expect } from 'vitest'
import {
  satisfiesRange, isValidRange, keyMatches, specificity, groundingBody, sameBody, rankGroundings, effectiveStep,
  assertTemplatesKept, resolveArea, AREA_BODY_KEYS, type Grounding,
} from './desktop-grounding.ts'

describe('satisfiesRange', () => {
  it('支持 >= > <= < = 与裸版本，空格 = AND', () => {
    expect(satisfiesRange('4.0.6', '>=4.0 <4.1')).toBe(true)
    expect(satisfiesRange('4.1.0', '>=4.0 <4.1')).toBe(false)
    expect(satisfiesRange('4.0.6', '4.0.6')).toBe(true)
    expect(satisfiesRange('4.0.6', '=4.0.6')).toBe(true)
    expect(satisfiesRange('4.0.6.1', '>4.0.6')).toBe(true)
    expect(satisfiesRange('3.9', '<=3.9')).toBe(true)
  })
  it('版本里的非数字尾巴忽略；认不出的区间片段一律不匹配', () => {
    expect(satisfiesRange('4.0.6-beta', '>=4.0.6')).toBe(true)
    expect(satisfiesRange('4.0.6', '^4.0')).toBe(false)
    expect(satisfiesRange('4.0.6', '')).toBe(false)
  })
  /** 装载期校验吃的是这一个，和 `satisfiesRange` 共用同一段比较子正则——两份语法定义漂了，
   *  表现是「装载放行、运行时永不匹配」，那条落地方式就此静默消失。 */
  it('isValidRange 认得的语法 = satisfiesRange 认得的语法', () => {
    expect(isValidRange('>=4.0 <4.1')).toBe(true)
    expect(isValidRange('^4')).toBe(false)
  })
})

describe('keyMatches / specificity', () => {
  it('没写的键不限；写了的键要相符', () => {
    expect(keyMatches({}, { platform: 'win32' })).toBe(true)
    expect(keyMatches({ platform: 'darwin' }, { platform: 'win32' })).toBe(false)
    expect(keyMatches({ platform: 'win32', app: '>=4.0' }, { platform: 'win32', appVersion: '4.0.6' })).toBe(true)
    expect(keyMatches({ platform: 'win32', app: '>=4.0' }, { platform: 'win32' })).toBe(false) // appVersion 缺席 → app 区间不匹配
    expect(keyMatches({ platform: 'win32' }, {})).toBe(false)                                 // agent 没报平台
    expect(keyMatches({ lang: 'zh' }, { platform: 'win32', lang: 'zh' })).toBe(true)
  })
  it('specificity = 写了的键数', () => {
    expect(specificity({})).toBe(0)
    expect(specificity({ platform: 'win32', app: '>=4' })).toBe(2)
  })
})

describe('groundingBody / sameBody', () => {
  it('body 去掉 on / verified / note / ref / origin / shadowed', () => {
    expect(groundingBody({ on: {}, verified: { runs: 1, first: 'a', last: 'a', by: 'ai' }, note: 'n', kind: 'click', at: { x: 1, y: 1 } }))
      .toEqual({ kind: 'click', at: { x: 1, y: 1 } })
  })
  it('sameBody 不看键顺序', () => {
    expect(sameBody({ kind: 'click', at: { x: 1, y: 2 } }, { at: { y: 2, x: 1 }, kind: 'click' })).toBe(true)
    expect(sameBody({ kind: 'click', at: { x: 1, y: 2 } }, { kind: 'click', at: { x: 1, y: 3 } })).toBe(false)
  })
})

describe('rankGroundings', () => {
  const step = {
    label: 'L', kind: 'click', at: { x: 0.5, y: 0.5 }, expect: { see: { text: 'x' } },
    groundings: [
      { on: { platform: 'win32' }, kind: 'click', see: { text: 'A' }, verified: { runs: 2, first: 'd', last: 'd', by: 'author' } },
      { on: { platform: 'win32', app: '>=4.0' }, kind: 'click', see: { text: 'B' }, verified: { runs: 1, first: 'd', last: 'd', by: 'contributed' } },
      { on: { platform: 'darwin' }, kind: 'click', see: { text: 'C' } },
    ],
  }
  it('过滤 + 贴合度 > 来源 > runs，通用 body 永远最后', () => {
    const local: Grounding[] = [
      { on: { platform: 'win32', app: '>=4.0' }, kind: 'click', see: { text: 'D' }, verified: { runs: 9, first: 'd', last: 'd', by: 'ai' } },
    ]
    const ranked = rankGroundings(step, local, { platform: 'win32', appVersion: '4.0.6' })
    expect(ranked.map((r) => (r.body.see as { text?: string })?.text ?? 'UNIVERSAL')).toEqual(['B', 'D', 'A', 'UNIVERSAL'])
    expect(ranked.at(-1)!.universal).toBe(true)
    expect(ranked.at(-1)!.body).toEqual({ kind: 'click', at: { x: 0.5, y: 0.5 } }) // 顶层 body 不带 expect / label / groundings
  })
  it('同 key 同来源按 runs 降序', () => {
    const local: Grounding[] = [
      { on: { platform: 'win32' }, kind: 'click', see: { text: 'E' }, verified: { runs: 1, first: 'd', last: 'd', by: 'human' } },
      { on: { platform: 'win32' }, kind: 'click', see: { text: 'F' }, verified: { runs: 5, first: 'd', last: 'd', by: 'human' } },
    ]
    const ranked = rankGroundings({ kind: 'click', at: { x: 0, y: 0 } }, local, { platform: 'win32' })
    expect(ranked.map((r) => (r.body.see as { text?: string })?.text ?? 'U')).toEqual(['F', 'E', 'U'])
  })
  it('事实一个都没有 → 只剩通用 body', () => {
    expect(rankGroundings(step, [], {}).map((r) => r.universal)).toEqual([true])
  })
  it('本机 shadowed 的条目不参与', () => {
    const local: Grounding[] = [{ on: { platform: 'win32' }, kind: 'click', see: { text: 'S' }, shadowed: true } as Grounding]
    expect(rankGroundings({ kind: 'click', at: { x: 0, y: 0 } }, local, { platform: 'win32' })).toHaveLength(1)
  })
})

describe('effectiveStep', () => {
  it('顶层公共字段 + 选中的 body；不带 groundings', () => {
    const step = { label: 'L', intent: 'I', expect: { see: { text: 'x' } }, else: 'abort', kind: 'click', at: { x: 0, y: 0 }, groundings: [] }
    const eff = effectiveStep(step, { body: { kind: 'invoke', see: { text: 'y' } }, on: {}, source: 'package', universal: false })
    expect(eff).toEqual({ label: 'L', intent: 'I', expect: { see: { text: 'x' } }, else: 'abort', kind: 'invoke', see: { text: 'y' } })
    expect('at' in eff).toBe(false)
  })
})

describe('assertTemplatesKept', () => {
  it('顶层带 {param} 的字段，grounding 同一路径必须还带着它', () => {
    const top = { kind: 'invoke', see: { text: '{contact}', below: ['联系人'] } }
    expect(() => assertTemplatesKept(top, { kind: 'invoke', see: { text: '{contact}', region: 'left' } }, ['contact', 'message'], 'w')).not.toThrow()
    expect(() => assertTemplatesKept(top, { kind: 'invoke', see: { text: '文件传输助手' } }, ['contact', 'message'], 'w'))
      .toThrow(/w.*see\.text.*\{contact\}/)
  })
  it('grounding 里出现顶层的参数以外的字面量不管；顶层没模板的字段不管', () => {
    expect(() => assertTemplatesKept({ kind: 'click', at: { x: 0, y: 0 } }, { kind: 'invoke', see: { text: '发送' } }, ['contact'], 'w')).not.toThrow()
  })
})

describe('resolveArea', () => {
  const area = {
    region: { x: 0.34, y: 0.06, w: 0.66, h: 0.72 },
    groundings: [
      { on: { platform: 'win32' as const }, region: { x: 0.34, y: 0.4, w: 0.66, h: 0.38 }, verified: { runs: 1, first: '2026-09-13', last: '2026-09-13', by: 'author' as const } },
      { on: { platform: 'darwin' as const }, region: { x: 0.34, y: 0.06, w: 0.66, h: 0.52 } },
    ],
  }
  it('按事实取第一条，通用最后', () => {
    const r = resolveArea('气泡区', area, [], { platform: 'win32' })
    expect(r?.region).toEqual({ x: 0.34, y: 0.4, w: 0.66, h: 0.38 })
    expect(r?.tag).toBe('package:win32')
    expect(r?.universal).toBe(false)
  })
  it('没有一条 on 相符时退回顶层 region', () => {
    const r = resolveArea('气泡区', area, [], {})
    expect(r?.region).toEqual(area.region)
    expect(r?.tag).toBe('universal')
    expect(r?.universal).toBe(true)
  })
  it('没有顶层 region 且没有相符的 grounding → null（不发明一块区域）', () => {
    expect(resolveArea('x', { groundings: area.groundings }, [], { platform: 'linux' as never })).toBeNull()
    expect(resolveArea('x', {}, [], {})).toBeNull()
  })
  it('本机 override 参与排序：同贴合度时包内 author 排在本机 ai 前面', () => {
    const local = [{ on: { platform: 'win32' as const }, region: 'bottom' as const, verified: { runs: 9, first: '2026-09-01', last: '2026-09-10', by: 'ai' as const } }]
    expect(resolveArea('气泡区', area, local, { platform: 'win32' })?.tag).toBe('package:win32')
    expect(resolveArea('气泡区', { groundings: [] }, local, { platform: 'win32' })?.tag).toBe('local:win32')
  })
  it('AREA_BODY_KEYS 只有 region', () => {
    expect(AREA_BODY_KEYS).toEqual(['region'])
  })
})
