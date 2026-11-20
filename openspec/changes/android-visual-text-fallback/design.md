# android-visual-text-fallback — design

## Engine selection

| Candidate | License | Verdict |
|---|---|---|
| Tesseract4Android 4.9.0 (Tesseract OCR + Leptonica) | Apache-2.0 (Tesseract), BSD-2-Clause (Leptonica) | **Chosen** |
| ML Kit Text Recognition (Chinese + Latin) | Google ML Kit terms of service | Rejected: not Apache-2.0-compatible; it also needs Google Play services or bundled models |
| tess-two 9.1.0 | Apache-2.0 | Rejected: Tesseract 3.05, cannot read the LSTM `tessdata_fast` models (legacy models are much larger) |

Tesseract4Android is served from JitPack (`cz.adaptech.tesseract4android:tesseract4android:4.9.0`,
12.8 MB AAR, native libraries for `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`; ~7.5 MB of them
per 64-bit ABI). A debug APK of the app module grows to ~36 MB; a release build shrinks it.
Tesseract and Leptonica are listed in `THIRD-PARTY-NOTICE`.

## Models

`chi_sim.traineddata` and `eng.traineddata` come from **tessdata_fast 4.1.0** (Apache-2.0), the
LSTM models Tesseract 4+ reads:

| File | Bytes | SHA-256 |
|---|---|---|
| `chi_sim.traineddata` | 2,469,156 | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |
| `eng.traineddata` | 4,113,088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |

They are **not bundled** in the APK. The first recognition downloads what is missing into
`<filesDir>/tessdata` from the pinned URLs (raw.githubusercontent.com, tag `4.1.0`), verifies size
and SHA-256, writes `.part` and renames. A host that ships the files itself, or cannot reach the
URL, pre-places the same two files; the check skips files that already match. The first run is
therefore slower, and its cost is visible in `timing.ocrMs`.

## Where OCR sits

- `find` — the caller's read. `ocr: auto|on|off`; `auto` triggers on a foreground scoped window
  with fewer than **3 visible named nodes**; only a foreground window is captured (a background
  window's screenshot would show another app).
- `click(rect)` — the gate's read. Triggered only when the accessibility hit has no name (or no
  node exists), whatever the app's category; the cache usually serves it after a `find` on the
  same frame.
- The frame is the same `Device.screenshot` the `screenshot` op uses, so credential areas are
  covered before recognition and an unlocatable credential area skips OCR entirely.
- Results are cached by the frame's SHA-256 (last 8 frames). Recognition is one line per
  `RIL_TEXTLINE`; the element is `role: "ocr-text"`, `className: "ocr"`, `name` = the line,
  `source: "ocr"`, `confidence` 0..1. It goes through the same ref table, so refs stay stable
  until the screen changes over the line's area; `invoke` on one taps its centre.

## Gate table for `click(rect)`

| Point lands on | Judgment |
|---|---|
| a named accessibility node | unchanged (existing tables and structure) |
| a structural accessibility node without a name (input / list / tab) | unchanged (not a commit) |
| no named node, OCR text inside the rect | every line drawn inside the tapped rect is judged on its own through `commit` / `payment` / `claim` / install / call / setting, with `control.role = "ocr-text"`; the frame's whole text stands in for the screen those tables read (an amount, a cart offer, a commit question) |
| … a cart line (「加入购物车」/「加购」/ "add to cart") | no reason — a free step, whether or not the sheet shows a price |
| … a lone affirmative (「确定」/「确认」) in `shopping` / `payments` / `finance` | `payment-label` when an amount is under the rect or on the screen; free when the frame offers a cart and names no commit and no amount (a spec sheet's own 确定); `commit-unrecognized` otherwise |
| neither (blind) | `shopping` / `payments` / `finance` app → `commit-unrecognized` (`approval-required`); any other app → no reason, as before |
| OCR cannot run (no models, protected frame, engine error) | the click is blind: same blind row (fail-safe, one extra approval at worst) |

The rect, not its centre pixel, is what step 2 reads. A canvas button's label is drawn somewhere
inside the button — left-aligned, above the vertical centre, or in a glyph box shorter than the
button — so a rect the caller sends over the button can have its centre on blank pixels while the
label sits inside it. Reading only the centre pixel turns that into a blind click and an extra
approval on a button the pixels do name. A line counts when it and the rect overlap over at
least half of the smaller of the two: a small tap inside a big label takes the label, a wide rect
takes every label it holds, and a line that only touches the edge does not. The lines are judged
one by one rather than joined into one string — concatenating 「加入购物车」 and 「立即购买」 would
read as neither label and hide the commit.

`safe labels` for the scenario: 「加入购物车」/「加购」 does not gate, with or without a price on
the sheet; 「提交订单」「立即支付」「立即购买」「领券购买」 do (the last one because a claim that
also names a purchase is a commit, the existing claim rule, not a special case). A bare 「确定」
in a shopping, payments or finance app is the sheet's own confirmation only when the frame shows
a cart and no commit word and no amount; a sheet that also shows 「立即购买」 or a price makes the
same 确定 a purchase step. Outside those categories the lone 确定 runs as before, the same scope
the blind rule has.

## Categories

`app/android/agent/src/main/assets/policy/apps.json` gains two non-deny categories: `shopping`
(Taobao/Tmall/JD/Pinduoduo/Amazon/eBay/Shopee/Lazada/Temu… and their Chinese names) and `payments`
(Alipay/UnionPay/…). They change nothing about visibility (unlike `finance`); they only let the
blind-click rule know the app is one where money or goods change hands. App stores stay in
`stores` and are not part of the blind rule.
