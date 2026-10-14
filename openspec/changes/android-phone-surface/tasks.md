## 1. Host relay v2 (multi-device)

Plan: `plans/01-host-relay-v2.md`

- [ ] 1.1 `hello` parsing and the per-device registry
- [ ] 1.2 `attachHostRelay` speaks `host-relay.v2` (refuse v1, mandatory hello)
- [ ] 1.3 Driver decides unsupported ops from the declared set
- [ ] 1.4 Harvest and serve resolve the desktop driver from the registry
- [ ] 1.5 Stream Desktop sends `hello`
- [ ] 1.6 Spec delta, cookbook, live swap

- [ ] 1.7 **Before the next `stream` npm release:** bump and republish `@streamapp/desktop-*` with the
  v2 agent, together with the pins in `cli/package.json` and `capabilities/desktop/package.json`
  (they still point at the v1 build, 0.7.2). Releasing the backend alone leaves every installed
  machine without desktop control. Publishing needs the user's go-ahead.

## 2. Pairing and device tokens

Plan: `plans/02-pairing.md` (written after plan 1 lands)

## 3. Stream Android app

Plan: `plans/03-android-app.md` (written after plan 2 lands)

## 4. Recipe platform field and Android vocabulary

Plan: `plans/04-recipe-platform.md` (written after plan 3 lands)

## 5. Measure the four delivery apps on the REDMI K80

Tree readable, taps land, any refusal under an active accessibility service — per app.
