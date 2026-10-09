# ENGINE.md — Engine, Perception Vocabulary, and State Diagrams

Recipe describes **what to do** (steps) and **what to read** (observers); this document defines three other things orthogonal to it:

- **What makes an action take effect** — **Engine** (axis B, §2)
- **What vocabulary a recipe uses to perceive the controlled object** — **Perception Vocabulary** (axis A, §3)
- **How to know where you are when the path does not work** — **state diagrams** (§6–7)

The first two axes are the structural prerequisite that lets browsers, desktop applications, and pure vision connect to the same recipe runtime as **siblings**;
the third item is the skeleton of this runtime on **failure paths**: when `expect` misses, it only says "not expected", not "what it is",
and the state diagram is what completes that half-sentence.

- For Recipe concepts, orthogonal composition, and verification terminology, see `docs/PACKAGE.md` §2 (recipe slots) (this document is its companion: it promotes
  the `transport` that section only mentions in passing, and the `PageDriver` that exists only in code and has not entered the docs, into first-class concepts).
- For the business model (Channel / Stream / Provider / Source / Plugin), see `docs/ARCHITECTURE.md`.
- How the human-like harvest pipeline runs / how to observe it / how to fix it: `.claude/skills/write-recipe/SKILL.md` (the single source of truth).
- Code anchors are in `src/replay/`; §8 gives the concept → code mapping, and §9 explains which cells are still empty today.

> **The two axes are a conceptual contract, not code structure.** "How to find" and "how to act" are conceptually two independently replaceable axes,
> while in code they **have not been split yet**: the existing `PageDriver` is the **browser fused implementation** of this abstraction (§8).
> The seam location and the contracts on both sides are fixed here; the actual split should wait until a second vocabulary has validated the interface shape with real requirements.

---

## 1. Two Orthogonal Axes

A behavior that "locates a target on an interface and operates on it" consists of two **mutually independent** decisions:

| Axis | Name | Question answered | Values (target state) |
|---|---|---|---|
| **A** | **Perception Vocabulary** | What language to use to **perceive** the controlled object — for both locating and reading | `dom` / `a11y` / `pixel` |
| **B** | **Actuation Engine** | Who makes the action **take effect** on that interface | `ext-cdp` / `host-desktop` / `sandbox` |

**The two axes are independent**: the same `dom` vocabulary can run both on a browser engine and on any controlled surface that has a DOM; in the future the same
`host-desktop` engine can pair with the `a11y` vocabulary (read the accessibility tree) or the `pixel` vocabulary (pure-vision fallback). The vocabulary decides
"what to use to find and read"; the engine decides "what hand to use to act"; the two can be freely combined.

**Why the browser side does not reveal the difference between the two axes**: the browser's **vocabulary is always `dom`**, so "changing engines" never requires
"changing vocabulary"; the two axes can be pasted together into one string without exposing a flaw. **Desktop is the first integration where "axis A is also different"** — once it
comes in, the pasted-together axis can no longer hold. This is exactly why this document exists.

---

## 2. Axis B: Actuation Engine —— How to Act

Engine is **the set of engine-level action primitives**; it **does not know "elements", only coordinates and actions**:

```
interface Engine {
  click(rect, button?)          // Click once at the center of a box (or at its coordinates)
  drag(fromRect, toRect)
  scroll(px | rect, direction)
  moveMouse(x, y)
  type(text)                    // Input text into the current focus (keyboard -> must first take the screen)
  press(keys)                   // Chord / single key
  screenshot() → image
  sleep(ms)
}
```

These primitives are **independent of perception vocabulary**: scrolling is scrolling, clicking coordinates is clicking coordinates, and neither has anything to do with whether the controlled object is a browser. Therefore
a desktop Engine can implement them **as-is** — this is where "copy UI-TARS's control logic" truly lands.

**Engine implementations (target state)**:

