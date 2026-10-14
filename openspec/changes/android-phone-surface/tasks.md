## 1. Host relay v2 (multi-device)

Plan: `plans/01-host-relay-v2.md`

- [x] 1.1 `hello` parsing and the per-device registry
- [x] 1.2 `attachHostRelay` speaks `host-relay.v2` (refuse v1, mandatory hello)
- [x] 1.3 Driver decides unsupported ops from the declared set
- [x] 1.4 Harvest and serve resolve the desktop driver from the registry
- [x] 1.5 Stream Desktop sends `hello`
- [x] 1.6 Spec delta, cookbook, live swap
- [x] 1.7 Republish `@streamapp/desktop-*` 0.7.3 (v2 agent) with the pins in `cli/package.json` and
  `capabilities/desktop/package.json`, ahead of `@streamapp/stream` 0.0.29

## 2. Pairing and device tokens

Plan: `docs/superpowers/plans/2026-10-14-device-pairing.md` (the comet guard keeps implementation
plans out of the change directory while the change is in the open phase).

- [x] 2.1 Add `uqr` to the panel (main checkout)
- [x] 2.2 `DeviceStore` with hashed tokens and one-time codes
- [x] 2.3 `/api/host` accepts device tokens bound to their id; registry can drop a device
- [x] 2.4 Device routes, the pairing exemption, serve wiring
- [x] 2.5 Panel "手机" section
- [x] 2.6 Spec delta, cookbook, full suite, live check

## 3. Stream Android app

Plan: `plans/03-android-app.md` (written after plan 2 lands)

## 4. Recipe platform field and Android vocabulary

Plan: `plans/04-recipe-platform.md` (written after plan 3 lands)

## 5. Measure the four delivery apps on the REDMI K80

Tree readable, taps land, any refusal under an active accessibility service — per app.
