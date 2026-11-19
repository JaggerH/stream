# android-scroll-latency

## Why

On a real phone, a shopping feed whose content keeps changing (a carousel, an autoplaying
video, a price countdown) turns one `scroll` into a 9–90 second op: 9.4 s for one step, 34 s for
two, 31 s for four, 29 s for ten. A scroll-until on the same page ended in the caller's op timeout
at 41 s and 90 s. The same phone scrolls a system settings page in 1–2 s.

Two waits add up on such a page. After every accessibility scroll step the dispatcher waits for
the content print to stop changing as well as for it to change, so a page that never goes still
uses the whole poll budget on every step. After the op, the settle wait requires accessibility
events to be quiet, which never happens while a countdown ticks, so it runs to its 2.5 s cap
reading the whole tree on every poll. A scroll-until re-enumerates and re-ranks the scroll
candidates on every step it takes. The caller cannot see where the time went, and its own op
timeout is the only thing that ends the op.

## What Changes

- **A scroll receipt carries the phase timings (optional, backward compatible).**
  `timing: {a11yMs, gestureMs, settleMs, changeCheckMs, steps}` says how long the accessibility
  steps, the fallback swipes, the post-action settle check and the tree reads for change detection
  took, and how many steps completed. Callers can tell where a slow scroll went without guessing.
- **A step ends when it has visibly moved.** After an accessibility scroll, the step is complete
  as soon as the scroll container's first visible item has changed position between two reads, or
  the content print is unchanged between two consecutive reads. A page whose carousel or countdown
  never goes still no longer spends the whole poll budget on every step. One step waits at most
  800 ms for its movement.
- **A whole scroll is bounded.** A scroll op (with or without `until`) returns within 10 s by
  default. The bounds are checked between steps, like the existing step and time bounds: when the
  time bound is hit, the reply carries the steps that did complete and `stopped: "time"`; the
  caller's op timeout no longer has to end the op. `until`'s default `timeoutMs` drops from 15 s
  to 10 s (an explicit value may still be up to 60 s). The post-action settle check after a scroll
  is one short check (at most 200 ms) and does not wait for accessibility quiescence: a scroll is
  not a commit.
- **The container that moved is remembered for the rest of the scroll.** Once a scrollable node's
  step confirms movement, later steps of the same op use that node; other candidates are not
  retried, and `until` no longer re-ranks the candidates on every step.
- **Capability `ui.tree` goes to v5** for the new receipt fields and behaviour. Older callers
  ignore `timing` and the new `stopped` value on a plain scroll.

## Capabilities

### Modified Capabilities

- `android-recipe-replay`: the scroll timing receipt, the per-step and whole-op bounds, and the
  remembered scroll container.

## Impact

- `app/android/agent/src/main/java/com/streamapp/android/agent/Dispatcher.kt` (scroll, scrollUntil,
  awaitMove, settle), `.../agent/Stability.kt` (settle timing constants), `docs/API.md` (scroll and
  settle sections).
- Compatibility: every new field is optional; the plain scroll receipt keeps its existing keys and
  gains `timing` and, only on a capped op, `stopped: "time"`.
