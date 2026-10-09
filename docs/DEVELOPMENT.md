# DEVELOPMENT.md — Development Guide

For **day-to-day development and operations**: starting and stopping, reading logs, running tests, and the pitfalls most likely to bite after switching to a native host backend.
For the conceptual model (Target/Stream/Provider/Source/Plugin), see [ARCHITECTURE.md](./ARCHITECTURE.md);
for port/gateway rules, see [GATEWAY.md](./GATEWAY.md); for connecting Sources and building packages, see [PACKAGE.md](./PACKAGE.md).

## Runtime Shape (In One Sentence)

**Stream itself runs on the host; only plugins remain in containers.** The backend is a native node process on the host, bound directly to
`127.0.0.1:8900` -- **it is the gate itself**: it answers `/api`, `/ws`, and `/_p` itself, while every other path lands on 8900's independent
front door (`src/http/standalone-page.ts`, a self-contained page that mounts the panel bundle under `/panel/*`). There is no Caddy,
no serve-backend/serve-frontend container, and no `docker-compose.local.yml`.

**Why the backend must be on the host**: harvest needs to see **the user's own Chrome** -- detect it, wake it, and live at the same layer as it;
a process inside a container cannot reach the host's process table or filesystem. (See
`internal design record` for the design.)

The full containerized stack (backend+frontend+Caddy) belongs only to the **self-hosted side branch** (NAS/VPS: that shape has no "user's browser" side)
-- `pnpm plugins compose --selfhost`; see the end of this document.

## Run from Source

