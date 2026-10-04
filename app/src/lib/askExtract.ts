import type { Connection } from './api.ts'
import { toast } from '../components/acrylic/sonner.tsx'

/**
 * 「转成文字」——**开一条对话，让模型去取**。全站唯一的转成文字动作，两个入口共用
 * （全屏详情页的动作行、时间线行/卡片的右键菜单）。
 *
 * ## 为什么是对话，而不是起一条后台转换
 *
 * 转成文字的**产物是一段要读的文字**，而 Stream 前端里没有任何地方画它——原生对话抽屉拆掉
 * 之后，转写稿/正文只剩通知说一声"好了"，点进去只到详情页，内容本身看不见。对话面自带
 * 渲染（Stream UI 插件里的 `ExtractCard` 就是给 `extract` 工具的产出画的），所以转成文字回到对话，
 * 结果就有了归宿。设计见 `docs/superpowers/specs/2026-08-19-extract-into-conversation-design.md`。
 *
 * 「识别发言人」的开关也随之撤掉：`extract` 工具本来就吃 `diarize` / `rerun`，该不该识别、
 * 要不要重跑由模型按用户的话决定。UI 上再留一个开关，等于同一个决定有两个不打招呼的来源。
 *
 * ## 一句话的形状：明写工具名，且**不随附正文**
 *
 * 明写 `extract` 是因为「我们在提示里要求过」不等于「它照做了」（`docs/AGENT-TOOLING.md`），
 * 而这一句的**全部目的**就是那一次工具调用。不随附摘要正文是同一个理由的反面：随附了，
 * 模型手里就已经有字，很可能直接答完、根本不去取全文。
 *
 * （对比 `@` 引用那条路——它**要**随附截断正文，因为那里的目的是"零工具调用直接问答"。
 * 两条路目的相反，别把序列化合并成一份。）
 *
 * ## 只给句柄和标题 —— 别把条目的元信息倒进这一句
 *
 * `extract` 的入参只有一个**句柄**（三个命名空间：库内 item id / 现搜快照 id / 网盘绑定的
 * `tmdb:…`，见 `src/mcp/mcp-extras.ts` 的 `extractImpl`）。作者、来源、链接一格都不进工具
 * 入参，它们在这一句里唯一的作用是让人读得懂——而那件事**由卡片做**（`ExtractCard` 从回执
 * 的 `snapshot` 里画标题/来源/链接）。倒进提示语的代价是真的：抖音的分享链接单条 500+ 字符，
 * 占掉整段的九成，用户看到的就是一屏乱码般的 query string。
 */

/** 提示语里描述一条内容用得上的几格。`Item` 的子集——测试和面板都只需要这几样。
 *  `url`/`author`/`source_id` 收着是因为调用方本来就带着它们（多余属性不报错），
 *  `extractPrompt` 一格都不用——理由见文件头注那节。 */
export interface AskExtractItem {
  id: string
  title: string
  url?: string
  author?: string
  source_id?: string
}

/** 发进对话的那一句（导出给测试钉形状：工具名与句柄必须在里面）。
 *
 * **一行**：`「标题」(item:<句柄>)` 与订阅那条引用（`subscriptionRefText` 的
 * `「label」(stream:<id>)`）是同一种写法——模型两处都读得懂，人也一眼看得出引的是谁。
 *
 * **不再提 full**：extract 的模型面没有全文开关了（spec 2026-08-24-digest-authority——
 * 那个开关开给模型必被滥用）。用户点「转成文字」要的是**眼睛看到那些字**,这由卡片兑现:
 * ExtractCard 收到 digest 后自己从 /api/conversions 拉全文渲染,模型上下文里只有要点。 */
export function extractPrompt(item: AskExtractItem): string {
  return `请对「${item.title}」(item:${item.id}) 调用 extract 转成文字（音视频走转写、图片/PDF 走 OCR），取到后简述要点。`
}

/**
 * 面板递给对话的一次动作。**三种形态，别合并成一个 text 参数**——它们落在对话上的位置不一样：
 * `send` 发出去（说完就等它干活），`compose`/`ref-item` 塞进输入框不发（引用完用户还要接着说）。
 *
 * `ref-item` 和 `compose` 也不能合并：一条内容要**随附正文**，而那份正文得在发送那一刻现取
 * （插完用户可能又滚了几屏）。所以它插的是有身份的占位符，由 `@` 引用源的 codec 现取——
 * 死文字顶替不了（详见插件侧 `compose-into-conversation.ts` 的头注）。
 */
