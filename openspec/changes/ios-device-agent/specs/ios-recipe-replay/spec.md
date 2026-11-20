## ADDED Requirements

### Requirement: The iOS device is a host agent that declares its automation path

The Stream iOS app SHALL connect as a host device with `platform:"ios"` and
`deviceId:"ios:<udid>"`, and SHALL send the existing `hello` with `deviceId`, `platform`, `name`,
`agentVersion`, `ops`, `capsVersion` and `caps`, plus the additive fields `iosVersion` and
`path`.

The path SHALL be selected from the OS version: `native-accessibility` for iOS 27 and later,
`xctest-session` for iOS 18 through 26, and no path below 18. A connection below iOS 18 SHALL
declare no ops and SHALL fail every op with `service-unavailable`; it SHALL NOT pretend to have
a surface. The iOS version SHALL NOT change the op vocabulary: a caller sends the same action
names on either path.

#### Scenario: an iOS 27 hello

- **WHEN** an iPhone on iOS 27 connects
- **THEN** its hello has `platform:"ios"`, `path:"native-accessibility"`, `iosVersion:"27.x"`
  and declares `tap`, `longPress`, `swipe`, `scroll`, `invoke`, `type`, `setText`, `press`,
  `screenshot`, `find`, `windows`, `openApp`, `sleep` and `status`

#### Scenario: an iOS 20 hello takes the XCTest path

- **WHEN** an iPhone on iOS 20 connects with its Swift bridge linked
- **THEN** `path` is `xctest-session`, `caps` includes `ios.xctest-session`, and the op set is
  the same as the native path

#### Scenario: an unsupported OS

- **WHEN** the app runs on iOS 17
- **THEN** the hello declares no ops and every dispatched op fails `service-unavailable`

### Requirement: Capability negotiation covers the whole action set

The iOS agent SHALL declare, in `caps`, every capability it backs: `ui.tree` at 7, `ui.act` at
2, `screen.shot` at 1, `app.launch` at 2, `app.in_use` at 1, `input.text` at 1, and the path
capability `ios.ax-native` or `ios.xctest-session` at 1. It SHALL NOT declare `ui.ocr`: iOS has
no on-device OCR. A caller SHALL refuse an op the device did not declare, or a capability below
the required version, before sending it.

On a path whose snapshot is available, `find` with `ocr:"on"` or `ocr:"auto"` SHALL still return
tree elements; the receipt SHALL say
`ocr.used:false` and, for `on`, `ocr.degraded:"ocr-unsupported"`. `ocr:"off"` SHALL be honoured
without an OCR field beyond `requested`.

#### Scenario: an undeclared op is refused locally

- **WHEN** a caller sends `url` or `readText` to an iOS device
- **THEN** the reply is `unsupported-op` and nothing is sent to the phone

#### Scenario: OCR degrades

- **WHEN** a caller sends `find {query:{role:"Button"}, ocr:"on"}`
- **THEN** the receipt carries the matching elements and `ocr:{requested:"on", used:false,
  degraded:"ocr-unsupported"}`

### Requirement: The shared action contract maps to iOS mechanisms

Every declared action SHALL use the shared name and argument shape and SHALL answer the shared
receipt. The mapping SHALL be:

| Action | iOS mechanism |
|---|---|
| `tap` | UniversalHID touch at the rect centre |
| `longPress` | touch held for `durationMs` (default 900) |
| `swipe` | HID drag between the points over `durationMs` (default 300) |
| `scroll` | HID drag in the scrollable area, `amount` 1..10 |
| `type` | pasteboard write + Cmd-V, pasteboard restored |
| `setText` | focus the ref's node, then the pasteboard path |
| `clearInput` | `setText` with an empty string |
| `press` | Indigo button for `Home`/`Lock`/`VolumeUp`/`VolumeDown`; HID Return for `Enter` |
| `screenshot` | CoreDevice screen-capture service (PNG) |
| `find` / `windows` | accessibility snapshot and query (native path: clean-room placeholder, below) |
| `openApp` | CoreDevice app service launch; `fresh` terminates an existing instance |
| `invoke` | tap the centre of a node returned by `find` |
| `sleep` | local timer |

