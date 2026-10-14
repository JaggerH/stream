# Stream Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stream Android app that pairs with the backend, keeps a `host-relay.v2` connection open from a foreground service, and executes the host op table through an AccessibilityService, so the backend can drive a phone the way it drives Stream Desktop.

**Architecture:** The phone is one more host agent (design D1). The backend sends `{id, op, args}` frames and the app replies `{id, result}` or `{id, error}`. All query matching, op dispatch and frame handling is plain Kotlin with no Android imports, unit-tested on the JVM against a fake device. The Android-bound layer is thin: an `AccessibilityService` implements the `Device` interface, a foreground service owns the WebSocket, and one Activity handles pairing and the setup checklist. The backend gains three small things: state frames from devices, a loopback-only op endpoint for live checks, and an APK download route.

**Tech Stack:** Kotlin 2.0.21, Android Gradle Plugin 8.7.3, Gradle 8.10.2, JDK 17, compileSdk/targetSdk 35, minSdk 30, OkHttp 4.12.0 (WebSocket), zxing-android-embedded 4.3.0 (QR scan), JUnit 4.13.2 + org.json 20240303 (JVM tests). Backend: TypeScript, Hono, vitest.

**Spec:** `openspec/changes/android-phone-surface/design.md` (D1, D4, D5, D6, D7).

## Global Constraints

- Code lives in `app/android/` (Gradle, Kotlin, minSdk 30, targetSdk = current). The Android build goes through `scripts/qrun.sh` like cargo.
- Toolchain on the dev machine: `JAVA_HOME=$HOME/opt/jdk-17.0.20.1+1`, `ANDROID_HOME=$HOME/android-sdk` (platforms;android-35, build-tools;35.0.0 installed). Scripts default to these paths when the variables are unset.
- Application id and Kotlin package: `com.streamapp.android`.
- Subprotocol `host-relay.v2`. The app offers `[host-relay.v2, <deviceToken>]`. Its first frame is `{type:'hello', deviceId, platform:'android', name, agentVersion, ops}`.
- Declared ops (`ANDROID_OPS`, exactly these 16): `windows`, `scopeWindow`, `focusApp`, `find`, `invoke`, `setValue`, `type`, `clearInput`, `click`, `scroll`, `press`, `readSubtree`, `screenshot`, `url`, `sleep`, `status`. Not declared: `ensureApp`, `moveMouse`, `nudge`, `readText`, `readElements`, `findImage`.
- Wire shapes are the ones `src/replay/desktop-driver.ts` unwraps: `find` → `{elements:[{ref,role,name,className,rect}], unbuilt?}`; actuation → `{via}` or `{via, confirmed}`; `screenshot` → `{base64, window, scale}` (JPEG); `windows` → `WindowInfo[]`; `scopeWindow` → `{window}`; `focusApp` → `{ok}`; `readSubtree` → `Record<string,string>[]`; `url` → string; `sleep` → `null`; `status` → `{}`.
- Error strings start with a stable prefix, the same as the Rust agent: `missing arg:`, `unknown op:`, `stale-ref:`, `no-scope:`, `no-window-match:`, `ambiguous-window:`, `device-locked:`, `secure-window:`, `a11y-off:`, `unsupported-key:`, `unsupported-deliver:`, `not-editable:`, `action-failed:`, `gesture-failed:`, `blocked-by-os:` (the OS refused to start an activity from the background).
- The scope is an app (package + optional title), re-resolved to that app's current window on every op: each Activity is its own window, so a window-id scope dies on the first navigation.
- `confirmed` is three-state: present only when an `expect` was given. Never default it to `true`.
- A node ref is valid for one tree snapshot. Using a ref from an older snapshot fails as `stale-ref:`; it never acts on a recycled node.
- State frame: `{type:'state', a11yEnabled, screenOn, keyguardLocked, battery, charging}`, sent right after `hello`, every 30 s, and immediately when the accessibility service connects or disconnects.
- Abort frame: `{type:'abort', reason:'user'}`, sent by the overlay's Stop button.
- Close code 4003 from the backend means the token is revoked or rejected: the app forgets its credentials and stops reconnecting.
- Payment is never automated. Nothing in this plan taps a payment confirmation.
- Public docs are English and describe the current state only. User-facing strings in the app and panel are Chinese.
- Git: run as `git -C <abs path>`. No `git stash`, no `--amend`, no `pkill -f`, no inline scripts or heredocs (write scripts to a file first).

---

## File Structure

Backend:
- `src/http/host-registry.ts`: add `HostDeviceState`, `parseState`, `HostRelayRegistry.setState`, and `HostDevice.state`.
- `src/http/host-relay.ts`: route `{type:'state'}` frames to the registry and to `onDeviceState`.
- `src/http/device-routes.ts`: `GET /api/devices` carries `state`; new loopback-only `POST /api/devices/:id/ops`.
- `src/http/panel-mount.ts`: `GET /panel/android/stream.apk`.
- `src/serve.ts`: wire `onDeviceState` to a notification and pass `registry.devices` to the op route.
- `app/src/components/PhoneDevicesSettings.tsx`, `app/src/lib/api.ts`: an "accessibility off" badge and an install link.

Android (`app/android/`):
- `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/wrapper/*`, `gradlew`: the project.
- `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/res/xml/*`, `app/src/main/res/values/strings.xml`.
- `app/src/main/java/com/streamapp/android/protocol/`: `Json.kt` (helpers), `Frames.kt`, `PairPayload.kt`, `Backoff.kt`. Pure.
- `.../agent/`: `UiNode.kt`, `Query.kt`, `RefTable.kt`, `Device.kt`, `Dispatcher.kt`. Pure.
- `.../a11y/`: `StreamAccessibilityService.kt`, `AndroidDevice.kt`, `NodeAdapter.kt`, `Overlay.kt`, `WakeActivity.kt`.
- `.../net/`: `RelayService.kt`, `RelayClient.kt`, `Pairing.kt`.
- `.../store/Credentials.kt`.
- `.../ui/MainActivity.kt`.
- `app/src/test/java/com/streamapp/android/...`: JVM tests for every pure file.
- `scripts/build-android.sh`: test and build, then copy the APK to `app/dist-panel/android/stream.apk`.

---

### Task 1: Backend: device state, op endpoint, APK route, panel badge

**Files:**
- Modify: `src/http/host-registry.ts`
- Modify: `src/http/host-relay.ts`
- Modify: `src/http/device-routes.ts`
- Modify: `src/http/panel-mount.ts`
- Modify: `src/serve.ts`
- Modify: `app/src/lib/api.ts`, `app/src/components/PhoneDevicesSettings.tsx`
- Test: `src/http/host-registry.test.ts`, `src/http/host-relay.test.ts`, `src/http/device-routes.test.ts`, `src/http/panel-mount.test.ts`, `app/src/components/PhoneDevicesSettings.test.tsx`

**Interfaces:**
- Produces: the `{type:'state'}` frame contract, `POST /api/devices/:id/ops` with body `{op, args?}` returning `{result}` or `{error}`, and `GET /panel/android/stream.apk`.

- [ ] **Step 1: Write failing tests for `parseState` and `setState`**

Append to `src/http/host-registry.test.ts`, following its existing imports and fake-socket helper:

```ts
describe('parseState', () => {
  it('reads a full state frame', () => {
    expect(parseState(JSON.stringify({ type: 'state', a11yEnabled: true, screenOn: false, keyguardLocked: true, battery: 81, charging: false })))
      .toEqual({ a11yEnabled: true, screenOn: false, keyguardLocked: true, battery: 81, charging: false })
  })
  it('is null for anything that is not a well-formed state frame', () => {
    expect(parseState('{"type":"state","a11yEnabled":"yes"}')).toBeNull()
    expect(parseState('{"id":1,"result":null}')).toBeNull()
    expect(parseState('not json')).toBeNull()
  })
})

describe('HostRelayRegistry.setState', () => {
  it('attaches state to the live device and returns the previous one', () => {
    const reg = new HostRelayRegistry()
    const sock = fakeSocket()
    reg.connect(sock, { deviceId: 'android:1', platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['find'] })
    const s1 = { a11yEnabled: true, screenOn: true, keyguardLocked: false, battery: 50, charging: true }
    expect(reg.setState('android:1', s1)).toBeUndefined()
    expect(reg.devices()[0].state).toEqual(s1)
    const s2 = { ...s1, a11yEnabled: false }
    expect(reg.setState('android:1', s2)).toEqual(s1)
  })
  it('ignores state for a device that is not connected', () => {
    const reg = new HostRelayRegistry()
    expect(reg.setState('android:gone', { a11yEnabled: true, screenOn: true, keyguardLocked: false, battery: 1, charging: false })).toBeUndefined()
    expect(reg.devices()).toEqual([])
  })
})
```

If the file has no `fakeSocket` helper, add one: `const fakeSocket = (): HostSocket => ({ send: () => {}, close: () => {} })`.

- [ ] **Step 2: Run them and watch them fail**

Run: `scripts/qrun.sh npx vitest run src/http/host-registry.test.ts`
Expected: FAIL, `parseState` is not exported.

- [ ] **Step 3: Implement**

In `src/http/host-registry.ts` add:

```ts
/** What a phone reports about itself: sent right after `hello`, every 30 s, and on every
 *  accessibility-service change. The backend only stores the latest one. */
export interface HostDeviceState {
  a11yEnabled: boolean
  screenOn: boolean
  keyguardLocked: boolean
  battery: number
  charging: boolean
}

/** `null` for anything that is not a complete state frame. A partial frame is dropped, not
 *  merged: a missing `a11yEnabled` read as `false` would raise a false alarm. */
export function parseState(raw: string): HostDeviceState | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (m === null || typeof m !== 'object' || m.type !== 'state') return null
  const { a11yEnabled, screenOn, keyguardLocked, battery, charging } = m
  if (typeof a11yEnabled !== 'boolean' || typeof screenOn !== 'boolean' || typeof keyguardLocked !== 'boolean') return null
  if (typeof battery !== 'number' || typeof charging !== 'boolean') return null
  return { a11yEnabled, screenOn, keyguardLocked, battery, charging }
}
```

Add `state?: HostDeviceState` to both `HostDevice` and the private `Live` interface. In `devices()`, map `...(l.state ? { state: l.state } : {})`. Add the method:

```ts
  /** Store a device's latest state. Returns the previous state so the caller can act on a
   *  transition. A device that is not live is ignored. */
  setState(deviceId: string, state: HostDeviceState): HostDeviceState | undefined {
    const l = this.live.get(deviceId)
    if (!l) return undefined
    const prev = l.state
    l.state = state
    return prev
  }
```

`connect` builds a fresh `Live`, so a reconnect starts with no state until the device sends one.

- [ ] **Step 4: Run the registry tests; expect PASS**

Run: `scripts/qrun.sh npx vitest run src/http/host-registry.test.ts`

- [ ] **Step 5: Write a failing relay test for state frames**

In `src/http/host-relay.test.ts`, find the existing tests that pair a device token, connect over a real `ws` client and send a hello. Add one in the same style:

```ts
it('routes state frames to the registry and to onDeviceState, not to the relay', async () => {
  const seen: Array<[string, unknown, unknown]> = []
  // build server + registry exactly like the neighbouring device-token test, adding:
  //   onDeviceState: (id, prev, next) => seen.push([id, prev, next])
  // connect with the device token, send the android hello, then:
  client.send(JSON.stringify({ type: 'state', a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false }))
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  expect(seen[0]).toEqual(['android:1', undefined, { a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false }])
  expect(registry.devices()[0].state?.a11yEnabled).toBe(false)
})
```

Use the existing test's device id and helpers; the literal `'android:1'` stands for whatever id that test pairs.

- [ ] **Step 6: Implement in `attachHostRelay`**

Add `onDeviceState?: (deviceId: string, prev: HostDeviceState | undefined, next: HostDeviceState) => void` to the opts type and destructure it. In the `message` handler, replace the `deviceId !== null` branch with:

```ts
      if (deviceId !== null) {
        const state = parseState(raw)
        if (state) {
          const prev = registry.setState(deviceId, state)
          onDeviceState?.(deviceId, prev, state)
          return
        }
        registry.devices().find((d) => d.hello.deviceId === deviceId)?.relay.handleMessage(raw)
        return
      }
```

Import `parseState` and `type HostDeviceState` from `./host-registry.ts`.

- [ ] **Step 7: Run relay tests; expect PASS**

Run: `scripts/qrun.sh npx vitest run src/http/host-relay.test.ts src/http/host-registry.test.ts`

- [ ] **Step 8: Write failing route tests**

In `src/http/device-routes.test.ts`, extend the deps factory so `registry` also has `devices()` returning a device with a `relay` whose `send` is a `vi.fn()`, plus `state`. Add:

