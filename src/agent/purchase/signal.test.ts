import { describe, it, expect } from 'vitest'
import { buildSignalTool, validateSignal, NOT_IN_SET } from './signal.ts'

const UNIVERSE = ['小米17 Ultra', 'vivo X300 Pro']

describe('buildSignalTool', () => {
  it('把本轮全集逐个塞进 enum，并且**带逃生项**', () => {
    const tool = buildSignalTool(UNIVERSE, ['拍照']) as any
    const modelEnum = tool.function.parameters.properties.mentions.items.properties.model.enum
    expect(modelEnum).toEqual([...UNIVERSE, NOT_IN_SET])
  })

  it('逃生项不是可选修饰——没有它，模型会被迫在都不对的选项里挑一个', () => {
    // 这条守的是探针实测出来的那个坑（spec §4.1）：强制 enum 且无逃生项时，模型会挑一个
    // 并把理由写得头头是道，而字段本身是个假的正确答案。
    const tool = buildSignalTool(UNIVERSE, []) as any
    const modelEnum: string[] = tool.function.parameters.properties.mentions.items.properties.model.enum
    expect(modelEnum).toContain(NOT_IN_SET)
  })

  it('软条件进描述——它是模型判断"因为什么被夸"的判据', () => {
    const tool = buildSignalTool(UNIVERSE, ['夜景', '长焦']) as any
    expect(tool.function.description).toContain('夜景、长焦')
  })
})

describe('validateSignal', () => {
  it('全集内的进 mentions', () => {
    const r = validateSignal(
      { mentions: [{ model: '小米17 Ultra', attribute: '夜景', quote: '夜景第一梯队' }] },
      UNIVERSE,
    )
    expect(r.mentions).toHaveLength(1)
    expect(r.unmatched).toHaveLength(0)
    expect(r.dropped).toHaveLength(0)
  })

  it('逃生项进 unmatched，不进候选，并保留原文写法用于诊断', () => {
    const r = validateSignal(
      { mentions: [{ model: NOT_IN_SET, raw: 'Pixel 10 Pro', attribute: '算法', quote: '谷歌的算法依旧' }] },
      UNIVERSE,
    )
    expect(r.mentions).toHaveLength(0)
    expect(r.unmatched[0]?.raw).toBe('Pixel 10 Pro')
  })

  it('**enum 没兜住时事后校验必须拦下**——越界型号绝不进候选；但原文要留在 unmatched，不许丢', () => {
    const r = validateSignal(
      { mentions: [{ model: '三星S26 Ultra', attribute: '长焦', quote: '长焦无敌' }] },
      UNIVERSE,
    )
    expect(r.mentions).toHaveLength(0)
    expect(r.dropped).toHaveLength(0)
    expect(r.unmatched).toEqual([expect.objectContaining({ model: '__not_in_set__', raw: '三星S26 Ultra' })])
  })

  it('model 格写了个变体写法（少空格 / 多空格）——和逃生项一样按身份认领，不问模型第二次', () => {
    const r = validateSignal(
      { mentions: [{ model: UNIVERSE[0]!.replace(/\s+/g, ''), attribute: '长焦', quote: 'x' }] },
      UNIVERSE,
    )
    expect(r.mentions.map((m) => m.model)).toEqual([UNIVERSE[0]])
    expect(r.unmatched).toHaveLength(0)
  })

  it('缺字段的丢掉并计数，不静默', () => {
    const r = validateSignal({ mentions: [{ model: '小米17 Ultra', attribute: '夜景' }] }, UNIVERSE)
    expect(r.mentions).toHaveLength(0)
    expect(r.dropped[0]?.reason).toBe('missing_field')
  })

  it('模型回了个不成形状的东西也不炸', () => {
    expect(validateSignal(null, UNIVERSE).mentions).toEqual([])
    expect(validateSignal({ mentions: 'nope' }, UNIVERSE).dropped).toEqual([])
  })
})

describe('逃生项的二次认领——enum 挡不住假阴性', () => {
  it('**模型说"不在集合里"，但原文其实就在**：归一化对上就算点名', () => {
    // 活体 2026-09-02：`OPPO Find X9` 明明在这一轮的 enum 里，模型仍然扔进逃生项、
    // raw 写着一模一样的字。事后集合校验拦不住——逃生项是合法值。
    const r = validateSignal(
      { mentions: [{ model: NOT_IN_SET, raw: 'OPPO Find X9', attribute: '拍照', quote: '旅拍神器' }] },
      ['OPPO Find X9', 'vivo X300'],
    )
    expect(r.mentions).toEqual([expect.objectContaining({ model: 'OPPO Find X9' })])
    expect(r.unmatched).toHaveLength(0)
  })

  it('少了容量后缀、多了空格也认得出来（归一化的活干在这儿，不问模型第二次）', () => {
    const r = validateSignal(
      { mentions: [{ model: NOT_IN_SET, raw: 'vivo  x300 12GB+256GB', attribute: '长焦', quote: 'q' }] },
      ['vivo X300'],
    )
    expect(r.mentions[0]?.model).toBe('vivo X300')
  })

  it('**真的不在集合里就老老实实留在 unmatched**——二次认领不许放宽成模糊匹配', () => {
    const r = validateSignal(
      { mentions: [{ model: NOT_IN_SET, raw: 'Pixel 10 Pro', attribute: '算法', quote: 'q' }] },
      ['OPPO Find X9', 'vivo X300'],
    )
    expect(r.mentions).toHaveLength(0)
    expect(r.unmatched[0]?.raw).toBe('Pixel 10 Pro')
  })

  it('逃生项没带 raw 就无从认领，留在 unmatched', () => {
    const r = validateSignal({ mentions: [{ model: NOT_IN_SET, attribute: '拍照', quote: 'q' }] }, ['vivo X300'])
    expect(r.unmatched).toHaveLength(1)
  })
})
