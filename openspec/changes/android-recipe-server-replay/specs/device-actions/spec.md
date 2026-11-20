## ADDED Requirements

### Requirement: One action vocabulary across execution surfaces

Every device agent SHALL implement actions under the following normalized names and shapes.
A caller SHALL be able to target the same action on any surface without mapping op names itself.

| Action | Arguments | Receipt |
|---|---|---|
| `tap` | `{ rect: {x,y,w,h} }` | `{ via?, settled?, changedDuringRead?, effect?, ocr?, timing? }` |
| `longPress` | `{ rect: {x,y,w,h}, durationMs? }` | as `tap` |
| `swipe` | `{ from: {x,y}, to: {x,y}, durationMs? }` | as `tap` |
| `scroll` | `{ dir: 'up'\|'down', amount?: 1..10, until?: string, maxSteps?, timeoutMs? }` | `{ method, steps, via?, found?, scrolls?, stopped?, match?, visible?, timing? }` |
| `type` | `{ text: string }` | `{ via?, settled?, changedDuringRead?, effect? }` |
| `setText` | `{ ref: string, text: string }` | `{ via?, confirmed?, settled?, changedDuringRead?, effect?, relocated? }` |
| `press` | `{ key: 'Back'\|'Home'\|'Enter' }` | as `tap` |
| `screenshot` | `{}` | `{ base64, window?, scale? }` |
| `find` | `{ query: Query, ocr?: 'auto'\|'on'\|'off' }` | `{ elements, viewport?, unbuilt?, ocr?, timing? }` |
| `windows` | `{}` | `WindowInfo[]` |
| `openApp` | `{ package: string, fresh?: boolean }` | `{ ok: boolean, fresh?: true }` |
| `sleep` | `{ ms: number }` | `{}` |
| `url` | `{}` | foreground address: `package/activity` on Android, a URL on a browser |

`Query` SHALL include at least `role`, `name`, `nameContains`, `className` and `path`; a surface that
can name a control by its own stable id SHALL also accept `viewId` (Android resource id). `name` and
`nameContains` SHALL be mutually exclusive.

The caller-facing contract is the normalized action name. A driver SHALL map it to the wire op its
surface already uses (Android's `click` / `focusApp` / `setValue` remain the wire names), and a
surface MAY additionally accept the normalized name directly as an alias. A caller never has to
know which spelling a surface chose.

#### Scenario: the same recipe action on two surfaces

- **WHEN** a caller runs `tap {rect}` against a desktop agent and against an Android agent
- **THEN** each surface performs one tap at the rectangle's centre and answers a receipt with the
  same optional keys

#### Scenario: long press and swipe are first-class

- **WHEN** a caller sends `longPress {rect, durationMs: 900}` or
  `swipe {from, to, durationMs: 300}`
- **THEN** the surface performs that gesture for approximately that duration and answers the
  action receipt — a caller never has to encode a long press as a right-click or a swipe as a
  scroll

### Requirement: Capability negotiation covers the whole action set

A device SHALL declare, in its `hello`, every capability it backs with an integer version under
the existing `capsVersion` / `caps` manifest. Version numbers SHALL be bumped when a capability's
behavior or accepted arguments change in a way an older caller cannot assume; new optional fields
SHALL NOT require a bump.

The initial version map SHALL be:

| Capability | Version | Backs |
|---|---|---|
| `ui.tree` | 7 | `windows`, `find`, `readSubtree`; v7 adds `viewId` as a query key |
| `ui.act` | 2 | `tap`, `longPress`, `swipe`, `scroll`, `press`, `invoke`, `setValue`; v2 adds `longPress` / `swipe` |
| `screen.shot` | 1 | `screenshot` |
| `app.launch` | 2 | `openApp` / `focusApp` |
| `app.in_use` | 1 | the `app-in-use` refusal |
| `input.text` | 1 | `type`, `setText`, `clearInput` |
| `ui.ocr` | 1 | the on-device OCR tier |

A caller SHALL refuse before sending when the device did not declare an op it needs, or declared
a capability below the version the action requires. The refusal SHALL name the missing op or the
capability and the required version; it SHALL NOT be discovered by sending the op and matching an
error. A device that sends no manifest SHALL keep its declared `ops` as the only promise, exactly
as before.

#### Scenario: an old agent asked for a new gesture

- **WHEN** a device declares `ui.act` at v1 and `ops` without `longPress`
- **THEN** the caller fails locally with a message naming `longPress` / `ui.act v2`, and nothing is
  sent to the device

#### Scenario: an unknown capability is still connected

- **WHEN** a device declares a capability id the backend does not know
- **THEN** the backend keeps the entry and the device connects as before

### Requirement: The device-side safety gate is part of the contract

Every action that can change the device state SHALL pass the device's own safety gate before it
performs any gesture or accessibility action. The gate SHALL run on the device, AFTER the request
arrives and BEFORE the action; a caller SHALL NOT be able to disable it, skip it by renaming an
action, or supply a flag that turns it off. `tap`, `longPress`, `setText`, `type`, `press`,
`scroll` and `swipe` are gated; read-only actions (`find`, `windows`, `screenshot`, `url`, `sleep`,
`status`) are not.

A gated action that the gate classifies as sensitive SHALL fail with `approval-required` and a
structured receipt (`op`, `app`, `reasons`, optional `control`, `bindingDigest`, `screenDigest`,
`snapshotRef`). Nothing SHALL be performed in that case. An approval credential SHALL bind the
device, the session, the op, its arguments and the screen it was approved on; replaying it after
the screen changed SHALL fail as `approval-stale`.

`longPress` SHALL be judged at its landing point exactly as `tap` is: the node under the point,
else the OCR text under the point, else the blind rule. `swipe` SHALL be judged by the existing
slider rules: a slider on the screen whose label is a commit / payment is a `commit-label` /
`payment-label`, and a settings-category slider (including a scrollable one) is a `setting`.

#### Scenario: a blind long press in a payment app

- **WHEN** `longPress` lands on a point that neither the accessibility tree nor OCR names, in an app
  whose category requires approval for commits
- **THEN** the device answers `approval-required` with `commit-unrecognized`, and no gesture is sent

#### Scenario: swiping a slide-to-pay control

- **WHEN** the screen contains a scrollable slider labelled 「滑动支付」 and a caller sends `swipe`
- **THEN** the device answers `approval-required` with `commit-label` and `payment-label`, and no
  gesture is sent

#### Scenario: an ordinary swipe runs

- **WHEN** the same `swipe` runs on a screen with no slider and no commit-shaped label
- **THEN** it performs the gesture and answers the action receipt
