/** Always-on event-loop-lag flight recorder. Node runs one thread: any SYNCHRONOUS operation
 *  (a big JSON.parse, a batch of synchronous better-sqlite3 writes, a heavy registry build) blocks
 *  ALL I/O — HTTP requests, timers, and health probes included — until it finishes. Such a freeze
 *  is otherwise invisible: it even delays its own would-be logger. This samples the event-loop
 *  delay histogram and, whenever a window stalls past a threshold, drops a durable stdout line so
 *  the freeze leaves evidence. (Motivating case: a one-off "all 6 plugins down 19s" alarm that was
 *  NOT a network fault but a real ~18s synchronous stall starving the 1.2s-timeout probes.) */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import type { DebugEntry, DebugField } from './debug.ts'
import type { OpOverlap } from './op-track.ts'

/** perf_hooks reports delays in nanoseconds. */
const toMs = (ns: number) => ns / 1e6

export interface LoopLagReport {
  /** durable one-line flight-recorder message for stdout (greppable in container logs) */
  line: string
  /** structured entry for the DebugBox `loop` channel (UI surface) */
  entry: DebugEntry
}

/* ── Culprit attribution ────────────────────────────────────────────────────────────────────
 * The delay histogram answers "did we stall, and for how long" but never "who did it": it runs
 * ON the blocked loop, so by the time it wakes up the offending call has already returned and
 * its stack is gone. The V8 CPU profiler samples from outside the loop on its own clock, so a
 * synchronous block cannot silence it — during a 317ms freeze it keeps recording the very stack
 * that is doing the freezing. Cross the two and the stall gets a name. */

/** One frame of a V8 CPU profile (`node:inspector` Profiler.stop). Line numbers are 0-based. */
export interface CpuCallFrame {
  functionName: string
  scriptId: string
  url: string
  lineNumber: number
  columnNumber: number
}

export interface CpuProfileNode {
  id: number
  callFrame: CpuCallFrame
  hitCount?: number
  children?: number[]
}

/** The subset of Profiler.stop's result we consume. All times are microseconds. */
export interface CpuProfile {
  nodes: CpuProfileNode[]
  startTime: number
  endTime: number
  samples: number[]
  /** timeDeltas[i] is how long samples[i]'s stack ran, relative to the previous sample. */
  timeDeltas: number[]
}

/** A blamed frame: how much wall time was spent with this exact frame on top of the stack. */
export interface HotFrame {
  fn: string
  /** `app/src/store.ts:120`, or `native` for frames with no script */
  site: string
  selfMs: number
}

/** V8 bookkeeping frames meaning "no JS was on the stack" — the loop being free is not a culprit.
 *  Note `(garbage collector)` is deliberately NOT here: a long GC pause is a real stall. */
const IDLE_FRAMES = new Set(['(idle)', '(root)'])

/** Human-readable source location. Dependency frames arrive as deeply-nested pnpm store paths
 *  (`/app/node_modules/.pnpm/better-sqlite3@11.3.0/node_modules/better-sqlite3/lib/…`); keep only
 *  the package-relative tail so the row stays legible without inventing a truncation rule. */
function siteOf(frame: CpuCallFrame): string {
  if (!frame.url) return 'native'
  const path = frame.url.replace(/^file:\/\//, '')
  const marker = path.lastIndexOf('node_modules/')
  const rel = marker >= 0 ? path.slice(marker + 'node_modules/'.length) : path.replace(/^\/+/, '')
  return `${rel}:${frame.lineNumber + 1}`
}

/**
 * Pure attribution: given a CPU profile, blame the frames that burned wall time at/after `sinceUs`
 * (absolute microseconds, same clock as `profile.startTime`), hottest first, capped at `topN`.
 *
 * Self time only — the frame actually executing, not its callers — because a stall is caused by
 * whoever was on TOP of the stack for those milliseconds. Slicing by `sinceUs` is what isolates
 * the stall from the calm seconds around it; without it a 317ms freeze is diluted by idle samples.
 */
export function hotFrames(profile: CpuProfile, sinceUs: number, topN: number): HotFrame[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  // Fold by function identity, NOT by node id: V8's profile is a call TREE, so one function
  // reached from ten call paths is ten nodes. Keying by node would shatter the real hog into ten
  // slivers and bury it under some unrelated frame that happens to have a single fat node.
  const ident = (f: CpuCallFrame) => `${f.functionName}\u0000${f.url}\u0000${f.lineNumber}`
  const totals = new Map<string, { frame: CpuCallFrame; us: number }>()
  let at = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) {
    const delta = profile.timeDeltas[i] ?? 0
    at += delta
    if (at < sinceUs) continue
    const frame = byId.get(profile.samples[i])?.callFrame
    if (!frame || IDLE_FRAMES.has(frame.functionName)) continue
    const slot = totals.get(ident(frame))
    if (slot) slot.us += delta
    else totals.set(ident(frame), { frame, us: delta })
  }
  return [...totals.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, topN)
    .map(({ frame, us }) => ({
      fn: frame.functionName || '(anonymous)',
      site: siteOf(frame),
      selfMs: Math.round(us / 1e3),
    }))
}

