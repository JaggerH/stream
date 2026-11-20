## Context

The iOS executor is one app on the phone. At run time the app reaches the phone's own developer
services through a loopback route it installs (a packet tunnel, or the user's existing loopback
VPN). The backend holds recipes; the app holds this core, which turns normalized actions into
accessibility, display and HID operations.

Two OS generations expose different automation mechanisms:

- **iOS 27+**: the paired native services. Accessibility is read through the AX inspector
  service; screenshots through the CoreDevice screen-capture service; input through
  UniversalHID/Indigo; app launch through the CoreDevice app service; text through the
  pasteboard. No XCTest session runs.
- **iOS 18–26**: an in-process XCTest session. The testmanagerd connection lives in the app
  process (there is no second runner bundle), owned by the app's Swift bridge. The Rust core
  speaks to that bridge through a narrow trait.

Everything below the transport — action vocabulary, receipts, refs, the gate, approvals,
capability negotiation, failure codes — is identical on both paths and is what this change
implements with host-runnable tests.

## Goals / Non-Goals

**Goals**

- One device type (`ios`) that declares its op set and capability manifest in `hello`.
- The shared action contract on iOS, with explicit `unsupported` and a degraded OCR receipt
  where the phone cannot do something.
- The same gate semantics as the Android executor: commit / payment / claim / setting / blind /
  send / install / call / link / category ask, enforced on the device, not by the caller.
- Ref and approval rules that make a stale target and a changed screen fail loudly.
- Protocol, gate, refs and approvals covered by `cargo test` on Linux, including constructed
  accessibility fixtures.
- A transport that compiles for `aarch64-apple-ios` and uses only the MIT `idevice` crate.

**Non-Goals**

- The app shell UI, the pairing/setup helper, DDI mounting and signing renewal. Setup is the
  only part that needs a computer; it is a later change.
- Implementing the Swift XCTest bridge for iOS 18–26. The core defines the path, the trait and
  the refusal; the bridge is app-side work.
- Backend/panel changes: accepting `ios` as a paired platform, issuing device tokens and
  targeting `ios` recipes. The `hello` shape is fixed here so those changes stay small.
- App Store distribution. The native developer services require sideloading and Developer Mode.
- Any entry point that bypasses the gate.

## Decisions

### D1. One device type, the OS version selects the path

The `hello` carries `platform:"ios"`, `deviceId:"ios:<udid>"`, `ops`, `capsVersion`/`caps` and
two additive fields: `iosVersion` and `path`. The path is `native-accessibility` for iOS 27+,
`xctest-session` for 18–26, and absent for <18 (the hello declares no ops and every op fails
`service-unavailable`). The backend does not branch on the path for dispatch: ops are routed by
the declared op set, as with every device.

*Alternative rejected:* two device types (`ios-native`, `ios-xctest`). The automation mechanism
is an implementation detail; a recipe should not care which one a phone supports.

### D2. Capability manifest

The manifest uses the shared shape. On a supported path iOS declares:

| Capability | Version | Backs |
|---|---|---|
| `ui.tree` | 7 | `find`, `windows` (and `readSubtree` when the bridge exposes it) |
| `ui.act` | 2 | `tap`, `longPress`, `swipe`, `scroll`, `press`, `invoke`, `setValue` (accepted as `setText`) |
| `screen.shot` | 1 | `screenshot` |
| `app.launch` | 2 | `openApp` |
| `app.in_use` | 1 | the app-in-use refusal |
| `input.text` | 1 | `type`, `setText`, `clearInput` |
| `ios.ax-native` | 1 | native path (27+) |
| `ios.xctest-session` | 1 | in-process XCTest path (18–26) |

`ui.ocr` is deliberately absent: iOS has no on-device OCR. A caller that requests `ocr:"on"` gets
a receipt with `ocr.used:false` and `ocr.degraded:"ocr-unsupported"`; `find` itself still works.
A caller refuses an op the device did not declare, or a capability below the version it needs,
before sending anything.

### D3. Op mapping

