import type { PageDriver } from '../../shared/browser-relay/page-driver.ts'
import { inventoryExpression } from '../../shared/browser-relay/page-inventory.ts'
import type { DesktopDriver } from './desktop-driver.ts'

export interface SceneElement {
  /** 浏览器侧的清单编号（会话级脚手架，**绝不写进 recipe**，见 page-inventory.ts 头注）。 */
  n?: number
  tag?: string
  role?: string
  name?: string
  /** 桌面侧的来源档：a11y / detector / text。 */
  kind?: string
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * 一次介入的**现场**：AI 被问的时候看到的东西，也是人审提议时看到的东西（spec §4.1、§9）。
 * 每一项独立 best-effort——现场捕获永远不许盖掉真正的失败原因。
 */
export interface Scene {
  side: 'browser' | 'desktop'
  url?: string
  title?: string
  text?: string
  /** `truncated` = 这张图太大，落库时被丢掉了（`base64` 留空）。**如实说而不是当没有截图**：
   *  人审提议时要能分清「引擎没抓到」和「抓到了但没存」，两者的下一步完全不同。 */
  shot?: { mime: 'image/jpeg' | 'image/png'; base64: string; truncated?: boolean }
  elements: SceneElement[]
  truncated?: boolean
}

const TEXT_CAP = 1200

export async function captureBrowserScene(driver: PageDriver, fallbackUrl?: string): Promise<Scene> {
  const scene: Scene = { side: 'browser', elements: [] }
  scene.url = (await driver.currentUrl?.().catch(() => undefined)) ?? fallbackUrl
  const probe = (await driver
    .evalJson?.(`(()=>({t:document.title,x:(document.body&&document.body.innerText||"").slice(0,${TEXT_CAP})}))()`)
    .catch(() => undefined)) as { t?: string; x?: string } | undefined
  if (probe?.t) scene.title = probe.t
  if (probe?.x) scene.text = probe.x
  const inv = (await driver.evalJson?.(inventoryExpression()).catch(() => undefined)) as
    | { items?: SceneElement[]; truncated?: boolean; __error?: string } | undefined
  if (inv && Array.isArray(inv.items)) {
    scene.elements = inv.items.map((i) => ({
      ...(i.n !== undefined ? { n: i.n } : {}), ...(i.tag ? { tag: i.tag } : {}), ...(i.role ? { role: i.role } : {}),
      ...(i.name ? { name: i.name } : {}), rect: i.rect,
    }))
    if (inv.truncated) scene.truncated = true
  }
  // 整屏优先：`shotViewport` 截的是此刻那一屏，正是人审和模型要看的东西。
  // **只在这一格「不存在」时才退回 `shotOf('body')`**，回 null 不退——null 是"试过了、没有"，
  // 再拿一张按 body 矩形裁的图去补，只会在滚过几十屏之后再失败一次。
  //
  // **后台档（unattended）的标签两条路都截不到**：Chrome 不给不显示在屏幕上的标签画帧，
  // `Page.captureScreenshot` 在扩展侧 1.5s 到点判失败（`extension/src/lib/driver.ts` 的
  // `SCREENSHOT_BUDGET_MS`，含实测数字）。活体 2026-09-11 的 xhs-search 两轮都是这么丢的——
  // 现场只有文字 + 元素表，模型照样答对了。这不是 bug，别在这里加"抢到前台截一张"：
  // 后台档的承诺就是不抢屏，一次失败诊断不值得让浏览器蹦到用户面前。
  const shot = driver.shotViewport
    ? await driver.shotViewport().catch(() => null)
    : ((await driver.shotOf?.('body').catch(() => null)) ?? null)
  if (shot) scene.shot = { mime: 'image/jpeg', base64: shot }
  return scene
}

export async function captureDesktopScene(driver: DesktopDriver): Promise<Scene> {
  const scene: Scene = { side: 'desktop', elements: [] }
  scene.url = (await driver.url().catch(() => undefined)) || undefined
  const cap = await driver.captureWindow().catch(() => null)
  if (cap) scene.shot = { mime: 'image/jpeg', base64: cap.jpeg.toString('base64') }
  const els = await driver.readElements().catch(() => null)
  if (els) scene.elements = els.elements.map((e) => ({ ...(e.name ? { name: e.name } : {}), kind: e.kind, rect: e.rect }))
  const txt = await driver.readText().catch(() => null)
  if (txt && txt.texts.length) scene.text = txt.texts.map((t) => t.text).join('\n').slice(0, TEXT_CAP)
  return scene
}