| Engine | What it is | Status |
|---|---|---|
| `ext-cdp` | The user's own visible Chrome, driven through extension CDP. **The only harvest browser**: Stream does not ship a browser — the user's Chrome is already a real human browser, with no need to disguise, download, manage profiles, or handle fingerprints | Existing |
| `host-desktop` | The native **Stream Desktop** process on the host machine (executable file `stream-desktop`, a thin executor: enigo sends input + per-OS `A11yBackend`), driven by the backend `DesktopDriver` through the `/api/host` WS relay, operating the real mouse, keyboard, and screen. The binary is packaged as an npm subpackage per platform, and its lifecycle is held in-process by the Stream backend itself (`src/host-agent/mount.ts`, mounted under `capabilities/desktop/`) — no desktop shell needs to be opened (constraint: it must be in the user's interactive session, not a session-0 service) | Existing |
| `sandbox` | An isolated container with its own virtual desktop (cloud or local); what it controls is not the user's real environment | Target state |

**Takeover indication and abort hotkey for `host-desktop`**: When Stream Desktop is actually sending keyboard/mouse input to the screen
(`focusApp`/`click`/`moveMouse`/`scroll`/`type`), a click-through, non-focus-stealing banner appears at the top of the screen:
`AI 正在操作你的电脑 · <recipe id> · <当前步骤> (i/n) · 按 Ctrl+Alt+Esc 停止` ("AI is operating your computer · <recipe id> · <current step> (i/n) · press Ctrl+Alt+Esc to stop") (the step segment is written by the backend
with a `status` op on each step; it only contains the recipe id and step label, without parameters; `STREAM_DESKTOP_STATUS=0` turns it off).
Read-only ops, `ensureApp`/`invoke`/`setValue`, and `status` itself do not light it up — this signal has exactly one meaning:
**lit = do not touch the mouse right now**. When the hotkey is pressed, the agent sends the relay one frame
`{"type":"abort"}`, and the backend rejects all pending and queued ops with `HostAbortedByUser`; the whole recipe stops
there, and **no layer retries automatically** (`run_action_recipe` reports blocked, the harvest side declines, and neither records drift).
The decision is on the agent side (`app/host-agent/src/overlay.rs` is the platform-independent policy, and `overlay_win.rs` is the Windows
rendering layer), so if the backend crashes, the banner also disappears by itself.

> **The red line is unchanged**: Engine only automates **the user's own** browsing/desktop session, and never reverse-engineers or forges platform signatures. The correct answer when signatures/risk control
> blocks the path is "let the page/application compute it itself in the real environment", not rebuilding requests. See
> `project_legal_red_line_no_signature_forgery`.

> **Write effects expand with desktop**: the **effect axis** (read / write) from `2026-07-17-capability-normalization` establishes that "hot-plugged
> data recipes must not contain write operations" — engine access control only understands "who the request is sent to"; it does not understand "what this write does over there".
> The `host-desktop` Engine amplifies that bet by an order of magnitude: one desktop write operation can delete files or empty a netdisk, which is much harsher
> than a browser POST. The same rule only becomes stricter for desktop — **writes stay in code + release until there is a trust model with explicit authorization per recipe + package-origin signing**
> (a Marketplace-stage product problem).

> **UI-less sibling engines**: `kind:'http'` / `kind:'html'` (host sends requests directly, with no browser) belong to the same recipe runtime family as the
> UI engines in the table above, and are the two cheapest levels on the cost ladder — but they **do not have an actuation axis** (the only action
> is "send request"), and their perception vocabularies are JSON dot-path and CSS selector respectively. The two-axis picture in this document only describes
> engines with UI; the http engine's own capability surface (jar / compute hooks / probe object output) is defined in
> `internal design record` and `docs/PACKAGE.md` §2.3.

> **Note**: The browser Engine has one extra `goto(url)` primitive (URL navigation is a browser-specific concept). The desktop Engine's
> counterpart is "launch/focus an application"; the semantics differ, so they are not force-unified — `goto` is recorded as a private extension of the browser Engine,
> and does not enter the generic `Engine` interface.

---

## 3. Axis A: Perception Vocabulary —— What Vocabulary to Perceive With

This is where this document most needs to correct an existing misunderstanding: **"perception vocabulary" is not only responsible for "locating"; it is also responsible for "reading"**.

Because, in a recipe, "find a card to click" (a `locate`/`openTarget` step) and "read out a batch of data"
(an observer) use **the same vocabulary**: in the `dom` world, locate relies on CSS selector + href, and observer
also relies on `itemSelector` / `statePath` / href attributes. They are two uses of one axis and advance or retreat together. Therefore the accurate
definition of axis A is — **what language this recipe uses to perceive the controlled object**. It simultaneously constrains the following two components:

- **Locator**: parses a query into an operable target (for steps).
- **Observer**: reads structured data from the interface (for output; that is, the network/state/dom
  observer family in `PACKAGE.md` §2.2).

Three vocabularies:

| Vocabulary | What Locator uses to find | What Observer uses to read | When to use |
|---|---|---|---|
| `dom` | CSS selector / href / `__INITIAL_STATE__` | Intercept XHR body / read `window` state / read rendered DOM | Browser (all recipes today) |
| `a11y` | role / name / native class hints | Accessibility tree properties (value / text) | When a desktop application has an accessibility tree (main path on the cost ladder) |
| `pixel` | `see`: text on the screen (system OCR) / cached template / vision model reports coordinates; see `src/replay/desktop-see.ts` | Text boxes read by the same ladder | When there is no accessibility tree (custom-drawn interface, game, canvas, remote desktop) or when it misses and needs fallback |

**`a11y` is a platform-neutral vocabulary, with three OS backends**: Windows **UIA** (ControlType/Name/Invoke), macOS **AX**
(AXRole/AXTitle/AXPress), Linux **AT-SPI** (role/name/action). The concepts are shared (role + name + rect +
invoke), and Stream Desktop's per-OS backends translate neutral queries into their respective APIs — recipes only write role+name and remain as portable as possible.

These three levels are exactly the desktop mapping of the `onboard-source` cost ladder: **`a11y` is the DOM equivalent (cheap, deterministic, microsecond-level,
free)** and is the main path; `pixel` is the net that catches misses, not the first choice.

`pixel` itself is also a cost-ordered ladder. The recipe only writes one `see` sentence ("this text on the screen" or "what this icon looks like"),
and `resolveSee` tries in order. `via` has six values and five stages (`SeeVia`, `desktop-see.ts`):

| via | What this stage does |
|---|---|
| `a11y` | Treats `text` as the control name and searches once in the control tree |
| `screen` | Reads the screen and matches by text |
| `template` | If a template for this `see` exists in cache, searches for it on the window screenshot (NCC) |
| `model` | Overlays numbers on clickable boxes in the screenshot, and the vision model returns a number |
| `point` | **Last level**: the grounding model **reports absolute coordinates directly**. It has built-in out-of-bounds rejection — if it reports outside the window, treat it as no report |
| `pinned` | Not a stage, but an **artifact**: after the model reports coordinates, read the control tree back and solidify the landing point into a handle; next time, use it directly |

So the sentence "the model never touches coordinates" is **only true for the first four stages**: the `point` level is exactly the opposite; it asks the model to report coordinates —
because by this level, every previous "re-evaluable locator expression" has already failed, and the remaining choice is report coordinates or give up.
`pinned` exists precisely so this level **only happens once**: once coordinates land as a handle, the next run is no longer coordinate-based.

**Stop as soon as the first stage returns a box; the two model stages are last-resort, and the number of calls in one recipe run does not exceed the number of steps**; the `expect` path is not allowed to call
a model at all — checks must be deterministic, free, and repeatedly pollable. After a model hit, that region is cropped into a template and written to cache, so the next run lands in the `template` stage;
**templates grow on the user's own machine and belong only to that machine** (`<dataDir>/desktop-see/<sourceId>/`, with a cache key containing window size
and scale ratio), and are not distributed with packages. Which stage each step used is recorded in `via`; if a `template` hit does not fulfill `expect`, that template is invalidated. For why it is segmented this way, see
`internal design record` §5.

---

## 4. Core Contract: `find(query) → { rect, handle? }`

The two axes can be freely combined only because of a minimum common denominator that holds across all three vocabularies. The core operation of axis A is to resolve a query into
a target that axis B can operate on:

```
Locator.find(query) → { rect, handle? }
```

