import { makeAndroidDriver, type AndroidCaps, type AndroidDriver, type AndroidDriverOptions, type AndroidElement, type AndroidOps } from './android-driver.ts'
export type { AndroidElement } from './android-driver.ts'
import type { OcrRequest } from './desktop-driver.ts'
import { pickTextDetailed, regionRect } from './desktop-see.ts'
import type { Feature, StateDef } from './state-graph.ts'
import { identifyWith, type FeatureTest, type IdentifyResult, type Perception } from './state-perception.ts'

/** The foreground app, as the OS reports it — never as the controlled app describes itself. */
export interface AndroidForeground {
  package: string
  /** The last activity seen for it (`package/activity`), without the package prefix. */
  activity?: string
  /** The window title, when the phone reports one. */
  title?: string
}

/** One read of the phone screen. The perception builds this ONCE per identify (ENGINE.md §6.5). */
export interface AndroidScreen {
  elements: AndroidElement[]
  viewport: { width: number; height: number }
  foreground: AndroidForeground
  /** What the OCR tier said about the frame; absent when the device never considered it. */
  ocr?: { ran: boolean; cached: boolean; texts: number; error?: string }
}

/** The read/write half of a remote device. Reads are all a state check needs. */
export interface AndroidProbe {
  /** Read the current screen. One `find` plus one `windows` and one `url`; no per-feature reads. */
  read(opts?: { ocr?: OcrRequest }): Promise<AndroidScreen>
  /** A readable scene for a failure receipt: foreground app + visible elements, best effort. */
  snapshot(): Promise<{ foreground?: AndroidForeground; elements: SceneElementLike[] }>
}

/** The subset of `SceneElement` the failure scene needs, kept local to avoid a cycle. */
export interface SceneElementLike {
  role?: string
  name?: string
  kind?: string
  rect: { x: number; y: number; w: number; h: number }
}

const EMPTY_VIEWPORT = { width: 1080, height: 2400 }

function activityOf(url: string, pkg: string): string | undefined {
  const slash = url.indexOf('/')
  if (slash < 0) return undefined
  const a = url.slice(slash + 1)
  if (!a) return undefined
  return a.startsWith('.') ? a : a.startsWith(pkg) ? a.slice(pkg.length) : a
}

/**
 * Build the probe every Android read goes through. `url` and `windows` are read once per
 * `read()`; when the device omits `url` the foreground comes from the window list, and when it
 * omits the OCR tier the read still returns accessibility elements.
 */
export function androidProbeFromDriver(driver: AndroidDriver): AndroidProbe {
  const read = async (opts: { ocr?: OcrRequest } = {}): Promise<AndroidScreen> => {
    const ocr = opts.ocr ?? 'auto'
    const readFind = async (mode: OcrRequest) => driver.find({}, { ocr: mode })
    let found = await readFind(ocr).catch(async (e) => {
      // A device without the OCR capability must still answer the accessibility half.
      if (ocr !== 'off' && /ui\.ocr/.test(String((e as Error)?.message ?? ''))) return readFind('off')
      throw e
    })
    const [wins, url] = await Promise.all([
      driver.windows().catch(() => []),
      driver.url().catch(() => ''),
    ])
    const win = wins.find((w) => w.foreground) ?? wins[0]
    const pkg = win?.process ?? url.split('/')[0] ?? ''
    const activity = url ? activityOf(url, pkg) : undefined
    return {
      elements: found.elements,
      viewport: found.viewport ?? win?.viewport ?? EMPTY_VIEWPORT,
      foreground: { package: pkg, ...(activity ? { activity } : {}), ...(win?.title ? { title: win.title } : {}) },
      ...(found.ocr ? { ocr: found.ocr } : {}),
    }
  }
  return {
    read,
    async snapshot() {
      try {
        const screen = await read({ ocr: 'auto' })
        return {
          foreground: screen.foreground,
          elements: screen.elements.slice(0, 80).map((e) => ({
            ...(e.role ? { role: e.role } : {}),
            ...(e.name ? { name: e.name } : {}),
            ...(e.source ? { kind: e.source } : {}),
            rect: e.rect,
          })),
        }
      } catch {
        return { elements: [] }
      }
    },
  }
}

const packageMatches = (want: string | string[] | undefined, got: string): boolean => {
  if (want === undefined) return true
  return Array.isArray(want) ? want.includes(got) : want === got
}

