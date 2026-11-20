# android-recipe-server-replay — tasks

## 1. Failing tests first

- [x] 1.1 Device action contract: drill-down driver test — `tap` / `longPress` / `swipe` map to the
      wire ops; an undeclared op and a too-old `ui.act` / `ui.tree` refuse before sending.
- [x] 1.2 Android recipe validator: locator-only targets, package candidates, entry / exit feature
      sets, coordinate rejection, scroll / press / duration bounds.
- [x] 1.3 Android state perception: one read per `identify` (OCR only when a text feature is asked
      for), `a11y` with `viewId`, OCR text with `where`, `android-window`, `absent`,
      same-group collision, observation ledger / discrimination gate.
- [x] 1.4 End-to-end fake ops: a four-step recipe runs; a renamed control is drift + `unknown` + a
      readable failure scene; an `expect` miss and an ambiguous locator are drift; an optional
      step is skipped; a recognized failure state reaches `onObserved`.
- [x] 1.5 Kotlin: dispatcher op list / long press / swipe, policy gate for long press and slider
      swipe, `viewId` query, capability manifest versions.

## 2. Implementation

- [x] 2.1 `android-driver.ts`: normalized action names, wire mapping, capability negotiation,
      opaque `ops` function and transport adapter.
- [x] 2.2 `android-recipe.ts`: recipe / locator / step types and the load-time validator;
      `kind:'android'` wired into `recipe.ts` / `recipe-store.ts` / `needsBrowser`.
- [x] 2.3 `android-state-perception.ts`: probe, single-frame perception, Android feature evaluation,
      failure scene; `state-graph.ts` gains `android-window`; `classifyByState` delegates to
      `classifyWithPerception`.
- [x] 2.4 `android-runner.ts`: step execution over the injected driver, locator resolution,
      entry / exit / expect polling, drift classification and scene.
- [x] 2.5 Kotlin: `longPress` / `swipe` ops with the existing safety gate, duration-aware long press,
      `viewId` query key, `ui.tree` v7 / `ui.act` v2 declarations.
- [x] 2.6 Public exports in `src/engine/index.ts` and the export snapshot.

## 3. Documentation and verification

- [x] 3.1 `docs/ENGINE.md`: Android locate / feature / identify-policy / locator notes.
- [x] 3.2 `docs/API.md`: `longPress` / `swipe` ops, `viewId`, capability versions, server-side replay.
- [x] 3.3 `docs/PACKAGE.md`: §2.4.1 recipe shape, locator rule, entry / exit features, injected ops,
      public exports.
- [x] 3.4 Kotlin unit tests and the affected Stream suites.
