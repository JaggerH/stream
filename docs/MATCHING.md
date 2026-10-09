# MATCHING — How Netdisk Files Match the Program List

**Problem it solves**: A netdisk contains a pile of chaotically named files (avoidance words added by the sharer, watermarks, timestamp suffixes, misplaced
numbers). The system must decide which episode in the program list each file corresponds to.

**What it does not do**: It does not rename files, move files, or delete files. Matching only produces the ledger of "who corresponds to whom"; files stay where they are.
(Disguised names on the netdisk are assets, not noise — see
`internal design record`.)

Code: `src/netdisk/match-engine/` (evidence layer `collect.ts` → adjudication layer `resolve.ts` + rule table `rules.ts`
→ adaptation layer `adapt.ts`), and the language of match specs plus the cleanup/comparison tools shared by both sides are in `src/netdisk/match-spec.ts`.

## Terms

| Name | What it is |
|---|---|
| `SpecLeft` | One item in the program list: `{ leftKey, title, durationS?, paid?, needsSupply? }`. It comes from a TMDb episode table or a subscription Stream item. Nobody reads `paid` (it only explains why); `needsSupply` (= whether this episode itself has a playable URL; absent = needs supply) is the only bit read by the decision layer and the handling layer. See "That bit is called `needsSupply`, not `paid`" |
| `SpecRight` | A file: `{ name, size?, durationS? }`. `name` includes the relative subpath when directories are listed recursively |
| `inbox` | The batch of `SpecRight` waiting to be handled (not currently used by film/TV flows; the three source directories for the Yile podcast play this role) |
| `library` | The batch of `SpecRight` that has already been archived. Daily matching binds to this |
| `MatchSpec` | A binding's matching rule, **data rather than code**, stored on the binding and overridable per binding |
| `matchByEvidenceResult` | The work entry point (`match-engine/adapt.ts`): give it MatchSpec + SpecLeft[] + SpecRight[], and it produces pairs, questions, coverage, plus a complete adjudication `Resolution` |
| `Resolution` | The complete conclusion for one matching run: claims / questions / residue / missing files / each file's adjudication trace (`match-engine/types.ts`) |
| episode-identification function | `makeIdentity(rules)` in `src/netdisk/identity.ts`: filename → `{key, num}`, a grouping-key generator dedicated to the archiver (`reconcile/`); binding matching uses its own cleanup pipeline. The two sides share this show's rule data, not the same function. See the "Shared Episode-Identification Layer" section |

## Adjudication Table: Which Evidence Combinations Produce Which Conclusions

The "six stages" below describe **how execution works** (who runs first, who buckets). This table describes the **conclusion contract**: given a shape of evidence,
which decision should come out. The two must not fight each other — changing stage order, moving thresholds, adding or removing a stage must not change any cell in this table.

Evidence has only **two axes + one amplifier**:

- **Name**: structural-key hit > exact equality after cleanup > best similarity > no signal;
- **Duration**: match (±tolerance) / contradiction (relative difference > 10%) / unknown;
- **Uniqueness is an amplifier, not evidence** — "it is the only one within tolerance" does not itself prove "this is the episode".

Byte equality is **file↔file** evidence. It is only used for duplicate-copy decisions and **does not participate in episode identification**.

| # | Evidence shape | Adjudication |
|---|---|---|
| 1 | Name uniquely hits one episode + duration matches | Claim |
| 2 | Name uniquely hits one episode + duration is **unknown** | Claim (the name alone is valid evidence; no need to collide with duration) |
| 3 | Name uniquely hits one episode + duration **contradicts** | **Show a card** (two pieces of evidence conflict; human adjudicates) |
| 4 | Duration uniquely matches + name is best but below the threshold | Claim the best candidate, but it must pass the 0.3 name floor; if it does not pass the floor → show a card |
| 5 | Multiple files match by duration + name can separate the best candidate | Claim the best candidate, and put the others into the duplicate chain or show a card; **rejected candidates must leave a trace** |
| 6 | Name points to episode A, duration points to episode B | **Show a card** |
| 7 | Multiple names hit the same episode | If duration can separate them, separate them; otherwise use quality to choose the best / show a card |
| 8 | Name has no signal + duration has no hit | Residue → take down |

**Two iron rules**: no cell may be traceless (every file has a trace, and every rejected edge can give a reason);
**take-down may only enter from cell 8**.

**The trap in cell 2: a number collision is not a name hit.** The episode number is only a bucketing key; disambiguation inside the bucket still depends on the title —
`014.六月新闻大盘点` ("June news roundup") and `14.辛金` ("Xin metal") have the same number, but they are two different things. That case shows a card instead of claiming.

**Cell 6 explicitly does not automate**: even if this file is **byte-for-byte identical** to B's rightful file, that is only a sentence shown to the human on the card;
it is not a reason to "automatically judge it as a duplicate and delete it".

The full table and the implementation source for each cell: `internal design record`
§8 (decision record P13); each conclusion is pinned cell by cell in `src/netdisk/match-engine/decision-table.test.ts`,
and the overall behavior is guarded by 104 golden-sample baseline groups (`match-engine/golden.test.ts` + `golden-baseline.json`).

## Six Stages

`MatchSpec.stages` is an **ordered** list loaded into the rule table (R1–R14 in `match-engine/rules.ts`);
the order is the priority order. Each stage only handles left-side items that have not yet been matched; matched right-side files are occupied, and later stages cannot see them
(**one-to-one**: one file never belongs to two episodes at the same time). **Evidence is collected in full first** — the bucketing half is computed once in the evidence layer,
and each stage receives a slice of the same graph, not a fresh scan of the right side.

| Stage | How it buckets | When to use it |
|---|---|---|
| `duration` | The **duration** on both sides, tolerance 1s | **Main anchor for episode identification**. Names can lie; duration cannot. See "Duration Stage" below |
| `season-episode` | The left side takes `S01E02` from the end of `leftKey` (TMDb keys carry it); the right side takes `[Ss]\d{1,2}[Ee]\d{1,3}` from the filename | Episodes named by scene groups; the most reliable |
| `season-episode` (single capture group) | When `fileRegex` has only one capture group, it degrades to "bucket purely by episode number"; the left side also compares only the episode number | The netdisk is split into folders by season, and filenames themselves are bare down to only the episode number (see "Folders Split by Season" below) |
| `episode-part` | Compound key of issue number + segment (`第2期纯享下集` ("issue 2 pure-enjoyment lower episode") / `第10期（三）` ("issue 10 (three)") / `第1期四` ("issue 1 four") / `第4期2` ("issue 4 2") / `第一期上` ("first issue upper"), with an optional date prefix consumed; compare after both sides are normalized, Chinese numerals = Arabic numerals), default `DEFAULT_EPISODE_PART_REGEX` | Variety shows with multiple episodes per issue |
| `epnum` | Leading 1–3 digits, default `^0*(\d{1,3})(?=[.\s、\-]\|[一-鿿])` | Serial numbers for podcasts/variety shows. **4-digit numbers are excluded by digit count** to avoid treating years as episode numbers |
| `title` | No bucketing; pure title similarity | Fallback for items with no number of any kind (`2026丙午流年运势解析` ("2026 Bingwu annual fortune analysis")) |
| `solo` | The only video file in the directory is claimed; if there are multiple, take the largest one | **Movie-only**, and only when the left side has exactly 1 item |

**Why the order is like this**: the earlier a stage is, the harder the evidence and the less likely it is to be coincidence. Duration (intrinsic to the content) > season/episode number >
issue number + segment > serial number > pure title. Strong evidence first pins down what can be determined; only the remainder goes to weaker evidence. This prevents title similarity from
stealing a pair that should be determined by a number — and also prevents a **wrong number** from stealing a pair that should be determined by content.

Default rules (`DEFAULT_MATCH_SPEC`; if you configure nothing, this is it):

```
duration      (tolerance 1s, threshold 0.6, margin 0.15)   ← filled in implicitly; see below
season-episode(threshold 0,    margin 0.15)
episode-part  (threshold 0.25, margin 0.1)
epnum         (threshold 0.6,  margin 0.15)
title         (threshold 0.85, margin 0.15)
```

Movies use `MOVIE_MATCH_SPEC`: `solo` → `title(0.85, 0.15)` (plus the implicit duration stage, but movie left sides have no duration,
so the whole stage has no signal).

## Duration Stage (Main Anchor for Episode Identification)

**It solves the class of problems filename rules can never solve**: the name itself is wrong. Two real cases:
the content of `53.财克印、印克食伤` ("wealth restrains seal, seal restrains food/output") sits on the netdisk as `52.财克印、印克食伤.mp3` ("wealth restrains seal, seal restrains food/output") (number shifted by 1);
`455.现代版木仓下留人` ("modern version of spare the person under the wooden gun") is actually the source site's `454.现代版枪下留人` ("modern version of spare the person under the gun") (shift + avoidance-character rewrite fail at the same time).
Duration is intrinsic to the content; renaming, adding watermarks, adding avoidance words, or using the wrong number cannot change it.
The design is in `internal design record`.

**Five things to know**:

1. **You do not configure it; it exists automatically.** `specStages()` prepends a stage to any spec that does not explicitly declare `duration`
   (including LLM-produced specs and frozen custom specs that are respected) — it is an anchor, not "a naming rule for some show".
   To tune tolerance, explicitly write a stage `{ by: 'duration', toleranceS: N, ... }` on that binding; once written, it is not filled in again.
2. **Both sides must have duration; otherwise the whole stage has no signal and falls back byte-for-byte to the filename chain.** Left side: subscription Streams carry it from normalized media
   `duration_s`; **TMDb episode indexes do not provide duration**, so TV/movie bindings cannot use this stage today,
   behavior stays exactly unchanged, and no probe is sent. Right side: `NetdiskService` probes with ffprobe (header-only read),
   sharing the same cache as the archiver (the `durations` table in `netdisk.db`, key = `byte count:absolute path`),
   with at most 200 **new** probes per sync (cache hits do not count). Files beyond the budget are treated as having no duration in this round.
3. **A unique hit is claimed directly, and it is `auto`** — threshold is not checked. This is the same special case as
   "structured key + unique candidate" for `episode-part`/`season-episode`; duration is harder than those two keys. The title similarity of `455.现代版木仓下留人` ("modern version of spare the person under the wooden gun")
   is only 0.615, so similarity alone can never reach `auto`.
   **But the exemption has a name floor, `DURATION_MIN_SIM = 0.3`**: even the only file within tolerance must have at least some name overlap.
   "Unique" is not the same as "correct" — when no third file happens to fall in the ±1s interval, that is often just luck.
   **Anything below the floor is never matched** (it is not degraded to pending, and not recorded as missing): this episode falls back to the filename chain, and the file stays in the pool;
   if the chain also cannot match it, report the episode as missing honestly and put the file into orphan. **Failure to match is itself a signal that must be reported**; giving it a "somewhat similar"
   score only translates the problem into another wording.
   > 2026-07-30 live verification: `848.三十探悬疑案件` ("thirty explorations of suspense cases") (8162s) was assigned to `怡乐播客 - 209.十五谈身边灵异事.mp3`
   > ("Yile Podcast - 209. fifteen talks about supernatural events around us") (8163s), with no character overlap in the name yet marked `auto`; episode 209 was not in the list provided by the subscription Stream (the feed only provides the most recent 167 items),
   > so there was no "rightful owner" to claim the file back, and the mismatched pair kept hanging around.
   >
   > The 0.3 floor is measured, and both sides of the gap are empty: the lower bound of true matches is **0.615** for 455/454 (avoidance-character rewrite),
   > while false matches are all **0.000** (848/209, 530/820, 29/104). Raising it would hurt real shifted-number cases; do not tweak it casually.
4. **Collisions are not forced into matches.** Whole seasons with equal lengths (every episode ~60min) have low duration distinctiveness: when multiple candidates fall within tolerance,
   first use `reduceByQuality` for deduplication, then use title similarity (0.6/0.15) for subdivision; if subdivision fails, record ambiguous
   and let this episode go to later `season-episode`/`epnum` stages (if it truly matches later, ambiguous is cleared).
   **Size (`size`) may only be used to break duplicate files with the same name, and must never choose between different titles** — `sameEpisodeBucket=false` in `reduceByQuality`
   is this gate: the bucket key for `epnum`/`season-episode` is the episode number, guaranteeing the bucket contains the same episode,
   so "larger wins" selects clarity; the bucket key for `duration` is only "same duration" and **does not guarantee the same episode**,
   so the same rule here is choosing "which episode".
   > Measured cost of the first live sync on 2026-07-30 (when this gate was missing): Yile episodes 530 and 820 both had duration
   > 7707s and size differed by 3.7KB. The collision was compressed into a "unique candidate", uniqueness then triggered the exemption in item 3, and the two episodes were matched **crosswise**
   > incorrectly and both marked `auto`; in Xuangguan Notes, `29.十神的生克关系` ("the generation and restraint relationships of the ten gods") (1989s/31.9MB) was displaced by the larger main episode
   > `104.清华大学朱令案` ("the Zhu Ling case at Tsinghua University") (1989s/47.7MB), while the exact same-name file with sim=1 instead fell into orphan.
   > Both cases have regressions in `match-spec.test.ts`, and both are in the golden-sample baseline.
5. **Zero competition = fake collision.** If, among the few files that collide within tolerance, only **one** has any name overlap (`titleSim > 0`) and the others are exactly
   `0` (not even a shared bigram), that is not a collision: the files with similarity 0 have no overlap at all with this episode's title;
   they collided only because two episodes have the same length. They do not count as competitors, and the overlapping file is claimed directly as anchor-level evidence (`auto`) according to item 3.
   The winner still must pass the 0.3 name floor — "the only one with overlap" and "enough overlap" are two different things.
   **The rejected files must never count as other copies of this episode** (the fate of `losers` is deletion by quality, but they are **other episodes**):
   leave them in the pool as-is, for their own episodes to claim.
   > Live verification (2026-08-01 Yile): the bucket for issue 005 (5808s) contained `怡乐播客 - 005.身边那些灵异事.mp3`
   > ("Yile Podcast - 005. those supernatural events around us") (0.571, only diluted by the sharer's prefix) + `玄关笔记/05.太极两仪生四象.mp3` ("Xuangguan Notes/05. Taiji gives birth to two forms, two forms give birth to four images") (0, another program's episode).
   > Treating it as "multiple candidates" made even the exact-name file fail to match and accumulate into a question, while the position it occupied made the true issue 05
   > keep waiting in `swap-hold` for human approval.

**The duration stage never records missing files** (`missingEpisodes` is still produced only by `epnum`): a duration miss only means "this stage has no signal",
not "this episode has no file" — the filename chain has not run yet.

## Three Thresholds, Each Governing One Thing

Normalize before comparing titles. **The cleanup policy is split by side; do not merge the two sides into one**:

| | What it is | How to clean it |
|---|---|---|
| Right (`SpecRight.name`) | The **absolute path** of the netdisk file (`plan.ts` intentionally passes it this way: source and library often contain same-name files) | First strip directory and extension (`fileBase`), then run `titleStrip` |
| Left (`SpecLeft.title`) | The **episode title** in the program list — not a path | **Only run `titleStrip`** |

