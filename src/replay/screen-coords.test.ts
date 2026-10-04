import { describe, it, expect } from 'vitest'
import { solveScreenMapping, toScreenPoint, type CalibrationProbe } from './screen-coords.ts'

// 浏览器视口坐标 → 屏幕坐标。这块以前不存在(全仓没人读过 screenX/devicePixelRatio),而它是
// 「用 OS 级输入点浏览器里的元素」唯一缺的一环:CDP 读得到元素在**视口**里的位置,enigo 要的是
// **屏幕**绝对坐标。
//
// 不靠算窗口几何(screenX + 工具栏高度 × DPR)去猜——那正是 125%/150% 显示缩放下会偏的做法。
// 改成**自标定**:把鼠标挪到两个已知屏幕点,页面上的 mousemove 报回它看到的 clientX/Y,两点解出
// 这个仿射映射。DPR、工具栏高度、窗口边框全都不用知道。

const probes = (...p: [number, number, number, number][]): CalibrationProbe[] =>
  p.map(([sx, sy, vx, vy]) => ({ screen: { x: sx, y: sy }, viewport: { x: vx, y: vy } }))

describe('solveScreenMapping', () => {
  it('DPR=1 无缩放:解出纯平移', () => {
    // 窗口内容区左上角在屏幕 (100, 200)
    const m = solveScreenMapping(probes([300, 400, 200, 200], [500, 700, 400, 500]))
    expect(m.scaleX).toBeCloseTo(1)
    expect(m.scaleY).toBeCloseTo(1)
    expect(m.offsetX).toBeCloseTo(100)
    expect(m.offsetY).toBeCloseTo(200)
  })

  it('DPR=1.5(150% 缩放):解出缩放 + 平移', () => {
    // screen = 100 + viewport*1.5 (X) / 200 + viewport*1.5 (Y)
    const m = solveScreenMapping(probes([250, 350, 100, 100], [550, 800, 300, 400]))
    expect(m.scaleX).toBeCloseTo(1.5)
    expect(m.scaleY).toBeCloseTo(1.5)
    expect(m.offsetX).toBeCloseTo(100)
    expect(m.offsetY).toBeCloseTo(200)
  })

  it('解出来的映射能把视口点换回屏幕点(往返一致)', () => {
    const m = solveScreenMapping(probes([250, 350, 100, 100], [550, 800, 300, 400]))
    expect(toScreenPoint(m, { x: 100, y: 100 })).toEqual({ x: 250, y: 350 })
    expect(toScreenPoint(m, { x: 300, y: 400 })).toEqual({ x: 550, y: 800 })
    // 内插的点也对
    expect(toScreenPoint(m, { x: 200, y: 250 })).toEqual({ x: 400, y: 575 })
  })

  it('输出取整——enigo 要的是整数像素', () => {
    const m = solveScreenMapping(probes([250, 350, 100, 100], [550, 800, 300, 400]))
    const p = toScreenPoint(m, { x: 111, y: 123 })
    expect(Number.isInteger(p.x)).toBe(true)
    expect(Number.isInteger(p.y)).toBe(true)
  })

  it('少于两个标定点 → 报错(解不出来)', () => {
    expect(() => solveScreenMapping(probes([1, 2, 3, 4]))).toThrow(/至少两个|two/i)
  })

  it('两点在某个轴上重合 → 报错,而不是算出 Infinity', () => {
    // 视口 x 相同 → x 轴解不出
    expect(() => solveScreenMapping(probes([250, 350, 100, 100], [550, 800, 100, 400]))).toThrow(/x/i)
    // 视口 y 相同 → y 轴解不出
    expect(() => solveScreenMapping(probes([250, 350, 100, 100], [550, 800, 300, 100]))).toThrow(/y/i)
  })

  it('两轴缩放差太多 → 报错(标定点不可信,别拿它去点)', () => {
    // scaleX=1.5 但 scaleY=3 —— 真实显示缩放是各向同性的，差这么多说明采样坏了
    expect(() => solveScreenMapping(probes([250, 350, 100, 100], [550, 1250, 300, 400]))).toThrow(/缩放|scale/i)
  })
})
