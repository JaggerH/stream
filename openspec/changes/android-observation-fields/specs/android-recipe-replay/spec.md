## ADDED Requirements

### Requirement: find reports hint text, resource ids and editability

Each `find` element SHALL carry, when applicable: `hintText` (the node's hint text, only when
non-empty and the node is not a credential field), `isShowingHintText: true` (when the system
reports the hint as showing, or the node's text equals its hint), `viewId` (the node's resource id,
only when its resource part matches `^[A-Za-z0-9_]{4,}$` and contains a run of at least three
letters — obfuscated ids are left out) and `editable` (boolean). A `find` reply SHALL carry
`viewport: {width, height}` (the screen size). The capability manifest SHALL declare `ui.tree`
at `v: 3`.

#### Scenario: a search input showing its rotating hint
- **WHEN** the caller finds an input whose hint is "搜索商家" and whose text is empty
- **THEN** the element carries `hintText: "搜索商家"` and `isShowingHintText: true`

#### Scenario: an obfuscated resource id is not reported
- **WHEN** a node's resource id is `com.app:id/a1b2`
- **THEN** its element carries no `viewId`

#### Scenario: every find reply carries the screen size
- **WHEN** the caller runs `find` on a 1080×2400 screen
- **THEN** the reply carries `viewport: {width: 1080, height: 2400}`

### Requirement: windows reports kind, layer and the viewport

Each `windows` row SHALL carry `type` (one of `application`, `input`, `system`,
`accessibility_overlay`), `layer` (the window's z-order) and `viewport: {width, height}`.
Accessibility-overlay and input-method windows SHALL be listed, but their `foreground` SHALL be
false, and they SHALL NOT be scope targets (`scopeWindow` still scopes application and system
windows).

#### Scenario: the keyboard is listed as input
- **WHEN** the soft keyboard is up and the caller runs `windows`
- **THEN** the reply has a row with `type: "input"`, and no row with a non-application type has
  `foreground: true`

### Requirement: refs persist across reads

A ref returned by `find` SHALL stay valid until it fails its freshness check, even when later
`find` calls run in between. A later read SHALL reuse the same ref for the same control when the
identity key (role + identity name + viewId; an input's identity name is its hint text, its value
never is) is unique in both reads, the window is the same, no change event touched the element's
area since it was last seen, and its centre moved less than 15% of the screen's short edge; an
element inside a scrollable container additionally SHALL be in place (≤2%) and SHALL NOT be reused
after a scroll ran over it. Unrecognizable elements (no name, no viewId) and ambiguous matches
SHALL get a fresh ref. Ref numbers SHALL be monotonic and a retired ref number SHALL never be
reused.

#### Scenario: reading the same page twice keeps the refs
- **WHEN** the caller finds a button, then runs the same `find` again while the screen holds still
- **THEN** both replies carry the same ref for that button

#### Scenario: a later find of something else does not drop an older ref
- **WHEN** the caller finds a button, then finds an input, then invokes the button's ref while the
  screen holds still
- **THEN** the click is performed

### Requirement: stale errors carry a kind

A `stale-ref` error frame SHALL carry `code: "stale-ref"` and `semantics: {kind, ref}`, with
`kind` one of `snapshot_unknown` (the ref does not parse, or its number was never issued on this
connection), `ref_not_in_snapshot` (the number was issued but is no longer tracked), `ref_retired`
(the ref is tracked but its scope or window is no longer the current one) and `element_moved`
(scope and window are current but the node is gone from where it was found and relocation found
no unique match). The backend SHALL pass `code` and `semantics` through to embedders unchanged.

#### Scenario: a ref from before the app restarted
- **WHEN** the caller sends a ref that parses but was issued before the agent restarted
- **THEN** the error semantics carry `kind: "snapshot_unknown"`

#### Scenario: a scroll recycled the row
- **WHEN** a scroll ran over a ref's element and `invoke` uses the ref
- **THEN** the error semantics carry `kind: "element_moved"` and no click is performed

### Requirement: acting relocates a ref when the control is still recognizable

When a ref's node is no longer where it was found, the op SHALL first try to relocate it in a
fresh read of the scoped window: a unique node whose identity key matches, whose context (the
nearest named element before it in document order) is the same, and whose centre moved at most
15% of the screen's short edge. When the page is basically static (at least two elements uniquely
named in both reads, and at least 80% of them in place within 2%), the match SHALL also accept a
node with the same viewId at the same place whose name changed only in digits, or whose previous
name was a hint (a rotating prompt); a name that changed meaning (关注 → 已关注) SHALL NOT match.
On success the op proceeds on the relocated node and the reply carries `relocated: true`. An op
carrying an approval credential SHALL NOT relocate (the credential binds the screen it was
approved on), and the ask gate SHALL judge the node the action will actually land on.

#### Scenario: a countdown keeps the ref usable
- **WHEN** a button's label changed from "跳过 5" to "跳过 3" on an otherwise static page and
  `invoke` uses the ref found on "跳过 5"
- **THEN** the click is performed and the reply carries `relocated: true`

#### Scenario: a rotating search hint keeps the ref usable
- **WHEN** the scoped input's hint changed to another prompt on an otherwise static page and
  `setValue` uses the ref found under the old prompt
- **THEN** the text is set and the reply carries `relocated: true`

#### Scenario: a semantic rename does not relocate
- **WHEN** a button's label changed from "关注" to "已关注" and `invoke` uses the ref found on "关注"
- **THEN** the reply is a `stale-ref` error with `kind: "element_moved"` and no click is performed

#### Scenario: an approval credential never relocates
- **WHEN** an approved op is resent after the screen changed
- **THEN** the reply is `approval-stale`, the approval is not consumed, and no relocation re-binds
  the ref to another node

### Requirement: actions wait for the screen to settle

After a gated action (`click`, `invoke`, `setValue`, `type`, `clearInput`, `scroll`, `press`
including Back/Home/Enter), the phone SHALL wait until accessibility events have been quiet for
at least 450 ms and the tree fingerprint differs from the one before the action, and SHALL stop
waiting at 2.5 s at the latest (a page whose events never stop — a countdown, a progress bar —
does not hold the op past the cap). The reply SHALL carry `settled` (the quiet-and-changed
condition was met) and `changedDuringRead`, MAY carry `effect` (one of `done`, `small_change`,
`no_effect`, `place_changed`) classified from the fingerprints before and after, and, when the op
gave `expect`, `confirmed` judged after the wait.

#### Scenario: a navigation click settles
- **WHEN** a click opens another page (events stop, the tree changed)
- **THEN** the reply carries `settled: true` and `effect: "done"` before the 2.5 s cap

#### Scenario: a countdown page does not hold the op
- **WHEN** a click lands on a page whose countdown ticks every second
- **THEN** the reply arrives within 2.5 s with `changedDuringRead: true` and, when only digits
  changed, `effect: "small_change"`

#### Scenario: a click with no visible effect
- **WHEN** a click changes nothing on screen
- **THEN** the reply carries `settled: false`, `changedDuringRead: false` and `effect: "no_effect"`
