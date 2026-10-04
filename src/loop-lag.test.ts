import { describe, it, expect } from 'vitest'
import { evalStall, hotFrames, startLoopLagMonitor, type CpuProfile } from './loop-lag.ts'
import type { OpOverlap } from './op-track.ts'

/** Build a V8 CPU-profile node. V8 line numbers are 0-based; all times are microseconds. */
const node = (id: number, functionName: string, url: string, lineNumber = 0) => ({
  id,
  callFrame: { functionName, scriptId: '1', url, lineNumber, columnNumber: 0 },
  hitCount: 0,
  children: [] as number[],
})

/** samples[i] is the stack running for timeDeltas[i] microseconds. */
const profileOf = (nodes: ReturnType<typeof node>[], samples: number[], timeDeltas: number[]): CpuProfile => ({
  nodes,
  startTime: 0,
  endTime: timeDeltas.reduce((a, b) => a + b, 0),
  samples,
  timeDeltas,
})

describe('evalStall', () => {
  it('returns null when the window max is below threshold (no noise from normal ops)', () => {
    expect(evalStall(120, 4.2, 1000, 250, 1000)).toBeNull()
  })

  it('flags a stall over threshold: rounded stdout line + loop-channel DebugEntry', () => {
    const r = evalStall(1830.6, 12.34, 1000, 250, 42)
    expect(r).not.toBeNull()
    expect(r!.line).toContain('1831ms') // rounded from 1830.6
    expect(r!.line).toContain('mean 12.3ms')
    expect(r!.entry.channel).toBe('loop')
    expect(r!.entry.ok).toBe(false)
    expect(r!.entry.id).toBe('loop:stall@42')
    expect(r!.entry.fields[0]).toMatchObject({ label: 'max stall', value: '1831ms', tone: 'bad' })
  })

  it('treats exactly-threshold as a stall (>=, not >)', () => {
    expect(evalStall(250, 1, 1000, 250, 0)).not.toBeNull()
  })

  it('names the culprit on the stdout line and lists the blamed frames as fields', () => {
    const r = evalStall(317, 28.8, 1000, 250, 42, [
      { fn: 'writeRows', site: 'app/src/store.ts:120', selfMs: 300 },
      { fn: 'present', site: 'app/src/content/xhs.ts:41', selfMs: 12 },
    ])
    // one greppable line: the worst offender only, detail lives in the fields
    expect(r!.line).toContain('blamed: writeRows (app/src/store.ts:120) 300ms')
    expect(r!.entry.summary).toContain('writeRows')
    expect(r!.entry.fields).toContainEqual({ label: '#1 300ms', value: 'writeRows — app/src/store.ts:120', tone: 'bad' })
    expect(r!.entry.fields).toContainEqual({ label: '#2 12ms', value: 'present — app/src/content/xhs.ts:41', tone: 'muted' })
  })

  it('says so explicitly when the profiler caught no frames, rather than silently looking clean', () => {
    const r = evalStall(317, 28.8, 1000, 250, 42, [])
    expect(r!.line).not.toContain('blamed')
    expect(r!.entry.fields).toContainEqual({ label: 'culprit', value: '未捕获（profiler 未启用或采样未命中）', tone: 'muted' })
  })
})

