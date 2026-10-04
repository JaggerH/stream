## Purpose

在原生桌面窗口上回放 recipe：host-desktop Engine 的动作原语、按结构特征而非稳定 id 的 a11y 定位与观察、`kind:'desktop'` 走独立路径。

## Requirements

### Requirement: host-desktop Engine actuation primitives

The system SHALL provide a `host-desktop` Engine exposing coordinate- and keyboard-level actuation
primitives (`click`, `moveMouse`, `scroll`, `type`) plus `screenshot` and `focusApp`, all delegated
over a relay to a host agent running on the Windows host. These primitives SHALL be
perception-vocabulary-agnostic (they operate on coordinates/text, not on UI elements).

Every actuation primitive that changes UI state (`click`, `type`, `scroll`, `invoke`) SHALL accept an
optional post-action read-back (`expect`, an a11y query) and SHALL report whether the expected feature
appeared (`confirmed`) or not (`acted-unconfirmed`). Returning success on "the op was dispatched"
alone is NOT sufficient — at the OS layer a dispatched input is routinely not a delivered input
(foreground lock, a higher-integrity window on top, a locked desktop), and a call that cannot tell
those apart makes every conclusion built on it unsound.

Before dispatching any coordinate-level input, the Engine SHALL confirm the target window holds the
foreground, and SHALL fail loudly when it does not. Coordinate input is addressed to the screen, not
to a window: without this check the input lands on whatever happens to be on top.

#### Scenario: actuation op is delegated verbatim to the host agent
- **WHEN** the desktop runner invokes `click({x,y,w,h})` on the `host-desktop` Engine
- **THEN** exactly one relay message `{op:'click', args:{rect, button}}` is sent to the host agent and
  the coordinates are forwarded unchanged

#### Scenario: screenshot returns a decoded image or null
- **WHEN** the host agent answers a `screenshot` op with base64 image data
- **THEN** the driver returns it as a Buffer; and WHEN the agent returns no image, the driver returns
  `null` rather than throwing

#### Scenario: click reports whether it took effect
- **WHEN** the runner clicks with `expect: {role:'Text', name:'已保存'}` and the feature does not
  appear within the read-back window
- **THEN** the result is `acted-unconfirmed`, distinguishable from a confirmed click

#### Scenario: input is refused rather than misdirected
- **WHEN** the target window cannot be brought to the foreground
- **THEN** the Engine returns an error naming that cause and dispatches no input at all

#### Scenario: a locked desktop explains a refusal, it does not cause one
- **WHEN** the session is locked and a coordinate-level input is requested
- **THEN** the foreground check refuses it (no window can hold the foreground while locked) and the
  error names the lock screen as the blocker — rather than surfacing a raw input-injection failure
  for the caller to reverse-engineer, and rather than gating on a lock check of its own: measured
  2026-08-01, native `invoke` keeps working while locked, so gating on the lock would stop scheduled
  desktop harvesting every time the user walks away.

### Requirement: cross-container delegation over /api/host relay

Desktop recipe logic (recipe selection, action sequencing, mapping, drift classification) SHALL remain
in the backend. The `host-desktop` Engine SHALL reach the Windows host agent only through a `/api/host`
WS relay, mirroring the ext-cdp transport split. The relay dependency SHALL be a narrow interface so
tests can substitute a fake host agent.

#### Scenario: backend holds the logic, host agent is a thin executor
- **WHEN** a desktop recipe runs
- **THEN** the backend performs all locate/read/map/drift decisions and the host agent only executes
  primitive ops (find, readSubtree, invoke, click, type, scroll, screenshot, focusApp, url)

#### Scenario: a fake host agent satisfies the driver contract
- **WHEN** a test drives `DesktopDriver` over a fake relay that records ops and returns canned results
- **THEN** every driver method produces the specified wire message and returns the mapped result,
  with no real Windows dependency

### Requirement: a11y Locator by structural features, not stable id

The `a11y` Perception Vocabulary SHALL locate elements by neutral `role` and `name` plus an optional
per-platform class hint (the Windows UIA backend uses ControlType→role, Name, and the widget
ClassName), and SHALL NOT require a stable id such as UIA `AutomationId` (which target apps like
Telegram Desktop do not provide). A located element SHALL carry a `{rect, ref}` so the Engine can act
on it. `a11y` is platform-neutral with per-OS backends (Windows UIA / macOS AX / Linux AT-SPI); this
change implements the Windows UIA backend.

#### Scenario: locate a Telegram message list by class and control type
- **WHEN** a recipe queries `{role:'List', className:'HistoryInner'}`
- **THEN** the host agent returns the matching element with its screen rectangle and an opaque ref,
  without relying on any stable id (UIA AutomationId)

### Requirement: handle fast-path via native invoke

The Engine SHALL actuate a located element by its native invoke action (Windows UIA Invoke, macOS AX
AXPress, Linux AT-SPI action) — the `handle` fast-path — rather than computing and clicking a
coordinate, and SHALL fall back to a coordinate click only when no handle/invoke is available.