export type AskChatOp =
  | { kind: 'send'; text: string }
  | { kind: 'compose'; text: string }
  | { kind: 'ref-item'; id: string; label: string }

/** 面板跑在一个带对话的壳里时（用户 DSH 里的 Stream UI 插件），壳把这个能力递进来
 *  （见 `panel/entry.tsx` 的 `onAskChat`）。
 *  **失败要 reject**：这条路上任何一步坏了都表现成"点了没反应"，得由这里接住说人话。 */
export type AskChatSink = (op: AskChatOp) => void | Promise<void>

let sink: AskChatSink | undefined

/**
 * 装/卸对话通道。**只有面板那一档会装**——独立前端（8900）没有对话面，动作会说人话拒绝（见 `runChatOp`）。
 * @param fn - 通道；`undefined` = 卸掉（面板卸载时必须卸，否则指着一棵已经没了的树）。
 */
export function setAskChatSink(fn: AskChatSink | undefined): void {
  sink = fn
}

/**
 * 读回当前通道。
 *
 * **为什么需要这个 getter**：详情视图是**第二个独立 IIFE bundle**（`detail-entry.tsx`），
 * 自带一整套模块实例——主 bundle 里 `setAskChatSink` 装的那一份，它这边读不到（它那份
 * `sink` 恒为 undefined）。而「转成文字」按钮恰恰画在详情里。所以主 bundle 挂详情时要把
 * 通道当参数递过去（`detailBundle.ts` → `MountOptions.askChat`），详情那边再 set 一次。
 *
 * 漏了这一步的症状**极像"什么都没发生"**：按钮点得动、没有报错、没有 toast（详情那棵树
 * 的 sonner 也是它自己那份），实际走的是"没有对话面"那条拒绝路，而报错 toast 画在了
 * 详情自己那份看不见的 sonner 上。活体实测过（2026-08-19）。
 */
export function askChatSink(): AskChatSink | undefined {
  return sink
}

/**
 * 把一句话送进对话——**卡片→对话上下文桥的通用底座**（spec 2026-08-24-conversational-reconcile
 * §3.4：整理卡蹚通后其他卡片照抄的就是这一条）。两个消费者：「转成文字」（askExtract）与
 * 「让 AI 整理」（askReconcile）。场景知识（prompt 怎么组）归各自的调用方，这里只管通道：
 * 面板在对话宿主里 → 走壳递进来的 sink；独立前端（8900）没有对话面 → 说人话拒绝（见 `runChatOp`）。
 * @param errLabel - 失败 toast 的动作名（"转成文字" / "让 AI 整理"）——报错要说清是哪个动作没进去。
 */
export async function sendToChat(conn: Connection, text: string, errLabel: string): Promise<void> {
  return runChatOp(conn, { kind: 'send', text }, errLabel)
}

/**
 * 把一条**引用**塞进输入框（不发）。没有对话的壳里没有输入框可塞，所以这一档**不走深链兜底**——
 * 深链只能把一句话发出去，而"发出去"恰恰是引用不想要的那个动作。
 * @param op - `compose`（死文字）或 `ref-item`（带 codec 的内容引用）。
 * @param errLabel - 失败 toast 的动作名。
 */
export async function composeIntoChat(op: AskChatOp, errLabel: string): Promise<void> {
  if (sink === undefined) {
    toast.error(`${errLabel}要在带对话的那张页里进行`, { description: '这一页没有对话输入框。' })
    return
  }
  try {
    await sink(op)
  } catch (e: unknown) {
    toast.error(`${errLabel}没能进输入框`, { description: e instanceof Error ? e.message : String(e) })
  }
}

/** `send` 那一档的实现：只有面板在对话宿主里（壳递了 sink）才能发；独立前端没有对话面。 */
async function runChatOp(conn: Connection, op: AskChatOp & { kind: 'send' }, errLabel: string): Promise<void> {
  void conn
  if (sink !== undefined) {
    try {
      await sink(op)
    } catch (e: unknown) {
      toast.error(`${errLabel}没能进对话`, { description: e instanceof Error ? e.message : String(e) })
    }
    return
  }
  // 独立前端（8900）里没有对话——对话在用户自己的宿主里（spec 2026-09-05 §6.2）。
  // **不静默失败**："点了什么都没发生"和"转成文字坏了"长得一模一样。
  toast.error(`${errLabel}要在对话里进行`, {
    description: '这一页没有对话面。在你的 DSH 里装 Stream UI 插件后从那里操作，或在 Claude Code / Codex 里让它调 extract。',
  })
}