```ts
it('lists the live state of an online device', async () => {
  // registry.devices() returns one android device, paired in the store, with state {a11yEnabled:false,...}
  const r = await app.request('/api/devices')
  const body = await r.json()
  expect(body.devices[0].state).toEqual({ a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false })
})

it('runs one op on a device, loopback only', async () => {
  send.mockResolvedValueOnce({ elements: [] })
  const ok = await app.request('/api/devices/android:1/ops', { method: 'POST', body: JSON.stringify({ op: 'find', args: { query: { role: 'Button' } } }) })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ result: { elements: [] } })
  expect(send).toHaveBeenCalledWith({ op: 'find', args: { query: { role: 'Button' } } })
})

it('reports an agent error as 502 with the message', async () => {
  send.mockRejectedValueOnce(new Error('stale-ref: n3 belongs to an older tree'))
  const r = await app.request('/api/devices/android:1/ops', { method: 'POST', body: JSON.stringify({ op: 'invoke', args: { ref: 'n3' } }) })
  expect(r.status).toBe(502)
  expect(await r.json()).toEqual({ error: 'stale-ref: n3 belongs to an older tree' })
})

it('refuses the op route off-box and for an offline device', async () => {
  // isLocal → false
  expect((await remoteApp.request('/api/devices/android:1/ops', { method: 'POST', body: '{"op":"url"}' })).status).toBe(403)
  expect((await app.request('/api/devices/android:nope/ops', { method: 'POST', body: '{"op":"url"}' })).status).toBe(404)
  expect((await app.request('/api/devices/android:1/ops', { method: 'POST', body: '{"args":{}}' })).status).toBe(400)
})
```

Adapt `app` / `remoteApp` to however the file already builds a local and a non-local app.

- [ ] **Step 9: Implement the routes**

In `src/http/device-routes.ts`: widen `registry` to `Pick<HostRelayRegistry, 'devices' | 'kick'>` (already) and use `devices()` for the op route. In the `GET /api/devices` mapping add `...(live?.state ? { state: live.state } : {})` for paired rows and `...(d.state ? { state: d.state } : {})` for the others. Add:

```ts
  /**
   * Run one host op on one device and return what the agent answered. **This machine only**:
   * it actuates a phone, so it needs someone at the machine, the same rule as `pairing-code`.
   * It exists for live checks and for measuring a new app before writing its recipe; recipes
   * never go through it.
   */
  app.post('/api/devices/:id/ops', async (c) => {
    if (!deps.isLocal(c)) return c.json({ error: '只能在运行 Stream 的那台机器上调用' }, 403)
    const id = c.req.param('id')
    let body: { op?: unknown; args?: unknown }
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    if (typeof body.op !== 'string' || (body.args !== undefined && (typeof body.args !== 'object' || body.args === null))) {
      return c.json({ error: 'op 必须是字符串，args 可选且必须是对象' }, 400)
    }
    const device = deps.registry.devices().find((d) => d.hello.deviceId === id)
    if (!device) return c.json({ error: '这台设备不在线' }, 404)
    try {
      const result = await device.relay.send({ op: body.op, ...(body.args ? { args: body.args as Record<string, unknown> } : {}) })
      return c.json({ result: result ?? null })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    }
  })
```

- [ ] **Step 10: Run route tests; expect PASS**

Run: `scripts/qrun.sh npx vitest run src/http/device-routes.test.ts`

- [ ] **Step 11: APK route, test first**

In `src/http/panel-mount.test.ts`, add, following the file's temp-dir setup:

```ts
it('serves the Android APK from <root>/android/stream.apk', async () => {
  mkdirSync(join(root, 'android'), { recursive: true })
  writeFileSync(join(root, 'android', 'stream.apk'), Buffer.from('PK\x03\x04apk'))
  const r = await app.request('/panel/android/stream.apk')
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('application/vnd.android.package-archive')
  expect(r.headers.get('content-disposition')).toBe('attachment; filename="stream.apk"')
})

it('names the build command when the APK has not been built', async () => {
  const r = await app.request('/panel/android/stream.apk')
  expect(r.status).toBe(404)
  expect(await r.text()).toContain('scripts/build-android.sh')
})
```

Then in `mountPanelAssets`, **before** the `/panel/:file` route, add:

```ts
  // The phone downloads the Stream app from here (design D7): installing from the phone's own
  // browser avoids Xiaomi's "USB install" gate and needs no cable.
  app.get('/panel/android/stream.apk', async (c) => {
    let body: Buffer
    try {
      body = await readFile(join(opts.root, 'android', 'stream.apk'))
    } catch {
      return c.text('[panel] stream.apk 还没构建：scripts/build-android.sh', 404)
    }
    return c.body(Uint8Array.from(body), 200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="stream.apk"',
      'cache-control': 'no-cache',
    })
  })
```

Run: `scripts/qrun.sh npx vitest run src/http/panel-mount.test.ts`. Expected: PASS.

- [ ] **Step 12: Wire serve.ts**

In the `attachHostRelay(...)` call in `src/serve.ts`, add:

```ts
      // A phone whose accessibility service went off can still connect but cannot do anything.
      // The OS turns it off silently (app updates, some OEM cleanups), so say it where the user looks.
      onDeviceState: (id, prev, next) => {
        if (next.a11yEnabled || prev?.a11yEnabled === false) return
        const name = harvest.hostRelays.devices().find((d) => d.hello.deviceId === id)?.hello.name ?? id
        streamEvents.emit({
          type: 'device.a11y-off', severity: 'warn',
          title: `${name} 的无障碍服务关了`,
          body: '手机上的 Stream 连着，但无障碍服务被系统关掉了，手机上的 recipe 都跑不了。到手机的 设置 → 无障碍 → Stream 重新打开。',
          dedupeKey: `device-a11y-off:${id}`,
        })
      },
```

`prev?.a11yEnabled === false` suppresses repeats while it stays off; the first state after a connect (`prev` undefined) with `a11yEnabled:false` does notify.

- [ ] **Step 13: Panel badge and install link**

In `app/src/lib/api.ts`, add to `DeviceRow`: `state?: { a11yEnabled: boolean; screenOn: boolean; keyguardLocked: boolean; battery: number; charging: boolean }`. In `PhoneDevicesSettings.tsx`, next to an online device's name, render `<span>无障碍已关</span>` (reuse the badge/class pattern the component already uses for "在线") when `d.state?.a11yEnabled === false`. Under the "添加手机" button add a link `<a href={`${conn.backend}/panel/android/stream.apk`}>下载安卓 App</a>`, using however the component already derives the backend base URL from `conn` (check `api.ts` for the field name; do not hard-code a host). Add a test in `PhoneDevicesSettings.test.tsx` that a device row with `state.a11yEnabled:false` shows `无障碍已关`.

Run (cwd `app/`): `../scripts/qrun.sh npx vitest run src/components/PhoneDevicesSettings.test.tsx`. Expected: PASS.

- [ ] **Step 14: Typecheck and commit**

Run: `scripts/qrun.sh npx tsc --noEmit -p .` and (cwd `app/`) `../scripts/qrun.sh npx tsc --noEmit -p .`. Both must be clean.

```bash
git -C <worktree> add src/http app/src/lib/api.ts app/src/components/PhoneDevicesSettings.tsx app/src/components/PhoneDevicesSettings.test.tsx src/serve.ts
git -C <worktree> commit -m "feat(devices): device state frames, a local op endpoint and the APK download"
```

---

### Task 2: Android project skeleton, protocol module, build script

**Files:**
- Create: `app/android/settings.gradle.kts`, `app/android/build.gradle.kts`, `app/android/gradle.properties`, `app/android/.gitignore`, wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties`)
- Create: `app/android/app/build.gradle.kts`, `app/android/app/src/main/AndroidManifest.xml` (minimal for now), `app/android/app/src/main/res/values/strings.xml`
- Create: `app/android/app/src/main/java/com/streamapp/android/protocol/{Json.kt,Frames.kt,PairPayload.kt,Backoff.kt}`
- Create: `app/android/app/src/test/java/com/streamapp/android/protocol/{FramesTest.kt,PairPayloadTest.kt,BackoffTest.kt}`
- Create: `scripts/build-android.sh`

**Interfaces:**
- Produces: `Frames.request(raw): Request?` where `data class Request(val id: Long, val op: String, val args: JSONObject)`; `Frames.reply(id, result: Any?)`, `Frames.error(id, message)`, `Frames.hello(deviceId, name, agentVersion, ops: List<String>)`, `Frames.state(DeviceState)`, `Frames.abort()`; `data class DeviceState(a11yEnabled, screenOn, keyguardLocked, battery: Int, charging)`; `PairPayload.parse(text): PairPayload?` with `backend`, `code`; `Backoff` with `next(): Long` and `reset()`; `wsUrl(backend: String): String`.

- [ ] **Step 1: Generate the Gradle wrapper**

Download Gradle 8.10.2 once to `~/opt` (not into the repo):

```bash
curl -sSL -o ~/opt/dl/gradle-8.10.2-bin.zip https://services.gradle.org/distributions/gradle-8.10.2-bin.zip
cd ~/opt && unzip -q -o dl/gradle-8.10.2-bin.zip
```

Create `app/android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "stream-android"
include(":app")
```

`app/android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

`app/android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
```

`app/android/.gitignore`:

```
.gradle/
build/
local.properties
*.apk
```

Then generate the wrapper from `app/android/`: `JAVA_HOME=$HOME/opt/jdk-17.0.20.1+1 ~/opt/gradle-8.10.2/bin/gradle wrapper --gradle-version 8.10.2 --distribution-type bin`. Commit `gradlew`, `gradlew.bat` and `gradle/wrapper/*`.

- [ ] **Step 2: App module build file**

`app/android/app/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.streamapp.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.streamapp.android"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded from the backend. Signed with this machine's debug key so every build from
            // here updates the installed app in place; a store release would need its own key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub on the JVM; tests need the real one.
    testImplementation("org.json:json:20240303")
}
```

Minimal `app/src/main/AndroidManifest.xml` (Task 6 and 7 fill it in):

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name" android:allowBackup="false" />
</manifest>
```

`app/src/main/res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Stream</string>
</resources>
```

- [ ] **Step 3: Write the failing protocol tests**

`app/src/test/java/com/streamapp/android/protocol/FramesTest.kt`:

```kotlin
package com.streamapp.android.protocol

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FramesTest {
    @Test fun parsesARequestWithArgs() {
        val r = Frames.request("""{"id":7,"op":"find","args":{"query":{"role":"Button"}}}""")!!
        assertEquals(7L, r.id)
        assertEquals("find", r.op)
        assertEquals("Button", r.args.getJSONObject("query").getString("role"))
    }

    @Test fun argsDefaultToEmptyObject() {
        assertEquals(0, Frames.request("""{"id":1,"op":"url"}""")!!.args.length())
    }

    @Test fun rejectsFramesThatAreNotRequests() {
        assertNull(Frames.request("""{"op":"url"}"""))
        assertNull(Frames.request("""{"id":"1","op":"url"}"""))
        assertNull(Frames.request("""{"id":1}"""))
        assertNull(Frames.request("nope"))
    }

    @Test fun replyCarriesNullResultExplicitly() {
        val o = JSONObject(Frames.reply(3, null))
        assertEquals(3, o.getInt("id"))
        assertTrue(o.has("result"))
        assertTrue(o.isNull("result"))
    }

    @Test fun errorFrame() {
        val o = JSONObject(Frames.error(4, "stale-ref: n1"))
        assertEquals("stale-ref: n1", o.getString("error"))
        assertFalse(o.has("result"))
    }

    @Test fun helloDeclaresAndroid() {
        val o = JSONObject(Frames.hello("android:x", "K80", "0.1.0", listOf("find", "url")))
        assertEquals("hello", o.getString("type"))
        assertEquals("android", o.getString("platform"))
        assertEquals("android:x", o.getString("deviceId"))
        assertEquals(2, o.getJSONArray("ops").length())
    }

    @Test fun stateFrame() {
        val o = JSONObject(Frames.state(DeviceState(a11yEnabled = false, screenOn = true, keyguardLocked = false, battery = 77, charging = true)))
        assertEquals("state", o.getString("type"))
        assertFalse(o.getBoolean("a11yEnabled"))
        assertEquals(77, o.getInt("battery"))
    }

    @Test fun abortFrame() {
        val o = JSONObject(Frames.abort())
        assertEquals("abort", o.getString("type"))
        assertEquals("user", o.getString("reason"))
    }
}
```

`PairPayloadTest.kt`:

```kotlin
package com.streamapp.android.protocol

import org.junit.Assert.*
import org.junit.Test

class PairPayloadTest {
    @Test fun parsesThePanelQr() {
        val p = PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://10.9.8.21:8900","code":"123456"}""")!!
        assertEquals("http://10.9.8.21:8900", p.backend)
        assertEquals("123456", p.code)
    }

    @Test fun stripsATrailingSlash() {
        assertEquals("http://h:1", PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1/","code":"000001"}""")!!.backend)
    }

    @Test fun rejectsOtherQrCodes() {
        assertNull(PairPayload.parse("https://example.com"))
        assertNull(PairPayload.parse("""{"stream":"pair","v":2,"backend":"http://h:1","code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"ftp://h","code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1","code":"12345"}"""))
    }

    @Test fun manualEntryBuildsTheSamePayload() {
        val p = PairPayload.manual(" 10.9.8.21:8900 ", " 654321 ")!!
        assertEquals("http://10.9.8.21:8900", p.backend)
        assertEquals("654321", p.code)
        assertNull(PairPayload.manual("10.9.8.21:8900", "abc"))
    }

    @Test fun wsUrlFollowsTheScheme() {
        assertEquals("ws://h:1/api/host", wsUrl("http://h:1"))
        assertEquals("wss://h/api/host", wsUrl("https://h"))
    }
}
```

`BackoffTest.kt`:

```kotlin
package com.streamapp.android.protocol

