---
title: Adding Capabilities to a Chat Agent: Tools, Prompts, and How to Verify That It Really Follows Them
status: cookbook
type: guide
tags: [stream, agent, llm, tooling, verification]
---

# Adding Capabilities to a Chat Agent

This document governs one thing: **when adding a tool to the MCP tool surface (`src/mcp/`), or when using prompts to require the model to perform an action,
what rules to follow and how to verify it.** The conceptual model is in `docs/ARCHITECTURE.md`, and how to run it is in `docs/DEVELOPMENT.md`;
this document only covers the line of making the model actually follow instructions.

**The user's own host handles the conversation** (Claude Code / Codex / DSH). On the Stream side, we only provide the tool surface
(`/api/mcp`) and skills — the model is configured by the user in the host (see the "Conversation" section in `docs/ARCHITECTURE.md`),
and does not go through Stream.
The system prompt is not in our hands either — **this makes item 1 below more important, not less important**:
the only remaining places where we can exert influence are tool descriptions and tool return values.

## 1. The Most Expensive Rule: The Model Will Narrate an Action as Completed

**For the model, "say a sentence" and "call a tool" are the same kind of output** — both are what it chooses to emit as the next step. There is no mechanism
that binds "it said it did it" to "it actually did it". So it can generate the sentence `我已经记录了您的需求` ("I have recorded your request"), without generating the corresponding
tool call.

**Measured specimen** (2026-08-13, real model): ask it to subscribe to a blog that Stream cannot onboard. `resolve_intent` came back empty-handed;
it correctly said "cannot onboard", then told the user `我已经记录了您的需求` ("I have recorded your request") — while the list had no new entry. In its reasoning, it wrote in black and white,
`我需要调用 note_unonboardable` ("I need to call note_unonboardable"): **it knew what it should do, then skipped the action and directly narrated it as completed**.

**Why this kind of defect is especially expensive**:

- **It is silent.** There is no error, no log, and the answer sounds even more appropriate than the normal case.
- **The user cannot discover it.** Who would inspect the list to verify what the assistant said.
- **It is not limited to one tool.** Anywhere that relies on a prompt/description to ask the model to perform an action can be hit.

## 2. Check: Only Look at Side Effects, Not at What It Said

There is only one way to judge whether this happened — **look at the trace that action should have left**: whether the list gained an entry, whether the Channel gained
a Stream, whether the library gained a row. **The model's own words are not evidence**; the smoother it sounds, the more you need to check.

The same rule applies to daily troubleshooting: when a user reports "it said it subscribed, but I do not see it", first hit the endpoint and look at side effects; do not read the conversation transcript first.

## 3. Where to Put Instructions: The Closer to the Decision Point, the More Effective

Three positions, from farthest to closest:

| Position | Distance from decision point | What it is used for |
|---|---|---|
| System prompt | Farthest (thousands of tokens earlier) | **Not in our hands** — that belongs to the host |
| skill (the shipped ones in `src/skills/shipped.ts`) | Far (the host reads them on demand) | Craft such as "when to use which tool"; the host decides when to load it |
| Tool description (`description`) | Middle | What this tool is, when to use it, and what it is not the same as |
| **Tool return value** | **Closest (the model just read that data)** | **"What must be done next"** |

In the failure above, both the prompt and the tool description said "record a note when empty-handed", and the model still skipped it. The fix is to put that instruction into
the **return body** of `resolve_intent` (add a `next_step` field when `matches` is empty; see `src/mcp/tool-catalog.ts`) —
once it has just read that data, it must decide the next step, so the instruction is hardest to route around there. On re-verification, it really did call the tool. A second place with the same shape is
`read_content`: when the body layer has not run yet, add a sentence to the return body: "call extract first; do not describe the content before you get it".

**Note that this is not a guarantee; it only raises the hit rate.** No wording can make the model follow instructions 100% of the time, so item 2 (look at side effects)
is always necessary, and item 5 (live verification) can never be skipped.

### 3.1 Fourth Tier: Structural Closure — Product Bottom Lines Must Not Go into Any Tier of Prompt

