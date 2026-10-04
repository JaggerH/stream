/**
 * 「用户此刻在看哪条 / 手边有哪些条」推给壳的那份投影（`@` 引用的候选来源）。
 *
 * 为什么是投影而不是整条 `Item`：壳（`dsh-plugin-stream-ui`）是另一个 bundle、另一个包，
 * 两边不共享类型——契约靠这份结构 + 壳侧 `panel/host.ts` 里的镜像声明对齐。这是**唯一**还
 * 往宿主推的一份状态：频道名录那条线已经收回面板自己（两个挂载点共读 `nav/channel-store.ts`，
 * 宿主不再当转发点）。整条 `Item` 带着 media/storyGroup/videoDetail
 * 一大堆壳用不上的东西，还会把跨包契约撑成"整个数据模型"。
 *
 * **正文在这里就随附**（截断的 `excerpt`），不是只给一个 id 让对话那侧回头再取：引用最终
 * 要变成模型看得见的文字，而"模型会不会自己去调工具取"是没有保证的一件事
 * （`docs/AGENT-TOOLING.md` 反复讲的那类静默缺陷——我们要求过 ≠ 它照做了）。随附正文让
 * 默认路径零工具调用就成立；`extract({item:id})` 是模型自主深读的加深入口——长正文默认回
 * 带出处的要点摘要（digest，见 `docs/superpowers/specs/2026-08-24-extract-narrow-receipt-design.md`），
 * 可传 `focus` 定镜头。模型面没有全文开关（曾有 `full`，被模型滥用后结构性收回，
 * spec 2026-08-24-digest-authority）；整篇原文归 `get_conversions({item})` 与卡片。
 */
import type { Item } from '../lib/types.ts'

/**
 * 随附正文的上限（字符）。超出截断并在序列化时明写"已截断"。
 *
 * **这个数是拍的，没有实测支撑**——别当成调过的结论。选它时只有两条朴素的直觉：再长会明显
 * 吃 prompt 预算（活体那次单条引用连元数据一共 1426 字符、整轮输入 29.4K token），太短则常常
 * 逼模型多跑一次 `extract`。要改它，先量：拿几类真实内容（长文 / 短帖 / 音视频转写）跑一轮，
 * 看"模型答得上来"和"输入 token"这两条曲线在哪儿交叉，别凭手感换一个同样没依据的数。
 */
export const EXCERPT_LIMIT = 1200
/** 推给壳的最近条目条数上限——候选菜单本来就只展示前若干条，多推只是白占内存。 */
export const RECENT_LIMIT = 30

/** 壳侧候选看到的一条内容。 */
export interface PanelItemRef {
  id: string
  title: string
  url?: string
  author?: string
  /** 所属 Stream id（候选行的副标题，用户靠它区分同名标题）。 */
  streamId?: string
  /** 正文摘要，已按 `EXCERPT_LIMIT` 截断。 */
  excerpt?: string
  /** 上面那份 excerpt 是不是被截断了（序列化时要如实告诉模型）。 */
  truncated?: boolean
}

/** 推给壳的整份状态：正在看的那条 + 当前频道手边这一批 + 主区是不是被全屏占着。 */
export interface PanelItemContextState {
  /** 详情页开着的那条；没开详情就是 null。 */
  open: PanelItemRef | null
  recent: PanelItemRef[]
  /**
   * 主区此刻被一块全屏内容占满了没有——工作台的对话列据此让位。
   *
   * **它不等于 `open !== null`**，别让壳去从 `open` 推：影视频道全屏看片时主区一样被占满，
   * 但那不是一条 item（没有 id、`@` 引用不了它），`open` 只能是 null。壳曾经就是照 `open`
   * 推的，症状是看片时对话列还占着 480 而没有任何一处报错。判据在面板这一侧算一次。
   */
  fullscreen: boolean
}

/** 一条 item 的正文文字——`content.text` 优先（归一化后的那份），回落 `body_text`。 */
function bodyText(item: Item): string | undefined {
  const text = item.content?.text ?? item.body_text
  if (text === undefined) return undefined
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把一条 item 投影成壳侧的引用。
 * @param item - 面板列表/详情里的那条。
 */
export function toItemRef(item: Item): PanelItemRef {
  const text = bodyText(item)
  const truncated = text !== undefined && text.length > EXCERPT_LIMIT
  return {
    id: item.id,
    title: (item.content?.title ?? item.title ?? '').trim() || item.id,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(item.stream_id !== undefined ? { streamId: item.stream_id } : {}),
    ...(text !== undefined ? { excerpt: truncated ? text.slice(0, EXCERPT_LIMIT) : text } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  }
}
