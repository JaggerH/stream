/** One timed phase of a recipe run: `ms` is measured wall-clock. */
export interface PhaseTiming {
  phase: string
  ms: number
}

export interface RunProbeDeps {
  now?: () => number
  log?: (line: string) => void
}

/**
 * Per-run observability for a recipe: wall-clock per phase (entry / login / each step /
 * harvest). Timing is ALWAYS collected (cheap, returned on the outcome); the log lines happen
 * only when `enabled`, so it is silent in prod/tests and lit up in dev (see recipeProbeEnabled).
 * An injectable clock keeps it deterministic under test.
 *
 * It used to sample chromium RSS at every phase boundary too. That number described
 * CloakBrowser, which ran inside this container; the tabs are now in the user's own Chrome, so
 * a container-side /proc scan would only ever report "no chromium here" — a measurement of the
 * wrong process is worse than no measurement, because it reads like a real zero.
 */
export class RunProbe {
  private last: number
  private readonly marks: PhaseTiming[] = []
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly sourceId: string, private readonly enabled: boolean, deps: RunProbeDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((l) => console.log(l))
    this.last = this.now()
  }

  /** Close the phase since the previous mark. */
  mark(phase: string): void {
    const t = this.now()
    const ms = t - this.last
    this.last = t
    this.marks.push({ phase, ms })
    if (this.enabled) {
      this.log(`[recipe-probe] ${this.sourceId}  ${phase.padEnd(16)} ${String(ms).padStart(6)}ms`)
    }
  }

  timings(): PhaseTiming[] {
    return this.marks
  }

  /** An extra, free-form line under a phase (e.g. the per-scroll breakdown of a scroll step
   *  whose single mark hides where its wall-clock went). Silent unless probing is enabled. */
  detail(line: string): void {
    if (this.enabled) this.log(`[recipe-probe] ${this.sourceId}  ${line}`)
  }

  /** One roll-up line: total wall-clock, items harvested. */
  summary(itemCount: number): void {
    if (!this.enabled) return
    const total = this.marks.reduce((s, m) => s + m.ms, 0)
    this.log(`[recipe-probe] ${this.sourceId}  TOTAL ${(total / 1000).toFixed(1)}s  items ${itemCount}`)
  }
}

/** Dev-on by default; set RECIPE_PROBE=0 to silence (e.g. a noisy prod deployment). */
export const recipeProbeEnabled = (): boolean => process.env.RECIPE_PROBE !== '0'