import org.junit.Assert.*
import org.junit.Test

class BackoffTest {
    @Test fun doublesUpToTheCapThenResets() {
        val b = Backoff(baseMs = 1000, capMs = 60_000, jitter = { 0.0 })
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 32000L, 60000L, 60000L), (1..8).map { b.next() })
        b.reset()
        assertEquals(1000L, b.next())
    }

    @Test fun jitterAddsUpToAQuarter() {
        val b = Backoff(baseMs = 1000, capMs = 60_000, jitter = { 1.0 })
        assertEquals(1250L, b.next())
    }
}
```

- [ ] **Step 4: Run and watch them fail**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest` (with `JAVA_HOME` and `ANDROID_HOME` exported as in Global Constraints).
Expected: compilation FAIL, `Frames` unresolved.

- [ ] **Step 5: Implement the protocol module**

`protocol/Json.kt`:

```kotlin
package com.streamapp.android.protocol

import org.json.JSONArray
import org.json.JSONObject

/** Convert agent results (Kotlin maps, lists, primitives, null) into org.json values. */
fun toJson(v: Any?): Any = when (v) {
    null -> JSONObject.NULL
    is JSONObject, is JSONArray -> v
    is Map<*, *> -> JSONObject().also { o -> v.forEach { (k, x) -> o.put(k.toString(), toJson(x)) } }
    is List<*> -> JSONArray().also { a -> v.forEach { a.put(toJson(it)) } }
    else -> v
}
```

`protocol/Frames.kt`:

```kotlin
package com.streamapp.android.protocol

import org.json.JSONArray
import org.json.JSONObject

data class Request(val id: Long, val op: String, val args: JSONObject)

data class DeviceState(
    val a11yEnabled: Boolean,
    val screenOn: Boolean,
    val keyguardLocked: Boolean,
    val battery: Int,
    val charging: Boolean,
)

/** The `host-relay.v2` frames this app sends and receives. */
object Frames {
    const val PROTOCOL = "host-relay.v2"

    /** A backend request, or null for anything else. A frame with a non-numeric id is not ours. */
    fun request(raw: String): Request? {
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        val id = o.opt("id")
        if (id !is Number) return null
        val op = o.optString("op", "")
        if (op.isEmpty()) return null
        return Request(id.toLong(), op, o.optJSONObject("args") ?: JSONObject())
    }

    fun reply(id: Long, result: Any?): String = JSONObject().put("id", id).put("result", toJson(result)).toString()

    fun error(id: Long, message: String): String = JSONObject().put("id", id).put("error", message).toString()

    fun hello(deviceId: String, name: String, agentVersion: String, ops: List<String>): String =
        JSONObject()
            .put("type", "hello")
            .put("deviceId", deviceId)
            .put("platform", "android")
            .put("name", name)
            .put("agentVersion", agentVersion)
            .put("ops", JSONArray(ops))
            .toString()

    fun state(s: DeviceState): String =
        JSONObject()
            .put("type", "state")
            .put("a11yEnabled", s.a11yEnabled)
            .put("screenOn", s.screenOn)
            .put("keyguardLocked", s.keyguardLocked)
            .put("battery", s.battery)
            .put("charging", s.charging)
            .toString()

    fun abort(): String = JSONObject().put("type", "abort").put("reason", "user").toString()
}
```

`protocol/PairPayload.kt`:

```kotlin
package com.streamapp.android.protocol

import org.json.JSONObject

/** What the panel's QR code carries: `{"stream":"pair","v":1,"backend":"http://…","code":"123456"}`. */
data class PairPayload(val backend: String, val code: String) {
    companion object {
        private val CODE = Regex("^\\d{6}$")

        fun parse(text: String): PairPayload? {
            val o = try { JSONObject(text) } catch (_: Exception) { return null }
            if (o.optString("stream") != "pair" || o.optInt("v") != 1) return null
            return of(o.optString("backend"), o.optString("code"))
        }

        /** Manual entry: the user types the address shown under the QR code and the code. */
        fun manual(address: String, code: String): PairPayload? {
            val a = address.trim()
            return of(if (a.startsWith("http://") || a.startsWith("https://")) a else "http://$a", code.trim())
        }

        private fun of(backend: String, code: String): PairPayload? {
            if (!(backend.startsWith("http://") || backend.startsWith("https://"))) return null
            if (!CODE.matches(code)) return null
            return PairPayload(backend.trimEnd('/'), code)
        }
    }
}

/** `/api/host` on the same backend, with the WebSocket scheme that matches its HTTP scheme. */
fun wsUrl(backend: String): String =
    (if (backend.startsWith("https://")) "wss://" + backend.removePrefix("https://") else "ws://" + backend.removePrefix("http://")) + "/api/host"
```

`protocol/Backoff.kt`:

```kotlin
package com.streamapp.android.protocol

/** Reconnect delays: doubling from [baseMs] to [capMs], plus up to 25% jitter so a backend
 *  restart does not get every phone back in the same millisecond. */
class Backoff(
    private val baseMs: Long = 1_000,
    private val capMs: Long = 60_000,
    private val jitter: () -> Double = { Math.random() },
) {
    private var attempt = 0

    fun next(): Long {
        val raw = (baseMs shl attempt.coerceAtMost(20)).coerceAtMost(capMs)
        if (raw < capMs) attempt++
        return raw + (raw * 0.25 * jitter()).toLong()
    }

    fun reset() { attempt = 0 }
}
```

- [ ] **Step 6: Run the tests; expect PASS**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`

- [ ] **Step 7: Build script**

`scripts/build-android.sh` (mode 755):

```bash
#!/usr/bin/env bash
# Test and build the Stream Android app, then stage the APK where the backend serves it
# (GET /panel/android/stream.apk). Run it through scripts/qrun.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-$HOME/opt/jdk-17.0.20.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
"$ROOT/app/android/gradlew" -p "$ROOT/app/android" --console=plain :app:testDebugUnitTest :app:assembleRelease
mkdir -p "$ROOT/app/dist-panel/android"
cp "$ROOT/app/android/app/build/outputs/apk/release/app-release.apk" "$ROOT/app/dist-panel/android/stream.apk"
echo "[build-android] staged app/dist-panel/android/stream.apk"
```

Run: `scripts/qrun.sh scripts/build-android.sh`. Expected: tests pass, `app/dist-panel/android/stream.apk` exists.

- [ ] **Step 8: Commit**

```bash
git -C <worktree> add app/android scripts/build-android.sh
git -C <worktree> commit -m "feat(android): project skeleton, host-relay frames and the build script"
```

---

### Task 3: Query engine and ref table (pure Kotlin)

**Files:**
- Create: `app/android/app/src/main/java/com/streamapp/android/agent/{UiNode.kt,Query.kt,RefTable.kt}`
- Test: `app/android/app/src/test/java/com/streamapp/android/agent/{QueryTest.kt,RefTableTest.kt,FakeNode.kt}`

**Interfaces:**
- Produces:
  - `interface UiNode { val role: String; val name: String; val className: String; val text: String; val rect: Rect; val children: List<UiNode> }`
  - `data class Rect(val x: Int, val y: Int, val w: Int, val h: Int)` with `toMap()` returning `mapOf("x","y","w","h")`
  - `data class A11yQuery(role, name, nameContains, className, path: List<A11yQuery>?)` with `A11yQuery.from(JSONObject): A11yQuery` that throws `IllegalArgumentException("a11y query: name 与 nameContains 只能给一个（前者全等、后者包含）")` when both are given
  - `fun findAll(root: UiNode, q: A11yQuery): List<UiNode>`: depth-first, document order, the root itself excluded
  - `fun readSubtree(root: UiNode, spec: JSONObject): List<Map<String, String>>`
  - `class RefTable<N>` with `snapshot(nodes: List<N>): List<String>`, `resolve(ref: String): N` (throws `StaleRefException`), `generation: Int`
  - `class StaleRefException(msg: String) : Exception(msg)`

Matching rules (same as the Rust agent):
- `role`: exact, case-sensitive. On Android `role` is the class simple name (`android.widget.Button` → `Button`).
- `name`: exact, case-sensitive. `name` is the node text if non-empty, else its contentDescription, else `""`.
- `nameContains`: substring, case-insensitive. A node with an empty name never matches `nameContains`.
- `className`: exact against the full class name.
- `path`: the node's ancestors (outermost first, root included) must contain the segments **in order**, not necessarily adjacent. Each segment matches by its given `role`/`name`/`className`, exact.
- All given conditions AND together. An empty query matches every node.

`readSubtree` spec is `{itemQuery, fields: {<field>: {read: 'name'|'value', from?: <query>}}, dedupeBy}`. For each item matched by `itemQuery` under the root: for each field, pick the item itself, or the first `findAll(item, from)` hit when `from` is given; read `name` → that node's name, `value` → that node's `text`. A field whose `from` matches nothing reads `""`. `dedupeBy` is applied by the backend; the agent returns every row.

- [ ] **Step 1: Write the failing tests**

`FakeNode.kt` (test source):

```kotlin
package com.streamapp.android.agent

data class FakeNode(
    override val role: String,
    override val name: String = "",
    override val className: String = "android.widget.$role",
    override val text: String = name,
    override val rect: Rect = Rect(0, 0, 10, 10),
    override val children: List<UiNode> = emptyList(),
) : UiNode

fun n(role: String, name: String = "", vararg kids: UiNode) = FakeNode(role, name, children = kids.toList())
```

`QueryTest.kt`:

```kotlin
package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QueryTest {
    private val tree = n("FrameLayout", "",
        n("LinearLayout", "搜索栏",
            n("EditText", "搜索商家或商品"),
            n("Button", "搜索")),
        n("RecyclerView", "",
            n("ViewGroup", "麦当劳 月售 9999+", n("TextView", "麦当劳"), n("TextView", "月售 9999+")),
            n("ViewGroup", "肯德基 月售 5000+", n("TextView", "肯德基"), n("TextView", "月售 5000+"))),
    )

    private fun q(json: String) = A11yQuery.from(JSONObject(json))

    @Test fun matchesRoleAndExactName() {
        assertEquals(listOf("搜索"), findAll(tree, q("""{"role":"Button","name":"搜索"}""")).map { it.name })
    }

    @Test fun nameIsCaseSensitiveButNameContainsIsNot() {
        val t = n("FrameLayout", "", n("Button", "OK"))
        assertTrue(findAll(t, q("""{"name":"ok"}""")).isEmpty())
        assertEquals(1, findAll(t, q("""{"nameContains":"ok"}""")).size)
    }

    @Test fun nameContainsNeverMatchesAnUnnamedNode() {
        assertTrue(findAll(n("FrameLayout", "", n("ImageView")), q("""{"nameContains":""}""")).isEmpty())
    }

    @Test fun rejectsNameTogetherWithNameContains() {
        assertThrows(IllegalArgumentException::class.java) { q("""{"name":"a","nameContains":"a"}""") }
    }

    @Test fun pathSegmentsMustAppearInOrderAmongAncestors() {
        val hits = findAll(tree, q("""{"role":"TextView","path":[{"role":"RecyclerView"},{"name":"肯德基 月售 5000+"}]}"""))
        assertEquals(listOf("肯德基", "月售 5000+"), hits.map { it.name })
        assertTrue(findAll(tree, q("""{"role":"TextView","path":[{"name":"肯德基 月售 5000+"},{"role":"RecyclerView"}]}""")).isEmpty())
    }

    @Test fun documentOrderAndRootExcluded() {
        assertEquals(listOf("麦当劳", "月售 9999+", "肯德基", "月售 5000+"), findAll(tree, q("""{"role":"TextView"}""")).map { it.name })
        assertFalse(findAll(tree, q("{}")).any { it === tree })
    }

    @Test fun readSubtreeReadsItemsAndFromFields() {
        val spec = JSONObject("""{
          "itemQuery":{"role":"ViewGroup","path":[{"role":"RecyclerView"}]},
          "fields":{"title":{"read":"name","from":{"role":"TextView"}},"whole":{"read":"name"},"missing":{"read":"name","from":{"role":"Button"}}},
          "dedupeBy":"title"}""")
        assertEquals(
            listOf(
                mapOf("title" to "麦当劳", "whole" to "麦当劳 月售 9999+", "missing" to ""),
                mapOf("title" to "肯德基", "whole" to "肯德基 月售 5000+", "missing" to ""),
            ),
            readSubtree(tree, spec),
        )
    }

    @Test fun valueReadsTheTextNotTheDescription() {
        val t = n("FrameLayout", "", FakeNode("EditText", name = "地址", text = "公司"))
        val spec = JSONObject("""{"itemQuery":{"role":"EditText"},"fields":{"v":{"read":"value"}},"dedupeBy":"v"}""")
        assertEquals(listOf(mapOf("v" to "公司")), readSubtree(t, spec))
    }
}
```

`RefTableTest.kt`:

```kotlin
package com.streamapp.android.agent

