import { composeContent, type ComposeInclude, type SpeakerInput } from './compose.ts'
import type { ConversionKind, ConversionRecord } from './store.ts'

/**
 * 「把这条内容读给我」——**三条轨（底座正文 / 谁在说 / 屏幕上写着什么）的唯一读口**。
 *
 * 没有它，帧文字那一层就是没有消费者的死代码：模型这一侧没有第二条路到达它
 * （`get_conversions` 给的是逐条原始记录，不是按时刻排好的稿子）。
 *
 * **它只读，不起任务。** 起任务是 `extract` / `identify_speakers` 的事——那两个会等结果。
 * 两件事分开，是因为「等一层跑完」和「把已有的拼起来」的耗时差着两个数量级，混成一个工具
 * 就只能取其一：要么读一次也可能卡三分钟，要么永远读不到还在跑的那层。
 *
 * **吃哪几层由调用方选，没有默认**：帧文字可能有几十行，问「他说了什么」的人不该付这笔 token。
 *
 * **每一层都带状况，空内容时那才是答案。**「没跑」「还在跑」「跑了没料」「跑了失败」四种都会
 * 让某层交出空，合成一个空值就等于让模型据此告诉用户「这视频屏幕上没有字」——而真相可能是那层
 * 压根没跑。判据与措辞在 `compose.ts`。
 */
export interface ReadContentDeps {
  /** 读这条 item 的转换记录。就是 `McpExtras['conversions']['list']`。 */
  list: (q: { item?: string; kind?: string; limit?: number; expandResult?: boolean }) => { items: unknown[] }
  /** 说话人读口（时间线 × 转写段的现算投影）。缺省 = 声纹域没配，稿子不带名字。 */
  speakers?: (itemId: string) => SpeakerInput
}

/** 一层取**最新的一条**。同一条 item 可能有多条同 kind 记录（重跑过），最新那条才是现状。 */
function latest(deps: ReadContentDeps, itemId: string, kind: ConversionKind): ConversionRecord | undefined {
  try {
    const items = deps.list({ item: itemId, kind, limit: 20, expandResult: true }).items as ConversionRecord[]
    // list 的顺序是契约之外的东西，别指望它——自己按创建时刻挑，挑不出就退回第一条。
    return [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? items[0]
  } catch {
    // 读不到 = 这层此刻无从得知。**当成没跑交给 compose 去报 absent**，别把整次读挂掉：
    // 三层里有一层读不出来，另外两层的内容照样是有用的。
    return undefined
  }
}

/** 长到值得在返回体里喊"扇出"的正文门槛(与 extract 窄回执的 4000 同一量级,独立常数——
 *  两个门槛的语义不同:那边管压不压,这边只管提醒不提醒)。 */
export const READ_CONTENT_FULL_NOTE_CHARS = 4000

export function readContent(
  deps: ReadContentDeps,
  itemId: string,
  include: ComposeInclude,
): ReturnType<typeof composeContent> & { next_step?: string; note?: string } {
  // 说话人读不出来（声纹库还没建表之类）＝此刻无从得知，交给 compose 当「没配」处理，
  // 别把整次读挂掉——正文与帧文字照样有用。
  let speakers: SpeakerInput | undefined
  try {
    speakers = deps.speakers?.(itemId)
  } catch {
    speakers = undefined
  }
  const composed = composeContent(
    {
      extract: latest(deps, itemId, 'extract'),
      identify: latest(deps, itemId, 'identify'),
      frames: latest(deps, itemId, 'frames'),
    },
    include,
    speakers,
  )
  // 正文那层还没跑时**明说下一步**，别让模型对着一份全 absent 的读数自己编。指令放在它刚读到
  // 的那份数据里，比放在几千 token 之前的描述里更靠近决策点（docs/AGENT-TOOLING.md 那条实测教训）。
  if (composed.layers.extract.state === 'absent') {
    return {
      ...composed,
      next_step:
        'Nothing has been extracted for this item yet. Call `extract` with this itemId to produce the base text, then read again. Do NOT describe the content until you have it.',
    }
  }
  // 长正文整份出门时,在**返回体里**提醒扇出——描述与系统提示词两档都被活体绕过(2026-08-24,
  // 三条对比照样串行读全文),只剩这根离决策点最近的杠杆:它正好打在"读完这条、要不要再读下一条"
  // 的缝上。只对长正文喊,短正文每条都喊只会把它变成背景噪音。
  if ((composed.text?.length ?? 0) > READ_CONTENT_FULL_NOTE_CHARS) {
    return {
      ...composed,
      note:
        `This was a FULL body (${composed.text!.length} chars) and it now lives in this conversation permanently. ` +
        'If your task involves reading MORE items after this one, STOP reading them here: spawn one `subagent` per remaining item — each subagent reads its item and reports back at most 10 sourced bullets — or call `extract` with a one-line `focus` for a digest instead.',
    }
  }
  return composed
}
