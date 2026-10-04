# @streamapp/plugin-sdk

SDK for people writing a **Stream package with code** (an `activate(ctx)` entry point).
If your package only ships a manifest and/or a recipe, you don't need this — it's for the
`stream.code` (adapter/normalizer/enricher) case.

Two halves:

- **Types** — the shape of `ctx` and of what `activate()` hands back. Hand-maintained
  copies of the host's definitions, so your editor and `tsc` know the contract.
- **Runtime toolkit** — re-exported from `shared/package-sdk/`, the one place the host and
  packages consume the *same source*: `ValidationError` / `ContentUnavailableError` (the
  two errors the host gives meaning to: 400 and 404 instead of 502), `mediaPlayUrl`, the
  html helpers (`toText` / `extractImages` / `stripImages` / `firstLink` / `extractLinks`),
  `BROWSER_UA`, `compareVersions`. You bundle these into your own `dist/index.js`.

Nothing in here is published to npm yet — that is a separate, explicit step; for now the
seven built-in code packages in `packages/` consume `shared/package-sdk/` directly and pin
the shape.

## Why the types are redeclared instead of imported

The Stream release backend is a single esbuild-bundled file (`server.mjs`) — there is
no host module your package can `import` at runtime. The *only* capability surface
your package gets is the `ctx` object handed to `activate()`. This SDK's types
describe that surface; they are redeclared independently of Stream's own internal
types (not re-exported), so installing this package can never accidentally drag a
chunk of Stream's internal `.d.ts` graph into your project.

## Why the errors are duck-typed

Your bundle carries its own copy of `ValidationError`, so `instanceof` against the host's
copy is always false. Each error instance therefore carries a marker (`validation: true` /
`unavailable: true`) and the host only reads the marker (`isValidationError` /
`isUnavailable`). Throw the SDK's class and it just works; a plain object with the marker
works too. `src/packages/plugin-sdk-compat.test.ts` pins this.

## Writing a package

1. `package.json` must declare a `stream` block naming this package's `entry` (the
   compiled JS file, relative to the package root) and the `adapters`/`normalizers`
   names your `activate()` returns — the host validates the returned keys against
   this list at load time and refuses to load a mismatch. See `docs/PACKAGE.md` for
   the full manifest shape.

2. Your entry module exports a function named `activate`:

   ```ts
   import type { ActivateFn } from '@streamapp/plugin-sdk'

   export const activate: ActivateFn = (ctx) => {
     return {
       adapters: {
         myAdapter: {
           id: 'myAdapter',
           async init(envOverrides) { /* … */ },
           async fetch(params, manifest, context) {
             const url = ctx.backendUrl('myservice')
             ctx.log(`fetching via ${url}`)
             return { items: [] }
           },
         },
       },
     }
   }
   ```

3. **`dist/index.js` (or whatever `stream.code.entry` names) must be a single
   pre-bundled ESM file with all of your dependencies compiled in.** The host does
   **not** run `npm install` for third-party packages — npm/the tarball is only the
   transport, not a dependency-resolution step. If your package imports anything
   beyond Node builtins, bundle it (esbuild/rollup/tsup — anything that emits one
   self-contained ESM file) before publishing.

4. `ctx.cookieFor(domain)` only works for domains your package's manifest lists
   under `credentials` — anything else throws. Declare every domain you touch.

5. **A code-format package only takes effect after Stream restarts.** Dynamic
   `import()` of your entry happens once at boot; installing or updating a code
   package while the backend is running does not hot-swap it — the user (or you,
   in dev) has to restart Stream to pick up the change.

## What's in here

- `PluginContext` — the `ctx` your `activate()` receives.
- `PackageActivation` / `ActivateFn` — what `activate()` must return and its signature.
- `Adapter` / `AdapterSidecar` / `AdapterFetchResult` / `SourceExecutionContext` — the
  adapter contract, if your package registers one.
- `SourceManifest` and its component types — the shape of the manifest object your
  adapter's `fetch()` receives (you don't construct these; the host does, from your
  package's declarative manifest files).
- `Normalizer` — the content-normalization function shape, if your package registers one.
- `Enricher` / `ConnectFn` / `PackageAction` — the other three things `activate()` may hand back.
- Runtime: `ValidationError` / `isValidationError` / `ContentUnavailableError` / `isUnavailable`,
  `mediaPlayUrl`, `toText` / `extractImages` / `stripImages` / `firstLink` / `extractLinks`,
  `BROWSER_UA`, `compareVersions` / `isStrictlyHigher` / `parseVersion`.

The types are hand-maintained copies of Stream's internal types (see the comment at the
top of `index.ts`). If you're the one making changes to this SDK from inside the
Stream repo: `src/packages/plugin-sdk-compat.test.ts` guards `PluginContext` against
drift from the host's real definition — keep it green.
