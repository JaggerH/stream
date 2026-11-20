# android-recipe-server-replay

## Why

Today a recipe can drive a browser (`kind:'browser'`), plain HTTP (`kind:'http'` / `'html'`)
or a native desktop application (`kind:'desktop'`). A phone is a different execution surface:
the planning and recipe storage live on the server, the phone only performs ops. The ops exist
(`find` / `invoke` / `click` / `scroll` / `type` / `press` / `windows` / `scopeWindow` /
`ui.tree` / `ui.ocr`), but there is no recipe kind, no server-side runner and no state-feature
path for them. An embedder can call one op at a time and cannot replay a multi-step recipe
against the phone, nor say what screen it is on when a step misses.

Three gaps follow from that:

- **No shared action vocabulary.** Desktop and Android ops overlap in meaning but differ in
  names and argument shapes (`click` vs `tap`, `focusApp` vs `openApp`, `setValue` vs
  `setText`). Nothing states which action is required, what its reply looks like, or what
  happens when a device lacks it. Capability versions exist (`capsVersion` / `caps`) but only
  two ids use them.
- **Coordinates are the only way to express a gesture.** The Android agent has no `longPress`
  or `swipe` op; the only long press is `click` with `button:"right"`, and a swipe is an
  internal detail of `scroll`. The sensitive-action gate never sees a free swipe.
- **No recipe surface and no state features.** There is no `kind:'android'`, so the recipe
  loader and validator reject the shape; `identify` only knows browser (`dom`/`url`) and
  desktop (`a11y`/`text`/`image`) features, so a failed Android step cannot be classified
  against a state graph or recorded in the observation ledger.

## What Changes

- **A cross-platform device action contract.** One openspec capability (`device-actions`)
  defines the normalized action set (`tap`, `longPress`, `swipe`, `scroll`, `type`, `setText`,
  `press`, `screenshot`, `find`, `windows`, `openApp`, `sleep`, plus the read op `url`), the
  argument and receipt shapes, capability negotiation over the existing `capsVersion` /
  `caps` manifest, and the device-side safety gate as a non-bypassable part of the contract.
  The Android agent declares versions for every capability it backs instead of defaulting
  everything but `ui.tree` / `app.launch` to v1, and adds `longPress` / `swipe` (`ui.act` v2).
  `longPress` is judged at its landing point exactly as `click` is (including the blind-click
  rule and the OCR fallback); `swipe` goes through the existing slider judgment on a payment
  or slider control (`ui.tree` v7 adds `viewId` as a `find` query key so a locator can name a
  resource id).
- **`kind:'android'` recipes.** The app is named by package (one name or a list of candidates);
  steps use only the contract's actions; every target is a re-evaluable locator expression
  (an a11y query including `viewId`, or text / OCR text with an optional `where` anchor).
  Coordinates are never stored and the validator rejects any step carrying a bare coordinate.
  Entry and exit screens are declared as feature sets. The recipe validator and the documented
  JSON shape are updated together.
- **Server-side replay over an injected `ops(op, args) → reply` function.** A remote-device
  driver / transport adapter executes each step against the embedder's own device connection;
  Stream does not own the connection. A step failure (target not found / `expect` missed)
  goes through the existing state-classification path, and the run returns the readable
  failure scene (foreground app + visible elements) next to the classification.
- **Android state features.** Foreground package + activity / window title, a11y query hits
  (including `resourceId`), OCR text (`ui.ocr`) and `absent`, fed into the existing
  `identify` / `checkDiscriminative` / `ObservationLedger`. The Android identify policy
  follows `docs/ENGINE.md` §6.5: `on-failure` by default, one screen read per `identify`
  (`windows` + `url` + one `find` with the OCR tier when a text feature is asked for).
- **Public exports.** The runner, driver/transport factory, perception, probe, validator,
  graph helpers and their types are exported from the library entry (`@streamapp/engine`),
  and the export snapshot is updated.

## Capabilities

### New Capabilities

- `device-actions`: the normalized cross-platform action set, reply shapes, capability
  negotiation and the non-bypassable device-side safety gate.

### Modified Capabilities

- `android-recipe-replay`: `kind:'android'` recipe shape and validator; server-side replay
  over an injected ops function; locator-only targeting; entry/exit feature sets; Android
  state features and identify policy.

## Impact

- `app/android/agent/` — `Dispatcher.kt` (ops, capability versions, long press / swipe
  branches), `Device.kt` / `a11y/AndroidDevice.kt` (duration-aware long press), `Query.kt`
  (`viewId` query key), policy `Gate.kt` (swipe through the slider judgment).
- `src/replay/` — new `android-driver.ts`, `android-recipe.ts`, `android-state-perception.ts`,
  `android-runner.ts`; `recipe.ts` / `recipe-store.ts` (`kind:'android'` and validation);
  `state-graph.ts` (`android-window` feature); `state-classify.ts` (perception-generic
  classification); `scene.ts` (Android failure scene); `desktop-driver.ts` (`viewId` in the
  query type).
- `src/engine/index.ts` — public exports.
- `docs/ENGINE.md`, `docs/API.md`, `docs/PACKAGE.md` — the contract, the recipe shape and the
  public entry points.
- Tests: Kotlin dispatcher / policy / query tests; TypeScript driver, validator, perception
  and end-to-end fake-ops tests.

## Non-Goals

- No recipe for a specific app: item production and concrete locators belong to the embedder.
- No iOS support.
- No change to existing `kind:'browser'` / `'desktop'` behavior, including their gate order
  and reply shapes.
- No new device connection: the embedder supplies the ops function; Stream never dials the
  phone from this path.
