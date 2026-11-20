## Why

A large class of everyday actions lives only in iPhone apps. Stream can drive Chrome, native
desktop windows and an Android phone today; it cannot reach an iPhone at all.

The product form is settled: **one app on the phone drives that phone**, with the brain on the
server and no computer in the loop at run time. The app reaches the phone's own developer
services through a loopback route (a packet tunnel or the user's existing loopback VPN). On
iOS 27 and later those are the paired native services (accessibility inspector, display capture,
UniversalHID); on iOS 18–26 they are an in-process XCTest automation session owned by the app.
The one-time setup (pairing record, developer disk image, signing renewal) is the only part that
needs a computer, and it is out of scope here.

This change adds the device-side core: the protocol layer, the safety gate and the transport
client, with everything that can be verified off-device covered by tests.

## What Changes

- **A new device type `ios`.** Its `hello` declares `platform:"ios"`, `deviceId:"ios:<udid>"`,
  its op set and a capability manifest (`capsVersion`/`caps`). The OS version selects the
  automation path and is reported additively as `iosVersion` / `path`.
- **A new Rust crate `app/ios-agent/core`** (`stream-ios-agent`). It sits on the MIT `idevice`
  crate (pinned) for the RSD/RemoteXPC transport and the CoreDevice services, and implements:
  the normalized action vocabulary, the shared receipts, ref resolution, the device-side
  gate, approval credentials, capability negotiation and the iOS-version → path decision.
- **The shared device-action contract on iOS.** `tap`, `longPress`, `swipe`, `scroll`, `type`,
  `setText`, `press` (Home / Lock / volume / Enter), `screenshot`, `find`, `windows`,
  `openApp`, `sleep` and `invoke` map onto HID reports, the pasteboard, display capture, the
  accessibility snapshot and the app service. `url` and on-device OCR are not available; a
  requested OCR tier degrades to the tree and says so in the receipt.
- **A device-side gate with the Android semantics** (commit / payment / claim / setting / blind
  / send / install / call / link / category ask), running after the request arrives and before
  any HID report or accessibility action. No caller flag can disable it.
- **Structured failure codes** for the iOS surface: `locked`, `needs-human`, `device-busy`,
  `service-unavailable`, `pairing-missing`, `ddi-missing`, `developer-mode-off`, plus the shared
  approval / denial / stale-ref codes.
- **CI**: a Linux `cargo test` job (both feature sets) and an iOS-target build gate on a macOS
  runner.

Not in this change: the app shell UI, the one-time setup helper, signing renewal, the Swift
XCTest bridge implementation for iOS 18–26, the backend accepting `ios` as a paired platform and
a recipe targeting `ios`. Those are separate changes; this one fixes the device-side contract
they will build against.

## Capabilities

### New Capabilities

- `ios-recipe-replay`: replay the shared action vocabulary on an iPhone that runs the Stream iOS
  app, with capability negotiation, the device-side gate and structured failures.

### Modified Capabilities

None. The action vocabulary and receipt shapes are consumed from the existing
`device-actions` contract (the Android server-replay change); this change does not alter it.

## Impact

- New crate `app/ios-agent/core` (Rust, `publish = false`), its tests and fixture.
- `app/ios-agent/README.md`.
- `.github/workflows/test.yml`: two jobs (`ios-agent`, `ios-agent-ios-check`).
- `THIRD-PARTY-NOTICE`: the `idevice` MIT entry.
- No backend, panel, Android, desktop or recipe-runner code changes.