/**
 * 转成文字。
 * @param conn - 后端连接（`sendToChat` 的签名要求，独立前端这一档目前用不上，见 `runChatOp`）。
 * @param item - 要转成文字的那条。
 */
export async function askExtract(conn: Connection, item: AskExtractItem): Promise<void> {
  return sendToChat(conn, extractPrompt(item), '转成文字')
}

/** 「让 AI 整理」发进对话的那一句（导出给测试钉形状：工具名与 show id 必须在里面）。
 *
 * 明写三个工具名，理由同 `extractPrompt`：「我们在提示里要求过」不等于「它照做了」，而这一句
 * 的全部目的就是那几次工具调用。**裁决纪律不在这里重复**——硬证据直接落 / 薄证据先问人的
 * 分层判据写在 `reconcile_decide` 的工具描述里（离决策点最近的地方），提示里再抄一份就是
 * 两个会各自漂移的真相源。 */
export function reconcilePrompt(showId: string, label: string): string {
  return [
    `请整理「${label}」：先用 reconcile_status 查它的状态（show: ${showId}），`,
    `按各工具描述里的裁决规则处理待决项（reconcile_decide），拿不准的把证据摆给我选，`,
    `然后 reconcile_execute 执行搬运，最后汇报结果。`,
  ].join('')
}

/** 「让 AI 整理」——整理状态卡上唯一的动作按钮（spec 2026-08-24-conversational-reconcile §3.4）。 */
export async function askReconcile(conn: Connection, showId: string, label: string): Promise<void> {
  return sendToChat(conn, reconcilePrompt(showId, label), '让 AI 整理')
}

/**
 * 「让 AI 配整理」——这条订阅**还没有整理配置**时发的那一句（spec 2026-08-25 §4.2/§5）。
 *
 * 原来这一步是个四格表单（来源目录 / 付费库 / 下架库 / 名称）加一套派生规则。撤掉它不是
 * 少给功能：**来源目录本来就不是常驻配置，是一次性进料**——从某个分享链接扒下来的那一坨，
 * 搬完就该没了。让用户在表单里"存"它，才是那个错。
 *
 * 明写工具名，理由同 `extractPrompt`：这一句的全部目的就是那一次工具调用。**不替用户猜目录**
 * ——`reconcile_open` 一动就是建绑定、改订阅成员、写配置，猜错的代价不是重来一次。
 */
export function openReconcilePrompt(streamId: string, label: string): string {
  return [
    `我要整理「${label}」(stream:${streamId})。`,
    `先问我要整理哪个网盘目录（可以用 netdisk_browse 帮我找，别自己猜），`,
    `确认后用 reconcile_open 把它接起来，然后按 reconcile_status → reconcile_decide → reconcile_execute 走完，最后汇报结果。`,
  ].join('')
}

/** 「让 AI 整理」——这条订阅还没配过整理时的那颗按钮。发出去（不是引用）：这一句本身就是一个任务。 */
export async function askOpenReconcile(conn: Connection, streamId: string, label: string): Promise<void> {
  return sendToChat(conn, openReconcilePrompt(streamId, label), '让 AI 整理')
}

/**
 * 一条订阅的引用形态：**屏幕上是名字、送出去的是 id**。
 *
 * 和对话输入框里 `@` 出来的那串字**必须一模一样**（`dsh-plugin-stream-ui` 的
 * `subscriptionRefText`）——同一个东西两个入口拼出两种写法，模型读到的就是两种引用，
 * 而两边单看都正常。改这里就要改那边。
 */
export function subscriptionRefText(id: string, label: string): string {
  return `「${label}」(stream:${id})`
}

/**
 * 一部影视作品的引用形态：`「星卡梦少女」(tmdb:tv:241453)`。
 *
 * **带 media**：TMDb 的 id 按媒体类型分命名空间（电影 1399 ≠ 剧集 1399），只给 id 等于让
 * 模型去猜该打 `/movie` 还是 `/tv`（后端那一侧为同一个理由把 media 存进了绑定左侧，见
 * `netdisk/types.ts` 的 `MappingLeft`）。
 *
 * **只送坐标、不随附任何正文**：一部剧不是"一段内容"。要简介、要分集、要绑定状态，模型
 * 各有工具可查，而随附一份就得选"随附哪一份"——那是替它做了它自己该做的判断。
 */
