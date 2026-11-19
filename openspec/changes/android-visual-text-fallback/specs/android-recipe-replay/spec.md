## ADDED Requirements

### Requirement: Text elements from on-device OCR when the accessibility tree cannot see

When the accessibility tree of the foreground window carries fewer than three visible named nodes,
or when the caller asks for it, the agent SHALL recognize the text drawn on the screen from one
screenshot of that window and SHALL return each recognized text line as an element of the same
shape as an accessibility element:

- `role`: `"ocr-text"`;
- `name`: the recognized line's text, trimmed (a blank line is dropped);
- `text`: the same string (the `UiNode` text field an element already carries);
- `rect`: the line's bounding box in frame pixels (the frame is the full screen, so these are
  screen pixels too);
- `source`: `"ocr"`;
- `confidence`: the engine's mean confidence for the line, 0..1, rounded to three decimals;
- `ref`, `className` and `editable`: `ref` from the same ref table every other element uses,
  `className` `"ocr"`, `editable` `false`.

OCR elements SHALL match `find` queries the same way accessibility elements do (role, name,
`nameContains`, `className`), SHALL be usable with `click(rect)` on their rect, and `invoke(ref)`
on one SHALL tap the center of its rect. A ref on an OCR element stays usable only while no
change event has crossed its area since it was read; otherwise it fails as `stale-ref` with
`element_moved` (OCR elements are not relocated).

Recognition SHALL happen on the device; the screenshot SHALL NOT leave it. Credential fields and
code-context text are covered before the frame is recognized (the same masking the `screenshot`
op uses); when their areas cannot be located, OCR is skipped rather than reading a frame that
cannot be vouched for.

#### Scenario: a self-drawn page yields text elements

- **WHEN** the scoped foreground window has fewer than three visible named nodes (a canvas-drawn
  shopping page), and the caller sends `find` with `{"nameContains": "加入购物车"}`
- **THEN** the reply's `elements` contains one with `role: "ocr-text"`, `source: "ocr"`, that text
  and a rect over it, and `click` on that rect taps its center

#### Scenario: a readable tree does not pay for OCR

- **WHEN** the scoped foreground window has three or more visible named nodes and the caller
  sends `find` without an `ocr` argument
- **THEN** no screenshot is taken and the reply contains no OCR element and no OCR timing

#### Scenario: the caller can force or forbid OCR

- **WHEN** the caller sends `find` with `ocr: "on"` on a readable page
- **THEN** OCR elements are included; with `ocr: "off"` on an unreadable page no OCR element is
  included and no recognition runs

#### Scenario: OCR failure does not fail the read

- **WHEN** the screenshot is refused (`secure-window`, an all-black frame) or the engine cannot
  run (models missing and the download failed)
- **THEN** `find` still returns the accessibility elements, the reply's `ocr` field says the run
  did not produce texts, and no OCR element is included

### Requirement: The `ui.ocr` capability and OCR timing

The Android agent SHALL declare the capability `ui.ocr` at version 1 in its `hello` manifest. The
`find` reply SHALL carry, when OCR was considered, an `ocr` object — `ran` (recognition was
attempted), `cached` (the result came from the same-frame cache), `texts` (how many lines it
produced) and, on failure, `error` — and a `timing` object whose `ocrMs` is the milliseconds spent
recognizing (0 on a cache hit). A `find` on a background window never runs OCR: a screenshot would
show whatever is in front instead of the scoped window.

The same screenshot (identical frame bytes) SHALL reuse the previous result: the cache key is the
frame's SHA-256, bounded to the last eight frames. The line granularity is the engine's text line
(`RIL_TEXTLINE`); line stitching across frames is the caller's business, as on the desktop text
tier.

#### Scenario: a repeat read of the same screen skips the engine

- **WHEN** two `find` calls with `ocr: "on"` run with no screen change between them
- **THEN** the second reply carries `ocr.cached: true`, `timing.ocrMs: 0`, the same elements, and
  the engine was called once

#### Scenario: an older caller is unaffected

- **WHEN** a caller that knows neither `ui.ocr` nor the `ocr` argument reads a normal page
- **THEN** the reply shape it reads is unchanged (extra optional fields are the only difference)
  and no OCR work happens
