/**
 * 购买决策 job 的**抽取关节**（spec `2026-09-02-purchase-decision-job-design.md` §2 关节 B）：
 * 一页横评 → `[{型号, 被夸的属性, 原话}]`，型号必须落在本次枚举出的全集里。
 *
 * 这是整条链上模型仅有的三个位置之一，也是唯一一个**能把脏数据带进支配运算**的位置——
 * 所以它有两道闸，而且两道都必须在：
 *
 * 1. **enum**（把全集塞进工具参数的取值域）——把越界变成罕见分支。实测 `deepseek-v4-flash`
 *    在对抗性负对照下 4/4 都落在集合内，但那是**行为证据不是语法保证**（该模型明确不支持
 *    `response_format: json_schema`，没有语法层的约束解码可用）。
 * 2. **事后集合校验**（`validateSignal`）——这才是保证。enum 只是让它少走。
 *
 * **enum 挡不住假阴性，所以还有第三道。** 活体撞到过：`OPPO Find X9` 明明在这一轮的 enum 里，
 * 模型仍然把它扔进逃生项、`raw` 写着一模一样的字。事后集合校验拦不住这种——逃生项是合法值。
 * 所以逃生项带回来的 `raw` 要再拿 `modelIdentity` 跟全集对一次（纯代码、确定性），对上了就
 * 算点名。这颗"两条是不是同一个"的脑子仓库里本来就有，别让模型去做它做不稳的字符串匹配。
 *
 * ⚠️ **enum 里必须有逃生项**（`NOT_IN_SET`）。探针实测：给两个都不对的选项、又要求必须选，
 * 模型会挑一个并把理由写得头头是道——字段本身是个**假的正确答案**。映射到这里：横评提到
 * 一台不在全集里的机器时，没有逃生项就会把那句话安到一台无关的机器头上，两边单看都正常，
 * 没有一处会喊。逃生项的计数还是一等信号：它是「全集抓漏没有」的唯一线索。
 */

import { modelIdentity } from '../search/domains/catalog.ts'

/** 逃生项：这一条提到的型号不在全集里。**不是候选**，只计数与诊断。 */
export const NOT_IN_SET = '__not_in_set__'

export interface SignalMention {
  /** 全集成员的型号名，或 `NOT_IN_SET`。 */
  model: string
  /** 原文里那台的写法。`NOT_IN_SET` 时它是唯一有用的信息——用来判断是我们漏抓了，
   *  还是文章在讲海外/未上市型号。 */
  raw?: string
  /** 这一条夸的是哪个属性（对着用户给的软条件，如「拍照」）。 */
  attribute: string
  /** 支撑这句话的原文摘句。没有它，结论就是无出处断言。 */
  quote: string
}

/** 被校验丢掉的一条，连同为什么——丢弃必须计数，不许静默。 */
export interface DroppedMention {
  raw: unknown
  reason: 'missing_field'
}

export interface SignalResult {
  /** 落在全集里的点名。 */
  mentions: SignalMention[]
  /** 提到了、但明说不在全集里的（逃生项）。 */
  unmatched: SignalMention[]
  /** 结构不合法或型号越界被丢掉的。 */
  dropped: DroppedMention[]
}

/**
 * 造这一轮的工具定义。`universe` 是**本次枚举出来的**型号名，逐个进 enum——
 * 所以这个函数每轮都要重新调，不能缓存一份工具定义。
 */
/**
 * 「因为什么被点名」的措辞——**工具描述和系统提示词必须用同一句**，所以只在这里拼。
 * 没有软条件时是「任何值得注意的优点」，不是「综合表现」：活体（2026-09-03）两处措辞不一致，
 * 系统提示词写「综合表现」，模型每篇只记一台综合首选（同一篇正文夸 3 台、3 次采样都只记 1 台；
 * 换成本句 3 次记 3–4 台），6 篇 2500 元档横评合起来只点名了 1 台，比较面被提示词掐没了。
 */
export function criteriaLabel(softCriteria: string[]): string {
  return softCriteria.length > 0 ? softCriteria.join('、') : '任何值得注意的优点'
}

