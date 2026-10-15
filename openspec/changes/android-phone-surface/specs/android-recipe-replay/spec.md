## ADDED Requirements

### Requirement: The Android app declares exactly its op set

The Stream Android app SHALL declare, in its `hello`, exactly the ops it implements (`ANDROID_OPS`):
`windows`, `scopeWindow`, `focusApp`, `find`, `invoke`, `setValue`, `type`, `clearInput`, `click`,
`scroll`, `press`, `readSubtree`, `screenshot`, `url`, `sleep` and `status`. A request for any other
op SHALL fail with `unknown op: <op>` without acting on the phone.

#### Scenario: the hello carries the sixteen ops
- **WHEN** the app connects to `/api/host`
- **THEN** its `hello` has `platform:"android"` and `ops` equal to `ANDROID_OPS`

#### Scenario: an undeclared op is refused on the phone
- **WHEN** the app receives `readText`
- **THEN** it replies with the error `unknown op: readText` and performs no action

### Requirement: A ref acts only on the screen it was found on

A ref returned by `find` SHALL be bound to the scope, the scoped window and the screen-change
sequence it was found under. `invoke` and `setValue` SHALL fail with `stale-ref`, without acting,
when a later `find` replaced the snapshot, the scope or scoped window changed, the phone's window
set changed or another page came to the front, a view in that window scrolled over the node, or
the live node no longer has the class, bounds and label (for an input: class and bounds) recorded
at the find.

#### Scenario: a scroll between find and invoke stales the ref
- **WHEN** a list scrolls after `find` returned a ref to one of its rows, and `invoke` uses that ref
- **THEN** the reply is a `stale-ref` error and no click is performed

#### Scenario: a carousel elsewhere leaves the ref usable
- **WHEN** a banner carousel scrolls in another part of the page between `find` and `invoke`
- **THEN** the click is performed

#### Scenario: the runner retries a stale ref once
- **WHEN** an `invoke` step's ref comes back `stale-ref`
- **THEN** the desktop runner finds the target again and invokes the fresh ref, skips an `optional`
  step whose target is then gone, and fails the step only if the fresh ref is stale too

#### Scenario: a changed scope stales the ref
- **WHEN** `scopeWindow` selects another app after a `find`, and `setValue` uses a ref from that find
- **THEN** the reply is a `stale-ref` error and no text is set

#### Scenario: a still screen keeps the ref usable
- **WHEN** nothing changed on screen since the `find`
- **THEN** `setValue` with its ref succeeds, repeatedly

#### Scenario: Stream's own overlay does not stale a ref
- **WHEN** the takeover overlay appears, hides or passes touches through between `find` and `invoke`
- **THEN** the ref is still current

### Requirement: A secure keyguard fails before any action

Every op except `status`, `sleep`, `windows` and `url` SHALL check the keyguard first. A keyguard
with a PIN, pattern or password SHALL fail the op with `device-locked` before any gesture or
accessibility action. A non-secure keyguard or a dark screen SHALL be woken and dismissed; a wake the
OS blocks SHALL fail with `blocked-by-os`.

#### Scenario: a locked phone refuses a tap
- **WHEN** a `click` arrives while a secure keyguard is up
- **THEN** the reply is a `device-locked` error and no tap is dispatched

#### Scenario: status works on a locked phone
- **WHEN** a `status` arrives while a secure keyguard is up
- **THEN** it succeeds without waking the phone

### Requirement: A protected screen captures as secure-window

`screenshot` SHALL fail with `secure-window` when the system refuses the capture because a window is
`FLAG_SECURE`, and when the captured frame is entirely black.

#### Scenario: a payment page is not captured
- **WHEN** `screenshot` runs while a `FLAG_SECURE` window is in front
- **THEN** the reply is a `secure-window` error and no image is returned

### Requirement: The app reports its state and the panel warns when accessibility is off

The app SHALL send a `state` frame (`a11yEnabled`, `screenOn`, `keyguardLocked`, `battery`,
`charging`) right after its `hello`, every 30 seconds, and whenever the accessibility service
connects or disconnects. The backend SHALL keep the latest state on the device row, and SHALL emit a
`device.a11y-off` warning when a device first reports `a11yEnabled:false` or turns from enabled to
disabled, and not again while it stays disabled.

#### Scenario: turning accessibility off raises one warning
- **WHEN** the user turns Stream's accessibility service off on a connected phone
- **THEN** the panel shows one `device.a11y-off` notification for that phone

### Requirement: Stop cancels the phone's ops

The overlay's Stop button SHALL send `{type:"abort", reason:"phone-stop"}` to the backend, then cancel
every op the app holds: a queued op SHALL NOT run, and the running op SHALL stop before its next
device action, including after a wait or a wake, and fail with `aborted`; a device action already
under way completes. The connection SHALL stay open and ops received after the abort SHALL run
normally.

#### Scenario: Stop interrupts a scroll
- **WHEN** the user taps Stop after the first swipe of `scroll` with `amount:10`
- **THEN** no further swipe happens, the reply is an `aborted` error, and the next op succeeds

#### Scenario: Stop during a wake prevents the tap
- **WHEN** the user taps Stop while a `click` is waking the phone
- **THEN** the tap is not dispatched

### Requirement: Stop also ends the backend's run

On an abort the backend SHALL fail the pending and queued ops and the next op of the recipe session
that was running, with `HostAbortedByUser`. It SHALL send each request with the number of aborts it
has counted (`abortEpoch`), and once the app's abort frame is sent, the app SHALL refuse with
`aborted` a request whose count is older than that Stop. A request without the count SHALL NOT be
refused this way.

#### Scenario: Stop between two steps ends the recipe
- **WHEN** the user taps Stop while a recipe session is between two ops
- **THEN** the session's next op is not sent and the run fails with `HostAbortedByUser`

#### Scenario: a request crossing the abort on the wire is refused
- **WHEN** the backend sends a `click` before it receives the phone's abort
- **THEN** the phone replies `aborted` and does not tap

#### Scenario: Stop while reconnecting does not lock the connection
- **WHEN** the user taps Stop before the connection is open, so no abort frame is sent
- **THEN** requests on that connection run normally

### Requirement: An op dies with its connection

A closing, closed or replaced connection, a revoke and the service stopping SHALL cancel every op
the app holds the same way Stop does, so no op starts another device action once the connection
that sent it is going away.

#### Scenario: a queued op dies with its connection
- **WHEN** a `click` is queued, the connection drops and a new connection opens before it runs
- **THEN** the click never reaches the phone

### Requirement: Close code 4003 forgets the token

When the backend closes the connection with code 4003, or answers the upgrade with 401, the app SHALL
delete its stored credential, stop reconnecting and ask the user to pair again. Any other close or
failure SHALL reconnect with backoff.

#### Scenario: a revoked phone asks to pair again
- **WHEN** the phone is revoked in the panel
- **THEN** the app shows `这台手机已在电脑上被移除，请重新配对`, forgets its token and does not reconnect