- **`rect` (required)**: the target's coordinate box on the screen/viewport (CSS px or physical px, normalized by the Engine's scaleFactor).
  All three vocabularies can provide it — `dom` has `getBoundingClientRect`, `a11y` has BoundingRectangle (UIA) / AXFrame
  (AX), and so on, while `pixel` returns a box directly. **Engine can act using only `rect`**: click its center, or drag from it to another rect. This is the baseline path for all
  vocabulary/engine combinations.
- **`handle` (optional)**: a native element handle, which is a **fast lane**. `dom` can provide a Playwright locator (for trusted
  element clicks, more accurate than coordinate clicks and with risk-control features closer to a real human); `a11y` can provide a control element (call its own Invoke/AXPress/
  action, bypassing coordinates); `pixel` has **no** handle — and "no handle" is exactly something the abstraction should let the implementation decide,
  not a flaw in the abstraction.

**Engine usage rule**: if there is a `handle`, take the handle fast lane; if not, degrade to `rect` coordinate actions. This rule lets
the browser preserve the fidelity of its existing "trusted element click" while also allowing pure vision (rect only) to run.

**The fast lane is not just "more accurate"; it decides whether this step needs to take the user's screen.** Coordinate actions (including keyboard `type`, which sends to
the current focused window) must first bring the target window to the foreground; the recipient of a handle action is the element itself, so it does not need the foreground and still
works on the lock screen. So typing has two paths: `a11y` `setValue` (UIA ValuePattern and similar, writing text into the element) takes the fast lane,
and Engine keyboard is the baseline. **Scheduled harvest should take the fast lane** — taking over the user's screen in the middle of the night is exactly what this path needs to avoid.
When a control does not accept Value pattern, it falls back to keyboard, but that must leave a trace (`DesktopRunOutcome.typedVia`); otherwise, "screen takeover" will
grow back unchanged in a form that cannot be investigated. See
`internal design record`.

Coordinate actions themselves have a third path: **send to the window** (`PostMessage` to hwnd, `input:"message"` in the recipe).
Like a handle, it has a recipient, so it does not take the foreground and still works on the lock screen — applications without a control tree (WeChat 4.x) need it to
run in the background. The cost is per-application compatibility (Electron applications mostly ignore it), so it is explicitly selected by the recipe, not an automatic fallback;
the contract is in `docs/PACKAGE.md` §2 "`input`", and measurements are in `internal design record`.

This is why "leaving a seam based on the abstraction definition" and "not changing code" are not in conflict: **the contract can be nailed down on paper**. It accommodates browsers,
UIA, and vision, and does not need a real machine first.

---

## 5. How a step runs in this model

Using "open a card in the feed" as the example, split the work into the two axes:

```
step: locate + click target card
  │
  ├─ Axis A (Locator, vocabulary=dom): find("a.note-card", identity=noteId)
  │      → { rect: card viewport box, handle: Playwright locator }
  │      (under the dom vocabulary, this step internally is the existing locateCard loop:
  │        readViewport sees who is in the viewport,
  │        findCard reads document Y for a specific card, fitIndexToY fits, then scrolls into place — all are private implementations of the dom vocabulary)
  │
  └─ Axis B (Engine): handle exists → trusted element click; absent → click(rect.center)
```

The same step on desktop: axis B changes to the `host-desktop` Engine, axis A changes to the Locator with the `a11y` vocabulary (`find` takes
role/name and returns control rect + element handle), while **the structure of the step itself does not change by a single word**. This is the value of the "seam".

---

## 6. State Graph — When You Cannot Get Through, How Do You Know Where You Are

The two axes above answer "how to look" and "how to act". This section answers the third question: **after acting, if the result is wrong, what is it?**

`goto(url)` only guarantees that the browser **went to an address**; it gives no guarantee about "where you arrived". Behind the same URL there can be at least:
not logged in, login wall, human verification, layout A / layout B, empty results, rate limiting, and silent redirects after the session expires. And most of these
**are not caused by your own action** — external forces (risk-control upgrades, A/B splitting, cookie expiry) can change them at any time, and the script cannot predict them.

An engine with only `expect` is equivalent to a **state machine with only two states**: right / wrong. A missed `expect` only says
"not expected"; **it does not say "what is it"** — the information is thrown away here, so the engine cannot find a path and can only fail.

### 6.1 Which Part Is Wired Today

**Only the "look back and recognize once" segment is wired** (`classifyByState`, `src/replay/state-classify.ts`). The complete
"recognize the state first, then find a path, then walk it" machine (`runToState`, `state-machine.ts`) has code and complete tests,
but **has no production caller** — writing a recipe is still writing `steps[]`, not drawing a state graph.

There are two wired callsites, both on the failure path in `recipe-runner.ts`:

```
A step's expect misses (StepExpectError)
   → recognize once through the state graph
       ├ recognize a dead end (cf/banned)        → stop immediately, flip outcome to challenged
       ├ recognize an obstacle with an escape hatch (cf/turnstile)
       │      → run the escape-hatch steps to clear it, then [redo this step], at most once per cell
       ├ cannot recognize (unknown) / same-group collision (ambiguous)
       │      → capture a scene and hand it to the intervention Broker (§6.7); this run's handling is unchanged
       └ ordinary state                         → do nothing
   → only then does the recipe's own retryFrom get a turn (rerun the whole segment)

After the whole run, blocked / drift is judged (including "not a single item" — it also takes the exception exit and must not bypass the following steps)
   → recognize once again; if a dead end or obstacle is recognized → flip to challenged
   → unknown / ambiguous likewise carries the scene and is handed to the intervention Broker
   → this step is ordered [before] loginCheck.wall detection: specific comes before generic
```

**Handing to the Broker is a side channel, not handling** (`handOffVerdict`): for scene capture (`captureBrowserScene`,
`src/replay/scene.ts`), each item is independent best-effort; if it cannot be captured, skip it; if it cannot be asked, do not throw —
**intervention must never cover up the real failure cause**. This run fails as it originally would; the proposal is left for the next run.

**Why it must be flipped to `challenged`**: judging `drift` makes `RepairLedger` **silently isolate** this Source after several consecutive runs,
and after that it returns `items:0 + errors:[]` — exactly the same as "the run succeeded, but it really found nothing"; judging `challenged` only
waits for one facility cooldown. The cost is extremely asymmetric, so prefer flipping.

