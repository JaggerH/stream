/** Task-boundary attribution for the loop-lag flight recorder. Nearly all of this process's
 *  chunky synchronous work enters through a handful of gates (per-source harvest ticks, HTTP
 *  routes, download-queue jobs, cookie refresh, netdisk autosync rounds, recipe-package reloads,
 *  plugin-status probes; sync spans for settings writes / normalize / store).
 *  Each gate wraps its work in track(); on a stall,
 *  loop-lag asks overlapping() which tracked ops intersect the stall window — task-level blame
 *  with zero standing cost, so it stays ON always (unlike the V8 profiler hunting mode).
 *
 *  The ring of FINISHED spans is load-bearing, not a nicety: a stall freezes the loop-lag sampler
 *  itself, so by the time it wakes the culprit op has usually already ended — only its corpse in
 *  the ring can still be matched against the stall window. */

export interface OpSpan { name: string; startMs: number; endMs: number | null }
export interface OpOverlap {
  name: string
  overlapMs: number
  /** the op's own total lifetime (measured to `nowMs` while still in flight) */
  opMs: number
  /** the op's whole life falls inside the window — a strong suspect, because a task that
   *  existed only during the freeze is a better candidate than one that merely happened to
   *  be alive across it */
  contained: boolean
}

/** What the gates get injected with — just the function, decoupled from this class. */
export type TrackFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>
/** Sync twin of TrackFn, for sub-second synchronous phases (normalize / store). */
export type TrackSyncFn = <T>(name: string, fn: () => T) => T

export class OpTracker {
  // No timeout reclamation, on purpose: a leaked span (fn that never resolves) just keeps showing
  // up in every future overlap query, and that persistent visibility IS the intended bug signal —
  // silently expiring it would hide the leak it exists to surface.
  private readonly active = new Set<OpSpan>()
  private readonly ring: OpSpan[] = []

  constructor(private readonly capacity = 200, private readonly now: () => number = Date.now) {}

  /** Wrap one unit of work. Transparent to the caller: the result/error pass through untouched;
   *  the span is finalized in finally, so a throwing fn still leaves evidence. */
  async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const span: OpSpan = { name, startMs: this.now(), endMs: null }
    this.active.add(span)
    try {
      return await fn()
    } finally {
      this.finish(span)
    }
  }

  /** Synchronous twin of track(). Exists because wrapping a sync section in the async track()
   *  closes its span one microtask late — and under a stalled loop that microtask runs only after
   *  the NEXT sync op finishes, silently billing it to the wrong span. Here the span closes on the
   *  same tick the work ends. */
  trackSync<T>(name: string, fn: () => T): T {
    const span: OpSpan = { name, startMs: this.now(), endMs: null }
    this.active.add(span)
    try {
      return fn()
    } finally {
      this.finish(span)
    }
  }

  private finish(span: OpSpan): void {
    span.endMs = this.now()
    this.active.delete(span)
    this.ring.push(span)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)
  }

  /** Ops (active + finished) overlapping [windowStartMs, nowMs], ranked in two tiers: `contained`
   *  ops first, then `overlapMs` descending within each tier. Attribution is a bystander: on ANY
   *  internal error return [] rather than break the report.
   *
   *  Op duration ≠ blocking duration. The window is only sampleMs+maxMs wide (~1–3s typically), so
   *  ANY op spanning the whole window trivially maximizes overlapMs without blocking anything — a
   *  full harvest round, an LLM stream, a cloak page op. A containment RATIO alone would still get
   *  this wrong the other way: a 5ms request has ratio 1.0 and would outrank a 400ms task at ratio
   *  0.9, even though for a ~486ms stall the 400ms task is obviously the better suspect. Tiering by
   *  boolean containment demotes the merely-alive long-runners while keeping overlapMs magnitude
   *  meaningful inside the plausible (contained) set.
   *
   *  This is correct at both ends of stall duration: the window WIDENS with the stall itself
   *  (sampleMs + maxMs), so a genuine long blocker (the file header's motivating ~18s synchronous
   *  stall) still ends up `contained` — it isn't merely alive across a short window, it IS the
   *  window — and still ranks first. */
  overlapping(windowStartMs: number, nowMs = this.now()): OpOverlap[] {
    try {
      const out: OpOverlap[] = []
      const consider = (s: OpSpan) => {
        const overlap = Math.min(s.endMs ?? nowMs, nowMs) - Math.max(s.startMs, windowStartMs)
        if (overlap > 0) {
          const opMs = (s.endMs ?? nowMs) - s.startMs
          const contained = s.startMs >= windowStartMs && (s.endMs ?? nowMs) <= nowMs
          out.push({ name: s.name, overlapMs: overlap, opMs, contained })
        }
      }
      for (const s of this.active) consider(s)
      for (const s of this.ring) consider(s)
      return out.sort((a, b) => (a.contained !== b.contained ? (a.contained ? -1 : 1) : b.overlapMs - a.overlapMs))
    } catch {
      return []
    }
  }
}
