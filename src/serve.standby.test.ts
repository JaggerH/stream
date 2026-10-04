import { describe, it, expect } from 'vitest'
import { buildStandbyOrDegrade } from './serve.ts'

// I3:standby 的任何构造失败都必须降级成"一行日志 + standby inert",而不是掀翻整个后端启动。
// 真实的那颗雷:makeStandbyManager 对重名 service 主动 throw,而 main() 结尾是
// .catch(… process.exit(1)) —— 两个插件的 backend.service 撞名 ⇒ 后端拒绝启动。
describe('buildStandbyOrDegrade (I3)', () => {
  it('a throwing build degrades: no rethrow, cleanup runs, one log line', async () => {
    const logs: string[] = []
    let cleaned = 0
    await expect(buildStandbyOrDegrade(
      async () => { throw new Error('standby: duplicate service names in config: voiceprint') },
      () => { cleaned++ },
      (m) => void logs.push(m),
    )).resolves.toBeUndefined()
    expect(cleaned).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('standby setup failed')
    expect(logs[0]).toContain('duplicate service names')
  })
  it('a non-Error throw still yields a readable reason (never the literal "undefined")', async () => {
    const logs: string[] = []
    await buildStandbyOrDegrade(async () => { throw 'docker socket gone' }, () => {}, (m) => void logs.push(m))
    expect(logs[0]).toContain('docker socket gone')
  })
  it('a throwing cleanup cannot escape either', async () => {
    const logs: string[] = []
    await expect(buildStandbyOrDegrade(
      async () => { throw new Error('boom') },
      () => { throw new Error('cleanup blew up too') },
      (m) => void logs.push(m),
    )).resolves.toBeUndefined()
    expect(logs[0]).toContain('boom')
  })
  it('the happy path is untouched: no log, no cleanup, no notice', async () => {
    const logs: string[] = []
    const notices: string[] = []
    let cleaned = 0
    let ran = 0
    await buildStandbyOrDegrade(async () => { ran++ }, () => { cleaned++ }, (m) => void logs.push(m), (d) => void notices.push(d))
    expect([ran, cleaned, logs.length, notices.length]).toEqual([1, 0, 0, 0])
  })

  // 降级到今天为止只有一行 console.log。而 standby inert 的后果是**沉默的**:睡着的容器
  // 再没人唤醒(备齐也不会替它起——那是 standby 的活,见 provisioner.ts 头注),表现是
  // 「这个插件就是不好使」,而唯一的线索在一行没人看的启动日志里。
  it('degrading notifies the user, not just the log', async () => {
    const notices: string[] = []
    await buildStandbyOrDegrade(
      async () => { throw new Error('duplicate service names in config: voiceprint') },
      () => {},
      () => {},
      (d) => void notices.push(d),
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('duplicate service names')
  })

  it('a throwing notifier cannot escape either (降级路径上再炸也不许掀翻开机)', async () => {
    await expect(buildStandbyOrDegrade(
      async () => { throw new Error('boom') },
      () => {},
      () => {},
      () => { throw new Error('event bus not up yet') },
    )).resolves.toBeUndefined()
  })
})