/**
 * Pure decision + format: given a sampling window's max/mean event-loop delay (ms) and whatever
 * frames the CPU profiler caught red-handed (`frames`, hottest first — see `hotFrames`), return a
 * report IFF the window stalled at/over `thresholdMs`, else null. Split from the perf_hooks wiring
 * so "when do we flag, and what do we say" is unit-testable without real timing.
 */
export function evalStall(
  maxMs: number,
  meanMs: number,
  windowMs: number,
  thresholdMs: number,
  at: number,
  frames: HotFrame[] = [],
  activeOps?: OpOverlap[],
): LoopLagReport | null {
  if (maxMs < thresholdMs) return null
  const max = Math.round(maxMs)
  const [worst] = frames
  // Only the worst offender goes on the stdout line — it stays one greppable line; the full
  // ranking rides along in the fields, where the UI can afford the rows.
  const blame = worst ? ` — blamed: ${worst.fn} (${worst.site}) ${worst.selfMs}ms` : ''
  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)
  // Task-level attribution rides the same line/fields as the profiler's frame-level blame.
  // undefined = tracker not wired (today's output, byte-identical); [] = wired but nothing
  // overlapped — itself a finding: the stall came through a gate we haven't instrumented.
  //
  // Line stays bounded to the first 3 (the two-tier sort in OpTracker.overlapping already puts
  // strong suspects first) — the HTTP gate tracks EVERY request, so an unbounded line during e.g.
  // an SPA first paint (dozens-to-hundreds of static asset requests) would produce a line too long
  // to read or grep, destroying the one durable artifact this flight recorder exists to produce.
  // The full ranking still rides along in the fields below, unbounded, where the UI can afford it.
  const ACTIVE_LINE_CAP = 3
  const active = activeOps?.length
    ? ` — active: ${activeOps
      .slice(0, ACTIVE_LINE_CAP)
      .map((o) => `${o.name}(${fmtMs(o.overlapMs)})`)
      .join(', ')}${activeOps.length > ACTIVE_LINE_CAP ? ` +${activeOps.length - ACTIVE_LINE_CAP} more` : ''}`
    : ''
  const activeFields: DebugField[] =
    activeOps === undefined
      ? []
      : activeOps.length
        // tone/wording follow `contained`, not rank: a task that was merely alive across the
        // freeze (contained=false) must not shout "warn" just because it sorted first for having
        // the largest raw overlap — see OpTracker.overlapping's two-tier ranking rationale.
        ? activeOps.map((o, i) => ({
          label: `在跑 #${i + 1}`,
          value: `${o.name} — 重叠 ${fmtMs(o.overlapMs)} / 任务全长 ${fmtMs(o.opMs)}${o.contained ? '' : '（跨窗口）'}`,
          tone: o.contained ? 'warn' as const : 'muted' as const,
        }))
        : [{ label: '在跑', value: '窗口内无已埋点任务——卡顿来自未埋点的门', tone: 'warn' as const }]
  const culprits: DebugField[] = frames.length
    ? frames.map((f, i) => ({
      label: `#${i + 1} ${f.selfMs}ms`,
      value: `${f.fn} — ${f.site}`,
      tone: i === 0 ? 'bad' : 'muted',
    }))
    // Absence is itself a finding: a stall with no frames means the profiler was off or the hog
    // was outside JS (native/syscall). Saying nothing here would read as "nothing to see".
    : [{ label: 'culprit', value: '未捕获（profiler 未启用或采样未命中）', tone: 'muted' }]
  return {
    line: `[loop-lag] event loop stalled ${max}ms (window ${windowMs}ms, mean ${meanMs.toFixed(1)}ms) — a synchronous op blocked I/O${blame}${active}`,
    entry: {
      id: `loop:stall@${at}`,
      at,
      channel: 'loop',
      key: 'stall',
      title: '事件循环卡顿',
      summary: worst
        ? `${worst.fn}（${worst.site}）把事件循环堵了 ${max}ms（阈值 ${thresholdMs}ms）——期间所有请求、定时器、健康探测都被卡住`
        : `一个同步操作把事件循环堵了 ${max}ms（阈值 ${thresholdMs}ms）——期间所有请求、定时器、健康探测都被卡住`,
      ok: false,
      fields: [
        { label: 'max stall', value: `${max}ms`, tone: 'bad' },
        { label: 'window', value: `${windowMs}ms`, tone: 'muted' },
        { label: 'mean', value: `${meanMs.toFixed(1)}ms`, tone: 'muted' },
        ...activeFields,
        ...culprits,
      ],
    },
  }
}

