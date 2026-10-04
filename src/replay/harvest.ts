import { getPath, mapItem, type MappedItem } from './interpret.ts'
import type { AccumulatorInput } from './recipe.ts'

export function urlMatches(pattern: string, url: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(url)
}

export class HarvestAccumulator {
  private matched = 0
  private malformed = 0
  private dedupedIds = new Set<string>()
  private collectedItems: MappedItem[] = []

  constructor(private readonly h: AccumulatorInput) {}

  offer(body: unknown): { fresh: number } {
    this.matched++

    // 1. Assert validation on response body
    if (this.h.assert) {
      for (const a of this.h.assert) {
        if (getPath(body, a.path) == null) {
          this.malformed++
          return { fresh: 0 }
        }
      }
    }

    // 2. Extract items array. A response that passes assert but has no item array
    // at itemsAt is malformed too — otherwise a relocated list (assert path intact)
    // silently harvests 0 items without ever tripping drift.
    const rawItems = getPath(body, this.h.itemsAt)
    if (!Array.isArray(rawItems)) {
      this.malformed++
      return { fresh: 0 }
    }

    let freshCount = 0
    for (const item of rawItems) {
      if (this.done) break

      const idVal = getPath(item, this.h.dedupeBy)
      if (idVal == null) {
        // "某条缺 dedupeBy 路径" -> dropped, not counted, not drift
        continue
      }
      const idStr = String(idVal)
      if (!this.dedupedIds.has(idStr)) {
        this.dedupedIds.add(idStr)
        this.collectedItems.push(mapItem(item, this.h.mapping))
        freshCount++
      }
    }

    return { fresh: freshCount }
  }

  get size(): number {
    return this.collectedItems.length
  }

  get done(): boolean {
    return this.size >= this.h.targetCount
  }

  get matchedResponses(): number {
    return this.matched
  }

  get malformedRatio(): number {
    if (this.matched === 0) return 0
    return this.malformed / this.matched
  }

  items(): MappedItem[] {
    return this.collectedItems
  }

  driftReason(): string | null {
    if (this.matched > 0 && this.malformedRatio > 0.8) {
      return `Drift detected: ${this.malformed} out of ${this.matched} responses were malformed (ratio: ${this.malformedRatio.toFixed(2)})`
    }
    return null
  }
}
