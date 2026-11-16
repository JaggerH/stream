## ADDED Requirements

### Requirement: The indicator can be replaced and stays out of screenshots

The library SHALL build the indicator through `StreamAgent.indicatorProvider` each time it needs one
and SHALL dispose of an indicator built by a provider that has since been replaced, or on an
accessibility service that has since been replaced. `StreamAgent.overlayIndicator` SHALL attach a
host-supplied view as a `TYPE_ACCESSIBILITY_OVERLAY` window. Before every screenshot the agent SHALL
ask the indicator to hide; when it does not, the agent SHALL black out the indicator's reported
bounds in the frame. After every screenshot, successful or not, the agent SHALL ask it to come back.

#### Scenario: a host indicator replaces the banner
- **WHEN** the host sets `indicatorProvider` while the default banner is showing, and the agent next shows a status
- **THEN** the banner is disposed and the host's indicator shows the status

#### Scenario: an indicator that cannot hide
- **WHEN** the indicator's `hideForCapture(true)` returns false and its bounds are a strip at the bottom
- **THEN** the screenshot covers that strip, and `hideForCapture(false)` is called afterwards

### Requirement: The occupancy hint is consulted

Before `focusApp`, `scopeWindow` and every action op, the agent SHALL ask `StreamAgent.occupancyHint`
about the target app and then about the app in front. A `true` SHALL fail the op as `app-in-use` naming
that app, before any action, with the same code and `semantics` as the agent's own refusal. `false`,
`null` or a hint that throws SHALL leave the decision to the agent's own check. With
`anyRecentTouchOccupies` on (default off), an app in front that the user touched within the last
10 seconds SHALL count as in use whatever the op targets.

#### Scenario: the host app is in front and busy
- **WHEN** the host app is in front, its hint answers `true` for its own package, and `focusApp` arrives for another app
- **THEN** the reply is `app-in-use` naming the host app and nothing is launched

#### Scenario: defaults keep current behaviour
- **WHEN** no hint is set and the policy is off, and the user recently touched an app other than the target
- **THEN** `focusApp` for the target runs

### Requirement: Stopping from the indicator notifies the host

The indicator's stop SHALL send the existing abort and then call `StreamAgent.userStopListener`; a
listener that throws SHALL NOT affect the abort.

#### Scenario: user stop
- **WHEN** the user taps the indicator's stop while a listener is set
- **THEN** the abort frame goes out first and the listener is called once
