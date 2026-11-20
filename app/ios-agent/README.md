# stream-ios-agent (iOS device agent core)

The executor core that runs **inside the Stream iOS app**. The phone drives itself: the app's
loopback route reaches the phone's own developer services, and this crate turns the shared
action vocabulary into accessibility, display and HID operations on that phone. There is no
computer in the loop at run time, no network listener, and no dependency on the backend — the app shell owns the WebSocket and the loopback VPN.

The host side of the same protocol is `app/host-agent`; the Android executor is
`app/android`. This crate is the iOS member of that family.

## Layout

- `src/ax.rs` — snapshot model, refs, queries, hit-testing, digests, credential masking.
- `src/policy/` — word and category tables (copied from the Android executor's data files),
  label detection and the device-side safety gate.
- `src/ops.rs` — the normalized action vocabulary, its iOS mapping and the receipts.
- `src/caps.rs` — the `hello` capability manifest and the iOS-version → path decision.
- `src/dispatch.rs` — state checks, gate, approval credentials, ref resolution, surface call.
- `src/surface.rs` — the narrow trait a transport implements (fake in tests).
- `src/transport/` — the `idevice`-backed native surface (feature `device`): RSD handshake,
  AX client over DTX, CoreDevice HID/display/pasteboard/screenshot/app services.
- `tests/fixtures/` — constructed accessibility fixtures.

## Two automation paths

| iOS | Path | Mechanism |
|---|---|---|
| 27+ | `ios.ax-native` | Paired native services — accessibility inspector, display capture, UniversalHID. No XCTest session. |
| 18–26 | `ios.xctest-session` | In-process XCTest session through the app's Swift bridge (the testmanagerd connection lives in the app). Without the bridge linked the agent answers `service-unavailable`. |
| <18 | none | `service-unavailable`; the hello declares no ops. |

## Build and test

```bash
# Protocol, gate, refs, approvals, fixtures — no idevice, any OS
cargo test

# Also compiles and tests the idevice-backed transport (Linux build of the same code)
cargo test --features device

# The library compiles for the phone target (no linking; the app shell owns the binary)
rustup target add aarch64-apple-ios
cargo check --target aarch64-apple-ios --features device
```

`idevice` is pinned to `=0.1.68` (MIT). It is the only transport dependency. The crate uses the
pure-Rust `rustcrypto` backend so the same code builds for aarch64-Apple-iOS without a C
toolchain. See the change `openspec/changes/ios-device-agent` for the capability contract, the op
mapping and the gate, and `THIRD-PARTY-NOTICE` for the license entry.

## What is deliberately not here

- App shell UI, the one-time setup helper, pairing and signing renewal: those are separate
  pieces (the setup helper is the only part that needs a computer).
- The iOS 18–26 XCTest bridge implementation itself (Swift, app side). The Rust core defines the
  path and refuses cleanly until it is linked.
- Native focus payload parsing. The focus-event keys and iteration strategy are pending clean-room
  discovery; `find`, `windows` and gated ops on the native path answer `service-unavailable` with
  that reason instead of guessing. The service client and capability init are in place; the
  element/attribute argument shapes are deferred to the follow-up as well.
- Any entry point that bypasses the safety gate. The gate is part of the dispatcher, not a
  wrapper a caller can skip.
