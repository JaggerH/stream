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
window), for the visible scrollable nodes not known to scroll horizontally, and try them in order of
on-screen area, except that a scrollable nested inside another and covering at least half of its
on-screen area SHALL be tried before it (an inner list before the wrapper around it). A node is
scrolled with `ACTION_SCROLL_DOWN`/`ACTION_SCROLL_UP` when it offers them, else
`ACTION_SCROLL_FORWARD`/`ACTION_SCROLL_BACKWARD` when it offers those, one action per step; a node
offering neither for the direction counts as refusing. An accepted action SHALL count as a step only
when the visible content of the node's on-screen area changed afterwards. A candidate that refuses
its first step or accepts it without effect SHALL give way to the next one (at most three). A later
step that is refused or has no effect SHALL end the scroll with `end: true`. A candidate declaring
only the opposite direction's scroll action is at that end: when no candidate moved, the reply SHALL
be `method: "a11y", steps: 0, end: true` and no gesture SHALL be dispatched. Only when no candidate
exists or none moved on its first step SHALL the executor fall back to a swipe gesture over the first
candidate (else the window). The reply SHALL carry `method` (`a11y` or `gesture`) and `steps`;
`a11y: "no-effect"` marks a fallback after a candidate accepted its first step without anything
moving, `a11y: "refused"` one after every candidate refused.
The fallback swipe SHALL start inside the area's right edge band (48 dp in), hold for 100 ms before
lifting, and be refused as `action-failed` without dispatching anything when its length would be
under four touch slops.

#### Scenario: a list scrolls without a touch
- **WHEN** the scoped window holds a vertical list and the caller sends `scroll {dir: "down", amount: 2}`
- **THEN** the list receives two accessibility scroll actions, no gesture is dispatched, and the reply
  carries `method: "a11y", steps: 2`

#### Scenario: an outer wrapper around the list
- **WHEN** a collapsing-toolbar page wraps its list in an outer scroll view and the caller sends
  `scroll {dir: "down", amount: 1}`
- **THEN** the inner list receives the accessibility action and the reply carries `method: "a11y"`

#### Scenario: an accepted action that moves nothing
- **WHEN** every candidate accepts the first scroll action but the content on screen stays the same
- **THEN** a swipe is dispatched and the reply carries `method: "gesture", a11y: "no-effect"`

#### Scenario: a later step without effect
- **WHEN** the first step moved the list and the second accepted action leaves it where it was
- **THEN** the scroll stops with `steps: 1, end: true` and no gesture is dispatched

#### Scenario: already at the end
- **WHEN** the list declares only `ACTION_SCROLL_UP`/`BACKWARD` and the caller sends `scroll {dir: "down", amount: 10}`
- **THEN** the reply carries `method: "a11y", steps: 0, end: true` and no gesture is dispatched

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
