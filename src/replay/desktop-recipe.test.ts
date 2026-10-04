import { describe, expect, it } from 'vitest'
import { concretizeApp, processMatches, validateSee } from './desktop-recipe.ts'

describe('validateSee 的三选一', () => {
  it('text 单给通过', () => {
    expect(validateSee({ text: '发送' }, 'x').text).toBe('发送')
  })

  it('icon 单给通过', () => {
    expect(validateSee({ icon: '放大镜' }, 'x').icon).toBe('放大镜')
  })

  it('point 单给通过', () => {
    expect(validateSee({ point: '消息输入框' }, 'x').point).toBe('消息输入框')
  })

  it('一个都不给 → 拒绝', () => {
    expect(() => validateSee({}, 'x')).toThrow(/恰好给/)
  })

  it('给两个 → 拒绝（矛盾不是宽容：两个目标下游只会用其中一个，而用的是哪个说不清）', () => {
    expect(() => validateSee({ text: '发送', point: '发送按钮' }, 'x')).toThrow(/恰好给/)
    expect(() => validateSee({ icon: '放大镜', point: '搜索框' }, 'x')).toThrow(/恰好给/)
  })
})

describe('see.point', () => {
  it('空串不算给了——一句话都没有的 point 没法问模型，而它会安静地永远找不到', () => {
    expect(() => validateSee({ point: '   ' }, 'x')).toThrow(/恰好给/)
  })

  it('不是字符串不算给了', () => {
    expect(() => validateSee({ point: 42 }, 'x')).toThrow(/恰好给/)
  })

  it('可以和 region 并存——region 是给模型的取景框，不是它的替代品', () => {
    const see = validateSee({ point: '输入框', region: { x: 0, y: 0.5, w: 1, h: 0.5 } }, 'x')
    expect(see.point).toBe('输入框')
    expect(see.region).toBeTruthy()
  })

  it('region：比例矩形四个必填且在 0–1 内；dip 矩形 w/h 可省、数值不限 0–1；混着写不认', () => {
    expect(validateSee({ text: 'a', region: { unit: 'dip', x: 340, y: 0, h: 80 } }, 'x').region).toEqual({ unit: 'dip', x: 340, y: 0, h: 80 })
    expect(() => validateSee({ text: 'a', region: { x: 340, y: 0, h: 80 } }, 'x')).toThrow(/不认识/)
    expect(validateSee({ text: 'a', region: { unit: 'dip', x: 340, y: -240 } }, 'x').region).toEqual({ unit: 'dip', x: 340, y: -240 })
    expect(() => validateSee({ text: 'a', region: { unit: 'dip', x: 0, y: 0, w: 0 } }, 'x')).toThrow(/dip 矩形不合法/)
    expect(() => validateSee({ text: 'a', region: { unit: 'dip', x: 'a', y: 0 } }, 'x')).toThrow(/dip 矩形不合法/)
    expect(() => validateSee({ text: 'a', region: { unit: 'px', x: 0, y: 0 } }, 'x')).toThrow(/不认识/)
  })

  it('below 仍然只对 text 目标有意义——控件树按章节找这一维本来就不存在，而 point 是问模型要坐标', () => {
    expect(() => validateSee({ point: '输入框', below: ['联系人'] }, 'x')).toThrow(/below/)
  })
})

describe('app.process 多候选（跨平台的名字）', () => {
  it('processMatches：省略 = 不过滤；字符串全等；数组任一', () => {
    expect(processMatches(undefined, 'a.exe')).toBe(true)
    expect(processMatches('a.exe', 'a.exe')).toBe(true)
    expect(processMatches('a.exe', 'b.exe')).toBe(false)
    expect(processMatches(['a.exe', '甲'], '甲')).toBe(true)
    expect(processMatches(['a.exe', '甲'], '乙')).toBe(false)
  })

  it('concretizeApp：取屏上在的那个；都不在取第一个；字符串原样；其余字段保留', () => {
    expect(concretizeApp({ process: ['Weixin.exe', '微信'], title: '微信' }, [{ process: '微信' }])).toEqual({ process: '微信', title: '微信' })
    expect(concretizeApp({ process: ['Weixin.exe', '微信'] }, [{ process: 'Finder' }])).toEqual({ process: 'Weixin.exe' })
    expect(concretizeApp({ process: 'QQ.exe', title: 'QQ' }, [])).toEqual({ process: 'QQ.exe', title: 'QQ' })
    expect(concretizeApp({ windowClass: 'Chrome_WidgetWin_1' }, [])).toEqual({ windowClass: 'Chrome_WidgetWin_1' })
  })
})