describe('hotFrames', () => {
  it('ranks frames by self time — the synchronous hog comes first', () => {
    const p = profileOf(
      [
        node(1, '(root)', ''),
        node(2, 'writeRows', 'file:///app/src/store.ts', 119),
        node(3, 'present', 'file:///app/src/content/xhs.ts', 40),
      ],
      [3, 2, 3],
      [2_000, 300_000, 1_000],
    )
    const hot = hotFrames(p, 0, 5)
    expect(hot[0]).toMatchObject({ fn: 'writeRows', site: 'app/src/store.ts:120', selfMs: 300 })
    expect(hot[1]).toMatchObject({ fn: 'present', site: 'app/src/content/xhs.ts:41', selfMs: 3 })
  })

  it('sums one function across call paths — V8 emits a separate node per path, which would otherwise shatter the real hog into slivers', () => {
    const p = profileOf(
      [
        node(1, '(root)', ''),
        node(2, 'compile', 'file:///app/a.ts', 8), // reached via path A
        node(3, 'compile', 'file:///app/a.ts', 8), // same function, reached via path B
        node(4, 'other', 'file:///app/b.ts', 0),
      ],
      [2, 3, 4],
      [100_000, 150_000, 120_000],
    )
    const hot = hotFrames(p, 0, 5)
    expect(hot[0]).toMatchObject({ fn: 'compile', site: 'app/a.ts:9', selfMs: 250 })
    expect(hot[1]).toMatchObject({ fn: 'other', selfMs: 120 })
  })

  it('counts only samples inside the stall window, ignoring earlier calm', () => {
    // cumulative sample times: 100ms, 200ms, 500ms
    const p = profileOf(
      [node(1, '(root)', ''), node(2, 'earlier', 'file:///app/a.ts'), node(3, 'inStall', 'file:///app/b.ts')],
      [2, 2, 3],
      [100_000, 100_000, 300_000],
    )
    expect(hotFrames(p, 250_000, 5).map((f) => f.fn)).toEqual(['inStall'])
  })

  it('drops (idle)/(root) bookkeeping — that is the loop being free, not a stall', () => {
    const p = profileOf(
      [node(1, '(root)', ''), node(2, '(idle)', ''), node(3, 'realWork', 'file:///app/a.ts')],
      [2, 1, 3],
      [900_000, 50_000, 300_000],
    )
    expect(hotFrames(p, 0, 5).map((f) => f.fn)).toEqual(['realWork'])
  })

  it('keeps (garbage collector) — a long GC pause IS a synchronous stall', () => {
    const p = profileOf([node(1, '(root)', ''), node(2, '(garbage collector)', '')], [2], [400_000])
    expect(hotFrames(p, 0, 5)).toMatchObject([{ fn: '(garbage collector)', site: 'native', selfMs: 400 }])
  })

  it('truncates to topN', () => {
    const p = profileOf(
      [node(1, '(root)', ''), node(2, 'a', 'file:///app/a.ts'), node(3, 'b', 'file:///app/b.ts'), node(4, 'c', 'file:///app/c.ts')],
      [2, 3, 4],
      [300_000, 200_000, 100_000],
    )
    expect(hotFrames(p, 0, 2).map((f) => f.fn)).toEqual(['a', 'b'])
  })

  it('names anonymous frames by their site rather than showing an empty label', () => {
    const p = profileOf([node(1, '(root)', ''), node(2, '', 'file:///app/src/scheduler.ts', 76)], [2], [300_000])
    expect(hotFrames(p, 0, 5)[0]).toMatchObject({ fn: '(anonymous)', site: 'app/src/scheduler.ts:77' })
  })

  it('strips pnpm store noise from dependency sites, keeping the package-relative path', () => {
    const url = 'file:///app/node_modules/.pnpm/better-sqlite3@11.3.0/node_modules/better-sqlite3/lib/methods/wrappers.js'
    const p = profileOf([node(1, '(root)', ''), node(2, 'run', url, 11)], [2], [300_000])
    expect(hotFrames(p, 0, 5)[0].site).toBe('better-sqlite3/lib/methods/wrappers.js:12')
  })

  it('returns [] when no sample falls in the window', () => {
    const p = profileOf([node(1, '(root)', ''), node(2, 'a', 'file:///app/a.ts')], [2], [10_000])
    expect(hotFrames(p, 900_000, 5)).toEqual([])
  })
})

/** Burn CPU synchronously — the exact species of bug the recorder exists to catch. Named
 *  distinctively so the assertion below can only pass if the profiler really blamed THIS frame. */