**Obstacle clearing redoes "this step", not "the whole segment"**, and it does not violate "do not rerun within the same run": the obstacle's presence means the page
**has already been replaced**, so this step never acted on the target page and therefore has no side effect.

**The graph has three layers, assembled by facility** (spec §9.1; state is a site-level concern, so the key is facility rather than sourceId):

| Layer | Where | Who writes it | What it follows |
|---|---|---|---|
| Built-in global | `src/replay/states-builtin.ts` (three Cloudflare tiers) | us | code |
| Package-bundled | `packages/<id>/states.json` (a file in the recipe contract; see `docs/PACKAGE.md` §2.10) | recipe author | package distribution; npm package too |
| Locally learned | `<dataDir>/state-graphs/<facility>.json` | written when a proposal is accepted | data, **without touching the package directory** |

All three layers use the same `StateGraph` schema. The two local layers are composed by `StateGraphStore.graphFor(facility)`
(`state-graph-store.ts`); `session-recipe-executor.ts` fetches on demand by this recipe's `session.facility`,
passes it down through `RecipeRunOptions.stateGraph`, and then the runner `assembleGraph`s it together with the built-in global graph.
**Any id collision between any two layers always throws**, so nothing silently covers anything else — the symptom of being covered is "other Sources can all be recognized, only this one cannot",
and nowhere states the cause. When both layers are absent, `graphFor` truthfully returns `undefined`; it does not fill in an empty graph.

Each state in the learned layer has two additional source fields: `proposalId` and `acceptedAt` — it can be revoked, reviewed, and "promoted into the package" with one action;
they are stripped when assembled into the runner.

### 6.2 `identify()` Returns a Set of States, Not One

**A state is a partial description, not a snapshot.** A state only declares the few features it cares about; anything it does not declare can change without affecting
it. Therefore, it is **normal** for several states to hold on one screen at the same time — live verification (QQ): "the middle column has the search panel open" and
"the right side is a conversation with someone" are true at the same time, and both are correct.

**Conclusion: combinatorial explosion never exists.** Any mechanism introduced to eliminate combinatorial explosion (orthogonal state regions, state hierarchy,
XState-style state-composition libraries) is solving a problem that does not exist.

Real ambiguity only occurs **within the same group**. `group` is the human-written sentence "these cannot be true at the same time", a free-form string;
same-group states are mutually exclusive, and cross-group states may hold simultaneously. Only a same-group collision returns `ambiguous`, and the engine **never picks one from inside and returns it**: picking one
means the engine continues with a false belief, and it will not crash — it will perform every later step under the wrong assumption, all the way to
the cell that has side effects.

**Omitting `group` means falling into the default empty-string group, whose meaning is "mutually exclusive with everyone"** — this is the most dangerous
default. The built-in three CF tiers therefore all explicitly write `group: 'global/cf'`: without it, local states that also omit group
would be judged as colliding with them, while the CF interception page is **returned from the same origin**, with the URL unchanged, so a local state recognized by URL features
is still true on the banned page.

### 6.3 Features, Constraints, and `absent`

- **Features** answer "what is it" and are used to recognize states: URL patterns, DOM selectors, a11y queries, screen text, and a template image.
- **Constraints** answer "which one is it" and are used to adjudicate among multiple candidates: relative positional relationships belong to the positioning layer.

**There is one explicit exception: `where`** (§7.2). If the two are mixed into the same table, checks cannot be written, so this exception
must state its boundary clearly.

**`absent` is a required tier, not a supplement**: the most reliable check for "logged in" is often "the login button is gone".
Mutual exclusion also depends on it — in the three CF tiers, `js-challenge` must declare that "the Turnstile container **is absent**",
otherwise two tiers hit together on the challenge page.

**Background color is not a feature** — it follows the system theme and is not portable across machines. The type system cannot block it; rely on review.

### 6.4 Discriminativeness Gate

The check is not "can this feature describe the current page", but **"can it match only the current page"**. It is normal for two pages in the same app
to look alike.

`checkDiscriminative` takes the candidate's **entire set** of features and compares it against historical observations of known states; **one hit sends it back**. It looks at the whole set
rather than each feature individually because a single feature may be insufficient while two features together being unique is a perfectly valid form; it **only compares within the same group** because cross-group simultaneous truth
is valid.

Without this gate, the state library grows longer and blurrier until every state matches — and there is no way to trace which day it started breaking.

**Where observations come from**: every time `identify()` **successfully** recognizes a state, `classifyByState` records "the feature keys that were true at that moment"
through `onObserved` into the observation ledger (`ObservationLedger`, `<dataDir>/state-observations/<facility>.json`,
one file per facility, with the same key as the state graph; each facility keeps the latest 200 entries). Without the ledger, the gate is a door that is installed
but always open.

**The gate is installed before admission**: before `state` / `discriminator` proposals enter the review queue, they first pass two fixed-order `gateStateLike`
checks (`src/intervention/gate.ts`) — ① **true right now** (every feature of the candidate is true in the current scene;
a feature for which not even one part is true right now cannot even "describe the current page", so comparing it against historical observations is meaningless), ② **matches only the current page**
(`checkDiscriminative` compares the full feature set against historical observations of same-group states). Those that fail are still recorded in the run record with `rejection`
(humans need to see what the AI answered and why it was rejected), but they do not enter the review queue.

### 6.5 Two Call Frequencies, One Skeleton

| | `identify()` cost | `identifyPolicy` |
|---|---|---|
| Web | approximately free (the URL is a deterministic label present at every moment, and selector checks are local too) | `every-step` |
| Desktop | must read the screen; one 4K read takes 2.7–7.4s | **`on-failure`: do not recognize on the normal path; recognize only after `expect` misses** |

**The normal-path branch calls no model at all.** State recognition is a failure handler, not part of the main loop.
**The screen is read only once in one `identify`**: reading the screen once per text feature pays the same cost several times, and different reads
may not even see the same frame — that would make an AND check randomly false during animation.

### 6.6 Exit Conditions

There are four different things, and only splitting them makes them writable (`RunResult.outcome`):

| Exit | Check |
|---|---|
| **Success** `reached` | the target state is in the hit set from `identify` (it does not need to be the only hit) |
| **Stuck** `stuck` | nothing can be recognized, or something is recognized but there is no path to the target |
| **Looping** `looping` | the same state is visited for the 3rd time (choose 3 rather than 2: a legitimate "go home and walk again once" can make a state appear twice) |
| **Over budget** `budget` | any one of step count / wall-clock time / AI intervention count exceeds budget |