export interface LoopLagOptions {
  /** stall threshold (ms); a window whose MAX delay ≥ this is reported. Default 250. */
  thresholdMs?: number
  /** histogram sampling period (ms). Default 1000. */
  sampleMs?: number
  /** durable stdout logger. Default console.warn. */
  log?: (msg: string) => void
  /** optional DebugBox surface (loop channel). */
  onDebug?: (entry: DebugEntry) => void
  /** injectable clock (tests). Default Date.now. */
  now?: () => number
  /**
   * Arm the V8 CPU profiler so stalls get a culprit stack. NOT free, and not free in a subtle way:
   * `Profiler.start` makes V8 walk every compiled function to rebuild its code map, which itself
   * blocks the loop — measured at ~11ms in a bare process, ~87ms once the app graph is loaded, and
   * 250–500ms in a warm production backend. Harvesting (`Profiler.stop`) is cheap by comparison
   * (5–60ms), so the cost is entirely in ARMING. Hence: off by default, armed once, re-armed at
   * most every `harvestCooldownMs`. Default false.
   */
  profile?: boolean
  /** CPU profiler sampling interval (µs). Default 1000 (1ms) → a 250ms stall yields ~250 samples. */
  sampleIntervalUs?: number
  /** how many blamed frames to report. Default 5. */
  topFrames?: number
  /** Minimum gap between profiler harvests. Each harvest forces a re-arm, and re-arming stalls the
   *  loop, so attributing EVERY stall would make this recorder the top cause of stalls. Stalls
   *  inside the cooldown are still reported, just unattributed. Default 60_000. */
  harvestCooldownMs?: number
  /** Re-arm this long after the last harvest even if nothing stalled, so an un-harvested profile
   *  cannot accumulate samples forever. Default 600_000 (10min). */
  rotateMs?: number
  /** Task-boundary attribution (op-track): given the stall window's start (epoch ms), return
   *  tracked ops overlapping [windowStart, now], longest first. Wired in serve.ts from the
   *  process-wide OpTracker; absent → reports carry no task-level blame (today's behavior). */
  activeOps?: (windowStartMs: number) => OpOverlap[]
}

export interface LoopLagMonitor {
  stop(): void
}

/** Promisified inspector call. The typings only admit known method literals, so we dispatch by
 *  string — but `post` reads a private field, so it MUST stay bound to the session; detaching it
 *  throws and would silently degrade every stall to "culprit not captured". */
const post = <T>(session: Session, method: string, params?: Record<string, unknown>): Promise<T> =>
  new Promise((resolve, reject) => {
    const dispatch = session.post.bind(session) as unknown as (
      m: string,
      p: Record<string, unknown> | undefined,
      cb: (err: Error | null, res?: unknown) => void,
    ) => void
    dispatch(method, params, (err, res) => (err ? reject(err) : resolve(res as T)))
  })

/** Attach a CPU profiler and begin recording. Returns null if V8 refuses — lag detection still runs. */
function connectProfiler(intervalUs: number): Session | null {
  try {
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', { interval: intervalUs })
    session.post('Profiler.start')
    return session
  } catch {
    return null
  }
}

/**
 * Start the flight recorder. Samples every `sampleMs`; on a stall ≥ `thresholdMs`, logs a stdout
 * line (+ emits a `loop` DebugEntry). A long synchronous block delays this sampler too, so the
 * stall is reported on the first tick AFTER the loop frees — precisely the post-hoc evidence a
 * freeze otherwise erases. Call from the process entrypoint (serve.ts), not per-bootstrap, so
 * tests stay quiet.
 *
 * Three instruments: the delay histogram (free) decides WHETHER we stalled; the task-level op
 * tracker (also free, always on) says WHO in the common case — which tracked op overlapped the
 * stall window; and — only if `profile` is on — an armed V8 CPU profile, sampled off-loop so the
 * freeze cannot silence it, narrows WHO down to a function. Arming is the expensive half (see
 * `LoopLagOptions.profile`), so the profiler is armed once and re-armed at most every
 * `harvestCooldownMs`; the re-arm's own stall is scrubbed from the histogram, without which the
 * recorder would detect its own stall, harvest, re-arm, and feed on itself forever.
 */
