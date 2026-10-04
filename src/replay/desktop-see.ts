import sharp from 'sharp'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { DesktopDriver, Rect, ScreenText, SeeElement } from './desktop-driver.ts'
import type { DesktopInterrupt, See, SeeRegion, TextWhere } from './desktop-recipe.ts'
import type { LlmForTask } from '../llm/task.ts'
import { SeeCache } from './see-cache.ts'

/**
 * `pixel` 词汇的识别层：把一个 `see` 变成一个屏幕物理坐标框。
 *
 * 这个文件分两半：上半是纯函数（region / 文字匹配 / 坐标合成 / 叠图 / 裁模板），下半是四段梯子
 * `resolveSee`（Task 5）。runner 只认识 `resolveSee`；梯子每一段的进出都靠上半的纯函数单测钉住。
 *
 * 坐标只有两套：**截图坐标**（相对窗口左上角，物理像素）与**屏幕物理坐标**（截图坐标 + 窗口原点）。
 * DPI 修复之后 wire 上一切都是物理像素，这里不出现 `÷ scale`——出现了就是有人又造了第三套。
 */
/**
 * 这一次命中是从梯子哪一档来的。
 *
 * `pinned` 和 `a11y` 都是"查了一次控件树"，但**必须分开记**：`a11y` 是拿 recipe 里写的那段
 * 文字去查，`pinned` 是拿**上一趟模型固化下来的句柄**去查。两者陈旧时的处置不一样（前者是
 * recipe 该改，后者是句柄该丢），而且合并之后就看不出这一趟到底走的哪条路——
 * 「绿灯不证明走的是你以为的那条路」。
 */
export type SeeVia = 'a11y' | 'pinned' | 'screen' | 'template' | 'model' | 'point'

/**
 * 这一次定位**查哪张表**。由 `see` 出现在 recipe 的哪个位置决定，**不给作者留选择余地**
 * （spec §3）：动作步骤的目标与 `interrupts[].dismiss` 是 `'action'`（查元素表），
 * `expect` / `require` / `branch.when` / `interrupts[].see` 是 `'read'`（查文字表）。
 *
 * 作者一旦能选，就会有人在判据里查元素表（付整窗元素合成的钱去确认一句话），也会有人在动作
 * 里查文字表（点在两个按钮中间的空白处）——这两个错都不报错，只表现成"慢"和"偶尔点空"。
 */
export type SeeMode = 'action' | 'read'

/**
 * 一个 `region` 落到具体窗口上的样子：一块矩形，加上它是"只算里面"还是"只算外面"。
 * 排除档（`not-left` 等）为什么不能表示成一个矩形：窗口去掉一侧三分之一剩下的是个 L 形
 * 都不是的整块——就是一个矩形的补集，所以老实记成「矩形 + 取反」。
 */
export interface SeeArea { rect: Rect; exclude: boolean }

/** 九宫格：边缘档取 1/3，`center` 取中央 1/3×1/3；`not-<边>` = 那一侧三分之一的补集。
 *  矩形在截图坐标系（原点 0,0）。`scale` 只有 `unit:'dip'` 的矩形用（逻辑像素 × scale = 物理
 *  像素）；比例矩形和九宫格与它无关。 */
export function regionRect(region: SeeRegion | undefined, window: Rect, scale = 1): SeeArea {
  const W = window.w, H = window.h
  const w3 = Math.floor(W / 3), h3 = Math.floor(H / 3)
  const inside = (rect: Rect): SeeArea => ({ rect, exclude: false })
  const outside = (rect: Rect): SeeArea => ({ rect, exclude: true })
  if (typeof region === 'object') {
    if (region.unit === 'dip') {
      // 逻辑像素矩形：x/y ≥ 0 从窗口左上角量，< 0 从右下角往回量（底部输入栏这种贴着下边的固定高度栏）；
      // w/h 省略 = 一直到窗口右边/下边；夹在窗口内
      const edge = (v: number, full: number) => Math.max(0, Math.min(full, Math.floor(v < 0 ? full + v * scale : v * scale)))
      const x = edge(region.x, W), y = edge(region.y, H)
      const w = region.w === undefined ? W - x : Math.min(W - x, Math.floor(region.w * scale))
      const h = region.h === undefined ? H - y : Math.min(H - y, Math.floor(region.h * scale))
      return inside({ x, y, w, h })
    }
    // 比例矩形：按窗口宽高换成像素，取整往里收（floor 起点、floor 尺寸），别越出窗口
    return inside({ x: Math.floor(region.x * W), y: Math.floor(region.y * H), w: Math.floor(region.w! * W), h: Math.floor(region.h! * H) })
  }
  switch (region) {
    case undefined: return inside({ x: 0, y: 0, w: W, h: H })
    case 'top': return inside({ x: 0, y: 0, w: W, h: h3 })
    case 'bottom': return inside({ x: 0, y: H - h3, w: W, h: h3 })
    case 'left': return inside({ x: 0, y: 0, w: w3, h: H })
    case 'right': return inside({ x: W - w3, y: 0, w: w3, h: H })
    case 'top-left': return inside({ x: 0, y: 0, w: w3, h: h3 })
    case 'top-right': return inside({ x: W - w3, y: 0, w: w3, h: h3 })
    case 'bottom-left': return inside({ x: 0, y: H - h3, w: w3, h: h3 })
    case 'bottom-right': return inside({ x: W - w3, y: H - h3, w: w3, h: h3 })
    case 'center': return inside({ x: w3, y: h3, w: w3, h: h3 })
    case 'not-left': return outside({ x: 0, y: 0, w: w3, h: H })
    case 'not-right': return outside({ x: W - w3, y: 0, w: w3, h: H })
    case 'not-top': return outside({ x: 0, y: 0, w: W, h: h3 })
    case 'not-bottom': return outside({ x: 0, y: H - h3, w: W, h: h3 })
  }
}

/** 看框的**中心点**落不落在区域里（排除档 = 中心点不在那块矩形里）。 */
export function inRegion(rect: Rect, area: SeeArea): boolean {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
  const r = area.rect
  const within = cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h
  return area.exclude ? !within : within
}

const squash = (s: string) => s.replace(/\s+/g, '')

/**
 * 一次 `see` 决定的**完整现场**：候选有哪些、全等的是谁、包含的是谁、最后选了哪个、为什么。
 *
 * **为什么非有不可**：在此之前排查一次点错只能靠事后截图倒推"它当时看到了什么"，而那是推不
 * 准的——活体 2026-09-07 我据此编了一个「兜底行先渲染、真结果晚一步」的解释，用户盯着屏幕看
 * 到的却是两行同时出现、焦点还在目标行上。**猜出来的因果读起来和量出来的一模一样**，这是这条
 * 链路上最贵的东西。有了这条记录，"选错了候选"和"选对了候选但坐标算错"当场就分得开。
 */
export interface SeeTrace {
  at: string
  label?: string
  mode: SeeMode
  query: See
  /** 区域算成像素之后的样子（`exclude` = 这块矩形之外才算）。 */
  region: SeeArea
  window: Rect
  /** 这一段考虑过的全部候选（已按 region / 章节筛过），按 y 排。 */
  candidates: Array<{ i: number; text: string; rect: Rect; kind?: string }>
  /** 去空白后与查询**全等**的那些（下标指向 `candidates`）。 */
  exact: number[]
  /** 只是**包含**查询的那些。 */
  contains: number[]
  picked: { i: number; rect: Rect } | null
  /** 没选中时的原因，用人话。 */
  why: string
  /** 画了框的那一帧（相对本文件所在的 trace 目录）。 */
  shot?: string
}