**A dead end (`deadEnd`) takes priority over all of the above**, and also over "collision": `ambiguous` means "I cannot distinguish these",
which is unrelated to "one of them cannot proceed", so dead ends must be swept first before reporting collision. Once a dead end is recognized, stop immediately instead of waiting for loop prevention to hit
three times or spending the budget — **distinguishing "wait a little longer and it will be fine" from "waiting longer is useless" is more valuable than recognizing "what this is"**.
Loop prevention is the last net, not a check.

**Looping is a new risk unique to state graphs**: a linear script cannot walk into a cycle, but a state graph can — and AI intervention makes it cycle with particular confidence.
So **state visit history must be recorded**; this is not optional observation, but a liveness guarantee.

Path finding is **BFS, deliberately not Dijkstra**: unless edge weights have a measured source (time / success rate), cost is invented,
and invented weights only make path selection impossible to explain.

### 6.7 AI Intervention Gate

**There is only one trigger: `expect` is not fulfilled** (including when the initial state is unknown). It does not exist on the normal path.
AI is asked only three questions (`RepairRunner`; implemented in `src/intervention/broker.ts`):

1. **Where is this** (nothing can be recognized) → return a set of features that can recognize the current state; after passing the two gates in §6.4, admit it to the library.
2. **What can distinguish these** (same-group collision) → return one piece of distinguishing evidence. This is the runtime counterpart of the discriminativeness gate.
3. **Where to click next** (recognized but with no exit) → return target + operation method. The scene
   element table is checked literally only by `name`; `selector` always passes; live `find()` verification is not done yet.

**The three questions have the same input**: the **scene screenshot** at the trigger moment + **element table** (on the browser side: page-list number/
tag/role/name/rectangle; on the desktop side: three source tiers, a11y / detector / text) + **known state vocabulary** (the existing
states on this graph and their features). The model can answer only with features **that can be evaluated on this side** — browser side `url` / `dom`, desktop side
`a11y` / `text` / `image` (allowlist `ALLOWED_FEATURE_KINDS`, `src/intervention/ask.ts`); the prompt only presents
these kinds, and parsing plus the admission gate each block once more. Why adjudicate by side: if a browser-side graph receives a `text` feature that cannot be evaluated there,
every later identify run for that facility throws, and the log has only one line, `状态诊断失败` ("state diagnosis failed"). The prefix of `stateId` is **facility**
(`xhs/…`, not the Source name `xhs-search/…`): if the model writes the wrong prefix, do not reject it; rewrite it, and record the rewrite in `gateNote`.

**A scene in background mode (`visibility: unattended`) has no screenshot**: Chrome does not draw frames for tabs that are not visible on screen;
the screenshot command fails by timeout at 1.5s on the extension side, leaving only text + element table in the scene — that is enough for the model to answer correctly (live verification 2026-09-11
xhs-search). Do not add "grab the foreground and take a screenshot" for it: background mode's promise is not to grab the screen.

**The product is a proposal, stored at `/api/interventions`**: each proposal carries the scene, the model's rationale, and the gate's verdict; it is reviewed on that Source's repair page under `源健康` ("Source Health") on the operations page
(the status words in the notification center and Channel configuration both deep-link there); **acceptance is the only action in this chain that changes the state graph**, and it changes only **the learned layer**
(`<dataDir>/state-graphs/<facility>.json`), never the package directory — package-bundled `states.json` is changed by the author.
For same-origin, same-fingerprint problems, check the database before asking (`fingerprint.ts`); rejected answers are also knowledge.

Three rules:

- **Fix only positioning, never assertions.** Assertions define the task; if AI changes them, it is issuing itself a graduation certificate.
- **The product is a proposal, not an automatic rewrite.**
- **Do not rerun within the same run.** Rerunning an action step = sending the same action twice, which is the most expensive mistake on a UI with side effects.

**Agent mode (repair session)**: when a Source is isolated by `RepairLedger`, if `ai-agent` is configured in settings (a launch command for one ACP agent),
the Broker opens one `kind:'repair'` run: start subprocess → `initialize` → `session/new` (cwd is the package directory's **working copy**
`<dataDir>/repair-work/<runId>/`, with `mcpServers` carrying our `/api/mcp`) → task brief → each `session/update` is written as an event.
The product is a `recipe` proposal: the candidate body must pass four validation cells (schema, version exactly +1, assertions byte-for-byte unchanged, optional live probe);
only when a human accepts it does validation run again and then atomically write back to `recipePath` itself; `shouldRun` sees the version increase and allows it through. The assertion lock watches
`steps[].expect` and `steps[].require`, `loginCheck`, top-level `assert`, `harvest.assert`, `output.assert`,
`observers[].input.assert`, and `meta.params_schema[*].required` — only if these places are byte-for-byte unchanged does it pass the gate; any change outside positioning is rejected.
The approval gate (`approval.ts`) allows only read operations and writes inside the copy; everything else enters `awaiting_confirmation` and waits for a human. Stop: `end_turn` + validated =
clean completion; `UNREPAIRABLE:` marker = cannot be repaired; stuck (same tool and same parameters 3 times / ABAB for 3 cycles / validation failures for 3 consecutive rounds) and the three gates
(12 rounds / 1.5 million tokens / 30 minutes, each renewed by `+6 rounds / +1 million tokens / +20 minutes`) = `paused`; when a human clicks `继续` ("continue"), each limit is raised by one tier.
On backend restart, live sessions are collected as `paused`; when a human clicks `恢复` ("resume"), continue with `session/load`.
**Only adapters that have been tested are marked `已验` ("verified")** (see `internal design record`);
the others are `按协议应当可用` ("should be usable according to the protocol"). Code: `src/intervention/{acp-client,repair-session,repair-manager,approval,stuck,gates,recipe-validation,task-book}.ts`.

### 6.8 Trace

Each step writes one JSON file at path `<root>/<sourceId slash replaced with underscore>/<runId>/NNN.json`.
The most central field is **`identified.matched` — which feature it was judged by**. Recording only "step 3 clicked (620, 613)" is
not traceable; it does not show **why** the engine thought that spot was right at the time.

