# Stream

**English** | [简体中文](https://github.com/JaggerH/stream/blob/main/cli/README.zh-CN.md)

**Let your AI find the way once. Stream writes the route down — then replays it on a schedule, with
no tokens spent, inside desktop apps too, and calls the AI back only when it breaks.**

Today's agents (Claude Code / Codex / OpenClaw / Doubao) can all drive a browser and a computer for
you, but doing the same thing a second time is no cheaper and no more reliable than the first.
Stream freezes the route an agent got working into a **recipe** — not a prompt, but executable
data — and the local scheduler replays it on time: in **your own logged-in Chrome**, in **desktop
clients** (WeChat / QQ / brokerage apps), with no model in the loop and no tokens spent, even with
the screen locked, with a receipt every time. When a site changes, the replay stops at the failing
assertion, saves the scene to disk, and calls the agent back to fix it.

It is also a self-hosted **inbox**: Xiaohongshu / Bilibili / Douyin / podcasts / netdisks / RSS
flow in using your own login state, and the whole inbox is open to AI over MCP. All data stays on
your machine.

## Which Stream do you need?

| Path | You are | How to install |
|---|---|---|
| **① Paste a prompt to your agent** | Already using Claude Code / Codex / OpenClaw | Hand it the prompt below; it installs and connects itself |
| **② Install and use** | Want an inbox plus things that run on a schedule, with or without an agent | `npm i -g @streamapp/stream && stream`, then open <http://127.0.0.1:8900> |
| **③ Run from source** | Changing the code, writing RSSHub routes | [“From source” in the repository README](https://github.com/JaggerH/stream#from-source) |

### ① Paste to your agent

Paste this as-is into Claude Code / Codex / OpenClaw:

```text
Install Stream with `npm i -g @streamapp/stream`, start it with `stream`, verify
`curl -s 127.0.0.1:8900/api/health` returns ok:true, then register it as an MCP server
(`claude mcp add stream -- stream mcp`, or the equivalent one line for this host) and install its
skills with `curl -s -X POST 127.0.0.1:8900/api/skills/install`. If the browser extension is not
connected (`/api/browser-capability` is not "ready"), walk me through loading it.
```

Afterwards the agent has a set of `stream_*` / `cdp_*` / `run_action_recipe` tools and a batch of
`stream-`-prefixed skills. An action recipe the agent got working no longer needs the agent
present: the command line under “Run a recipe without an agent” below is exactly what you hand to
the scheduler.

### ② Install and use

```bash
npx @streamapp/stream                    # try it
npm i -g @streamapp/stream && stream     # keep it
```

Requires **Node 20+** (`node -v`; if missing, install the LTS from <https://nodejs.org>, or
`winget install OpenJS.NodeJS.LTS` on Windows). **Nothing else to install** — no git, no Docker, no
Python or compiler (native dependencies ship prebuilt). The out-of-box install is 96 packages /
230 MB / a dozen seconds.

Then open <http://127.0.0.1:8900>.

```
stream [--port <n>] [--data <dir>]        start the backend
stream mcp                                stdio entry for agents (starts a backend if none is up)
stream add <package>                      install a capability / recipe package
stream update [<package>…] [--yes]        update built-in / installed packages to npm latest
                                          (new side effects need --yes)
stream restart [--force]                  restart the backend (after install / update / remove it
                                          asks when a restart is pending; in scripts use
                                          --restart / --no-restart to skip the question)
stream recipe run <id> [--param name=value]… [--yes]
                                          run an action recipe from the command line

  --port, -p <n>   listening port (default 8900)
  --data <dir>     data directory (default ~/.stream)
```

- **All data lives in `~/.stream`**: delete it to reset; uninstall = delete it +
  `npm rm -g @streamapp/stream`.
- **One port only**: the web UI, `/api/*`, `/ws`, and plugins all go through 8900.
- **Big pieces install on first use**, not out of the box: RSSHub installs the first time an RSSHub
  source runs (about 400 MB, 43–147 s depending on machine and network).
- **`stream restart` detaches a foreground backend from the terminal**: a backend started by a
  foreground `stream` restarts by launching a new copy and exiting the old one, and the new copy is
  no longer attached to your terminal — Ctrl-C cannot reach it, so stop it by finding the pid on
  the port (`lsof -i :8900` / `ss -ltnp`). A backend kept by systemd or by `stream mcp` does not
  change in this way.

### Run a recipe without an agent

```bash
stream recipe run qq-send --param contact=Alice --param message="on my way"        # only prints what it would do
stream recipe run qq-send --param contact=Alice --param message="on my way" --yes  # actually runs
```

Without `--yes` it only reports what it would do (target app / target site / parameters), exits
with code 2, and executes nothing. Exit codes: 0 done · 1 ran but no landing receipt was read ·
2 usage or parameters · 3 did not finish cleanly (**the action may be partly done** — check the
target app first) · 4 environment (Stream Desktop / the Chrome extension not connected / login
required) · 5 backend unreachable. With `--json`, stdout carries exactly one JSON document.

**To schedule it**: create a task in the scheduling center at <http://127.0.0.1:8900>, with command
`stream` and arguments `recipe run qq-send --param contact=Alice --param message="on my way" --yes`
(no shell involved; arguments are passed one by one). From then on no agent has to be present;
whether it ran is in the task's run history, and a non-zero exit code is red.

---

## Getting started: five steps, each with a check

Every step below gives a command you can run and the answer you should see. **If a check fails, do
not move on** — every failure mode on this path is silent (guest-level data, a stream that never
gets scheduled, a capability that shows as available but fails when run), and moving on only
carries a silent failure further.

### 1. Install the Chrome extension — skipping it fails silently

Harvesting **borrows the login state of your own browser** (Stream ships no browser and never
touches your passwords). Without the extension, sites like Xiaohongshu / Bilibili / Douyin only
return what a guest can see — **no error, just less and shallower content**.

Opening <http://127.0.0.1:8900> for the first time walks you through it. To do it by hand:

```bash
curl -s -X POST 127.0.0.1:8900/api/extension/materialize    # → {"dir":"…/.stream/extension"}
```

Take that `dir` to Chrome: `chrome://extensions` → turn on **Developer mode** (top right) →
**Load unpacked** → pick that directory. (Chrome removed `--load-extension` in 137, so there is no
command-line install; the GUI is the only way.)

Before it can connect to the backend, the extension gets a key from the local **Stream Desktop**
process (the executable is `stream-desktop`). The backend registers it with Chrome and launches it
on startup — nothing extra to install; a startup log line `[stream-desktop] host-agent → <path>`
means registration succeeded. **Windows and macOS both have this helper** (on Linux the backend
logs a warning, the extension cannot pair, and harvesting is guest-level only). On macOS it only
does the pairing — the extension still gets its key and harvesting carries your login state;
**driving native desktop windows is Windows-only**.

**Check** (the only trustworthy one — ignore the icon in Chrome):

```bash
curl -s 127.0.0.1:8900/api/browser-capability     # → {"state":"ready","connected":true,…}
```

- `"never-seen"` = never connected → not installed yet, or installed in a different Chrome.
- `"disconnected"` = installed, not connected right now → click the extension icon to wake it
  (Chrome puts it to sleep, especially after a backend restart).

### 2. Subscribe your first stream — remember to give it a channel

Find a source first (source descriptions are mostly Chinese, so search in Chinese — `播客` means
“podcast”):

```bash
curl -s -G 127.0.0.1:8900/api/sources --data-urlencode "q=播客"
```

Put the `id` it returns into `members[].source` (**this is the one that has to be right**), and its
`adapter` (`rsshub` / `replay` / `builtin` …) into `plugin`:

```bash
curl -s -X POST 127.0.0.1:8900/api/streams -H 'content-type: application/json' -d '{
  "id": "my-podcast",
  "label": "故事FM",
  "strategy": "fanout",
  "cadence_seconds": 86400,
  "options": {},
  "channel_id": "default-audio",
  "members": [{ "plugin": "replay", "source": "@streamapp/lizhi/lizhi-user",
                "params": { "id": "2657184879512415276" } }]
}'
```

**`channel_id` is not an optional nicety**: a stream that belongs to no channel is scheduled for
this session and **gone after a restart** (boot only loads streams referenced by some channel).
Bind it in this same request, not afterwards. List channels with
`curl -s 127.0.0.1:8900/api/channels`; four ship out of the box (`default-timeline` /
`default-audio` / `default-video` / `default-tasks`).

**Check**:

```bash
curl -s -X POST 127.0.0.1:8900/api/streams/my-podcast/refresh   # → {"fetched":961,"written":961}
```

`fetched: 0` does **not** mean “nothing new”. Usual causes: that `source` does not resolve on this
machine, wrong parameters, missing login state, or the source is broken. Look at
`curl -s "127.0.0.1:8900/api/debug/log?channel=harvest"` for this round's per-stage verdict —
**if the log has not a single record for this source, it never ran at all**, rather than ran and
found nothing.

### 3. Turn on capabilities that need a key (transcription / OCR / summaries)

First ask what is missing:

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds
# the extract row's branches: {"stt":false,"ocr":true,"article":true}   ← stt is missing a key
```

Speech-to-text needs a Groq key. **Stream can request one for you** — it opens the vendor console
in your own Chrome, creates a new key with the account you are **already logged in to**, and
writes it to local config (no third party involved).

> **Prerequisite: log in to <https://console.groq.com> in that Chrome first** (Groq supports Google
> sign-in, and the free tier is enough). This step uses your existing login state — if you are not
> logged in it stops at the login page, which is a missing prerequisite, not a failure.

```bash
curl -s -X POST 127.0.0.1:8900/api/source-runtime-config/provision \
  -H 'content-type: application/json' \
  -d '{"pluginId":"builtin","sourceId":"groq-whisper","params":{"name":"stream-auto-7f3a"}}'
# → secrets.apiKey.configured: true            about 17 s measured
```

Getting one yourself at <https://console.groq.com/keys> and filling it in with
`PUT /api/source-runtime-config` works too. **No restart needed** — the next query has changed:

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds     # branches.stt → true
```

Transcribe an episode:

```bash
curl -s -X POST 127.0.0.1:8900/api/conversions -H 'content-type: application/json' \
     -d '{"kind":"extract","item":"<item id>"}'      # → {"id":"cv_…","status":"running"}
curl -s 127.0.0.1:8900/api/conversions/cv_…          # poll until status:"done"; result.text is the transcript
```

A one-hour podcast takes about 4–5 minutes (fetching and re-encoding the media dominate;
recognition itself takes tens of seconds).

### 4. Connect a chat host (optional)

Stream has no chat of its own; use the agent you already have. Three steps, and only the third is
optional:

**One — install Stream.** Already done (`npm i -g @streamapp/stream && stream`).
**Installing it gives you computer use** — your own logged-in Chrome, plus native desktop windows.

**Two — one line on the host side, pointing at Stream.**

```bash
claude mcp add stream -- stream mcp      # for Codex it is one mcp_servers entry in config.toml
```

`stream mcp` is a stdio shim: it probes the local backend once, forwards everything to `/api/mcp`
if it is up, and starts it first if it is not. **This line never needs to change again** — however
many capabilities you add to Stream, the tools come out of the same door.

**Three — add more capabilities when you want them:**

```bash
stream add @streamapp/netdisk      # netdisk: verify shares / save / direct links / redirects
stream remove @streamapp/netdisk   # no longer wanted
```

A capability package fills one slot of a Stream package (`package.json#stream.capability`). It is
installed into `<dataDir>/recipes/` and mounted by the backend **in its own process** — login state
never leaves that process. Installing from the “Components” page in the UI is the same path.
**A backend restart is required for it to take effect** (installing only writes to disk); if it
does not show up, restart before investigating.

Content-search and download adapters are not included in a new install by default; install them
explicitly when you want them:

```bash
stream add @streamapp/bt0
stream add @streamapp/btbtla
stream add @streamapp/1lou
stream add @streamapp/zuna
stream add @streamapp/toubiec
stream add @streamapp/shooter
stream add @streamapp/iqiyi
```

They are still ordinary Stream packages — leaving them out by default only keeps the release from
choosing content sources on the user's behalf; install, review, and removal all go through the same
`stream add` / `stream remove` path.

Next: step 5 installs Stream's skills into your agent (MCP gives the tools, skills give “when to
use which”).

#### One extra for DSH users: the Stream UI bundle

With it installed, DSH's whole face becomes Stream (content feed + chat). It also reads the skills
installed in step 5 (the same `~/.agents/skills/` directory):

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2   # engine version must match: this bundle is built against 0.2.0's client module table
# Install into the profile that already has the web UI ($DSH_HOME/profiles/web) — the bundle switches off
# web-app's full-page shell, and a freshly created empty profile has none to switch off. To keep a separate
# profile for Stream: cp -r profiles/web profiles/stream first, then replace `web` below with `stream`.
dsh plugin --profile web add @streamapp/dsh-plugin-stream-ui
dsh web                                                          # with a separate profile: dsh --profile stream
```

This bundle is the **only** thing that goes into a DSH profile; capability packages always go into
Stream, and nothing on the DSH side changes. Just keep the Stream backend running (`stream`); the
page does not need to be told which local port it is on — local origins are trusted by default.
Registration is only needed when the backend and DSH are on different machines:
`STREAM_TRUSTED_ORIGINS=http://<that machine>:<port> stream`.

> **The model is yours**: configure the provider on DSH's “Settings – Models” page; Stream is not
> involved. **The first three steps do not depend on it** — collecting, harvesting, and
> transcription use no model.

### Connecting other AI clients (MCP)

You can skip `stream mcp`: with the backend running, use the HTTP transport directly at
`http://127.0.0.1:8900/api/mcp` (`Authorization: Bearer …` is only needed if you set `api_token`).
If you would rather not keep a backend running, use the stdio transport and let the client start
the process on demand. The tool set is the same either way.

### 5. Install Stream's skills into your own agent (Claude Code / Codex)

The previous step gave **tools**; this one gives **craft** — when to use which, in what order, and
what counts as done.

```bash
curl -s -X POST 127.0.0.1:8900/api/skills/install
```

It refreshes the skills shipped with the package into `~/.stream/skills/`, then **links** them from
`~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (Codex). Links, not copies — after an
upgrade both sides are current at once.

**Check**:

```bash
curl -s 127.0.0.1:8900/api/skills      # every hosts[].landings[].mode is "link"
```

Type `/stream-` in Claude Code to see them, `$stream-` in Codex. Every name carries the `stream-`
prefix, so **they never replace a skill of yours with the same name**; if something else already
sits at that location it is skipped and reported. Undo with `POST /api/skills/uninstall` (removes
only what it created). A `mode` of `"copy"` means this machine cannot create symlinks — it works
the same, but run install again after upgrading.

---

## When something is wrong, run these first

**Go by side effects, not by “it should be fine now”** — every failure mode is silent.

| Question | Command | What green looks like |
|---|---|---|
| Is the backend alive? | `curl -s 127.0.0.1:8900/api/health` | `{"ok":true}` |
| Is the harvesting hand there? | `curl -s 127.0.0.1:8900/api/browser-capability` | `"state":"ready"` |
| Is this stream scheduled? | `curl -s 127.0.0.1:8900/api/streams` | the id you created is listed |
| Did it actually harvest anything? | `POST /api/streams/<id>/refresh` | `fetched > 0` **and** `written > 0` |
| Is this capability usable now? | `curl -s 127.0.0.1:8900/api/conversion-kinds` | its `available` / `branches.*` is true |
| Did my own recipe load? | `curl -s 127.0.0.1:8900/api/recipes/local` | `ok: true` (`dir` is where to write; if not loaded it carries the original `error`) |
| Why can this not be done? | MCP tool `capability_status` | it tells apart “key missing and I can request it” / “key missing and only the user can get it” / “not a missing key at all” |

The three easiest things to misjudge:

- **`fetched: 0` does not mean “nothing new”** (see step 2).
- **Creating a stream without `channel_id`**: it runs this time and disappears after a restart.
- **“Configured” does not mean “usable”**: the check is the capability's own self-report
  (`/api/conversion-kinds`), not the `configured` flag on the config slot.

---

Apache-2.0 · All data stays on your machine; nothing is uploaded anywhere.
