## Context

Stream Desktop (`app/host-agent`, Rust) is a thin executor. It dials `/api/host`, receives
`{id, op, args}` frames and replies `{id, result | error}`. All recipe logic stays in the backend:
step sequencing, `expect` read-back, drift and failure classification. `makeDesktopDriver(relay)`
turns those ops into the `DesktopDriver` interface that `runDesktopRecipe` consumes.

Android exposes the same kind of capability through an `AccessibilityService`. It has a node tree
with roles, text, content descriptions and bounds, and it supports node actions, gestures, global
actions and screenshots. So the phone fits in as one more host agent that speaks the same protocol,
not as a second automation stack.

Three facts in today's backend constrain the design:

1. `WsHostRelay` assumes one connection. `connect()` is "latest wins", so a phone connecting would
   kick Stream Desktop off.
2. The upgrade is authorized with the shared extension token (`verifyHostUpgrade`). That token
   controls everything, and it must not live on a device that can be lost.
3. The backend already listens on `0.0.0.0:8900` (the user opens it from their phone), so a phone on
   the same LAN can reach `/api/host` without new network plumbing.

## Goals / Non-Goals

**Goals**
- Run an action recipe on an Android phone with no developer mode, no adb and no cable.
- Reuse `runDesktopRecipe`, `expect`, failure classification and the session lease unchanged where
  possible.
- Allow a PC and a phone to be connected at once and run concurrently.
- Survive the phone being idle for hours: background killing, a disabled accessibility service and
  a sleeping screen.

**Non-Goals**
- Remote or cloud phones. The connection is outbound from the phone, so a phone in a data center
  later uses the same path; this change does not provision one.
- Several phones and choosing among them, which waits for a second phone.
- On-device OCR (`readText`), template matching (`findImage`) and the icon detector.
- Phones with a lock-screen credential. A credential lock cannot be dismissed programmatically.
- Payment. Recipes stop before any payment confirmation.

## Decisions

### D1. The phone is a host agent speaking `host-relay.v1`

The Android app implements the existing op table. Mapping:

| op | Android implementation |
|---|---|
| `windows` / `scopeWindow` / `url` | `getWindows()` / `rootInActiveWindow`; the window id is the foreground package + activity |
| `find` / `readSubtree` | walk the `AccessibilityNodeInfo` tree; `role` = class simple name, `name` = text, falling back to contentDescription |
| `invoke` | `performAction(ACTION_CLICK)` on the node, or on its nearest clickable ancestor |
| `setValue` / `type` | `ACTION_SET_TEXT` on the focused or referenced editable node |
| `clearInput` | `ACTION_SET_TEXT` with `""` |
| `click` / `scroll` | `dispatchGesture` tap / swipe |
| `press` | `Back` / `Home` via `performGlobalAction`; `Enter` via `ACTION_IME_ENTER` (API 30) |
| `screenshot` / `captureWindow` | `takeScreenshot` (API 30+) → PNG |
| `focusApp` / `ensureApp` / `launchApp` | launch intent for the package |
| `status` | text on the takeover overlay |
| `readText`, `findImage`, `moveMouse`, `nudge`, `readElements` icons | reply `unsupported`; the driver already treats absence as "this agent has no such op" |

Node refs are stable for the lifetime of one tree snapshot. A ref used after the tree changed fails
loudly as `stale-ref`, so the runner re-finds the node instead of acting on a recycled one.

*Alternative rejected:* drive the phone with adb from the backend. Measured on 2026-10-14: Xiaomi
blocks input injection without a Mi account and SIM card, and end users will not enable developer
mode either way. adb stays a developer tool for installing and debugging the app.

### D2. Multi-device relay, keyed by device id

The first frame after the upgrade is `{type:'hello', deviceId, platform:'windows'|'macos'|'android',
name, agentVersion}`. A `HostRelayRegistry` holds one `WsHostRelay` per `deviceId`. Each relay keeps
today's per-connection semantics: "latest wins" now applies per device, plus the session lease and
abort epoch. Two recipes on the same device still serialize. A phone and a PC do not block each other.

A Stream Desktop build without `hello` is registered as `deviceId: 'desktop-default'`, platform
`desktop`, so existing installs keep working untouched. For matching recipes, `windows` and `macos`
both count as the `desktop` platform; recipes that need one OS keep using their existing app match.

`hostRelay.connected` and the single `desktopDriver()` become
`driverFor(platform): DesktopDriver | undefined`. When no device of the platform is online, the run
records a `miss`, not a failure. This is today's behavior for a missing desktop agent.

### D3. A recipe declares its platform