When reading it, know two things: `identified.states` is **all** matched states, and `matched` is the
**union** of the features of those states (read it together with `states`; do not assume they all belong to `states[0]`); **the initial recognition does not write `outcome`**,
because forcibly writing `expectMet: false` would look exactly the same in the file as "the action was performed but not fulfilled".

### 6.9 Explicit Non-Goals

Each item is something rejected after measurement or collision; it is written here so it is not proposed again.

- **Layout / region splitting (layout analysis)**: recursive projection splitting (XY-cut) fails in live testing on real UI — the real
  inter-column gap is only 0.5–1.5 line heights (Discord 26px / 9px), and relaxing the threshold makes whitespace in the Slack message area masquerade as a
  1066px gap. Complexity also never comes only from regions (multiple unread counts on an avatar; splitting regions cannot solve that).
  The position dimension is carried by `where` in §7.2.
- **Orthogonal state regions / state hierarchy / XState-style state-composition libraries**: see the conclusion in §6.2.
- **Converging `expect` into state-graph `to`**: `expect` is still a binary check today. In desktop recipes it is tied to
  the whole set of `require`, `branch.when`, interrupt tables, `else`/`retry`/`abort`; changing it means changing the entire recipe contract and
  all existing recipes. **This is work for an independent plan**, not something to do in passing.

---

## 7. Visual Side: Where Features Come From When There Is No a11y

Use a11y when there is an a11y tree--not because it is more accurate, but because it is **cheap and replayable**. This section only covers the
APPs that have no a11y (such as QQ NT, which exposes no controls at all).

### 7.1 There Are Only Two Questions

| What to ask | `Feature` | How to answer |
|---|---|---|
| Whether this string is on the screen | `{ kind: 'text', text, where?, region?, absent? }` | Screen text table, via `pickTextDetailed` |
| Whether a small patch on the screen looks like this | `{ kind: 'image', png, minScore?, where?, absent? }` | NCC template match, via `find_image` |

`image` is for **cases text cannot answer**: buttons that only have icons and no labels, the highlight ring when an input gets focus,
and the unread badge on the corner of an avatar.

**The check is NCC (zero-mean normalized cross-correlation), not perceptual hashing.** NCC resists linear brightness/contrast changes and already has coarse-search
acceleration--it is the existing production implementation in the repository (`find_image` in `app/host-agent/src/see.rs`, also the same one used by the
`template` segment of the `see` ladder), so **do not write another fingerprint algorithm**. **It cannot survive light/dark theme switching** (that is color inversion,
not a linear change). When the theme changes, the reference image must be re-recorded. This is an inherent boundary of this tier, not the wrong algorithm.

**Text matching goes through `pickTextDetailed`, not `String.includes`.** It carries two things that are mandatory here:

- **Line stitching**: OCR segments each frame differently. The QQ line `进入全网搜索我的手机` ("enter whole-network search for my phone") is sometimes one whole segment and sometimes split into
  two segments. A segment-level check **never matches** on the frames where it is split, and the symptom is identical to "this thing really did not appear."
- **`where`**: see below.

**The recognition layer may refuse to answer; the location layer may not.** When the same string has multiple hits on screen, the check path treats it as "present" (the question is "is it present",
and multiple hits are precisely a stronger "present"); the action path must refuse--where to click must be unique. Moving the location layer's discipline into the recognition layer
would turn "there are two `发送` ("Send") entries on screen" into "there is no send."

### 7.2 `where`: Anchor + Direction + Distance

This copies UiPath's Anchor Base. On interfaces without a11y, this is the industry-standard approach; do not invent our own.

```jsonc
{ "kind": "text", "text": "$name",
  "where": { "anchor": { "text": "导入手机相册" }, "side": "left", "maxDist": 8 } }
```

It prevents mistaking the object in cases such as "the same name appears once in the conversation list and once in the title bar," where **the next cell is sending to the wrong person**.
Four checks:

- `side` has four choices: `left` / `right` / `above` / `below`. Left/right require the same row; above/below require the same column.
- The unit of `maxDist` is **multiples of the anchor box's width (left/right) or height (above/below)**, not pixels--resolution changes do not require rewriting it.
- The anchor is searched in the **full screen**, not inside the narrowed candidate set: the anchor often lands exactly on the row filtered out by `region`/`not`.
  If there are several anchors, **any one of them satisfying the condition is sufficient**.
- **`where` is a filter, not a selector**: it does not choose the best one, sort, or take the nearest. That is the location layer's job.
- **`where` is mutually exclusive with "line stitching"**: stitching lines puts the target and anchor into the same bounding box, so the directional relation disappears on the spot.

**If every feature in a state carries `where`, the state is written wrong**: "which interface am I on" should be answered by features without position;
`where` is only for pinning "which object am I interacting with."

**Do not confuse it with `see`**: `where` only exists on **state features**; the `See` type does not have this field. `see.not` /
`see.below` are narrowing tools in the location layer. They are not interchangeable.

### 7.3 Element Table: Stitch Three Source Tiers Into One

The Rust side (`stream-desktop`) stitches three sources into one element table. Each entry has only three fields: `rect` / `name?` /
`kind` (`a11y` | `detector` | `text`). Synthesis rules (`synthesize_elements`):

- **Containment names it**: a detector box enclosing a text span -> that text span becomes the name of this box.
- **A singleton enters the table**: a text span not enclosed by any box becomes its own `kind: text` entry.
- **Nested boxes fold into the same entry**--but **this cannot fold across tiers**. There are two rulers: within a tier, use overlap ratio (>0.7, keep the smaller one);
  across tiers, use IoU (>0.6). Synthesizing them into one ruler would eat clickable places: a toolbar reported by a11y enclosing a button reported by the detector
  has containment ratio constantly equal to 1.0, so under the same-tier rule that button would be merged away, **removing one clickable area**.

**There is no id, no fingerprint, and no relation edge.** The layout graph (`labeled-by` and that family) is not implemented; the
`where` in §7.2 is the implemented form of that part of its responsibility.

