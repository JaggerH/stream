## ADDED Requirements

### Requirement: `kind:'android'` recipes name an app and store only re-evaluable locators

An Android recipe SHALL declare `kind: "android"`, `sourceId`, `app.package` (one package name or a
non-empty list of candidates) and a non-empty `steps` array. Each step SHALL use one of the device
action vocabulary's names (`openApp`, `tap`, `longPress`, `swipe`, `scroll`, `type`, `setText`,
`press`, `screenshot`, `find`, `windows`, `sleep`).

Every target SHALL be a re-evaluable locator expression: an accessibility query (`query`, including
`viewId`), a `resourceId`, or a text locator (`text` plus an optional `where` anchor). A `swipe`
SHALL name its two ends with locators, never with absolute points. The recipe SHALL NOT contain an
absolute coordinate anywhere in its steps; the validator SHALL reject `x`, `y`, `rect`, `at`,
`point` or equivalent bare-coordinate fields in a step or locator.

Entry and exit screens SHALL be declared as feature sets (`entry.features` / `exit.features`), using
the Android feature vocabulary (`a11y`, `text`, `android-window`). The validator SHALL require a
non-empty feature list and SHALL reject feature kinds Android cannot evaluate (`dom`, `url`,
`image`).

#### Scenario: coordinates are rejected at load time

- **WHEN** a recipe step contains a target written as `{x: 540, y: 1200}` or a `swipe` written as
  `from: {x: 540, y: 1800}`
- **THEN** validation fails with a message naming the coordinate field, before anything runs

#### Scenario: a resource id is a valid locator

- **WHEN** a step uses `resourceId: "com.example:id/search"`
- **THEN** validation accepts it and the runner resolves it through `find {query:{viewId}}`

#### Scenario: a package candidate list

- **WHEN** `app.package` is `["com.example.app", "com.example.app.debug"]`
- **THEN** `openApp` tries the candidates in order and stops at the first one the phone brought to
  the foreground

### Requirement: Server-side replay uses an injected `ops` function

The recipe runner SHALL execute Android recipes against a caller-supplied
`ops(op, args) → reply` function (or a driver built over it). Stream SHALL NOT open the device
connection itself. Step failures — a locator that matches nothing, an ambiguous locator, a
`setText` target that is gone, an `expect` feature set that never becomes true — SHALL NOT be
thrown as an untyped error out of the runner. They SHALL go through the existing state
classification path against the supplied state graph, recording an observation for every
recognized state, and SHALL return a readable failure scene: the foreground package / activity /
window title and the elements visible at the moment of failure, next to the classification
(`unknown`, `ambiguous`, `deadEnd`, `escapable`, `identified`).

A successful run SHALL return `outcome: "ok"`; a failure SHALL return `outcome: "drift"` with the
failing step's index and label, and SHALL NOT retry an action step inside the same run.

#### Scenario: three or four steps run on a fake device

- **WHEN** a recipe opens the app, taps a named button, types a query and taps search
- **THEN** the fake ops function receives `openApp`, `find`, `click`, `find`, `type`, `find`,
  `click` in order and the run returns `ok`

#### Scenario: a renamed control is an unknown screen

- **WHEN** the same recipe runs after the app renames the control the third step targets, so the
  locator matches nothing
- **THEN** the run returns `drift`, the classification is `unknown` (no state in the supplied graph
  matches), and the failure scene lists the foreground app and the visible element names, so a
  reader can see what the screen became without the original run's context

#### Scenario: an ambiguous locator refuses to guess

- **WHEN** a locator matches two elements and the recipe offers no `where` narrowing
- **THEN** the step fails as ambiguous, and the run reports it as drift rather than tapping either
  one

### Requirement: Android state features feed the existing identify path

The Android perception SHALL evaluate these features:

| Feature | Meaning |
|---|---|
| `a11y` | an accessibility query hits (or, with `absent`, does not hit); `query.viewId` matches a resource id |
| `text` | a line read by the on-device OCR tier appears (or, with `absent`, does not); `where` narrows it to one side of an anchor on the same row/column |
| `android-window` | the foreground package (one name or a list), activity and/or window title match; `absent` inverts |

The perception SHALL read the screen ONCE per `identify`: one `find` call (with `ocr: "on"` when the
candidate states contain a `text` feature, otherwise `"off"`), one `windows` call and one `url`
call. Multiple text features SHALL be judged against the same frame; different frames inside one
AND check would make the result randomly false during animation.

The Android identify policy SHALL default to `on-failure`, like desktop: the normal path performs
no recognition; a failed `expect` triggers it. Every successful recognition SHALL be recordable
through `onObserved` into the existing observation ledger, and `checkDiscriminative` SHALL accept
the new feature kind without a separate code path.

#### Scenario: one read serves several features

- **WHEN** a state's features are `text: "购物车"` and `a11y {role:"Button", name:"结算"}`
- **THEN** one `identify` issues one `find` with `ocr:"on"` plus one `windows` and one `url`, no
  matter how many features are evaluated

#### Scenario: an OCR text feature on Android

- **WHEN** the pipeline recognizes the line 「确认订单」 on the device screen
- **THEN** the `text` feature matches and its feature key is recorded in the observation ledger

#### Scenario: foreground activity

- **WHEN** `url` returns `com.example.shop/.CheckoutActivity` and a state declares
  `android-window {package:"com.example.shop", activity:"CheckoutActivity"}`
- **THEN** the feature matches