Even when all three tiers are filled, they can still fail as a whole. Measured specimen (2026-08-24, narrow extract receipt line, the same `对比深读三条` ("compare and deeply read three items") run
for four rounds): PERSONA, the tool description, and the return-body `next_step` all said "fan out for multiple deep reads / do not read full text into the main session";
the model ignored all three tiers. After structural compression was added to `read_content`, **in the first round it discovered
the `full` parameter from the schema, passed `full: true` for all three items, and routed around it** — the user's original words did not mention full text at all.

Two invariants:

- **Product bottom lines (here, "long-form text must not enter the model context in full") can only be guaranteed structurally**: the return body does not contain the full text, so the model
  has nothing to move even if it wants to. The three prompt tiers are only for improving the hit rate of "nice-to-have" behavior; they must not carry bottom lines.
- **Bypass parameters visible in the schema = props for a disobedient model.** When an exemption is needed, do not make it a parameter; split the exemption into another
  channel: humans need full text -> the UI hits the API itself (ExtractCard "查看全文" ("View full text"), zero tokens); rare legitimate
  model needs -> leave a path whose shape naturally has friction (`get_conversions`). The full design is in
  `internal design record`; the two schemas each have a guard test
  saying "does not contain full" pinned down; do not add it back.

### 3.2 Background-Automatically-Derived Layers: Put the Artifact Directly into the Upstream Receipt, Do Not "Give Half + Add a Reminder"

Some layers are **automatically derived** in the background (transcription settled -> extract frames to obtain on-screen text, `src/conversions/derive.ts`). When the upstream tool
hands over its receipt, that layer may not have finished yet, or it may already be in the database. Each of the two situations has a pitfall, and both are very quiet:

**Pitfall one: if the model does not know it exists, it is equivalent to not existing.** And the model will not say "I don't know"; it will say **`系统没有提供这个工具` ("the system did not provide this tool")** — which sounds like a factual statement about the system.

**Pitfall two (more expensive): when the upstream receipt says `done`, it is saying "the body of this item is complete".** For video, that is false: transcription is often
only a small part; all the words are on the screen.

The same item (`54302ede4b47213a`, a Douyin news item with only background music and all text on-screen) hit this twice in a row:

| | What the receipt gave | What the model did |
|---|---|---|
| 2026-08-29 | Only transcription, with not a word about frames | Answered `系统没有提供对视频画面做 OCR 的工具` ("the system did not provide a tool for OCR on video frames") — while that layer had already finished and landed at the time |
| 2026-08-30 | Transcription + a sentence saying "wait and then use get_conversions to fetch it; do not assert first" | **Still** sent the summary while `画面文字·抽取中` ("on-screen text: extracting") was showing; the summary was of that 14-character lyric |

The second time is the key: **signposting failed**. This is exactly the invariant from §3.1 — product bottom lines can only be guaranteed structurally. So the rule is:

- **If that layer is still running, and the item's body is basically all in that layer -> the upstream receipt reports `running`, and carries no result.**
  If there is no text in hand, it cannot summarize. Use that layer's own gate to judge whether "the body stands on its own"; do not invent a new check
  (`src/mcp/transcript-stands-alone.ts` reuses `framesGate`). For items that stand on their own (complete transcription, with that layer only being
  supplemental), provide the body normally and attach a separate note saying "one layer is still missing".
- **When that layer settles -> splice the artifact directly into the receipt**; do not signpost and make the model call again by itself. The two runs above already killed off the path of "bet it will follow instructions".
- **"Still running", "ran but yielded no material", and "backend failed" must be distinguishable.** If either of the first two is described as "none",
  the model will immediately assert "there is no text in the video".
- **Humans must be able to see it too.** The card uses the same tiers (`ExtractCard`: waiting for on-screen text / words on screen / no words beyond transcription)
  — if the user cannot see that layer exists, they have no way to know to follow up.

The check is in `src/mcp/extract-frames-layer.ts` (the extract -> frames piece); copy it.

Acknowledge the cost: turning true on-screen-text video into text becomes slower. That is intended — summarizing a half result incorrectly is much more expensive
than waiting a few dozen seconds. And most items are unaffected: non-video items do not have this layer at all; videos judged to be pure speech are eliminated at the gate step,
and settle within a few hundred milliseconds.

### 3.3 "Not Ready Yet" Must Be Waited for on the **Server Side**; Never Let the Model Poll