#### Scenario: a button is actuated by native invoke, not by coordinate click
- **WHEN** the recipe actuates a button element that supports a native invoke action
- **THEN** the Engine sends `{op:'invoke', args:{ref}}` and does not issue a coordinate click for it

### Requirement: a11y Observer reads a subtree into items

The `a11y` Observer SHALL read an accessibility subtree into structured items per a read spec (item
query + field map + dedupe key), reading field values from element name/value (Windows UIA Name/Value,
macOS AX AXTitle/AXValue, …), with no OCR or vision model.

#### Scenario: read channel messages into items
- **WHEN** the observer reads the message list subtree with a field map
- **THEN** it returns one item per `ListItem`, fields populated from the elements' Name/Value, deduped
  by the declared key

### Requirement: pagination via Engine scroll

Because target apps may expose no UIA scroll pattern, the desktop runner SHALL load more content by
issuing Engine-level scroll (wheel / PageDown) and re-reading the rendered subtree each tick, deduping
and stopping at the recipe's target count — reusing the browser harvest accumulation model.

#### Scenario: load more results by scrolling, not by a UIA scroll pattern
- **WHEN** the results subtree has more items than currently rendered and no UIA Scroll pattern exists
- **THEN** the runner scrolls via the Engine, re-reads the subtree, dedupes new items, and stops at the
  target count

### Requirement: kind:'desktop' recipe is a separate path

Desktop recipes SHALL use a new `kind:'desktop'` with its own desktop runner and `DesktopDriver`
interface, parallel to the browser recipe path (following the http/html precedent). This change SHALL
NOT modify the browser `Transport`/`PageDriver` nor the cloak/ext-cdp arms.

#### Scenario: desktop path does not touch the browser path
- **WHEN** the desktop capability is added
- **THEN** `src/replay/transport.ts` and the browser `PageDriver` are unchanged and existing browser
  recipes behave identically

### Requirement: telegram-search recipe is read-only

The first desktop recipe `telegram-search` SHALL be a `search` variant Provider (T2, call-driven,
ephemeral results) that drives Telegram's in-app search and reads results as resource items feeding the
existing netdisk / resource-search. Desktop recipes SHALL contain no write operations (no send, no
save); the effect axis stays read-only until a per-recipe authorization + package-signing trust model
exists.

#### Scenario: search returns items without any write
- **WHEN** `telegram-search` runs with a query
- **THEN** it focuses/searches Telegram, reads result items, returns them to the caller, and performs no
  message send, save, or other mutating action

#### Scenario: desktop recipe with a write step is rejected
- **WHEN** a desktop recipe declares a write-effect step
- **THEN** it is rejected (not hot-droppable data) per the effect-axis constraint

### Requirement: 窗口定位可按标题消歧

`AppMatch` SHALL 支持 `title`（包含匹配）与既有的 `process` / `windowClass` 并列。一个进程开着多个
窗口时（浏览器尤其常见），仅凭进程与窗口类**无法**指出目标；缺这一维时调用方只能靠关掉其他窗口
来消歧，那既有破坏性又不可自动化。

匹配结果不唯一时 SHALL 报歧义错误并列出候选，MUST NOT 任选一个。

#### Scenario: 同进程多窗口按标题选中
- **WHEN** Chrome 同时开着主窗口与账户选择器，`AppMatch` 给出 `{process:'chrome.exe', title:'扩展程序'}`
- **THEN** 命中标题包含「扩展程序」的窗口

#### Scenario: 匹配不唯一时不擅自选一个
- **WHEN** `AppMatch` 只给 `{process:'chrome.exe'}` 而存在多个可见窗口
- **THEN** 返回歧义错误并列出候选窗口标题

### Requirement: 桌面驱动不再只能经 kind:'desktop' recipe 到达

`DesktopDriver` SHALL 可被临时调用方（`cdp_*` 的 `desktop` / `app:` 档及其等价 HTTP 路由）取用，
不再只对 `kind:'desktop'` source 的执行路径开放。既有 recipe 路径的语义 MUST NOT 因此改变。

理由是实测出来的：2026-08-01 为了点一次 `chrome://extensions` 的按钮，只能往用户 recipe 目录扔
一个一次性 recipe 包、靠热重载装上、用 `POST /api/sources/preview` 驱动，再从返回的 items 里读
a11y 结果——**用采集 source 的机制执行一次性 UI 动作**。浏览器侧对同一需求有 `cdp_act`。

#### Scenario: 临时驱动一次桌面动作
- **WHEN** 调用方要在原生窗口上点一下，且不打算产出任何 item
- **THEN** 经 `cdp_act` 的 `app:` 档即可完成，无需创建 source、无需产出 item

#### Scenario: 既有 recipe 路径不受影响
- **WHEN** `kind:'desktop'` 的 `telegram-search` 按原样运行
- **THEN** 其步骤语义、observer 读取与产出 item 与改动前一致
