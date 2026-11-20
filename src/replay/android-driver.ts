import type { A11yElement, A11yQuery, ActOutcome, OcrRequest, Rect, WindowInfo } from './desktop-driver.ts'

/**
 * The normalized device action names (openspec `device-actions`). A caller targets the same
 * action on any surface under these names; each surface maps them to its own wire ops.
 *
 * `tap` / `longPress` / `swipe` / `setText` / `openApp` are the names this module prefers; the
 * Android agent's existing wire ops (`click`, `focusApp`, `setValue`) remain aliases below the
 * seam so older agents keep working.
 */
export const ANDROID_OP_NAMES = [
  'tap', 'longPress', 'swipe', 'scroll', 'type', 'setText', 'press', 'screenshot',
  'find', 'windows', 'openApp', 'sleep', 'url',
] as const

export type AndroidQuery = A11yQuery & {
  /** Android (`ui.tree` v7): match the node's resource id exactly (e.g. `com.example:id/search`). */
  viewId?: string
}

export interface AndroidElement extends A11yElement {}

export interface AndroidFindResult {
  elements: AndroidElement[]
  viewport?: { width: number; height: number }
  unbuilt?: string
  ocr?: { ran: boolean; cached: boolean; texts: number; error?: string }
  timing?: { ocrMs?: number }
}

export interface AndroidActOutcome extends ActOutcome {}

export interface AndroidWindow extends WindowInfo {
  /** The screen the window sits on, in physical pixels (Android `ui.tree` v3). */
  viewport?: { width: number; height: number }
}

export interface AndroidScrollOptions {
  amount?: number
  until?: string
  maxSteps?: number
  timeoutMs?: number
}

export interface AndroidScrollReceipt {
  method?: 'a11y' | 'gesture'
  steps?: number
  via?: 'a11y' | 'coords'
  found?: boolean
  scrolls?: number
  stopped?: string
  match?: { name: string; role: string; rect: Rect }
  visible?: string[]
  timing?: Record<string, number>
  end?: boolean
  /** The list's own content moved nowhere in this op (capability `ui.tree` v8). */
  moved?: boolean
  /** Why nothing moved, when it didn't: `container-at-end`, `gesture-no-effect` or
   *  `no-container` (capability `ui.tree` v8). */
  reason?: string
  settled?: boolean
  [key: string]: unknown
}

/** One request to the remote device. The embedder owns the connection; this is all Stream needs. */
export type AndroidOps = (op: string, args?: Record<string, unknown>) => Promise<unknown>

export interface AndroidCaps {
  [id: string]: { v: number; availability?: string }
}

export interface AndroidDriverOptions {
  /** The ops the device declared in its `hello`; an undeclared op is refused before it is sent. */
  ops?: ReadonlySet<string>
  /** The capability manifest the device declared; a too-old capability is refused before sending. */
  caps?: AndroidCaps
}

/** The device did not declare this op. Raised before anything is sent. */
export class AndroidUnsupportedOpError extends Error {
  constructor(readonly op: string) {
    super(`unsupported-op: ${op} is not declared by this device`)
    this.name = 'AndroidUnsupportedOpError'
  }
}

/** The device declared the capability, but below the version the action needs. */
export class AndroidUnsupportedCapabilityError extends Error {
  constructor(readonly capability: string, readonly needed: number, readonly declared?: number) {
    super(
      declared === undefined
        ? `unsupported-capability: ${capability} v${needed} is required and the device did not declare it`
        : `unsupported-capability: ${capability} v${needed} is required, the device declared v${declared}`,
    )
    this.name = 'AndroidUnsupportedCapabilityError'
  }
}

/**
 * The remote-device driver. It is deliberately independent of the relay: the embedder passes an
 * `ops(op, args) → reply` function and Stream never opens the device connection itself.
 *
 * Capability negotiation happens here, BEFORE the wire: an op the device did not declare, or a
 * capability below the version its behavior needs, fails locally with a readable error instead of
 * being discovered by sending the op and matching an error string.
 */
