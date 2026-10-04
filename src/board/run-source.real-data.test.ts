import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { listRunIds, readRunManifest } from './run-source.ts'

const REAL = process.env.COCKPIT_ARTIFACTS ?? ''

// 这份数据是本机的真实产出，CI/别人的机器上没有——不在就跳过，不要伪造成绿。
//
// **不断言具体条数。** artifacts 目录是仓外的活数据，跑一批新研究数字就变；把 157/1158
// 钉进断言，唯一的效果是每跑一次研究就红一次，然后被人随手改数字，闸门形同虚设。
// 要守的是这两条：每个 run 都解析得动（零抛错），出现过的每种 view 都有人渲染。
describe.skipIf(!existsSync(REAL))('真实 artifacts 目录回归', () => {
  const ids = existsSync(REAL) ? listRunIds(REAL) : []

  it('每个 run 的 manifest 都解析得动,零抛错', () => {
    expect(ids.length).toBeGreaterThan(0) // 目录在却一个 run 都没列出来 = 解析挂了
    for (const id of ids) expect(() => readRunManifest(REAL, id)).not.toThrow()
  })

  it('真实数据里出现的每一种 view 都在前端注册表里', () => {
    const seen = new Set<string>()
    for (const id of ids) for (const a of readRunManifest(REAL, id).artifacts) seen.add(a.view)
    expect(seen.size).toBeGreaterThan(0)
    // 注册表 id 表在这里内联一份对照：跨包 import（后端测试拉 app/ 的模块）会把两套
    // vitest 配置搅在一起。加 view 时两处一起改——数量小、且这条测试就是提醒器。
    const REGISTERED = ['table', 'timeseries', 'text', 'scatter2d', 'heatmap', 'backtest_chart', 'distribution', 'html']
    for (const v of seen) expect(REGISTERED).toContain(v)
  })
})