import org.junit.Assert.*
import org.junit.Test

class RefTableTest {
    @Test fun refsResolveWithinTheirSnapshot() {
        val t = RefTable<String>()
        val refs = t.snapshot(listOf("a", "b"))
        assertEquals("b", t.resolve(refs[1]))
    }

    @Test fun anOlderSnapshotsRefIsStale() {
        val t = RefTable<String>()
        val old = t.snapshot(listOf("a"))
        t.snapshot(listOf("x"))
        val e = assertThrows(StaleRefException::class.java) { t.resolve(old[0]) }
        assertTrue(e.message!!.startsWith("stale-ref:"))
    }

    @Test fun garbageRefIsStaleNotACrash() {
        assertThrows(StaleRefException::class.java) { RefTable<String>().resolve("zzz") }
    }

    @Test fun refsAreUniqueAcrossSnapshots() {
        val t = RefTable<String>()
        assertNotEquals(t.snapshot(listOf("a"))[0], t.snapshot(listOf("a"))[0])
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`. Expected: compile FAIL.

- [ ] **Step 3: Implement**

`agent/UiNode.kt`:

```kotlin
package com.streamapp.android.agent

data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) {
    fun toMap(): Map<String, Int> = mapOf("x" to x, "y" to y, "w" to w, "h" to h)
    val centerX get() = x + w / 2
    val centerY get() = y + h / 2
}

/** One node of an accessibility tree, as the query engine sees it. The Android adapter builds
 *  these from `AccessibilityNodeInfo`; tests build them by hand. */
interface UiNode {
    /** Class simple name, e.g. `Button`. */
    val role: String
    /** Text if non-empty, else contentDescription, else "". */
    val name: String
    /** Full class name, e.g. `android.widget.Button`. */
    val className: String
    /** The node's text alone (an input's current value). */
    val text: String
    val rect: Rect
    val children: List<UiNode>
}
```

`agent/Query.kt`:

```kotlin
package com.streamapp.android.agent

import org.json.JSONObject

data class A11yQuery(
    val role: String? = null,
    val name: String? = null,
    val nameContains: String? = null,
    val className: String? = null,
    val path: List<A11yQuery>? = null,
) {
    companion object {
        fun from(o: JSONObject): A11yQuery {
            fun s(k: String) = if (o.has(k) && !o.isNull(k)) o.getString(k) else null
            val q = A11yQuery(
                role = s("role"),
                name = s("name"),
                nameContains = s("nameContains"),
                className = s("className"),
                path = o.optJSONArray("path")?.let { a -> (0 until a.length()).map { from(a.getJSONObject(it)) } },
            )
            require(q.name == null || q.nameContains == null) { "a11y query: name 与 nameContains 只能给一个（前者全等、后者包含）" }
            return q
        }
    }
}

private fun selfMatches(n: UiNode, q: A11yQuery): Boolean {
    if (q.role != null && n.role != q.role) return false
    if (q.name != null && n.name != q.name) return false
    if (q.nameContains != null && (n.name.isEmpty() || !n.name.contains(q.nameContains, ignoreCase = true))) return false
    if (q.className != null && n.className != q.className) return false
    return true
}

private fun pathMatches(ancestors: List<UiNode>, path: List<A11yQuery>?): Boolean {
    if (path.isNullOrEmpty()) return true
    var i = 0
    for (a in ancestors) {
        if (selfMatches(a, path[i])) {
            i++
            if (i == path.size) return true
        }
    }
    return false
}

/** Every descendant of [root] (root excluded) matching [q], in document order. */
fun findAll(root: UiNode, q: A11yQuery): List<UiNode> {
    val out = mutableListOf<UiNode>()
    fun walk(n: UiNode, ancestors: List<UiNode>) {
        for (c in n.children) {
            if (selfMatches(c, q) && pathMatches(ancestors, q.path)) out.add(c)
            walk(c, ancestors + c)
        }
    }
    walk(root, listOf(root))
    return out
}

/** Read items into rows. See the plan's Task 3 rules; `dedupeBy` is the backend's job. */
fun readSubtree(root: UiNode, spec: JSONObject): List<Map<String, String>> {
    val items = findAll(root, A11yQuery.from(spec.getJSONObject("itemQuery")))
    val fields = spec.getJSONObject("fields")
    return items.map { item ->
        fields.keys().asSequence().associateWith { field ->
            val f = fields.getJSONObject(field)
            val node = f.optJSONObject("from")?.let { findAll(item, A11yQuery.from(it)).firstOrNull() } ?: if (f.has("from")) null else item
            when {
                node == null -> ""
                f.getString("read") == "value" -> node.text
                else -> node.name
            }
        }
    }
}
```

`agent/RefTable.kt`:

```kotlin
package com.streamapp.android.agent

class StaleRefException(msg: String) : Exception(msg)

/**
 * Refs handed to the backend for one tree snapshot. A new snapshot invalidates every older ref,
 * so a ref used after the screen changed fails loudly instead of acting on whatever node the
 * system recycled into that slot.
 */
class RefTable<N> {
    var generation = 0
        private set
    private var nodes: List<N> = emptyList()

    fun snapshot(list: List<N>): List<String> {
        generation++
        nodes = list
        return list.indices.map { "g$generation-$it" }
    }

