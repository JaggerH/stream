import type { FacilityAuthNeed } from './facility-auth-view.ts'

/** Debounces the WS push to the not-needing → needing edge. Runtime-only (no persistence,
 *  spec I2): a flagged set that resets on restart, re-derivable from the next harvest. */
export class AuthNeededNotifier {
  private flagged = new Set<string>()
  constructor(private readonly broadcast: (msg: unknown) => void) {}

  sync(needs: FacilityAuthNeed[]): void {
    const now = new Set(needs.map((n) => n.facility))
    for (const need of needs) {
      if (!this.flagged.has(need.facility)) this.broadcast({ type: 'auth-needed', facility: need.facility, need })
    }
    this.flagged = now
  }
}