/**
 * Match one element against a query locally. `path` needs the tree's hierarchy, which the flat
 * `find` reply does not carry — a state feature asking for it is a mistake and throws (below),
 * while a recipe locator sends `path` to the device, which does have the tree.
 */
export function matchesAndroidQuery(e: AndroidElement, q: AndroidQueryLike): boolean {
  if (q.role !== undefined && e.role !== q.role) return false
  if (q.name !== undefined && e.name !== q.name) return false
  if (q.nameContains !== undefined && !e.name.toLowerCase().includes(q.nameContains.toLowerCase())) return false
  if (q.className !== undefined && e.className !== q.className) return false
  if (q.viewId !== undefined && e.viewId !== q.viewId) return false
  return true
}

interface AndroidQueryLike {
  role?: string
  name?: string
  nameContains?: string
  className?: string
  viewId?: string
  path?: unknown[]
}

function testFeature(screen: AndroidScreen, f: Feature): boolean {
  switch (f.kind) {
    case 'a11y': {
      const q = f.query as AndroidQueryLike
      if (q.path !== undefined) {
        throw new Error('安卓状态特征判不了 a11y query.path——识别只读一帧、拿到的是扁平元素表；path 只用于动作定位')
      }
      const there = screen.elements.some((e) => e.source !== 'ocr' && matchesAndroidQuery(e, q))
      return f.absent ? !there : there
    }
    case 'text': {
      const texts = screen.elements
        .filter((e) => e.name)
        .map((e) => ({ text: e.name, rect: e.rect }))
      const p = pickTextDetailed(
        texts,
        f.text,
        regionRect(undefined, { x: 0, y: 0, w: screen.viewport.width, h: screen.viewport.height }),
        undefined,
        undefined,
        true,
        f.where,
      )
      const there = p.kind !== 'none'
      return f.absent ? !there : there
    }
    case 'android-window': {
      const fg = screen.foreground
      const pkg = packageMatches(f.package, fg.package)
      const activity =
        f.activity === undefined
          ? true
          : !!fg.activity && (fg.activity === f.activity || fg.activity.endsWith(`/${f.activity}`) || fg.activity.endsWith(`.${f.activity}`))
      const title = f.title === undefined ? true : !!fg.title && fg.title.includes(f.title)
      const there = pkg && activity && title
      return f.absent ? !there : there
    }
    default:
      throw new Error(`安卓这条路线判不了 ${f.kind} 特征——图里混进了别的路线的东西`)
  }
}

/**
 * Android's `identify()`. Like desktop, it is not free: one screen read per call, and the
 * default policy is `on-failure` (the runner never recognizes on the normal path). Multiple
 * features are judged against the SAME frame — reading per feature would make an AND check
 * randomly false during animation.
 */
export class AndroidPerception implements Perception {
  constructor(private readonly probe: AndroidProbe) {}

  async identify(known: StateDef[]): Promise<IdentifyResult> {
    const needOcr = known.some((s) => s.features.some((f) => f.kind === 'text'))
    let screen: AndroidScreen | undefined
    const load = async (): Promise<AndroidScreen> => (screen ??= await this.probe.read({ ocr: needOcr ? 'on' : 'off' }))
    const test: FeatureTest = async (f) => testFeature(await load(), f)
    return identifyWith(known, test)
  }

  /** Poll one feature set. Each call is a fresh read; callers poll between device actions. */
  async check(features: Feature[]): Promise<boolean> {
    const needOcr = features.some((f) => f.kind === 'text')
    const screen = await this.probe.read({ ocr: needOcr ? 'on' : 'off' })
    return features.every((f) => testFeature(screen, f))
  }
}

/** A transport adapter over the embedder's ops function (openspec `device-actions`). */
export interface AndroidTransport {
  readonly driver: AndroidDriver
  readonly probe: AndroidProbe
  screenshot(): Promise<Buffer | null>
  close?(): Promise<void>
}

/**
 * The Android counterpart of the browser `Transport` seam: one object that holds the driver and
 * the read probe. `ops` is the embedder's own device connection — Stream never opens it.
 */
export function androidTransport(ops: AndroidOps, opts: AndroidDriverOptions = {}): AndroidTransport {
  const driver = makeAndroidDriver(ops, opts)
  return {
    driver,
    probe: androidProbeFromDriver(driver),
    screenshot: () => driver.screenshot(),
  }
}

/** Re-exported for embedders building their own transport over a capability manifest. */
export type { AndroidCaps }
