# Contributing to Stream

Thank you for helping improve Stream. This guide covers the public repository
workflow; report security-sensitive issues privately rather than putting
credentials, cookies, or personal data in an issue or pull request.

## Local development

Use Node 20 or newer and install the repository dependencies once:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The backend is the only public local entry point: <http://127.0.0.1:8900>.
It serves the UI, API, WebSocket endpoint, and plugin gateway. `pnpm dev`
starts the native backend and the browser-extension watcher; plugin containers
are optional and start separately with `docker compose up -d`.

Run checks before opening a pull request:

```bash
pnpm test
pnpm typecheck
cd app && npm run typecheck && npm test
```

## Repository layout

- `src/` is the Stream backend and MCP surface.
- `app/` is the web UI and desktop host-agent source.
- `extension/` carries the browser extension.
- `packages/` contains built-in Stream packages and recipes.
- `capabilities/` contains built-in capabilities such as desktop and netdisk.
- `shared/` contains rules consumed by both backend and frontend.

## Add or change a Source

A Source is delivered as a Stream package. Start with
[the package contract](docs/PACKAGE.md): it defines the manifest, recipe,
code, capability, container, and credential slots. Keep source-specific
knowledge in that package; the host owns generic loading, scheduling, and
credential plumbing.

For a new source, add the smallest package shape that can declare and run it,
write a focused test, and verify one real non-destructive fetch where access
is available. Do not add a credential, cookie, browser profile, or a captured
real-user response to fixtures.

## Pull requests

Keep each pull request focused and explain the user-visible behavior, the
verification you ran, and any platform or credential assumptions. Add or
update tests for behavior changes. Do not commit `data/`, `.env`,
`config.yaml`, browser state, local paths, generated release artifacts, or
other machine-specific files.

## Specifications

`openspec/specs/` contains the current public behavior contracts. Put a
proposed, still-active change in `openspec/changes/<change-name>/` alongside
its implementation. Do not add completed-change archives, incident records,
or any captured credentials, personal data, or machine-local details.