| Action | iOS implementation | Path | Receipt / degradation |
|---|---|---|---|
| `tap` | UniversalHID `mainTouchscreen`: contact + release at the rect centre, normalized 0..65535 | both | `{via:"hid", settled, changedDuringRead}` |
| `longPress` | contact, hold `durationMs` (default 900), release at the same point | both | as `tap` |
| `swipe` | HID drag, samples over `durationMs` (default 300) | both | as `tap` |
| `scroll` | HID drag inside the scrollable area; `amount` 1..10 selects the distance | both | as `tap` |
| `type` | focus the field, write the text to the pasteboard, send Cmd-V, restore the pasteboard | both | `{via:"pasteboard", …}` |
| `setText` | tap the node, then the same pasteboard path; `ref` must resolve | both | `{via:"ax", confirmed:false, relocated?}` |
| `clearInput` | `setText` with an empty string | both | as `setText` |
| `press` `Home`/`Lock`/`VolumeUp`/`VolumeDown` | Indigo button (usage page/code), 250 ms hold | both | `{via:"hid", …}` |
| `press` `Enter` | HID keyboard Return (usage `0x28`) | both | as `tap` |
| `press` `Back` | — | — | `unsupported-op` before anything is sent (iOS has no Back key) |
| `screenshot` | CoreDevice screen-capture service, PNG | both | `{base64, window, scale}` |
| `find` | AX snapshot + query (`role`, `name`, `nameContains`, `className`, `path`, `viewId`) | both | `{elements, viewport, ocr}`; the native snapshot is a clean-room placeholder today (see below) |
| `windows` | the single foreground window | both | one `WindowInfo` |
| `openApp` | CoreDevice app service `launchApplication`, `fresh` → `terminateExisting` | both | `{ok, fresh}` |
| `invoke` | tap the centre of a node returned by `find` | both | `{via:"hid", …}` |
| `sleep` | local timer | both | `{}` |
| `url` | — | — | not declared; `unsupported-op` |
| `readText`, `findImage`, `moveMouse`, `nudge`, `readElements` | — | — | `unsupported-op` before sending |

The native AX client currently initializes the service only. The focus-event payload keys and
iteration strategy are **pending clean-room discovery**: an earlier draft took them from a
GPL-3.0 project, removed in R1. The element/attribute argument wrappers were removed with them
because they shared the `PlatformElementValue_v1` name with the GPL-derived payload. Until a
permissively licensed source or on-device evidence establishes the shapes, the native snapshot
answers `service-unavailable` with the reason `focus payload keys pending clean-room discovery`;
`find`, `windows` and gated ops that rebuild a snapshot on the native path propagate it. Nothing
is guessed. When the shapes are known, geometry (where the OS reports it) feeds the same
blind-tap rule as D4.

### D4. The gate

The gate is inside the dispatcher: every gated op takes a fresh snapshot after the request
arrives, resolves the target, and asks `Gate::reasons` before any surface call. There is no
configuration flag, op alias or argument that turns it off. A refusal performs nothing and
returns `approval-required` with semantics:

```json
{"op":"tap","app":{"package":"…","name":"…","category":"shopping"},
 "control":{"role":"Button","label":"立即支付"},
 "reasons":["commit-label","payment-label"],
 "bindingDigest":"…","screenDigest":"…","snapshotRef":"snap:…"}
```

Reasons are the Android gate's open set:

| Reason | Kind | When |
|---|---|---|
| `commit-label` | commit | a commit-shaped label (word tables, any supported language) |
| `commit-unrecognized` | commit | a clickable control the tables cannot place, in a form or confirmation context; or a blind tap in a shopping / payments / finance app |
| `dialog-confirm` | commit | an affirmative button while the screen asks a commit question |
| `payment-label` | commit | a commit/install on a screen showing money, or a label that moves money |
| `message-send` | send | newline typing or Enter in messaging / social |
| `install` | install | an install-shaped button in an app store |
| `setting` | setting | a switch / setting / stepper / slider in the Settings app |
| `call` | call | a call-shaped label or dialer id |
| `link-leave-app` | link | a URL label outside a browser |
| `app-category-ask` | — | the category table asks for this kind in this app |

Deny categories (`finance`, `passwords`, `blocked`) hide the app entirely: reads and actions
both fail `app-denied`, with nothing performed. Structure outweighs the tables; a false
positive costs one approval, a false negative lets a commit through.

Approval credentials are validated in this order, before the action: expired →
`approval-expired`; binding mismatch → `approval-mismatch`; already used → `approval-used`;
screen digest changed → `approval-stale`. A credential binds device, session, op and canonical
arguments; an execution consumes it exactly once.

### D5. Refs

A ref (`n0.n2`) is a path inside one snapshot. `find` remembers the snapshot the caller saw.
`setText`/`invoke` take a fresh snapshot and resolve the ref by identity: the same path must
carry the same role, label, identifier and rect; otherwise exactly one node elsewhere may match
(that is a relocation, reported as `relocated`), and anything else is `stale-ref` with no
action. A ref from a different session is `stale-ref`.

### D6. Transport over the loopback

The app's loopback route exposes the phone's RSD port (default `49152`; the app may supply the
advertised port). The core opens a TCP stream to it, performs the RSD handshake and connects the
advertised services by port. On a host (setup helper / CI compile) the same code connects to a
forwarded port; the only platform-specific constant is the loopback host (`10.7.0.1` on iOS).