export interface AndroidDriver {
  windows(): Promise<AndroidWindow[]>
  scopeWindow(match: { process: string; title?: string }): Promise<AndroidWindow>
  openApp(packageName: string, fresh?: boolean): Promise<boolean>
  find(query: AndroidQuery, options?: { ocr?: OcrRequest }): Promise<AndroidFindResult>
  tap(rect: Rect): Promise<AndroidActOutcome>
  longPress(rect: Rect, durationMs?: number): Promise<AndroidActOutcome>
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs?: number): Promise<AndroidActOutcome>
  scroll(dir: 'up' | 'down', options: AndroidScrollOptions): Promise<AndroidScrollReceipt>
  type(text: string): Promise<AndroidActOutcome>
  setText(ref: string, text: string): Promise<AndroidActOutcome>
  press(key: 'Back' | 'Home' | 'Enter'): Promise<AndroidActOutcome>
  screenshot(): Promise<Buffer | null>
  sleep(ms: number): Promise<void>
  url(): Promise<string>
  readSubtree(spec: Record<string, unknown>): Promise<Record<string, string>[]>
}

/**
 * Wire op(s) each normalized action is sent as, in preference order. The first name is the one
 * the Android agent has always spoken; the second is the normalized action name itself, which an
 * agent written against the shared action vocabulary declares instead (the iOS agent declares
 * `tap`, `openApp` and `setText`, not the Android aliases). Which one is sent follows the op set
 * the device declared in its hello; a device that declares neither is refused before the wire.
 *
 * Exported as part of the public entry so an embedder drives a device from the same table instead
 * of keeping a copy that can drift. Look actions up through {@link wireNamesFor} /
 * {@link wireOpName}; the object is plain, typed data.
 */
export const DEVICE_WIRE_OPS = {
  tap: ['click', 'tap'],
  longPress: ['longPress'],
  swipe: ['swipe'],
  scroll: ['scroll'],
  type: ['type'],
  setText: ['setValue', 'setText'],
  press: ['press'],
  screenshot: ['screenshot'],
  find: ['find'],
  windows: ['windows'],
  openApp: ['focusApp', 'openApp'],
  sleep: ['sleep'],
  url: ['url'],
  scopeWindow: ['scopeWindow'],
  readSubtree: ['readSubtree'],
} as const

/** A normalized action in {@link DEVICE_WIRE_OPS}. */
export type DeviceWireAction = keyof typeof DEVICE_WIRE_OPS

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The canonical action for a name in either vocabulary (`tap` or `click`, `setText` or `setValue`,
 * `openApp` or `focusApp`), or undefined for a name outside the table. Callers that keep the
 * Android spelling internally can pass it straight through.
 */
export function wireActionOf(action: string): DeviceWireAction | undefined {
  if (Object.hasOwn(DEVICE_WIRE_OPS, action)) return action as DeviceWireAction
  for (const [canonical, names] of Object.entries(DEVICE_WIRE_OPS)) {
    if ((names as readonly string[]).includes(action)) return canonical as DeviceWireAction
  }
  return undefined
}

/** Every wire spelling of an action, preferred first; `[]` = a name outside the table. Accepts
 *  either vocabulary (`tap` / `click`, …). */
export function wireNamesFor(action: string): readonly string[] {
  const canonical = wireActionOf(action)
  return canonical ? DEVICE_WIRE_OPS[canonical] : []
}

const declarationHas = (declared: ReadonlySet<string> | readonly string[]) =>
  Array.isArray(declared)
    ? (name: string) => declared.includes(name)
    : (name: string) => (declared as ReadonlySet<string>).has(name)

/**
 * The wire op name to send for a normalized action: the first spelling the device declared in its
 * hello, in preference order. Without a declaration the preferred (Android) spelling is returned;
 * with a declaration that matches neither spelling the answer is undefined and the caller
 * must refuse before the wire. A raw op name outside the normalized table passes through as its own
 * spelling (and is still refused when the device did not declare it).
 */
