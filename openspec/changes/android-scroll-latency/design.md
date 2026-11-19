# android-scroll-latency — design

## Problem shape

The op is slow because it waits too much, not because the device is slow to act. On a page that
keeps changing, `awaitMove` requires the content print to be *both* different and stable, so
every step runs the full 12-poll budget; `settle` requires accessibility events to be quiet,
which a countdown never is, so it runs its 2.5 s cap reading the tree on every 100 ms poll; and
`scrollUntil` rebuilds the candidate list on every step. A tree read on a large feed is the
expensive unit, and the old code does tens of them per op.

## Decisions

**A step is done when the list visibly moved.** After an accessibility scroll, the step is
complete when either

- the `scroll` container's first visible item changed position between two reads
  (`firstItemPrint`: the first visible, named, non-scrollable node overlapping the container's
  on-screen area, by class, resource id and rect), or
- the content print is unchanged between two consecutive reads (it settled).

The first item's *position* is the signal, not its label: a ticking countdown changes a name but
not where things are, so it neither completes a step early nor hides a real move. A new row
recycled into the same slot may keep the position; then the second signal or the step cap ends
the wait. The step cap (800 ms) is the backstop for both.

**One step is bounded, and so is the whole op.** `SCROLL_STEP_CAP_MS = 800`,
`SCROLL_TOTAL_CAP_MS = 10_000`. The total bound is checked between steps, like the existing
`until` bounds: an action in flight finishes, then the op returns the steps it completed and
`stopped: "time"`. With `amount` clamped to 10, `10 × 800 ms` is under the whole-op bound, so a
normal scroll never hits it. `until`'s default `timeoutMs` becomes 10 000 ms (explicit values may
still go to 60 000): the old 15 s default let the caller's timeout end a search on a moving page
before the op could report anything useful.

**A scroll's settle check is short and does not wait for quiescence.** A scroll is not a commit;
the caller needs to know whether the screen changed and what kind of change it was, not that the
page went still. The check is a single poll (the settle poll interval plus one tree read), capped
at `SCROLL_SETTLE_CAP_MS = 200 ms`; `settled` keeps its documented meaning (quiet and changed) and
is simply `false` on a busy page. Other gated ops keep the 450 ms quiet / 2.5 s cap behaviour.

**The node that moved is remembered.** `scroll` gains an optional `only` node. Plain scroll
already stops trying other candidates once one moved; `until` now selects a candidate once and
passes it to every subsequent step (`only`), so it neither re-reads the root to rank candidates
nor tries a second container. If the remembered node refuses or stops moving, the existing
end-of-content rule applies; it does not fall back to another node.

**Timing is measured with the dispatcher's clock.** The dispatcher already takes an injectable
`now` for `until`; the settle check now uses it too. Each phase is timed around its calls
(`scrollNode`, `swipe`, the settle check, the tree reads used for movement checks) and reported
as `timing`. Tests advance a fake clock from the `sleep`/`scrollNode`/tree-read hooks, so the
bounds are exercised deterministically rather than by wall time.

**Version.** `ui.tree` goes to v5: the receipt gained `timing`, the plain scroll gained
`stopped: "time"` on a capped op, and the wait behaviour changed. All additions are optional, so
v4 callers keep working.

## Alternatives

- *Skip the settle check for scroll entirely.* Saves one tree read but loses `effect`, which
  recipes use to tell a scroll from a no-op. One poll is cheap enough.
- *Detect "animated" regions and hash only the rest.* Needs a reliable animation signal the
  accessibility tree does not provide; first-item position is the smallest observable fact that
  answers the question.
- *Leave `until`'s 15 s default.* A search on a moving page then still runs longer than the
  whole-op bound the caller was promised.
- *Interrupt an in-flight accessibility action.* The platform does not offer it; the op reports
  after the step returns.

## Verification

- JVM unit tests: a changing page (every tree read ticks a countdown), expensive tree reads and
  slow scroll actions on a fake clock; assert the receipt's `timing`, the per-step and whole-op
  bounds, `stopped: "time"` with completed steps, and that the candidate chosen first is the only
  one scrolled.
- Existing dispatcher, scroll-until and navigation tests stay green.
- `docs/API.md` scroll / settle / capability sections updated.