    fun resolve(ref: String): N {
        val m = Regex("^g(\\d+)-(\\d+)$").matchEntire(ref)
            ?: throw StaleRefException("stale-ref: $ref is not a ref this agent issued")
        val (gen, idx) = m.destructured
        if (gen.toInt() != generation) throw StaleRefException("stale-ref: $ref belongs to an older tree (now g$generation); find it again")
        return nodes.getOrNull(idx.toInt()) ?: throw StaleRefException("stale-ref: $ref is out of range")
    }
}
```

- [ ] **Step 4: Run; expect PASS**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add app/android/app/src
git -C <worktree> commit -m "feat(android): accessibility query engine and snapshot refs"
```

---

### Task 4: Device interface and op dispatcher (pure Kotlin)

**Files:**
- Create: `app/android/app/src/main/java/com/streamapp/android/agent/{Device.kt,Dispatcher.kt}`
- Test: `app/android/app/src/test/java/com/streamapp/android/agent/{DispatcherTest.kt,FakeDevice.kt}`

**Interfaces:**
- Consumes: Task 3's `UiNode`, `Rect`, `A11yQuery`, `findAll`, `readSubtree`, `RefTable`, `StaleRefException`.
- Produces:

```kotlin
data class WindowInfo(val id: String, val process: String, val title: String, val foreground: Boolean)
data class Shot(val jpeg: ByteArray, val window: Rect, val scale: Double)

interface Device {
    /** Throws `device-locked:` when a secure keyguard is up; wakes the screen otherwise. */
    fun ensureAwake()
    /** Throws `a11y-off:` when the accessibility service is not connected. */
    fun windows(): List<WindowInfo>
    /** Root of the window with this id, or null if it is gone. */
    fun windowRoot(windowId: String): UiNode?
    fun foregroundPackage(): String?
    /** `package/activityClass` of the foreground window, or `package` when the activity is unknown. */
    fun foregroundComponent(): String
    fun launch(packageName: String): Boolean
    fun click(node: UiNode): Boolean
    fun setText(node: UiNode, text: String): Boolean
    fun focusedInput(): UiNode?
    fun imeEnter(node: UiNode): Boolean
    fun tap(x: Int, y: Int, longPress: Boolean)
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long)
    fun globalBack(): Boolean
    fun globalHome(): Boolean
    fun screenshot(): Shot
    fun screenSize(): Rect
    fun status(text: String?)
    fun sleep(ms: Long)
}

class Dispatcher(private val device: Device) {
    fun dispatch(op: String, args: JSONObject): Any?   // throws AgentError / StaleRefException
}
class AgentError(msg: String) : Exception(msg)
val ANDROID_OPS: List<String>
```

Op semantics (the dispatcher holds `scope: String?`, the scoped window id, and one `RefTable<UiNode>`):

| op | args | behaviour | result |
|---|---|---|---|
| `windows` | — | `device.windows()` | list of `{id, process, title, foreground}` |
| `scopeWindow` | `match {process?, title?}` | resolve one window: `process` equals package (case-insensitive), `title` substring; 0 → `no-window-match: 没有窗口匹配 <match>`; >1 → `ambiguous-window: N 个窗口都匹配，请用 title 指名一个；候选：「t1」、「t2」`; sets `scope` | `{window}` |
| `focusApp` | `match {process}` | `device.launch(process)`; poll `foregroundPackage()` every 200 ms up to 5000 ms; on success scope to the foreground window of that package | `{ok}` |
| `find` | `query` | root = scoped window root (`no-scope: 还没限定搜索范围，先 scopeWindow / focusApp` if none; `no-window-match: 限定的窗口已经不在了` if its root is gone); `findAll`; new ref snapshot; when 0 hits **and** the scoped window is not foreground add `unbuilt: "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"` | `{elements:[{ref, role, name, className, rect}], unbuilt?}` |
| `invoke` | `ref`, `expect?` | `device.click(node)`; false → `action-failed: 节点不可点，换坐标点击` | `{via:'invoke'}` + `confirmed` if expect |
| `setValue` | `ref`, `text`, `expect?` | `device.setText(node, text)`; false → `not-editable: <ref> 不接受 ACTION_SET_TEXT` | `{via:'value'}` + confirmed |
| `type` | `text`, `expect?`, `deliver?` | `deliver=='message'` → `unsupported-deliver: 安卓没有消息投递，去掉 deliver`; node = `focusedInput()` or `not-editable: 没有获得焦点的输入框`; `setText(node, node.text + text)` | `{via:'value'}` + confirmed |
| `clearInput` | `deliver?` | same deliver rule; `setText(focusedInput, "")` | `{via:'value'}` + confirmed |
| `click` | `rect`, `button?`, `expect?`, `deliver?` | deliver rule; `left` → tap at centre; `right` → long press at centre; `middle` → `unsupported-key: 安卓没有中键` | `{via:'coords'}` + confirmed |
| `scroll` | `dir` up/down, `amount`, `expect?`, `deliver?` | deliver rule; area = scoped window root rect, else `screenSize()`; for each of `amount.coerceIn(1,10)` swipes: from 70% to 30% of the area's height for `down` (finger moves up), reversed for `up`, at the area's horizontal centre, 300 ms, then `sleep(150)` | `{via:'coords'}` + confirmed |
| `press` | `key`, `deliver?` | deliver rule; `Back` → `globalBack()`, `Home` → `globalHome()`, `Enter` → `imeEnter(focusedInput)`; anything else → `unsupported-key: <key>（安卓只认 Back / Home / Enter）` | `{via:'coords'}` |
| `readSubtree` | `spec` | needs scope (same errors as find); `readSubtree(root, spec)` | rows |
| `screenshot` | — | `device.screenshot()` | `{base64, window, scale}` |
| `url` | — | `device.foregroundComponent()` | string |
| `sleep` | `ms` | `device.sleep(ms)` | `null` |
| `status` | `text` (string or null) | `device.status(text)` | `{}` |
| other | — | `unknown op: <op>` | — |

`expect` handling (`settle`): when `args` has `expect`, sleep 300 ms, then run `findAll` with that query on the current scoped root (or, with no scope, on the foreground window's root) and add `confirmed: hits > 0`. Without `expect`, no `confirmed` key.

Every op except `status`, `sleep`, `windows` and `url` calls `device.ensureAwake()` first.
Missing args throw `missing arg: <key>`.

- [ ] **Step 1: Write the fake device and failing tests**

`FakeDevice.kt` (test source):

```kotlin
package com.streamapp.android.agent

class FakeDevice : Device {
    val log = mutableListOf<String>()
    var wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", true))
    var roots = mutableMapOf<String, UiNode>()
    var fg: String? = "com.sankuai.meituan"
    var locked = false
    var focused: UiNode? = null
    var clickable = true
    var launchMakesForeground: String? = null

    override fun ensureAwake() { if (locked) throw AgentError("device-locked: 锁屏有密码，Stream 解不开"); log += "awake" }
    override fun windows() = wins.toList()
    override fun windowRoot(windowId: String) = roots[windowId]
    override fun foregroundPackage() = fg
    override fun foregroundComponent() = (fg ?: "") + "/.Main"
    override fun launch(packageName: String): Boolean { log += "launch $packageName"; launchMakesForeground?.let { fg = it }; return true }
    override fun click(node: UiNode): Boolean { log += "click ${node.name}"; return clickable }
    override fun setText(node: UiNode, text: String): Boolean { log += "setText ${node.name}=$text"; return true }
    override fun focusedInput() = focused
    override fun imeEnter(node: UiNode): Boolean { log += "enter"; return true }
    override fun tap(x: Int, y: Int, longPress: Boolean) { log += "tap $x,$y long=$longPress" }
    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) { log += "swipe $x1,$y1->$x2,$y2" }
    override fun globalBack(): Boolean { log += "back"; return true }
    override fun globalHome(): Boolean { log += "home"; return true }
    override fun screenshot() = Shot(byteArrayOf(1, 2, 3), Rect(0, 0, 1080, 2400), 2.75)
    override fun screenSize() = Rect(0, 0, 1080, 2400)
    override fun status(text: String?) { log += "status $text" }
    override fun sleep(ms: Long) { log += "sleep $ms" }
}
```

`DispatcherTest.kt`:

```kotlin
package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class DispatcherTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private val search = FakeNode("Button", "搜索", rect = Rect(100, 200, 50, 40))
    private val input = FakeNode("EditText", "搜索商家或商品", text = "")

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = FakeNode("FrameLayout", children = listOf(input, search), rect = Rect(0, 0, 1080, 2400))
        d = Dispatcher(dev)
    }

    @Test fun declaresExactlyTheSixteenOps() {
        assertEquals(
            setOf("windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput", "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status"),
            ANDROID_OPS.toSet(),
        )
        assertEquals(16, ANDROID_OPS.size)
    }

    @Test fun findNeedsAScope() {
        val e = assertThrows(AgentError::class.java) { call("find", """{"query":{"role":"Button"}}""") }
        assertTrue(e.message!!.startsWith("no-scope:"))
    }

    @Test fun scopeThenFindThenInvoke() {
        call("scopeWindow", """{"match":{"process":"COM.SANKUAI.MEITUAN"}}""")
        val found = map(call("find", """{"query":{"role":"Button","name":"搜索"}}"""))
        @Suppress("UNCHECKED_CAST") val els = found["elements"] as List<Map<String, Any?>>
        assertEquals(1, els.size)
        assertEquals("Button", els[0]["role"])
        assertEquals(mapOf("x" to 100, "y" to 200, "w" to 50, "h" to 40), els[0]["rect"])
        assertFalse(found.containsKey("unbuilt"))
        val out = map(call("invoke", """{"ref":"${els[0]["ref"]}"}"""))
        assertEquals(mapOf("via" to "invoke"), out)
        assertTrue("click 搜索" in dev.log)
    }

    @Test fun aRefFromAnOlderFindIsStale() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        @Suppress("UNCHECKED_CAST") val ref = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        call("find", """{"query":{"role":"EditText"}}""")
        assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
    }

    @Test fun expectAddsConfirmedAndItsAbsenceDoesNot() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        @Suppress("UNCHECKED_CAST") val ref = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        assertEquals(mapOf("via" to "invoke", "confirmed" to true), map(call("invoke", """{"ref":"$ref","expect":{"role":"EditText"}}""")))
        @Suppress("UNCHECKED_CAST") val ref2 = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        assertEquals(mapOf("via" to "invoke", "confirmed" to false), map(call("invoke", """{"ref":"$ref2","expect":{"name":"不存在"}}""")))
    }

    @Test fun emptyResultInABackgroundWindowCarriesUnbuilt() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", false))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val r = map(call("find", """{"query":{"role":"Switch"}}"""))
        assertTrue((r["unbuilt"] as String).startsWith("a11y-unbuilt:"))
    }

    @Test fun ambiguousAndMissingWindows() {
        dev.wins = mutableListOf(WindowInfo("1", "p", "A", true), WindowInfo("2", "p", "B", false))
        assertTrue(assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"p"}}""") }.message!!.startsWith("ambiguous-window:"))
        assertTrue(assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"q"}}""") }.message!!.startsWith("no-window-match:"))
        assertEquals("2", map(call("scopeWindow", """{"match":{"process":"p","title":"B"}}"""))["window"].let { (it as Map<*, *>)["id"] })
    }

    @Test fun typeAppendsToTheFocusedInput() {
        dev.focused = FakeNode("EditText", "框", text = "麦")
        assertEquals(mapOf("via" to "value"), map(call("type", """{"text":"当劳"}""")))
        assertTrue("setText 框=麦当劳" in dev.log)
    }

    @Test fun messageDeliveryIsRefused() {
        assertTrue(assertThrows(AgentError::class.java) { call("type", """{"text":"x","deliver":"message"}""") }.message!!.startsWith("unsupported-deliver:"))
    }

    @Test fun clickTapsTheCentreAndRightIsLongPress() {
        call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}""")
        call("click", """{"rect":{"x":0,"y":0,"w":10,"h":10},"button":"right"}""")
        assertTrue("tap 125,220 long=false" in dev.log)
        assertTrue("tap 5,5 long=true" in dev.log)
    }

    @Test fun scrollDownSwipesUpOverTheScreen() {
        call("scroll", """{"dir":"down","amount":1}""")
        assertTrue("swipe 540,1680->540,720" in dev.log)
    }

    @Test fun pressMapsKeys() {
        call("press", """{"key":"Back"}""")
        call("press", """{"key":"Home"}""")
        assertEquals(listOf("back", "home"), dev.log.filter { it == "back" || it == "home" })
        assertTrue(assertThrows(AgentError::class.java) { call("press", """{"key":"Escape"}""") }.message!!.startsWith("unsupported-key:"))
    }

    @Test fun screenshotIsBase64Jpeg() {
        val r = map(call("screenshot"))
        assertEquals("AQID", r["base64"])
        assertEquals(mapOf("x" to 0, "y" to 0, "w" to 1080, "h" to 2400), r["window"])
        assertEquals(2.75, r["scale"])
    }

    @Test fun lockedDeviceFailsBeforeActing() {
        dev.locked = true
        assertTrue(assertThrows(AgentError::class.java) { call("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}""") }.message!!.startsWith("device-locked:"))
        assertFalse(dev.log.any { it.startsWith("tap") })
        assertEquals(emptyMap<String, Any?>(), map(call("status", """{"text":"下单中"}""")))
    }

    @Test fun focusAppWaitsForForeground() {
        dev.fg = "com.android.launcher"
        dev.launchMakesForeground = "me.ele"
        dev.wins = mutableListOf(WindowInfo("9", "me.ele", "饿了么", true))
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
    }

    @Test fun unknownOpAndMissingArg() {
        assertEquals("unknown op: readText", assertThrows(AgentError::class.java) { call("readText") }.message)
        assertEquals("missing arg: ref", assertThrows(AgentError::class.java) { call("invoke") }.message)
    }

    @Test fun urlAndSleep() {
        assertEquals("com.sankuai.meituan/.Main", call("url"))
        assertNull(call("sleep", """{"ms":20}"""))
        assertTrue("sleep 20" in dev.log)
    }
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`. Expected: compile FAIL.

- [ ] **Step 3: Implement `Device.kt` and `Dispatcher.kt`**

`Device.kt` holds `WindowInfo`, `Shot`, `Device` and `AgentError` exactly as in the Interfaces block. `Dispatcher.kt`:

```kotlin
package com.streamapp.android.agent

import org.json.JSONObject
import java.util.Base64

val ANDROID_OPS = listOf(
    "windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput",
    "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status",
)

private val NO_WAKE = setOf("status", "sleep", "windows", "url")

/**
 * The op table (see the plan's Task 4 table). One instance per connection; it owns the scoped
 * window and the current ref snapshot. Ops run one at a time, so it needs no locking.
 */
class Dispatcher(private val device: Device) {
    private var scope: String? = null
    private val refs = RefTable<UiNode>()

    fun dispatch(op: String, args: JSONObject): Any? {
        if (op !in ANDROID_OPS) throw AgentError("unknown op: $op")
        if (op !in NO_WAKE) device.ensureAwake()
        return when (op) {
            "windows" -> device.windows().map { it.toMap() }
            "scopeWindow" -> {
                val w = resolveWindow(obj(args, "match"))
                scope = w.id
                mapOf("window" to w.toMap())
            }
            "focusApp" -> mapOf("ok" to focusApp(str(obj(args, "match"), "process")))
            "find" -> find(A11yQuery.from(obj(args, "query")))
            "invoke" -> {
                val node = refs.resolve(str(args, "ref"))
                if (!device.click(node)) throw AgentError("action-failed: 节点不可点，换坐标点击")
                settle(args, "invoke")
            }
            "setValue" -> {
                val ref = str(args, "ref")
                if (!device.setText(refs.resolve(ref), str(args, "text"))) throw AgentError("not-editable: $ref 不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "type" -> {
                refuseMessage(args)
                val node = focused()
                if (!device.setText(node, node.text + str(args, "text"))) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "clearInput" -> {
                refuseMessage(args)
                if (!device.setText(focused(), "")) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "click" -> {
                refuseMessage(args)
                val r = rect(obj(args, "rect"))
                when (args.optString("button", "left")) {
                    "left" -> device.tap(r.centerX, r.centerY, longPress = false)
                    "right" -> device.tap(r.centerX, r.centerY, longPress = true)
                    else -> throw AgentError("unsupported-key: 安卓没有中键")
                }
                settle(args, "coords")
            }
            "scroll" -> {
                refuseMessage(args)
                scroll(str(args, "dir"), int(args, "amount"))
                settle(args, "coords")
            }
            "press" -> {
                refuseMessage(args)
                when (val key = str(args, "key")) {
                    "Back" -> device.globalBack()
                    "Home" -> device.globalHome()
                    "Enter" -> device.imeEnter(focused())
                    else -> throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
                mapOf("via" to "coords")
            }
            "readSubtree" -> readSubtree(scopedRoot(), obj(args, "spec"))
            "screenshot" -> device.screenshot().let {
                mapOf("base64" to Base64.getEncoder().encodeToString(it.jpeg), "window" to it.window.toMap(), "scale" to it.scale)
            }
            "url" -> device.foregroundComponent()
            "sleep" -> { device.sleep(long(args, "ms")); null }
            "status" -> { device.status(if (args.isNull("text")) null else args.optString("text")); emptyMap<String, Any?>() }
            else -> throw AgentError("unknown op: $op")
        }
    }

    private fun find(q: A11yQuery): Map<String, Any?> {
        val root = scopedRoot()
        val hits = findAll(root, q)
        val ids = refs.snapshot(hits)
        val els = hits.mapIndexed { i, n ->
            mapOf("ref" to ids[i], "role" to n.role, "name" to n.name, "className" to n.className, "rect" to n.rect.toMap())
        }
        val out = mutableMapOf<String, Any?>("elements" to els)
        if (hits.isEmpty() && device.windows().none { it.id == scope && it.foreground }) {
            out["unbuilt"] = "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"
        }
        return out
    }

    private fun focusApp(pkg: String): Boolean {
        device.launch(pkg)
        val deadline = System.currentTimeMillis() + 5_000
        while (true) {
            if (device.foregroundPackage() == pkg) {
                device.windows().firstOrNull { it.process == pkg && it.foreground }?.let { scope = it.id }
                return true
            }
            if (System.currentTimeMillis() >= deadline) return false
            device.sleep(200)
        }
    }

    private fun scroll(dir: String, amount: Int) {
        val area = scope?.let { device.windowRoot(it)?.rect } ?: device.screenSize()
        val x = area.centerX
        val hi = area.y + area.h * 7 / 10
        val lo = area.y + area.h * 3 / 10
        val (from, to) = when (dir) {
            "down" -> hi to lo
            "up" -> lo to hi
            else -> throw AgentError("missing arg: dir 必须是 up 或 down")
        }
        repeat(amount.coerceIn(1, 10)) {
            device.swipe(x, from, x, to, 300)
            device.sleep(150)
        }
    }

    private fun settle(args: JSONObject, via: String): Map<String, Any?> {
        val expect = args.optJSONObject("expect") ?: return mapOf("via" to via)
        device.sleep(300)
        val root = scope?.let { device.windowRoot(it) }
            ?: device.windows().firstOrNull { it.foreground }?.let { device.windowRoot(it.id) }
        val hit = root != null && findAll(root, A11yQuery.from(expect)).isNotEmpty()
        return mapOf("via" to via, "confirmed" to hit)
    }

    private fun resolveWindow(m: JSONObject): WindowInfo {
        val process = if (m.has("process")) m.getString("process") else null
        val title = if (m.has("title")) m.getString("title") else null
        val hits = device.windows().filter { w ->
            (process == null || w.process.equals(process, ignoreCase = true)) && (title == null || w.title.contains(title))
        }
        return when (hits.size) {
            0 -> throw AgentError("no-window-match: 没有窗口匹配 $m")
            1 -> hits[0]
            else -> throw AgentError("ambiguous-window: ${hits.size} 个窗口都匹配，请用 title 指名一个；候选：" + hits.joinToString("、") { "「${it.title}」" })
        }
    }

    private fun scopedRoot(): UiNode {
        val id = scope ?: throw AgentError("no-scope: 还没限定搜索范围，先 scopeWindow / focusApp")
        return device.windowRoot(id) ?: throw AgentError("no-window-match: 限定的窗口已经不在了，重新 scopeWindow")
    }

    private fun focused(): UiNode = device.focusedInput() ?: throw AgentError("not-editable: 没有获得焦点的输入框")

    private fun refuseMessage(args: JSONObject) {
        if (args.optString("deliver") == "message") throw AgentError("unsupported-deliver: 安卓没有消息投递，去掉 deliver")
    }

    private fun need(o: JSONObject, k: String) { if (!o.has(k) || o.isNull(k)) throw AgentError("missing arg: $k") }
    private fun obj(o: JSONObject, k: String): JSONObject { need(o, k); return o.getJSONObject(k) }
    private fun str(o: JSONObject, k: String): String { need(o, k); return o.getString(k) }
    private fun int(o: JSONObject, k: String): Int { need(o, k); return o.getInt(k) }
    private fun long(o: JSONObject, k: String): Long { need(o, k); return o.getLong(k) }
    private fun rect(o: JSONObject) = Rect(o.getInt("x"), o.getInt("y"), o.getInt("w"), o.getInt("h"))
}

fun WindowInfo.toMap(): Map<String, Any?> = mapOf("id" to id, "process" to process, "title" to title, "foreground" to foreground)
```

- [ ] **Step 4: Run; expect PASS**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add app/android/app/src
git -C <worktree> commit -m "feat(android): host op dispatcher over a device interface"
```

---

### Task 5: Accessibility service, Android device, overlay, wake

**Files:**
- Create: `app/android/app/src/main/java/com/streamapp/android/a11y/{StreamAccessibilityService.kt,NodeAdapter.kt,AndroidDevice.kt,Overlay.kt,WakeActivity.kt}`
- Create: `app/android/app/src/main/res/xml/accessibility_service.xml`
- Modify: `app/android/app/src/main/AndroidManifest.xml`, `app/android/app/src/main/res/values/strings.xml`

**Interfaces:**
- Consumes: Task 4's `Device`, `Shot`, `WindowInfo`, `AgentError`; Task 3's `UiNode`, `Rect`.
- Produces: `StreamAccessibilityService.instance: StreamAccessibilityService?` (null when the service is off); `StreamAccessibilityService.listener: ((Boolean) -> Unit)?` called on connect (true) and on unbind (false); `AndroidDevice(context: Context, onStop: () -> Unit) : Device`. Task 6 constructs `AndroidDevice` and uses `onStop` to send the abort frame.

This task is Android-bound and has no JVM tests. It must compile (`:app:assembleDebug`), and Task 8 checks it on the phone.

- [ ] **Step 1: Service declaration**

`res/xml/accessibility_service.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowsChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagRetrieveInteractiveWindows|flagReportViewIds|flagIncludeNotImportantViews"
    android:canRetrieveWindowContent="true"
    android:canPerformGestures="true"
    android:canTakeScreenshot="true"
    android:notificationTimeout="100"
    android:description="@string/a11y_description" />
```

Add to `strings.xml`: `<string name="a11y_description">让 Stream 按你写好的 recipe 在这台手机上点按、读屏。只在后端下发指令时动作，执行中屏幕顶部有提示条，可随时点「停止」。</string>`.

Manifest `<application>` gains:

```xml
        <service
            android:name=".a11y.StreamAccessibilityService"
            android:exported="true"
            android:label="@string/app_name"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data android:name="android.accessibilityservice" android:resource="@xml/accessibility_service" />
        </service>
        <activity
            android:name=".a11y.WakeActivity"
            android:exported="false"
            android:excludeFromRecents="true"
            android:showWhenLocked="true"
            android:turnScreenOn="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar" />
```

and the manifest gains `<uses-permission android:name="android.permission.WAKE_LOCK" />`. Package visibility: add `<queries><intent><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent></queries>` so `getLaunchIntentForPackage` can see the delivery apps on API 30+.

- [ ] **Step 2: `StreamAccessibilityService.kt`**

```kotlin
package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

/** The system-bound half. All op logic lives in `AndroidDevice`; this class only tracks the
 *  foreground component and publishes itself while it is connected. */
class StreamAccessibilityService : AccessibilityService() {
    @Volatile var lastComponent: String = ""
        private set

    override fun onServiceConnected() {
        instance = this
        listener?.invoke(true)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            val cls = event.className?.toString() ?: ""
            // Only activities name the screen; a Toast or a dialog class is not a place.
            lastComponent = if (cls.startsWith(pkg) || cls.contains("Activity")) "$pkg/$cls" else pkg
        }
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        listener?.invoke(false)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
            listener?.invoke(false)
        }
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: StreamAccessibilityService? = null
            private set
        @Volatile var listener: ((Boolean) -> Unit)? = null
    }
}
```

- [ ] **Step 3: `NodeAdapter.kt`**

```kotlin
package com.streamapp.android.a11y