| Prerequisite | Notes |
|---|---|
| Node 20+ | RSSHub itself requires 22.22.2+, but it is installed only when needed; it is not a dependency |
| pnpm 10+ | `npm install -g pnpm` |
| WSL2 / native Linux filesystem | If cloning **RSSHub**, put it under `~/projects/` (ext4), not under `/mnt/c/...` -- pnpm symlinks cannot be created on drvfs |
| Docker + Compose (optional) | Needed only for plugin backends (pansou / AList / Douyin ...) and container packages installed by `stream add` (`@streamapp/ddddocr` / `dewatermark` / `mineru` / `voiceprint`, source in [stream-packages](https://github.com/JaggerH/stream-packages)). Harvest does not need it -- login state comes from the browser extension |

```bash
git clone <this-repo-url> stream && cd stream
pnpm install                                 # Compiles better-sqlite3 (allowed by allowBuilds in pnpm-workspace.yaml)
cp config.example.yaml config.yaml           # Edit paths; per-field comments are in config.example.yaml
pnpm test && pnpm typecheck
pnpm dev                                     # Backend :8900
curl -s http://127.0.0.1:8900/api/health     # {"ok":true}
```

Subscriptions live in `data/stream.db` (created on first startup) -- add them from the UI, `POST /api/streams`, or MCP's `subscribe_source`.

**The RSSHub clone is optional.** `pnpm install` already installs the prebuilt `rsshub` package, and when there is no clone, that is what runs.
Clone only when you need one of two things: writing RSSHub routes yourself (when the clone is present, its TypeScript source runs and wins over the package),
or the full roughly 3000-route directory in the Source picker (`assets/build/routes.json` is the clone's build artifact and is not in the npm package).

```bash
git clone --depth 1 https://github.com/DIYgod/RSSHub.git ~/projects/RSSHub
cd ~/projects/RSSHub && pnpm install && pnpm build:routes   # routes.js is required
```

If the clone is not in the default location, set `RSSHUB_PKG=/abs/path/RSSHub/lib/pkg.ts`.

**Old installations whose database predates `33221b4c` must not upgrade straight to the latest version.** The identity of system Providers lives in code
(`src/providers/system/`), and there is no provider data migration during startup; if a database older than `33221b4c` is upgraded directly,
it will miss renamed rows, retired rows, and members that were backfilled. First checkout `33221b4c` and run it once (so it brings the database to the current shape),
then upgrade to the new version. Fresh installs do not have this concern.

## Start/Stop / Logs / Tests

```bash
pnpm dev                                   # Backend (native, caged hot reload) + extension WXT watcher; Ctrl-C stops both
docker compose up -d                       # Start separately when plugin containers are needed (plugins only, not Stream itself)
curl -s http://127.0.0.1:8900/api/health   # Health + which copy of the code is running: {"ok":true,"commit":...}
scripts/dev-stop.sh                        # Deterministic shutdown (port/cage/lock/resident service); pnpm dev also runs it before starting
systemctl --user status stream-back        # Resident backend (non-dev mode): Restart=always + starts on boot
```

- **Resident vs dev**: port 8900 normally runs `stream-back.service` (`scripts/stream-back.service`,
  symlinked into `~/.config/systemd/user/`). It stays resident because **the scheduling center is inside the backend process** -- A-share subscription/reverse-repo
  tasks must fire on schedule, and hanging them off a manually started terminal is a single point of failure. `pnpm dev` stops it first (dev-stop),
  then starts it again when Ctrl-C exits, so after development the machine automatically returns to resident mode without needing a manual pull. If both start at once,
  the single-instance lock in `serve.ts` blocks them (the later process exits immediately).
  Known degradation: when started at boot, WSL interop variables may be missing, so desktop-control plugins cannot reach the Windows side;
  if you need that, run `pnpm dev` from a terminal.

- **Hot update**: only the backend `tsx watch` (**polling**, `CHOKIDAR_USEPOLLING=1`) and the extension's WXT watcher are active. Pages are served from 8900,
  and panel artifacts (`app/dist-panel/panel*.js`, all of Stream's UI) **are not in watch**: after changing `app/src`, you must
  build manually. Build only the entry you changed: `npm run build:panel -- main` (about 5s); without an argument it builds all entries (about 25s).
  Entry names are in `app/panel-entries.mjs`.

  Leaving it out of watch is a measured tradeoff: a single `vite build --watch` measured **522MB RSS + 2% of one core while idle**, and five
  entries are about 3GB; even with watch enabled, the page **still requires a manual refresh** -- the bundle injected by `<script>` has no hot-replacement channel,
  so the only thing saved is that one command.
  For why the backend must poll and how much it costs, see the comment on that line in `scripts/dev.sh` -- **do not change it back to inotify mode**.
- **If you suspect "my change did not take effect", run `curl -s 127.0.0.1:8900/api/health` and check `commit`**, do not guess from log timestamps.
  If it does not match, the process did not reload (the polling mode theoretically should not allow this, but checks are more reliable than belief); `dirty_since_start` counts `.ts` files
  that changed again after process startup; it is a hint, not an alarm -- uncommitted WIP from other lines also counts. **Before live verification / A-B experiments, check this first**.
- **Backend logs are directly in the `pnpm dev` terminal**; do not use `docker compose logs`.
- **Tests/typecheck**: `pnpm test`, `pnpm typecheck` (backend); `cd app && npm run typecheck` (frontend).
  In a worktree, **do not run `pnpm install`** -- symlink `node_modules` from the main checkout (both root and `app/`);
  see the worktree section in `CONTRIBUTING.md` for how to run.
- **For a full run, write the entire output to a file**; do not use `| tail` (failure details are printed **above** the summary, and tail leaves only the
  "1 failed" number -- see the general rule in `~/.claude/principles.md`):
  ```bash
  scripts/qrun.sh node_modules/.bin/vitest run > /tmp/vitest.log 2>&1; tail -6 /tmp/vitest.log
  grep -n -B2 -A20 'Failed Tests' /tmp/vitest.log      # If red, inspect here
  ```
  For **intermittent red** (green on rerun), loop until you catch it: delete green logs, keep the red one; one catch is enough to locate it.
  ```bash
  for i in $(seq 1 20); do
    scripts/qrun.sh node_modules/.bin/vitest run > /tmp/run-$i.log 2>&1
    grep -qE '[0-9]+ failed' /tmp/run-$i.log && { echo "CAUGHT -> /tmp/run-$i.log"; break; }
    rm -f /tmp/run-$i.log
  done
  ```
  qrun is a machine-level single-slot lock, so running twenty rounds makes **tests in other sessions/worktrees queue too** -- before starting a long loop, check
  whether another line is running in parallel. If you catch a red run, triage first: if background numbers such as test-file count or built-in package count changed, someone advanced
  `main` (check `git log` first); it is not intermittent.

> **Do not look for backend logs in `logs/combined.log` / `logs/error.log`** -- those are legacy files from RSSHub's built-in winston File
> transport, disabled by `NO_LOGFILES`, and remain 0 bytes (they have no maxsize, which is how they reached
> 40GB on 2026-07-23). RSSHub worker output is captured by Stream itself, capped, and written to
> `logs/rsshub-worker.log` (`src/rsshub-worker-log.ts`).

**When startup fails or the backend is half-dead, check these three cases** (all are caused by resources shared between the host and containers, and are unrelated to business code):

1. **`/api/health` is 200, but logs contain `attempt to write a readonly database`** = files under `data/` were written by **another uid**
   (SQLite/JSON owned by root), and the backend on the host cannot open them. This half-dead state is the hardest to recognize. Fix (no sudo needed):
   ```bash
   docker run --rm -v $PWD/data:/d alpine chown -R $(id -u):$(id -g) /d
   ```
   Same class: if `data/ext-relay-token` is `root:root 600`, the backend crashes as soon as it reads it (see the `drive-live-ui` skill).
2. **`ENOSPC: System limit for number of file watchers reached`** (the backend and extension watchers both use polling and do not consume quota; this error comes from another inotify user, such as a manually started `vite build --watch`)
   = the inotify quota has been exhausted by another process on this machine -- watchers live on the host and **compete for the same quota as all host processes**
   (common heavy user: one CodeGraph MCP instance per Claude session, each of which can consume hundreds of thousands of watches). Check:
   compare `cat /proc/sys/fs/inotify/max_user_watches` with actual usage
   (sum `for f in /proc/[0-9]*/fdinfo/*; do grep -c ^inotify $f; done`), then rank heavy users by process.
   The fix is to raise the quota (`/etc/sysctl.d/60-stream-inotify.conf` = 4194304); **do not kill someone else's MCP**.
3. **`/_p/<plugin>` returns 502 immediately** (not a timeout) = that plugin container **does not exist**; it is not sleeping -- `docker compose down`
   deletes containers, while standby only starts/stops and does not create them. Fix: `docker compose create` to create it again (without starting it),
   and standby will still wake it on demand. To shut down the plugin layer, use `stop`, not `down`.

## Add a Backend Dependency

The backend runs on the host, so this is just a normal `pnpm add <pkg>`; `tsx watch` hot-reloads immediately. Native modules compile for the **host**,
and there is only one `node_modules`, compiled for the host.

> **Before running a script, `pnpm <script>` first verifies dependencies and automatically runs `install`** (`verifyDepsBeforeRun` in pnpm 11) --
> so `pnpm dev` **may modify your node_modules as a side effect**: if the tree and lockfile differ, it starts changing things; if it hits an owner
> that does not belong to you (root), it aborts with EACCES and `pnpm dev` does not start. Check: output contains `Packages: -N` or
> `EACCES ... node_modules`. The fix is to align the tree and restore ownership:
> ```bash
> docker run --rm -v $PWD:/w alpine chown -R $(id -u):$(id -g) /w/node_modules /w/app/node_modules
> pnpm install
> ```
> **Do not bypass the verification**. If you urgently need to start, run `scripts/dev.sh` directly (without the pnpm wrapper).

> **Dependencies in the self-hosted image** follow another set of rules: the dev override hides `/app/node_modules` behind an **anonymous volume** (the volume content
> is seeded once from the image when the container is created and does not track the lockfile). Therefore, in that mode, add dependencies with
> `docker compose exec serve-backend pnpm add <pkg>` (aligning the volume immediately), and when rebuilding the image you **must include**
> `--renew-anon-volumes`. The cost of missing that argument: the container shows `Up`, but `/api/health` is unreachable + logs show
> `Cannot find package '<x>'`, and it can stay broken like that for more than ten hours without reporting an error.

### Backend "Code Changes Have No Effect" -- the Hot-Reload Watcher Is Dead While the Child Process Is Still Alive

**The worst part of the symptom is that it does not look like a failure at all**: the page works, `/api/health` is 200, logs are clean, but every backend line
you change has no effect. The reason is that `tsx watch`'s file watcher crashed, while **the backend child process it launched does not die with it** --
it becomes an orphan and keeps serving the previous code version.

**Checks** (ask the live process first, then count processes):

```bash
curl -s 127.0.0.1:8900/api/health           # commit mismatch = it is really running old code; stop guessing
ps -eo pid,ppid,etime,cmd | grep serve.ts   # Child process still exists, but PPID is not tsx watch (it was reparented)
ps -eo pid,cmd | grep "tsx.*watch"          # Empty -> watcher is dead
```

If `etime` is clearly longer than the time of your last edit, that basically pins it down.

**Root cause**: RSSHub is imported from an **absolute path outside the repository** (tsconfig's `@/*` -> `$RSSHUB_SRC/lib`),
so `tsx watch` follows imports all the way into its `node_modules` -- tens of thousands of files; polling mode burns CPU for nothing, and inotify mode directly
blows through the quota. `scripts/dev.sh` already excludes it with `--exclude "$RSSHUB_SRC/node_modules/**"` (RSSHub's own
`lib/` still hot-reloads), and changes the trailing `wait` to `wait -n` -- if either leg falls first, the whole process is torn down, leaving no half-running remainder.

**What to do when it happens**: do not `touch` files (the watcher is gone, so touching anything is useless); restart `pnpm dev`.

### After Changing a Frontend Dependency Version -> Re-run `build:panel`; There Is No Other Cache to Clear

The UI is a panel bundle produced by `vite build` and does not go through the dev server, so Vite's dependency prebundle cache
(`app/node_modules/.vite/deps`, used only by the dev server) has no effect on it. After changing versions such as react,
`cd app && npm run build:panel` once is enough to get the new version; if the browser still sees the old version, first ask that artifact directly
(`curl -s 127.0.0.1:8900/panel/panel.js | grep -c <literal unique to the change>`) to verify whether it was actually rebuilt; do not hunt for cache.

### Start a Separate Backend for Smoke Tests/Verification -- Three Things Must Be Correct, and Getting Them Wrong Is **Silent**

The live 8900 process runs the scheduling center (A-share tasks place real orders), so when verifying things like "can the backend start" or "what happens with a bad package",
**start your own separate copy**; do not stop the live one. All three things must be done together for isolation to be real:

```yaml
# <smoke data dir>/config.yaml
packages_dir: /tmp/.../pkgs      # <- Critical; see below
manage_containers: false
```
Use `STREAM_PORT=<another port>` + `STREAM_DATA_DIR=<temporary directory>`. **Both must change**: the single-instance lock is keyed by
"port + pid file (or `STREAM_DATA_DIR`)"; changing only the port either fails to start or makes two backend instances write to the same
`data/stream.db`.

- **`packages_dir` must not point at the main checkout copy**. The second backend loads all built-in packages, and its standby manager
  `adopt()`s containers that the user is **currently running**, then stops them on exit -- while the live instance's cell state still remembers "awake",
  so `withAwake` sees awake and short-circuits, **and never brings it back**. The symptom is that AList and similar plugins silently die,
  with no log pointing to the cause. Point it at a temporary directory (empty, or containing only copied packages that do not declare `stream.backend`).
- **Symlinks do not work; it must be a real copy**. `scanPackages` uses `Dirent.isDirectory()` to identify directories; a symlinked directory returns
  `false` (it is `isSymbolicLink()`) -> `loaded 0 plugin descriptors`, **with no error**.
- **The user-level recipe directory is `<STREAM_DATA_DIR>/data/recipes`, not `<STREAM_DATA_DIR>/recipes`**.
  `resolveDataDir` uses `dirname(config.item_db)`, one level deeper than `STREAM_DATA_DIR`.

The symptoms of the last two are **identical** -- "the package I placed was not loaded", with not a single word in the logs. Hitting both at once looks like a wall of
`Unknown source`, which is easy to misread as "parsing broke".

Find the pid by port when stopping the process; do not use `pkill -f`. The task center's 8678 dashboard will collide with the live process on `EADDRINUSE`,
printing a stack trace, but it does not affect backend startup.

## compose: Generate Only the Plugin Container Layer

```bash
pnpm plugins compose        > docker-compose.yml            # Plugin containers (baked images)
pnpm plugins compose --dev  > docker-compose.override.yml   # Dev: plugins that declare backend.dev get source mounts + reload layered on
docker compose up -d                                        # compose automatically merges both
```

- The generated artifacts contain **no Stream backend/frontend itself and no gateway** -- those are on the host.
- `docker-compose.override.yml` is a **generated artifact and is gitignored**; after changing `packages/*/package.json`,
  rerun `pnpm plugins compose --dev` to regenerate it with the new config.
- **Adding a Plugin does not branch the setup**: the descriptor is declared once in the `stream` field of `packages/<id>/package.json`, and both compose files are generated from it.
- The backend on the host cannot reach container-internal DNS, so plugins use **host mode** (`STREAM_PLUGIN_NETWORK=host`; `pnpm dev`
  already sets this by default): each plugin container publishes one `127.0.0.1::<container port>` loopback random port, and after standby wakes it, the backend inspects
  the real port and connects directly. **The generated artifacts contain only plugin containers** -- login state does not go through containers (the extension pushes directly to the backend; see `docs/PACKAGE.md` §5.2),
  so all plugins are optional capabilities: with none installed, harvest still runs.

### Self-hosted Branch (NAS/VPS): Full Container Stack

```bash
pnpm plugins compose --selfhost > docker-compose.selfhost.yml   # Adds serve-backend/gateway
docker compose -f docker-compose.selfhost.yml up -d
```

In this mode, the backend sits behind Caddy (`STREAM_PORT=4555`, only `expose`d), the UI is still served by the backend's own front door, and the single published port remains
`127.0.0.1:8900`. **It has no "user's browser" side**, so human-like harvest for login Sources does not belong to this shape in the first place.

## Release Shape: Layered Installation (L0/L1/L2) -- the Same Backend as the dev Flow

Everything above describes **this repository's dev flow** (`pnpm dev`: native host backend + extension watcher, UI as prebuilt panel bundles). **The dev and release shapes are the same
thing**: both run the same native node backend and the same `8900` entrypoint; the only remaining differences are "who starts it"
(dev is `scripts/dev.sh`, release is MCP client spawn / OS service unit / the user's own `stream` command) and "where the frontend comes from"
(both use the panel bundles under `app/dist-panel/`; dev just requires you to run `build:panel` manually).

**How L0 is installed today**: `npx @streamapp/stream` (package under `cli/`, assembled by `node scripts/build-cli.mjs`).
There is only one startup contract -- set cwd to the resource directory, run `server.mjs`, and pass `STREAM_PORT`/`STREAM_DATA_DIR` through env.
**Native dependencies are not shipped with the npm package**; npm installs them for the user's platform. Data defaults to `~/.stream` -- the same directory used by the native messaging manifest and Stream Desktop's data pointer;
do not choose a second one. **Anything written to disk defaults under this root** (using `underData(...)` in `loadConfig`,
such as vault, databases, and music downloads under `music/`); only a user setting in `config.yaml` / environment variables sends it elsewhere.
Do not stitch together a default path with `homedir()` -- that creates an unwanted folder out of thin air in the user's home directory.

**Release shape** (user-installed Stream) is layered installation:

```
L0 core base     node backend + MCP (one codebase, one entrypoint)   <- Always present; the only invariant
L1 MCP registry  stdio command written into client config            <- Points to L0; almost always present
L2 resident (optional) OS service unit (systemd user / LaunchAgent / login task)  <- Points to L0; runtime switch
```

**There is no desktop-shell layer**: the UI is the panel served by the 8900 gate (and the Stream UI plugin inside the user's DSH).
Pure MCP users install only L0+L1; resident mode (L2) is an orthogonal optional add-on that merely "points to L0". The authoritative definition is in
[`docs/ARCHITECTURE.md` §Serving](./ARCHITECTURE.md#serving) +
`internal design record`.

**The only thing outside this layered model is the self-hosted container mode** (the full backend+frontend+Caddy stack inside compose, for
NAS/VPS) -- it is a third, independent deployment shape; see
`internal design record` §9.

## Release Verification: Whether the Published Package Works on a Clean Machine

Unit tests prove the source logic; **whether the published `@streamapp/stream` can install, start, and function on someone else's machine**
is known only by actually installing it once (missing packaged files, native dependencies failing to install, wrong host version injection -- all unit tests can be green and it can still fail). After every `npm publish`,
run this once against the test machine:

```bash
scripts/release-verify-remote.sh win-test --version 0.0.26 --old 0.0.25   # Windows test machine
scripts/release-verify-remote.sh mac      --version 0.0.26                 # Intel Mac
node scripts/release-verify.mjs --version 0.0.26 --old 0.0.25              # Local machine (first verify the script itself if the test machine is unreachable)
```

- **It does not touch the Stream currently in use on that machine**: both new and old versions are installed with `npm i --prefix` into temporary directories, each starts a backend on an independent port (8931/8932),
  an independent data directory, and `STREAM_NO_DESKTOP=1` (the backend is a child process of the script; it does not need a login session or scheduled task), and everything is deleted with the directory after testing.
  The only exception is **when `stream-*` plugin containers are running on the machine**: the verification backend would take them over and stop them on exit (see the three smoke-test items in the previous section),
  so in that case the script exits 2 immediately and does not start.
- **Checks accept only side effects**: real data returned by interfaces (recognized platform, real video title, native module that can load), not "no error".
- **`--old` runs the negative control**: the old version must reject the package under `--probe` **because of host version**, and the new version must allow it. Seeing only the new version allow it does not prove
  the gate has teeth.
- Exit code 0 = all pass / 1 = a check failed / 2 = environment is incomplete. For checks marked "external network", rule out the network first when they fail.
- **When a release gives users one more thing they can do, add one check to the script's `CHECKS`** -- use the entrypoint the user uses, and assert the real thing returned.
- Test-machine pitfalls: an unattended Windows machine sitting at the login screen goes to sleep after a while (ping fails); connect to both machines from **Windows-side `ssh.exe`**
  (direct WSL connections hang at the SSH banner), with presets documented in the header comments of `release-verify-remote.sh`. This script cannot verify the UI layer (whether buttons look right or respond when clicked);
  after logging into the desktop, use `drive-live-ui` to inspect it.

## Optional Capability Packages: How to Test Locally

`capabilities/netdisk/` is an **optional capability package** (it fills the `stream.capability` slot; the contract is in
[`PACKAGE.md` §5.9](./PACKAGE.md)). During development there are three ways to run it; choose based on what you need to verify:

| What to verify | How to run |
|---|---|
| **The package's own logic** | In the package directory, run `npm run typecheck` + `npm test` |
| **The artifact is self-contained** (whether a relative import was omitted) | Run `npm run bundle` to produce `dist/index.js`, then run that package's smoke script (such as `capabilities/netdisk/scripts/smoke-managed.mjs`). **The smoke test runs the artifact, not source** -- otherwise this constraint is not tested |
| **The whole seam** (installation gate -> write to disk -> dynamic import -> mount -> tools appear) | `scripts/qrun.sh node_modules/.bin/vitest run src/capabilities/optional-package.e2e.test.ts`. It really `npm pack`s a temporary fixture package and then walks the complete path |

**`stream add` accepts only the registry**: the installation gate requires matching integrity, so you cannot feed it a local tarball or `file:` path.
Therefore, if you want to try your modified package against the live backend, the only path is to first `npm publish` a prerelease version; regression for the whole seam relies on the
e2e above, not on manual testing.

**Installed packages are not hot-loaded**: the backend scans `<dataDir>/recipes/` only once on the startup path; restart it after changing installed packages. If the row in `/api/packages`
has an empty `tools` field -- restart first, then investigate.

## Built-in packages with code: producing npm artifacts

The seven packages under `packages/` that declare `stream.code` (bilibili / Douyin_TikTok_Download_API / xhs / netease / pansou /
eastmoney / alist) each produce a `dist/index.js` for npm publishing; the built-in layer still loads them from source (the contract is in [`PACKAGE.md` §3.8](./PACKAGE.md)).
`tsdown` is the **repo-root devDependency**, and `pnpm packages:bundle` (`scripts/bundle-code-packages.mjs`) takes it from the root
`node_modules/.bin/tsdown` and builds each package; package directories do not have their own node_modules, so `tsdown.config.ts` is written as a bare object and
does not `import 'tsdown'`. When the root dependencies in a worktree have not been refreshed, `STREAM_TSDOWN_BIN=<主检出>/node_modules/.bin/tsdown` (`主检出`, "main checkout") borrows one;
if neither location has it, the script exits 1 with an installation hint and does not silently skip. `dist/` is a gitignored build artifact, and `scripts/bundle-code-packages.real.test.ts`
really runs an xhs build once to pin the artifact shape (it fails instead of skipping when tsdown cannot be found).

## worktree workflow

See CONTRIBUTING.md "Workflow": open one worktree for each task, and do not work inline on `main`. The hot-reload stack
bind-mounts the **main checkout**, so worktree changes are picked up by the running stack only after they land in main.

## Starting containers for plugin backends

See [PACKAGE.md](./PACKAGE.md) §7 / CONTRIBUTING.md "Plugins": the only supported method is the generated compose,
**do not hand-write `docker run` / `docker build`** -- that bypasses the shared `stream` network, health checks, and credential broker.
