import type { Scene } from '../replay/scene.ts'
import type { InventoryItem } from './explore-graph.ts'

export type CdpVerbs = {
  look(a: { target: string; js?: string; inventory?: boolean }): Promise<unknown>
  act(a: Record<string, unknown> & { target: string }): Promise<unknown>
  shot(a: { target: string }): Promise<{ shot: string | null }>
}

export interface ExploreSurface {
  readonly side: 'browser'
  url(): Promise<string>
  inventory(): Promise<InventoryItem[]>
  /** 真点编号 ref。返回「点着了没」（`ActResult.status` 不是 not-found）。 */
  click(ref: number): Promise<boolean>
  back(): Promise<void>
  /**
   * 等这一屏不动了再往下走。**点击是异步的，而 `identify()` 是同步的一问**——点完立刻认，
   * 认到的是**导航发生之前**那一屏。活体（xhs，2026-09-12 第二条探索）：点侧栏「点点ai」真的跳到了
   * `/ai_chat`，我们在 `/explore` 上认了一次，判成 `noop`（死键），那条边从此不再被点——
   * 一条真实存在的路被永久标成死的，而每一步的回执都正常。
   *
   * **回执要说清是等稳了还是等到头了**：`settled:false` = 撞上限了、按当前样子认。这条退路必须
   * 留痕——不然「等稳之后认的」和「等烦了认的」长得一模一样，而后者认错的概率高得多。
   */
  settle(): Promise<{ settled: boolean; waitedMs: number }>
  exists(selector: string): Promise<boolean>
  scene(): Promise<Scene>
  /** 给 `DomPerception` 用的最小 PageDriver 视图。 */
  perceptionDriver(): { currentUrl(): Promise<string>; exists(sel: string): Promise<boolean> }
}

const TEXT_CAP = 4000
/** 连续这么久没变就算稳。 */
const SETTLE_STABLE_MS = 500
/** 等不稳也要走——**上限不是可选项**：站点上有永不停的轮询与动画，没有它 settle 会一直等下去。 */
const SETTLE_CAP_MS = 3000
const SETTLE_TICK_MS = 100
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const valueOf = (r: unknown): unknown => (r && typeof r === 'object' && 'value' in (r as object) ? (r as { value: unknown }).value : r)

/**
 * 网页面：骑 `cdp_*` 路由的 `chrome:<tabId>` 档——和 agent 自己 `cdp_look` 看到的是同一张标签，
 * 只是点的人换成了 Stream（拉黑闸、效果判定都在点之前 / 之后由我们做）。
 * `confirmed:true`：高危确认门是给模型的对齐件（mcp-extras 头注），这里的点击已经过了我们自己的闸。
 */
export function browserSurface(cdp: CdpVerbs, target: string): ExploreSurface {
  if (!/^chrome:\d+$/.test(target)) throw new Error(`探索面只认 chrome:<tabId>，收到 ${target}（用 cdp_pages 拿一个 tabId）`)
  const look = async (js: string): Promise<unknown> => valueOf(await cdp.look({ target, js }))
  const url = async (): Promise<string> => String((await look('location.href')) ?? '')
  const domain = async (): Promise<string> => { try { return new URL(await url()).hostname } catch { return '' } }
  const inventory = async (): Promise<InventoryItem[]> => {
    const v = valueOf(await cdp.look({ target, inventory: true })) as { items?: InventoryItem[]; __error?: string } | null
    return v && Array.isArray(v.items) ? v.items : []
  }
  const exists = async (sel: string): Promise<boolean> => (await look(`!!document.querySelector(${JSON.stringify(sel)})`)) === true
  return {
    side: 'browser',
    url,
    inventory,
    exists,
    async click(ref) {
      const r = (await cdp.act({ target, kind: 'click', ref, domain: await domain(), confirmed: true })) as { status?: string } | null
      return !!r && r.status !== 'not-found'
    },
    async back() { await cdp.act({ target, kind: 'back', domain: await domain(), confirmed: true }) },
    async settle() {
      // 三样一起看：地址、文档状态、可交互元素的条数。**元素数只是个变化信号，不是真相**——
      // 这里用一条便宜的 querySelectorAll 近似 inventory 的口径（少一次 cdp 往返），
      // 它数多数少都不影响判断，只要"变了没有"这一点是对的。
      const probe = `(()=>({h:location.href,r:document.readyState,n:document.querySelectorAll('a,button,input,select,textarea,[role],[onclick]').length}))()`
      const t0 = Date.now()
      let last: string | undefined
      let since = t0
      while (Date.now() - t0 < SETTLE_CAP_MS) {
        const v = (await look(probe).catch(() => undefined)) as { h?: string; r?: string; n?: number } | undefined
        // 读不到就当"还没稳"继续等——**不要当成稳了**：导航正中间的那一瞬恰好读不到，
        // 而把它读成稳，就等于把这道闸在最需要它的时刻关掉。
        const sig = v ? `${v.h}|${v.r}|${v.n}` : undefined
        if (sig !== undefined && sig === last && v?.r !== 'loading' && Date.now() - since >= SETTLE_STABLE_MS) {
          return { settled: true, waitedMs: Date.now() - t0 }
        }
        if (sig !== last) { last = sig; since = Date.now() }
        await sleep(SETTLE_TICK_MS)
      }
      return { settled: false, waitedMs: Date.now() - t0 }
    },
    async scene() {
      const scene: Scene = { side: 'browser', elements: [] }
      scene.url = await url().catch(() => undefined)
      const probe = (await look(`(()=>({t:document.title,x:(document.body&&document.body.innerText||"").slice(0,${TEXT_CAP})}))()`).catch(() => undefined)) as { t?: string; x?: string } | undefined
      if (probe?.t) scene.title = probe.t
      if (probe?.x) scene.text = probe.x
      scene.elements = (await inventory().catch(() => [])).map((i) => ({ n: i.n, ...(i.tag ? { tag: i.tag } : {}), ...(i.role ? { role: i.role } : {}), ...(i.name ? { name: i.name } : {}), rect: i.rect }))
      const shot = (await cdp.shot({ target }).catch(() => ({ shot: null }))).shot
      if (shot) scene.shot = { mime: 'image/jpeg', base64: shot }
      return scene
    },
    perceptionDriver: () => ({ currentUrl: url, exists }),
  }
}