The previous section's "report running, carry no result" has an obvious sequel: when the model receives `running`, it immediately calls again.
**It has to be immediate — the model has no sleep.** So the polling frequency is decided by how fast it emits text, and has nothing to do with how long the work takes:
one transcription was called five times; the user saw five cards flood the screen, the context took in five receipts, and four of the middle ones did not have a single new word.

The right shape is **to wait on the tool side until the result is ready, then return**, and this does not require any extra mechanism:

- **One DSH tool call renders exactly one card, and that card is live.** The tool view receives a `ToolCallBlock`;
  it is first in the running state, and after the result lands the same card is redrawn in place into the settled state
  (the rendering convention of `@deepseek-ai/dsh-client-ui-tool`). "One card updates its state" = "one call that does not return early";
  it is that simple.
- **There is no path for "call you back when it finishes".** One MCP `tools/call` has one response, not a second one; DSH's own
  long-task registry (`dsh-jobs`: job id, `wait`, `onJobDone`) has a convention whose original text says **`约定是进程内的` ("the convention is in-process")**,
  while we are an MCP server in another process, so we cannot reach it. Do not look for it again.
- **The ceiling is set by the MCP client, not DSH's tool timeout.** `dsh-mcp-client`'s `toolCallTimeoutMs`
  is the timeout for each `callTool`, **default 60000**; when it is exceeded, the model receives the hard error `TOOL_TIMEOUT`, not your receipt
  that clearly says "still running". **The waiting budget must be strictly smaller than the host's number**, and that number belongs to the user's configuration, so we cannot pin it down —
  therefore the tool-side budget must be set by the tightest tier. (Do not confuse this with `ToolDefinition.timeoutMs`: that is a declaration;
  the `dsh-tools` registry never enforces it, and it also governs tools inside the DSH process.)
- **Set the budget by the measured distribution; do not chase the heavy tail.** `/api/conversions`'s `timing.totalMs` is an existing sample:
  transcription takes 1-16 seconds (always enough), while the on-screen text layer takes 17-861 seconds (heavy tail, all cost in per-frame OCR). 90 seconds covers two thirds;
  freezing the whole conversation for more than ten minutes for the longest item is much worse than falling into the "still running" tier.
- **The tier that cannot be waited for must explicitly prohibit retries.** Writing "call again in a few seconds" here is the worst sentence — each retry
  freezes for a full budget again, and still cannot wait long enough. Write "do not call again; tell the user this layer is still being extracted, and ask again in a few minutes".

## 4. What Tests Can and Cannot Prove

| Test | Proves | Does **not** prove |
|---|---|---|
| Tool unit test | The tool is installed, calling it writes to disk, and the parameter shape is correct | Whether the model will call it |
| Registry parity (`src/mcp/dsh-ui-registry-parity.test.ts`) | Every tool has been registered once for "how to render" | Whether it renders well |
| Full green | The items above | Same as above |

**We have no alarm for exactly which tools the model has in hand** — that list is assembled by the user's host (profile / preset /
its own built-in tools); Stream only knows the ones it hands out via `/api/mcp`.

**The prompt tier is the same** (the system prompt belongs to the host). So for any product behavior that is "only written in the prompt/description",
the only evidence is to run it once live and look at side effects.

## 5. Live Verification: How to Run It

A real model, a real backend, and side effects. It costs real money, but the four rules above make it non-skippable.

**The main path is to run one round in any host** (DSH: `dsh web`, when installed into the web profile; for a standalone profile use `dsh --profile stream`; Claude Code: MCP points to
`/api/mcp`) — say that sentence -> look at side effects. Tool calls are visible one by one in the message stream; that is fact. The body text is rhetoric.

When you only want to verify "whether the tool itself works" and the model is not involved, hit the MCP surface directly (no conversation required):

```bash
# List the tool surface (confirm it really registered)
curl -sS 127.0.0.1:8900/api/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 2000

# Call one (replace name/arguments with the one to verify)
curl -sS 127.0.0.1:8900/api/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resolve_intent","arguments":{"input":"https://example.com/blog"}}}'

# The side effect is here (what the tool returns does not count)
curl -sS 127.0.0.1:8900/api/onboard/wishlist
```

