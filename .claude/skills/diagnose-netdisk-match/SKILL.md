---
name: diagnose-netdisk-match
description: Use when a netdisk (AList) binding shows an episode/video as unmatched or missing that the user says should have matched — turns a one-off manual fix into permanent regression coverage in src/netdisk/match-spec.test.ts instead of the same class of case being rediscovered by hand every time.
---

# Diagnose a netdisk match miss

## Overview

`src/netdisk/match-engine/` is a deterministic, zero-LLM matcher that pairs a Stream's episodes
(LEFT) against files in an AList directory (RIGHT). Two layers: `collect.ts` gathers evidence
(duration hits, structural keys, name scores, byte twins) into a graph, then `resolve.ts` applies
an ordered, numbered rule table (`rules.ts`, R1–R14 — the decision table in `docs/MATCHING.md`).
Entry point is `matchByEvidenceResult()` in `adapt.ts`. The `MatchSpec` vocabulary (stage kinds,
thresholds, cleaning) lives in `src/netdisk/match-spec.ts`.

`match-spec.test.ts` is a fixture aggregate — each `it(...)` is a real production naming pattern,
usually added straight from a bug (`grep -n 真实 src/netdisk/match-spec.test.ts` to see the
citation-comment style). There is also a frozen golden baseline over 104 inputs
(`match-engine/golden.test.ts` + `golden-baseline.json`): any behavior change shows up there as a
diff, so **expect it to go red and re-record deliberately** (`scripts/match-golden-baseline.ts`)
whenever you intentionally change a rule.