export function workRefText(ref: { id: string; media: 'movie' | 'tv'; title: string }): string {
  return `「${ref.title}」(tmdb:${ref.media}:${ref.id})`
}

/**
 * 一集的引用形态：`「星卡梦少女 S04E23 “弱”者的逆袭」(tmdb:241453:S04E23)`。
 *
 * 括号里就是**绑定左侧那个 leftKey 原文**——网盘那几个工具（`netdisk_residue` /
 * `netdisk_preview_spec` / `reconcile_*`）本来就说这门话，不必再翻译一次。屏幕上的名字带
 * 上作品名和 SxxExx：一条只写着集标题的引用，翻回去看的人认不出它是哪一部的第几集。
 */
export function episodeRefText(ep: { leftKey: string; workTitle: string; season: number; episode: number; title: string }): string {
  const no = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`
  return `「${ep.workTitle} ${no} ${ep.title}」(${ep.leftKey})`
}

/** 「在对话中引用」——一部影视作品。`compose` 不是 `ref-item`：送出去的就是坐标本身，
 *  又短又不会变，没有"发送那一刻现取"的东西（对比一条内容要随附正文）。 */
export async function referenceWork(ref: { id: string; media: 'movie' | 'tv'; title: string }): Promise<void> {
  return composeIntoChat({ kind: 'compose', text: workRefText(ref) }, '引用影视')
}

/** 「在对话中引用」——一集。同上走 `compose`。 */
export async function referenceEpisode(ep: { leftKey: string; workTitle: string; season: number; episode: number; title: string }): Promise<void> {
  return composeIntoChat({ kind: 'compose', text: episodeRefText(ep) }, '引用分集')
}

/**
 * 「AI 匹配」发进对话的那一句（导出给测试钉形状：setId 与三个工具名必须在里面）。
 *
 * 它**是发送不是引用**：用户在网盘下拉里点它，就是要模型现在去干活。
 *
 * 明写三个工具名，理由同 `extractPrompt`：「我们在提示里要求过」不等于「它照做了」，而这
 * 一句的全部目的就是那几次工具调用。**先 preview 再 apply 这条纪律写在工具描述里**（离决
 * 策点最近的地方），这里只点名不重复展开——两处各写一份就是两个会各自漂移的真相源。
 */
export function matchSpecPrompt(setId: string, label: string): string {
  return [
    `「${label}」的网盘分集没配上，帮我修：先 netdisk_residue 看残差（setId: ${setId}），`,
    `据此写一份匹配规格，用 netdisk_preview_spec 干跑对比覆盖，满意了再 netdisk_apply_spec 落盘，`,
    `最后告诉我配上了多少、还剩哪些没配上以及为什么。`,
  ].join('')
}

/** 「AI 匹配」——网盘下拉里那颗按钮（程序配不上时用户唯一的出路）。 */
export async function askMatchSpec(conn: Connection, setId: string, label: string): Promise<void> {
  return sendToChat(conn, matchSpecPrompt(setId, label), 'AI 匹配')
}

/**
 * 右键「在对话中引用」——一条订阅。
 *
 * 走 `compose`（死文字）就够了：一条订阅要送进模型的只有它的 id，短且不会变。
 * @param id - stream id。
 * @param label - 显示名。
 */
export async function referenceSubscription(id: string, label: string): Promise<void> {
  return composeIntoChat({ kind: 'compose', text: subscriptionRefText(id, label) }, '引用订阅')
}

/**
 * 右键「在对话中引用」——一条内容。
 *
 * **不能退化成 `compose` 那种死文字**：一条内容要随附正文，而正文得在发送那一刻现取
 * （插完用户可能又滚了几屏、开了别的详情）。所以插的是有身份的占位符，由 `@` 引用源的
 * codec 现取——这也是为什么那个源即使不在 `@` 菜单里出候选，也**必须保持注册**。
 * @param item - 要引用的那条（只用 id 和标题）。
 */
export async function referenceItem(item: AskExtractItem): Promise<void> {
  return composeIntoChat({ kind: 'ref-item', id: item.id, label: item.title }, '引用内容')
}
