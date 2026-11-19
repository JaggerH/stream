# android-scroll-latency — tasks

## 1. Failing tests first

- [x] 1.1 A constantly changing page (every tree read ticks a countdown) with a fake clock: a
      10-step scroll returns inside the whole-op bound, not after tens of seconds.
- [x] 1.2 A step completes as soon as the container's first visible item changes position, and a
      step that never moves is bounded by the 800 ms step cap.
- [x] 1.3 A slow action reaches the 10 s bound: the receipt carries the completed steps and
      `stopped: "time"`.
- [x] 1.4 The receipt carries `timing: {a11yMs, gestureMs, settleMs, changeCheckMs, steps}`, and
      the existing receipt keys keep their meaning.
- [x] 1.5 A page whose accessibility events never go quiet does not hold the scroll's settle
      check past one short poll.
- [x] 1.6 `until` remembers the first container that moved: later steps do not try a container
      that became larger, and the default time bound is 10 s.
- [x] 1.7 Existing dispatcher / navigation / scroll-until tests updated only where the receipt
      gained `timing`; everything else stays green.

## 2. Implementation

- [x] 2.1 `ScrollTiming` accumulator in the dispatcher; phase timing around `scrollNode`,
      `swipe`, the settle check and the change-check reads.
- [x] 2.2 `firstItemPrint` and the new `awaitMove` completion rule; `SCROLL_STEP_CAP_MS`.
- [x] 2.3 Whole-op deadline (`SCROLL_TOTAL_CAP_MS`) for plain scroll and `until`; `stopped`
      on a capped plain scroll; `until` default `timeoutMs` 10 s.
- [x] 2.4 Short settle check for scroll (`SCROLL_SETTLE_CAP_MS`, no quiet requirement); settle
      reads the dispatcher clock.
- [x] 2.5 Remember the moved container: `only` node threaded through plain scroll and `until`.
- [x] 2.6 `ui.tree` capability v5 and its comments; update the capability tests.

## 3. Documentation and verification

- [x] 3.1 `docs/API.md`: scroll row (timing, bounds, remembered container, `stopped`), settle
      paragraph, capability manifest version.
- [x] 3.2 Kotlin unit tests for the agent module green on lean (aapt2 override, JDK 17).
- [x] 3.3 Stream full test suite and `pnpm typecheck` on lean, with baseline failures listed
      separately.
