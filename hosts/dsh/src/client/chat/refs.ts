/**
 * 「这句话里提到了哪几条 Stream 的东西」——**一份纯文本文法**，前后端与剪贴板同吃。
 *
 * ## 为什么结构必须藏在文本里，而不是藏在渲染里
 *
 * 用户要的是两件事：气泡里看到一张卡，**而且把它复制到别处、粘贴出来仍然是那张卡**。
 * 这两件事只有一个解法：**让那段文本本身就是结构**。
 *
 * 走渲染那条路（气泡里画卡、文本另存一份 id）看着更漂亮，但复制走的是 DOM 的
 * `textContent`——卡片显示什么就复制什么。卡上只画标题，粘出去就只剩标题，id 没了，
 * 下一个对话既认不出这是哪一条，模型也没法调 `extract`。**结构在那一刻就丢了，
 * 而且丢得毫无痕迹。**
 *
 * 所以标记的字面量（`「标题」(item:xxx)`）**原样留在渲染出来的文本里**，只是把 `(item:xxx)`
 * 那半截画淡、画小。看得懂、复制得走、粘到任何地方（另一个会话、微信、记事本）都还原得回来。
 *
 * ## 文法
 *
 * 两种，和发送侧逐字对应（`app/src/lib/askExtract.ts` 的 `extractPrompt` /
 * `subscriptionRefText`，以及 `input/stream-ref-source.ts` 的序列化）：
 *
 * - `「<标题>」(item:<句柄>)` —— 一条内容
 * - `「<名字>」(stream:<id>)` —— 一条订阅
 *
 * **改这里就要改那几处**：文法是两侧共同的约定，一边多个空格另一边就整段认不出来
 * （表现是"卡片突然不见了"，而且没有任何一处会报错）。
 */

/** 一段解析结果。`kind: 'text'` 是原样的字，其余两种是认出来的引用。 */
export type RefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'item' | 'stream'; label: string; id: string; text: string }

/**
 * 句柄的字符集：库内 item id（hex）、现搜快照 id、网盘绑定的 `tmdb:99:S01E02`、
 * 订阅 id。**刻意不含 `)`**——右括号是终结符，收进来就会把后面整段吃掉。
 */
const REF = /「([^」]*)」\((item|stream):([^)\s]+)\)/g

/**
 * 把一句话切成「原样的字」和「认出来的引用」。
 *
 * @param text - 用户消息里的一段纯文本。
 * @returns 按出现顺序的段；没有引用时就是一段 `text`（**不返回空数组**——调用方据此直接渲染）。
 */
export function parseRefs(text: string): RefSegment[] {
  const out: RefSegment[] = []
  let last = 0
  // `matchAll` 而不是手写 while+exec：后者要自己管 `lastIndex`，而这个正则是模块级常量
  // （带 `g` 的正则有可变状态），忘了重置就会**从上一次的位置继续找**，表现为"有时候
  // 认得出、有时候认不出"。
  for (const m of text.matchAll(REF)) {
    const at = m.index
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: m[2] === 'item' ? 'item' : 'stream', label: m[1]!, id: m[3]!, text: m[0] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out.length > 0 ? out : [{ kind: 'text', text }]
}