import android.view.accessibility.AccessibilityNodeInfo
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode

/**
 * A snapshot of one `AccessibilityNodeInfo` subtree. Children are read once, when the snapshot
 * is built, so a query walks plain objects instead of making a binder call per child per query.
 * `info` stays attached for actions.
 */
class AndroidNode(val info: AccessibilityNodeInfo, override val children: List<UiNode>) : UiNode {
    override val className: String = info.className?.toString() ?: ""
    override val role: String = className.substringAfterLast('.')
    override val text: String = info.text?.toString() ?: ""
    override val name: String = text.ifEmpty { info.contentDescription?.toString() ?: "" }
    override val rect: Rect = android.graphics.Rect().let { r ->
        info.getBoundsInScreen(r)
        Rect(r.left, r.top, r.width(), r.height())
    }

    companion object {
        /** Depth cap guards against pathological trees (some apps nest hundreds deep). */
        fun snapshot(info: AccessibilityNodeInfo, depth: Int = 0): AndroidNode {
            val kids = if (depth >= 60) emptyList() else
                (0 until info.childCount).mapNotNull { info.getChild(it) }.map { snapshot(it, depth + 1) }
            return AndroidNode(info, kids)
        }
    }
}
```

- [ ] **Step 4: `Overlay.kt`**

```kotlin
package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The takeover banner (design D6): a `TYPE_ACCESSIBILITY_OVERLAY` strip at the top with the
 * current status text and a Stop button. Needs no extra permission. It shows on the first
 * non-null status and hides on `status(null)` or after 60 s without a status update.
 */
class Overlay(private val service: AccessibilityService, private val onStop: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var view: LinearLayout? = null
    private var label: TextView? = null
    private val hide = Runnable { remove() }

    fun show(text: String?) = main.post {
        main.removeCallbacks(hide)
        if (text == null) { remove(); return@post }
        if (view == null) add()
        label?.text = text
        main.postDelayed(hide, 60_000)
    }

    private fun add() {
        val wm = service.getSystemService(WindowManager::class.java)
        val tv = TextView(service).apply { setTextColor(Color.WHITE); textSize = 13f; setPadding(24, 12, 12, 12) }
        val stop = Button(service).apply {
            text = "停止"
            setOnClickListener { onStop(); remove() }
        }
        val bar = LinearLayout(service).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.argb(220, 30, 30, 30))
            addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(stop)
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        wm.addView(bar, lp)
        view = bar
        label = tv
    }

    private fun remove() {
        view?.let { service.getSystemService(WindowManager::class.java).removeView(it) }
        view = null
        label = null
    }
}
```

The banner is itself a window. `AndroidDevice.windows()` skips `TYPE_ACCESSIBILITY_OVERLAY` windows so it never shows up as a target.

- [ ] **Step 5: `WakeActivity.kt`**

```kotlin
package com.streamapp.android.a11y

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle

/** Shown for a moment to turn the screen on and dismiss a **non-secure** keyguard. The manifest
 *  sets showWhenLocked + turnScreenOn; `requestDismissKeyguard` needs an Activity. */
class WakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = finish()
            override fun onDismissError() = finish()
            override fun onDismissCancelled() = finish()
        })
    }
}
```

- [ ] **Step 6: `AndroidDevice.kt`**

```kotlin
package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.PowerManager
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.streamapp.android.agent.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * `Device` over the live accessibility service. Ops arrive on the relay's worker thread; the
 * gesture and screenshot callbacks are awaited with latches.
 */
class AndroidDevice(private val ctx: Context, private val onStop: () -> Unit) : Device {
    private var overlay: Overlay? = null
    private var overlayFor: StreamAccessibilityService? = null
    private var lastShotAt = 0L
    private var wake: PowerManager.WakeLock? = null

    private fun svc(): StreamAccessibilityService =
        StreamAccessibilityService.instance ?: throw AgentError("a11y-off: 无障碍服务没开，到手机的 设置 → 无障碍 → Stream 打开")

    override fun ensureAwake() {
        val km = ctx.getSystemService(KeyguardManager::class.java)
        val pm = ctx.getSystemService(PowerManager::class.java)
        if (km.isKeyguardLocked && km.isDeviceSecure) throw AgentError("device-locked: 锁屏有密码，Stream 解不开；这台手机要去掉锁屏密码才能无人值守")
        if (wake?.isHeld != true) {
            @Suppress("DEPRECATION")
            wake = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "stream:op")
        }
        // Held for 2 minutes after the latest op, then the screen may sleep again.
        wake?.acquire(120_000)
        if (!pm.isInteractive || km.isKeyguardLocked) {
            ctx.startActivity(Intent(ctx, WakeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val deadline = System.currentTimeMillis() + 3_000
            while ((km.isKeyguardLocked || !pm.isInteractive) && System.currentTimeMillis() < deadline) Thread.sleep(100)
            if (km.isKeyguardLocked) throw AgentError("device-locked: 锁屏没能解开")
        }
    }

    override fun windows(): List<WindowInfo> = svc().windows
        .filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY }
        .mapNotNull { w ->
            val root = w.root ?: return@mapNotNull null
            val pkg = root.packageName?.toString() ?: return@mapNotNull null
            WindowInfo(w.id.toString(), pkg, w.title?.toString() ?: pkg, w.isActive)
        }

    override fun windowRoot(windowId: String): UiNode? =
        svc().windows.firstOrNull { it.id.toString() == windowId }?.root?.let { AndroidNode.snapshot(it) }

    override fun foregroundPackage(): String? = svc().rootInActiveWindow?.packageName?.toString()

    override fun foregroundComponent(): String = svc().lastComponent.ifEmpty { foregroundPackage() ?: "" }

    override fun launch(packageName: String): Boolean {
        val i = ctx.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw AgentError("no-window-match: 手机上没装 $packageName")
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        return true
    }

    /** Click the node, or its nearest clickable ancestor: list rows often put the listener on a parent. */
    override fun click(node: UiNode): Boolean {
        var n: AccessibilityNodeInfo? = (node as AndroidNode).info
        while (n != null) {
            if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            n = n.parent
        }
        return false
    }

    override fun setText(node: UiNode, text: String): Boolean {
        val info = (node as AndroidNode).info
        val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        return info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    override fun focusedInput(): UiNode? {
        val f = svc().findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        // A hint is not a value: `type` appends to the current text, and must not append to "搜索商家".
        return if (f.isShowingHintText) object : UiNode by AndroidNode(f, emptyList()) { override val text = "" }
        else AndroidNode(f, emptyList())
    }

    override fun imeEnter(node: UiNode): Boolean =
        (node as? AndroidNode ?: return false).info.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)

    override fun tap(x: Int, y: Int, longPress: Boolean) =
        gesture(Path().apply { moveTo(x.toFloat(), y.toFloat()) }, if (longPress) 600 else 60)

    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) =
        gesture(Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }, durationMs)

    private fun gesture(path: Path, durationMs: Long) {
        val done = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        val sent = svc().dispatchGesture(g, object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(d: GestureDescription) { ok.set(true); done.countDown() }
            override fun onCancelled(d: GestureDescription) { done.countDown() }
        }, null)
        if (!sent || !done.await(durationMs + 3_000, TimeUnit.MILLISECONDS) || !ok.get()) {
            throw AgentError("gesture-failed: 系统没执行这次手势（被别的手势打断，或无障碍服务失去了手势权限）")
        }
    }

    override fun globalBack() = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    override fun globalHome() = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)

    /** `takeScreenshot` allows about one call per second; calls are spaced 1.1 s apart rather than failed. */
    override fun screenshot(): Shot {
        val wait = lastShotAt + 1_100 - System.currentTimeMillis()
        if (wait > 0) Thread.sleep(wait)
        val done = CountDownLatch(1)
        val out = AtomicReference<Any>()
        svc().takeScreenshot(Display.DEFAULT_DISPLAY, ctx.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(s: AccessibilityService.ScreenshotResult) { out.set(s); done.countDown() }
            override fun onFailure(code: Int) { out.set(code); done.countDown() }
        })
        lastShotAt = System.currentTimeMillis()
        if (!done.await(5, TimeUnit.SECONDS)) throw AgentError("gesture-failed: 截图超时")
        val r = out.get()
        if (r is Int) {
            if (r == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) throw AgentError("secure-window: 当前画面禁止截图（支付、密码页）")
            throw AgentError("gesture-failed: 截图失败，系统错误码 $r")
        }
        val shot = r as AccessibilityService.ScreenshotResult
        val hw = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
            ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
        val bmp = hw.copy(Bitmap.Config.ARGB_8888, false)
        shot.hardwareBuffer.close()
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        return Shot(bytes, Rect(0, 0, bmp.width, bmp.height), ctx.resources.displayMetrics.density.toDouble())
    }

    override fun screenSize(): Rect = ctx.resources.displayMetrics.let { Rect(0, 0, it.widthPixels, it.heightPixels) }

    override fun status(text: String?) {
        val s = StreamAccessibilityService.instance ?: return
        if (overlayFor !== s) { overlay = Overlay(s, onStop); overlayFor = s }
        overlay?.show(text)
    }

    override fun sleep(ms: Long) = Thread.sleep(ms.coerceIn(0, 30_000))
}
```

`ctx.resources.displayMetrics` gives the app window's size, which can exclude system bars; `screenSize` is only the scroll fallback area, so that is acceptable.

- [ ] **Step 7: Build**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:assembleDebug :app:testDebugUnitTest`. Expected: BUILD SUCCESSFUL, earlier tests still pass. Fix compile errors against the real SDK (for example, the `UiNode by` delegation in `focusedInput` may need an explicit wrapper class `HintlessNode(val inner: AndroidNode) : UiNode` that overrides `text`; if so, make `click`/`setText`/`imeEnter` unwrap it too).

