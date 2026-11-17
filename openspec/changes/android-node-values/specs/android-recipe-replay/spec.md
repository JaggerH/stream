## ADDED Requirements

### Requirement: find reports control values

Each `find` element SHALL carry, when the node has them: `checked` (boolean; only for checkable nodes),
`range` (`{type, now, min, max}` from `rangeInfo`, `type` one of `int`, `float`, `percent`,
`indeterminate`; whole numbers as integers, others rounded to three decimals, a non-finite number
omitted) and `state` (the node's `stateDescription`). A node without them SHALL carry none of these
keys. An element without a value of its own SHALL carry `values`, the value-bearing controls of its
row, nearest first, each `{ref, role, name?, rect, checked?, range?, state?}` with a ref issued in the
same snapshot. The row SHALL be the element's own subtree, else the nearest of at most three
ancestors holding a value-bearing node with a non-empty area; the search SHALL NOT reach a scrollable
ancestor or the window root, an ancestor holding more than three such nodes SHALL yield nothing, and a
node whose value fields are all repeated by a node inside it SHALL be left out. The capability
manifest SHALL declare `ui.tree` at `v: 2`.

#### Scenario: a slider next to its title
- **WHEN** the caller finds `{name: "Font size"}` on Settings → Display size & text
- **THEN** the title element carries `values: [{role: "SeekBar", range: {type: "float", now: 1, min: 0, max: 6}, state: "100 %", ref, rect}]`

#### Scenario: a switch's own value
- **WHEN** the caller finds a switch
- **THEN** its element carries `checked` and, when the node has one, `state`

### Requirement: the foreground app is never an overlay or the keyboard

The foreground window SHALL be the active window, else the focused one, else the topmost application
window, among windows that are not accessibility overlays, input methods, the split-screen divider,
the magnification overlay, or windows of the host app other than its activities. `windows`
(`foreground`), `url` and the occupancy check SHALL use it.

#### Scenario: a focusable overlay takes input
- **WHEN** an accessibility overlay of the host has input focus over app P
- **THEN** the foreground package is P and P's window is `foreground: true` in `windows`

### Requirement: refs survive the keyboard and overlays

The window set behind ref validity SHALL exclude input-method windows and accessibility overlays. A
`TYPE_WINDOW_STATE_CHANGED` from an input method (by window type or package) or an accessibility
overlay, or one repeating the class of the previous such event from the same window, SHALL NOT
invalidate refs.

#### Scenario: typing with the keyboard
- **WHEN** a ref to an input was found, then the keyboard shows and hides
- **THEN** `setValue` on that ref succeeds without another `find`

#### Scenario: a focusable overlay closes
- **WHEN** an overlay above the page takes focus and closes again
- **THEN** refs found on the page are still current

### Requirement: touches on the agent's or host's own surfaces are not app use

A touch the system attributes to an accessibility overlay or a window of the host app, a touch the
indicator reports, and a touch the host reports through `StreamAgent.ownSurfaceTouched()` SHALL NOT
count as the user touching the app in front; the system's event and the report cancel each other
within one second, in either order.

#### Scenario: the user taps the indicator
- **WHEN** the user taps the indicator while app P is in front
- **THEN** a later op on P is not refused as `app-in-use` because of that tap