function blockTheLoopHard(ms: number): number {
  const until = Date.now() + ms
  let x = 0
  while (Date.now() < until) x += Math.sqrt(x + 1)
  return x
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 真实卡顿用例的等待器：CI 共享 runner 上采样 tick 的到达时刻不可预测，固定 settle(700)
 *  会在"卡顿发生了、采样器还没跑到"的窗口里断言空输出（main 上连红三次的正是这个形状）。
 *  改成"没等到报告就再堵一次、再等一轮"，最多几轮——慢机器多等，快机器第一轮就过。 */
async function stallUntilReported(lines: string[], blockMs = 300): Promise<void> {
  for (let attempt = 0; attempt < 5 && lines.length === 0; attempt++) {
    blockTheLoopHard(blockMs)
    await settle(700)
  }
}

async function catchOneStall(profile: boolean) {
  const lines: string[] = []
  const monitor = startLoopLagMonitor({
    thresholdMs: 100,
    sampleMs: 200,
    sampleIntervalUs: 200,
    profile,
    log: (m) => lines.push(m),
  })
  try {
    await settle(60) // let the profiler arm
    blockTheLoopHard(400)
    await settle(700) // let the tick fire and the harvest land
  } finally {
    monitor.stop()
  }
  return lines.join('\n')
}

/** Run a calm monitor (no induced stall) and return everything it reported.
 *
 *  The threshold here is deliberately much higher than `catchOneStall`'s 100ms, and the reason
 *  matters: **these two harnesses are watching for different sizes of event.** `catchOneStall`
 *  induces a 400ms block and wants the smallest threshold that reliably catches it. The calm
 *  harness is asserting that the recorder does NOT report when nothing bad happened — and on a
 *  loaded machine "nothing bad happened" is not the same as "the loop never paused". Running the
 *  full suite pins 16 workers to 16 cores and the loop genuinely stalls ~110-200ms (measured:
 *  a real `stalled 112ms` report, 2026-08-28); the recorder is right and the assertion is wrong.
 *  At 100ms this pair of tests was, in practice, asserting that the machine was idle.
 *
 *  400ms keeps what they are actually for. What they guard is the recorder reporting its OWN
 *  arm/re-arm as a stall — and a self-inflicted arm that grew past 400ms in a process this small
 *  is exactly the runaway the scrub exists to prevent (arming costs ~12ms here; see the note on
 *  the rotate test below for why the expensive case can only be verified in production). What we
 *  give up is catching a self-arm regression in the 100-400ms band, which no longer has a clean
 *  signal on a shared machine anyway.
 */
async function watchCalmly(profile: boolean, ms: number) {
  const lines: string[] = []
  const monitor = startLoopLagMonitor({
    thresholdMs: 400,
    sampleMs: 100,
    sampleIntervalUs: 200,
    profile,
    harvestCooldownMs: 0,
    rotateMs: 200, // rotate aggressively: if re-arming self-reported, this would surface it
    log: (m) => lines.push(m),
  })
  try {
    await settle(ms)
  } finally {
    monitor.stop()
  }
  return lines
}

describe('startLoopLagMonitor (real stall, real V8 profiler)', () => {
  it('blames the actual function that blocked the loop, by name', async () => {
    const out = await catchOneStall(true)
    expect(out).toContain('[loop-lag] event loop stalled')
    expect(out).toContain('blockTheLoopHard')
    expect(out).toContain('loop-lag.test.ts:')
  })

  it('without the profiler the same stall is detected but unattributed (proves the blame is real)', async () => {
    const out = await catchOneStall(false)
    expect(out).toContain('[loop-lag] event loop stalled')
    expect(out).not.toContain('blockTheLoopHard')
  })

  // Arming/re-arming must not itself be reported as a stall. NOTE: this test cannot prove the
  // interesting half. Arming costs ~12ms in a process this small (V8's code map is tiny) but
  // 250–500ms in the warm production backend, and only there does a missing histogram scrub make
  // the recorder detect its own re-arm and feed on itself. Verified empirically in-container;
  // this only guards the cheap case, so do not read it as a guarantee.
  it('does not report its own arm/re-arm while rotating on a small heap', async () => {
    expect(await watchCalmly(true, 1200)).toEqual([])
  })

  it('stays silent on an idle loop with profiling off', async () => {
    expect(await watchCalmly(false, 600)).toEqual([])
  })
})

describe('evalStall op attribution (pure)', () => {
  const stall = (ops?: OpOverlap[]) => evalStall(500, 40, 1000, 250, 1000, [], ops)

  it('重叠任务上 stdout 行与 fields,时长按 ms/s 格式化;fields 带任务全长与 tone', () => {
    const r = stall([
      // 跨窗口:contained=false → 行文追加"（跨窗口）",tone 降级为 muted
      { name: 'harvest:bt0', overlapMs: 1234, opMs: 1234, contained: false },
      // contained=true → tone 为 warn,不追加"（跨窗口）"
      { name: 'cookie-refresh', overlapMs: 486, opMs: 486, contained: true },
    ])!
    expect(r.line).toContain('active: harvest:bt0(1.2s), cookie-refresh(486ms)')
    const f = r.entry.fields
    expect(f).toContainEqual({
      label: '在跑 #1',
      value: 'harvest:bt0 — 重叠 1.2s / 任务全长 1.2s（跨窗口）',
      tone: 'muted',
    })
    expect(f).toContainEqual({
      label: '在跑 #2',
      value: 'cookie-refresh — 重叠 486ms / 任务全长 486ms',
      tone: 'warn',
    })
  })

  it('行最多列 3 个(排序已把强嫌疑放前面),恰好 3 个时不带 +N more', () => {
    const r = stall([
      { name: 'a', overlapMs: 300, opMs: 300, contained: true },
      { name: 'b', overlapMs: 200, opMs: 200, contained: true },
      { name: 'c', overlapMs: 100, opMs: 100, contained: true },
    ])!
    expect(r.line).toContain('active: a(300ms), b(200ms), c(100ms)')
    expect(r.line).not.toContain('more')
    // 三个都各自有对应字段,fields 不受行截断影响
    expect(r.entry.fields.filter((x) => x.label.startsWith('在跑'))).toHaveLength(3)
  })

  it('超过 3 个时行截断为前 3 个 + "+N more",但 fields 仍列出全部', () => {
    const r = stall([
      { name: 'a', overlapMs: 400, opMs: 400, contained: true },
      { name: 'b', overlapMs: 300, opMs: 300, contained: true },
      { name: 'c', overlapMs: 200, opMs: 200, contained: true },
      { name: 'd', overlapMs: 100, opMs: 100, contained: true },
      { name: 'e', overlapMs: 50, opMs: 50, contained: true },
    ])!
    expect(r.line).toContain('active: a(400ms), b(300ms), c(200ms) +2 more')
    expect(r.line).not.toContain('d(')
    expect(r.line).not.toContain('e(')
    expect(r.entry.fields.filter((x) => x.label.startsWith('在跑'))).toHaveLength(5)
    expect(r.entry.fields.some((x) => x.label === '在跑 #5' && x.value.startsWith('e —'))).toBe(true)
  })

  it('接线但窗口空 → 报"未埋的门",行不带 active', () => {
    const r = stall([])!
    expect(r.line).not.toContain('active:')
    expect(r.entry.fields.some((x) => x.label === '在跑' && x.value.includes('未埋点'))).toBe(true)
  })

  it('未接线(undefined)→ 输出与现状一致,无任何"在跑"字段', () => {
    const r = stall(undefined)!
    expect(r.line).not.toContain('active:')
    expect(r.entry.fields.some((x) => x.label.startsWith('在跑'))).toBe(false)
  })
})

describe('startLoopLagMonitor + activeOps (real stall)', () => {
  it('真实卡顿的报告带上窗口重叠任务', async () => {
    const lines: string[] = []
    const monitor = startLoopLagMonitor({
      thresholdMs: 100,
      sampleMs: 200,
      log: (m) => lines.push(m),
      activeOps: () => [{ name: 'harvest:test', overlapMs: 321, opMs: 321, contained: true }],
    })
    try {
      await settle(60)
      await stallUntilReported(lines)
    } finally {
      monitor.stop()
    }
    expect(lines.join('\n')).toContain('active: harvest:test(321ms)')
  })

  it('activeOps 抛出也不影响卡顿上报——归因是旁观者，绝不能连累检测', async () => {
    const lines: string[] = []
    const monitor = startLoopLagMonitor({
      thresholdMs: 100,
      sampleMs: 200,
      log: (m) => lines.push(m),
      activeOps: () => {
        throw new Error('boom')
      },
    })
    try {
      await settle(60)
      await stallUntilReported(lines)
    } finally {
      monitor.stop()
    }
    const out = lines.join('\n')
    expect(out).toContain('[loop-lag] event loop stalled')
    expect(out).not.toContain('active:')
  })
})