- [ ] **Step 8: Commit**

```bash
git -C <worktree> add app/android/app/src
git -C <worktree> commit -m "feat(android): accessibility service, device actions, takeover banner and wake"
```

---

### Task 6: Relay connection in a foreground service

**Files:**
- Create: `app/android/app/src/main/java/com/streamapp/android/net/{RelayClient.kt,RelayService.kt}`
- Create: `app/android/app/src/main/java/com/streamapp/android/store/Credentials.kt`
- Test: `app/android/app/src/test/java/com/streamapp/android/net/RelayClientTest.kt`
- Modify: `AndroidManifest.xml`, `res/xml/network_security_config.xml` (create)

**Interfaces:**
- Consumes: `Frames`, `Backoff`, `wsUrl`, `DeviceState` (Task 2); `Dispatcher`, `ANDROID_OPS`, `AgentError` (Task 4); `AndroidDevice`, `StreamAccessibilityService` (Task 5).
- Produces:
  - `data class Creds(val backend: String, val deviceId: String, val token: String)`; `object Credentials { fun load(ctx): Creds?; fun save(ctx, c: Creds); fun clear(ctx) }`
  - `RelayClient(transport: Transport, handler: (String) -> String?, callbacks: RelayClient.Callbacks)`: transport-agnostic, unit-tested.
  - `RelayService.start(ctx)`, `RelayService.stop(ctx)`, and `RelayService.status: StateFlow`-free plain `@Volatile var statusText: String` plus `var onStatus: ((String) -> Unit)?` for the Activity.

The split: `RelayClient` decides what to send and when (hello first, state frames, requests to the worker, reconnect or stop by close code). `RelayService` provides an OkHttp transport, the worker thread, the notification and the device state.

```kotlin
interface Transport {
    fun open(url: String, protocols: List<String>, listener: Listener)
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed(code: Int, reason: String)
        fun onFailure(error: String)
    }
}
```

`RelayClient` rules:
- `start(creds)`: `transport.open(wsUrl(creds.backend), listOf("host-relay.v2", creds.token), …)`.
- `onOpen`: send `Frames.hello(deviceId, name, agentVersion, ANDROID_OPS)`, then `Frames.state(stateProvider())`; `backoff.reset()`; report `已连接`.
- `onMessage`: `Frames.request(text)` → null: ignore. Otherwise hand to `executor` (a single-thread executor injected as `(Runnable) -> Unit`); inside, run `dispatcher.dispatch` and send `Frames.reply` or `Frames.error(id, message)`. Any exception's message becomes the error; a null message becomes the class name.
- `onClosed(4003, …)`: call `callbacks.revoked(reason)`, do **not** reconnect.
- `onClosed(other)` / `onFailure`: report `连接断开，<n> 秒后重连`, schedule `start` after `backoff.next()` via the injected `schedule(delayMs, Runnable)`.
- `sendState()`: send `Frames.state(stateProvider())` if open.
- `abort()`: send `Frames.abort()` if open.
- `stop()`: cancel the scheduled reconnect, close with 1000.

- [ ] **Step 1: Write failing `RelayClientTest`**

```kotlin
package com.streamapp.android.net

import com.streamapp.android.agent.Device
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.FakeDevice
import com.streamapp.android.protocol.Backoff
import com.streamapp.android.protocol.DeviceState
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RelayClientTest {
    class FakeTransport : Transport {
        var listener: Transport.Listener? = null
        val sent = mutableListOf<String>()
        var opened = mutableListOf<Pair<String, List<String>>>()
        var closed: Int? = null
        override fun open(url: String, protocols: List<String>, listener: Transport.Listener) { opened += url to protocols; this.listener = listener }
        override fun send(text: String): Boolean { sent += text; return true }
        override fun close(code: Int, reason: String) { closed = code }
    }

    private val creds = Creds("http://10.9.8.21:8900", "android:abc", "tok")
    private val state = DeviceState(true, true, false, 90, false)
    private val scheduled = mutableListOf<Long>()
    private var revokedWith: String? = null

    private fun client(t: FakeTransport, dev: Device = FakeDevice()) = RelayClient(
        transport = t,
        dispatcher = { Dispatcher(dev) },
        name = "K80", agentVersion = "0.1.0",
        stateProvider = { state },
        executor = { it.run() },
        schedule = { ms, _ -> scheduled += ms },
        backoff = Backoff(jitter = { 0.0 }),
        callbacks = object : RelayClient.Callbacks {
            override fun status(text: String) {}
            override fun revoked(reason: String) { revokedWith = reason }
        },
    )

    @Test fun offersTheProtocolAndTokenThenSaysHelloAndState() {
        val t = FakeTransport()
        client(t).start(creds)
        assertEquals("ws://10.9.8.21:8900/api/host" to listOf("host-relay.v2", "tok"), t.opened.single())
        t.listener!!.onOpen()
        assertEquals("hello", JSONObject(t.sent[0]).getString("type"))
        assertEquals("android:abc", JSONObject(t.sent[0]).getString("deviceId"))
        assertEquals("state", JSONObject(t.sent[1]).getString("type"))
    }

    @Test fun answersRequestsAndErrors() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onOpen()
        t.listener!!.onMessage("""{"id":5,"op":"url"}""")
        t.listener!!.onMessage("""{"id":6,"op":"readText"}""")
        assertEquals("com.sankuai.meituan/.Main", JSONObject(t.sent[2]).getString("result"))
        assertEquals("unknown op: readText", JSONObject(t.sent[3]).getString("error"))
    }

    @Test fun ignoresFramesThatAreNotRequests() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onOpen()
        t.listener!!.onMessage("""{"type":"something"}""")
        assertEquals(2, t.sent.size)
    }

    @Test fun reconnectsWithBackoffButStopsOnRevoke() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        t.listener!!.onFailure("connection refused")
        t.listener!!.onClosed(1006, "")
        assertEquals(listOf(1000L, 2000L), scheduled)
        t.listener!!.onClosed(4003, "revoked")
        assertEquals("revoked", revokedWith)
        assertEquals(2, scheduled.size)
    }

    @Test fun aSuccessfulOpenResetsTheBackoff() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onFailure("x")
        t.listener!!.onOpen()
        t.listener!!.onClosed(1006, "")
        assertEquals(listOf(1000L, 1000L), scheduled)
    }

    @Test fun abortSendsTheAbortFrame() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        t.listener!!.onOpen()
        c.abort()
        assertEquals("abort", JSONObject(t.sent.last()).getString("type"))
    }
}
```

`FakeDevice` lives in the `agent` test package; it is visible to this test because both are in the same test source set.

- [ ] **Step 2: Run and watch it fail**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`. Expected: compile FAIL.

- [ ] **Step 3: Implement `RelayClient.kt`**

```kotlin
package com.streamapp.android.net

import com.streamapp.android.agent.ANDROID_OPS
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.protocol.Backoff
import com.streamapp.android.protocol.DeviceState
import com.streamapp.android.protocol.Frames
import com.streamapp.android.protocol.wsUrl

data class Creds(val backend: String, val deviceId: String, val token: String)

interface Transport {
    fun open(url: String, protocols: List<String>, listener: Listener)
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed(code: Int, reason: String)
        fun onFailure(error: String)
    }
}

/**
 * The connection's decisions, with no Android in it: hello first, then state; requests run one
 * at a time on [executor]; 4003 means the backend no longer accepts this phone, anything else
 * reconnects with backoff. A fresh [Dispatcher] per connection, so a reconnect never reuses
 * refs or a scope from before.
 */
class RelayClient(
    private val transport: Transport,
    private val dispatcher: () -> Dispatcher,
    private val name: String,
    private val agentVersion: String,
    private val stateProvider: () -> DeviceState,
    private val executor: (Runnable) -> Unit,
    private val schedule: (Long, Runnable) -> Unit,
    private val backoff: Backoff = Backoff(),
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        fun status(text: String)
        fun revoked(reason: String)
    }

    @Volatile private var open = false
    @Volatile private var stopped = false
    private var creds: Creds? = null
    private var current: Dispatcher? = null

    fun start(c: Creds) {
        creds = c
        stopped = false
        callbacks.status("正在连接 ${c.backend}")
        transport.open(wsUrl(c.backend), listOf(Frames.PROTOCOL, c.token), listener)
    }

    fun stop() {
        stopped = true
        open = false
        transport.close(1000, "stopped")
    }

    fun sendState() { if (open) transport.send(Frames.state(stateProvider())) }

    fun abort() { if (open) transport.send(Frames.abort()) }

    private val listener = object : Transport.Listener {
        override fun onOpen() {
            val c = creds ?: return
            open = true
            backoff.reset()
            current = dispatcher()
            transport.send(Frames.hello(c.deviceId, name, agentVersion, ANDROID_OPS))
            transport.send(Frames.state(stateProvider()))
            callbacks.status("已连接 ${c.backend}")
        }

        override fun onMessage(text: String) {
            val req = Frames.request(text) ?: return
            val d = current ?: return
            executor(Runnable {
                val reply = try {
                    Frames.reply(req.id, d.dispatch(req.op, req.args))
                } catch (e: Exception) {
                    Frames.error(req.id, e.message ?: e.javaClass.simpleName)
                }
                transport.send(reply)
            })
        }

        override fun onClosed(code: Int, reason: String) {
            open = false
            if (code == 4003) {
                stopped = true
                callbacks.revoked(reason)
                return
            }
            retry("连接断开（$code）")
        }

        override fun onFailure(error: String) {
            open = false
            retry("连不上：$error")
        }
    }

    private fun retry(why: String) {
        if (stopped) return
        val c = creds ?: return
        val ms = backoff.next()
        callbacks.status("$why，${ms / 1000} 秒后重连")
        schedule(ms, Runnable { if (!stopped) start(c) })
    }
}
```

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`. Expected: PASS.

- [ ] **Step 4: `Credentials.kt`** (Keystore-backed, design D4)

```kotlin
package com.streamapp.android.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.streamapp.android.net.Creds
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The pairing result. The token is encrypted with an AES key that never leaves Android Keystore. */
object Credentials {
    private const val ALIAS = "stream-device-token"
    private const val PREFS = "stream"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return gen.generateKey()
    }

    fun save(ctx: Context, c: Creds) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.doFinal(c.token.toByteArray())
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("backend", c.backend)
            .putString("deviceId", c.deviceId)
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("token", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
    }

    fun load(ctx: Context): Creds? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val backend = p.getString("backend", null) ?: return null
        val id = p.getString("deviceId", null) ?: return null
        val iv = Base64.decode(p.getString("iv", null) ?: return null, Base64.NO_WRAP)
        val sealed = Base64.decode(p.getString("token", null) ?: return null, Base64.NO_WRAP)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
            Creds(backend, id, String(cipher.doFinal(sealed)))
        } catch (_: Exception) {
            null // key gone (app data restored elsewhere): the user pairs again
        }
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
```

- [ ] **Step 5: `RelayService.kt`**