**Run both scenarios**: the one that can succeed (it should call the tool), and the one that cannot succeed (it should say so truthfully + perform the compensating action).
The latter is where things break — the failure above happened on this path.

**Triage order when it did not follow instructions** (do not edit the description first):

1. **Whether the tool is in the stack**: whether it appears in `tools/list`. If not -> wiring is broken (most likely some `extras` cell was not forwarded;
   see item 6), inspect assembly; do not edit prompts.
2. It is in the stack but the model does not proactively call it -> follow item 3 and move the instruction closer to the decision point (move it into the return body).
3. It called it but there is no effect -> look at the side-effect endpoint, not at its receipt.

### 5.1 Live Verification: The "Missing a Key" Line (`capability_status` + `provision_capability_key`)

This line **naturally steps on item 1**: the model can absolutely say `我已经帮你申请好了 Groq 的 key` ("I have already applied for the Groq key for you") without calling any tool,
and that sentence sounds even more appropriate than the normal case. So its acceptance has only one check — **that `configured` cell really flipped**,
not that the model said it flipped.

**Before starting, first make the scene "missing key"**: use `POST /api/source-runtime-config/status`
(body `{pluginId,sourceId}`, or read `/api/config/source:<ref>` directly) and check whether that cell is `configured:false`.
If it is already configured, there is nothing to verify — do not delete the user's key to manufacture the scene.

**Three rounds; missing any one means it was not verified:**

1. **The tier that can configure it for the user (`needs-key-self-serve`).** In the host, ask `这条播客帮我转成文字` ("help me turn this podcast into text")
   (or directly `转写现在能用吗` ("can transcription be used right now?")). The checks are all in side effects, not in its words:
   - the **first** tool call in the message stream is `capability_status` (if it answers "cannot use it" directly without calling it = guessed, red);
   - it then **asked the user** whether to choose "I help you apply" or "I get it myself", and **reported the URL of that self-service application page**
     — if it does not provide both choices, it missed half of the product intent;
   - the user says `你帮我` ("you help me") -> the message stream shows one `provision_capability_key` call without `confirmed`
     (receipt `status:"needs-confirmation"`), **and at this moment nothing has happened in the browser**;
   - the user nods -> the second call carries `confirmed:true`, and the user's own Chrome really opens that page;
   - **only this last step is the check**:
     ```bash
     curl -sS 127.0.0.1:8900/api/config/source:groq   # replace with the ref for that round
     ```
     `secrets.apiKey.configured` being `true` is what counts. The `status:"done"` sentence in the tool receipt **is also**
     verified by code (`provisionConfigSlot` reads again after finishing), but live verification wants the glance from outside the tool.
2. **The tier that ran but produced nothing (`ran-but-empty`).** Site redesign / bot verification failure / login wall all show up here, and it
   is the most expensive tier in the whole chain: without checking, it reports false success. The cheapest way to create the scene is to **log out of that site first** and run one round.
   Check: the receipt is `ran-but-empty`, the model **truthfully says it did not obtain anything** and points to `failures/`, **instead of** saying "already applied".
   A failed-scene artifact really appears under `<dataDir>/failures/`.
3. **The tier that is not missing a key (`blocked-other`).** This is the easiest one to misreport as "I will apply for one for you". Create the scene:
   start a backend with `STREAM_FFMPEG_PATH=/nonexistent` (use a different port + `STREAM_DATA_DIR`; do not steal the live one),
   then ask about transcription again. Check: `capability_status` reports `state:'blocked-other'`, the blocker includes
   `kind:'tool'`, and the model says "this machine does not have ffmpeg", **without mentioning applying for a key by even one word**.