The strip-directory/extension cut **belongs only to the right side**. Applied to titles, a normal `/` inside a title is cut down to the last segment
(`你有多讨厌男朋友/女朋友（6）` ("how much do you hate your boyfriend/girlfriend (6)") → `女朋友（6）` ("girlfriend (6)")), and an ending that looks like an extension is stripped
(`…2026.3.21` → `…2026.3`; `putt.day` → `putt`). **It does not error; it only lowers similarity** —
the symptom is a fake ambiguity where "duration matches, but the name shares no characters", while that file also appears as a noise candidate on
question cards for **other episodes**. Live verification: Chundian's true value 0.959 was compressed to 0.244, below the name floor (0.3).

The order also cannot be swapped: `fileBase` must run **before** `titleStrip` — most key regexes for the stages have anchors,
so `^0*(\d{1,3})` cannot read the episode number when it sees the `/quark/…` prefix, and `(\d{1,3})$` cannot read it when it sees the `.mp4` suffix.
This holds for **both the similarity path and the key extraction path** (the number extractors for `epnum`/`episode-part` are also split by side).

The common finishing steps on both sides: apply every regex in `titleStrip` (`g`, one rule strips **all** hits), strip **leading episode numbers**,
remove whitespace, and lowercase. Similarity is **bigram (adjacent two-character) overlap**, not edit distance.

| Threshold | What it governs | What happens if it fails |
|---|---|---|
| `threshold` | The most similar candidate must reach this line | No match, and if this stage is `epnum`/`episode-part`/`season-episode`, it is recorded as **ambiguous** |
| `margin` | First place must lead second place by this much | Same as above. This prevents blindly choosing one when both are fairly similar |
| `AUTO_SIM = 0.8` (hard-coded) | Whether a match is `auto` or `pending` after it is matched | It is matched, but marked `pending` for your confirmation |

**Two special cases; without knowing them, the result is hard to read**:

1. **Structured key + unique candidate → claim directly, without checking threshold** (`episode-part` / `season-episode`).
   The key itself is disambiguating evidence. Real regression: the files for King of Comedy S03 are so bare that only `第1期一.mkv` ("issue 1 one") remains, with no comparable
   text, so title similarity is naturally not high — requiring the unique candidate to pass the threshold would reject a certain match for no reason.
   Multiple candidates (a real collision) do not get this special case and still require similarity to disambiguate.

2. **The `title` stage does not record ambiguous when similarity is insufficient**. It is only a "high-threshold fallback"; if it does not reach the line, treat it as no signal, not ambiguity.
   `epnum` does record it (number hit but title cannot be trusted = real ambiguity). This difference in policy is intentional.
   **But "reached the line and was rejected by duration" must be recorded** (cell 3 in the adjudication table, R14 in `match-engine`): exact equality after cleanup + duration
   differing by an order of magnitude means two pieces of evidence conflict; it is not "no signal" — that case must show a card, or the file silently flows to take-down.

## Multiple Files for the Same Episode

After bucketing by `epnum` / `episode-part` / `season-episode`, a bucket may hold several files. The processing order **must not be reversed**:

1. **Layer by resolution** (probe 4K/2160P/1080P/… from the original file name). This must come first — the default `titleStrip`
   strips the resolution tag, so deduplicating by title first would treat two files that differ only in resolution as duplicates and swallow a whole layer
2. **Verbatim dedup within a layer** (identical title = watermark/save duplicate); keep the larger one
3. **Pick the main feature across layers**: once each layer has converged to a single winner, the largest one becomes primary and the rest are **deletion candidates for organize**
   (only the highest-quality copy of an episode is kept; for how to adjudicate see "Why a same-episode copy is deleted / why it is replaced" below).
   If any step cannot separate them, the whole group stays as candidates and is handed to title similarity
4. **An exact name match overrides size**: when the file selected by size in step 2/3 does not even touch the name floor (`DURATION_MIN_SIM`),
   and **exactly one** of the losing/discarded files has a name that exactly equals the listing (`identity-exact`), the exact-name file is the real one
   and the size winner is demoted to a same-key copy. Size can only choose between different releases of the **same content**; if one name matches exactly and the other scores 0,
   the pure-cut/behind-the-scenes file merely shares the issue number plus segment key and is not the same content at all. Several exact matches = true duplicates, and size remains the only ruler

### The Archiver Makes No Episode-Identity Decisions — It Consumes the Verdict of the Matcher Described in This Document

The above describes how the **matcher** picks which file in a bucket pairs with this episode (if it cannot pick, the result is ambiguous and no file is touched).
The **archiver** (`reconcile/plan.ts`) really moves files, but it has **no decision logic of its own**: each round it treats
**source-directory files ∪ paid-shelf files** as the right side and runs the matcher **once** (the same spec as binding sync,
`resolveSpec` in `sync.ts`), then places files on the shelf where they belong according to the verdict. To change "which episode is this file", change
the rules described in this document, and the binding and the archiver benefit together — any "judge it again" inside the archiver is a regression.

**Organize has exactly one goal: put the contents of the source folder into the library.** Each file lands in exactly one basket, and every basket has a verdict —
the machine never throws up its hands and asks "what is this"; it only waits for human approval at the "delete/replace" step:

