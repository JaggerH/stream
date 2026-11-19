## ADDED Requirements

### Requirement: A click the trees cannot name is judged, not waved through

For `click(rect)` the agent SHALL resolve the label the tap would land on in this order:

1. the deepest accessibility node covering the rect's center, when that node has a non-empty
   name — the existing judgment, unchanged;
2. else the smallest OCR text element (from the on-device recognition, see
   `android-recipe-replay`) whose rect contains the rect's center; that text SHALL go through the
   same `commit-label` / `payment-label` / claim / install / call / setting judgment as an
   accessibility label, with a synthetic element of role `"ocr-text"` and the text as its name;
3. else the click is **blind**: when the app in front is in the `shopping`, `payments` or
   `finance` category, the gate SHALL add `commit-unrecognized` and the op SHALL fail as
   `approval-required` without tapping. In any other category a blind click stays allowed, as it
   is today.

Recognition SHALL be attempted for step 2 whenever the accessibility hit is missing or unnamed,
whatever the app's category; a failed recognition (see above) leaves the click blind. An
approval credential still binds the screen it was approved on and is re-checked as before. Ask
exemptions apply to the reasons this rule produces like to any other (`commit`).

#### Scenario: a self-drawn button with a harmless label

- **WHEN** a `click(rect)` lands on an OCR text element reading 「加入购物车」 on a canvas-drawn
  shopping page with no accessibility label
- **THEN** the gate finds no commit and the tap runs

#### Scenario: a self-drawn commit button still asks

- **WHEN** a `click(rect)` lands on an OCR text element reading 「提交订单」, 「立即支付」,
  「立即购买」 or 「领券购买」 and no accessibility node names the target
- **THEN** the op fails as `approval-required` with `commit-label` and `payment-label` (a claim
  that also buys is a commit, as before) and nothing is tapped

#### Scenario: a blind click in a shopping app asks

- **WHEN** a `click(rect)` lands on a point with neither an accessibility node nor OCR text in a
  `shopping`, `payments` or `finance` app
- **THEN** the op fails as `approval-required` with `commit-unrecognized` and nothing is tapped

#### Scenario: a blind click elsewhere stays allowed

- **WHEN** the same blind click happens in an app of no known category
- **THEN** the gate adds nothing and the op runs as before (the category rule is what closes the
  blind spot; it does not descend to structure guesses)

#### Scenario: recognition that cannot run leaves the click blind

- **WHEN** recognition is unavailable or the frame cannot be captured (a protected page) and the
  click lands where no accessibility node names it, in a shopping app
- **THEN** the click counts as blind and the op fails as `approval-required` with
  `commit-unrecognized` — the failure direction is an extra approval, never a silent tap

#### Scenario: a named accessibility node keeps precedence

- **WHEN** a `click(rect)` lands on a named accessibility node and OCR text elsewhere overlaps
  the same point
- **THEN** the accessibility label is judged, not the OCR text