export function buildSignalTool(universe: string[], softCriteria: string[]): Record<string, unknown> {
  const criteria = criteriaLabel(softCriteria)
  return {
    type: 'function',
    function: {
      name: 'record_mentions',
      description:
        `记录这篇文章里，哪些型号因为「${criteria}」被推荐或称赞。` +
        `只记文章真的说过的；文章没提到的型号不要凭印象补。`,
      parameters: {
        type: 'object',
        properties: {
          mentions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                model: {
                  type: 'string',
                  enum: [...universe, NOT_IN_SET],
                  description:
                    `候选集里的型号；文章提到的那台**不在这个列表里**时，必须选 "${NOT_IN_SET}"，` +
                    '并把原文里的写法填进 raw。不要为了凑数选一个相近的型号。',
                },
                raw: { type: 'string', description: `原文里对这台的写法。model 为 "${NOT_IN_SET}" 时必填。` },
                // 两格的分工必须说死：活体一轮 11 条被丢，全是把整段评测总结写进 attribute、
                // 一个字的 quote 都没给——没有原话就是无出处断言，闸会整条丢掉，点名信号随之消失。
                attribute: { type: 'string', description: '被夸的是哪一点，**一个短语**（不超过 12 个字），如「夜景」「长焦」「续航」。不要写成一段总结。' },
                quote: { type: 'string', description: '**必填**：支撑这句话的原文，从文章里**照抄一句**（不超过 80 个字），不要自己概括。没有 quote 的条目会被整条丢掉。' },
              },
              required: ['model', 'attribute', 'quote'],
              additionalProperties: false,
            },
          },
        },
        required: ['mentions'],
        additionalProperties: false,
      },
    },
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * 第二道闸：不信 enum，拿全集再筛一遍。
 *
 * **为什么不能省**：enum 被遵守是观察到的行为，不是承诺；模型换一档、供应商改一次实现，
 * 它就可能悄悄不成立，而失败的样子是「多了一台没人见过的候选」——它会一路走到支配运算里，
 * 中间没有任何一处会报错。
 */
export function validateSignal(raw: unknown, universe: string[]): SignalResult {
  const known = new Set(universe)
  // 身份索引：给逃生项做二次认领用（见头注的"第三道"）。
  const byIdentity = new Map(universe.map((m) => [modelIdentity(m), m]))
  const mentions: SignalMention[] = []
  const unmatched: SignalMention[] = []
  const dropped: DroppedMention[] = []

  const rows = (raw as { mentions?: unknown })?.mentions
  if (!Array.isArray(rows)) return { mentions, unmatched, dropped }

  for (const row of rows) {
    const r = row as Record<string, unknown>
    const model = str(r?.model)
    const attribute = str(r?.attribute)
    const quote = str(r?.quote)
    if (!model || !attribute || !quote) {
      dropped.push({ raw: row, reason: 'missing_field' })
      continue
    }
    const entry: SignalMention = { model, attribute, quote, ...(str(r?.raw) ? { raw: str(r?.raw) } : {}) }
    if (model === NOT_IN_SET) {
      // **二次认领**：模型说"不在集合里"，但它写下的原文可能只是少了容量后缀、多了个空格。
      // 归一化对上了就算点名——这一步是纯代码，不问模型第二次。
      const claimed = entry.raw ? byIdentity.get(modelIdentity(entry.raw)) : undefined
      if (claimed) mentions.push({ ...entry, model: claimed })
      else unmatched.push(entry)
    } else if (known.has(model)) {
      mentions.push(entry)
    } else {
      // enum 没兜住的那种——**这条闸拦的是"把越界型号当候选"**，不是拦信息。第二问走正文 JSON
      // 时没有 enum，模型会按自己的写法写型号（`一加Ace6` / `Redmi K80 Pro`），和逃生项带回的
      // raw 是同一种东西：先按身份二次认领（纯代码），对上了算点名；对不上就归 unmatched 带着
      // 原文——它是「全集抓漏没有」的线索，一丢就没了（活体一轮 7 条全丢、回执里只剩一个数）。
      const claimed = byIdentity.get(modelIdentity(model))
      if (claimed) mentions.push({ ...entry, model: claimed, raw: entry.raw ?? model })
      else unmatched.push({ ...entry, model: NOT_IN_SET, raw: entry.raw ?? model })
    }
  }
  return { mentions, unmatched, dropped }
}
