## Purpose

浏览器上回放 recipe 的语义：DOM observer 采集、登录与挑战态识别、blocked 结论在回放期与编写期的不同含义、拟人化只为任务服务。

## Requirements

### Requirement: DOM observer harvest

A browser recipe reads rendered feed cards through a `dom` observer, and the runner SHALL extract
matching cards at the observer's trigger point, deduplicate by the output's `dedupeBy` field, and
stop once `targetCount` deduplicated items are collected. The observer declares `itemSelector`,
per-field extraction, and a `trigger`. The DOM read SHALL run in-page, which is what makes it immune to request signing and
response-body encryption. A `dom` observer MAY declare `fallback: true`; a fallback observer's item
SHALL NOT overwrite an item another observer produced for the same identity, so it can only fill
what nothing richer produced.

A run that harvests nothing SHALL report `blocked`, naming the URL it ended on and the observers'
own diagnostics — an empty harvest is otherwise indistinguishable from a page that never loaded.
A recipe that declares `allowEmpty` SHALL instead report `ok`, because for a probe-shaped recipe
"the target is genuinely empty" is data, not a failure. A moved response or DOM shape SHALL report
`drift`, and `drift` SHALL be decided before the empty check so a relocated shape is never reported
as an empty target.

#### Scenario: Harvest accumulates to target across recycled nodes
- **WHEN** a recipe with a `dom` observer scrolls a virtualized feed that recycles scrolled-past nodes
- **THEN** per-trigger extraction deduplicates re-shown cards and stops at `targetCount` unique items

#### Scenario: Item selector never matches
- **WHEN** the `itemSelector` matches zero cards across the entire run and the recipe does not declare `allowEmpty`
- **THEN** the run reports `blocked` and names where it ended up and what the observers saw

#### Scenario: A fallback observer never downgrades a richer item
- **WHEN** a `fallback: true` dom observer and a network observer both produce the same identity
- **THEN** the merged result carries the network observer's item, not the fallback's

### Requirement: Login and challenge state detection

A recipe SHALL carry a `loggedIn` selector and a `wall` selector, and MAY carry a `challenge`
selector. The runner SHALL classify the session as LOGGED_IN, WALLED, CHALLENGED, or UNKNOWN,
probing `challenge` before `wall` and `wall` before `loggedIn`; an UNKNOWN verdict SHALL be
re-probed once after a short delay before it is accepted. The probe SHALL run at entry, and again
on the failure path before a run's `blocked`/`drift` verdict is final. On WALLED or CHALLENGED the
runner SHALL stop rather than keep working a page that is already refusing it.

`challenge` SHALL stay a separate signal from `wall`, because the two demand opposite things of the
user: WALLED means they must go log in, CHALLENGED means they must do nothing while the facility
waits out a cooldown. A `challenge` selector SHALL be absent on a clean, unchallenged page — a
selector that matches a permanently-mounted container makes every run report CHALLENGED.

Only a positive WALLED or CHALLENGED verdict SHALL overturn a `blocked`/`drift` outcome on the
failure path. UNKNOWN SHALL NOT overturn it: doing so would dress a real drift up as "wait a while"
and skip quarantine.

#### Scenario: Login wall at entry
- **WHEN** the wall selector is present at entry
- **THEN** the run returns `needsLogin` without executing any step

#### Scenario: Login wall appears after the actions
- **WHEN** a run would conclude `blocked` or `drift`, and the failure-path probe returns WALLED
- **THEN** the outcome is re-classified `needsLogin`, not left as drift

#### Scenario: A challenge is not a login prompt
- **WHEN** the challenge selector is present
- **THEN** the outcome is `challenged`, the facility takes a cooldown, and the user is not asked to log in

### Requirement: Blocked outcomes differ between replay and authoring

In replay a WALLED outcome SHALL surface as `needsLogin` on the source's health status WITHOUT
quarantine and WITHOUT recording drift. Both `needsLogin` and `challenged` SHALL make the facility
take a back-off: its hourly budget is drained and its cooldown is armed, so the next run does not go
straight back into the same refusal. A successful run SHALL clear the cooldown.

In authoring, `record validate` SHALL accept an `onWall` hook: on a wall it prompts the operator,
waits until they resolve it, and resumes; still-walled after a resume SHALL end the run as
`needsLogin` rather than waiting forever. Logging in itself is not Stream's job — harvesting rides
the user's own Chrome, so the operator logs in there like on any other site.

#### Scenario: A scheduled replay hits a wall
- **WHEN** a scheduled replay detects WALLED
- **THEN** the source is marked `needsLogin` on its health card, is neither quarantined nor recorded as drift, and its facility takes a cooldown

#### Scenario: Authoring hits a wall
- **WHEN** a `record validate` run detects WALLED and an `onWall` hook is supplied
- **THEN** it prompts the operator, resumes once they resolve it, and reports `needsLogin` if the wall is still up

### Requirement: Humanization serves the task

Pacing, cursor trajectory, scrolling and dwell SHALL serve the recipe's current task. The runner
SHALL NOT open cards the task did not ask for, and SHALL NOT make randomized browsing decisions as
camouflage.

A recipe SHALL NOT declare camouflage. `step.humanize` SHALL be rejected at load with an error
naming the replacement (explicit task steps plus pacing) — accepting the key and ignoring it would
silently change what a trusted browser recipe does on a real logged-in account.

Anti-ban control SHALL live at facility level, not inside a recipe: a per-facility rate limiter
declared in the facility's package (`stream.rateLimit`) gates every run of every recipe on that
facility, and a per-facility cooldown backs off after the site refuses. A recipe only knows itself,
while the site counts the whole facility — feed, search, detail and interaction all land on the same
budget. The evidence behind this split, including why timing rather than disguise is the thing that
governs bans, is recorded at the enforcement points in `src/replay/facility-rate-limit.ts` and
`src/replay/facility-cooldown.ts`.

#### Scenario: The task decides which card opens
- **WHEN** the frontend asks to open note A
- **THEN** the session locates and opens A only, with no probabilistic detour into other notes

#### Scenario: A recipe declaring camouflage is refused
- **WHEN** a recipe declares `step.humanize`
- **THEN** it fails to load, with an error naming what to use instead

#### Scenario: The facility budget gates every recipe on it
- **WHEN** feed, search and detail recipes of one facility run around the same time
- **THEN** they all draw on that facility's single rate budget, and a refusal drains it and arms the cooldown
