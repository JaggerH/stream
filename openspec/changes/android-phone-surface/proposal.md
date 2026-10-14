## Why

Recipes can drive two surfaces today: the user's Chrome and native desktop windows (Stream Desktop).
A large class of everyday actions lives only in phone apps. Ordering food in China, for example,
happens in Meituan, Ele.me, JD and Taobao (闪购), and Stream cannot reach any of them.

Two ways to reach an Android phone were measured on 2026-10-14:

- **adb over USB debugging.** On a Huawei PPA-AL20 (Android 10), screenshots, the UI tree dump and
  `input tap` all worked, and AppGallery installs were driven end to end. On a REDMI K80 (HyperOS 2,
  Android 15), screenshots and the UI dump worked but every `input` call failed with
  `SecurityException: Injecting input events requires ... INJECT_EVENTS`. Xiaomi gates input
  injection behind "USB debugging (Security settings)", which needs a Mi account **and** a SIM card.
- More fundamentally, **end users will not turn on developer mode**. A surface that depends on it
  cannot be the product path, whether the phone sits on the user's desk or becomes a remote
  standby device later.

## What Changes

- **A Stream Android app** (Kotlin, `app/android/`) that acts as a host agent on the phone. It does the
  work through an `AccessibilityService`: it reads the node tree, dispatches gestures, sets text,
  performs global Back/Home actions and takes screenshots (`takeScreenshot`, API 30+). It holds a
  persistent outbound WebSocket to the backend and speaks the existing `host-relay.v1` op protocol.
  Neither developer mode nor adb is needed.
- **Multi-device host relay.** `/api/host` accepts more than one agent at a time. Each connection
  declares a device identity (id, platform, name). The backend keeps one relay per device, with its
  own session lease, so a phone and a PC can each run a recipe at the same time while each device
  still runs only one recipe at a time.
- **Recipes declare their platform.** A recipe that drives the phone says it targets `android` and
  names the app by package. The runner picks an online device of that platform.
- **Per-device pairing.** The panel shows a QR code holding the backend address and a one-time pairing
  code. The app exchanges that code for its own device token. Tokens can be revoked one at a time.
  The phone never holds the shared extension/desktop token.
- **Mobile op additions.** `press` gains `Back` and `Home`, and a `launchApp` op opens an app by
  package name. Ops the phone cannot do (`readText` OCR, `findImage`, `moveMouse`, `nudge`) answer
  "unsupported", following the path old desktop agents already take.

Out of scope for this change: remote or cloud phones, choosing among several phones, on-device OCR,
app-store distribution, and phones that have a lock-screen credential.

## Capabilities

### New Capabilities
- `android-recipe-replay`: replay recipes on an Android phone through the Stream Android app.

### Modified Capabilities
- `desktop-recipe-replay`: the host relay becomes multi-device, and recipes carry a target platform.

## Impact

- `src/http/host-relay.ts`: from one relay to a registry of relays keyed by device, plus the
  device handshake and per-device token check.
- `src/kernel/plugins/harvest.ts`: `desktopDriver()` resolves a driver for the recipe's platform
  instead of the single relay.
- `src/replay/desktop-recipe.ts` / `desktop-runner.ts`: platform field, Android app match, new keys.
- Panel: a device list, a pairing QR code and token revocation.
- New `app/android/` Gradle project. The dev machine needs a JDK and Android cmdline-tools again
  (about 1–2 GB).
- Stream Desktop (Rust) sends the device-identity handshake; old agents without it are treated as the
  default desktop device.