HID reports are dropped by the device unless a display media stream is active. The transport
starts the CoreDevice display stream and drains its RTP payload (the payload is discarded) to
authenticate the HID surfaces. If the stream cannot start, touch/typing/press fail
`service-unavailable` rather than silently no-op.

### D7. Failure codes and precedence

| Code | Meaning |
|---|---|
| `locked` | secure keyguard is up |
| `needs-human` | a passcode / system dialog / unsupported control needs a person |
| `device-busy` | another task holds the session lease |
| `service-unavailable` | a developer service is not answering |
| `pairing-missing` | no pairing record (setup not done) |
| `ddi-missing` | developer disk image not mounted |
| `developer-mode-off` | Developer Mode is off |
| shared codes | `approval-required`, `approval-stale`, `approval-expired`, `approval-mismatch`, `approval-used`, `app-denied`, `unsupported-op`, `unknown-op`, `stale-ref`, `action-failed` |

Order: path → pairing → Developer Mode → DDI → keyguard (all but `status`, `sleep`, `windows`,
`url`) → busy (all but `status`, `sleep`) → deny category → ref → gate. `status` and `sleep` are
always allowed; `windows` is exempt from the keyguard check like Android's.

### D8. The iOS 18–26 boundary

The Rust core exposes the same surface for the XCTest path, but the session itself is Swift and
in-process. Until the app links a bridge, `state.bridge_available` is false and every op fails
`service-unavailable`; the hello still declares `ios.xctest-session` so the backend can see the
path. The bridge must provide snapshots and actions; it cannot disable the gate (the gate is in
this crate).

### D9. Not implemented here

Setup, pairing, DDI mounting, signing renewal, app UI, backend pairing and recipe targeting.
The native accessibility snapshot is also pending clean-room discovery (see Provenance); the
service client and capability init exist, but no attribute/action argument or focus payload is
parsed yet.
If a future snapshot reports no geometry, tap hit-testing is blind by design.

## Provenance

**R1 correction.** An earlier draft of this change read `services/accessibilityaudit.py` from
doronz88/pymobiledevice3 (**GPL-3.0**) and derived the focus-event payload keys and the focus
iteration strategy from it. That content has been removed: the keys, the iteration code, its
test and the extracted fixture are gone, and the native snapshot now answers
`service-unavailable` with the reason `focus payload keys pending clean-room discovery`.
go-ios is **MIT**, not Apache-2.0; the earlier table said otherwise and is corrected here. No
source from a GPL, AGPL or PolyForm project is used by this change now, and none is a
dependency.

| Mechanism | Source | License | Taken |
|---|---|---|---|
| RSD / RemoteXPC, CoreDevice HID, display stream, pasteboard, screenshot, app launch | `idevice` 0.1.68, crate docs and source | MIT | dependency and its public API |
| AX inspector service name and capability notification | go-ios `ios/accessibility` | MIT | service name and DTX init, reimplemented. The attribute/action argument shapes were removed in R1 too (they shared `PlatformElementValue_v1` with the GPL-derived payload); the clean-room follow-up re-adds them from go-ios. |
| Home / Lock / volume usage page and codes | go-ios `ios/hid/button.go` | MIT | constants |
| One-app loopback form (`10.7.0.1`, packet tunnel / existing VPN), in-process XCTest session | public project READMEs and documentation | — | mechanism only; no source read |
| AX focus event payload keys and focus iteration strategy | doronz88/pymobiledevice3 `services/accessibilityaudit.py` | **GPL-3.0** | **removed in R1**; nothing is used. The native snapshot is a placeholder (`service-unavailable`, reason `focus payload keys pending clean-room discovery`). |

`idevice` is pinned with `=` because the crate's README says point releases break the API. The
pure-Rust `rustcrypto` TLS backend is selected so the same code builds for iOS without a C
toolchain.

## Testing

- `cargo test` (no transport): snapshot/refs/digests, the policy detection, the gate across
  commit / payment / claim / setting / blind / send / slider cases, op parsing and refusals,
  capability manifest, version → path, dispatcher state codes, the gate, approval credentials,
  ref relocation and staleness, receipts, and a constructed accessibility fixture.
- `cargo test --features device`: the same tests plus the transport's attribute-argument
  unwrapping and the placeholder's reason.
- `cargo check --target aarch64-apple-ios --features device`: the library compiles for the
  phone target.
- Real device: the checklist in the change's tasks (two paths separately). CI cannot cover it.

## Risks

- The native snapshot is pending clean-room discovery; until it is implemented, `find`,
  `windows` and every gated op on the native path fail `service-unavailable`. This is a
  deliberate, visible gap, not a silent degradation.
- HID authentication via a display stream needs a UDP receiver inside the app; its behaviour on
  device (and whether audio-first is required) is a real-device item.
- iOS point releases change private services. `idevice` is pinned; upgrades are deliberate.
