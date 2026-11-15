## ADDED Requirements

### Requirement: An app the user is using is not taken over

An op that can take over the screen SHALL fail as `app-in-use`, before any action, when the target
app is being used by the user at the execution point. **In use** is three facts at once:

1. the target app holds the foreground focus (the device's foreground package equals the target
   package, case-insensitive);
2. the accessibility service observed a user touch-interaction event (`TYPE_TOUCH_INTERACTION_START`)
   within the last 10 seconds;
3. that event was not produced by an injected gesture of the executor itself: touch events observed
   while the executor has a gesture in flight, and for 2 seconds after it completes, do not count.

The ops checked are `focusApp` (against the target package), `scopeWindow` (against the matched
window's process), and the action ops `click`/`invoke`/`setValue`/`type`/`clearInput`/`scroll`/`press`
(against the app the action would land on: the scoped app, else the foreground one). An absence of
fact (no touch interaction observed since the service connected, or the service cannot attribute
events) means **not in use** — the check fails open. Pure reads (`find`, `readSubtree`, `url`,
`screenshot`) never take the screen and are not checked. When it fires, the op executes nothing and
the error carries code `app-in-use` and a `semantics` receipt `{op, app: {id, name}}` (`name` is the
app title when known, else the package). Suspending, waiting and retrying are the caller's decision.

#### Scenario: focusApp refuses while the user is in the target app

- **WHEN** the user is browsing the target app in the foreground and touched the screen in the
  last 10 seconds, and the caller sends `focusApp` for that app
- **THEN** the reply is `{error: "app-in-use: …", code: "app-in-use", semantics: {op: "focusApp",
  app: {id: "<package>", name: "…"}}}` and nothing was launched

#### Scenario: recent input on another app does not block the target

- **WHEN** the user last touched the screen while another app was foreground (the target app is not
  in the foreground) and the caller sends `focusApp` for the target
- **THEN** the op runs and the app is launched

#### Scenario: an old touch does not block

- **WHEN** the target app is foreground but the last user touch was more than 10 seconds ago and
  the caller sends `focusApp` for it
- **THEN** the op runs

#### Scenario: an action op refuses mid-task while the user grabs the app

- **WHEN** a `click` lands on the app the caller scoped earlier, but the user touched the screen in
  the last 10 seconds and that touch was not the executor's own injected gesture
- **THEN** the reply is `app-in-use` with the receipt, and no tap was dispatched

#### Scenario: reads stay passive

- **WHEN** the caller sends `screenshot` (or `readSubtree`/`url`/`find`) while the user is using the
  foreground app
- **THEN** the op runs as usual — reads do not fail as `app-in-use`

## MODIFIED Requirements

### Requirement: The app reports its state and the panel warns when accessibility is off

The app SHALL send a `state` frame (`a11yEnabled`, `screenOn`, `keyguardLocked`, `battery`,
`charging`, and optionally `health`) right after its `hello`, every 30 seconds, and whenever the
accessibility service connects or disconnects. `health`, when present, is an object of device facts:

- `networkOk`: whether the OS has validated reachability on the device's default network
  (`NET_CAPABILITY_VALIDATED`);
- `clockSkewMs`: the device clock minus the backend clock in milliseconds (positive = the device is
  ahead), measured when the app received the backend's `{type: "time", serverTime}` frame and reused
  for the rest of that connection; absent until such a frame arrives on the connection. The backend
  clock is the backend process's own clock: the backend SHALL send the frame immediately after
  registering an android `hello`. On receiving it the app SHALL promptly send an updated `state`
  carrying the measured skew.

The device reports the facts and SHALL NOT judge them (no threshold, no verdict). The backend SHALL
keep the latest state on the device row — `health` included — and SHALL emit a `device.a11y-off`
warning when a device first reports `a11yEnabled:false` or turns from enabled to disabled, and not
again while it stays disabled.

#### Scenario: turning accessibility off raises one warning

- **WHEN** the user turns Stream's accessibility service off on a connected phone
- **THEN** the panel shows one `device.a11y-off` notification for that phone

#### Scenario: the backend answers an android hello with its clock

- **WHEN** an android app sends its `hello` and the backend registers it
- **THEN** the backend sends `{type: "time", serverTime: <backend clock, ms>}` on that connection,
  and the next `state` from the app carries `health.clockSkewMs`

#### Scenario: a state before any time frame omits the skew

- **WHEN** the app sends its first `state` right after `hello`, before any `time` frame arrived
- **THEN** `health` carries `networkOk` and no `clockSkewMs`
