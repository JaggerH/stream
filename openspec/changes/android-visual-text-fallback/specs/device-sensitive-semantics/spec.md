## ADDED Requirements

### Requirement: A click the trees cannot name is judged, not waved through

For `click(rect)` the agent SHALL resolve the label the tap would land on in this order:

1. the deepest accessibility node covering the rect's center, when that node has a non-empty
   name — the existing judgment, unchanged;
2. else every OCR text element (from the on-device recognition, see `android-recipe-replay`)
   whose box lies inside the tapped rect — the rect, not only the pixel under its centre: a label
   drawn to one side of a canvas button (or in a glyph box shorter than the button) misses the
   centre, and the tap is not blind then. A line counts when it and the rect overlap over at
   least half of the smaller of the two. Each line SHALL be judged on its own, as a label
   through the same `commit-label` / `payment-label` / claim / cart / install / call / setting
   judgment as an accessibility label, with a synthetic element of role `"ocr-text"`; the whole
   frame's recognized text SHALL stand in for the screen those judgments read (an amount, a cart
   offer, a commit question). Lines SHALL NOT be joined into one label;
   1. a line naming a cart (「加入购物车」/「加购」/ "add to cart") SHALL add no reason, whether
      or not the sheet shows an amount — it moves no money;
   2. a lone affirmative line (「确定」) in a `shopping`, `payments` or `finance` app SHALL add
      `payment-label` when an amount is inside the rect or on the frame; without an amount it
      SHALL add no reason only when the frame offers a cart and names no commit word
      (「立即购买」/「提交订单」/「付款」/「支付」…) — a spec sheet's own confirmation — and SHALL
      otherwise add `commit-unrecognized`, as the blind rule would;
3. else the click is **blind**: when the app in front is in the `shopping`, `payments` or
   `finance` category, the gate SHALL add `commit-unrecognized` and the op SHALL fail as
   `approval-required` without tapping. In any other category a blind click stays allowed, as it
   is today.

Recognition SHALL be attempted for step 2 whenever the accessibility hit is missing or unnamed,
whatever the app's category; a failed recognition (see above) leaves the click blind. An
approval credential still binds the screen it was approved on and is re-checked as before. Ask
exemptions apply to the reasons this rule produces like to any other (`commit`). An
`approval-required` failure produced by step 2 or 3 SHALL carry the `ocr` note the reply would
(`ran`, `cached`, `texts`, `error?`) — counts and an error code, never the recognized text.

#### Scenario: a self-drawn button with a harmless label

- **WHEN** a `click(rect)` lands on an OCR text element reading 「加入购物车」 on a canvas-drawn
  shopping page with no accessibility label
- **THEN** the gate finds no commit and the tap runs

#### Scenario: a label inside the rect counts though the centre misses it

- **WHEN** a `click(rect)` covers a canvas button whose drawn label lies inside the rect but not
  on its centre pixel
- **THEN** the label is judged, and a cart label on a sheet that shows a price still runs

#### Scenario: a spec sheet's confirm beside the cart

- **WHEN** a `click(rect)` covers 「确定」 on a sheet whose text offers 「加入购物车」 and names
  no commit and no amount
- **THEN** the gate finds no commit and the tap runs

#### Scenario: a confirm with an amount, or beside a buy button

- **WHEN** a `click(rect)` covers 「确定」 and the frame shows an amount, or shows 「立即购买」
- **THEN** the op fails as `approval-required` — `payment-label` for the amount, otherwise
  `commit-unrecognized` — and nothing is tapped

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
