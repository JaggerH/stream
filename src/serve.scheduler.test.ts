import { describe, it, expect } from 'vitest'
import { maybeStartScheduler } from './serve.ts'

// 查询档无采集：stdio MCP spawn 出的即用即回收后端不该把所有订阅流的定时采集跑起来——查询型
// 用户连上问一句不应顺带触发全量采集（两档拍板）。开关的翻译（STREAM_NO_SCHEDULER=1 →
// deployment.scheduler=false）在 deploymentFromEnv，这里守的是"启动分支"这个可测接缝：
// enabled=false 则跳过 scheduler.start() 并打一行原因日志，否则照常启动。API 查询路径与
// 本分支无关——app 在 main() 里无条件构造，不受本标记影响。
describe('maybeStartScheduler (查询档：deployment.scheduler)', () => {
  it('enabled=false：scheduler 不启动，一行日志说明原因，返回 false', () => {
    let started = 0
    const logs: string[] = []
    const ran = maybeStartScheduler(
      { start: () => { started++ } },
      false,
      (m) => void logs.push(m),
    )
    expect(started).toBe(0)
    expect(ran).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('scheduler disabled')
  })
  it('enabled=true：scheduler 照常启动，无跳过日志，返回 true', () => {
    let started = 0
    const logs: string[] = []
    const ran = maybeStartScheduler(
      { start: () => { started++ } },
      true,
      (m) => void logs.push(m),
    )
    expect(started).toBe(1)
    expect(ran).toBe(true)
    expect(logs).toHaveLength(0)
  })
  it('deploymentFromEnv：STREAM_NO_SCHEDULER=1 → scheduler=false（翻译测试钉那边）', () => {
    // 这里只钉启动分支对布尔语义的遵循；环境变量的翻译由 deploymentFromEnv 的用例守。
    let started = 0
    maybeStartScheduler({ start: () => { started++ } }, true, () => {})
    expect(started).toBe(1)
  })
})
