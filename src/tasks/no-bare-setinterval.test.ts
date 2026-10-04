// spec §3.6：业务代码禁止新增裸 setInterval——周期任务一律走调度中心。
// 用词边界匹配：字面量 `setInterval(` 曾漏掉 wire.ts 的 `(deps.setIntervalImpl ?? setInterval)(`。
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

/** 白名单：协议心跳/诊断采样（spec §1 线 B 明确不收编）。 */
const ALLOWED = [
  'src/http/host-relay.ts',            // WS ping
  'shared/browser-relay/relay.ts',     // WS ping（原 src/http/ext-relay.ts，随重构搬到 shared/）
  'src/event-source/relay.ts',         // WS ping（与 host-relay 同类）
  'src/loop-lag.ts',                   // 事件循环延迟采样
  // 一条 agent 会话自己的心跳/看门狗：每个实例一根，`unref()` 过，终态的每条路（finish / failRun /
  // cancel）都 `stopWatchdog()`。它的周期按这条 run 的 `idleTimeoutMs` 算，不是全局节拍——
  // 收编进 src/tasks/ 反而要把 per-run 的状态搬进调度中心。
  'src/intervention/agent-session.ts',
]

describe('no bare setInterval in src/ and shared/', () => {
  it('每个命中文件都在白名单里', () => {
    let out = ''
    try {
      out = execFileSync('grep', ['-rlE', '\\bsetInterval\\b', 'src/', 'shared/', '--include=*.ts'], { encoding: 'utf8' })
    } catch (e) {
      // grep 无命中 exit 1 —— 空结果合法；其他退出码（grep/src 缺失等）是真错误，必须冒泡，
      // 否则守卫会静默"通过"而没真的扫过任何东西。
      if ((e as { status?: number }).status !== 1) throw e
    }
    const offenders = out.split('\n').filter(Boolean)
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => !ALLOWED.includes(f))
    expect(offenders, `裸 setInterval 出现在非白名单文件（周期任务请注册进 src/tasks/）: ${offenders.join(', ')}`).toEqual([])
  })
})
