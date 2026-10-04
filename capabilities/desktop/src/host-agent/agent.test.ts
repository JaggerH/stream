// capabilities/desktop/src/host-agent/agent.test.ts
//
// agent 的生命周期。四件事，每一件都对应一个曾经真实发生过或必然发生的坏形状：
//   - **三个环境变量**：少 STREAM_DATA_DIR，agent 会起来然后握手失败——那个形状和
//     「没装」长得一模一样。少 PARENT_WATCH，强杀留下的孤儿会在下次启动时变成两个
//     agent 抢同一条中继（活体撞到过，见 Tauri 壳里那段注释）。
//   - **崩了要重来**，但不能忙等——退避封顶 10s。
//   - **跑久了再崩要从头退避**：不然一个健康跑了一周的 agent 崩一次就要等 10s。
//   - **dispose 之后绝不再起**：后端每次重启都会 dispose，重启后的新实例会自己 spawn，
//     旧的定时器再醒过来就是第二个 agent。
import { describe, it, expect } from 'vitest'
import { backoffMs, hostWsUrl, startAgent, stderrLineCapper, type AgentDeps, type AgentProcess } from './agent.ts'

interface Spawned { bin: string; env: Record<string, string>; killed: boolean; fire: () => void }

/** 假 deps：手动推时间、手动让子进程「退出」。 */
function harness() {
  const spawned: Spawned[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const logs: string[] = []
  let clock = 0
  const deps: AgentDeps = {
    spawn(bin, env) {
      let onExit = () => {}
      const rec: Spawned = { bin, env, killed: false, fire: () => onExit() }
      spawned.push(rec)
      const proc: AgentProcess = {
        kill: () => { rec.killed = true },
        onExit: (cb) => { onExit = cb },
      }
      return proc
    },
    setTimer(fn, ms) {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return t
    },
    clearTimer(handle) { (handle as { cancelled: boolean }).cancelled = true },
    now: () => clock,
    log: (m) => logs.push(m),
  }
  return {
    deps, spawned, timers, logs,
    advance: (ms: number) => { clock += ms },
    /** 跑掉最后一个还没取消的定时器。 */
    runLastTimer() {
      const t = timers.filter((x) => !x.cancelled).at(-1)
      if (!t) throw new Error('没有待跑的定时器')
      t.cancelled = true
      t.fn()
      return t.ms
    },
  }
}

const OPTS = { binPath: '/p/agent', wsUrl: 'ws://127.0.0.1:8900/api/host', dataDir: '/data' }

describe('hostWsUrl', () => {
  it('http → ws，并接上 /api/host', () => {
    expect(hostWsUrl('http://127.0.0.1:8900')).toBe('ws://127.0.0.1:8900/api/host')
  })
  it('https → wss', () => {
    expect(hostWsUrl('https://stream.example.com')).toBe('wss://stream.example.com/api/host')
  })
  it('结尾的斜杠不许变成双斜杠', () => {
    expect(hostWsUrl('http://127.0.0.1:8900/')).toBe('ws://127.0.0.1:8900/api/host')
  })
})

describe('backoffMs', () => {
  it('500ms 起倍增', () => {
    expect(backoffMs(0)).toBe(500)
    expect(backoffMs(1)).toBe(1000)
    expect(backoffMs(2)).toBe(2000)
  })
  it('封顶 10s，且大 attempt 不溢出', () => {
    expect(backoffMs(5)).toBe(10_000)
    expect(backoffMs(99)).toBe(10_000)
  })
})

describe('startAgent', () => {
  it('spawn 时带齐三个环境变量（少一个都会变成难查的静默失败）', () => {
    const h = harness()
    startAgent(h.deps, OPTS)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.bin).toBe('/p/agent')
    expect(h.spawned[0]!.env).toEqual({
      STREAM_HOST_URL: 'ws://127.0.0.1:8900/api/host',
      STREAM_DATA_DIR: '/data',
      STREAM_HOST_PARENT_WATCH: '1',
    })
  })

  it('崩了按退避重启：500 → 1000 → 2000', () => {
    const h = harness()
    startAgent(h.deps, OPTS)
    h.spawned[0]!.fire()
    expect(h.runLastTimer()).toBe(500)
    h.spawned[1]!.fire()
    expect(h.runLastTimer()).toBe(1000)
    h.spawned[2]!.fire()
    expect(h.runLastTimer()).toBe(2000)
    expect(h.spawned).toHaveLength(4)
  })

  it('跑够久再崩 → 退避从头算（健康跑了很久的进程崩一次不该等 10s）', () => {
    const h = harness()
    startAgent(h.deps, OPTS)
    h.spawned[0]!.fire()
    expect(h.runLastTimer()).toBe(500)
    h.advance(60_000) // 第二个实例活了 60s
    h.spawned[1]!.fire()
    expect(h.runLastTimer()).toBe(500)
  })

  it('dispose：杀掉子进程、取消待跑的重启、之后再也不 spawn', () => {
    const h = harness()
    const dispose = startAgent(h.deps, OPTS)
    h.spawned[0]!.fire() // 崩了，排了一个重启
    dispose()
    expect(h.timers.every((t) => t.cancelled)).toBe(true)
    expect(h.spawned).toHaveLength(1)
  })

  it('dispose 会 kill 活着的那个子进程', () => {
    const h = harness()
    const dispose = startAgent(h.deps, OPTS)
    dispose()
    expect(h.spawned[0]!.killed).toBe(true)
  })
})

// I2：唯一说得出真因的那句诊断（datadir.rs「找不到 ext-relay-token」）印在 agent 的 stderr 上，
// 过去被 `stdio: 'ignore'` 整段丢弃。这里测的是把它接回来那一半里"封顶"这条不变量——agent
// 在崩溃循环里可能疯狂刷屏，转发不能没有上限。
describe('stderrLineCapper', () => {
  it('按行拆分，空行不算一条', () => {
    const cap = stderrLineCapper(10)
    expect(cap.push('a\nb\n\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('半行（没有结尾换行）留到下一次 push 才拼完整', () => {
    const cap = stderrLineCapper(10)
    expect(cap.push('foo')).toEqual([])
    expect(cap.push('bar\n')).toEqual(['foobar'])
  })

  it('超过上限后不再产出新行——即便还在继续喂 chunk', () => {
    const cap = stderrLineCapper(2)
    expect(cap.push('a\nb\nc\nd\n')).toEqual(['a', 'b'])
    expect(cap.push('e\nf\n')).toEqual([])
  })

  // Minor-4：半行缓冲（还没等到换行的那一截）理论上无界——一条永不换行的畸形输出会让它
  // 一直增长。喂够多字节但永远不给换行，再补一刀换行确认拼出来的那一行长度是有界的。
  it('半行缓冲不会无界增长——永不换行的畸形输出被截断', () => {
    const cap = stderrLineCapper(10)
    for (let i = 0; i < 50; i++) {
      expect(cap.push('x'.repeat(5000))).toEqual([]) // 250000 字节喂进去，全无换行
    }
    const [line] = cap.push('\n')
    expect(line!.length).toBeLessThan(50_000) // 远小于喂进去的 250000，证明被截断而不是原样攒着
  })
})