export function wireOpName(
  action: string,
  declared?: ReadonlySet<string> | readonly string[] | undefined,
): string | undefined {
  const names = wireNamesFor(action)
  // A raw op name outside the normalized table (`invoke`, `status`, …) has exactly one spelling:
  // it passes through when the device declares it, and is refused when it does not.
  if (names.length === 0) {
    if (!declared) return action
    return declarationHas(declared)(action) ? action : undefined
  }
  if (!declared) return names[0]!
  const has = declarationHas(declared)
  return names.find((name) => has(name)) ?? undefined
}

/**
 * Arguments for the spelling chosen by {@link wireOpName}. The two open-app spellings disagree:
 * `focusApp` names the app through `{ match: { process } }`, the normalized `openApp` takes
 * `{ package }`. Every other action shares one argument shape and is returned untouched.
 */
export function wireArgsFor(
  action: string,
  wire: string,
  args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (wireActionOf(action) !== 'openApp' || wire !== 'openApp' || !args) return args
  const match = args.match
  if (!isRecord(match) || typeof match.process !== 'string' || match.process === '') return args
  const { match: _match, ...rest } = args
  void _match
  return { package: match.process, ...rest }
}

/**
 * Window-row identity across surfaces: the Android agent names the foreground app `process` and
 * marks the foreground row `foreground`; the iOS agent uses `app` and `focused`. Embedders read
 * both through this one function instead of carrying their own aliases.
 */
export interface DeviceWindowIdentity {
  app: string | undefined
  foreground: boolean
}

export function windowIdentity(row: unknown): DeviceWindowIdentity {
  const r = isRecord(row) ? row : {}
  const app =
    typeof r.process === 'string' && r.process !== ''
      ? r.process
      : typeof r.app === 'string' && r.app !== ''
        ? r.app
        : undefined
  // `focused` is the iOS spelling; only trust it when the row has no `process` at all (an Android
  // row with a stray focused flag is still not the foreground window).
  const foreground = r.foreground === true || (r.process === undefined && r.focused === true)
  return { app, foreground }
}

const outcome = (v: unknown): AndroidActOutcome => {
  const raw = v as
    | { confirmed?: unknown; via?: unknown; settled?: unknown; changedDuringRead?: unknown; effect?: unknown; relocated?: unknown }
    | null
  const via =
    raw?.via === 'invoke' || raw?.via === 'coords' || raw?.via === 'value' || raw?.via === 'message' ? raw.via : undefined
  const effect =
    raw?.effect === 'done' || raw?.effect === 'small_change' || raw?.effect === 'no_effect' || raw?.effect === 'place_changed'
      ? raw.effect
      : undefined
  return {
    ...(via ? { via } : {}),
    ...(typeof raw?.confirmed === 'boolean' ? { confirmed: raw.confirmed } : {}),
    ...(typeof raw?.settled === 'boolean' ? { settled: raw.settled } : {}),
    ...(typeof raw?.changedDuringRead === 'boolean' ? { changedDuringRead: raw.changedDuringRead } : {}),
    ...(effect ? { effect } : {}),
    ...(raw?.relocated === true ? { relocated: true } : {}),
  }
}

function parseFind(v: unknown): AndroidFindResult {
  if (Array.isArray(v)) return { elements: v as AndroidElement[] }
  const raw = v as
    | { elements?: AndroidElement[]; viewport?: { width: number; height: number }; unbuilt?: unknown; ocr?: unknown; timing?: unknown }
    | null
  const unbuilt = typeof raw?.unbuilt === 'string' ? raw.unbuilt : undefined
  const viewport =
    raw?.viewport && typeof raw.viewport.width === 'number' && typeof raw.viewport.height === 'number' ? raw.viewport : undefined
  const o = raw?.ocr as Record<string, unknown> | undefined
  const ocr =
    o && typeof o.ran === 'boolean' && typeof o.cached === 'boolean' && typeof o.texts === 'number'
      ? { ran: o.ran, cached: o.cached, texts: o.texts, ...(typeof o.error === 'string' ? { error: o.error } : {}) }
      : undefined
  const t = raw?.timing as Record<string, unknown> | undefined
  const timing = t && typeof t.ocrMs === 'number' ? { ocrMs: t.ocrMs } : undefined
  return {
    elements: raw?.elements ?? [],
    ...(unbuilt ? { unbuilt } : {}),
    ...(viewport ? { viewport } : {}),
    ...(ocr ? { ocr } : {}),
    ...(timing ? { timing } : {}),
  }
}

