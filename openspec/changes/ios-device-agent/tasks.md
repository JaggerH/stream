## 1. OpenSpec

- [x] 1.1 Proposal: device type, path selection, scope boundaries
- [x] 1.2 Design: capability manifest, op mapping, gate, refs, approvals, failure codes,
  provenance
- [x] 1.3 Spec delta `ios-recipe-replay`

## 2. Core crate (`app/ios-agent/core`)

- [x] 2.1 Snapshot model, refs, hit-testing, digests, credential masking (`src/ax.rs`)
- [x] 2.2 Policy tables (copied from the Android executor), detection, gate (`src/policy/`)
- [x] 2.3 Normalized vocabulary, aliases, receipts (`src/ops.rs`)
- [x] 2.4 Capability manifest and version → path (`src/caps.rs`, `src/version.rs`)
- [x] 2.5 Dispatcher: state checks, gate, approval four-checks, ref resolution (`src/dispatch.rs`)
- [x] 2.6 Surface trait and recording fake for tests (`src/surface.rs`, `tests/agent.rs`)
- [x] 2.7 Constructed accessibility fixture (`tests/fixtures/payment-screen.json`)

## 3. Transport (`feature = "device"`)

- [x] 3.1 RSD handshake over a TCP endpoint (loopback on iOS, forwarded port on a host)
- [ ] 3.2 AX client: service init and capability notification are implemented; the focus
  payload, attribute/action argument shapes and iteration were removed in R1 and are a
  clean-room placeholder (9.5)
- [x] 3.3 HID touch / long press / drag; Indigo buttons and keyboard
- [x] 3.4 Display stream keepalive that authenticates the HID surfaces
- [x] 3.5 Pasteboard typing with restore; screenshot; app launch
- [x] 3.6 `idevice` pinned to `=0.1.68` (MIT) with the pure-Rust `rustcrypto` TLS backend

## 4. CI and repository wiring

- [x] 4.1 `test.yml` job: Linux `cargo test` (default and `--features device`)
- [x] 4.2 `test.yml` job: macOS runner `cargo build --target aarch64-apple-ios --features device`
- [x] 4.3 `THIRD-PARTY-NOTICE` entry for `idevice`
- [x] 4.4 `app/ios-agent/README.md`

## 5. Off-device verification

- [x] 5.1 `cargo test` (protocol, gate, refs, approvals, fixtures)
- [x] 5.2 `cargo test --features device` (transport compiles and its parsers pass)
- [x] 5.3 `cargo check --target aarch64-apple-ios --features device`

## 6. Real device: iOS 27+ (native path)

- [ ] 6.1 Loopback route exposes the RSD port; `RsdHandshake` succeeds through it
- [ ] 6.2 `com.apple.accessibility.axAuditDaemon.remoteserver` is advertised and focus events
  arrive; a snapshot returns the foreground app's elements with labels and identifiers
  (blocked on the clean-room work in 9.5)
- [ ] 6.3 Whether the OS reports element geometry; confirm the blind-tap fallback on a payment
  screen
- [ ] 6.4 Display stream starts from inside the app and authenticates HID; a tap on a normal
  button changes the screen
- [ ] 6.5 Long press and swipe reach the app (no AX selection mode swallowing touches)
- [ ] 6.6 Pasteboard typing restores the previous clipboard; non-Latin text enters correctly
- [ ] 6.7 Home / Lock / volume button events
- [ ] 6.8 Screenshot is the current screen, PNG, correct scale
- [ ] 6.9 App launch by bundle id, including `fresh`
- [ ] 6.10 Gate: a payment tap and a slide-to-pay swipe are held with the expected reasons
- [ ] 6.11 Locked, busy, DDI-missing and Developer-Mode-off map to their codes
- [ ] 6.12 Session survives a screen change and a reconnect; refs go stale correctly

## 7. Real device: iOS 18–26 (XCTest path)

- [ ] 7.1 The app's Swift bridge opens the in-process XCTest session and reports
  `bridge_available`
- [ ] 7.2 The bridge supplies snapshots and actions through the trait; the Rust gate still runs
  before every action
- [ ] 7.3 The same op checklist as 6.2–6.11 through the bridge
- [ ] 7.4 The session survives backgrounding and a reconnect

## 8. Follow-ups (separate changes)

- [ ] 8.1 Backend accepts `ios` as a paired platform, issues device tokens and targets `ios`
  recipes
- [ ] 8.2 One-time setup helper (pairing record, DDI, signing renewal)
- [ ] 8.3 App shell UI (device status, pairing flow, takeover)
- [ ] 8.4 Swift XCTest bridge for iOS 18–26
- [ ] 8.5 iOS app-side loopback VPN packaging and distribution decision

## 9. R1 clean-room correction (2026-11-20)

- [x] 9.1 Removed the focus-event payload keys, the focus iteration strategy and the
  element/attribute argument wrappers (they shared `PlatformElementValue_v1` with the
  GPL-derived payload) derived from doronz88/pymobiledevice3 (GPL-3.0), together with its test
  and derived fixture
- [x] 9.2 The native snapshot is an explicit placeholder: `service-unavailable` with the reason
  `focus payload keys pending clean-room discovery`; no key is guessed
- [x] 9.3 Corrected the go-ios license to MIT (it is not Apache-2.0) and rewrote the provenance
  table
- [x] 9.4 Re-verified every opened source's license with `gh api repos/<r> --jq .license.spdx_id`
- [ ] 9.5 Clean-room rediscovery of the focus payload keys and iteration strategy (permissive
  source or on-device evidence) before `find`/`windows` work on the native path