**Do not treat the fourth behavior as a failure**: after a successful run, the capability still reports unavailable. That transcription ladder is built **at backend startup** based on
"which keys exist" (`src/providers/seed.ts`'s `ensureTranscribeRow`), and after configuring it, it will not attach without a restart.
For this tier, `capability_status` returns a blocker with `kind:'restart'`; the model should say "restart the backend once",
**and should not apply for another key** — that is the only mistake this tier can make, and it runs with no visible oddity.

### 5.2 `unblock`: Do Not Wait for the Model to Remember to Ask "Is This Missing Configuration?"

The line in 5.1 has one precondition: the model must **first realize** it should call `capability_status`. Its most common failure is not calling the wrong
tool; it is **not thinking in that direction at all** — an extract fails, it reports "transcription failed" according to the `error` sentence,
then stops, and the user believes this machine simply does not have that capability, when in fact it is only missing a key that the model can create on the spot.

So this seam **does not rely on prompts; it puts the conclusion directly into the receipt**: when `extract` fails, `slimExtractReceipt`
(`src/mcp/extract-receipt.ts`) adds an `unblock` cell to the receipt — which member on the ladder abstained because it is **missing configuration**,
and which recipe can fill it in (`unblockOptionsFor`, `src/auth/unblock.ts`). The instruction is written next to the comment for that field,
not in the system prompt (§3: the closer to the decision point, the more effective).

Three design constraints, each corresponding to a "worse suggestion":

- **Only accept `outcome:'miss'`, not `error`.** miss means "not configured, go configure it"; error means "tried but failed, go diagnose
  the fault"; the directions are opposite. If error is also counted, then when upstream fails it will advise the user to apply for another key.
- **If someone wins, the whole cell is absent.** The point of the ladder is that even if someone abstains, a result still appears; mentioning "you are missing a groq key"
  at that time is noise, because the user lost nothing.
- **An empty array does not appear; the whole cell disappears.** It burns context for nothing, and also makes the model think "I checked; there is none", causing it to add
  one useless sentence.

**Live check (same as §2: only look at side effects)**: clear the groq key, and say `把这个转成文字` ("turn this into text") to a video item.
- The `extract` receipt in the message stream **has** the `unblock` cell (absent = wiring broken; verify whether `registry.all()`
  really got passed in — that parameter **intentionally has no default value**, precisely so tsc goes red immediately on miswiring, instead of silently staying empty forever);
- The model **proposed** self-service filling, rather than just saying "you do not have a key configured" and stopping;
- After the user says go, follow the checks in 5.1: `/api/config/source:groq`'s `secrets.apiKey.configured` changes from
  `false` to `true`. **If it says "I have already created it for you" but this cell is still false = failure**, not success.

## 6. Rules When Adding a Tool

- **If there is no destination, do not install this tool.** Example: `note_unonboardable` is only installed when the ledger is injected (`extras.wishlist`).
  Installing a note-taking tool that cannot write anywhere makes the model think it recorded the note, and tell the user "already recorded" accordingly — **one lie is worse than
  a missing feature**.
- **The registration gate is whether that `extras` cell exists**, so **one missing cell in the forwarding table = that tool quietly does not register**. This table is in
  `src/kernel/plugins/agent.ts` (`mcpExtrasDeps`); the number of cells is self-checked at assembly time by `MCP_EXTRAS_DEP_COUNT`
  and pinned by `agent.test.ts`: adding a cell must also update the number.
- **The Stream UI plugin must know how to draw it**: register one row in `hosts/dsh/registry-table.json`,
  either `custom` (a custom card is implemented) or `generic` (state clearly why the generic card is enough). The bidirectional diff is pinned by
  `src/mcp/dsh-ui-registry-parity.test.ts`; a missing registration goes red immediately.
- **When two tools are easy to confuse, their descriptions must name each other.** The model chooses tools by description, not by the taxonomy in our heads.
  Measured specimen (2026-08-19): asked `总结时间线里某人近期的发言` ("summarize someone's recent statements in the timeline"), the model called `content_search` — that is
  **live search** (fan out online to configured searchable Sources; results are not written to the database), so it came back with a pile of freshly searched web pages; then it guessed Source ids and
  called `stream_read` wrong 4 times; finally `read_url` fetched the whole page, totaling 416K tokens, and upstream returned 400.
  The fix is to add `inbox_search` (read items **already harvested into the database**) **and write clearly in both descriptions what the other is**:
  "read the database, no network access, no harvest triggered" versus "live search, not written to the database". **If boundaries between same-family tools are not written into descriptions, they do not exist.**
- **The receipt must be a projection, not the existing object sent out as-is.** The direct cause of the failed round above was receipt size. For every tool
  that returns a batch of items, ask for each cell in the projection: "will this cell inflate the receipt?", and add a guard test with **pinned forbidden items**
  (`src/mcp/inbox-search.test.ts` pins that `raw`/`body_html`/`content.media` never appear — if the projection is changed back to
  `{...item}`, it goes red immediately). If truncated, write the truncation explicitly in the receipt (the model will treat a half excerpt as full text and answer silently wrong).
- **"Next step" in descriptions and receipts is a commitment, not a suggestion — first confirm that this path is valid for this kind of data.** Live measurement
  (2026-08-19): the `inbox_search` description said "if truncated, call `extract` to fetch the full text", so the model called extract 10 times for 8
  **plain-text** posts — but the body of that kind of item was already in the database; extract only fetched the same text again verbatim
  (10 wasted conversion tasks + one round of context). Two executable rules:
  **(a) signposts must be conditional**, and the condition should be a cell in the receipt (`full_text: true` = full text is already here; do not fetch again);
  once the model has just read that cell, it must decide what to do, so it is more effective than a general sentence in the description;
  **(b) the condition uses an existing authoritative check**, do not invent a sniff test that "looks like plain text" — here it uses
  `shared/extract/plan.ts`'s `planExtract` (the frontend "turn into text" button consumes the same source),
  and writing another copy yourself creates a third drifting check; drift manifests as the receipt **quietly pointing in the wrong direction**, with no error anywhere.
  There is another same-kind self-check: **before telling the model "use X to check it", first confirm that it really has X in hand** — the description once said
  "filter by Channel id", while the tool surface had no tool that could list Channels; to the model, that sentence was equivalent to telling it to guess.
- **Side-effect tools must explain before executing**: for actions such as subscribing and deleting that modify user data, the tool description must say explicitly "confirm with the user first".
  Only live verification can verify this.

## 7. When the User `@` Mentions Content in the Input Box — Attach the Body, Do Not Bet on the Model Fetching It

Typing `@` in the input box can reference Stream content ("the item I am currently viewing" ranks first). It uses DSH's official input-trigger
extension point (`ctx.inputTriggers.registerSource`), with source in `hosts/dsh/src/client/input/
stream-ref-source.ts` — **it does not modify DSH's input box or grab its slot**; `@` is already the trigger character recognized by that pipeline.

**The only place in this chain that decides success or failure is `codec.serialize`**: its return value is spliced character-for-character into the
prompt sent to the model (`sinkSerialized` in ui-conversation). Therefore a reference **writes the body directly into it**, instead of only giving an id
and making the model come back and call `extract` by itself — that is exactly the kind of bet described in sections 1 and 2: we asked for it != it followed. Once the body is attached,
the default path works with **zero tool calls**.

What is attached is a **truncated** body (`EXCERPT_LIMIT` in `app/src/panel/itemRef.ts`). The truncation is **written explicitly in
the serialized text**, and gives `extract({item:"<id>"})` as the deepening entrypoint — if it is not written, the model treats the half excerpt as full text,
and silently answers incorrectly, with nothing shouting anywhere.

Two easy-to-miss boundaries are both pinned by tests (`hosts/dsh/test/stream-ref-source.test.ts`):

- **`ReferenceInsert.source` must equal the source name** — on send, this string is used to look up the codec in the roster;
  if it differs, there is "no serializer", and the entire message cannot be sent.
- **Do not throw when the snapshot cannot find that item**: a `serialize` failure blocks sending, while "the referenced item is no longer at hand"
  (switched Channels / refreshed) is completely normal — honestly handing over the id is better than making the user unable to send the message.

"Which item is currently being viewed" is **cross-bundle**: the content is in the panel bundle (`app/src/panel/`), and the trigger source is in the shell
(`dsh-plugin-stream-ui`). Copy the existing path used by the Channel roster — through the mount `onItemContext`
callback, the panel pushes the entire state to the singleton store on the shell side (`panel/item-context-store.ts`); do not invent a second transport.

## 8. A tool description is a promise: what it says must be what the code actually does

The model **chooses tools only by their descriptions**. If the description contains a verb that the tool does not actually perform, the model uses it for that task and then gives the result to the user
as the answer to that task. **Nothing reports an error anywhere**: the tool returns normally and the data is real; it is just answering the wrong question.

One-sentence check: **before words like "harvested / subscribed / persisted / stored / the user's content" appear in a description,
first check whether that implementation is really reading from the database.** If it fetches on demand (`fetchSource` / `invoke`), the description must say explicitly: "this
fetches live from the network; it is not reading things you have already collected."

This is not wording pedantry; two real examples are on the stack:

- **`content_search` is live search** (`ctx.search.contentSearch` → `executor().invoke('content-search')`).
  Each call fans out network requests to the searchable Sources the user has enabled; results **are not written to the database**, and each item's `fetched_at` is the time of this call.
  The Sources the user has enabled may include search bridges such as Baidu/Bilibili, so what comes back is often a web page that was just found by live search.
- **`price_search` is its price-comparison sibling** (`ctx.search.priceSearch` → `invoke('price-search')`,
  HTTP `GET /api/search?scope=price`): the same live-search / no-write-to-database / slimming mechanism, except it fans out to
  price-comparison Sources with `provides=search-price` (慢慢买 (Manmanbuy)...), returning "product → quotes from each platform" (title=product, author=platform,
  excerpt=price). **Price comparison is its own tier and is not merged into content**: product quotes mixed into content search are drowned out by web results.
  Like `content_search`, its id **is not written to the database**; do not pass it to `extract`.
- **Residual value is the third tier** (`ctx.search.resaleSearch` → `invoke('resale-search')`, HTTP `GET /api/search?scope=resale`):
  it fans out to second-hand recycling Sources with `provides=search-resale` (转转 (Zhuanzhuan)...), returning "model → today's highest recycling price." It has no independent
  MCP tool; its only consumer is the residual-value cell in `purchase_decide`. **Do not merge it into price**: if recycling prices are mixed into new-product quotes, the model treats
  a 1200-yuan recycling price as a cheap purchase option.
- **`stream_read` also fetches on demand** (`Scheduler.readStream` calls `fetchSource` on each member Source and then merges the results).
  The name "read a Stream" sounds like reading from the database; in reality it runs harvest again.

**The negative cost has been measured in practice**: the description said "the user's CONFIGURED content"; the user asked "总结我时间线里某人近期的发言" ("summarize someone's recent posts on my timeline");
the model chose `content_search` and answered with a pile of just-searched Baidu/Bilibili web pages as if they were the user's subscribed content.

**The purchase path has only one entrypoint at the tool surface: `purchase_decide`.** When the user gives a category (even only a category), call it directly.
The whole route (enumerate the complete set → who is named in cross-comparisons → fetch prices one by one → dominance computation) runs in code; the receipt is the final draft, and the Stream
UI plugin renders it directly as comparison cards. **It is asynchronous**: it immediately returns `{runId}`, and the model calls `get_agent_run` once every 20-30 seconds (while it is running, it reports
the current stage; when it finishes, `receipt` is the receipt). **Do not make a two- or three-minute job a synchronous tool**: chat hosts' MCP single-call
limits differ (the line for `stream-mcp` in our bundle is set to 200s; Claude Code is about 120s). Waiting synchronously ends as "the task is cut off before it finishes,
the backend is still running, and a retry stacks another one on top." **There is only one source file for "how to use it and how to explain it": `.claude/skills/purchase-decision/SKILL.md`**.
Every host receives that same file (`src/skills/shipped.ts`). This is the fixed shape for every closed job going forward: **one MCP tool
(route, code) + one skill (wording, one source file)**; switching hosts only requires connecting Stream's MCP and installing the skill. The checks follow this document's principle and **look only at side effects**, three of them: (1) the first tool call in the session log is
`purchase_decide`, **and there is no follow-up question to the user before it**: in live verification (2026-09-03), the model received "5000 以内、一年后出掉" ("under 5000, sell it after one year") and still threw out a five-line questionnaire first; that is red; (2) the set of models named in the answer is a subset of the model set in the receipt;
(3) the answer carries the receipt's `coverage` number. **Do not add a second tool to this path again**: there used to be a pair of "materials tool + manually assemble
final-draft tool"; the model would hand-copy the job receipt field by field into the latter, and while copying it would fill "residual value unavailable" as
"残值按 0 计" ("residual value counted as 0") (`internal design record`).

### If a route is repeatedly skipped over, do not keep changing the prompt; move it into code

The first version of the purchase path wrote the nine steps "deep-read cross-comparisons → enumerate candidate set → converge models → compare prices one by one → deliver final draft" into a
hundreds-of-words receipt `next_steps` and gave it to the model to execute conscientiously. **That text was not low quality;
it said everything it should, including "writing prose directly without going through verdict is not acceptable" -- and the model still skipped steps**. The live evidence is recorded in
`2026-09-01-candidate-set-discovery-design.md` §5. The step skipped most often was enumeration, and when that step is skipped, the dominance computation
lands on an arbitrary subset: **the conclusion is not "incomplete"; it is misleading**.

**This is not because the prompt was not forceful enough; it was in the wrong place.** A route that must be followed every time is equivalent to no route at all if it lives somewhere the model can choose to read
or not read. The fix is to move the stages into code (`src/agent/purchase/job.ts`, tool
`purchase_decide`), leaving the model only three narrow openings; skipping steps is structurally impossible.

The check still looks only at side effects, and now it can be written as a test: **models that appear in the answer must be a subset of the model set in the receipt**.
This catches the worst distortion: the model adds another machine by itself. Another check is "the delivered answer corresponds to a real run record."

⚠️ **After moving it into code, the invalidated route explanation must be updated at the same time**; do not leave it in the receipt, because it makes the next person (and the model)
think the route is still there. `brief.ts`'s `next_steps` now points to `purchase_decide` and demotes the manual path into an explicit
fallback. Design: `internal design record`.

### The next-step pointer in a description is also a promise: before writing "next use X," confirm that X really works on this data

This is easier to miss than the previous rule, because the main path usually works; it fails only on one class of data. **The check is to take values from this tool's real
receipt and actually run the next hop with them**, not "the tool X exists."

Example on the stack: `extract` parses handles through `itemStore.get(handle)` (`extractImpl` in `src/mcp/mcp-extras.ts`).
If the handle is not in the database and is not a netdisk-bound `tmdb:` handle, it directly returns `{status:'error', error:'item
not found'}`. So **it only holds for items already in the inbox**; `content_search` hits are not written to the database, and calling `extract` with those ids
necessarily comes up empty. There is only one way to dig deeper into these live-search hits: call `read_url` with their `url`. The cost of pointing to the wrong next step
is the same as the main rule in §8: the model follows it into a dead end, and nothing reports an error anywhere.

## 9. Receipt size is a hard constraint: slim at the tool boundary, not in the data source

A tool receipt can be tens of KB; a few calls push the whole conversation to the context limit and then produce a 400 `Prompt exceeds max length`
error: **the entire conversation dies directly**, it does not degrade. So "how large is this receipt" and "how usable is this tool" are the same question.

- **Slimming belongs at the tool boundary** (`src/mcp/content-search-slim.ts`, the hit limit for `web_search`),
  **not at the data source**. The same capability often has a second consumer with a different appetite: the fan-out frontend search page also consumes `content_search`;
  the frontend needs complete items (media list, `body_html`, `raw`) to render cards. Slimming inside fan-out silently breaks the search page.
- **The version for the model keeps only fields useful for judging "relevant or not"**: id / title / author / time / url / truncated body summary /
  whether media exists. Deep digging is left to the next hop (live-search hits use `url` + `read_url`). **The `raw` field is never given**: it is the entire
  source-site response object; for sources like Bilibili, it can also contain `<iframe>` and strings of image URLs, so one item can be worth dozens of summaries.
  Measured in practice (one real `content_search`, 111 hits): original 2,501,691 bytes → slimmed 6,147 bytes.
- **Cap the item count, and write explicitly in the receipt how many items were cut off**. The consequence of not writing this is the same as not writing body truncation in §7: the model treats a
  silently cut result as the complete set and silently answers wrong.
- **Guards must pin the on-the-wire payload**, not only test pure functions: the check is that the JSON text being sent does not contain `raw` / `body_html`
  (`src/mcp/content-search-slim.test.ts`). After writing the test, change the implementation back to the fat receipt and confirm it really turns red; this kind of test is naturally prone to false green.

## 10. Related

- Conceptual model and conversation shape: `docs/ARCHITECTURE.md`
- Conversation belongs to the host (Stream does not host DSH): `internal design record`
- Design for the "found by search → connect as subscription" path: `internal design record`
- Search Agent (another agent path, a goal-directed search loop):
  `internal design record`
