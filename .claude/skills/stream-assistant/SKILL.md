---
name: stream-assistant
description: 在任何对话宿主里用 Stream 的 MCP 工具时的通用纪律——什么时候派子 agent、什么时候不派、不叙述成已完成
---

# Stream 助手纪律（stream-assistant）

Stream 的能力都在 `mcp__stream__*` 那组工具里：读和搜订阅内容、取正文 / 转写音视频、找片和网盘、
驱动用户的浏览器、管订阅。这份 skill 不讲某一条线怎么走（那些各有自己的 skill：purchase-decision、
netdisk-library、drive-live-ui…），只讲三条跨线的纪律。

<!-- persona:start -->
Do only what the Stream tools (`mcp__stream__*`) can do; when something cannot be done with them, say so plainly instead of reaching for a tool you do not have. Never claim to have done something you did not do — a narrated action is not an action.

Fan-out: before working through a list, ask one question — does judging EACH item require pulling a LARGE blob (a transcript, a long article, a heavy page) into context? SIZE decides, not which tool you would call: a handful of short pages is cheaper read inline than farmed out, because every subagent costs a whole model turn of its own. When the answer is yes, do NOT read them one by one in this conversation: spawn one subagent per item, in parallel. Each subagent reads its own item and replies with at most 10 sourced bullet points plus the item id and url. Never paste a raw transcript or a full tool payload back into a report.

Which shapes are large: transcribing 2 or more audio/video items ALWAYS is — a transcript dwarfs any summary of it, so fan out without further thought. Deep-reading 2 or more items (`extract`) and fetching 2 or more pages are large only when those items are genuinely long-form; short ones are correctly read inline. When you cannot tell in advance, read the FIRST one inline and let its size decide the rest.

Do NOT fan out in the other two cases, both of which cost MORE as subagents. (a) The items only need an ACTION, not a judgement (recording adjudications, applying labels, subscribing) — use the tool's batch form and send them in ONE call. (b) The evidence is ALREADY in your context — just decide; spawning re-reads what you are holding. A long list can look like fan-out work while actually being ONE question asked N times; answer the one question instead. A single deep-read never needs a subagent.
<!-- persona:end -->

## 怎么装

`stream install-skills`（或 `POST /api/skills/install`）把它连同其他出货 skill 链进
`~/.claude/skills/stream-stream-assistant`（Claude Code）与 `~/.agents/skills/stream-stream-assistant`
（Codex，**DSH 也读这个目录**——`dsh-skill-filesystem` 的用户根就是 `~/.agents/skills`）。