| Basket | Criterion | Destination |
|---|---|---|
| `claimed` | The matcher paired it to an episode with `auto` confidence (`authority:<leftKey>`) | The `claimed` shelf (= the binding's landing directory; the copy already in the library stays where it is); a file whose name hits a sub-show's `numPattern` lands in that sub-show's folder. **Exception: if that episode has `needsSupply === false` (the source site can serve it itself) → do not move, delete directly** (`delete-redundant`, ledger basis `redundant-free:<leftKey>`); see the second boundary below |
| `copy` | The matcher handed it over as one of the **other copies** of that episode (`SpecAssignment.losers` → `same-episode-copy:<leftKey>`: a same-name duplicate, a different bitrate, a re-cut with a few extra seconds of tail) | The only question is replacement: copy worse/tied → `delete-loser`; better or incomparable → `replace` (delete the old primary + move this one into the target directory). Both go into the "to-delete list" and wait for preview confirmation; **the scheduled round does not do a single step** |
| `offline` | It could not land on any episode: neither its name nor its duration points to any entry of the listing = the listing does not contain it | The `secondary` shelf (for podcasts, the "offline shelf", with source/library files treated alike). Before moving it in, compare it with the copy of the same episode already on the shelf (worse/tied → delete this one, better → replace the one on the shelf, incomparable → `pending`; the card offers two buttons for "which one to keep", and once a person has adjudicated, the system follows what they said). **If this binding has no `secondary` configured** (e.g. film and TV) → the verdict is recorded but **no action is taken**: the file stays where it is and is never deleted |
| `offline` + `pending duration-collision` | The matcher **cannot decide** (`ambiguous`: number collision / insufficient similarity / vetoed by the duration gate / duration hits but the name fails the floor) or **is not confident enough** (pair `status: pending`) — ledger basis `ambiguous:<reason>:<leftKey>` | Not claimed, and not automatically moved to the offline shelf either: it may be another version of that episode (a different bitrate), or merely a different issue with a colliding number. It carries `compare` and is shown side by side for a person to adjudicate, and **never goes into "can complete automatically"**. Answering "no" has an exit, see below |
| `offline` + `delete-redundant` | Not claimed, but **every episode the evidence points to has no need for netdisk supply** (`needsSupply === false`) — ledger basis `redundant-free-candidates:<key1,key2,…>` | Delete directly, **without a card**: whichever of those episodes it is, the disposal is the same, so "which episode is it" is not worth asking. **Zero candidates (the listing truly does not contain it) does not take this path** and goes to the offline shelf as before. See "That flag is called `needsSupply`, not `paid`" below |
| `hold` | Duration unknown (not probed / this round's probe budget exhausted) | `pending`; probing resumes next round. It is a **state, not a question**, and asks nothing of the user |
| `dup` | Same episode + **identical byte count** | `delete-dup` — skips the "to-delete list" preview and is deleted immediately under `autoExecute` (keep the copy in the library, then break ties by `sourcePriority`). **Exception: if that episode is `paid` → degrade to the confirmation tier `delete-loser`**, see below |
| `exempt` | Manual exemption/tombstone (`decisions` table) | Not touched, not reported |

Five boundaries:

- **A `paid` episode is never deleted automatically**. `delete-dup` (identical bytes) is the **only** action in the whole flow that **skips human eyes and is deleted immediately under `autoExecute`**
  — the `losers` switch in `execute.ts` governs `delete-loser`/`replace` but cannot govern this one. And the netdisk copy of a `paid` episode
  may be the **only playable source** (the source site charges = the source site cannot serve the audio itself); deleting the wrong one silences that episode entirely
  and irreversibly. So when that episode is `paid`, the disposal of an identical-bytes duplicate **degrades to the confirmation tier `delete-loser`**: the action semantics are unchanged
  (delete this one, keep that one, with side-by-side data), but the scheduled round never executes it and a person must approve. Free episodes do not degrade (the source site can serve them,
  so deleting the netdisk copy silences no episode).
  The sharpest shape: **the copy that stays is on the secondary shelf** — the secondary shelf does not enter the **main** matching pool, and each round's review (see "The offline shelf is re-examined every round" below)
  only recognizes `auto` hits, so files that were renamed or whose duration was never probed cannot be recognized again. So "the bytes are still there"
  does not mean "this episode still has audio": once the copy on the paid shelf is deleted, the episode may go silent.
  **This gate consults the name-to-episode identity table, which is used only to "not delete" and never to "delete" or "claim"** — this asymmetry is exactly why
  it does not count as a second decision brain (the next item forbids "judging which episode it is **and then acting on it**"): mistaking an episode for one that needs supply costs only one extra
  human approval, and failing to recognize it falls back to the original behavior. No decision layer reads it, so it changes no pairing result. **This gate reads the
  `needsSupply === true` that the listing states explicitly**, and does not apply the conservative default "absent also counts as needs supply" — it only governs "whether a person must nod before deleting",
  and identical bytes mean the copy that stays is byte-for-byte the same; letting absence tip toward "needs a nod" would only make the whole film and TV library click through one by one.
- **Copies of episodes the source site can serve itself (`needsSupply === false`) are deleted directly and do not enter the confirmation tier**. The claim holds, but the source site can serve that episode →
  the netdisk copy is redundant, `delete-redundant` (**no `keptPath`**: what stays is not a file but the source site itself).
  The `losers` switch in `execute.ts` cannot govern it, and the scheduled round deletes it as usual — the cost of saving is very low and the Quark recycle bin is the safety net;
  piling them up into a screen that needs a nod for each one means nobody reads it. So the scheduled notification **must report a separate number for it**: this tier really deletes files.
  The other copies of the same episode are cleared together with the episode (the primary is deleted anyway, so comparing quality again is pure waste).
  **This flag does not apply when absent (film and TV, and any listing that cannot answer)**; the check is always the explicit `=== false`, and absence falls on the
  "needs supply" side; files that are `pending`/`ambiguous`/`hold` are not touched at all — when uncertain, do not delete, and the existing question mechanism is fully retained.
- **All decisions live on the matcher side**. The archiver reads only four states: an `auto` pair → claim; the `losers` of an `auto` pair → same-episode copy;
  a `pending` pair / `ambiguous` → question; none of these → offline shelf. It has **no** duration tier, no name identity table, and no independent
  contradiction gate of its own. **Do not add any criterion of the archiver's own**: if its criterion is a notch looser than the matcher's, the two brains give opposite answers about the same
  file, and playback follows the wrong one (this really happened: the binding took a wrong-identity file of 96–104 minutes for episodes 05/20/37
  with `status: auto`, while at the same moment the archiver said "this is not it" about the same three files). See "How the other copies of the same episode are recognized" below.
- **A duration hit must pass the name floor**: falling within the 1s tolerance is only a necessary condition; the title similarity of the two sides must also be ≥ `DURATION_MIN_SIM`(0.3)
  to count as "corresponds to this episode" (`DURATION_MIN_SIM` in `match-spec.ts`, rule R3). A hit that fails the floor **counts for nothing**:
  that episode falls back to the file-name chain and the file stays in the pool; at the same time the matcher records this hit as an `ambiguous`
  (reason `name-floor`) — **the evidence "its duration hit this episode" must not evaporate along the chain**; downstream relies on exactly it
  to raise the question (`pending duration-collision`, with `compare`), instead of moving the file away as if nobody wanted it.
  Why: for a program of one or two hours, duration collisions are common (in the same batch of 371 files, 530 and 820 are identical to the second at 7707s),
  and "the only one within tolerance" is often just luck. Live shape: `玄关笔记/37.申与酉.mp3` ("Entrance Notes/37.Shen and You.mp3"; 100:44, 320k) collided with episode 756
  (100:43) without sharing a single character of the name — if the archiver were a notch looser than the matcher, it would produce the suggestion "delete episode 756, the real one whose name and duration are both right,
  and replace it with this one", and land it in the can-complete-automatically tier.
  **This question must have two answers** (both are recorded in the `decisions` ledger; the key is always
  a combination of **this episode + this file path**, assembled by the backend. The adjudication entry point is in the **chat**: the agent in the host calls
  `reconcile_decide`, and the HTTP surface is `POST /api/netdisk/reconcile/decisions` with `leftKey` + `path`
  — the same write path, with the ledger backfill hooked in at the `service.setXxx` layer):
  · **"Not this episode → move to the offline shelf"** (kind `not-episode`): next round it goes to the offline shelf as "the listing does not contain it"
  (ledger basis `decision:not-episode:<leftKey>`), the slot is freed, and the file waiting for it lands naturally.
  · **"This is the episode → claim"** (kind `is-episode`): next round it becomes a **pin at the matching layer**
  (`SpecLeft.pinnedRight`, fixing this pair before any stage runs), and the claim and the move go through the one and only path of matcher → archiver as usual. An episode can pin only one file, and it is mutually exclusive with `not-episode` on the same pair; both are guaranteed by `DecisionStore`.
  **Writing a decision never moves a file**: the move is still one move in the next round's preview, and still needs a person to click execute.
  With only "not" and no "is", the user could only push the file away and never say "then which episode is it", and the same question would come back round after round;
  without an exit, the file holding the slot never frees it, and the file waiting for it stays in `swap-hold` forever — the two lock each other.
  It is **not an exemption by episode identity**: with a different file, or the same file colliding with another episode, the question is asked again.
  **The path in the combination key follows the move**: each time execute moves a file, it migrates the paths hit in the three kinds of combination keys (not-episode / is-episode /
  prefer) to the new address (`DecisionStore.migratePath`; undo migrates back) — so after a pending card is adopted and the file enters the shelf, the pin is not lost,
  and the same file does not raise a card a second time at its new path.
- **Content contradiction gate** (rule R11, governing **all** tiers): a name points to some episode, but its **relative difference from the listing's duration exceeds 10%**
  (`CONTENT_MISMATCH_RATIO` in `match-spec.ts`) = a different program wearing this episode's name (a wrong-identity file);
  it is **not a candidate** and is removed before the threshold decision (live shape: a 104-minute wrong-identity file in the 玄关笔记 ("Entrance Notes") directory, named `05`,
  while the listing says 36 minutes — suggesting a replacement for it amounts to suggesting deleting the correct one). When it removes every candidate in a bucket, an
  `ambiguous` (reason `duration-contradiction`) is recorded: the number hit but there was no confidence to pair, which is a question, not "the listing does not contain it".
  Differences within the same order of magnitude but beyond the 1s tolerance (a few seconds of tail / a re-cut of the intro, live 780: difference 0.06%) are "another version of the same episode",
  go to replacement adjudication, and must not be thrown onto the offline shelf — that would become an independent episode colliding by name with the feed (violating "no duplicates by default").
- **Pure-cut gate** (same level as the content contradiction gate, `pureCutMismatch` in `src/netdisk/pure-cut.ts`): the file name carries 「纯享」 ("pure cut") while that episode
  is a main feature in the issue-segment system (title carries 「第N期」 ("issue N") and does not contain 纯享) → **no edge is built** (`vetoReason: pure-cut-mismatch`);
  even when name/issue-segment/duration all match, it is not paired and **no question is raised** — the pure cut is another playback line, and the archiver moves it to `纯享/S<nn>/`.
  Blocking only in the engine is deliberate: sync and the archiver each look at their own decision ledger, so blocking on either side alone cannot stop the other side from recognizing it again
  (six pure-cut talk-show files bearing the `S03E11 - ` prefix were repeatedly recognized as main features). Episodes whose own title carries 纯享 (the listing lists the pure cut as an episode) are recognized as usual.
  The 10% leaves a hundredfold margin on both sides: same-episode variants measure a difference ≤0.1%, wrong-identity files differ by 160%+.

#### How the Other Copies of the Same Episode Are Recognized (`losers`)

An episode has only one primary; the other copies are handed over by the **matcher** (`SpecAssignment.losers`), and the archiver compares quality against them
and produces delete/replace suggestions. They have two sources:

1. **When picking the main feature within one bucket** (`reduceByQuality`): the losers across resolution tiers, and same-name duplicates after cleaning within a layer.
   **Only those with the same name after cleaning are collected** — the same number does not mean the same content: `第7期（一）(二)(三)(四)` ("Issue 7 (1)(2)(3)(4)"), `第5期上/中/下纯享` ("Issue 5 part 1/2/3 pure cut")
   all land in the same number bucket, and absorbing "the whole bucket as the same episode" would mark dozens of different contents as losers, while losers are judged for deletion by quality
   (2026-08-01 full-scale measurement: 喜剧之王 ("King of Comedy") 53 copies, 脱口秀 ("Talk Show") 25 copies). Subtitles/posters are not collected either: after stripping the extension they are
   often named the same as the main feature.
2. **A final pass after all stages have run** (`sweepOtherCopies`): once an episode is paired, later stages skip it entirely, so "this episode has another copy" never gets a chance to be discovered —
   the library copy of live 780 (8279s) fell all the way to "the listing does not contain it" this way and was planned to move to the offline shelf. This pass looks only at files
   **nobody has claimed**, with two criteria: the same name as the primary after cleaning, or
   **a duration within this episode's tolerance that also passes the name floor**. The second criterion holds up the whole same-episode comparison — saved copies often carry
   tails like `（补档）` ("(re-upload)") / `_0412212803`, which the same-name criterion cannot reach.

Live prototype: the listing says `20.七杀` ("20.Seven Kills") is 2389s, the source copy of 2390s is claimed, and the library copy of **6247s** is nobody's → into the offline shelf.

**Only audio/video files enter this pipeline.** Subtitles (`.ass/.srt`), cover images, and `.nfo/.txt/.zip` are blocked at the scan layer
(`scanFiles` in `reconcile/service.ts`, with the check being `EXT` of the shared episode-recognition layer): they take no part in matching, generate no pending noise,
are **never deleted and never moved**, and get no ledger row either (the `input` count does not include them, so conservation still holds).

**Why the destination of "not paired" is the "offline shelf" and not some new directory**: the contracts of the two library directories differ, but their names speak of their origin —
`付费` ("paid") really means "**the ones that must be paired with the listing**" (the matcher looks only here), and `下架` ("offline") really means
"**the ones that are not paired, where the file itself is an episode**": that directory itself is harvested as an alist source
(`packages/alist/normalizer.ts`), and every file in it becomes a playable item directly. So a file that matches no episode of the listing,
if left on the paid shelf, **never gets claimed**; moved to the offline shelf, it is **immediately an independent episode** — not gone, just rerouted.
The offline shelf **does not enter the main matching pool** (pulling it into the main pool for pairing would negate this contract); in the main pool it is used only to judge identical-byte duplicates and same-name placeholders.

#### The Offline Shelf Is Re-Examined Every Round

**The contract is maintained on both shelves continuously, not checked just once at the entrance.** The offline shelf takes no part in claims in the main pool, but each round
`reviewSecondary` in `plan.ts` re-examines it separately with the **same matching brain**: the authority listing on the left, **only the offline files** on the right,
calling the matcher one extra time (the same spec, not a line of the criteria changed). **The verdict is used only for shelf hygiene and is never written back into the main pool's claims**
— the two calls are independent, and the main pool's result is exactly the same whether or not this pass ran (pinned by a unit test).

**Only `auto` hits count**: a `pending`/`ambiguous` from the review always yields no action. The default state of an offline file is "sitting there";
turning old files in the drawer into a pile of new questions would only flood the panel — when uncertain, do not stir things up. After a hit, it forks by the three `paid` states:

| The episode hit | Action | `basis` |
|---|---|---|
| **Needs supply** and nobody claimed it this round | It is back on sale and the offline copy is the only copy → `move` back to the paid shelf (ordinary move tier, can execute automatically) | `relisted:<leftKey>` |
| **Needs supply** and a primary already exists | It is another copy of the same episode → a **confirmation tier** in the shape of `delete-loser` (with side-by-side data); the machine does not delete automatically | `shelf-copy-of:<primary path>` |
| **Does not need supply** | The source site can serve it and the copy has nowhere to live → `delete-redundant` (same rule as in the main pool) | `redundant-free:<leftKey>` |
| No hit | **That is exactly where it belongs**; do not touch it — the vast majority | — |

When a move-back collides with a placeholder (same name / same episode) → no action this round and **no `swap-hold` raised**: the waiting in the main pool is a promise ("it lands naturally next round"),
while the file staying put on the shelf is a perfectly legitimate state that needs no alert to the user. If that episode has other copies on the shelf →
this round moves only the primary one, and the rest naturally take the "primary already exists" tier next round (planning a deletion against a planned position is gambling on
execution order). The review needs a duration to have a primary anchor, so offline files also enter the probe queue — **after the source and the paid shelf**: when the budget is
consumed by the first two sides, the cost is that the review recognizes a few fewer copies, not that the main pool lands a few fewer.

**The ledger gets its own section** (`secondaryReview: { checked, rows }`): the conservation law of the main pool's `rows`/`counts` speaks of
"the files that entered this round's main pool", and offline files by contract are not in the pool; stuffing them in would break the identity. `rows` records only the
copies that produced an action, while those that were checked but not acted on are accounted for by `checked`. The actions themselves go into the same `actions` (the executor does not care who judged an action).

**Paid shelf = `paid` ∧ claimed by the matcher.** Both conditions are required (decided 2026-08-01):

| Condition | About whom | What happens when it is not met |
|---|---|---|
| Claimed by the matcher | The **file** | Matches no episode of the listing → it takes no part in pairing and goes to the `下架` ("offline") shelf (entering it makes it an independent episode) |
| That episode's `needsSupply` | The **episode** | The source site can serve this episode itself (`needsSupply === false`) → this netdisk copy is redundant and is **deleted** (`delete-redundant`) |

**For episodes the source site can serve itself, a netdisk copy has no reason to exist**: the source site's direct link is still there, and the netdisk copy is at most another copy of the same audio.
The cost of saving from a share link is very low and the Quark recycle bin still backs it up, so this tier **does not enter the confirmation tier** — the scheduled round
deletes directly, and the notification reports a separate number ("N redundant copies deleted").

#### That Flag Is Called `needsSupply`, Not `paid`

**Nobody reads `paid`** — not the decision layer (reading it would be a second decision brain), and not the disposal layer either. It lives only to explain the reason:
the phrase "the source site charges" in the ledger, the evidence card, and the authority listing statistics. The flag that really decides stay or go is a different one:

```
needsSupply = this episode carries a playable address of its own ? false : true      // absent = needs supply
```

The criterion is computed on the listing side (`hasPlayableMedia` in `left-from-stream.ts`), and the matching layer and the archiver only consume the verdict.

**The default must be "needs supply"**: deletion is irreversible and keeping a file only costs space, so one dares say "no supply needed" only after **seeing**
a media item that carries a playable address. The reverse (default to no supply needed, supply only once proven) would judge an app-exclusive episode — "the source site gave no address, but it is not paid either" — as
redundant and delete it: `content.paid` has a single injection point in the whole repo (`withPaid` in `content/normalize.ts`) that writes `true` only when `price > 0`
and writes nothing otherwise, so `paid` simply cannot answer "can the source site serve it". Live exposure: 怡楽 ("Yile")
`rsshub-lizhi-user-id-ln6vj` has 167 episodes of this kind (including 948/949), for which the netdisk copy is the only source.

**The criterion recognizes only the `url` of the two playable kinds (`audio`/`video`), not "any url in media"**: the `url` of a cover image
(`kind:'image'`) is a required field but cannot play for a single second. Measured, 3295 items across the whole library (36 streams) are "no playable address,
but media holds some other url", including the netdisk-bound `tencent-talkshow-friends-season3` (210 items, whose media holds only
a cover image) — judged by "any url", that binding's netdisk files would be judged redundant across the whole library. Recognizing only these two kinds is **not hard-coding podcasts**:
any new archetype that can play will land on these two kinds. **Do not switch to `media.resolveOnly`** — that is a marker the normalize
podcast branch sets itself (an implementation detail that only that one path sets); whether an address exists is more fundamental.

Wiring in any new source only requires answering "does this episode carry a playback address of its own" to fill this slot (`LeftEntry.needsSupply` →
`AuthorityEntry.needsSupply` / `SpecLeft.needsSupply`, absent = needs supply).
Two places use it, and in both it only means **do not ask / do not keep**, and never changes a claim:

| Layer | Rule | Result |
|---|---|---|
| Decision layer (`note()` in `resolve.ts`, the single choke point for episode-side questions) | That episode has `needsSupply === false` → record no question | Free episodes no longer raise any episode-side card (`name-floor` / `below-threshold` / `duration-contradiction` all stay silent) |
| Disposal layer (the main loop of `reconcile/plan.ts`) | For a file that was **not claimed**, all of its **live candidates** need no supply → `delete-redundant` (basis `redundant-free-candidates:<key1,key2,…>`) | No card, delete directly |

**Live candidate** = an edge on the file's adjudication trail that qualifies as a candidate (the shared criterion is `candidateWeight`: duration hit ∣ structural key ∣
name passing the `DURATION_MIN_SIM` floor), **minus** fact-level vetoes (`duration-contradict`, `pure-cut-mismatch`) and those a person adjudicated as "not this episode".
The other veto reasons (`left-claimed`/`below-threshold`/`no-margin`) are order- or threshold-based, and the evidence still points at that episode, so they stay.

**Which veto reasons are removed is a single table shared by the decision layer and the disposal layer**: `NON_LIVE_VETO_TO_ASK` in
`match-engine/live-candidate.ts` (defined by the matcher and read by the archiver; the direction cannot be reversed). The invariant is — **an edge removed from the live candidates by the disposal layer
must still raise its question in the decision layer**: that edge cannot reach automatic deletion, so "the answer does not change the action" is false in this tier
(is this episode → swap the primary; is not → move to the offline shelf). **Adding a removal reason = adding a row to this table**, and the two sides follow automatically.
**Do not let each side hard-code a string and point at the other only through a comment** — the symptom is a file silently moved away without a single card
(2026-08-02 怡楽 `112.河南洛阳案.mp3` ("112.Henan Luoyang Case.mp3") / `116.安特卫普金库案.mp3` ("116.Antwerp Vault Case.mp3"), names matching the listing character for character, durations off by 350-odd seconds).

Two guardrails (both guarded by test cases; read that section of `plan.test.ts` before touching this):

- **Zero candidates means no delete.** Not a single live candidate = the listing truly does not contain it → goes to the offline shelf as before. The basis for deletion is "every episode the evidence points to
  needs no supply"; without evidence there is no basis.
- **Absent always counts as "needs supply".** Film and TV bindings (whose listing comes from the TMDb episode index and has no such flag) never lose a single file this way —
  the check is written as `!== false`, absence falls on the "needs supply" side, and no special case is needed.

Live (怡楽): the duration of `玄关笔记/37.申与酉.mp3` collided with three episodes at once and raised a card "is it 《037.三谈身边灵异事》" ("037. Talking Again About Paranormal Events Around Us")
— yet the source site can serve all three episodes, and whatever the card is answered it leads to the same action (delete). **A question that is pointless to ask should not take a single moment of the user's attention**; these two rules take it off the panel.

#### Manual Override: `matchSpec.needsSupply`

The computed flag has cases it cannot reach: the source site gave an address but the address expired long ago; or the quality it gives is too poor to listen to. A person knows and the machine does not,
so there is one entry whose word is final — **`matchSpec.needsSupply`; the default = computed automatically, and when filled in, what is filled in wins**
(`true`: every episode of this binding always needs supply and is never judged redundant; `false`: never needs supply). The override replaces the **whole criterion**:
the main loop, other copies of the same episode, the offline shelf review, and the identical-bytes degradation gate all follow it together.

**It is an escape hatch, not a routine tool — so it has no UI, and should not have one.** It can only be set by passing a complete spec through `applySpec`, and this threshold is deliberate. The
"the address exists but actually cannot play" it is meant to rescue is a problem of **a single episode**, whereas this switch is a **master gate for the whole binding**: once on, all redundant copies of this show are never cleaned up again, and a single-episode problem
is traded for "the whole show permanently leaves automatic organizing". Per-episode rescue already exists and can be reached in the organize panel — exemption / tombstone (`decisions` table) and
`corrected` pinning. **Do not give this flag a button**: with one, it would be used as a routine tool, and the side effects are larger than the problem it solves.
(A to-do item "make it a switch" was rejected on 2026-08-04; among the 16 live bindings, none has ever set it.)

Two design boundaries; read them before touching it:

- **The granularity is the whole binding, not a leftKey list.** The leftKey of a subscription stream is `item:<id>`, and the item id changes with re-harvesting
  (rebuilding with the same id, renormalize, and switching recipe all move it). A list hard-coded by id would **quietly stop working** — the worst way for a protective
  switch to fail is "looks like it is still there, but no longer protects". A whole-binding cut has no key to rot. Rescuing a particular file per episode
  goes through other entries (exemption/tombstone, `corrected` pinning), not this switch.
- **It lives in `matchSpec`, not in the stream config.** Whether to supply varies precisely by binding (the same stream bound to different directories
  may have different policies); the stream config answers "how is this source harvested", which is a different matter.
