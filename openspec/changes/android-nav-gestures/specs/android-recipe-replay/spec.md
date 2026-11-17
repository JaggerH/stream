## ADDED Requirements

### Requirement: focusApp can open an app from its start page

`focusApp` SHALL accept an optional boolean `fresh`. With `fresh: true` the executor SHALL launch the
app at its launcher activity with its task cleared (`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK`),
and the reply SHALL be `{ok, fresh: true}`; when the app was already in front, it counts as arrived only
after the window set has changed. Without `fresh` (or `false`) the executor SHALL launch as before
(`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`, resuming the page the app was left on)
and reply `{ok}`. The capability manifest SHALL declare `app.launch` at `v: 2`.

#### Scenario: fresh launch
- **WHEN** the caller sends `focusApp {match: {process: P}, fresh: true}`
- **THEN** P opens at its launcher activity and the reply is `{ok: true, fresh: true}`

#### Scenario: default launch resumes
- **WHEN** the caller sends `focusApp {match: {process: P}}`
- **THEN** P returns to the page it was left on and the reply is `{ok: true}`

### Requirement: scroll prefers accessibility actions

`scroll` SHALL first look, in the scoped window (else the foreground window; never the host app's own
window), for the visible scrollable node not known to scroll horizontally with the largest on-screen
area, and scroll it with `ACTION_SCROLL_DOWN`/`ACTION_SCROLL_UP` when the node offers them, else
`ACTION_SCROLL_FORWARD`/`ACTION_SCROLL_BACKWARD`, one action per step. A refused later step SHALL end
the scroll with `end: true`. Only when no such node exists, or it refuses the first step, SHALL the
executor fall back to a swipe gesture over that node (else the window). The reply SHALL carry `method`
(`a11y` or `gesture`) and `steps`; `a11y: "refused"` marks a fallback after a refused first step.
The fallback swipe SHALL start inside the area's right edge band (48 dp in), hold for 100 ms before
lifting, and be refused as `action-failed` without dispatching anything when its length would be
under four touch slops.

#### Scenario: a list scrolls without a touch
- **WHEN** the scoped window holds a vertical list and the caller sends `scroll {dir: "down", amount: 2}`
- **THEN** the list receives two accessibility scroll actions, no gesture is dispatched, and the reply
  carries `method: "a11y", steps: 2`

#### Scenario: no scrollable node
- **WHEN** the window has no scrollable node
- **THEN** a swipe in the right edge band with a 100 ms hold is dispatched and the reply carries
  `method: "gesture"`

#### Scenario: too short to be a swipe
- **WHEN** the area is so short that the swipe would be under four touch slops
- **THEN** the reply is `action-failed` and no gesture was dispatched

### Requirement: windows lists the host app's own windows

`windows` SHALL include the windows of the app the executor runs in, each row marked `self: true` with
its `foreground` flag; other rows carry no `self` field. Those windows SHALL NOT be resolvable by
`scopeWindow` and SHALL NOT be the target of `find`, actions, `readSubtree` or screenshots' window
resolution.

#### Scenario: the host app is in front
- **WHEN** the host app is in front and the caller sends `windows`
- **THEN** the reply includes `{process: "<host package>", foreground: true, self: true, …}`

#### Scenario: the host app cannot be scoped
- **WHEN** the caller sends `scopeWindow {match: {process: "<host package>"}}`
- **THEN** the reply is `no-window-match`