**The detector lives on the Rust side**, because the screenshot is already in Rust's hands; putting it in Node would require passing a full frame of pixels once. Use OmniParser's
`icon_detect` (only the detection half, **not** the caption half), with the ONNX Runtime CPU backend. It does not need a GPU
and does not need torch. Measured: `icon_detect.onnx` is 12.25MB, detection takes 34-150ms and is basically independent of resolution;
**the bottleneck is OCR** (2.7-7.4s once at 4K). The confidence threshold **must be 0.02**--at 0.05, the three icons on QQ's left side cannot be detected.
Scores in that tier are inherently low; this is not "looser is better."

Two engineering traps that must be stepped on have already been stepped on and fixed. Do not regress them when changing this area: **the input must be letterboxed, not directly resized**
(640x640 is square, desktop windows are wide, and direct squeezing flattens icons); **NMS must be done ourselves** (it is usually not stitched into the exported graph).

> The detector weights' license has not been decided yet (the ready-made ONNX uses the Ultralytics YOLOv8 base, AGPL, and it is already distributed together with
> `stream-desktop`); see `project planning record`.

### 7.4 The Split Between "Recognize It Locally" and "Have AI Say What It Is" Is Not Built Yet

> **Local code only answers "is this the same thing as last time"; AI answers "what is this."**
> The former can run an unlimited number of times for free; the latter is asked once per thing over its lifetime, and the answer is written into a `(state, fingerprint) -> function` dictionary.

Today **not a single line is implemented**. When this is actually built, missing any one of the following three premises makes the dictionary wrong:

1. **Fingerprints expire**: when the APP upgrades and redraws icons, the template no longer recognizes them. The failure mode is **not found** (fall back to asking AI once),
   not clicking the wrong thing--this is the safe failure direction. But it is **silent**, so there must be a signal such as "prompt for re-recording after N consecutive unrecognized attempts."
2. **The key must be `(state, fingerprint)`, not only the fingerprint.** The same fingerprint may mean different functions in different states--the back
   arrow looks the same everywhere. If this point is missed, the whole dictionary is wrong, and wrong very quietly.
3. **AI can guess wrong, and a wrong guess looks exactly like a right guess.** The first use of every new binding must have an `expect` fallback:
   if it does not materialize, **invalidate this binding** instead of retrying.

### 7.5 Persist "How to Find It Again," Not "Where It Is"

What is stored must be **a re-evaluable locator expression**: an a11y query, a text span (optionally with `where`), a template image,
or a selector. **Never store `(x, y)`.** Coordinates drift, and they do not report errors--they click some other thing,
which is the most expensive failure mode for this kind of system.

The final `point` tier of the `see` ladder (the model directly reports coordinates) is the only gap in this rule, and `pinned` exists precisely to
close that gap: as soon as coordinates land, the control tree is read back and solidified into a handle, so **on the next trip it is no longer coordinates**.

---

## 8. Current-State Comparison (Current Code vs Target-State Definition)

**Axis B (Engine) is already an object today: `Transport` (`src/replay/transport.ts`). Axis A (Perception)
has not been extracted yet--it is fused together with Engine location actions inside the browser-specific `PageDriver` (`src/replay/actions.ts`).**
The two axes have different implementation progress, so examine them separately.

### Axis B -- Already Objectified as `Transport`

CP1 of `2026-07-16-ext-cdp-first-class` collected the transport if/else logic scattered across three places (`session-recipe-executor` / `bootstrap`
resolveLauncher / makeLauncher) into one object. That object is the Engine axis:

```ts
interface Transport {                         // src/replay/transport.ts
  launcher
  driverFactory(rawPage) → PageDriver         // Creates the PageDriver for this transport
  relayFactory(rawPage)  → ObserverRelay?      // Creates the network-observation relay
  evaluate(rawPage, expr)                      // ← transport-independent primitive; `look` rides it
  screenshot(rawPage) / elementShot(rawPage, sel)  // ← transport-independent primitive; `shot` rides it
  url(rawPage)                                 // ← Ask the browser process, not the page (trust the engine, not the controlled surface)
  bringToFront(rawPage)                        // ← Only when the user explicitly requests it (focusFacilityTab)
}
```

`resolveTransport(deps)` produces only **one** implementation: the user's own Chrome through the extension relay (there is no second browser choice).
The seam is not invalidated by that--the session manager and executor
are **written against Transport**, and what they hold is never a Playwright page. `evaluate` / `screenshot` / `url` are
**Engine primitives unrelated to the perception vocabulary**--the three live-page read endpoints `look` / `act` / `shot` ride on top of them
(`session-manager.ts`), and `/api/facilities/:id/page*` gets results this way. **What ENGINE.md §2 says,
"Engine primitives are independent of vocabulary," is already a code fact here, not just a claim.**

A safety position is already embedded in `url()`: it reads the browser process's navigation record and **does not `evaluate('location.href')`**--"asking the page
is asking the suspect." The desktop Engine inherits this directly: its "which app/window am I in" must ask the OS window manager, not the controlled
application itself.

### Axis A -- Still Fused Inside the Browser-Specific `PageDriver`

The `PageDriver` created by `Transport.driverFactory` speaks `selector: string` everywhere, and `findCard` directly does
`href.match(/\/explore\/([0-9a-f]+)/)` internally--it is a **browser-specific** interface that assumes the controlled object has URLs, DOM, CSS
selectors, and hrefs. Classifying its methods by the two axes makes clear what is still fused:

| PageDriver method | Ownership | Notes |
|---|---|---|
| `scrollOnce` `moveMouse` `back` `sleep` `scrollProbe` `goto` | Axis B (Engine primitive) | Vocabulary-independent, and the desktop Engine can implement it as-is (`goto` excepted, because it is browser-private) |
| `openTarget` `type` `submit` `openItem` | **fused** (Engine action + dom location) | Actions whose parameters carry selectors--the future split point into `find(sel)->rect` + `engine.act(rect)` |
| `findCard` `readViewport` `exists` | Axis A (dom Locator) | All speak CSS selectors |
| `readItems` `readState` `evalJson` | Axis A (dom Observer) | The driver side of the network/state/dom observer family in `PACKAGE.md` §2.2 |

