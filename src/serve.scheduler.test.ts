import { describe, it, expect } from 'vitest'
import { maybeStartScheduler } from './serve.ts'

// 查询档无采集:stdio MCP spawn 出的即用即回收后端(STREAM_NO_SCHEDULER=1)不该把所有订阅流的
// 定时采集跑起来——查询型用户连上问一句不应顺带触发全量采集(两档拍板)。这里守的是"启动分支"
// 这个可测接缝:标记为真则跳过 scheduler.start() 并打一行原因日志,否则照常启动。API 查询路径
// 与本分支无关——app 在 main() 里无条件构造,不受本标记影响。
describe('maybeStartScheduler (查询档:STREAM_NO_SCHEDULER)', () => {
  it('STREAM_NO_SCHEDULER=1:scheduler 不启动,一行日志说明原因,返回 false', () => {
    let started = 0
    const logs: string[] = []
    const ran = maybeStartScheduler(
      { start: () => { started++ } },
      { STREAM_NO_SCHEDULER: '1' },
      (m) => void logs.push(m),
    )
    expect(started).toBe(0)
    expect(ran).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('STREAM_NO_SCHEDULER')
  })
  it('无标记:scheduler 照常启动,无跳过日志,返回 true', () => {
    let started = 0
    const logs: string[] = []
    const ran = maybeStartScheduler(
      { start: () => { started++ } },
      {},
      (m) => void logs.push(m),
    )
    expect(started).toBe(1)
    expect(ran).toBe(true)
    expect(logs).toHaveLength(0)
  })
  it('只有精确值 "1" 才关采集(其他值仍照常采集)', () => {
    let started = 0
    maybeStartScheduler({ start: () => { started++ } }, { STREAM_NO_SCHEDULER: '0' }, () => {})
    maybeStartScheduler({ start: () => { started++ } }, { STREAM_NO_SCHEDULER: 'true' }, () => {})
    expect(started).toBe(2)
  })
})