`kind:'desktop'` recipes gain `platform?: 'desktop' | 'android'`. The default is `'desktop'`, so
existing recipes are unchanged. An Android `app` match is `{ package: 'com.sankuai.meituan' }`.
Platform-specific vocabulary is checked when the recipe is loaded: `press: 'Back'` on a desktop
recipe is rejected at load time, not at run time. `PRESSABLE_KEYS` becomes per platform.

*Alternative rejected:* a new `kind:'android'`. The step vocabulary, `expect`, branches and
interrupts are the same. A new kind would fork `desktop-runner.ts` for no semantic difference.

### D4. Pairing and per-device tokens

- The panel's "Add phone" action creates a one-time pairing code (6 digits, 5-minute TTL, single use)
  and shows a QR code containing `{backendUrl, code}`.
- The app posts the code to `POST /api/devices/pair` and receives `{deviceId, deviceToken}`. It stores
  them in Android Keystore-backed storage.
- `/api/host` accepts either the shared token, kept for Stream Desktop, or a device token. A device
  token is bound to its `deviceId`. A `hello` claiming another id is rejected.
- `GET /api/devices` lists paired devices with their last-seen time. `DELETE /api/devices/:id`
  revokes the token and drops a live connection immediately.
- Pairing endpoints are rate-limited. Codes are compared in constant time.

### D5. Staying alive on an idle phone

- A foreground service owns the WebSocket and shows a persistent "Stream connected" notification.
  It reconnects with backoff.
- The app shows a setup checklist with deep links into the OEM settings pages. On Xiaomi: autostart,
  battery saver "No restrictions", lock in recents.
- Every heartbeat reports `{a11yEnabled, screenOn, keyguardLocked, battery, charging}`. When the
  accessibility service turns off, which the OS does silently on app updates and some OEM cleanups,
  the backend raises an event through the notification center. Each such event carries a `dedupeKey`.
- Before a recipe runs, the agent wakes the screen (a wake lock with `ACQUIRE_CAUSES_WAKEUP`) and
  dismisses a **non-secure** keyguard. If the keyguard is secure, the run fails with
  `device-locked` and does not hang. After the run the agent releases the wake lock and lets the
  screen sleep.

### D6. Takeover overlay and abort

While a session lease is held, the app draws a `TYPE_ACCESSIBILITY_OVERLAY` banner, which needs no
extra permission. The banner shows the `status` text and a Stop button. Stop sends
`{type:'abort', reason:'user'}`, the same frame the desktop hotkey sends. The relay rejects queued
and in-flight ops with `HostAbortedByUser`, and no layer retries them.

### D7. Distribution and build

The code lives in `app/android/` (Gradle, Kotlin, minSdk 30, targetSdk = current). The APK is served
by the backend at `/panel/android/stream.apk`, so the user installs it from the phone browser. This
also avoids Xiaomi's "USB install" gate. App-store release is out of scope. The Android build goes
through `scripts/qrun.sh` like cargo.

## Risks / Trade-offs

- **Apps that detect accessibility services.** Some apps refuse service or hide content when an
  accessibility service is active. → The first milestone after the agent works is to measure the
  four delivery apps (tree readable? taps land? any refusal?) before writing their recipes.
- **`FLAG_SECURE` screens screenshot as black.** Payment-password pages do this. → Acceptable:
  recipes stop before payment. A black capture must surface as `secure-window`, not as an empty page.
- **Custom-drawn UIs with no node tree.** Flutter, game engines and WebViews without accessibility.
  → They show up in the measurement; OCR is the follow-up, not part of this change.
- **`takeScreenshot` is rate-limited.** It allows roughly one call per second. → The agent serializes
  screenshot calls and backs off, and does not return an error.
- **OEM background killing beats the checklist.** → The heartbeat makes the failure visible within
  one interval instead of at the next scheduled run.
- **The relay refactor touches Stream Desktop's path.** → Old agents map to `desktop-default`, and the
  existing host-relay tests run against the registry unchanged.

## Migration Plan

1. Registry and `hello` in the backend; Stream Desktop sends `hello`. Behavior for a single desktop
   agent is unchanged.
2. Pairing endpoints, device tokens and the panel device list.
3. The Android app: connection, pairing, the op table and the overlay.
4. A recipe `platform` field plus Android app match and keys.
5. Measure the four delivery apps with the app installed on the REDMI K80.

Rollback: steps 1–4 are additive. With no device paired, the backend behaves as it does today.

## Open Questions

- How the scheduled-task bridge invokes an action recipe (the breakfast use case). This is a
  separate change after the measurement.
- How a payment-confirmation hand-off reaches the user's own phone. This is a separate change.