/** 候选叠图：全部候选描黄边 + 编号，选中的那个描红加粗。选中的和落选的必须一眼分得开。 */
export async function annotateCandidates(
  jpeg: Buffer,
  boxes: Rect[],
  picked: number | null,
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata()
  const items = boxes.map((b, i) => {
    const hit = i === picked
    const color = hit ? '#e11' : '#fc0'
    const fs = Math.max(11, Math.min(20, Math.round(b.h * 0.6)))
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${color}" stroke-width="${hit ? 4 : 2}"/>` +
      `<rect x="${b.x}" y="${Math.max(0, b.y - fs - 2)}" width="${fs * String(i + 1).length + 6}" height="${fs + 2}" fill="${color}"/>` +
      `<text x="${b.x + 3}" y="${Math.max(fs, b.y - 3)}" font-family="sans-serif" font-size="${fs}" fill="#000">${i + 1}</text>`
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${items.join('')}</svg>`
  return sharp(jpeg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer()
}

/**
 * 按文字挑框：去空白后**全等优先**，没有再**包含**；`region` 外的不算。
 * 同一档多命中 → null：宁可落下一段（模板 / 模型）也别猜——猜错的代价是"每步成功、发错人"。
 *
 * region 是**前置过滤**：先按 region 圈出候选，再在候选里分全等/包含两档——区域外的元素
 * 对结果零影响，既不参与匹配也不能否决区域内的合法命中（微信联系人列表那种场景：标题栏
 * `region:'top'` 只是包含匹配"Alice (3)"，左侧会话列表里若恰好有一个全等的"Alice"，
 * 那是 region 外的东西，不该把 top 区域内本该成立的包含匹配判死）。
 */
/** `see.below` / `see.notBelow`：哪些字算小标题、其中哪些下面的才算（见 `See.below`）。 */
export interface SeeSections { below: string[]; notBelow?: string[] }

/**
 * 「这一段归哪个小标题」：所有小标题（`below` ∪ `notBelow`，去空白后全等）里，**在它上方**
 * （标题底边 ≤ 它的顶边）且最近的那一个。上方没有任何已知小标题 → `null`。
 * 小标题自己也可能命中查询（联系人恰好叫「功能」）——所以调用方先把小标题从候选里剔掉。
 */
export function sectionOf(rect: Rect, headers: Array<{ text: string; rect: Rect }>): string | null {
  let best: { name: string; bottom: number } | null = null
  for (const h of headers) {
    const bottom = h.rect.y + h.rect.h
    if (bottom > rect.y) continue
    if (!best || bottom > best.bottom) best = { name: squash(h.text), bottom }
  }
  return best?.name ?? null
}

/**
 * 按文字挑框：去空白后**全等优先**，没有再**包含**；`region` 外的不算；给了 `sections` 就只算
 * 落在允许的小标题下方的那些（先按章节筛，再分全等/包含两档——两档的唯一性都只在筛剩的候选里判）。
 * 同一档多命中 → null：宁可落下一段（模板 / 模型）也别猜——猜错的代价是"每步成功、发错人"。
 */
/** 只留落在允许的小标题下方的那些段（小标题自己不算候选）。`sections` 没给就原样返回。 */
export function filterSections<T extends { text: string; rect: Rect }>(texts: T[], sections: SeeSections | undefined): T[] {
  if (!sections) return texts
  const names = new Set([...sections.below, ...(sections.notBelow ?? [])].map(squash))
  const headers = texts.filter((t) => names.has(squash(t.text)))
  const allowed = new Set(sections.below.map(squash))
  return texts.filter((t) => !names.has(squash(t.text))).filter((t) => {
    const s = sectionOf(t.rect, headers)
    return s != null && allowed.has(s)
  })
}

/**
 * 挑框的结果。**「一个都没有」和「不止一个」必须分开**，因为下一段该不该接手取决于这个区别：
 * 没有 = 这一帧没认出来（OCR 漏认是常事），落到模板段是对的；不止一个 = **我不知道是哪个**，
 * 这时候拿一张旧模板去点，正是"每步成功、点错地方"。
 *
 * 活体 2026-09-07 撞到的就是后者：QQ 搜索结果里兜底那行「进入全网搜索我的手机」被 OCR 切成
 * 两段，后半段「我的手机」和真会话行全等 → 两条全等 → screen 段如实拒绝，却被模板段接住，
 * 用上一轮种下的图点了下去，然后每一步都"成功"到最后一步才炸。
 */
/**
 * `ambiguous` 带着 `first`（这一档里最靠前的那个框）**不是为了让动作路去点它**——动作路必须
 * 拒绝。它是给判据路用的：`expect` 问的是"在不在"，多命中照样是"在"，而 trace 和回执还需要
 * 一个框来说明"在哪儿"。**动作路读 `first` 就是 bug**，判据见 `resolve` 里那段。
 */
export type Pick =
  | { kind: 'hit'; rect: Rect }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number; first: Rect }

/** 两段在不在同一行：纵向重叠超过较矮那段的一半。**不是按 y 相等**——同一行里字号不同
 *  （名字大、时间小）时顶边差好几个像素，按相等分行会把一行拆成两行。 */
export function sameRow(a: Rect, b: Rect): boolean {
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return bottom - top > Math.min(a.h, b.h) / 2
}

/** `sameRow` 的另一根轴：横向重叠超过较窄那段的一半。 */
export function sameCol(a: Rect, b: Rect): boolean {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  return right - left > Math.min(a.w, b.w) / 2
}

/**
 * 这一段在不在锚点的指定那一边（`TextWhere` 的求值）。
 *
 * 锚点可能有好几处（同一段字出现多次）——**任意一处成立就算成立**。这里不需要选出唯一的那个：
 * 判据问的是"有没有"，不是"点哪儿"。
 */
export function matchesWhere(rect: Rect, where: TextWhere, texts: ScreenText[]): boolean {
  const want = squash(where.anchor.text)
  if (!want) return false
  const exact = texts.filter((t) => squash(t.text) === want)
  const anchors = exact.length ? exact : texts.filter((t) => squash(t.text).includes(want))
  for (const a of anchors) {
    if (a.rect === rect) continue // 锚点不能是目标自己
    const horizontal = where.side === 'left' || where.side === 'right'
    if (horizontal ? !sameRow(rect, a.rect) : !sameCol(rect, a.rect)) continue
    const gap =
      where.side === 'left' ? a.rect.x - (rect.x + rect.w)
      : where.side === 'right' ? rect.x - (a.rect.x + a.rect.w)
      : where.side === 'above' ? a.rect.y - (rect.y + rect.h)
      : rect.y - (a.rect.y + a.rect.h)
    if (gap < 0) continue // 方向反了
    const unit = horizontal ? a.rect.w : a.rect.h
    if (where.maxDist !== undefined && gap > where.maxDist * unit) continue
    return true
  }
  return false
}

/**
 * 把候选**按行**剔掉：某一行里出现了 `not` 里的任何一段字，这一行的所有段一起出局。
 *
 * **为什么按行不按段**：OCR 每帧的分段不一样。QQ 那行兜底入口有时是一整段
 * 「进入全网搜索我的手机」，有时被切成「进入全网搜索」+「我的手机」——只按段剔，剔掉的是前
 * 半段，后半段照样是个和目标全等的假候选。按行聚合之后，怎么切都不影响结论。
 */
export function excludeRows<T extends { text: string; rect: Rect }>(texts: T[], not: string[] | undefined): T[] {
  if (!not?.length) return texts
  const bad = not.map(squash).filter(Boolean)
  if (!bad.length) return texts
  // 一段所在的"整行文字" = 与它同行的所有段（含它自己）拼起来。O(n²)，n 是一屏的文字段数
  // （几十条），不值得为它建索引。
  return texts.filter((t) => {
    const row = texts.filter((o) => sameRow(o.rect, t.rect)).sort((a, b) => a.rect.x - b.rect.x)
    const line = squash(row.map((r) => r.text).join(''))
    return !bad.some((b) => line.includes(b))
  })
}

/** 把同一行的段聚成一组（按 x 排好），并给出这一行的包围盒。`excludeRows` 用的是同一个"同行"判据。 */
function groupRows<T extends { text: string; rect: Rect }>(texts: T[]): Array<{ text: string; rect: Rect }> {
  const rest = [...texts]
  const rows: Array<{ text: string; rect: Rect }> = []
  while (rest.length) {
    const head = rest.shift()!
    const mates = [head, ...rest.filter((o) => sameRow(o.rect, head.rect))]
    for (const m of mates) {
      const i = rest.indexOf(m as T)
      if (i >= 0) rest.splice(i, 1)
    }
    mates.sort((a, b) => a.rect.x - b.rect.x)
    const x = Math.min(...mates.map((m) => m.rect.x))
    const y = Math.min(...mates.map((m) => m.rect.y))
    const right = Math.max(...mates.map((m) => m.rect.x + m.rect.w))
    const bottom = Math.max(...mates.map((m) => m.rect.y + m.rect.h))
    rows.push({ text: mates.map((m) => m.text).join(''), rect: { x, y, w: right - x, h: bottom - y } })
  }
  return rows
}

/**
 * `joinRows`：段都不匹配时，**再按行拼起来试一次**。
 *
 * OCR 每帧的分段不一样：QQ 那行「进入全网搜索我的手机」有时是一整段，有时被切成
 * 「进入全网搜索」+「我的手机」。按段匹配的判据在被切开的那些帧上**永远匹配不上**，而它的
 * 表现是"这东西没出现"——和真的没出现一模一样。`not:` 那一格早就因为同一个原因改成了按行聚合；
 * 这里是同一件事的另一半。
 *
 * **只给判据路开（`mode === 'read'`）。** 判据问的是"这串字在不在屏上"，拼行不改变答案的真假；
 * 而动作路问的是"我该点哪儿"，拿一整行的包围盒去点，点的是行中央——那是另一回事，别顺手打开。
 */
export function pickTextDetailed(
  texts: Array<{ text: string; rect: Rect }>,
  wanted: string,
  region: SeeArea,
  sections?: SeeSections,
  not?: string[],
  joinRows = false,
  where?: TextWhere,
): Pick {
  const want = squash(wanted)
  if (!want) return { kind: 'none' }
  // 顺序是有讲究的：先按区域圈出这一屏我们关心的那块，再在**这块之内**按行聚合做排除——
  // 拿区外的段去拼行，会把一行拼成它在别处的样子。
  const scoped = excludeRows(filterSections(texts, sections).filter((t) => inRegion(t.rect, region)), not)
  // 锚点要在**全屏**里找，不在 `scoped` 里找：收窄的是目标的范围，不是锚点的。
  // 锚点常常正好落在被 region/not 排掉的那一条上（顶部栏里的按钮就是典型），在 scoped 里找必然扑空。
  const inside = where ? scoped.filter((t) => matchesWhere(t.rect, where, texts)) : scoped
  // `first` = 识别层给的次序里的第一个（元素表按 (y,x) 排过，文字表是 OCR 的行序）。
  // **它只是"其中一个"，不承诺是最靠上的那个**——判据路拿它进 trace 说明"在哪儿看到的"，
  // 别把它当成"就是这一个"去点。
  const exact = inside.filter((t) => squash(t.text) === want)
  if (exact.length === 1) return { kind: 'hit', rect: exact[0].rect }
  if (exact.length > 1) return { kind: 'ambiguous', count: exact.length, first: exact[0].rect }
  const partial = inside.filter((t) => squash(t.text).includes(want))
  if (partial.length === 1) return { kind: 'hit', rect: partial[0].rect }
  if (partial.length > 1) return { kind: 'ambiguous', count: partial.length, first: partial[0].rect }
  // 段都不匹配 → 判据路再按行拼一次（见上面的头注）。命中的框是**整行的包围盒**，
  // 它只进 trace 说明"在哪一行看到的"。
  // **`where` 一在场就不拼行**：拼行把目标和锚点装进同一个包围盒，"在锚点左边"这种方位关系
  // 当场消失（gap 变成负的，判据恒假）。两者本来就是两条互斥的兜底路——拼行救的是"分段不稳"，
  // `where` 救的是"同名撞车"，而拼行会把撞车的两段也拼在一起。
  if (joinRows && !where) {
    const rows = groupRows(inside).filter((r) => squash(r.text).includes(want))
    if (rows.length === 1) return { kind: 'hit', rect: rows[0].rect }
    if (rows.length > 1) return { kind: 'ambiguous', count: rows.length, first: rows[0].rect }
  }
  return { kind: 'none' }
}

/**
 * 判据路的**全部**命中位置（`expect.fresh` 用）：同 `pickTextDetailed` 的判据路口径——先圈区域、
 * 分节、按行剔除，段里包含目标的都算；一段都不中才按行拼起来再找。和 `pickTextDetailed` 的区别
 * 只在于不挑"哪一个"：`fresh` 问的是"动作之后有没有冒出一个动作之前没有的位置"，要的是整张清单。
 */
export function textMatches(
  texts: Array<{ text: string; rect: Rect }>,
  wanted: string,
  region: SeeArea,
  sections?: SeeSections,
  not?: string[],
): Rect[] {
  const want = squash(wanted)
  if (!want) return []
  const inside = excludeRows(filterSections(texts, sections).filter((t) => inRegion(t.rect, region)), not)
  const segs = inside.filter((t) => squash(t.text).includes(want)).map((t) => t.rect)
  if (segs.length) return segs
  return groupRows(inside).filter((r) => squash(r.text).includes(want)).map((r) => r.rect)
}

/**
 * 两个框算不算"同一个位置"：中心点互相落在对方半个宽 / 高以内。
 *
 * 容差按框自身的尺寸给，不写死像素：同一行字连读两帧，OCR 的框会差几个像素（分段、边缘都在抖），
 * 而"输入框里那一行"和"气泡里那一行"隔着几十到几百像素——按半个框算，前者恒同、后者恒不同，
 * 与 DPI 无关。
 */
export function sameSpot(a: Rect, b: Rect): boolean {
  const dx = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2))
  const dy = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))
  return dx <= Math.max(a.w, b.w) / 2 && dy <= Math.max(a.h, b.h) / 2
}

export function pickText(texts: Array<{ text: string; rect: Rect }>, wanted: string, region: SeeArea, sections?: SeeSections, not?: string[]): Rect | null {
  const p = pickTextDetailed(texts, wanted, region, sections, not)
  return p.kind === 'hit' ? p.rect : null
}

/**
 * 按名字挑**元素**：语义与 `pickText` 逐字一致（全等优先、包含其次、同档多命中拒绝、region
 * 前置过滤、`sections` 按小标题分节），只是候选来自元素表。
 *
 * **无名的元素不参与按名匹配**：`name` 缺席就整条出局，绝不补成空串——`squash('').includes(want)`
 * 只在 want 为空时成立，但反过来 `squash(name).includes(want)` 拿空串当 name 时……更要命的是
 * 全等档：`'' === ''`。任何把缺席当空串的写法都会让匹配静默命中一堆无名图标，表现成"点到了一个
 * 谁也说不清的地方"。
 *
 * 章节这一维在元素表上同样成立：小标题（「联系人」/「功能」）自己也是元素表里的一条
 * （落单即入表 → `kind:'text'`，名字就是那几个字），所以**一次读元素表就够**，不用再读一次
 * 文字表去找小标题——见 `resolve` 里 `below` 那一段的注释。
 */
export function pickElement(elements: SeeElement[], wanted: string, region: SeeArea, sections?: SeeSections): Rect | null {
  return pickText(namedOnly(elements), wanted, region, sections)
}

/** 元素表 → `pickText` 吃的形状，**丢掉无名的**（见 `pickElement`）。 */
function namedOnly(elements: SeeElement[]): ScreenText[] {
  return elements.flatMap((e) => (e.name ? [{ text: e.name, rect: e.rect }] : []))
}

/** 元素表 → `filterSections` 吃的形状，**无名的照样留着**：它可能正是要点的那个图标，只是名字
 *  缺席，而"它在哪个小标题下面"是纯几何判断，不需要名字。（与 `namedOnly` 相反，那里是按名
 *  匹配，无名的必须出局。）小标题名不可能是空串，所以空名不会被误认成小标题。 */
function sectionable(elements: SeeElement[]): ScreenText[] {
  return elements.map((e) => ({ text: e.name ?? '', rect: e.rect }))
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** 截图坐标 → 屏幕物理坐标。**只加原点**。 */
export function toScreen(rect: Rect, window: Rect): Rect {
  return { x: window.x + rect.x, y: window.y + rect.y, w: rect.w, h: rect.h }
}

/** Set-of-Mark：每个框描红边、左上角贴编号（从 1 起）。模型只报编号，坐标留在我们手里。 */
export async function annotateMarks(jpeg: Buffer, boxes: Rect[]): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata()
  const items = boxes.map((b, i) => {
    const n = i + 1
    const fs = Math.max(12, Math.min(22, Math.round(b.h * 0.6)))
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#e11" stroke-width="2"/>` +
      `<rect x="${b.x}" y="${Math.max(0, b.y - fs - 2)}" width="${fs * String(n).length + 6}" height="${fs + 2}" fill="#e11"/>` +
      `<text x="${b.x + 3}" y="${Math.max(fs, b.y - 3)}" font-family="sans-serif" font-size="${fs}" fill="#fff">${n}</text>`
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${items.join('')}</svg>`
  return sharp(jpeg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer()
}

/** 从截图上裁下一块当模板（PNG，无损——模板要拿去做相似度匹配，JPEG 的块效应会吃掉分数）。 */
export async function cropTemplate(jpeg: Buffer, rect: Rect): Promise<Buffer> {
  return sharp(jpeg).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).png().toBuffer()
}

export const TEMPLATE_MIN_SCORE = 0.9
/** 调用点 id（`src/providers/callsites.ts` 同名一行；用户在设置里换模型换的就是它）。 */
export const SEE_CALLSITE = 'desktop.see'
/**
 * 第五档的调用点 id（`src/providers/callsites.ts` 同名一行）。
 *
 * **和 `desktop.see` 分开是有意的**：两档要的是两种模型。那档的活是"在编号里挑一个"，
 * 这档的活是"报出绝对坐标"（grounding）——后者该绑一个 GUI 专用模型（UI-TARS 系），
 * 而绑同一个模型会让其中一档一直不准，且没有任何一处会喊。
 */
export const POINT_CALLSITE = 'desktop.point'

export interface SeeHit { rect: Rect; via: SeeVia; cacheKey: string | null; a11yRef?: string }
export interface SeeResolverDeps { cacheDir: string; llm?: LlmForTask }
export interface SeeResolver {
  /** `mode` 没有默认值：每个调用点都得说清这一次是动作还是判据（见 `SeeMode`）。 */
  /** `label` 只进排查记录（`SeeTrace`），不参与任何判断——一条记录说不清是哪一步的就没用。 */
  /** `a11y`：recipe 的申报（`RecipeAppMatch.a11y`），只影响动作路的元素表读取；缺省 true。 */
  resolve(see: See, opts: { allowModel: boolean; mode: SeeMode; label?: string; a11y?: boolean }): Promise<SeeHit | null>
  /**
   * 判据路读一次屏，交回 `see.text` 在区域内的**全部**命中（屏幕坐标）。只走文字表：不查控件树、
   * 不落模板、不调模型——`expect.fresh` 要比的是"这一帧上真看见的位置"，模板给的是上一次的位置。
   * 读不了屏（agent 不支持）回 null。
   */
  matches(see: See, opts: { label?: string }): Promise<Rect[] | null>
  invalidate(hit: SeeHit): void
  /** 这一趟里 model 段调了几次——runner 拿它对"≤ 步骤数"的上限。 */
  modelCalls: number
  /** 这台机器上攒下来的打断表（`<cacheDir>/<sourceId>/interrupts.json`），与 recipe 自带的那张
   *  取并集。**分两层是有意的**：recipe 是跨机器分发的，而"这台机器上会弹什么"（某个杀毒软件
   *  的角标、某次促销）是本机的事，写进 recipe 就会跟着分发给所有人。 */
  localInterrupts(): DesktopInterrupt[]
}

/**
 * 四段梯子，第一段给出框就停：a11y → screen → template → model。
 * 一趟 recipe 一个实例（`modelCalls` 归一趟）。`allowModel:false` 是 expect 用的：判据不许调模型。
 */
export function makeSeeResolver(driver: DesktopDriver, sourceId: string, deps: SeeResolverDeps): SeeResolver {
  const cache = new SeeCache(join(deps.cacheDir, sourceId))
  /**
   * 这个实例见过的**窗口画面尺寸**。`region` 要算成像素才能下推，而像素要窗口的宽高——
   * 而窗口宽高今天只随读屏/抓拍的回执一起回来。所以第一次需要它时先探一下（`captureWindow`
   * 一次 PrintWindow，几十毫秒；整窗一次 PP-OCR 是 1–3.4 秒，差一个量级），之后每次读屏
   * 都顺手更新它。
   */
  let canvas: { w: number; h: number; scale: number } | null = null

  /**
   * 决定现场的落盘（见 `SeeTrace`）。**默认关着**，靠 `STREAM_DESKTOP_SEE_TRACE=1` 打开——
   * 每条记录多一次 `captureWindow` 和两个文件——**那一次不便宜**：Windows 上 50–925ms
   * （整窗 JPEG 编码 + base64 过 WS），wechat-send 快路一趟 12 次共 2.4s，占整趟的四分之一
   * （2026-09-13 活体）。别把它留在常驻服务的环境里——排查完就关。排查点错时它是唯一能把
   * "选错了候选"和"选对了候选但坐标算错"分开的东西。
   */
  const traceDir = process.env.STREAM_DESKTOP_SEE_TRACE ? join(deps.cacheDir, sourceId, 'trace') : null
  let traceSeq = 0
  const trace = async (
    see: See,
    mode: SeeMode,
    label: string | undefined,
    screen: { texts: ScreenText[]; elements: SeeElement[]; window: Rect },
    region: SeeArea,
    sections: SeeSections | undefined,
    picked: Rect | null,
  ): Promise<void> => {
    if (!traceDir) return
    try {
      // 候选池按 mode 取**和 pick 同一份**：动作路是元素表里有名字的那些，判据路是文字表。
      // 两边分开算就会出现"记录里有、实际没考虑"的假现场，那比没有记录更坏。
      const pool = mode === 'action' ? namedOnly(screen.elements) : screen.texts
      const inside = filterSections(pool, sections).filter((t) => inRegion(t.rect, region))
      const want = squash(see.text ?? see.icon ?? '')
      const exact: number[] = []
      const contains: number[] = []
      inside.forEach((t, i) => {
        const s = squash(t.text)
        if (s === want) exact.push(i)
        else if (s.includes(want)) contains.push(i)
      })
      const pickedAt = picked ? inside.findIndex((t) => sameRect(t.rect, picked)) : -1
      const why = picked
        ? `选中 #${pickedAt + 1}（${exact.length === 1 ? '全等唯一' : '包含唯一'}）`
        : inside.length === 0
          ? '区域内没有任何候选'
          : exact.length > 1
            ? `全等命中 ${exact.length} 条，拒绝（宁可落到下一段也不猜）`
            : contains.length !== 1
              ? `全等 0 条、包含 ${contains.length} 条，拒绝`
              : '未命中'
      const stamp = `${String(++traceSeq).padStart(2, '0')}-${(label ?? see.text ?? see.icon ?? 'see').replace(/[^\w一-龥]+/g, '_')}`
      mkdirSync(traceDir, { recursive: true })
      const rec: SeeTrace = {
        at: new Date().toISOString(),
        label, mode, query: see, region, window: screen.window,
        candidates: inside.map((t, i) => ({ i: i + 1, text: t.text, rect: t.rect })),
        exact: exact.map((i) => i + 1),
        contains: contains.map((i) => i + 1),
        picked: picked && pickedAt >= 0 ? { i: pickedAt + 1, rect: picked } : null,
        why,
      }
      const shot = await driver.captureWindow()
      if (shot && shot.window.w === screen.window.w && shot.window.h === screen.window.h) {
        const img = await annotateCandidates(shot.jpeg, inside.map((t) => t.rect), pickedAt)
        rec.shot = `${stamp}.jpg`
        writeFileSync(join(traceDir, rec.shot), img)
      }
      writeFileSync(join(traceDir, `${stamp}.json`), JSON.stringify(rec, null, 1))
    } catch {
      // 排查工具坏了不该把被排查的那一轮也带走。
    }
  }

  /**
   * 读一次屏：按 `mode` 选表，并把 `see.region` **算成像素下推给 agent**。
   *
   * 下推是这条改动的重点，不是顺手做的优化：整窗读实测 1.06–3.43 秒，而 recipe 里的判据
   * 几乎都写了 region——"取回整窗再本地筛"和裁一刀的结果一模一样，只是每步慢两秒，
   * 而这一点不会出现在任何断言里。
   *
   * **排除档（`not-left` / `not-right` / `not-top` / `not-bottom`）下推不了**：它是一个矩形的
   * **补集**（窗口去掉左边三分之一剩下的那块不是矩形），而 wire 上的 `region` 就是一块裁剪
   * 窗口。这几档照旧整窗读 + 本地 `inRegion` 过滤。要下推就得让 wire 认识"补集"这个概念——
   * 给一个只有四个取值的档位加一整套语义，不值。**这不是漏了，是量过之后没做。**
   *
   * 回执里的 `window` 永远是**整窗**那个 rect（agent 把裁剪原点加回到每个框上了），所以
   * `toScreen` 和 `inRegion` 都不用分"裁没裁"两档。
   */
  const readTable = async (
    see: See,
    mode: SeeMode,
    icons: boolean,
    a11y: boolean,
  ): Promise<{ texts: ScreenText[]; elements: SeeElement[]; window: Rect; scale: number; area: SeeArea } | null> => {
    // 是不是排除档只取决于 region 的取值，与窗口尺寸无关——拿一个空窗口去问 `regionRect`，
    // 判据就只有一份（别在这里另写一个 `startsWith('not-')`，两份迟早分家）。
    const pushable = see.region !== undefined && !regionRect(see.region, { x: 0, y: 0, w: 0, h: 0 }).exclude
    if (pushable && !canvas) {
      const shot = await driver.captureWindow()
      if (shot) canvas = { w: shot.window.w, h: shot.window.h, scale: shot.scale }
    }
    for (let attempt = 0; ; attempt++) {
      const assumed = canvas
      const push = pushable && assumed ? regionRect(see.region, { x: 0, y: 0, w: assumed.w, h: assumed.h }, assumed.scale).rect : undefined
      const r = mode === 'action'
        ? await driver.readElements({ ...(push ? { region: push } : {}), icons, a11y })
        : await driver.readText(push)
      if (!r) return null
      const actual = { w: r.window.w, h: r.window.h, scale: r.scale }
      // 下推用的尺寸和实际画面对不上（窗口在这两次调用之间被缩放/最大化了）→ 这一趟裁的是
      // 错的地方。**必须按新尺寸重来一次**：拿回来的是另一块的结果，而"那儿没有"和"我看错了
      // 地方"长得一模一样，落到梯子下一段之后就再也说不清了。只重一次，防止窗口正在被拖动
      // 时无限重读。
      const stale = push != null && assumed != null && (assumed.w !== actual.w || assumed.h !== actual.h || assumed.scale !== actual.scale)
      canvas = actual
      if (stale && attempt === 0) continue
      return {
        texts: 'texts' in r ? r.texts : [],
        elements: 'elements' in r ? r.elements : [],
        window: r.window,
        scale: r.scale,
        area: regionRect(see.region, { x: 0, y: 0, w: actual.w, h: actual.h }, actual.scale),
      }
    }
  }

  const self: SeeResolver = {
    modelCalls: 0,
    invalidate(hit) {
      if (!hit.cacheKey) return
      // **两个库，别混。** `pinned` 的键指的是 `handles.json` 里那一条（上一趟固化下来的
      // 控件名），不是 `<key>.json`/`<key>.png` 那对文件。走错一边的后果是"作废了"其实没
      // 作废——下一趟照样拿着指错的句柄去点，而日志上写着已经作废。
      if (hit.via === 'pinned') cache.dropHandleKey(hit.cacheKey)
      else cache.invalidate(hit.cacheKey)
    },
    // 每次现读，不在建实例时快照：这张表是复盘工具写的，一趟 recipe 跑着的时候它可能刚被写进去。
    localInterrupts: () => cache.interrupts(),
    async matches(see, { label }) {
      if (!see.text) return []
      const screen = await readTable(see, 'read', false, false)
      if (!screen) return null
      const sections = see.below ? { below: see.below, notBelow: see.notBelow } : undefined
      const found = textMatches(screen.texts, see.text, screen.area, sections, see.not)
      await trace(see, 'read', label, screen, screen.area, sections, found[0] ?? null)
      return found.map((r) => toScreen(r, screen.window))
    },
    async resolve(see, { allowModel, mode, label, a11y = true }) {
      // ── a11y：text 当 name 查一次控件树。有控件树的应用在这一段就完了。
      // **给了 `region` 就整段跳过**：控件树查询没有区域这一维，`find` 只会告诉你"全窗唯一"。
      // 写 `region` 的人正是在说"同名的东西不止一个，我要的是这一块里的那个"——拿一个别处的
      // 唯一命中去应答，每一步都会成功，只是点错了地方，而这条路上最贵的错就是这种。
      // `below`（按章节找）同理跳过 a11y：控件树查询没有"在哪个小标题下面"这一维。
      // `a11y === false`（recipe 申报这个应用没有控件树）时整段跳过——查了也白查，还倒贴一次
      // 必然落空的 IPC 往返。
      if (a11y && see.text && !see.region && !see.below) {
        const r = await driver.find({ name: see.text })
        if (r.elements.length === 1) return { rect: r.elements[0].rect, via: 'a11y', cacheKey: null, a11yRef: r.elements[0].ref }
      }
      /**
       * ── 固化下来的句柄（spec §4）：上一趟第五档在这一格定位过，而当时那个位置有个带名字的
       * 控件。拿名字查树比任何一档都便宜（省掉整窗一次 OCR，1–3.4 秒），而且**坐标漂了它还在**。
       *
       * **只对 `point` 目标做**：`text` / `icon` 前四档本来就找得到，给它们多查一次树是白花钱。
       *
       * **必须恰好一条**。两条就是"是哪一个"没有答案——那时宁可落回梯子重新定位，也不许挑一个
       * （点错的代价不可回退）。零条通常是界面变了，同样落回梯子，让第五档重新定位并覆盖句柄。
       *
       * 同上，`a11y === false` 时也跳过：没有控件树，固化下来的句柄也查不到名字。
       */
      if (a11y && see.point) {
        const pinned = cache.peekHandle(see)
        if (pinned) {
          const r = await driver.find({ name: pinned })
          // `cacheKey` 给的是**句柄的键**：这一趟点完 expect 没兑现时，runner 靠它把这个陈旧
          // 句柄丢掉（`invalidate`）。给 null 的话，一个已经指错的句柄会永远留在库里。
          if (r.elements.length === 1) return { rect: r.elements[0].rect, via: 'pinned', cacheKey: cache.handleKeyOf(see), a11yRef: r.elements[0].ref }
        }
      }
      // ── screen：读屏，**动作查元素表、判据查文字表**（spec §3）。agent 不支持 → 后面三段
      // 全落空（模板匹配和叠图都要这张图）。
      //
      // **检测器按需要才跑**：OmniParser icon_detect 一次约 2 秒，而文字识别是这张表的大头
      // （1–3.4 秒整窗、带 region 约 30ms）。只有 `icon` 目标（没有文字可指，只能靠检测器给框）
      // 一开始就要它；文字目标不跑——spec §5 的成本表就是这么定价的。代价要说清：一个写着
      // 「发送」的按钮，不跑检测器时元素表里只有 OCR 那一档给的文字框（`kind:'text'`），
      // 框还是只圈住那两个字，不是整个可点区域。检测器给的整框只在 `icon` 目标和 `see-probe`
      // 里看得到。
      const screen = await readTable(see, mode, !!see.icon, a11y)
      if (!screen) return null
      const texts = screen.texts
      const elements = screen.elements
      const region = screen.area
      const key = cache.key(see, screen.window, screen.scale, mode)
      const cached = cache.get(key)
      /**
       * screen 段命中也**顺手裁一张模板**（只在缓存里还没有时，一次性）。OCR 不是每趟都稳：
       * 活体 2026-09-07 微信搜索框的占位字「搜索」，光标停在它前面那一趟就没认出来——同一屏
       * 前一趟还认得；而模型段的候选框**只来自读屏**，字没被认出就不在候选里，模型只能如实说
       * "没有"。有了这张模板，下一趟 OCR 漏认时 template 段接住；它和模型裁出来的模板走同一套
       * 自愈（命中却 expect 不兑现 → 作废）。抓拍尺寸对不上就不裁（同模型段那道闸）。
       */
      /**
       * 模板命中之后的**核字**（只对 `text` 目标）：把命中那一小块再 OCR 一遍，字对不上就当没中。
       *
       * 模板是从命中当时的画面上裁的，带着当时的底色。活体 2026-09-12：「文件传输助手」那一行
       * 被选中（绿底白字）时裁的模板，下一趟在**另一个被选中的会话行**上匹配到 0.9 以上——绿底
       * 白字对绿底白字，字形只占一小片，相关分数分不出是谁——于是点开了别人的会话。branch
       * 挡住了没误发，但白开一次别人的会话、多花 5s。模板存在的理由是救 OCR **漏检**那一帧，
       * 不是替 OCR 认字；所以命中之后让 OCR 在这一小块上把字认回来（几十毫秒，裁块不放大），
       * 认不出目标文字就不算命中。`icon` 目标没有字可核，照旧只看分数。
       */
      const templateSaysSameText = async (rect: Rect): Promise<boolean> => {
        if (!see.text) return true
        const want = squash(see.text)
        // 往外扩几个像素：模板框贴着字边，OCR 的检测框需要一点边缘。
        const pad = 4
        const probe = {
          x: Math.max(0, rect.x - pad),
          y: Math.max(0, rect.y - pad),
          w: Math.min(screen.window.w - Math.max(0, rect.x - pad), rect.w + pad * 2),
          h: Math.min(screen.window.h - Math.max(0, rect.y - pad), rect.h + pad * 2),
        }
        const read = await driver.readText(probe)
        if (!read) return true
        const got = squash(read.texts.map((t) => t.text).join(''))
        // OCR 在这一小块上**什么都没认出来** → 正是模板要救的那一帧（漏检），按分数算命中。
        // 认出了字、字却不是它 → 模板贴在别人身上了，拒绝。
        if (!got) return true
        return got.includes(want) || (want.length >= 2 && want.includes(got) && got.length >= Math.ceil(want.length / 2))
      }
      const seed = async (rect: Rect): Promise<void> => {
        if (cached?.template) return
        const shot = await driver.captureWindow()
        if (!shot || shot.window.w !== screen.window.w || shot.window.h !== screen.window.h) return
        const inside = clampToWindow(rect, shot.window)
        if (!inside) return
        cache.put(key, { via: 'screen', rect: inside, at: Date.now() }, await cropTemplate(shot.jpeg, inside))
      }
      /**
       * `below` / `notBelow` 在两张表上是**同一件事**：小标题（「联系人」/「功能」）自己也是
       * 元素表里的一条——落单的文字段自成一条 `kind:'text'` 元素，名字就是那几个字。所以
       * 动作路**不需要**先读一次文字表算 y 区间再读一次元素表（那是两次整窗读，把刚省下来的
       * 钱又花回去），一次读元素表就够。
       *
       * 洞在这里，说清楚免得下一个人以为是漏了：**检测器框若把小标题和它下面第一行一起圈住**，
       * 合成出来的那条元素名字是两段拼一起的，小标题就不再是独立的一行 → `filterSections`
       * 找不到它 → 允许区间为空 → 这一段无候选，落到模板/模型。失败是安全的（不猜），但它
       * 安静。真撞上就用 `see-probe` 看一眼元素表：小标题在不在、名字是不是被拼进了别人。
       */
      const sections = see.below ? { below: see.below, notBelow: see.notBelow } : undefined
      if (see.text) {
        const pick = mode === 'action'
          ? pickTextDetailed(namedOnly(elements), see.text, region, sections, see.not)
          // 判据路多给一档"按行拼起来再试"：OCR 把一行切成几段是常事，而判据问的是
          // "这串字在不在屏上"，拼行不改变答案的真假。动作路不开——见 `pickTextDetailed` 头注。
          : pickTextDetailed(texts, see.text, region, sections, see.not, true)
        /**
         * **多命中在两种模式下是两个不同的问题，别用同一条规则答。**
         *
         * - 动作路问的是"我该点哪一个"。两个同档命中 = 不知道，必须拒绝（点错的代价是不可
         *   回退的副作用）。
         * - 判据路（`expect` / `require` / `branch`）问的是"这东西在不在屏上"，是个**是非题**。
         *   出现两次照样是"在"——拒绝它等于把一次成功判成失败。
         *
         * 这条曾经只写了动作路那一半，判据路跟着一起拒，代价是活体 2026-09-08 的一次**假红**：
         * 消息真发出去了，正文同时命中右侧气泡和左栏会话预览（同一条消息的两处呈现），
         * `expect` 判多命中即拒 → recipe 报 `blocked`。**发送动作上这是最贵的一种错**——调用方
         * 看到失败会重发，于是发两遍。
         */
        const ambiguousButPresent = pick.kind === 'ambiguous' && mode === 'read'
        const rect = pick.kind === 'hit' ? pick.rect : ambiguousButPresent ? pick.first : null
        await trace(see, mode, label, screen, region, sections, rect)
        if (rect) {
          // 多命中的那一档**不种模板**：种下去的是"其中一个"，而下一轮模板段会稳定命中它，
          // 把一个"在不在"的问题偷偷变成"是不是那一个"。判据不需要模板兜底，它每帧现读。
          if (!ambiguousButPresent) await seed(rect)
          return { rect: toScreen(rect, screen.window), via: 'screen', cacheKey: key }
        }
        // **动作路的歧义到此为止，不落模板段。** 「一个都没认出来」和「认出来好几个」要区别
        // 对待：前者是 OCR 这一帧漏了，模板接住是对的；后者是"我不知道是哪个"，而模板段拿的是
        // 上一轮种下的图——它会稳定地命中当初那一个，把一次诚实的拒绝变成一次沉默的点错
        // （活体 2026-09-07，QQ 兜底行被切成两段之后就是这样）。
        if (pick.kind === 'ambiguous') {
          console.warn(`[desktop] see ${JSON.stringify(see)} 在这一帧有 ${pick.count} 个同档命中，拒绝——不落模板段`)
          return null
        }
      }
      // `icon` 是纯粹的元素概念（"哪儿有个能点的东西"），文字表里没有它可查的东西——判据路
      // 在这一段无解，落到模板/模型。这是二分的直接后果，不是遗漏：一个查图标的 `expect`
      // 要的其实是"元素表里有没有这个东西"，那笔钱判据路本来就不该付。
      if (see.icon && mode === 'action') {
        const rect = pickElement(elements, see.icon, region, sections)
        if (rect) {
          await seed(rect)
          return { rect: toScreen(rect, screen.window), via: 'screen', cacheKey: key }
        }
      }
      // ── template：缓存里有模板就在窗口截图上找。只扫 region 那一块（排除档没法裁，才扫整窗）。
      if (cached?.template) {
        const hit = await driver.findImage(cached.template, region.exclude ? undefined : region.rect)
        if (hit && hit.score >= TEMPLATE_MIN_SCORE && inRegion(hit.rect, region) && (await templateSaysSameText(hit.rect))) {
          return { rect: toScreen(hit.rect, screen.window), via: 'template', cacheKey: key }
        }
      }
      // 下面两档都要模型。**这道闸同时守着第四、第五档**：判据路（`allowModel:false`）
      // 一行模型都不调——这是「AI 只许改点哪儿，绝不许改怎么算成了」在代码里的落点。
      if (!allowModel || !deps.llm) return null
      const llm = deps.llm

      // ── model：编号叠图 → 模型报编号 → 裁模板进缓存。
      //
      // **它发明不了框**：候选一律来自元素表，`marks.length === 0` 就直接落到第五档。
      // 这是它和第五档的分界——那一档问「它在哪」，可以指出元素表里不存在的位置。
      const byMarks = async (): Promise<SeeHit | null> => {
      /**
       * **候选框一律来自元素表**，不再是"可点框优先、没有就退回文字框"那两个池子。
       * 二分之后元素表本身就是那两个池子缝好的结果：检测器给的框、a11y 给的框、以及落单的
       * 文字段（`kind:'text'`）都在里面，同一套坐标、同一次画面。老的两池写法在这里已经
       * 没有意义——退回文字框那一档正是元素表的第三档。
       *
       * 这一段**必须带 `icons`**：模型要在"能点的东西"里挑，而只有图标的按钮只有检测器认得。
       * 上面那次读若已经带过（`icon` 目标）就直接用，否则补读一次。尺寸和上一次对不上就不用
       * 它——两组框不在一个坐标系里，叠出来的编号全是错的。
       */
      let pool = elements
      if (!see.icon) {
        const det = await readTable(see, 'action', true, a11y)
        if (!det || det.window.w !== screen.window.w || det.window.h !== screen.window.h) return null
        pool = det.elements
      }
      // 给了 `below` 就只让模型在允许的章节里挑：网页搜索建议那一排和真正的账号长得一样，
      // 模型分不出、也不该由它分——分节是 recipe 写死的判据。
      const marks = markCandidates(sections ? filterSections(sectionable(pool), sections) : pool, region)
      if (marks.length === 0) return null
      // 编号来自 readScreen 那一张、图来自这一张，中间窗口可能被挪过或缩过——尺寸一对不上，
      // 两套坐标就不是一个坐标系，叠出来的框全是错的，裁模板还会直接把 sharp 炸掉（bad extract
      // area），把"找不到就回 null"的契约变成一个异常。这一趟作废，下一趟重走梯子就是了。
      //
      // **只被拖走（尺寸没变）这一档过得了这道闸，所以下面一律用 `shot.window` 的原点**：
      // 截图坐标在两张之间是通用的（窗口内部布局没动），能变的只有原点，而 `screen.window.x/y`
      // 是拖走之前的那个。用它算出来的屏幕框指着窗口原来待的地方——点空一次，还把这个错框缓存下来。
      const shot = await driver.captureWindow()
      if (!shot || shot.window.w !== screen.window.w || shot.window.h !== screen.window.h) return null
      const annotated = await annotateMarks(shot.jpeg, marks)
      self.modelCalls++
      const tSee = Date.now()
      const res = await llm(SEE_CALLSITE, {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: seePrompt(see, marks.length) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${annotated.toString('base64')}` } },
          ],
        }],
        temperature: 0,
      })
      // 模型这一趟花了多久，进日志：它是整轮里唯一一段远程等待，不记就只能从账本的空档里猜。
      console.warn(`[desktop-see] model ${SEE_CALLSITE} ${Date.now() - tSee}ms（${marks.length} 个候选）`)
      const n = parseMark(res?.content, marks.length)
      if (n == null) return null
      // 识别器给的框可能越界一两个像素（半个字被切在窗口边上）。裁之前夹回图内——夹完没面积了
      // 就当没找到，别拿一个 0 宽的模板去污染缓存。
      const rect = clampToWindow(marks[n - 1], shot.window)
      if (!rect) return null
      const template = await cropTemplate(shot.jpeg, rect)
      cache.put(key, { via: 'model', rect, at: Date.now() }, template)
      return { rect: toScreen(rect, shot.window), via: 'model', cacheKey: key }
      }
      const marked = await byMarks()
      if (marked) return marked

      // ── point：**梯子最后一档**。到这里说明前四档全部指不到——最常见的原因不是"这一帧没
      // 认出来"，而是**元素表里压根没有这个东西**：空的输入框 OCR 无字、检测器不给框，它在
      // 三张表里都不存在。这一档不从候选里挑，而是让 grounding 模型直接报一个绝对坐标。
      if (!see.point) return null
      self.modelCalls++
      const pshot = await driver.captureWindow()
      if (!pshot) return null
      const tPoint = Date.now()
      const pres = await llm(POINT_CALLSITE, {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: pointPrompt(see.point, pshot.window) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pshot.jpeg.toString('base64')}` } },
          ],
        }],
        temperature: 0,
      })
      console.warn(`[desktop-see] model ${POINT_CALLSITE} ${Date.now() - tPoint}ms`)
      const prect = parsePoint(pres?.content, pshot.window)
      if (!prect) return null
      // **`region` 是作者写死的取景框，指到框外就是指错了。** 而"指错了"和"这儿没有"在下游
      // 长得一模一样（都是这一步找不到），必须在这里分开——否则唯一说得清的那句话没人看得见。
      if (!inRegion(prect, region)) {
        console.warn(`[desktop] point「${see.point}」模型指到了 region 之外（${JSON.stringify(prect)}），拒绝`)
        return null
      }
      /**
       * **固化**（spec §4）：模型给的是坐标，而**坐标会漂**——窗口挪一下、下次开机布局差一点，
       * 缓存里那个框就指到别处，而"指到别处"每一趟都会成功地点错。所以趁这一刻回读一次元素表，
       * 看这个位置上有没有一个**带名字的控件**：有就把名字记下来，下一趟从梯子第一档走完，
       * 既不再付模型钱、也不受坐标漂移影响。
       *
       * 回读失败、或那儿本来就没有带名字的控件（纯画出来的界面），都只是少一格加速——
       * 不影响这一趟的结果，也不报错。
       */
      // 申报了没有控件树（`a11y:false`）就不回读：这一读的唯一用途是 `pickHandle`，而它只认
      // `kind:'a11y'`——为一个必然为空的句柄再付一次整窗 OCR 是白花钱。少的只是那格加速。
      const reread = a11y ? await driver.readElements() : null
      const handle = reread && reread.window.w === pshot.window.w && reread.window.h === pshot.window.h
        ? pickHandle(reread.elements, prect)
        : null
      if (handle) cache.putHandle(see, handle)
      cache.put(key, { via: 'point', rect: prect, at: Date.now(), ...(handle ? { a11yName: handle } : {}) })
      return { rect: toScreen(prect, pshot.window), via: 'point', cacheKey: key }
    },
  }
  return self
}