export function startLoopLagMonitor(opts: LoopLagOptions = {}): LoopLagMonitor {
  const thresholdMs = opts.thresholdMs ?? 250
  const sampleMs = opts.sampleMs ?? 1000
  const topFrames = opts.topFrames ?? 5
  const cooldownMs = opts.harvestCooldownMs ?? 60_000
  const rotateMs = opts.rotateMs ?? 600_000
  const log = opts.log ?? ((m) => console.warn(m))
  const now = opts.now ?? Date.now
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()

  let session = opts.profile ? connectProfiler(opts.sampleIntervalUs ?? 1000) : null
  // Backdated by one cooldown so the FIRST stall is attributable — when you are hunting, the stall
  // you are staring at is the one you need named. (Still short of rotateMs, so nothing rotates.)
  let harvestedAt = now() - cooldownMs
  let busy = false

  /** Re-arm the profiler. Blocks the loop (V8 rebuilds its code map) — so scrub the delay we just
   *  caused, otherwise the next tick reports US as the culprit and harvests again, forever. */
  const rearm = () => {
    if (!session) return
    try {
      session.post('Profiler.start')
    } catch {
      session = null // profiler wedged — keep plain lag detection alive rather than dying
    }
    harvestedAt = now()
    h.reset()
  }

  /** Stop the armed profile and hand it back. Cheap; the re-arm afterwards is what costs. */
  const harvest = async (): Promise<CpuProfile | null> => {
    if (!session) return null
    try {
      return (await post<{ profile: CpuProfile }>(session, 'Profiler.stop')).profile
    } catch {
      return null
    }
  }

  const timer = setInterval(() => {
    const maxMs = toMs(h.max)
    const meanMs = toMs(h.mean)
    h.reset()
    const stalled = maxMs >= thresholdMs
    // Window start reaches BACK past the sampler's own frozen period (now − sampleMs − maxMs):
    // the stall delayed this very tick, so the culprit op may have ended up to maxMs ago.
    let ops: OpOverlap[] | undefined
    if (stalled && opts.activeOps) {
      try {
        ops = opts.activeOps(now() - sampleMs - maxMs)
      } catch {
        // attribution is a bystander: a broken injection must never kill the recorder
        ops = []
      }
    }
    const armed = !!session
    const cool = armed && now() - harvestedAt >= cooldownMs
    // Re-arm on a timer even when healthy: an un-harvested profile accumulates samples forever.
    const stale = armed && now() - harvestedAt >= rotateMs
    if (busy || (!stalled && !stale)) return
    // A stall we cannot attribute (profiler off, or still cooling down) is still worth reporting —
    // knowing the loop froze beats knowing nothing.
    if (stalled && !cool) {
      const report = evalStall(maxMs, meanMs, sampleMs, thresholdMs, now(), [], ops)
      if (report) {
        log(report.line)
        opts.onDebug?.(report.entry)
      }
      if (!stale) return
    }
    busy = true
    void (async () => {
      try {
        const profile = await harvest()
        // Slice to just the stall: endTime is "now" in the profile's own clock, which avoids
        // mapping V8's monotonic microseconds onto Date.now(). Without this the freeze's samples
        // would be diluted by the healthy seconds around it.
        const frames = profile && stalled && cool
          ? hotFrames(profile, profile.endTime - sampleMs * 1e3, topFrames)
          : []
        if (stalled && cool) {
          const report = evalStall(maxMs, meanMs, sampleMs, thresholdMs, now(), frames, ops)
          if (report) {
            log(report.line)
            opts.onDebug?.(report.entry)
          }
        }
        rearm() // must be last: it stalls the loop and scrubs the histogram
      } finally {
        busy = false
      }
    })()
  }, sampleMs)
  // never hold the process open just for the monitor
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      h.disable()
      if (session) {
        try {
          session.post('Profiler.disable')
          session.disconnect()
        } catch { /* already gone */ }
        session = null
      }
    },
  }
}