```kotlin
package com.streamapp.android.net

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import com.streamapp.android.BuildConfig
import com.streamapp.android.a11y.AndroidDevice
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.protocol.DeviceState
import com.streamapp.android.store.Credentials
import okhttp3.*
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Owns the connection while the app is paired (design D5): a foreground service, so the OS
 *  keeps it, with a persistent notification that says whether Stream is connected. */
class RelayService : Service() {
    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val timers = HandlerThread("stream-relay").apply { start() }
    private val handler by lazy { Handler(timers.looper) }
    private var client: RelayClient? = null
    private val heartbeat = object : Runnable {
        override fun run() { client?.sendState(); handler.postDelayed(this, 30_000) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTE_ID, note("正在连接"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        val creds = Credentials.load(this) ?: run { stopSelf(); return START_NOT_STICKY }
        if (client == null) {
            val device = AndroidDevice(this) { client?.abort() }
            client = RelayClient(
                transport = OkHttpTransport(http),
                dispatcher = { Dispatcher(device) },
                name = "${Build.MANUFACTURER} ${Build.MODEL}",
                agentVersion = BuildConfig.VERSION_NAME,
                stateProvider = ::state,
                executor = { worker.execute(it) },
                schedule = { ms, r -> handler.postDelayed(r, ms) },
                callbacks = object : RelayClient.Callbacks {
                    override fun status(text: String) = publish(text)
                    override fun revoked(reason: String) {
                        Credentials.clear(this@RelayService)
                        publish("这台手机已在电脑上被移除，请重新配对")
                        stopSelf()
                    }
                },
            )
            StreamAccessibilityService.listener = { client?.sendState() }
            client!!.start(creds)
            handler.postDelayed(heartbeat, 30_000)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        client?.stop()
        client = null
        StreamAccessibilityService.listener = null
        timers.quitSafely()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun state(): DeviceState {
        val pm = getSystemService(PowerManager::class.java)
        val km = getSystemService(KeyguardManager::class.java)
        val bat = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = bat?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = bat?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val plugged = (bat?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        return DeviceState(
            a11yEnabled = StreamAccessibilityService.instance != null,
            screenOn = pm.isInteractive,
            keyguardLocked = km.isKeyguardLocked,
            battery = if (level < 0) -1 else level * 100 / scale,
            charging = plugged,
        )
    }

    private fun publish(text: String) {
        statusText = text
        onStatus?.invoke(text)
        getSystemService(NotificationManager::class.java).notify(NOTE_ID, note(text))
    }

    private fun note(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Stream 连接", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, com.streamapp.android.ui.MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Stream")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL = "relay"
        private const val NOTE_ID = 1
        @Volatile var statusText: String = "未连接"
        @Volatile var onStatus: ((String) -> Unit)? = null

        fun start(ctx: Context) = ctx.startForegroundService(Intent(ctx, RelayService::class.java))
        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, RelayService::class.java))
    }
}

/** OkHttp's WebSocket behind [Transport]. OkHttp sends no Origin header, which `/api/host` requires. */
class OkHttpTransport(private val http: OkHttpClient) : Transport {
    private var ws: WebSocket? = null

    override fun open(url: String, protocols: List<String>, listener: Transport.Listener) {
        val req = Request.Builder().url(url).header("Sec-WebSocket-Protocol", protocols.joinToString(", ")).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                if (response?.code == 401) listener.onClosed(4003, "unauthorized") else listener.onFailure(t.message ?: t.javaClass.simpleName)
        })
    }

    override fun send(text: String) = ws?.send(text) ?: false
    override fun close(code: Int, reason: String) { ws?.close(code, reason) }
}
```

A 401 at upgrade means the token was revoked while the phone was offline, so it is treated like 4003.

- [ ] **Step 6: Manifest and cleartext**

`res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- The backend is on the LAN over plain http (http://10.9.8.21:8900); the token rides the
     WebSocket subprotocol header. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
```

Manifest additions: permissions `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `RECEIVE_BOOT_COMPLETED`; `android:networkSecurityConfig="@xml/network_security_config"` on `<application>`; and:

```xml
        <service
            android:name=".net.RelayService"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Keeps the paired connection to the user's Stream backend open so it can run the user's own automations." />
        </service>
```

- [ ] **Step 7: Build and test**

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest :app:assembleDebug`. Expected: PASS and BUILD SUCCESSFUL. (`MainActivity` does not exist yet; if the `PendingIntent` reference stops compilation, create an empty `ui/MainActivity.kt` `class MainActivity : android.app.Activity()` here and let Task 7 fill it.)

- [ ] **Step 8: Commit**

```bash
git -C <worktree> add app/android/app/src
git -C <worktree> commit -m "feat(android): foreground relay service with hello, state heartbeat and reconnect"
```

---

### Task 7: Pairing, setup checklist, boot start

**Files:**
- Create: `app/android/app/src/main/java/com/streamapp/android/net/Pairing.kt`
- Create/replace: `app/android/app/src/main/java/com/streamapp/android/ui/MainActivity.kt`
- Create: `app/android/app/src/main/java/com/streamapp/android/BootReceiver.kt`
- Test: `app/android/app/src/test/java/com/streamapp/android/net/PairingTest.kt`
- Modify: `AndroidManifest.xml`

**Interfaces:**
- Consumes: `PairPayload` (Task 2), `Creds`, `Credentials`, `RelayService` (Task 6), `StreamAccessibilityService` (Task 5).
- Produces: `Pairing.parseResponse(status: Int, body: String, backend: String): Result<Creds>`; `Pairing.pair(p: PairPayload, name: String, http: OkHttpClient): Result<Creds>` (network, not unit-tested).

- [ ] **Step 1: Failing test for response parsing**

```kotlin
package com.streamapp.android.net

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    @Test fun successGivesCredentials() {
        val c = Pairing.parseResponse(200, """{"deviceId":"android:1","deviceToken":"t"}""", "http://h:1").getOrThrow()
        assertEquals(Creds("http://h:1", "android:1", "t"), c)
    }

    @Test fun backendErrorTextIsShownAsIs() {
        val e = Pairing.parseResponse(403, """{"error":"配对码已过期"}""", "http://h:1").exceptionOrNull()!!
        assertEquals("配对码已过期", e.message)
    }

    @Test fun nonJsonBodyNamesTheStatus() {
        assertEquals("配对失败（HTTP 502）", Pairing.parseResponse(502, "<html>", "http://h:1").exceptionOrNull()!!.message)
    }
}
```

- [ ] **Step 2: Implement `Pairing.kt`**

```kotlin
package com.streamapp.android.net

import com.streamapp.android.protocol.PairPayload
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object Pairing {
    fun pair(p: PairPayload, name: String, http: OkHttpClient): Result<Creds> = try {
        val body = JSONObject().put("code", p.code).put("name", name).toString()
        val req = Request.Builder().url("${p.backend}/api/devices/pair").post(body.toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { r -> parseResponse(r.code, r.body?.string() ?: "", p.backend) }
    } catch (e: Exception) {
        Result.failure(Exception("连不上 ${p.backend}：${e.message}"))
    }

    fun parseResponse(status: Int, body: String, backend: String): Result<Creds> {
        val o = try { JSONObject(body) } catch (_: Exception) { null }
        if (status == 200 && o != null && o.has("deviceId") && o.has("deviceToken")) {
            return Result.success(Creds(backend, o.getString("deviceId"), o.getString("deviceToken")))
        }
        return Result.failure(Exception(o?.optString("error")?.takeIf { it.isNotEmpty() } ?: "配对失败（HTTP $status）"))
    }
}
```

Run: `scripts/qrun.sh app/android/gradlew -p app/android :app:testDebugUnitTest`. Expected: PASS.

- [ ] **Step 3: `MainActivity.kt`**

One screen built in code (no layout XML, no AppCompat). Sections, top to bottom:

1. **Status line**: `RelayService.statusText`, refreshed through `RelayService.onStatus` (post to the UI thread) and in `onResume`.
2. **Not paired**: buttons `扫码配对` and `手动输入`. Scan uses `com.google.zxing.integration.android.IntentIntegrator(this).setPrompt("扫描电脑上 Stream 设置 → 手机 里的二维码").setBeepEnabled(false).setOrientationLocked(true).initiateScan()`, with the result read in `onActivityResult` through `IntentIntegrator.parseActivityResult`. Manual entry is an `AlertDialog` with two `EditText`s (address, 6-digit code) feeding `PairPayload.manual`. Either path: `PairPayload.parse(text)` (null → toast `这不是 Stream 的配对码`), then `Pairing.pair(p, "${Build.MANUFACTURER} ${Build.MODEL}", OkHttpClient())` on a background thread; on success `Credentials.save` + `RelayService.start(this)`; on failure toast the message.
3. **Paired**: the backend URL and a `取消配对` button (`RelayService.stop`, `Credentials.clear`). Revoking on the computer is the main path; this is the phone-side escape hatch.
4. **Setup checklist** (design D5), each row a label, a ✓/✗ state, and a button that opens the right settings page:
   - 无障碍服务: ✓ when `StreamAccessibilityService.instance != null`; opens `Settings.ACTION_ACCESSIBILITY_SETTINGS`.
   - 通知权限 (API 33+): ✓ when `checkSelfPermission(POST_NOTIFICATIONS) == GRANTED`; button calls `requestPermissions`.
   - 电池不受限制: ✓ when `PowerManager.isIgnoringBatteryOptimizations(packageName)`; opens `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with `package:` uri.
   - 自启动 (shown only when `Build.MANUFACTURER` equals `Xiaomi` ignoring case): state unknown (no API), button opens `ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")`, falling back to `Settings.ACTION_APPLICATION_DETAILS_SETTINGS` when that throws `ActivityNotFoundException`.
   - 最近任务里锁定: text-only hint: `在最近任务里下拉 Stream 卡片加锁，防止被一键清理`.
   - 后台弹出界面 / 锁屏显示 (shown only on Xiaomi): state unknown (no public API), hint `HyperOS 默认不让后台应用弹出界面，Stream 唤醒屏幕和打开外卖 App 都要用到`, button opens `ComponentName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")` with extras `extra_pkgname` = packageName, falling back to `Settings.ACTION_APPLICATION_DETAILS_SETTINGS`.
   - 受限制的设置: text-only hint shown while the accessibility service is off: `如果无障碍里 Stream 是灰的点不动：到 应用信息 → 右上角 ⋮ → 允许受限制的设置，再回来打开`. (Android 13+ restricts accessibility for apps installed from a browser.)
   - 锁屏: ✓ when `!KeyguardManager.isDeviceSecure`; when ✗ the hint reads `有锁屏密码时 Stream 无法在无人时操作手机`; button opens `Settings.ACTION_SECURITY_SETTINGS`.

Refresh the checklist in `onResume`. When credentials exist, `onCreate` calls `RelayService.start(this)` so opening the app revives a killed service.

- [ ] **Step 4: `BootReceiver.kt`**

```kotlin
package com.streamapp.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.streamapp.android.net.RelayService
import com.streamapp.android.store.Credentials

/** Reconnect after a reboot. A phone that is not paired stays idle. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Credentials.load(ctx) != null) RelayService.start(ctx)
    }
}
```

- [ ] **Step 5: Manifest**

```xml
        <activity android:name=".ui.MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
        </receiver>
```

Also add `<uses-permission android:name="android.permission.CAMERA" />` (the scanner asks at runtime).

- [ ] **Step 6: Build**

Run: `scripts/qrun.sh scripts/build-android.sh`. Expected: tests pass, APK staged.

- [ ] **Step 7: Commit**

```bash
git -C <worktree> add app/android/app/src
git -C <worktree> commit -m "feat(android): QR and manual pairing, setup checklist, start on boot"
```

---

### Task 8: Docs, spec delta, live check on the REDMI K80

**Files:**
- Modify: `openspec/changes/android-phone-surface/specs/desktop-recipe-replay/spec.md` (or add `specs/android-agent/spec.md` if the change's spec layout puts host-agent requirements elsewhere; follow the existing files)
- Modify: the cookbook page that documents Stream Desktop and phone pairing (find it with `grep -rln "api/devices" docs/`); add an "Android app" section
- Modify: `docs/ARCHITECTURE.md` if it lists host agents
- Modify: `openspec/changes/android-phone-surface/tasks.md` §3

- [ ] **Step 1: Spec delta**

Add requirements, each with scenarios, for: the app declares exactly `ANDROID_OPS`; a stale ref fails as `stale-ref`; a secure keyguard fails as `device-locked` before any action; a `FLAG_SECURE` screen captures as `secure-window`; the state frame and the accessibility-off notification; the Stop button sends the abort frame; close code 4003 makes the app forget its token.

- [ ] **Step 2: Cookbook**

Document, in English and present tense: how to build (`scripts/qrun.sh scripts/build-android.sh`, toolchain paths), where the APK is served (`/panel/android/stream.apk`), how to pair, the op table with the Android mapping and the error prefixes, the local op endpoint `POST /api/devices/:id/ops` (this machine only) with one curl example, the setup checklist, and the rule that release builds are signed with the build machine's debug key (an APK built on another machine cannot update an installed one; uninstall first).

- [ ] **Step 3: Live check** (controller does this, with the user for the on-phone taps)

1. Land Tasks 1–7 on main, restart `stream-back.service` (respect the restart windows and running tasks in the project rules), run `scripts/qrun.sh scripts/build-android.sh` on the main checkout.
2. On the K80, open `http://10.9.8.21:8900/panel/android/stream.apk` in the browser and install. **User action:** allow the install, open Stream, scan the QR from 设置 → 手机, turn on the accessibility service, work through the checklist.
3. `curl -s localhost:8900/api/devices` shows the phone online with `state.a11yEnabled:true`.
4. Through `POST /api/devices/<id>/ops`: `windows`; `focusApp {match:{process:"com.taobao.taobao"}}`; `find {query:{role:"TextView"}}` (non-empty); `invoke` one element; `screenshot` (decode the base64 and look at it); `status {text:"测试中"}` shows the banner; tap 停止 on the phone and confirm the backend logs the abort; `press {key:"Home"}`.
5. Turn the accessibility service off on the phone: a `device.a11y-off` notification appears in the panel.
6. Revoke the phone in the panel: the app shows `这台手机已在电脑上被移除，请重新配对` and stops reconnecting.

Record what was observed (including any step that did not work) in the ledger and in the final report. Do not mark §3 done if a step failed.

- [ ] **Step 4: Tasks file and commit**

Tick §3 in `tasks.md` with the plan path `docs/superpowers/plans/2026-10-14-android-app.md`.

```bash
git -C <worktree> add openspec docs
git -C <worktree> commit -m "docs(android): the Stream Android app, its ops and the live check"
```