/** 给模型编号的候选框：元素表里落在 `region` 内的那些。上限 60 个——叠图太密模型就分不清编号了。 */
function markCandidates(pool: Array<{ rect: Rect }>, region: SeeArea): Rect[] {
  return pool.map((c) => c.rect).filter((r) => inRegion(r, region)).slice(0, 60)
}

/** 把框夹回窗口内；夹完没面积（完全在窗外）→ null。 */
function clampToWindow(rect: Rect, window: Rect): Rect | null {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y)
  const w = Math.min(rect.x + rect.w, window.w) - x
  const h = Math.min(rect.y + rect.h, window.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

/** 第五档回来的是**一个点**，而缓存和 `toScreen` 吃的是框——这是把点撑成框的半径。 */
const POINT_RADIUS = 10

/**
 * 给一个坐标在元素表里找一个**可复用的句柄**：与它重叠最多、`kind:'a11y'`、且有名字的那条的名字。
 *
 * 这是「固化」的那一下（spec §4）。**坐标会漂，句柄不漂**——窗口挪动、缩放、重排都不影响
 * 一个控件叫什么，而模型给的坐标下一次开机就可能指到别处。
 *
 * **为什么只认 a11y 那一档**：句柄的用途是下一趟拿去查控件树（`driver.find({ name })`）。
 * 检测器和 OCR 给的框背后没有控件，拿它们的文字去查树是空手——而"空手"和"这一格还没固化"
 * 长得一样，于是每一趟都白查一次。
 *
 * **为什么无名的不算**：`find` 的包含匹配在空名字上恒真，会命中窗口里的每一个元素。一个
 * 恒定命中、恒定点在全窗第一个控件上的"句柄"，比没有句柄坏得多。
 */
export function pickHandle(elements: readonly SeeElement[], rect: Rect): string | null {
  let best: { name: string; area: number } | null = null
  for (const el of elements) {
    if (el.kind !== 'a11y' || !el.name) continue
    const x = Math.max(rect.x, el.rect.x)
    const y = Math.max(rect.y, el.rect.y)
    const w = Math.min(rect.x + rect.w, el.rect.x + el.rect.w) - x
    const h = Math.min(rect.y + rect.h, el.rect.y + el.rect.h) - y
    if (w <= 0 || h <= 0) continue
    const area = w * h
    if (!best || area > best.area) best = { name: el.name, area }
  }
  return best?.name ?? null
}

/**
 * 从 grounding 模型的回复里抠出**一个窗口坐标系的点**，返回以它为心的小框。
 *
 * 认三种写法，都是 UI-TARS 系模型的实际输出形状：`click(start_box='[x1,y1,x2,y2]')`（取框心）、
 * `<point>x y</point>`、裸的 `(x, y)`。
 *
 * **抠不出来一律 `null`，绝不补默认值。** 「模型说没找到」是一个合法答案，而补一个坐标出来
 * 的表现是点在窗口左上角、这一步照样"成功"——那正是 AGENTS.md 里「缺席时补一个默认值就是
 * 把痕迹擦掉」说的那件事。
 *
 * 千分比口径：两个数里只要有一个超过窗口对应边长，就整体按 `0-1000` 折算——超出边长的像素值
 * 不可能是真坐标，而这些模型在归一化档上恰好只吐 0–1000。两个都超过 1000 就既不是像素也不是
 * 千分比，说不清就别猜。
 */
export function parsePoint(text: string | undefined | null, window: Rect): Rect | null {
  if (!text) return null
  const nums = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  let pt: [number, number] | null = null
  const box = text.match(/start_box\s*=\s*'?\[([^\]]+)\]/)
  if (box) {
    const v = nums(box[1])
    if (v.length >= 4) pt = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2]
    else if (v.length >= 2) pt = [v[0], v[1]]
  }
  if (!pt) {
    // **裸的中括号也要认**：`[300, 600, 900, 650]`（四个数当框、取心）或 `[x, y]`（两个数当点）。
    // 活体 2026-09-08 实测：同一个模型换一句提示词，输出就从 `click(start_box='[…]')` 变成
    // 光秃秃一个 `[…]`——不认它的代价是**一次指对了的定位被当成"没找到"**，而两者在下游一模一样。
    const p = text.match(/<point>([^<]+)<\/point>/)
      ?? text.match(/\(\s*(-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?)\s*\)/)
      ?? text.match(/\[([^\]]*\d[^\]]*)\]/)
    if (p) {
      const v = nums(p[1])
      if (v.length >= 4) pt = [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2]
      else if (v.length >= 2) pt = [v[0], v[1]]
    }
  }
  if (!pt) return null
  let [x, y] = pt
  if (x > window.w || y > window.h) {
    if (x > 1000 || y > 1000) return null
    x = (x / 1000) * window.w
    y = (y / 1000) * window.h
  }
  x = Math.round(x)
  y = Math.round(y)
  if (x < 0 || y < 0 || x > window.w || y > window.h) return null
  return { x: x - POINT_RADIUS, y: y - POINT_RADIUS, w: POINT_RADIUS * 2, h: POINT_RADIUS * 2 }
}