/**
 * Build an `AndroidDriver` over the embedder's ops function. If `opts.ops` / `opts.caps` are
 * given, the driver enforces them locally; without them it trusts the function (tests, and an
 * embedder that has already negotiated).
 */
export function makeAndroidDriver(ops: AndroidOps, opts: AndroidDriverOptions = {}): AndroidDriver {
  const declared = opts.ops
  const caps = opts.caps
  const wireOf = (action: DeviceWireAction): string => {
    const names = DEVICE_WIRE_OPS[action]
    const hit = wireOpName(action, declared)
    // Name the preferred spelling: that is the one an older caller would have expected to work.
    if (!hit) throw new AndroidUnsupportedOpError(names[0])
    return hit
  }
  const send = async (action: DeviceWireAction, args?: Record<string, unknown>): Promise<unknown> => {
    return ops(wireOf(action), args)
  }
  const requireCap = (id: string, needed: number): void => {
    if (!caps) return
    const declaredV = caps[id]?.v
    if (declaredV === undefined || declaredV < needed) throw new AndroidUnsupportedCapabilityError(id, needed, declaredV)
  }
  const requireGestureCaps = (): void => requireCap('ui.act', 2)

  return {
    async windows() {
      const r = await send('windows')
      return Array.isArray(r) ? (r as AndroidWindow[]) : []
    },
    async scopeWindow(match) {
      const r = (await send('scopeWindow', { match })) as { window: AndroidWindow }
      return r.window
    },
    async openApp(packageName, fresh) {
      // The Android agent names the app through `match.process`; the normalized op takes the
      // identifier itself (`package`) — on a phone that identifier is the bundle id.
      const wire = wireOf('openApp')
      const args = wireArgsFor('openApp', wire, { match: { process: packageName }, ...(fresh ? { fresh: true } : {}) })
      const r = (await ops(wire, args)) as boolean | { ok?: boolean }
      return typeof r === 'boolean' ? r : r?.ok === true
    },
    async find(query, options) {
      if (query.name !== undefined && query.nameContains !== undefined) {
        throw new Error('a11y query: name 与 nameContains 只能给一个（前者全等、后者包含）')
      }
      if (query.viewId !== undefined) requireCap('ui.tree', 7)
      if (options?.ocr && options.ocr !== 'off') requireCap('ui.ocr', 1)
      return parseFind(await send('find', { query, ...(options?.ocr ? { ocr: options.ocr } : {}) }))
    },
    async tap(rect) {
      return outcome(await send('tap', { rect, button: 'left' }))
    },
    async longPress(rect, durationMs = 600) {
      requireGestureCaps()
      return outcome(await send('longPress', { rect, durationMs }))
    },
    async swipe(from, to, durationMs = 300) {
      requireGestureCaps()
      return outcome(await send('swipe', { from, to, durationMs }))
    },
    async scroll(dir, options) {
      const args: Record<string, unknown> = { dir }
      if (options.until !== undefined) {
        args.until = options.until
        if (options.maxSteps !== undefined) args.maxSteps = options.maxSteps
        if (options.timeoutMs !== undefined) args.timeoutMs = options.timeoutMs
      } else {
        args.amount = options.amount ?? 1
      }
      return ((await send('scroll', args)) ?? {}) as AndroidScrollReceipt
    },
    async type(text) {
      return outcome(await send('type', { text }))
    },
    async setText(ref, text) {
      return outcome(await send('setText', { ref, text }))
    },
    async press(key) {
      return outcome(await send('press', { key }))
    },
    async screenshot() {
      const r = (await send('screenshot')) as { base64?: string } | null
      return r?.base64 ? Buffer.from(r.base64, 'base64') : null
    },
    async sleep(ms) {
      await send('sleep', { ms })
    },
    async url() {
      return ((await send('url')) as string) ?? ''
    },
    async readSubtree(spec) {
      return ((await send('readSubtree', { spec })) as Record<string, string>[]) ?? []
    },
  }
}