**A per-binding `titleStrip` fix can feed two consumers, not just one — but check the override
first.** Binding match (this skill's main subject, using `match-spec.ts`'s `stripper()`/`normTitle()`)
and the reconcile organizer (`src/netdisk/reconcile/`, which sorts loose files into
move/delete/pending, see `docs/MATCHING.md`'s "共享认集层" section) run two DIFFERENT cleaning
pipelines, deliberately: binding match needs a comparable title for bigram similarity scoring
(must NOT strip punctuation — that distorts similarity), the organizer needs an exact-match
grouping key (must strip punctuation, all the way). What they actually share is not a function,
it's data: `identityRulesFromSpec()` (`src/netdisk/match-spec.ts`) distills a binding's
`MatchSpec` into `{titleStrip, epNumRegex}`, which the organizer's `makeIdentity()`
(`src/netdisk/identity.ts`) takes as parameters.

That borrow is **per-field, with replacement, not union** — `ReconcileShowConfig.identity`
(`src/netdisk/reconcile/service.ts:27`) lets a show override `titleStrip` and/or `epNumRegex`
independently, and whichever field is overridden stops looking at the binding entirely
(deliberate: a union would drift the organizer's grouping key and silently orphan
`data/reconcile/decisions.json` exemptions). **Before assuming "fix it on the binding, the
organizer picks it up automatically" — check whether the show's `identity` config already
overrides that field.** The live 怡乐(yile) show overrides BOTH `titleStrip` and `epNumRegex`,
so for that show, binding-side `titleStrip` changes never reach the organizer at all.

**Multi-season TV bindings have a second layer in front of this**, `src/netdisk/season-resolve.ts`
(`season-resolve.test.ts` is its own fixture aggregate) — it sorts right-side files into
per-season buckets (nested literal season name → structural file-count fingerprint → LLM
fallback, in that priority order) *before* the matcher ever runs, so the matcher only ever
sees one season's worth of clean data per call. A miss on a multi-season binding can come from
either layer — see step 4 for how to tell which. Full mechanics: `docs/MATCHING.md`'s "季归属
怎么判的" section.

**Core principle:** don't just hand-fix a miss and move on. Reproduce it with the REAL left/right
data, classify it, then land it as a fixture — that's what makes "I fixed this once" become "this
class of case can't silently break again."

## When to use

- User reports: "this episode should be matched/playable but isn't", for a stream that already
  has (or should have) a netdisk binding.
- A binding's `netdisk_bindings` coverage shows unexpected `missing`/`orphan` counts.
- The reconcile organizer groups two files into the wrong episode, or splits one episode's files
  into two groups (wrong move/delete/pending decision). Same diagnosis flow applies as far as
  where the rules live — the organizer borrows its rules-as-data from the same binding as binding
  match (see Overview), so a fix usually starts as a per-binding `titleStrip`/`epNumRegex`
  addition, verified via `netdisk_preview_spec` on the binding. But check the show's `identity`
  override first (Overview) — if it already sets the field you're about to change, the binding-side
  fix is a no-op for the organizer and the fix has to go in `ReconcileShowConfig.identity` instead
  (`data/reconcile/config.json`, not code).
- Not for: choosing a directory / creating a brand-new binding when none exists yet (that's
  `project planning record`'s "非 TMDb 关注流没有 UI 入口创建网盘绑定" gap — use `POST /api/netdisk/mappings`
  with `{streamId, dirPath}` first, this skill is about the MATCH failing after a binding exists).

## Procedure

1. **Find the binding** — `netdisk_bindings` MCP tool → `setId`, `dirPath`, current coverage.
2. **Get LEFT + RIGHT raw data**:
   - LEFT: `GET /api/netdisk/mappings/<setId>` → `entries[].leftKey`/`leftTitle` (or every visible
     episode title if the binding doesn't exist yet).
   - RIGHT: `GET /api/netdisk/fs?path=<dirPath>&recursive=1` → real file names, not a guess.
3. **Reproduce locally against `DEFAULT_MATCH_SPEC`** — write a throwaway script (repo convention:
   `Write` it under the job tmp dir, run with `pnpm exec tsx`, don't inline) that imports
   `matchByEvidenceResult` from `src/netdisk/match-engine/adapt.ts` and `DEFAULT_MATCH_SPEC` from
   `src/netdisk/match-spec.ts`, and runs the REAL pair through it, untuned. This tells you what the
   generic rules do before any per-binding data. The returned `.resolution.trails` is a per-file
   verdict trail (which episodes it had evidence for, which rule vetoed each edge and why) — read
   that before guessing.
4. **Classify — regression or new pattern? (multi-season TV: check season resolution FIRST)**
   - If the binding is multi-season TV and the miss looks like a whole subfolder (not scattered
     individual episodes) — check `GET /api/netdisk/mappings/<id>` → `llmSeasonCache` before
     touching the matcher at all. A folder mapped to `null`, or to a season that doesn't match
     what its files actually belong to, means `season-resolve.ts` misrouted or dropped that
     folder — the matcher never even saw those files paired against the right season's left
     items. Fix path is in `season-resolve.ts` (see step 5), not the matcher.
   - Otherwise, read the `by:`-stage doc comments in `match-spec.ts` (`DEFAULT_EPISODE_PART_REGEX`,
     `DEFAULT_TITLE_STRIP`, etc.) — several declines are BY DESIGN (e.g. bare "上/下" without a
     trailing "集" is deliberately excluded from `episode-part`, guarded by an existing test, to
     avoid misfiring on titles like "第10期上流社会"). A designed decline is not a bug.
   - Grep `match-spec.test.ts` for a fixture with the same shape (same stage, similar
     naming pattern). Equivalent fixture passes but the real case still fails → **regression**,
     something in the matcher broke a guarantee — find the shape difference, fix the code
     (evidence missing → `collect.ts`; evidence there but the wrong rule fired → `rules.ts`/`resolve.ts`).
   - No equivalent fixture, and any decline is by clear design intent → **new pattern**. Solve it
     with a per-binding `MatchSpec` (see step 5), and add a fixture so DEFAULT's correct decline
     AND the tuned-spec recovery are both pinned down.
   - Neither of the above (the file genuinely doesn't exist in the directory) → not a matcher
     problem. Report it as residue; no fixture needed.
5. **Solve it**:
   - Iterate a candidate `MatchSpec` with `netdisk_preview_spec` (dry-run against the live
     binding) until coverage looks right, then `netdisk_apply_spec` to commit.
   - **Threshold is a correctness lever, not just a recall lever.** A loose threshold on short
     strings can wrongly match "第3期上" to "第3期下" (1-char diff, easily >0.6 similarity) when the
     right file is simply absent — push threshold high (~0.95+) so only near-exact matches pass;
     genuine misses should surface as `missing`, not a confident wrong pairing.
   - A **generic, low-risk** fix (e.g. an extension the built-in stripper never covered) belongs in
     the code itself (`match-spec.ts` for cleaning/thresholds, `match-engine/` for evidence or rules). A **show-specific** fix (e.g. stripping everything after a colon —
     catastrophic for a show whose episodes share one colon-prefixed label and differ only after
     it) stays per-binding `titleStrip` data, never code — this is an existing, explicit rule in
     the file (grep for "不写进代码" / "不入代码"). "Not written into code" applies to the
     reconcile organizer too: its 怡乐播客 show-name prefix strip used to be hardcoded in
     `reconcile/identity.ts` (`SHOW_PREFIX`) — it has since been migrated to a data override
     (`ReconcileShowConfig.identity` in `data/reconcile/config.json`), the same place a
     per-binding `titleStrip` lives, not a code constant.
   - **A `from: null → to: X` preview pairing is not automatically a win.** A strip rule that
     removes a distinguishing prefix can push duplicate copies down into the weak `title` stage
     and manufacture a confident wrong pairing — verify the episode number in `to` actually
     matches, don't just count new pairings as recovered coverage (see `docs/MATCHING.md`'s
     "读 preview 的判据").
   - Genuine ties (two right files reduce to the identical stripped string — e.g. a regular cut and
     a "纯享" cut of the same segment where only one file's name says so) correctly stay
     `unmatched`; resolve those by hand with `PATCH /api/netdisk/mappings/<id>/entries/<leftKey>`
     (`{rightFile: "<exact name>"}`), not by loosening the spec.
   - **Season-resolve.ts misses go through the same generic-vs-per-binding split**, just one layer
     up. A folder mis-sorted because of a genuine priority/heuristic bug in
     `structuralSeasonMatch`/`nestedCleanNameSeason`/`resolveFolderSeasons` is a code fix in
     `season-resolve.ts` (real regression: 2026-07-25, a season split across `part1`/`part2`
     subfolders had `part1`'s file count coincidentally equal another season's real episode
     count — structural fingerprint won over a literal `Sxx` already sitting in the folder name;
     fixed by trying the literal-name check first). A folder that genuinely can't be resolved by
     any of the three tiers (no literal season marker, file count matches nothing, LLM declines —
     e.g. a "最终季"/"完结篇"-labeled folder with no `Sxx` and an episode count that doesn't match
     any season) is not a bug to route around with a bespoke heuristic — that's exactly the kind
     of one-show special case docs/MATCHING.md warns against baking into shared code. Confirm the
     season pairing by hand (episode-count continuity, absolute-numbering offsets across parts)
     and `PATCH` those entries directly.
6. **Land the fixture** — append an `it(...)` near the relevant stage's existing tests, using the
   file's `L()`/`R()` helpers and its citation-comment convention:
   `// 真实案例（<剧名/来源>，<date>）：<what broke / what pattern this is>`. Assert the SAME
   classification you found in step 4 (decline-by-design + recovery-with-tuned-spec, or a straight
   regression fix). A season-resolve.ts fix lands the same way in `season-resolve.test.ts`.
7. **Verify**: `pnpm test src/netdisk/` (covers `match-spec.test.ts`, `match-engine/`, and
   `season-resolve.test.ts`), then full `pnpm test` + `pnpm typecheck` before considering it done.
   If `golden.test.ts` went red, diff it deliberately — re-record the baseline only once you can
   name which rule changed and why.

## Worked example

2026-07-19, "脱口秀和Ta的朋友们 第三季": episodes titled `第2期上纯享：18岁女高音乐脱口秀` (bare
上/下, inline "纯享" tag, colon-description), files named `2026-07-03 第2期上.mp4` (no "纯享" in the
name at all). `DEFAULT_MATCH_SPEC` → 0/8: `episode-part` correctly declines (no trailing "集"),
`title` stage's similarity was 0.75 (colon-suffix + "纯享" never stripped) — below its 0.85 bar. Also
found a real code gap along the way: `EXT` (the extension-stripper) only ever covered audio formats
(`mp3/m4a/ogg/...`) — `.mp4`/`.mkv` were never stripped before title comparison, even though a
sibling `VIDEO_EXT` already existed for the movie `solo` stage. That part was generic and low-risk,
so it went into the shared cleaning code (`match-spec.ts`) directly. The colon/纯享 stripping stayed a per-binding spec. Landed
as three fixtures in `match-spec.test.ts` (decline-by-design, tuned-spec recovery, genuine-tie
decline) — see `git log -p -- src/netdisk/match-spec.test.ts` around that date for the exact form.

## Worked example — a miss that spans both layers

2026-07-25, "进击的巨人" (tmdb:1429, 4 seasons, 87 episodes): 0/87, all 143 right files orphan.
`DEFAULT_MATCH_SPEC` declines everything — right files are named `进击的巨人 S01/进击的巨人24.mp4`,
season folder + bare trailing episode number, no `SxxExx` in the basename at all (the recursive
path gets stripped to basename before any regex runs, so the folder-level `S01` is invisible to
`fileRegex` no matter how it's written). `epnum` can't help either: it needs the *left* title to
also start with a number, and TMDb episode titles ("致两千年后的你") never do — structurally
incompatible with TMDb-keyed TV bindings regardless of directory layout, not something a regex
tweak fixes.

This was generic, not this-show-specific (any archive that organizes by season-folder + bare
episode number hits the same wall), so it became a code change: `season-episode`'s `fileRegex` can
take a single capture group (episode only) and drop the season component of the match key — safe
specifically because a single-season data set is exactly what `season-resolve.ts` already guarantees
per match run. (That key-building now lives in `match-engine/collect.ts`'s structural-key collector.)
Applying that alone got 71/87.

Digging into the remaining 16 misses surfaced the `season-resolve.ts` priority bug from step 4's
example above (`part1`/`part2` file-count collision) — fixing that (separate commit, separate
`season-resolve.test.ts` fixture) recovered 12 more, to 83/87. The last 4 (`S04E05/E14/E27/E28`)
sat in a `llmSeasonCache` `null` folder ("最终季 Part.1/Part.2", 4K-quality re-release, no literal
`Sxx`, file count matches no season, descriptive filenames like `...Final Season - 08 [BD HEVC
2160P FLAC].mkv` that no regex cleanly reduces to a bare number) — genuinely unresolvable by any
generic rule without risking a wrong guess on some other binding, so those 4 were confirmed by
hand (absolute-numbering continuity across the two parts, already validated against the 83 that
matched automatically) and `PATCH`ed directly. Three fixes, three different homes: one matcher
capability + fixture, one `season-resolve.ts` priority fix + fixture, one per-binding manual
correction that stays data, never code.