An action the phone cannot perform SHALL fail `unsupported-op` before any device call and SHALL
NOT be declared in `ops`. `press` with `Back` is such an action.

#### Scenario: the same tap on two surfaces

- **WHEN** a recipe step `tap {rect}` runs against an iOS device
- **THEN** one HID touch lands at the rect centre and the reply has the same optional keys as
  the Android and desktop receipts

#### Scenario: a swipe is a drag, not a scroll event

- **WHEN** a caller sends `swipe {from, to, durationMs: 300}`
- **THEN** the HID drag samples the path for approximately 300 ms and lifts at the end point

#### Scenario: Back is not an iOS key

- **WHEN** a caller sends `press {key:"Back"}`
- **THEN** the reply is `unsupported-op` and nothing is sent

### Requirement: The native accessibility snapshot is pending clean-room discovery

The focus-event payload keys and the focus iteration strategy SHALL NOT be taken from a copyleft
source. Until a permissively licensed source or on-device evidence establishes the shape, a
native snapshot SHALL fail `service-unavailable` with the reason
`focus payload keys pending clean-room discovery`; `find`, `windows` and every gated op that
rebuilds a snapshot on the native path SHALL propagate that failure. The agent SHALL NOT guess a
payload key and SHALL NOT return an empty snapshot as if it were the screen.

#### Scenario: a native find names the gap

- **WHEN** a caller sends `find` on the native path
- **THEN** the reply is `service-unavailable` naming `focus payload keys pending clean-room
  discovery`, and no focus payload key is parsed

### Requirement: The device-side gate runs before any action and cannot be disabled

Every gated op (`tap`, `longPress`, `invoke`, `swipe`, `scroll`, `type`, `setText`, `press`) SHALL
pass the gate on the device, after the request arrives and before any HID report or accessibility
action. No argument, alias or configuration SHALL turn the gate off. Read-only ops (`find`,
`windows`, `screenshot`, `status`, `sleep`) are not gated.

The gate SHALL produce reasons from the open set `commit-label`, `commit-unrecognized`,
`dialog-confirm`, `payment-label`, `message-send`, `install`, `setting`, `call`,
`link-leave-app` and `app-category-ask`, with Android's structure-first semantics: a clickable
control the word tables cannot place in a form or confirmation context, and a blind tap in a
shopping / payments / finance app, SHALL gate as `commit-unrecognized`. A tap whose point has no
geometry in the snapshot SHALL be treated as blind.

A gated action with any reason SHALL fail `approval-required` with `semantics` (op, app,
optional control, reasons, `bindingDigest`, `screenDigest`, optional `snapshotRef`) and SHALL
perform nothing. The semantics SHALL NOT contain screen text or a credential value.

#### Scenario: a payment button is held

- **WHEN** a `tap` lands on 「立即支付」 on a screen showing an amount, in a shopping app
- **THEN** the reply is `approval-required` with `commit-label` and `payment-label`, and no HID
  report is sent

#### Scenario: a blind tap in a payment app is held

- **WHEN** a `tap` point resolves to no labelled node in a payments app
- **THEN** the reply is `approval-required` with `commit-unrecognized` and nothing is performed

#### Scenario: a free claim is not a commit

- **WHEN** a `tap` lands on a claim-only label such as 「领取红包」 that names no payment
- **THEN** the tap runs without an approval request

#### Scenario: a setting is held

- **WHEN** a `tap` lands on a switch or setting-shaped control in the Settings app
- **THEN** the reply is `approval-required` with `setting`

#### Scenario: newline typing sends

- **WHEN** a `type` into a non-search field contains a newline, or `press Enter` lands on it, in
  a messaging or social app
- **THEN** the reply is `approval-required` with `message-send` and no text is entered

#### Scenario: a slider that pays is held

- **WHEN** a `swipe` or `scroll` is sent while the screen contains a slider labelled 「滑动支付」
- **THEN** the reply is `approval-required` with `commit-label` and `payment-label`

### Requirement: Deny categories hide the app

An app in a deny category (`finance`, `passwords`, `blocked`) SHALL fail every op with
`app-denied`, including reads (`find`, `windows`, `screenshot`), and SHALL perform nothing. A
deny SHALL take precedence over an approval request.

