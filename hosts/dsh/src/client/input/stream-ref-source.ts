/**
 * 对话输入框里的 `@` 引用源：把「Stream 里的这条内容」插进草稿。
 *
 * 走的是 DSH 官方的输入触发器扩展点（`ctx.inputTriggers.registerSource`），**不改它的输入框、
 * 不抢它的槽**——`@` 本来就是这条管线认的触发字符，我们只是多注册一个来源，和它自带的
 * `@subagent` 并列成两组候选。
 *
 * ## 发出去之后模型怎么读到内容 —— 正文随附，不赌它去调工具
 *
 * `codec.serialize` 的返回值会被**逐字拼进发给模型的那段 prompt**（见 ui-conversation 的
 * `sinkSerialized`），所以这是唯一真正决定"模型看不看得见"的地方。这里选择**把正文直接
 * 写进去**，而不是只给一个 id 让模型自己去调 `extract`：
 *
 * - 「我们在提示里要求过」不等于「它照做了」——这正是 `docs/AGENT-TOOLING.md` 反复讲的
 *   那类静默缺陷，判据只看副作用。赌一次工具调用，就是把这条引用的成败押在模型的自觉上。
 * - 正文随附之后，默认路径**零工具调用**就成立：用户 `@` 一条再问"这讲了什么"，模型手里
 *   已经有字了。
 *
 * 随附的是**截断**的正文（面板侧按 `EXCERPT_LIMIT` 截）。截断这件事**明写在序列化文本里**，
 * 并给出加深入口 `extract({item:"<id>"})`——不写的后果是模型拿半截当全文，静默答错。
 *
 * ## 它不在 `@` 菜单里出候选 —— 但**必须保持注册**
 *
 * 内容是无限的（时间线里成千上万条），把它摆进 `@` 菜单就是让用户在一个永远选不完的列表里
 * 找东西——用户实测反馈是"很乱"。**指着一条内容说"引用它"的正确入口是右键菜单**：他正看着
 * 那一条，引的是谁一目了然，零歧义、零翻找。所以 `candidates()` 恒空。
 *
 * 但这个源**不能因此注销**：右键插进去的引用带的 `source` 就是这个名字，发送那一刻
 * ui-input-trigger 拿它**在 roster 里回查 codec**（不是在菜单里）。注销掉 = 引用还在草稿里、
 * 序列化时找不到源——那正是"引用了但模型什么也没看见"，而且没有任何一处会报错。
 * 右键那条路见 `compose-into-conversation.ts` 的 `ref-item`。
 */
import type {
  CandidateRequest,
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ItemContextStore, PanelItemRef } from '../panel/item-context-store.ts'

/** 源名。**它同时是 `ReferenceInsert.source`**——发送时按这个字符串回查 codec
 *  （ui-input-trigger 的 `serializeReference` 拿它在 roster 里找源），两处必须是同一个值。 */
export const STREAM_REF_SOURCE_NAME = 'stream'

/**
 * 一条引用的模型形态。**这就是模型真正看到的那几行**（会被逐字拼进 prompt）。
 * @param ref - 引用指向的那条内容；`undefined` = 面板里已经找不到它了。
 * @param id - 引用里存的 item id（`ref` 缺席时也要把它写出去，模型才有得可查）。
 */
export function serializeItemRef(ref: PanelItemRef | undefined, id: string): string {
  const deepen = `要深读请调用 extract({item:"${id}"})——长正文回带出处的要点摘要，可传 focus 定镜头；任务本身需要整篇原文时用 get_conversions({item})`
  if (ref === undefined) {
    // 面板刷新/切频道之后草稿里的老引用会落到这里。**不抛错**——抛错会整条挡住发送
    // （ui-conversation 的 sinkSerialized 把 serialize 失败当作阻断），而"引用的那条现在
    // 不在手边"完全是正常的，把 id 如实交出去比让用户发不出消息好。
    return `<stream-item id="${id}">\n（面板里已经没有这条的快照，正文未随附。${deepen}）\n</stream-item>`
  }
  const lines = [
    `<stream-item id="${id}">`,
    `标题：${ref.title}`,
    ...(ref.author !== undefined && ref.author !== '' ? [`作者：${ref.author}`] : []),
    ...(ref.streamId !== undefined && ref.streamId !== '' ? [`来源：${ref.streamId}`] : []),
    ...(ref.url !== undefined && ref.url !== '' ? [`链接：${ref.url}`] : []),
  ]
  if (ref.excerpt !== undefined && ref.excerpt !== '') {
    lines.push('正文：', ref.excerpt)
    // 截断必须明写：不写的话模型会把半截当全文，然后静默答错——而且没有任何一处会喊。
    if (ref.truncated === true) lines.push(`（正文到此截断。${deepen}）`)
  } else {
    lines.push(`（这条没有随附正文——图集/音视频类的正文要现取。${deepen}）`)
  }
  lines.push('</stream-item>')
  return lines.join('\n')
}

/**
 * 建一个 `@` 引用源。
 * @param store - 面板推过来的内容快照（`panel/item-context-store.ts` 的单例）。
 */
export function makeStreamRefSource(store: ItemContextStore): InputTriggerSource {
  return {
    trigger: '@',
    name: STREAM_REF_SOURCE_NAME,
    order: 0,
    // 恒空：内容不进 `@` 菜单（理由见头注——内容是无限的，摆进菜单就是让用户在选不完的
    // 列表里翻找）。这个源现在**只提供 codec**：右键插进去的引用带着 `source: 'stream'`，
    // 发送那一刻靠它取正文。
    candidates(): Promise<readonly InputTriggerCandidate[]> {
      return Promise.resolve([])
    },
    // 菜单里没有我们的候选，这里就不会被调到；真被调到也说明那条候选不是我们出的，
    // 让管线走默认落点，别插一个指向空气的引用。
    onPick(): PickOutcome {
      return undefined
    },
    codec: {
      clipboardText: (ref: string): string => {
        const found = store.find(ref)
        return `@${found?.title ?? ref}`
      },
      // 发送那一刻才取内容：草稿里存的只有 id，用户可能在插入之后又滚了几屏、开了别的
      // 详情——发出去的应该是**此刻**这条的样子。
      serialize: (ref: string): Promise<string> => Promise.resolve(serializeItemRef(store.find(ref), ref)),
    },
  }
}
