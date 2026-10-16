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

Plan: `docs/superpowers/plans/2026-10-14-android-app.md`

- [x] 3.1 Backend: device state frames, local op endpoint, APK route, panel badge
- [x] 3.2 Project skeleton, host-relay frames, build script
- [x] 3.3 Query engine and snapshot refs
- [x] 3.4 Op dispatcher over a device interface
- [x] 3.5 Accessibility service, device actions, takeover banner, wake
- [x] 3.6 Foreground relay service
- [x] 3.7 Pairing, setup checklist, start on boot
- [x] 3.8 Spec delta, cookbook, live check on the REDMI K80
  - Spec delta `specs/android-recipe-replay/`, cookbook `docs/API.md` (Android app).
  - Live check 2026-10-15/16, REDMI K80, HyperOS 2.0 / Android 15, backend on this branch: install
    from `/panel/android/stream.apk` (the backend machine needs an inbound firewall rule for its
    port on the LAN), pair by QR from 设置 → Stream → 手机 (one code, the phone asks which
    address), `windows`, `url`, `focusApp` (淘宝, 美团, 闲鱼), `find`, `invoke` with `expect`,
    `screenshot` (淘宝's login page captures black: protected), `scroll`, `press` Back/Home,
    stale refs (superseded find, a new window, a scroll over the node: refused without acting;
    a ref beside a ticking carousel still works after 12 s), the banner's 停止 (a 20 s wait
    ended at 15.6 s as an abort worded for the phone; the next op ran), accessibility off
    (`a11yEnabled:false`, the `device.a11y-off` notice, ops fail `a11y-off`), revoke (the app
    asks to pair again and stops reconnecting).
  - Fixed on the way: the page hidden under the title bar (edge to edge), no pairing entry in the
    panel, the scanner crashing (androidx.core), HyperOS's 「是否允许」 launch prompt misnamed,
    `url` renamed by background apps, the abort worded as the desktop hotkey, a stale 已连接
    after 取消配对.
  - For §5: 美团 answered `focusApp` with its risk-control page (`yoda`) on later launches.

## 4. Recipe platform field and Android vocabulary

Plan: `plans/04-recipe-platform.md` (written after plan 3 lands)

## 5. Measure the four delivery apps on the REDMI K80

Tree readable, taps land, any refusal under an active accessibility service — per app.