#### Scenario: a wallet app is invisible

- **WHEN** a `find` arrives while a wallet app is in the foreground
- **THEN** the reply is `app-denied` and no snapshot is returned

#### Scenario: opening a denied app is refused

- **WHEN** `openApp` names a bundle in a deny category
- **THEN** the reply is `app-denied` and the app is not launched

### Requirement: Refs bind to a snapshot

A ref returned by `find` SHALL name one node in that snapshot. `setText` and `invoke` SHALL take
a fresh snapshot and SHALL resolve the ref by identity (role, label, identifier, rect): the same
path with the same identity succeeds; exactly one node elsewhere with the same identity succeeds
and the receipt names the new path as `relocated`; anything else SHALL fail `stale-ref` without
acting. A ref the session has not seen SHALL fail `stale-ref`.

#### Scenario: the tree moved

- **WHEN** a container appears above the control between `find` and `setText`
- **THEN** `setText` writes into the same control and the receipt carries `relocated`

#### Scenario: the control changed

- **WHEN** the node at the ref's path now has a different label or role
- **THEN** the reply is `stale-ref` and no text is written

### Requirement: Approval credentials bind and are consumed once

When a gated op carries `args.approval = {id, bindingDigest, screenDigest, expiresAt}`, the agent
SHALL check, before any device action: `expiresAt` (epoch ms) against its clock → `approval-expired`;
`digest(device, session, op, canonical args without the credential)` against `bindingDigest` →
`approval-mismatch`; the used set → `approval-used`; a fresh snapshot's digest against
`screenDigest` → `approval-stale`. A failed check SHALL NOT perform anything and SHALL NOT consume
the credential. A successful execution SHALL consume it.

#### Scenario: one approval, one action

- **WHEN** the same credential is replayed after a successful execution
- **THEN** the reply is `approval-used` and no second HID report is sent

#### Scenario: the screen changed

- **WHEN** the screen digest differs from the credential's `screenDigest`
- **THEN** the reply is `approval-stale` and the credential remains unconsumed

### Requirement: Failure codes are structured and ordered

An iOS failure SHALL carry a machine-readable `code` and a human message in the existing
`{error, code, semantics?}` shape. The iOS surface SHALL use `locked`, `needs-human`,
`device-busy`, `service-unavailable`, `pairing-missing`, `ddi-missing` and `developer-mode-off`,
plus the shared `approval-*`, `app-denied`, `unsupported-op`, `unknown-op`, `stale-ref` and
`action-failed`.

Checks SHALL run in this order: path, pairing, Developer Mode, DDI, keyguard (all but `status`,
`sleep`, `windows` and `url`), busy (all but `status` and `sleep`), deny category, ref, gate.
`status` and `sleep` SHALL always be allowed. A structured code SHALL NOT be invented from a
failed action when the platform state is known.

#### Scenario: locked beats busy

- **WHEN** the screen is locked and the device is also busy
- **THEN** a `tap` fails `locked`

#### Scenario: a missing pairing is named

- **WHEN** no pairing record exists
- **THEN** an op fails `pairing-missing` and no developer service is contacted

### Requirement: Credential values do not leave the device

A password or one-time-code field's value SHALL be replaced with a fixed mask in every snapshot
element and in `approval-required` control labels. A screenshot SHALL NOT be returned when the
surface cannot guarantee the credential regions are covered; the default is to return the
screenshot of the current screen only, with credential fields masked in the tree.

#### Scenario: a password input is masked

- **WHEN** `find` returns a password field
- **THEN** its `value` is the fixed mask and the raw value is not in the frame

### Requirement: The iOS 18–26 path refuses without its bridge

When the automation path is `xctest-session` and the app has not linked its in-process XCTest
bridge, every op SHALL fail `service-unavailable`; the gate SHALL remain in this crate and SHALL
NOT be delegated to the bridge.

#### Scenario: bridge absent

- **WHEN** an iOS 20 device has `path:"xctest-session"` and no bridge
- **THEN** `tap` fails `service-unavailable` and nothing is sent