**This vocabulary is split into two layers**: the half that only recognizes selectors, pixels, and URLs (goto / click / type / scroll / exists...) lives in
`shared/browser-relay/page-driver.ts`, and the DSH browser plugin imports exactly that file on machines without the Stream backend;
the cells that understand cards, field tables, and recipes (`openItem`/`openTarget`/`readItems`/`readState`/`readViewport`/
`findCard`) are in the `PageDriver` in `src/replay/actions.ts` (it extends the former). Decide ownership before adding a verb.

**Two drivers, one vocabulary**: `makeExtPageDriver` (`browser-ext-drive.ts`, via raw CDP) is the one used for **harvest**;
`makePageDriver` (`browser-drive.ts`, via Playwright) only serves the **authoring flow**--`record validate` connects to the developer's
own debug-port Chrome (`connectOverCDP` in `browser.ts`), and harvest runtime does not go through it. Both produce **the same set of
selector-based methods**, meaning the same `dom` vocabulary speaks the same language.

### Two Heights of the Word "transport"

- **Object** `interface Transport` = the Engine axis, already done correctly: one seam; adding a transport is adding a
  `resolveTransport` branch, not changing three places.
- **Enum field** `transport?: ...` = a browser-limited projection of the Engine axis, and **no runtime code reads it**.
  Only the loading point (`recipe-store.ts`) uses it for gating: `'ext-cdp'` is accepted but ineffective (writing it is redundant), `'cloak'`
  **is rejected at load time** (it is an immediately fail-worthy surprise for a recipe that requires an unattended stealth browser to silently get the user-visible one),
  and other values are rejected as spelling errors. **New recipes should not write this field.**

Concept-to-code comparison:

| Concept in this document | Current code location | Current state |
|---|---|---|
| Engine (Axis B) | `Transport` (`src/replay/transport.ts`) | **Objectified**: single seam for driverFactory/evaluate/screenshot/url/relayFactory/bringToFront |
| `ext-cdp` Engine | `resolveTransport` -> `makeExtPageDriver` | Existing, and the only browser Engine |
| Perception Vocabulary (Axis A) | Selector-carrying methods in `PageDriver` + observer family | Only one kind, `dom`, hard-coded in method signatures and not extracted |
| `find -> {rect, handle?}` | Combination of `findCard` / `readViewport` / `openTarget` | dom-private; not abstracted into a unified contract |
| Engine selection enum | `transport?: ...` | Only gates at the loading point; nobody reads it at runtime; new recipes do not write it |

---

## 9. The Cells That Are Still Empty Today

**Desktop takes an independent path** (following the http/html precedent): the `host-desktop` Engine = the Rust
process in `app/host-agent/` (UIA/AX + enigo), driven through `/api/host` WS by `DesktopDriver` + the desktop runner
(`src/replay/desktop-*.ts`) + `kind:'desktop'` recipes. **It does not touch the browser `Transport`/`PageDriver`**
--so the two empty cells below **are not prerequisites for landing desktop**. Do not think they must be filled first.

- **Generalize `Transport` to non-browsers**: `resolveTransport` only produces browser `PageDriver`s. Bringing desktop in means adding a new branch
  that produces a `host-desktop` driver--the seam exists; this branch is missing.
- **Extract Axis A**: `PageDriver` speaks selectors everywhere, and the perception vocabulary is hard-coded as `dom`. To let `a11y` / `pixel` in,
  we need to refine "location/read" out of the selector language into a declarable vocab axis (splitting fused
  methods such as `openTarget` / `type` into `find(query)->{rect,handle?}` + `engine.act`).
- **Main loop of the state graph**: `runToState` still has **no production callsite** (see §6.1)--the only wiring today is the
  "look back once" segment on the failure path. The desktop-side `DesktopPerception` has been built and likewise is not wired.
- **Mac (AX) / Linux (AT-SPI) backends for `a11y`**: fill them when their targets appear; do not fabricate them in the abstract.

**Two shape questions only have answers when changing code** (they are not abstraction questions; answer them with real requirements): the concrete type of `handle`
(private to each vocabulary/engine; the abstraction only promises "present or absent"); whether the browser Engine should change click behavior--`openTarget`
today does a trusted `.click()` on a selector (location and click are fused; it never calculates coordinates), while coordinate clicks and element clicks
have different risk-control signatures. Whether to preserve the fast lane "if there is a handle, do trusted element click" is decided when changing the code.

**Temporary driving** (does not write recipes and does not produce items): the two tiers
`target: 'desktop'` and `'app:<进程>[/<标题>]'` (`进程` means "process"; `标题` means "title") for `cdp_look`/`cdp_shot`/`cdp_act`/`cdp_pages`, sharing the same verbs as the browser side and the same `expect`
for completion confirmation. Usage and traps are in the `drive-live-ui` skill.

---

## 10. Cross-References

- `docs/PACKAGE.md` §2 -- Recipe concepts, orthogonal composition (session/steps/observers/output/policy), and verification terms.
  This document fills in the Engine / Perception axes that it does not expand.
- `docs/ARCHITECTURE.md` -- Business model; the "Browser Recipe execution (session-backed T2)" section describes
  where recipes sit in the scheduling system.
- `.claude/skills/write-recipe/SKILL.md` -- the single source of truth for human-like harvest runtime experience.
- **Foundation specs for Axis B (Engine)**:
  - `internal design record` -- connects the
    transport abstraction on the harvest path (`Transport` seam starting point).
  - `internal design record` -- CP1
    Transport objectification, CP2 look/shot across transports, CP3 ext-cdp persistent interactive lane; the user's original words, "the two are completely interoperable in logic except that the terminal
    window and process differ; abstract an interface for both to reuse," are here.
  - `internal design record` -- why the browser Engine
    only has the user's own Chrome; background tabs **do not reject** trusted input (focus simulation catches it without forcing even one frame),
    so foreground is never a feasibility prerequisite; `visibility` only distinguishes `unattended` / `interactive` (who acts),
    and harvest never steals the screen.
- **Adjacent orthogonal axes**: the three axes in `internal design record`
  (expression code/data, distribution image/hot-drop, effect read/write) are the **capability governance** split; they are orthogonal to the two axes here and do not conflict;
  its effect axis is the constraint source for desktop write risk (see §2).
- Related memory: `project_legal_red_line_no_signature_forgery` (red line),
  `project_xhs_harvest_transport` (practical conclusion for which harvest path xhs uses).