- **It survives `resolveSpec`'s re-resolution.** An inventory default spec (without `generatedBy`) is thrown away whole every round and re-resolved to
  the current default — that rule holds for the **criteria** but not for this flag (it is the user's intent itself). And the vast majority of bindings use exactly the inventory
  default, so `resolveSpec` explicitly carries it over; without that, the symptom is "the switch was flipped, but next round still follows the computed value".

### How the Archiver Degrades When Its Input Is Distorted

The sections above are about "whether the decision is right". This section is about something else: **when the input of the decision itself cannot be trusted, the action must degrade,
and the degradation must be visible** — neither taken at face value nor silently skipped. Four guards, each protecting one link.

#### 1. The Authority Listing's Health Gate (Blocks Only the Scheduled Round)

Before planning, compare this round's listing with the listing **recorded in the baseline round's ledger** (`gateAuthority` in
`reconcile/authority-gate.ts`). The two numbers come from independent sources: this round's from `listLeft`, the baseline's from `reconcile_runs`, so the comparison is meaningful.
Four criteria; if any hits, the whole show drops to the observe tier for this round:

| `gated.reason` | Criterion | Constant |
|---|---|---|
| `authority-empty` | The listing has no entries at all (`entries === 0`). **History is not consulted**: an empty listing would judge the whole library "the listing does not contain it" | — |
| `authority-truncated` | The listing itself reports that it was truncated at the limit (`AuthorityListing.truncated`) | `AUTHORITY_ITEM_LIMIT` (`left-from-stream.ts`) |
| `authority-shrink` | `entries` is ≥10% **or** ≥5 entries fewer than the baseline | `SHRINK_RATIO` / `SHRINK_ABS` |
| `authority-flip` | The episodes with `needsSupply` true are ≥10% **or** ≥3 entries fewer than the baseline | `FLIP_RATIO` / `FLIP_ABS` |

The empty-listing rule is a **floor** that needs neither a baseline nor history: if the very first run is empty, it is gated all the same. The other three take the "or" of ratio and absolute count:
the ratio lets small listings through, the absolute count lets large listings through, each blocking one end. The flip rule's threshold is lower — `needsSupply` is the sole basis of
`delete-redundant`, so its drop deserves more watching than the listing's own. If the baseline ledger row has no `needsSupply` flag
(a later-added field), **this rule is not compared**; do not count absence as 0 and produce a false flip. No baseline → apart from the empty listing, nothing is compared and the run proceeds as usual.

**The baseline is the most recent "accepted" run, not the most recent run**: only **scheduled rounds that were not gated** and **manual executions**
(an execution a person clicked after viewing the preview) qualify as a baseline; **manual previews and gated rounds never count as a baseline**.
Why it must be defined this way: every time the panel expands a show it POSTs a preview, and those previews write the shrunken numbers into the ledger —
taking the "most recent round" as the baseline, a shrunken listing would become the new normal as soon as the panel is expanded, and the gate would let the next round through by itself, when that is exactly
the round it exists to block. The `trigger` on the ledger row (`'scheduled' | 'manual'`) plus whether there is a `gated` is all the basis for judging "does this round count as a baseline".

**A gated round is still recorded in the ledger**: `mode` is `preview`, the actions that should have been executed are all recorded in `actions` without omission,
and the run row gains a `gated: { reason, detail }`. **How to read a ledger row**: `counts` and `autoExecute` alone
cannot tell "moved" from "would have moved" — the two rounds look identical, and the only difference is whether the `gated` slot exists.
To judge from the ledger whether files really moved, look at it. The `trigger` (`'scheduled'` / `'manual'`) on the same row answers
a different question: was this round scheduled or clicked by a person. The two together determine whether "this round counts as a baseline" (see below). The notification headline states the difference together with "how much would have moved"
("the listing changed (the listing shrank from N entries last round to M), this round only observes and does not act — X moves and Y deletions were not done"),
because saying only "the listing changed" leaves the user unable to judge what this round dodged.

**There is no automatic recovery; the exit is a person**: if the listing really did get smaller, it will **block every night as usual** (one deduplicated warn notification per show, no spamming)
until the user runs a **manual execution** — that round becomes the new baseline, the next day's scheduled round compares against it, the difference is within the threshold,
and it is let through naturally. This is deliberate: the machine cannot tell "the harvest broke" from "the listing really lost half its entries", the numbers look identical,
and being wrong once costs a whole batch of files moved to the offline shelf. So the recovery step needs a person to press the button, and the gate does not press it for them.

**Manual execution and manual preview never pass through the gate**: the user has seen the preview with their own eyes before clicking execute, which is the human-eye confirmation of that round.
The gate is evaluated only in `runScheduled`, and only for shows with `autoExecute`.

#### 2. Verify the Size Before Deleting

For the three kinds of delete, and for deleting the old primary inside `replace`, before `remove` do a **single-level `refresh`** listing of the target directory and compare `size`
(`staleBeforeRemove` in `execute.ts`). If they do not match, do not delete; the error rows look like this:

```
delete <path>: stale: expected 12345678 got 12300000      # still there, but the content changed
delete <path>: stale: expected 12345678 got missing       # no longer there
delete <path>: stale: expected unknown（replace has no compare, refusing to delete）
```

The third is **not knowing how large it should be**: the size of `replace`'s old primary is taken from `compare`, and without `compare` there is no number to compare,
and reporting `expected 0 got N` would read as "the file changed", so it explicitly says "unknown". In all three cases **nothing was deleted**; it is not a delete failure.
Moves are not verified — a name-collision 403 is loud on its own.

**Why deletion must be verified and a listing does not count**: with OpenList mounting Quark, `fs/remove` on a name that **does not exist at all** still
returns `code 200 success` (live, 2026-09-03). That is, "the directory listing says it is there" is not evidence of existence, and "remove reported no error"
is not evidence that the delete succeeded either. The verification is the only step on this path that can grow eyes by itself.

#### 3. A Half-Written File Counts as Unknown

A file with `size === 0` or below `MIN_MEDIA_BYTES` (1 MiB), or one that the source declared `inProgress`
(`isSizeSuspect` in `plan.ts`) is judged `hold`, `basis: 'size-suspect'`, and its `pendingKind` is `no-duration`.
It **does not enter the matching pool and does not enter the identical-bytes signature table** (neither the main pool's nor the secondary shelf's) — two half-written files of the same episode
may happen to have equal byte counts, and entering the signature table would mean "the same copy" and delete one.

`hold` is a **state, not a question** and asks nothing of the user: next round it has finished arriving and naturally enters the pool. A file that is being saved or uploaded should
look exactly like this.

#### 4. After a Batch Move Fails, Read Back the Current State

After a batch of `move` throws, read back the source directory (`refresh`); every name that is no longer in the source directory is recorded as a success for provenance and its decision keys are migrated,
and only the rest go into the error rows. Without the read-back, the symptom is **human adjudication silently stops working**: the next time the few files that were actually moved are seen, their decision keys are already lost.

Execution is **idempotent**: any round can start over from the current state, and the planner depends only on the current state + the ledger, not on "what was done" last round.
Do not introduce a skip mechanism such as a "processed list".

#### The Shelf Self-Description Table: Source Differences Are Declared by the Source Itself

The planner **reads only one self-description table and does not recognize source types** (`ShelfTraits` in `shared/netdisk/shelf.ts`). Adding a kind of file source
means implementing five operations (list / create directory / move / delete / give a direct link) + filling in this table, and the planner changes not a single line; a missing field is a compile-time
missing-field error, not a silent one.

| Field | Which planner branch consumes it |
|---|---|
| `caseSensitive` | The placeholder criterion. On a shelf with `false`, comparison folds to lowercase, and `A.mp3` and `a.mp3` count as same-name placeholders |
| `hasTrash` | The deletion tier. With `false`, a same-episode copy changes from `delete-loser` to a confirmation tier carrying a ` no-trash` marker, and `delete-redundant` carries `noTrash` — on a shelf where deletion cannot be undone, a person must always nod |
| `listingIsLive` | Whether to `refresh` before planning. **No consumer yet**: today the three-sided scan unconditionally uses `refresh:true`; this flag records a fact (OpenList has a 30-minute directory cache), and no code branches on it yet |
| `reportsInProgress` | Whether the source can carry `inProgress` on an entry. **No consumer yet**: `isSizeSuspect` reads `RFile.inProgress` directly and does not ask whether the shelf declared it |

OpenList's self-description is `OPENLIST_TRAITS`: `{ caseSensitive: true, hasTrash: true, listingIsLive: false,
reportsInProgress: false }`. `AlistClient` is today the only `FileShelf` implementation, with `id === 'openlist'`.
A set of contract tests (`shelf-contract.ts`) runs the same cases against a fake shelf and the real `AlistClient` — if the two implementations drift,
it is the one that raises the alarm.

#### Decision Keys Carry the Shelf ID

For the five kinds of decisions — exemption / tombstone / not this episode / is this episode / which copy to keep — the key is `fileKeyOf(shelfId, path)`
(`reconcile/decisions.ts`), and `DecisionStore` is bound to a `shelfId` when built. The same relative path on two shelves is not the same file; without separating them, they would knock out each other's pins.
The key format lives in that one function only, pinned by a guard test.

**Changing the id of a shelf already in production = its existing decisions all lose their pins** — the assembled keys no longer match, and the symptom is "the 'stop reminding me' the user clicked
quietly stops working", with nothing shouting about it.

### Three-Layer Division of Labor: Who Supplies the Listing, Who Produces the Audio, Who Moves the Files

The object of organize is **one binding** (`{claimed, secondary?}`): the `claimed` shelf (= the binding's landing directory
`right.path`) is always present for podcasts and film/TV alike; `secondary` (the podcast "offline" shelf) and `sourceDirs` (the staging area)
are both **optional** — configuring neither gives **in-place mode**: pick winners only among the files on the `claimed` shelf itself and judge the losing copies for deletion,
with no moves. One-click film dedup is this degenerate configuration, not a second implementation.

| Layer | What it does | What it holds |
|---|---|---|
| **Authority listing** | Gives "which episodes this show/work has" (for podcasts, plus the paid flag) | The **program-schedule layer** of a stream, or the TMDb episode table |
| **Resolution** | Turns (paid) episodes, and entries in the listing that carry no playback link, into audio/video that can really play | The **binding**: its landing directory is the `claimed` shelf |
| **Organize** | Moves staging-area files into the two shelves + picks the best among same-episode copies and judges losing copies for deletion — **this is the only operation** | The source directory (when `sourceDirs` is configured) or the shelf itself (in-place mode) |

**One stream = program-schedule layer ⊎ shelf layer, and the authority listing takes only the program-schedule layer.** The program-schedule layer = entries from outside (the source site's
feed); the shelf layer = entries produced by the **netdisk member** (`alist`) on this stream — this is how the offline shelf comes in
(the `alist-audio` source scans that directory), and every file scanned is directly a playable entry the user can open. When taking the authority, the source ids of the netdisk members are computed from the member table
and the entries they produce are removed (`authorityFromStream` in `src/netdisk/left-from-stream.ts`).

**Why they must be removed**: letting the shelf into the program schedule = copying the answer into the question. Organize has just judged a file offline and moved it into the offline shelf;
the next harvest writes it back into the library; if the authority took everything as is, this file would flow back as "an episode on the schedule",
and the archiver could never again tell it was already taken offline. Only "whether it enters the authority" is removed — the shelf layer is still a playable entry and is still in the UI as usual,
and that `alist` member is mounted deliberately; do not tear it down.

#### The Authority Listing's Data-Source Contract

**The authority listing is taken only from the storage layer** (the `itemStore` shape — what the library actually stores). **The playback projection never enters the organize pipeline**:
`/api/items` carries a serve-time projection (`src/content/paid-playability.ts`, `video-playability.ts`), and
when a paid episode is not yet paired in the netdisk, the whole audio is replaced by a cover image — the duration and `track_id` vanish with it. It answers
"what the frontend sees right now", not "what the library stores".

This contract is enforced by the **type system**, not by memory: the projection produces `PresentedItem` (`src/content/presented-item.ts`),
which cannot be assigned back to `StoredItem` in the type system, while the two entry points of `src/netdisk/left-from-stream.ts` accept only `StoredItem`.
Feeding the projection's product in is a compile error, not a false conclusion discovered at runtime.

**To inspect the authority listing as the organize pipeline sees it, use these three doors** (read-only, on the same data-fetching path as preview; each returns the listing itself
+ the four numbers `{ entries, paid, withDuration, needsSupply }`, on the same footing as the run ledger). Use them when debugging,
and do not count durations on `/api/items` — what you count there is necessarily false:

The listing also reports **whether it is complete itself**: `source` is the name of the fetch entry (`stream:<id>` / `tmdb:<id>`), and `truncated:true`
means the **fetch** hit `AUTHORITY_ITEM_LIMIT` and there is more behind it — **the absence of this field means "complete"; it never writes false**.
It is judged from the raw count fetched, not from the filtered `entries` (after the shelf layer and muted entries are removed, the count is naturally below the limit).
Why it exists: the archiver judges "offline" with exactly "the listing does not contain it", and when the listing is incomplete that statement is wrong. Truncation always drops the **oldest**
batch (the fetch takes `AUTHORITY_ITEM_LIMIT + 1` entries newest-first and then reverses them back into ingestion order), not the most recently ingested.

| Door | When to use |
|---|---|
| `GET /api/netdisk/reconcile/:show/authority` | This stream has already been configured for organize |
| `GET /api/netdisk/reconcile/bindings/:bindingId/authority` | The film/TV in-place mode (no show config) |
| `GET /api/netdisk/reconcile/streams/:streamId/authority` | **Nothing configured yet** — neither a show nor a binding |

The third door is opened for "**should this subscription use organize, or is what is in the netdisk actually a different batch of programs**": the criterion is `stats.needsSupply` (the number of episodes the source site lists but
cannot serve itself; only when >0 is there something to pair from the netdisk). The first two doors both require a config first, and the config is exactly what the user has not yet decided whether to
build, so they cannot answer this question. On the UI side it is the sentence at the top of the netdisk drawer (`NetdiskAdvice`) —
**the frontend does not count by itself**, because the `/api/items` playback projection would make it count a false conclusion.

**There is only one matching mindset, with two callsites**: binding sync (`sync.ts`) and organize (`plan.ts`) both call the same engine
(via `match-engine/adapt.ts`; organize additionally reads the residuals, the file-side questions, and the trail in the verdict).
It runs this flow when the user supplies a source; playback/display never touches it.

**Ownership follows (spec §6 P8)**: the addresses of the two shelves each have their own source of truth, and **the organize config does not store them** —
paid shelf = the binding's `right.path`, offline shelf = the directory scanned by the shelf layer's `alist` member (`offlineDirOf` reads
the member table live). Organize resolves them fresh every round (`ReconcileService.shelvesOf`). If they cannot be resolved (no binding / the subscription has no offline source yet /
the address collides with the source directory), **stop and report an error** and do not substitute a path from elsewhere: a directory that no member scans means files moved in would not be playable,
would be in no listing, and would effectively vanish from the user's sight.

Four invariants:

- **A sub-show's `numPattern` only chooses the destination and does not exempt matching**: hitting it merely switches the landing point of `claimed` from the paid root to that sub-show
  folder; whether the file is that episode is still decided only by the matcher. Do not turn it into a pre-pass of "claim on a name hit" — that would be
  a second decision brain: a wrong-identity file would be claimed by name and left in place, and the correct one would sit in `swap-hold` forever waiting for a slot that never frees (deadlock).
- **`durationS === undefined` means "not probed", not "duration wrong"** — it can only go to `hold` and never to `offline`.
  Otherwise a single expiry of the Quark credential could move a whole batch of good files off the shelf.
- **Never move into a directory that already has a file with the same name or the same episode**: same name is on the execution side (`executePlan` groups moves by
  `(srcDir → dstDir)` and the order between groups is not guaranteed, so "A moves out + B moves in" in the same round collides on name with a 403); same episode is on the
  semantic side (if the shelf already holds a copy of this episode — even one awaiting adjudication — moving in a second copy yields two copies of one episode, violating "no duplicates by default".
  Same-episode is judged by the episode-identity key, not the literal file name: copies decorated with 【】 are caught too). Both degrade to
  `pending swap-hold`, and next round, once the other side has freed up, the file lands naturally. The archiver runs periodically, so the cost is only one extra round.
- **When the placeholder is to be deleted unconditionally this round, the waiting file lands in the same round** (slot swap, `freeSlotPass`): a degraded
  `swap-hold` is promoted back to `move` and carries `evicts` (the precondition is which file). The executor **deletes first, then moves**,
  and when that precondition step fails (the delete fails) the move does not run either — without this, a name-collision 403 is certain.
  Three gates: only `delete-dup` / `delete-redundant` count as placeholders (`delete-loser` is a confirmation tier that the scheduled round
  skips, and listing a move that waits for it under "can complete automatically" would be a lie); only one waiter may be blocking it; and the target directory **at the end of this
  round** has neither a same-name nor a same-episode file (recomputed as "what remains after the deletes", not by consulting the placeholder table from before the action — the placeholder
  itself is in that table, so a lookup would always hit).
  **The secondary shelf is an exception**: there is no "freed next round" there (no round will ever move away the copy on the shelf), and waiting would just be a
  zombie slot that never frees — so before a file judged offline is moved over, it is first compared with the copy of the same episode already on the shelf for the **better** one (see the `offline` row in the table above).
- **A file that is about to be deleted this round carries no "move in" action**: when a file is chosen as the `oldPath` of a `replace`, its
  own `move` and `pending swap-hold` are both withdrawn to no action (the ledger row stays, `action: none`, conservation unchanged).
  Otherwise the ledger contradicts itself: the same file is both "deleted this round" and "moved in next round", and the group "waiting to land next round" would contain
  files that no longer exist this round. `no-duration` / `suspect-dir` are a different matter and are unaffected.
- **Disposal of a same-episode copy is always a confirmation tier, and the scheduled round never deletes it by itself**: when several copies of one episode all match (e.g. the library copy
  with a few extra seconds of spoken tail), the matcher picks the one that occupies the shelf by size/resolution, and the losing copy goes into the `copy` basket → worse is judged `delete-loser`,
  better is judged `replace`, and when no difference can be told the direction is adjudicated by the program schedule. Both go into the "to-delete list" to wait for preview confirmation — `autoExecute`
  governs moves and identical-byte duplicates but not this class, and deletion must first pass a pair of human eyes. See "Why a same-episode copy is deleted /
  why it is replaced" later for details.

Each round also records one **run ledger** (the `reconcile_runs` table in `netdisk.db`, also included in the preview/execute response):
exactly one row per file entering this round (including no-action ones) + `conservation` (`input === the sum of the baskets`, self-proved by code) +
`authority` (listing entry count / paid count / duration coverage / number of episodes that need supply) + `errors` (probe failures, AList errors). **Look at it first when debugging**,
without digging through backend stdout. For the design see
`internal design record`
and `internal design record`.

## Where a subscription's netdisk settings come in

**One entry point: the netdisk panel** (`app/src/components/netdisk/NetdiskPanel.tsx`). The "Netdisk" item in a
podcast Channel's menu and the hard-drive icon in the subscription header open the same panel. The panel has
two blocks, which are **the two ends of the same conveyor belt**, and
**each writes back to its own source of truth**:

| Block in the panel | Which end | What it reads | Source of truth |
|---|---|---|---|
| Organize | The intake end | The organize config (where the files recognized in this round get moved on the shelf; attached one-to-one to the binding below through `bindingId`) | `reconcile_shows` |
| Pairing status | The output end | The binding (which netdisk directory faces this subscription's episode list, and which episodes are matched one by one) | `MappingStore` |

**What is merged is the entry point, not the data.** The two stores have separate responsibilities; merging them into one table
mixes the two layers together, and afterwards nobody can say which layer a given number
came from. The line at the top of the panel, "whether to use organize, or the netdisk holds a different batch of shows", is described above in "Data-source contract of the authoritative list".

**This panel does not write the organize config.** The source directory is a one-time intake, not a long-term setting of this subscription — changing the directory = opening a new
round of organizing, which goes through the conversation (the AI calls `reconcile_open`, which sets up the two shelf directories, the binding, the delisted source, and the config
atomically in one action, and rolls everything back if it fails). Do not add a config form to the panel: it would be a second write-back path, and it would certainly have half the validation and rollback of the backend
one, leaving behind half-finished states such as "binding created, delisted source not filled in" — files judged as delisted get moved
into a directory nobody scans, which from the user's side means they simply vanish.

**Subscribing to a netdisk directory as a show source does not happen in this panel.** It is an ordinary "Add source": pick the `alist-audio`
source (titled "网盘目录（音频）" ("Netdisk directory (audio)")), fill in `path` (this parameter is declared in the manifest with `widget: netdisk-dir`,
so the frontend shows a directory picker rather than a text box). What it writes is the **subscription's member table**, which has nothing to do with this conveyor belt.

"Which subscription this organize config belongs to" is **one criterion, one implementation** (`showsForStream` in `app/src/lib/reconcileShows.ts`): the organize config does not record the subscription itself, only a bindingId, so it has to detour through the binding's `left.streamId`.
The summary block in the panel and the organize dialog's own filtering use the same one — two copies would drift into "configured in organize, but the panel says not configured".

**Movies and TV use the same panel, just in a different mode**: a title is one binding with no subscription, so `bindingId` is passed instead of
`streamId`. In this mode the organize block becomes "Organize this directory", and the suggestion line at the top does not appear — it is computed from the subscription's episode list
(`needsSupply`), and that number does not exist here.

**The organize panel (`ReconcilePanel`) has the same two modes**: the `bindingId` mode does not read the organize config, does not pick a show, and does not show the
"never configured for organizing" state (all of these are show things); preview/execute go through `bindings/:id/preview|execute`.
**The pending-decision cards exist in this mode too** — they consume only the output of preview, regardless of where the config comes from. The movie/TV
"one-click dedup" lives in this panel; there is no separate menu item for it.

### A subscription with several directories attached: the row in the table is "merged"

A subscription can have **several** bound directories (the "paid" + "delisted" pair such as 春典/怡乐 (Chundian/Yile)). The pairing table **merges** the records of the same list entry
under each binding **into one row**, taking one of them as the representative (`best` in `mergedEntries`,
`app/src/components/netdisk/NetdiskBindings.tsx`). That row decides not only what is displayed but also
**which binding "Edit" writes back to and which directory browsing starts from** (`setId`).

**The first criterion for picking `best` is "does it hold a file", not "has it been manually corrected".** When an entry that was paired in A is
rebound to B, **both sides get marked as manually corrected** — A is cleared (`rightFile` becomes null, and `corrected.autoFile`
records the one that was originally auto-paired), and B receives the file. Looking only at `corrected`, the two sides tie, and a tie broken by binding order takes the first one,
which is **the cleared one**: the rebinding clearly succeeded, yet the table shows "unpaired", and the next click on "Edit" goes back to A.
The data is right and the UI lies — this kind of bug raises no error; it only makes people think the operation did not take effect, so they do it again.

## Claiming a folder

The only entry for connecting an existing folder on the netdisk to a subscription: Channel → netdisk panel → open organize → claim. You pick only the folder; the library directory
and name are derived by convention (`<mount root>/From Stream/<show name>/付费` ("paid"), and the sibling "下架" ("delisted") directory follows the derivation); submitting
creates the binding and writes the archive config, while file moves still go only through preview → execute. For the design and its boundaries see
`internal design record`.

## How to configure rules for a binding

**Always preview before apply.** preview returns a `changed` array, each element being `{leftKey, title, from, to}`.

```
POST /api/netdisk/mappings/<id>/spec/preview   {"spec": {...}}
POST /api/netdisk/mappings/<id>/spec/apply     {"spec": {...}}
```

**The spec is written in conversation**: tell the model "this binding still has a residue, adjust the rules", and it uses `netdisk_bindings`
to find the binding, `netdisk_residue` to read the residue (left items that did not match, right files nobody uses, manually corrected samples), writes a
MatchSpec itself, and dry-runs it with `netdisk_preview_spec` to look at `changed`; once you approve, it calls `netdisk_apply_spec`.
If you are not satisfied, let it keep revising — this is a loop that can go back and forth for several rounds, not a one-shot decision.

**Criteria for reading the preview**:

- `from: null → to: "文件名"` ("file name") = newly paired. **Most likely good, but not automatically good** — check
  whether the file name in `to` really corresponds to this episode. Stripping a prefix/suffix may drop
  duplicate copies, which were told apart by that prefix, into the weak-signal `title` tier, where bigram similarity wrongly pairs them (for a real case see "Shared episode-recognition layer":
  after adding a prefix strip to the 怡乐 (Yile) binding, `878.五十谈身边灵异事` was paired with the completely different episode number
  `137.十谈身边灵异事.mp3`). **The criterion is whether the episode numbers match, not the fact that it "went from null to something"**
- `from: "A" → to: "B"` = **an existing pairing was broken**. Unless you are exactly fixing a wrong pairing, this means the rule is too broad; stop
- A number of changes far beyond expectation = the rule is too broad

Rules are data, written into the binding, and can be changed back at any time — but an applied rule recomputes coverage immediately.

## Troubleshooting: a file did not match, how to investigate

First tell apart three kinds of "does not line up"; their fixes are completely different:

| Symptom | Meaning | Fix |
|---|---|---|
| The left item is in `unmatchedLeft`, and the right side has **no** corresponding file | The netdisk really does not have this episode | Not a matching problem; go add the file |
| The left item is in `unmatchedLeft`, and the right file is in `orphanFiles` | **Both sides have it; they just do not line up** | See the tier-by-tier check below |
| Only `orphanFiles`, with no corresponding entry on the left | The episode list never had it (extras / bonus episodes / wrap-up / 纯享 ("pure-cut")) | Normal; ignore |
| All actions for a whole source directory become `pending`, with the reason `目录疑似认领错误` ("directory suspected wrongly claimed") | suspect-dir circuit breaker (`suspectDirPass` in `plan.ts`): more than half of the files in that directory are "going to the delisted shelf + not lining up", and there are at least 5 | **First look at what the directory holds** (`netdisk_browse`), then sort it into one of the three cases below. The circuit breaker persists no state |

#### The three cases after the circuit breaker — look at the directory first, do not ask a person first

The circuit breaker says **one thing** ("what does this directory actually hold"), not N pending questions to adjudicate. The hundreds of `pending` entries underneath it
are copies of the same judgment, and **adjudicating them one by one is the wrong action, not just a slow one**. What a directory holds is a fact you can look up,
so the first step is always `netdisk_browse` on that directory, not throwing the question at the user. After looking, sort it into one of these:

| What you see | What it is | Fix |
|---|---|---|
| It holds **a different show** | The directory really points to the wrong place (common when pointing at a parent directory that contains several shows) | Change the binding's source directory; do not adjudicate |
| It holds **this show, but all extras / compilations / bonus episodes** | The directory is not wrong; **the episode list does not cover this batch of content** | Do not adjudicate, and do not copy as-is — copying would send the whole batch to the delisted shelf. Put the finding in front of the user and let them decide how to place this batch (for example, a separate subscription whose episode list is the batch of files itself) |
| It really holds **the main episodes of this show**, just unmatched | They genuinely need to be judged one by one | Adjudicate manually one by one (on the agent side, page through them with `expandDir` of `reconcile_status`) |

**The second case is the one most easily mistaken for the first.** Live sample: a directory tripped at 349/491, whose 10 top-level subdirectories were all paid extras such as
plus / 大醉酒馆 ("Drunken Tavern") / 纪念专辑 ("commemorative album") / 纳凉故事 ("cool-evening stories") — every directory name carried this show's name, and there was not a single main episode.
Treating it as the first case and "changing the binding" produces nothing (there is no better directory to point to), while treating it as the third case and adjudicating one by one turns a placement problem
into 491 episode-recognition problems.

**The numerator of the circuit breaker includes `duration-collision`**: its bucket is `offline` (not landing on any episode), and semantically it really means
"cannot be recognized as belonging to this show". So when files with colliding durations appear in a directory in bulk, the circuit breaker trips more easily than when counting pure `offline` —
**the criterion is not loosened because of this**: the cost of oversensitivity is only one more question, whereas a missed call means files get moved wrongly in bulk.

**The third case is the bulk of it; do not treat it as a bug.** Most of the 165 orphans of 喜剧之王 (King of Comedy) are derivative content that does not exist in the TMDb
episode table at all.

**The archiver (reconcile) moved a file to the wrong shelf** — the archiver does no episode-recognition judgment; it moves files according to the matcher's conclusion
(see "The archiver does no episode-recognition judgment"), so the fix is at this document's layer: the binding's `titleStrip`/`epNumRegex`
(recognition/grouping) plus the stage thresholds in the spec. **First read that round's run ledger** (the `reconcile_runs` table in `netdisk.db`,
or the `ledger` in the response):
one row per file, with `basis` saying why it landed in that bucket, which is much faster than guessing from file names.

### Both sides have it but they do not line up — check tier by tier where it is stuck

Use `netdisk_residue` (MCP) or `GET /api/netdisk/mappings/<id>` to get `unmatchedLeft` and
`orphanRight`, pull out the pair in question, and ask from top to bottom:

-1. **Do the durations on both sides match? — Ask this first; it is the main anchor.** Each `unmatchedLeft` entry carries its own `durationS`
   (none = the source site did not provide one, so this tier naturally does not apply to it; skip to question 0). If it has `durationS` but did not match,
   there are only four possibilities; check them in this order:
   - **The right-hand file had no duration probed**: AList not configured / direct link 412 (Quark `__puus` expired) / ffprobe probing failed
     all silently degrade to "no duration"; it may also be that **this round's probe budget (200 new probes) ran out**, in which case sync once more.
     Check: whether the `durations` table in `netdisk.db` has the key `<byte count>:<absolute path>`
     (a value of `null` = a negative cache of a probe that was made and failed; **renaming the file does not invalidate it; it is re-probed only when the byte count changes**).
   - **The difference exceeds 1s**: the tolerance is exactly 1s (the order of magnitude of encoding remainders for the same episode). A larger difference is basically a different episode —
     do not rush to adjust the tolerance; first confirm that these two really are the same episode.
   - **A collision**: several files all fall within the tolerance (common for shows whose whole season has equal-length episodes), and the titles cannot tell them apart either → recorded as ambiguous,
     which is **by design**; forcing a pairing is not allowed. Move on to check the file-name rule chain.
   - **The name did not clear the floor**: unique within the tolerance, but the title similarity of the two sides is &lt; `DURATION_MIN_SIM`(0.3) → **deliberately not paired**.
     Check: compare the two normalized titles; they share almost no adjacent character pairs. If you are sure these two are the same episode
     (the name was altered too heavily), **do not adjust the floor** — add an entry to the binding's `titleStrip` that strips the noise, so that the similarity
     truly reflects the content; if it is still 0 after stripping, the file name no longer contains any identity information, and a manual `patchEntry` finishes the job.
     For the same file, the **organize** side shows a `pending duration-collision` (ledger basis
     `ambiguous:name-floor:<leftKey>`) — both sides use the same floor, so they appear together and disappear together.
0. **Multi-season tv binding: a whole season / a whole subdirectory did not match, not just a few scattered episodes?** First suspect that the season attribution was judged wrong; it is not a matter of
   fileRegex/threshold — the `llmSeasonCache` field of `GET /api/netdisk/mappings/<id>` records
   which season each pending folder was finally judged to be (`null` = none of the three tiers could decide, and the files never entered any season's matching bucket).
   If all the files of a whole subdirectory are in `orphanFiles`, and the left items they should correspond to are **exactly** in `unmatchedLeft` for another season → most likely a problem in the season-judging step of `season-resolve.ts` (see the previous section), not the
   fileRegex/titleStrip problem this section covers — check whether the folder name has a literal season number and whether the file count collides with another season.
1. **Can the bucket key be extracted?** Run each side's title through that tier's regex.
   - Cannot be extracted on the right → the file name does not start with a digit / has no SxxExx. See whether a prefix is blocking it (`怡乐播客 - 186.…`
     starts with Chinese characters, so the `^0*(\d{1,3})` of `epnum` simply fails to match) → add a `titleStrip` to strip the prefix
   - The numbers extracted on the left and right are **different** → the numbering is misaligned, `titleStrip` cannot save it; see the next section
2. **The keys are the same; is the similarity enough?** Compare bigram overlap after normalization. Common things that pull similarity down:
   - A timestamp (`_0603111423`), release group, or note tacked onto the end of the file name
   - The left-side title carries the show-name prefix (`瓜瓜乐-中元聊聊恐怖片`) while the right side does not
   - → both are solved by adding a `titleStrip` regex
3. **Similarity is enough but it did not match?** Look at `margin` — the bucket has two that both look quite similar (the 纯享 ("pure-cut") and non-纯享 versions of the same episode),
   and the program refuses to pick blindly. This is correct; fall back to manual handling rather than lowering the margin
4. **Matched but `pending`?** The similarity is between `threshold` and `AUTO_SIM=0.8`. Just confirm it

### Why a same-episode copy gets deleted / why it gets swapped in

A file reaches the "same-episode copy" step (`settleCopy` in `reconcile/plan.ts`) only if both of these hold:
**it corresponds to some episode** (a duration hit, or the recognized identity points to it), **and that episode already has a claimed audio file**. The only issue left
is replacement, and `compareQuality` decides the outcome:

| Copy relative to the authoritative file | Action | `basis` |
|---|---|---|
| Worse | `delete-loser`: delete this one, keeping only one per episode | `quality-loser-of:<the one kept>` |
| Better (higher resolution tier / higher bitrate) | `replace`: delete the old authoritative file; this one takes its place and is moved into the target directory | `quality-upgrade:<the one deleted>` |
| **Cannot tell which is better** (a tie, or resolution cannot be probed / durations incomplete / the other version of the same episode is longer than the tolerance but within the same order of magnitude) | The direction is decided by the ladder below: keep the authoritative file → `delete-loser`, keep the copy → `replace` (both carry `compare` side-by-side data) | `authority-duration:` / `name-authority:` / `quality-loser-of:` / `quality-unknown:` |

**When it cannot tell which is better, the direction is decided by the episode list — not by "who was claimed first".** Which file is the authoritative one and which the copy depends only on
whom the matcher claimed, and has nothing to do with which one looks more like this episode; deciding the direction by that is a coin toss. The criterion ladder is **first come, first served; if one tier cannot decide, go to the next**:

1. **Closer to the episode list's duration** (`authority-duration:<the one deleted>`): both files had durations probed, and the episode list gives a duration for this episode
   → the one with the smaller `|duration − episode list|` stays. If the two differences are equally large → next tier.
2. **Name agrees with the episode title** (`name-authority:<the one deleted>`): the recognized identity (`identity(file name).key`) equals the recognized identity of this episode's
   title for only one side → keep that side. If both sides match (or neither does) → next tier.
3. **Neither can be decided**: a tie → `delete-loser` deletes the copy (`quality-loser-of:<the one kept>`); not comparable →
   `replace` swaps in the authoritative file (`quality-unknown:<the one deleted>`).

Live prototype for tier 1 (怡楽 (Yile) 780/796): the episode list says 8274s; the source-side file at 8274s was claimed and became the authoritative file, while the in-library file at 8279s
was judged the copy, a 5-second difference beyond the tolerance → cannot tell which is better. If the direction were fixed as "the copy takes over", the one deleted would be the file that fits the episode list exactly.

Live prototype for tier 2: `05.太极两仪生四象.mp3` and `怡乐播客 - 005.身边那些灵异事.mp3` have exactly the same byte count and duration
(the same audio, both episode 005, so tier 1 cannot decide), while episode 05 in the episode list is only 2164s — the former is the wrongly named
file. When several files in the same round all point to the same empty episode, the claim order follows this rule too: the one whose name matches the episode list lands first (`plan.ts`
stably reorders by it before the main loop).

When it cannot tell which is better it still gives a recommendation rather than a question: **no one else could answer "which one is this episode" better**, and throwing up one's hands only
piles the same question onto the next round. The safety boundary is on the execution side, not the judgment side — both kinds of action are **confirm-tier**:
`executePlan` with `losers:false` (which the scheduled round uses) does not touch them at all and only counts them toward pending, so they show up in the
preview again next round; a real deletion can only be an explicit `execute` after the user has looked at "delete this one, keep that one" in the "to-be-deleted list".

**Do not get the direction of `replace` backwards**: what is deleted is `oldPath` (the old authoritative file), and what stays is `src` — exactly the opposite
of `delete-loser`. The execution order is firm too: `remove` the old one first, then `move` the new one (the other way round, the same name is guaranteed to hit a 403); if `remove` fails,
the move is skipped, the error row is still recorded, and the next round retries.

**Files that matched no episode at all** (extras, suspected other works) do not take this path: if "duplicate" cannot be established, they have no right to be deleted, and they go to the
second shelf (or stay where they are).

When troubleshooting, look at the `basis` field of `run_actions` (or of the `ledger` in the response):

- `quality-upgrade:` / `quality-unknown:` / `name-authority:` / `authority-duration:` = the table and ladder above,
  and the path is **the one that was deleted**; `quality-loser-of:` is the only exception, with the path pointing at **the one that was kept**
- `size-dup-of:<path of the one kept>` = a hard duplicate with an identical byte count, an earlier and harder criterion than same-episode best-of selection
  (the criterion is "it is the same file", so no quality comparison is needed), and the execution side does not go through the "to-be-deleted list" preview.
  **When that episode is `paid`, the basis stays and the action changes**: it is degraded to `delete-loser` (confirm tier, not executed by the scheduled round),
  so seeing this basis paired with `delete-loser` is not a contradiction — that gate taking effect is exactly what it means
- `authority:<leftKey>` = the authoritative file paired by the matcher with `auto` confidence
- `same-episode-copy:<leftKey>` = the "remaining copies of this episode" handed over by the matcher (`losers`); the only issue is replacement
- `ambiguous:<reason>:<leftKey>` = the matcher cannot decide / is not sure and raises a question (`reason` ∈ `below-threshold` /
  `no-margin` / `duration-contradiction` / `name-floor` / `low-confidence`). **Dispatch only on this closed set,
  never parse the message text**
- `redundant-free:<leftKey>` = the claim holds, but that episode has `needsSupply === false` (the source site can supply it itself) → the netdisk copy is
  redundant, and `delete-redundant` deletes it directly (it does not enter the confirm tier; the scheduled round deletes it as well). **It has no path for "the one kept"**: what is kept
  is the source site itself. Seeing it paired with `verdict: claimed` (or with a `copy` among the remaining copies of the same episode) is not a contradiction — the bucket states the verdict,
  and this basis is reached only when the claim holds; what changes is the disposition
- `relisted:<leftKey>` = delisted-shelf recheck: the source site relisted this episode (`paid`, unclaimed this round) → this file flows back to the
  paid shelf. `shelf-copy-of:<authoritative path>` = the recheck recognized it as another copy of that episode, with the authoritative file already on the paid shelf → confirm tier.
  Both come from the "delisted shelf looks back each round" pass, and the ledger is in the `secondaryReview` section
- `decision:not-episode:<leftKey>` = a person ruled "this is not that episode", and it goes to the delisted shelf as "it is not in the list"
- `decision:prefer:<path of the one kept>` = on the second shelf, two copies of the same episode that **the machine cannot rank**, and a person ruled "which one to keep".
  The actions are exactly isomorphic to measured best-of selection (`delete-loser` / `replace`, still entering the "to-be-deleted list" for confirmation); only the grounds change —
  the ledger shows at a glance whether this entry was said by a person or measured. **A person's ruling is asked for only in the `unknown` cell**: when the machine can rank them,
  it is not consulted, otherwise it would be one more path that silently rewrites the best-of result. The decision is stored in the `prefer` kind of the `decisions` table, with a composite key of
  **two file paths** `[kept, dropped]` — both sides are included so that it automatically becomes invalid once the kept file disappears;
  a one-sided "this one is the dropped one" would, in the next round, judge the sole remaining file as well, degrading a protective decision into grounds for deletion
- `no-duration-hit:<seconds>s` = nobody claims it → delisted shelf

### Three real cases (2026-07-25, 怡乐播客 (Yile Podcast) binding)

| Symptom | Where it is stuck | Fix | Result |
|---|---|---|---|
| Left `瓜瓜乐-中元聊聊恐怖片` / right `中元聊恐怖片.mp3` | The left side has an extra show-name prefix, so similarity is not enough | Add `^瓜瓜乐\s*[-–—·]\s*` to `titleStrip` | 3 episodes absorbed |
| Left `787.二十七探悬疑案件` / right `787.…_0603111423【…】.mp3` | The numbers match, but the timestamp at the tail pulls similarity below 0.6 | Add `_\d{10}` to `titleStrip` | 1 episode absorbed |
| Left `53.财克印、印克食伤` / right `52.财克印、印克食伤.mp3` | **Numbering off by 1**, the titles are identical | No `titleStrip` can save it → **duration tier** | Absorbed |

The first two kinds are "the name has something extra or something missing", which `titleStrip` can fix. **The third kind is that the name itself is wrong, and only the content can save it**
— that is exactly what the duration tier does (see above).

## Multi-season TV archiving

The archiver for a TMDb series binding (`left.kind:'tmdb' && media:'tv'`) does not go into the claim shelf root; the destination is split by season:
`tv-<id>/S<nn>/` (the season number is taken from the leftKey the matcher assigned to this episode, zero-padded to two digits). Renaming and duplicate detection use different criteria too:

- **File name prefix**: only claims judged `auto` get the `S03E14 - ` prefix, with the original file name left unchanged right after it; the
  title is never written into the file name (to avoid takedown triggers). A file that already carries the **correct** prefix is not changed again; one carrying a **wrong** prefix (the name says
  S03E14, the engine assigned it S03E15) is not renamed and produces a `pending` (`evidence-conflict`) — when the name and the engine disagree,
  the machine may not unilaterally rewrite the evidence; it goes to a person.
- **How the same episode is judged**: the identity key of a file matched to an episode is the matcher's leftKey (`tmdb:<id>:S03E14`), which never
  collides across seasons (S02 and S03 both having an "episode 7" do not affect each other). Files not matched to an episode stay where they are, and can only be compared for byte-for-byte equality with other unmatched files in the **same directory**
  (`delete-dup`); they never take part in `delete-loser`/`replace` — a dropped copy must be
  one where "the engine says these two are the same episode", and the machine does not rank them just because their file names collide.
- **It takes the same season-partition path as sync**: a multi-season binding first decides the season by leaf folder (clean nested name → air date → structural fingerprint →
  the LLM cache on the binding → LLM, `resolveFolderSeasons`), and then matches **each season separately** (`matchBySeasonResolved`). The archiver
  **never** mixes all seasons' lists and all folders' files into one adjudication — that would judge files with the same issue number and the same title in season 2 (2025) and season 3 (2026)
  to be the same episode (in one live round 52/128 rows were misjudged, and all 21 replace + 2 delete-loser
  were cross-season). When judging the season it looks at the **unfiltered** directory listing (the season number is often written only in the names of `.zip`/`.nfo` files), while matching still looks
  only at media files; a folder whose season cannot be judged takes no part in matching and stays where it is, with the ledger row `season-unresolved:<dir>`, and it is not
  counted toward the directory-level circuit breaker either.
- **Same-episode copy quality not comparable (`incomparable`) → comparison card, neither auto-delete nor swap the authoritative file**: both durations are known and differ by more than
  the tolerance = they are not the same content, which produces a `pending` (`pendingKind:'replace'`, ledger basis `incomparable-copy:`),
  waiting for a person to look at whether it is another version of the same episode. Every authoritative file in a season directory carries the `SxxExx - ` prefix, so the "name agrees with the episode title"
  tier always sides with the authoritative file here, and ruling by it would amount to **issuing a deletion order based on the name alone** (live: after the prefix was added,
  "第1期纯享版" ("Episode 1 pure-cut edition") was judged a dropped copy of episode 1, 10 entries in one round); and the follow loop runs unattended with `losers:true`.
  A tie (`tie`) is unaffected and still goes through the criterion ladder to delete the copy.
- **"纯享" ("pure-cut") edits are a separate playback line and go to their own shelf**: files whose names contain "纯享" are not any episode, and
  land in `tv-<id>/纯享/S<nn>/`, **without the `SxxExx - ` prefix** (the prefix is an assertion of "this is which episode"), with ledger verdict
  `offline` and basis `pure-cut:S<nn>`. This **overrides the dropped-copy path**: a pure-cut file the engine judged a same-episode loser
  no longer goes through `delete-loser`/`replace`/comparison card and goes straight to the pure-cut shelf — a pure-cut is not a copy of the main episode, and comparing quality between two things that differ by a dozen
  minutes was asking the wrong question to begin with. Two exceptions must be remembered: **when the engine recognizes it as the authoritative file of some episode** (some shows
  list the pure-cut version in the episode list as the main episode) it is that episode and goes to `S<nn>/` as usual; **when the season number cannot be determined** (the folder's season cannot be judged,
  and it is nobody's loser) it is not moved and stays on the `season-unresolved` row. There are two sources for the season number, with leftKey taking priority
  (the engine's conclusion outranks the folder), followed by the folder's season attribution. In the counts it is its own `movePureCut` slot and is **not in
  `moveClaimed`** — that directory sits inside the claim shelf but holds no episodes. Empty-directory cleanup keeps `纯享/` and the `S<nn>/` beneath it as
  archive structure, the same as season directories.
- **Whole-round undo**: renaming (`rename`) records provenance first, just like moving, and all actions in one round share a single `run_id`;
  `POST /api/netdisk/reconcile/undo-run {runId}` reverts them in reverse rowid order (move back / rename back / recreate
  directories); deletion-type actions are skipped and counted (files in the recycle bin are not automatically fished back by this path).

Three more entries for the troubleshooting manual:

| Symptom | Fix |
|---|---|
| `rightFile` broke after a file was moved into a season directory | The follow loop automatically resyncs one round after each archiving round; after a manual execute, click "Sync" once |
| A rename collided with an existing file of the same name in the target directory | Degraded to `swap-hold`: no rename; wait until the occupant is cleared out in a later round, then rename |
| Archiving emptied out a share subdirectory | Only the share subdirectory that this round actually emptied is deleted; ones with leftover files such as `.nfo` are kept |

## Manual fallback

When rules cannot fix it, pin the pairing directly:

```
PATCH /api/netdisk/mappings/<id>/entries/<leftKey>        {"rightFile": "...", "status": "corrected"}
POST  /api/netdisk/mappings/<id>/entries/<leftKey>/reset  Release the manual correction, back to the automatic rules
```

`corrected` pairings are **pinned during sync / spec apply / rebind** — changing rules does not wash away your
manual corrections, and they are inherited when the directory is changed (rebind recognizes by fingerprint).

## Listening to a piece of netdisk audio (`netdisk_transcribe`)

A pending-decision card asks "is this file actually that episode?". When every criterion has been exhausted and it still cannot be told, there is a path that **fetches new evidence**:
the MCP tool `netdisk_transcribe` fetches the transcript of **the first and last two minutes** of the file (bytes are cut in proportion to duration, which is accurate for VBR too)
and hands it to the agent in the conversation, which reads it, makes the call itself, and records it with `reconcile_decide`.

**It is a standalone primitive and takes only one absolute AList path.** The other speech-to-text/transcription tools on the conversation side (`extract` /
`transcribe` / `get_conversions`) all fetch data by item id, and loose netdisk files have no item id at all — this is the only
way to listen to them. Code: the shape layer is `src/mcp/netdisk-transcribe.ts`, the policy and cache are in `src/netdisk/reconcile/
sample-audio.ts`, and slicing and transcription are in `identity-probe.ts`.

- **Only mp3/aac are supported**, and the duration must be known (two gates: `sliceable.ts` and the duration-probing step). The index (moov/cues) of mp4/m4a/mkv
  is not in the slice, so a slice cut out for transcription comes back empty — which would be read as "nobody speaks in this segment", worse than having no
  conclusion, so **no network request is made at all** and the tool answers directly `{status:'unsupported', reason}`.
  **This path does not hold for movies and TV at all**: their files are almost all mkv/mp4, and those pending cards can only be looked at by a person.
- **The window is 120 seconds, not 30 seconds**: measured, the first 16 seconds are the intro music and the last 30 seconds are pure end-credits song, so 30 seconds is not enough at either end.
- **The window is adjustable but capped** (`clampWindowS`, upper limit 300 seconds). Transcribing a whole episode of several dozen minutes is **not allowed** — the full transcript would blow up the
  entire conversation, and it costs real ASR money. This cap is hard: the model can see this parameter in the schema,
  and a cap that can be talked around is no cap.
- **The default sampling policy lives in the tool, not with the model**: which segment to listen to is a deterministic question (the start decides identity, the end decides completeness),
  not a trade-off that requires judgment.
- **The head and tail segments are fetched in parallel.** The per-stage timings (`fetchMs`/`transcribeMs` in `probe.timing`) are therefore **the sum of the individual durations,
  not wall-clock time** — reading them as wall-clock time yields the odd result of "the total is larger than the total duration".
- **A sample is cached per file** (the `audio_samples` table in netdisk.db). The key prefers AList's driver-side object id
  (the fid for Quark), and falls back to "byte count:path" only when that is unavailable. **This is not a convenience, it is a necessity**: the whole job of organizing is to move
  files from the source directory onto the shelf, so with the path as the key, every file already judged would have to pay for transcription again after being moved.
  A hit must also **recheck the byte count** — a key collision would serve up another file's transcript, and it would read flawlessly.
  When it falls back to the path tier, there is a line in the log; if "the cache seems not to work", investigate by it.
- **The receipt states by itself that "this is only a sample"** (`sampledOnly` + `coverage` + a `truncated` flag per segment). Without that, the consequence is
  that the model summarizes a whole episode from two minutes, or answers "X is not mentioned at the start" as "X is not in the whole episode", and nothing anywhere raises an error.
  When a segment has no speech, the receipt gives a human-readable `note`, not an empty string: **"nobody speaks at the end" is itself evidence**,
  and swallowing it as a fetch failure makes it vanish.
- **Conclusions must quote the exact words from the transcript.** What follows this chain is a claim or a delisting, and a conclusion that cannot be checked is worse than no conclusion.
- **Ending completeness** (a closing remark vs an abrupt stop) is the most valuable cell of this evidence-gathering: it tells apart "this file was truncated" from
  "the duration in the episode list was registered inaccurately", and the two call for opposite handling. **The blind spot is multi-episode compilations**: the tail of such files is often pure silence
  (measured: 120 seconds at -91dB, concatenation padding), and the transcript honestly returns empty — but silence cannot tell "normal ending" from "truncation". When a duration larger than
  the episode list by an order of magnitude and a tail segment with no speech occur together, do not draw a conclusion from the ending; that file very likely contains several episodes.
- **Transcription goes through the `transcribe` ladder** (Groq first, 217× real time, about 1 second for two 120-second windows). **Do not bypass
  the ladder and new up a backend client yourself**: the version that bypassed it took 20–40 seconds for the two windows, and from that it deduced "there is only one path,
  so it must be serial", which turned a dozen cards into ten minutes — a wiring error grew into an architectural conclusion.
- **Listen to one file at a time; do not sweep a whole directory**: one cold call downloads about 10 MB and runs ASR twice. If you really need to judge a batch, pick only the few that are stuck.

### The tiered criteria for recording a decision are in the tool description

The organize panel is a **read-only status surface** (coverage / pending cards / evidence display); its only action is "Have the AI organize" — it sends a one-line message carrying the show
context into the conversation column, and evidence gathering (`netdisk_transcribe`), adjudication (`reconcile_decide`) and execution
(`reconcile_execute`) all happen over there. Two hard boundaries:

- **Gathering evidence and recording a decision are two steps.** Gathering evidence is read-only and writes no decision at all; recording a decision is a separate call. The look in between is not there out of fear that it
  would judge wrongly (a claim is a pin in the match layer and can be cancelled, and moving to the delisted shelf is relocation, not deletion; both can be undone), but because when twenty-odd cards are recorded at once,
  if the prompt skews it systematically somewhere, you only find out in the next round when you see the files have all gone to the wrong place.
- **The unattended loop stays closed (full auto-adoption is not built).** The bar is not "whether it can be undone" — both kinds of conclusion write only to the decision ledger and can both be
  undone; the bar is that **the evidence does not reach**: a quote only guarantees "it really did say that", not "the right words were quoted and the right episode was judged",
  and matching the head of a compilation file cannot prove the attribution of the whole file. Adjudication in the conversation keeps a person in the loop: for hard evidence (a byte-level copy, a duration match to the second)
  the agent records directly and reports afterwards in a sentence, and for the rest it lays out the evidence and waits for the user to answer — the **single source of truth for the tiered criteria is
  the tool description of `reconcile_decide`**; do not copy another version into prompts or documents.

**"The evidence does not reach" was measured, not inferred** (2026-08-24, the first 5 cards of 发发大王 (Fafa Dawang)): of 66 files,
**all 61 that had an audio reference were auto-claimed by the matcher**, and all 5 cards fell on the 116 entries in the episode list with `paid: true` and **no audio at all**
— pending cards arise only in this dead corner, where acoustic fingerprinting has no other half to compare against, and listening to the head and tail is the only evidence.
3 of the 5 were multi-episode compilations of over 3 hours (file 12245s vs episode list 4824s), and the tail measured as **120 seconds of pure silence**
(ffprobe valid 120s mp3, volumedetect −91dB), and a silent tail cannot tell "normal ending" from "concatenation padding".
**This is not a disease of the pipeline**: slicing / ASR / probe / verdict were each verified layer by layer and every layer is honest, and `ending: no-speech` is
a truthful reading — it is the `ending` cell that has no discriminating power on compilations. So cards like `duration-collision` **never enter
auto**: auto-adoption would mask entirely that "this file contains several episodes", which is exactly what a person should see when answering the card.
(Corollary: the value of relaxing the bar by piling up volume to accumulate samples is also doubtful — the bulk of what accumulates is exactly these "only the head can be looked at" cards.)

**Cards with several candidates have no "choose per candidate" form** — this is one of the reasons adjudication moves into the conversation: the right action for an exception
("claim the first candidate, and also recognize that the third is its byte-level copy") does not fit into a set of buttons fixed at design time, while one sentence in the conversation records it
(spec `2026-08-24-conversational-reconcile` §1). Multiple candidates are the norm, not an edge case: measured, they account for 5 of 8 cards for 怡楽 (Yile) and
3 of 18 cards for 春典 (Chundian) (all 2–3 candidates, 2026-08-01).

### AI suggestion vs the person's final choice (comparison ledger)

**This table can only read historical data**: the writer of the AI half no longer exists (the judgment is done in the conversation), so it no longer grows new rows;
the person half is still backfilled by the step that writes the decision (`ReconcileService.setIsEpisode`/`setNotEpisode`), and rows still unanswered in the existing data can still be answered. The reason it
originally existed — to give auto-adoption an accurate-rate base — still holds, but the base is now sealed.

- **Revocation does not write to the ledger**: the ledger asks "what did they choose at the time", and a later revocation does not change the choice made then.
- **When several negations come in a row for the same file**, the one that lands on the episode the AI itself named decides — it is the only one that truly
  negates this suggestion. With first-come-first-served, when the episode the AI pointed to is ordered later, a real disagreement would be recorded as "not comparable".
- **The four cells are mutually exclusive and exhaustive** (agree / disagree / answered but not comparable / not yet answered, which add up to the total comparable). A three-cell version inevitably folds
  "not comparable" into one of the cells, which inflates the agreement rate — and an inflated accuracy rate is exactly what this mechanism should least produce.
- To read it: `GET /api/netdisk/reconcile/suggestions` (see `docs/API.md`).

## End-of-round adjudication

After the follow-loop round archives, or when `reconcile_adjudicate` is called manually, the pending archive cards and the follow candidates judged `pending` this round are packaged and
put to the model once; the conclusions pass through the code gate (`admitDecision` in `src/netdisk/adjudicate/gate.ts`) and are then recorded in the decision ledger,
archive cards that pass the gate are immediately re-archived once, and follow candidates that pass are saved directly. **The model does not delete files** — it can only answer
"is this file that episode", and only two decisions are recorded, `is-episode`/`not-episode`; deletion still goes only through the archiver's
existing code gates. For the implementation see `src/netdisk/adjudicate/` (`cards.ts` builds the cards, `prompt.ts` holds the system prompt and parsing,
`gate.ts` is the code gate, and `service.ts` is the main body); for the authoritative design see
`internal design record`.

- **Only three pending tiers are asked**: `evidence-conflict`, `duration-collision`, `no-duration` (those tripped by the `replace`/
  `season-unresolved`/`suspect-dir` circuit breakers are never asked and still go to a person); the follow path adds one more tier,
  `follow-candidate` (files in a share that has stock but whose confidence is not enough for automatic saving).
- **Throttling**: if the fingerprint of this batch of cards for the same binding (a hash of path + type + sorted candidate leftKeys) is the same as last time and it has been
  less than 7 days since then → do not ask again, and record one `skipped:'same cards'`. At most 40 cards and one model call per run.
- **The candidate count of a `no-duration` card depends on the season length; it is not fixed**: this kind of card has no leftKey signal at all (no
  `conflictsWith`/`collidesWith`), and the only narrowing it dares to use is the "第N期" ("issue N") that the file name carries — keep only list entries with the same title issue number;
  if the file name has no issue number, or no candidate is left after narrowing, this task does not build the card (v1 does not ask, rather than building an empty card
  the model can only guess at). The longer a show's season (for example a daily variety show with a hundred-plus issues in one season), the more than one candidate may collide on the same issue number across
  different seasons — there is another gate for season consistency (`Card.dirSeason` vs the candidate's season number), but that gate takes effect only when the assembler
  passes `seasonOfDir`; the end-of-round adjudicator does not currently wire this signal (`ReconcileService.previewBinding`
  does not export it), so the issue-number gate is currently the only one that truly backstops.
- **Audit**: every model conclusion (including rejected ones and `unsure` ones) writes a row to `ai_suggestions` (see the previous section).
- **Revocation**: revoke a whole batch by the `note` prefix `llm:<runId>` (`reconcile_revoke_adjudication` /
  `DecisionStore.revokeByNotePrefix`), without touching the human decisions; files already saved for follow candidates are unaffected,
  and the revocation only returns that episode to the unclaimed state.

## The shared episode-recognition layer

"Understanding a file name = recognizing which episode it is" has two uses: binding matching (the matching engine of this document) and the archiver
(`src/netdisk/reconcile/`, the three-way routing of loose files into move / delete / pending). What the two share is **rule data**, not the same
cleaning function — this is deliberate, not unfinished:

- Binding matching has to score title similarity (bigram overlap) and **must not strip punctuation** — once punctuation is stripped, the similarity is distorted,
  and two unrelated titles can collide into a high score.
- The archiver needs exact grouping (the same key means the same episode) and **must strip punctuation all the way** — leave one comma, and two file names that were
  the same episode would be split into two keys and treated as two episodes.

The requirements of the two outputs are mutually exclusive, so by nature they cannot share a single cleaning pipeline:

```
Recognition rules for file names ── manually specified (highest; what a person has ruled the machine may not overturn) — the two sides each manage their own, not merged
             ├─ Per-show customization (stored in the binding's MatchSpec, data rather than code, shared by both sides)
             └─ Generic cleaning (two implementations, whose output requirements differ, see above)
```

Only two things are truly unified:

1. **The generic constant `EXT`** (the union of extensions, including `opus`) — defined only in `src/netdisk/identity.ts`,
   and `stripper()`/`canonName` in `match-spec.ts` `import` it from there; **do not each maintain a copy**.
2. **Per-show rules as data**: `identityRulesFromSpec()` (`src/netdisk/match-spec.ts`) extracts a
   binding's `MatchSpec` into `{titleStrip, epNumRegex}` (the de-duplicated union of each stage's `titleStrip`, and
   the `epNumRegex` of the `epnum` stage; **the `solo` and `duration` tiers do not take part** — especially the implicitly added
   duration tier, whose `titleStrip`, if merged in, would make the archiver's grouping keys drift wholesale and cut off all of the manual
   exemptions in the `decisions` table), and the archiver's `makeIdentity()` (`src/netdisk/identity.ts`)
   takes it as a parameter — one configuration (the binding's `matchSpec`), and the archiver benefits along with it, with no need to write it again on the archiver side.

**How the archiver is wired to this rule data**: `ReconcileShowConfig.bindingId` (`src/netdisk/reconcile/
service.ts:19`) points to an authoritative binding, and `ReconcileService.identityFor()`
(`service.ts:183`) uses it to fetch that binding's `matchSpec`, feed it to `identityRulesFromSpec()`, and build
`makeIdentity()`. **Adding a `titleStrip` to the binding changes the archiver's default rules with it** — but this holds only when the archiver
has no explicit override for that field; see the next paragraph.

`ReconcileShowConfig.identity` (`service.ts:27`) is the explicit override, which **replaces field by field, and does not merge**:
`titleStrip: show.identity?.titleStrip ?? rules.titleStrip`, and likewise for `epNumRegex` — whichever
field is overridden no longer looks at the binding's rule at all, and only fields not overridden still borrow from the binding. This is a deliberate choice: if it
were changed to a union of both sides, any new `titleStrip` added on the binding side at any time would silently mix into the rules of an overridden field and change the keys
the archiver produces — and the manual exemptions in the `decisions` table of `netdisk.db` are stored by exactly this key, so
once the key drifts, the exemptions are cut off. Replace semantics gives up the convenience of "change a rule on the binding and the archiver follows automatically", and gets in return that "the archiver's
keys are not accidentally disturbed by changes on the binding side".

Current state: the `identity` override of the 怡乐 (Yile) show **sets both fields** — `titleStrip:
["^怡[乐楽樂](?:播客|电台)?\s*[-–—·]\s*"]` + `epNumRegex: "^(\d{3})\."`. **This means that for the Yile show, changing the binding side's
`titleStrip` never reaches the archiver at all** — both fields are taken over wholesale by the override, and the "borrow the binding's rules" path is
a dead letter for it; "change the binding and the archiver follows automatically" holds only when a new show is created and `identity` is left unfilled (or only one of its fields is filled). **This is not "should have been eliminated but was not", and do not try to eliminate it**: adding this prefix rule to the Yile binding's
`matchSpec.titleStrip` (so that binding matching shares it too) would produce 2 new pairings and **both are wrong pairings** — with the prefix stripped, `878.五十谈身边灵异事` is paired with the completely different episode number `137.十谈身边灵异事.mp3`
(stripping the prefix drops the file names of duplicate copies into the weak-signal `title` tier, where bigram similarity wrongly puts them together as a pair).
The investigation confirmed that the episode numbers corresponding to those 11 orphan files of the `怡乐播客 - NNN` form are all already paired to other files on the left, so they are
genuinely redundant copies, and leaving them as orphans is correct — they are not "missed absorptions". So this prefix rule stays only in the archiver's
`identity` override, and the binding's `matchSpec` is untouched.

**The decisions key drifts along with the recognition rules**: changing a single `titleStrip`/`epNumRegex` may change the key the recognition function
produces, and records in the `decisions` table (exempt/tombstone) stored by key drift along and are cut off. In the Yile migration of 2026-07-25,
because the `identity` override replicated the old rules verbatim, the keys produced did not drift — the `decisions` table
needed no migration, and the action lists before and after the preview matched entry by entry (counts, actions, and exemptions were all identical). **This is not
"changing rules is always safe"**: if a future change alters the rules themselves (rather than migrating them as-is like this time), expect key drift and
a corresponding migration of the `decisions` table.

## Per-season folders, files bare down to just the episode number

The `name` obtained by `stripper()` listing directories recursively carries the full relative subpath, but before comparison it is first cut with `.replace(/^.*\//, '')` down to just
the basename — **directory names are never visible to `fileRegex`**. Real case (进击的巨人 (Attack on Titan), 2026-07-25): the netdisk is split into per-season
folders, and the files themselves are bare down to just the episode number (`进击的巨人 S01/进击的巨人24.mp4`); the default two-capture-group
`fileRegex` of `season-episode` cannot read the season number, so DEFAULT is wiped out entirely.

`fileRegex` supports writing just **one** capture group (taking only the episode number): when a right-side file matches, group 2 is always `undefined`, and `stage` accordingly
degrades the whole tier into "bucket purely by episode number, discarding the left side's season number and comparing only the episode number". This is safe only when the right-side data is already a pure single-season set — either of two paths
satisfies that:

1. **A multi-season tv binding goes through `matchBySeason`** (`season-resolve.ts`, already wired automatically into the sync entry): left and right are first split by season
   (structural fingerprint / nested clean name / LLM fallback to decide which season a folder belongs to), and each season runs the matching pipeline independently, so it is pure by construction.
2. **A binding whose `dirPath` itself is narrowed to a single-season subdirectory** is likewise safe — the directory holds only that season's files.

Mixing the two forms in one `fileRegex` (the same regex matching group 2 for some files and not for others) is not supported, and is handled uniformly by the convention of the last
hit; when writing rules, keep the number of capture groups consistent.

**A bare issue number ≠ a bare episode number: in a season where `期` ≠ `集` ("issue" ≠ "episode"), a bare number must not be followed by "期".** Variety shows are often numbered as "one issue, several episodes"
(TMDb `E01` = issue 1 part 1, `E02` = issue 1 part 2, ...), while the netdisk names them by issue (`第3期上：….mkv`). As soon as the authoritative titles (`SpecLeft.title`) of this season
contain the shape "第N期上/中/下" ("issue N, part 1/2/3") or "第N期（一）" ("issue N (one)", a parenthesized part number, as in the stand-up seasons of 喜剧之王 (King of Comedy)), the bare-episode-number fallback tier of `season-episode` tightens the regex to "the digits must not be followed by `期`", so that
files like "第3期上" yield to the more precise `episode-part` (第N期上/下, 第N期（一）, 第N期四 all belong to it), while files like "第4期纯享版" ("issue 4 pure-cut edition"), which neither match the issue-number
composite key nor should be wrongly swallowed by the bare-episode-number tier, stay orphans. A season without this shape (titles only "第N期" with no
part number at all) is unchanged, since a bare issue number is simply the episode number. The criterion is implemented in `withBareEpisodeTail` in `season-resolve.ts`.

**The archiver also has an independent gate (`qiConflict` in `reconcile/plan.ts`)**: before stamping the `SxxExx - ` prefix, if both the file name's
"第N期" and the list entry's title "第M期" are present but unequal, or the file name says 纯享 ("pure-cut") while the list entry (whose title carries an issue number)
is not pure-cut → it raises an `evidence-conflict` card, with no move and no rename. The prefix is the only place that writes the engine's conclusion into the file name on disk,
and once a wrong number is stamped it becomes the strongest evidence for the next round; when both the sharer's issue number and TMDb's issue number are present, the machine does not choose between them.

## How the season attribution is judged (`season-resolve.ts`)

A multi-season tv binding (more than one season) passes through this layer first and only then enters the matcher — this is how the "right-side data
is already a pure single-season set" of the "Per-season folders" section comes about. The criteria are **ordered** and stop at the first hit:

1. **Nested clean name** (`nestedCleanNameSeason`) — a literal `第N季`/`Sxx` ("season N") written in the folder name (including subpaths, scanned from nearest to farthest).
   A literal label is the hardest evidence, so it goes first.
2. **Air date** (`airDateSeason`) — which season's air-date range the date in the file names (`2026.08.14` / `20260814` / `2026-08-14`) falls into
   (the earliest/latest TMDb airDate of each episode, with the tail relaxed by 14 days for upload delay). It decides only when the files carrying dates make up more than half of the
   "episode-like" files, more than half of those fall into **the same season**, and no second season is assigned any of them. It sits ahead of the structural
   fingerprint and the cache: file count == some season's episode count is coincidence-grade evidence (when following adds two episodes to a share directory of season 2, the directory
   happens to have exactly 20 videos = the episode count of season 1, and the whole directory is judged season 1), and the cache may hold a `null` from a previous round when the LLM came back empty-handed;
   dates do not lie. Variety shows' share directories are often garbled names holding only the latest few issues (the file count matches no season), and this tier
   is the only way they can have their season determined automatically.
3. **Structural fingerprint** (`structuralSeasonMatch`) — the number of "episode-like" files in the folder uniquely hits some season's real episode count.
   The fallback tier when there is no literal label and the file names have no dates either.
4. **Cache** — the answer from the last LLM fallback judgment (`set.llmSeasonCache`, persisted on the binding); if the folder has not been renamed,
   the model is not asked again.
5. **LLM semantic fallback** — when none of the earlier tiers can decide, ask once in a batch (all pending folders of the same binding in one question). It receives only the
   directory name, the subdirectory tree, and miscellaneous file names, **not the episode-by-episode file names** — a directory with a garbled name, no subdirectories, and no miscellaneous files
   looks empty to it, and it is entirely normal that it cannot answer; do not count on it.

**Real regression (进击的巨人 (Attack on Titan), 2026-07-25)**: the old order had the structural fingerprint first. The netdisk split S03 into
`进击的巨人 S03/进击的巨人 S03 part1` (12 files) + `.../part2` (10 files), and the file count of part1
(12) happened to equal the real episode count of S02 — the structural fingerprint misjudged it as season 2, so the 12 files were wholesale merged into the wrong season, and S03E01-E12
all became `missing` (same-name files on both sides such as `进击的巨人01.mp4` made `reduceByQuality` unable to disambiguate, and the file of season 2 that arrived first
won the first move). This was fixed by moving the nested clean name ahead of the structural fingerprint — a literal season number is
harder evidence than "the file counts happen to be equal".

**Residual limitation**: a folder that no tier (including the cache) can decide is assigned `null`, and its files are wholesale left as orphans — it does not guess.
For folders such as `最终季`/`完结篇` ("final season" / "finale") that have no literal `Sxx`/`第N季` and whose file count matches no season's real episode count,
the LLM may also conservatively decline to answer (real case: the "进击的巨人最终季 Part.1" folder under the 进击的巨人 4K collector's edition directory,
with 16 files, matching no season's episode count, which the LLM judged `null`). This kind of residue **is not worth forcing a heuristic
for the sake of automation** (a mapping such as "final season → highest season number" is reasonable for this one title, but may hit exceptional usage in other works,
and the risk outweighs the benefit) — go straight to the manual fallback (see below).

## Known limitations

**Cross-part absolute numbering + descriptive file names has no solution; go to the manual fallback.** The "进击的巨人最终季 Part.1/
Part.2" mentioned in the previous section: besides the season number being undeterminable, even if it were determined, the file names look like
`[SRENIX] Attack on Titan The Final Season - 08 [BD HEVC 2160P FLAC].mkv` — the number is followed by a long string of
quality/encoding descriptions, so it is not a "trailing number", and `fileRegex` cannot extract a clean episode number; moreover part1/part2 use absolute numbering continuous across parts
(part1: 1-16 → E01-16 of that season, part2: 17-28 → E17-28), and the offset conversion is not something a regex can express.
For this kind, **there has been no live verification that the offsets line up everywhere** (there is a risk of missing episodes and irregular naming), so it is not worth
a custom regex for a single binding — read the numbering continuity in the folder, check it manually, and pin it with `PATCH`.

**Misaligned numbering: file-name rules have no solution; hand it to the duration tier.** Numbering on the netdisk may be misaligned as a whole or in individual files
(`455.现代版木仓下留人` is actually the source site's `454.现代版枪下留人` — numbering off by 1, and the title with a character altered to evade review, failing at the same time).
No rule on file names can save this kind; **the duration tier (see above) was added precisely for it**; when neither side can obtain a duration it is still unsolvable,
and you go to the manual fallback.

**The shared `EXT` includes `opus`, so the binding matching's `canonName` collapses `x.mp3` and `x.opus` into the same canonical name.**
For a binding that holds both formats, `coverage.right.total` is therefore 1 lower than counting by extension separately, with one orphan fewer —
dedup is more accurate, but keep this in mind when investigating coverage numbers that do not match earlier records.

**`EXT` is shared in both directions, so the archiver side also recognizes video extensions (`mkv/mp4/ts/…`) — and this side can drift the keys of the `decisions`
table.** Whether an extension is in `EXT` decides whether it is stripped off whole or stays in the grouping key (`PUNCT` strips only the dot, and
the three letters `mkv` remain) — **the same file gets different grouping keys under the two conventions**, and once the key drifts, the exemptions/tombstones previously stored for it
can no longer recognize it. Fine today: Yile is pure audio, and the `decisions` table in `netdisk.db` has no key with a video
extension. But **before connecting a show that contains video files to the archiver**, check the existing keys against this point first, so that the user's
"do not remind me again" decisions do not silently stop working. **The key also has a shelf id in front** (`fileKeyOf(shelfId, path)`, see "Decision keys carry the shelf id" above):
when checking existing keys, read the part after the `openlist:` prefix; the shelf id itself does not take part in this drift.

**The two cleaning pipelines run their steps in different orders, so the same `titleStrip` rule may take effect on one side and not on the other.**
`makeIdentity` (the archiver) first strips `【水印】` ("watermark") / bracket noise and then applies the caller's `titleStrip`; `stripper()`
(binding matching) has no such pre-cleaning and applies `titleStrip` directly. If a binding's `titleStrip` has only one prefix rule anchored at
the start (such as `^怡乐播客\s*-\s*`) and no watermark rule, then for a file name like `【整理】怡乐播客 - 186.x.mp3`
with the watermark placed first: the archiver strips the watermark first, so the prefix rule can anchor at the start and strip normally; binding matching
has no pre-cleaning, so the prefix rule is pushed into the middle by the watermark, cannot anchor, and does not take effect. It has not blown up so far because
`DEFAULT_TITLE_STRIP[0]` happens to be the watermark rule and bindings usually inherit it — but that is coincidence, not a guarantee; when writing a
per-binding `titleStrip`, if you intend to replace it entirely rather than append on top of DEFAULT, watch for this order difference.

**The duration tier is live, and this section covers its remaining boundaries.** Duration has been promoted from "fallback evidence for judging delisting" to
the main anchor for judging identity (usage is in the "duration tier" section above), and the prior needed to connect a new show has dropped from "a set of naming regexes" to
"an episode list that carries durations". What is still not covered:

- **The TMDb side still has no duration**, so TV/movie bindings get no anchor and still rely purely on file names. TMDb's `runtime` is only to the minute
  and is an approximate value for the whole series, which is as good as nothing against a 1s tolerance.
- **The first-round probing has a budget** (200 new probes per sync). The part that cannot be filled is not "wrong"; those episodes just
  go through the file-name chain this round; the archiver also fills the same cache every night, so it converges after a few rounds.
- `paid` (three-state, see "Paid shelf = `paid` ∧ claimed by the matcher" above) entered `SpecLeft` together with `durationS`.
  **No judgment layer on the episode-recognition path reads it** — the match layer does not (the pairing result is identical with or without it), and the archiver does not read it
  when judging "which episode is this" (reading it would make a second judging brain). Only the **disposition** side, after the claim conclusion has been settled, reads it.
  It entered the match layer so that the "episode list → match layer" step loses no information and is carried into the run ledger.
  The subscription-stream branch always knows `paid` (if readable it is `false`); the TMDb branch is naturally `undefined`.

**There are only two cleaning rule sets (the two above in this section), and nobody may create a third — do not wire `displayTitle` in.**
The sharer-prefix regex of `displayTitle` (`packages/alist/normalizer.ts`) is a **hard-coded generic heuristic**
(`^.{1,12}?\s*[-–—·]\s*(?=\d{3}[.．])`: a prefix of ≤12 characters followed by three digits), and for shows it does not hit there would be an
inconsistency of "recognized as a prefix in one place and not in another", creating a pile of noise out of thin air for the user to adjudicate. It serves only the content/
display layer (`alistNormalizer` and the adapter). To get a clean title by this show's rules, use `makeTitleClean()`
(`identity.ts`) — **it uses the same `titleStrip` data source as the grouping key `makeIdentity()`**.