/** 第五档问模型的那一句。**要坐标，不要编号**——和 `seePrompt` 是两种活。 */
function pointPrompt(what: string, window: Rect): string {
  return `这是一张 ${window.w}x${window.h} 的应用窗口截图。请找到「${what}」，` +
    `只回它的位置，格式为 click(start_box='[x1,y1,x2,y2]')，坐标以这张图的左上角为原点。` +
    `如果图里没有这个东西，只回「没找到」三个字，不要猜一个坐标。`
}

function seePrompt(see: See, count: number): string {
  const target = see.text ? `文字「${see.text}」所在的那个控件` : `${see.icon}`
  return `这是一张桌面应用窗口的截图，上面用红框和编号（1 到 ${count}）标出了候选区域。` +
    `请找出「${target}」对应的编号。只回答那个数字本身，不要带任何其他文字；没有一个候选是它就回答 0。`
}

/** **整条回答就是一个数字**才算数——"第一个数字"不行：提示词自己写着「1 到 N」，模型一句
 *  「在 1 到 60 里我选 12」就会被读成 1，静默选中 1 号框，而那一刀还会被 `cache.put` 冻成模板，
 *  此后每一趟都稳定命中错的地方。`0`（模型说"没有一个是它"）与任何非纯数字一律 null，都不缓存。 */
function parseMark(content: string | null | undefined, count: number): number | null {
  const m = String(content ?? '').trim().match(/^(\d+)$/)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= count ? n : null
}
